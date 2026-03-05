import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readNumberParam, readStringParam } from "./common.js";
import {
  CacheEntry,
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_TIMEOUT_SECONDS,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveTimeoutSeconds,
  withTimeout,
  writeCache,
} from "./web-shared.js";

const SEARCH_PROVIDERS = ["brave", "perplexity", "exa"] as const;
const DEFAULT_SEARCH_COUNT = 5;
const MAX_SEARCH_COUNT = 10;

const BRAVE_SEARCH_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_EXA_BASE_URL = "https://api.exa.ai";
const DEFAULT_EXA_SEARCH_TYPE = "auto";
const DEFAULT_EXA_CONTENT_MODE = "highlights";
const DEFAULT_EXA_MAX_CHARACTERS = 4_000;
const DEFAULT_PERPLEXITY_BASE_URL = "https://openrouter.ai/api/v1";
const PERPLEXITY_DIRECT_BASE_URL = "https://api.perplexity.ai";
const DEFAULT_PERPLEXITY_MODEL = "perplexity/sonar-pro";
const PERPLEXITY_KEY_PREFIXES = ["pplx-"];
const OPENROUTER_KEY_PREFIXES = ["sk-or-"];

const SEARCH_CACHE = new Map<string, CacheEntry<Record<string, unknown>>>();
const BRAVE_FRESHNESS_SHORTCUTS = new Set(["pd", "pw", "pm", "py"]);
const BRAVE_FRESHNESS_RANGE = /^(\d{4}-\d{2}-\d{2})to(\d{4}-\d{2}-\d{2})$/;

const WebSearchSchema = Type.Object({
  query: Type.String({ description: "Search query string." }),
  count: Type.Optional(
    Type.Number({
      description: "Number of results to return (1-10).",
      minimum: 1,
      maximum: MAX_SEARCH_COUNT,
    }),
  ),
  country: Type.Optional(
    Type.String({
      description:
        "2-letter country code for region-specific results (e.g., 'DE', 'US', 'ALL'). Default: 'US'.",
    }),
  ),
  search_lang: Type.Optional(
    Type.String({
      description: "ISO language code for search results (e.g., 'de', 'en', 'fr').",
    }),
  ),
  ui_lang: Type.Optional(
    Type.String({
      description: "ISO language code for UI elements.",
    }),
  ),
  freshness: Type.Optional(
    Type.String({
      description:
        "Filter results by discovery time (Brave only). Values: 'pd' (past 24h), 'pw' (past week), 'pm' (past month), 'py' (past year), or date range 'YYYY-MM-DDtoYYYY-MM-DD'.",
    }),
  ),
});

type WebSearchConfig = NonNullable<ClawdbotConfig["tools"]>["web"] extends infer Web
  ? Web extends { search?: infer Search }
    ? Search
    : undefined
  : undefined;

type BraveSearchResult = {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
};

type BraveSearchResponse = {
  web?: {
    results?: BraveSearchResult[];
  };
};

type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};

type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";

type PerplexitySearchResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  citations?: string[];
};

type PerplexityBaseUrlHint = "direct" | "openrouter";

type ExaConfig = {
  apiKey?: string;
  apiKeys?: string[];
  baseUrl?: string;
  searchType?: "fast" | "auto";
  contentMode?: "highlights" | "text";
  maxCharacters?: number;
};

type ExaKeyAttempt = {
  keyIndex: number;
  status?: number;
  error?: string;
};

type ExaSearchResult = {
  title?: string;
  url?: string;
  text?: string;
  highlights?: string[];
  publishedDate?: string;
  published_date?: string;
};

type ExaSearchResponse = {
  results?: ExaSearchResult[];
};

function resolveSearchConfig(cfg?: ClawdbotConfig): WebSearchConfig {
  const search = cfg?.tools?.web?.search;
  if (!search || typeof search !== "object") return undefined;
  return search as WebSearchConfig;
}

function resolveSearchEnabled(params: { search?: WebSearchConfig; sandboxed?: boolean }): boolean {
  if (typeof params.search?.enabled === "boolean") return params.search.enabled;
  if (params.sandboxed) return true;
  return true;
}

function resolveSearchApiKey(search?: WebSearchConfig): string | undefined {
  const fromConfig =
    search && "apiKey" in search && typeof search.apiKey === "string" ? search.apiKey.trim() : "";
  const fromEnv = (process.env.BRAVE_API_KEY ?? "").trim();
  return fromConfig || fromEnv || undefined;
}

function missingSearchKeyPayload(provider: (typeof SEARCH_PROVIDERS)[number]) {
  if (provider === "perplexity") {
    return {
      error: "missing_perplexity_api_key",
      message:
        "web_search (perplexity) needs an API key. Set PERPLEXITY_API_KEY or OPENROUTER_API_KEY in the Gateway environment, or configure tools.web.search.perplexity.apiKey.",
      docs: "https://docs.clawd.bot/tools/web",
    };
  }
  if (provider === "exa") {
    return {
      error: "missing_exa_api_key",
      message:
        "web_search (exa) needs an API key. Set EXA_API_KEY or EXA_API_KEYS in the Gateway environment, or configure tools.web.search.exa.apiKey/tools.web.search.exa.apiKeys.",
      docs: "https://docs.clawd.bot/tools/web",
    };
  }
  return {
    error: "missing_brave_api_key",
    message: `web_search needs a Brave Search API key. Run \`${formatCliCommand("clawdbot configure --section web")}\` to store it, or set BRAVE_API_KEY in the Gateway environment.`,
    docs: "https://docs.clawd.bot/tools/web",
  };
}

function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number] {
  const raw =
    search && "provider" in search && typeof search.provider === "string"
      ? search.provider.trim().toLowerCase()
      : "";
  if (raw === "perplexity") return "perplexity";
  if (raw === "brave") return "brave";
  if (raw === "exa") return "exa";
  return "brave";
}

function resolvePerplexityConfig(search?: WebSearchConfig): PerplexityConfig {
  if (!search || typeof search !== "object") return {};
  const perplexity = "perplexity" in search ? search.perplexity : undefined;
  if (!perplexity || typeof perplexity !== "object") return {};
  return perplexity as PerplexityConfig;
}

function resolveExaConfig(search?: WebSearchConfig): ExaConfig {
  if (!search || typeof search !== "object") return {};
  const exa = "exa" in search ? search.exa : undefined;
  if (!exa || typeof exa !== "object") return {};
  return exa as ExaConfig;
}

function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: PerplexityApiKeySource;
} {
  const fromConfig = normalizeApiKey(perplexity?.apiKey);
  if (fromConfig) {
    return { apiKey: fromConfig, source: "config" };
  }

  const fromEnvPerplexity = normalizeApiKey(process.env.PERPLEXITY_API_KEY);
  if (fromEnvPerplexity) {
    return { apiKey: fromEnvPerplexity, source: "perplexity_env" };
  }

  const fromEnvOpenRouter = normalizeApiKey(process.env.OPENROUTER_API_KEY);
  if (fromEnvOpenRouter) {
    return { apiKey: fromEnvOpenRouter, source: "openrouter_env" };
  }

  return { apiKey: undefined, source: "none" };
}

function normalizeApiKey(key: unknown): string {
  return typeof key === "string" ? key.trim() : "";
}

function normalizeApiKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(normalizeApiKey).filter(Boolean);
}

function normalizeApiKeysCsv(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  return trimmed
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolveExaApiKeys(exa?: ExaConfig): string[] {
  const fromConfigKeys = normalizeApiKeys(exa?.apiKeys);
  if (fromConfigKeys.length > 0) return fromConfigKeys;

  const fromEnvKeys = normalizeApiKeysCsv(process.env.EXA_API_KEYS);
  if (fromEnvKeys.length > 0) return fromEnvKeys;

  const fromConfigKey = normalizeApiKey(exa?.apiKey);
  if (fromConfigKey) return [fromConfigKey];

  const fromEnvKey = normalizeApiKey(process.env.EXA_API_KEY);
  if (fromEnvKey) return [fromEnvKey];

  return [];
}

function resolveExaBaseUrl(exa?: ExaConfig): string {
  const fromConfig = typeof exa?.baseUrl === "string" ? exa.baseUrl.trim() : "";
  return fromConfig || DEFAULT_EXA_BASE_URL;
}

function resolveExaSearchType(exa?: ExaConfig): "fast" | "auto" {
  const raw = typeof exa?.searchType === "string" ? exa.searchType.trim().toLowerCase() : "";
  if (raw === "fast") return "fast";
  return DEFAULT_EXA_SEARCH_TYPE;
}

function resolveExaContentMode(exa?: ExaConfig): "highlights" | "text" {
  const raw = typeof exa?.contentMode === "string" ? exa.contentMode.trim().toLowerCase() : "";
  if (raw === "text") return "text";
  return DEFAULT_EXA_CONTENT_MODE;
}

function resolveExaMaxCharacters(exa?: ExaConfig): number {
  const raw =
    typeof exa?.maxCharacters === "number" && Number.isFinite(exa.maxCharacters)
      ? exa.maxCharacters
      : DEFAULT_EXA_MAX_CHARACTERS;
  return Math.max(1, Math.floor(raw));
}

function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined {
  if (!apiKey) return undefined;
  const normalized = apiKey.toLowerCase();
  if (PERPLEXITY_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "direct";
  }
  if (OPENROUTER_KEY_PREFIXES.some((prefix) => normalized.startsWith(prefix))) {
    return "openrouter";
  }
  return undefined;
}

function resolvePerplexityBaseUrl(
  perplexity?: PerplexityConfig,
  apiKeySource: PerplexityApiKeySource = "none",
  apiKey?: string,
): string {
  const fromConfig =
    perplexity && "baseUrl" in perplexity && typeof perplexity.baseUrl === "string"
      ? perplexity.baseUrl.trim()
      : "";
  if (fromConfig) return fromConfig;
  if (apiKeySource === "perplexity_env") return PERPLEXITY_DIRECT_BASE_URL;
  if (apiKeySource === "openrouter_env") return DEFAULT_PERPLEXITY_BASE_URL;
  if (apiKeySource === "config") {
    const inferred = inferPerplexityBaseUrlFromApiKey(apiKey);
    if (inferred === "direct") return PERPLEXITY_DIRECT_BASE_URL;
    if (inferred === "openrouter") return DEFAULT_PERPLEXITY_BASE_URL;
  }
  return DEFAULT_PERPLEXITY_BASE_URL;
}

function resolvePerplexityModel(perplexity?: PerplexityConfig): string {
  const fromConfig =
    perplexity && "model" in perplexity && typeof perplexity.model === "string"
      ? perplexity.model.trim()
      : "";
  return fromConfig || DEFAULT_PERPLEXITY_MODEL;
}

function resolveSearchCount(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const clamped = Math.max(1, Math.min(MAX_SEARCH_COUNT, Math.floor(parsed)));
  return clamped;
}

function normalizeFreshness(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const lower = trimmed.toLowerCase();
  if (BRAVE_FRESHNESS_SHORTCUTS.has(lower)) return lower;

  const match = trimmed.match(BRAVE_FRESHNESS_RANGE);
  if (!match) return undefined;

  const [, start, end] = match;
  if (!isValidIsoDate(start) || !isValidIsoDate(end)) return undefined;
  if (start > end) return undefined;

  return `${start}to${end}`;
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return false;

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function resolveSiteName(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

async function runPerplexitySearch(params: {
  query: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutSeconds: number;
}): Promise<{ content: string; citations: string[] }> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/chat/completions`;

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${params.apiKey}`,
      "HTTP-Referer": "https://clawdbot.com",
      "X-Title": "Clawdbot Web Search",
    },
    body: JSON.stringify({
      model: params.model,
      messages: [
        {
          role: "user",
          content: params.query,
        },
      ],
    }),
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Perplexity API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as PerplexitySearchResponse;
  const content = data.choices?.[0]?.message?.content ?? "No response";
  const citations = data.citations ?? [];

  return { content, citations };
}

function shouldRotateExaKey(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

function createExaContents(params: {
  contentMode: "highlights" | "text";
  maxCharacters: number;
}): Record<string, unknown> {
  if (params.contentMode === "text") {
    return {
      text: { max_characters: params.maxCharacters },
    };
  }
  return {
    highlights: { max_characters: params.maxCharacters },
  };
}

function resolveExaDescription(
  entry: ExaSearchResult,
  params: { contentMode: "highlights" | "text" },
): string {
  if (params.contentMode === "text") {
    return typeof entry.text === "string" ? entry.text : "";
  }
  if (Array.isArray(entry.highlights) && typeof entry.highlights[0] === "string") {
    return entry.highlights[0];
  }
  return typeof entry.text === "string" ? entry.text : "";
}

async function runExaSearch(params: {
  query: string;
  count: number;
  apiKeys: string[];
  baseUrl: string;
  searchType: "fast" | "auto";
  contentMode: "highlights" | "text";
  maxCharacters: number;
  timeoutSeconds: number;
}): Promise<
  | { ok: true; results: Array<Record<string, unknown>>; keyIndex: number }
  | { ok: false; error: string; message: string; attempts: ExaKeyAttempt[] }
> {
  const endpoint = `${params.baseUrl.replace(/\/$/, "")}/search`;
  const body = {
    query: params.query,
    num_results: params.count,
    type: params.searchType,
    contents: createExaContents({
      contentMode: params.contentMode,
      maxCharacters: params.maxCharacters,
    }),
  };

  const attempts: ExaKeyAttempt[] = [];

  for (let keyIndex = 0; keyIndex < params.apiKeys.length; keyIndex += 1) {
    const apiKey = params.apiKeys[keyIndex];
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: withTimeout(undefined, params.timeoutSeconds * 1000),
      });

      if (!res.ok) {
        const detail = await readResponseText(res);
        const attempt: ExaKeyAttempt = {
          keyIndex,
          status: res.status,
          error: detail || res.statusText,
        };
        if (shouldRotateExaKey(res.status)) {
          attempts.push(attempt);
          continue;
        }

        return {
          ok: false,
          error: "exa_api_error",
          message: `Exa API error (${res.status}): ${detail || res.statusText}`,
          attempts: [attempt],
        };
      }

      const data = (await res.json()) as ExaSearchResponse;
      const results = Array.isArray(data.results) ? data.results : [];
      const mapped = results.map((entry) => {
        const url = typeof entry.url === "string" ? entry.url : "";
        return {
          title: typeof entry.title === "string" ? entry.title : "",
          url,
          description: resolveExaDescription(entry, { contentMode: params.contentMode }),
          published: entry.publishedDate ?? entry.published_date ?? undefined,
          siteName: resolveSiteName(url),
        };
      });

      return { ok: true, results: mapped, keyIndex };
    } catch (err) {
      attempts.push({
        keyIndex,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
  }

  return {
    ok: false,
    error: "exa_key_pool_exhausted",
    message: "Exa search failed for all configured API keys.",
    attempts,
  };
}

async function runWebSearch(params: {
  query: string;
  count: number;
  apiKey?: string;
  apiKeys?: string[];
  timeoutSeconds: number;
  cacheTtlMs: number;
  provider: (typeof SEARCH_PROVIDERS)[number];
  country?: string;
  search_lang?: string;
  ui_lang?: string;
  freshness?: string;
  perplexityBaseUrl?: string;
  perplexityModel?: string;
  exaBaseUrl?: string;
  exaSearchType?: "fast" | "auto";
  exaContentMode?: "highlights" | "text";
  exaMaxCharacters?: number;
}): Promise<Record<string, unknown>> {
  const cacheKey = normalizeCacheKey(
    params.provider === "brave"
      ? `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}:${params.freshness || "default"}`
      : params.provider === "exa"
        ? `${params.provider}:${params.query}:${params.count}:${params.exaSearchType || DEFAULT_EXA_SEARCH_TYPE}:${params.exaContentMode || DEFAULT_EXA_CONTENT_MODE}:${params.exaMaxCharacters || DEFAULT_EXA_MAX_CHARACTERS}:${params.exaBaseUrl || DEFAULT_EXA_BASE_URL}`
        : `${params.provider}:${params.query}:${params.count}:${params.country || "default"}:${params.search_lang || "default"}:${params.ui_lang || "default"}`,
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) return { ...cached.value, cached: true };

  const start = Date.now();

  if (params.provider === "exa") {
    const apiKeys = Array.isArray(params.apiKeys) ? params.apiKeys.filter(Boolean) : [];
    if (apiKeys.length === 0) {
      return {
        error: "missing_exa_api_key",
        message: "Exa API key is missing (set tools.web.search.exa.apiKey/apiKeys or EXA_API_KEY(S)).",
        docs: "https://docs.clawd.bot/tools/web",
      };
    }

    const contentMode = params.exaContentMode ?? DEFAULT_EXA_CONTENT_MODE;
    const searchType = params.exaSearchType ?? DEFAULT_EXA_SEARCH_TYPE;
    const maxCharacters = params.exaMaxCharacters ?? DEFAULT_EXA_MAX_CHARACTERS;
    const baseUrl = params.exaBaseUrl ?? DEFAULT_EXA_BASE_URL;

    const exa = await runExaSearch({
      query: params.query,
      count: params.count,
      apiKeys,
      baseUrl,
      searchType,
      contentMode,
      maxCharacters,
      timeoutSeconds: params.timeoutSeconds,
    });

    if (!exa.ok) {
      return {
        query: params.query,
        provider: params.provider,
        tookMs: Date.now() - start,
        error: exa.error,
        message: exa.message,
        attempts: exa.attempts,
      };
    }

    const payload = {
      query: params.query,
      provider: params.provider,
      count: exa.results.length,
      tookMs: Date.now() - start,
      searchType,
      contentMode,
      maxCharacters,
      results: exa.results,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider === "perplexity") {
    if (!params.apiKey) {
      throw new Error("Perplexity API key is missing.");
    }
    const { content, citations } = await runPerplexitySearch({
      query: params.query,
      apiKey: params.apiKey,
      baseUrl: params.perplexityBaseUrl ?? DEFAULT_PERPLEXITY_BASE_URL,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      timeoutSeconds: params.timeoutSeconds,
    });

    const payload = {
      query: params.query,
      provider: params.provider,
      model: params.perplexityModel ?? DEFAULT_PERPLEXITY_MODEL,
      tookMs: Date.now() - start,
      content,
      citations,
    };
    writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
    return payload;
  }

  if (params.provider !== "brave") {
    throw new Error("Unsupported web search provider.");
  }
  if (!params.apiKey) {
    throw new Error("Brave Search API key is missing.");
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set("q", params.query);
  url.searchParams.set("count", String(params.count));
  if (params.country) {
    url.searchParams.set("country", params.country);
  }
  if (params.search_lang) {
    url.searchParams.set("search_lang", params.search_lang);
  }
  if (params.ui_lang) {
    url.searchParams.set("ui_lang", params.ui_lang);
  }
  if (params.freshness) {
    url.searchParams.set("freshness", params.freshness);
  }

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": params.apiKey,
    },
    signal: withTimeout(undefined, params.timeoutSeconds * 1000),
  });

  if (!res.ok) {
    const detail = await readResponseText(res);
    throw new Error(`Brave Search API error (${res.status}): ${detail || res.statusText}`);
  }

  const data = (await res.json()) as BraveSearchResponse;
  const results = Array.isArray(data.web?.results) ? (data.web?.results ?? []) : [];
  const mapped = results.map((entry) => ({
    title: entry.title ?? "",
    url: entry.url ?? "",
    description: entry.description ?? "",
    published: entry.age ?? undefined,
    siteName: resolveSiteName(entry.url ?? ""),
  }));

  const payload = {
    query: params.query,
    provider: params.provider,
    count: mapped.length,
    tookMs: Date.now() - start,
    results: mapped,
  };
  writeCache(SEARCH_CACHE, cacheKey, payload, params.cacheTtlMs);
  return payload;
}

export function createWebSearchTool(options?: {
  config?: ClawdbotConfig;
  sandboxed?: boolean;
}): AnyAgentTool | null {
  const search = resolveSearchConfig(options?.config);
  if (!resolveSearchEnabled({ search, sandboxed: options?.sandboxed })) return null;

  const provider = resolveSearchProvider(search);
  const perplexityConfig = resolvePerplexityConfig(search);
  const exaConfig = resolveExaConfig(search);

  const description =
    provider === "perplexity"
      ? "Search the web using Perplexity Sonar (direct or via OpenRouter). Returns AI-synthesized answers with citations from real-time web search."
      : provider === "exa"
        ? "Search the web using Exa Search API. Returns titles, URLs, and snippets from fetched page content (highlights or text)."
        : "Search the web using Brave Search API. Supports region-specific and localized search via country and language parameters. Returns titles, URLs, and snippets for fast research.";

  return {
    label: "Web Search",
    name: "web_search",
    description,
    parameters: WebSearchSchema,
    execute: async (_toolCallId, args) => {
      const perplexityAuth = provider === "perplexity" ? resolvePerplexityApiKey(perplexityConfig) : null;
      const apiKey = provider === "brave" ? resolveSearchApiKey(search) : perplexityAuth?.apiKey;
      const exaApiKeys = provider === "exa" ? resolveExaApiKeys(exaConfig) : null;

      if (provider === "exa") {
        if (!exaApiKeys || exaApiKeys.length === 0) {
          return jsonResult(missingSearchKeyPayload(provider));
        }
      } else if (!apiKey) {
        return jsonResult(missingSearchKeyPayload(provider));
      }
      const params = args as Record<string, unknown>;
      const query = readStringParam(params, "query", { required: true });
      const count =
        readNumberParam(params, "count", { integer: true }) ?? search?.maxResults ?? undefined;
      const country = readStringParam(params, "country");
      const search_lang = readStringParam(params, "search_lang");
      const ui_lang = readStringParam(params, "ui_lang");
      const rawFreshness = readStringParam(params, "freshness");
      if (rawFreshness && provider === "perplexity") {
        return jsonResult({
          error: "unsupported_freshness",
          message: "freshness is only supported by the Brave web_search provider.",
          docs: "https://docs.clawd.bot/tools/web",
        });
      }
      const freshness = provider === "brave" && rawFreshness ? normalizeFreshness(rawFreshness) : undefined;
      if (provider === "brave" && rawFreshness && !freshness) {
        return jsonResult({
          error: "invalid_freshness",
          message:
            "freshness must be one of pd, pw, pm, py, or a range like YYYY-MM-DDtoYYYY-MM-DD.",
          docs: "https://docs.clawd.bot/tools/web",
        });
      }
      const result = await runWebSearch({
        query,
        count: resolveSearchCount(count, DEFAULT_SEARCH_COUNT),
        apiKey,
        apiKeys: provider === "exa" ? exaApiKeys ?? undefined : undefined,
        timeoutSeconds: resolveTimeoutSeconds(search?.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS),
        cacheTtlMs: resolveCacheTtlMs(search?.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES),
        provider,
        country,
        search_lang,
        ui_lang,
        freshness,
        perplexityBaseUrl: resolvePerplexityBaseUrl(
          perplexityConfig,
          perplexityAuth?.source,
          perplexityAuth?.apiKey,
        ),
        perplexityModel: resolvePerplexityModel(perplexityConfig),
        exaBaseUrl: provider === "exa" ? resolveExaBaseUrl(exaConfig) : undefined,
        exaSearchType: provider === "exa" ? resolveExaSearchType(exaConfig) : undefined,
        exaContentMode: provider === "exa" ? resolveExaContentMode(exaConfig) : undefined,
        exaMaxCharacters: provider === "exa" ? resolveExaMaxCharacters(exaConfig) : undefined,
      });
      return jsonResult(result);
    },
  };
}

export const __testing = {
  inferPerplexityBaseUrlFromApiKey,
  resolvePerplexityBaseUrl,
  normalizeFreshness,
  resolveExaApiKeys,
} as const;
