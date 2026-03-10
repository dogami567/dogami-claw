import { toPhoneAccountSummary, toPhoneRuntimeSummary } from "../config.js";
import type { PhoneRuntimeAdapter } from "../runtime.js";
import { PhoneError } from "../types.js";
import type {
  PhoneRuntimeEvent,
  PhoneResolvedAccount,
  PhoneScreenRequest,
  PhoneRunRequest,
  PhoneRuntimeDiscoveredDevice,
  PhoneWaitRequest,
} from "../types.js";

type JsonRecord = Record<string, unknown>;
type AutoglmRunTerminal = {
  status: "completed" | "failed" | "stopped";
  ok: boolean;
  message?: string;
  finalEvent: JsonRecord;
  events: PhoneRuntimeEvent[];
};

const AUTOGLM_RUN_WAIT_TIMEOUT_MS = 10 * 60_000;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function resolveAutoglmApiUrl(account: PhoneResolvedAccount): string {
  const direct = normalizeOptionalString(account.runtime.apiUrl);
  if (direct) return trimTrailingSlash(direct);

  const uiUrl = normalizeOptionalString(account.runtime.uiUrl);
  if (!uiUrl) {
    throw new PhoneError(
      "invalid_request",
      `phone account "${account.id}" is missing runtime.apiUrl or runtime.uiUrl`,
    );
  }

  const trimmed = trimTrailingSlash(uiUrl);
  return trimmed.endsWith("/api") ? trimmed : `${trimmed}/api`;
}

function resolvePathUrl(apiUrl: string, path: string): string {
  return `${apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function buildHeaders(account: PhoneResolvedAccount, initHeaders?: HeadersInit): Headers {
  const headers = new Headers(account.runtime.headers ?? {});
  if (initHeaders) {
    for (const [key, value] of new Headers(initHeaders).entries()) {
      headers.set(key, value);
    }
  }
  return headers;
}

function resolveScreenQuery(account: PhoneResolvedAccount, request?: PhoneScreenRequest): string {
  const deviceId =
    normalizeOptionalString(request?.deviceId) ?? normalizeOptionalString(account.deviceId);
  if (!deviceId) return "";
  const params = new URLSearchParams({ device_id: deviceId });
  return `?${params.toString()}`;
}

function parseJsonText(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function extractErrorMessage(status: number, responseText: string): string {
  const parsed = parseJsonText(responseText);
  if (isRecord(parsed)) {
    const detail = normalizeOptionalString(parsed.detail);
    if (detail) return detail;
    const message = normalizeOptionalString(parsed.message);
    if (message) return message;
  }
  const text = normalizeOptionalString(responseText);
  return text ? `phone runtime returned ${status}: ${text}` : `phone runtime returned ${status}`;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function resolveRunWaitTimeoutMs(account: PhoneResolvedAccount, request: PhoneRunRequest): number {
  return request.waitTimeoutMs ?? Math.max(account.runtime.timeoutMs, AUTOGLM_RUN_WAIT_TIMEOUT_MS);
}

function resolveWaitTimeoutMs(account: PhoneResolvedAccount, request: PhoneWaitRequest): number {
  return request.waitTimeoutMs ?? Math.max(account.runtime.timeoutMs, AUTOGLM_RUN_WAIT_TIMEOUT_MS);
}

function decodeStreamChunk(decoder: TextDecoder, value?: Uint8Array): string {
  if (!value) return "";
  return decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
}

function parseSseDataBlock(block: string): string | undefined {
  const dataLines = block
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart());
  if (dataLines.length === 0) return undefined;
  const data = dataLines.join("\n").trim();
  return data || undefined;
}

function classifyAutoglmTerminalEvent(event: JsonRecord): AutoglmRunTerminal | undefined {
  const type = normalizeOptionalString(event.type);
  if (!type) return undefined;

  if (type === "error") {
    return {
      status: "failed",
      ok: false,
      message: normalizeOptionalString(event.message),
      finalEvent: event,
      events: [],
    };
  }

  if (type === "end") {
    const message = normalizeOptionalString(event.message);
    const normalizedMessage = (message ?? "").trim().toLowerCase();
    const stopped = normalizedMessage === "stopped";
    const failed =
      normalizedMessage.startsWith("model error:") || normalizedMessage.startsWith("error:");
    return {
      status: stopped ? "stopped" : failed ? "failed" : "completed",
      ok: !(stopped || failed),
      message,
      finalEvent: event,
      events: [],
    };
  }

  return undefined;
}

async function waitForAutoglmRunCompletion(
  account: PhoneResolvedAccount,
  apiUrl: string,
  runId: string,
  timeoutMs: number,
): Promise<AutoglmRunTerminal> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      resolvePathUrl(apiUrl, `/run/stream?run_id=${encodeURIComponent(runId)}`),
      {
        headers: buildHeaders(account),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const bodyText = await response.text();
      throw new PhoneError(
        response.status >= 500 ? "unavailable" : "invalid_request",
        extractErrorMessage(response.status, bodyText),
      );
    }
    if (!response.body) {
      throw new PhoneError("unavailable", "phone runtime stream returned no body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const events: PhoneRuntimeEvent[] = [];

    const processBlock = (block: string): AutoglmRunTerminal | undefined => {
      const data = parseSseDataBlock(block);
      if (!data || data === "[DONE]") return undefined;
      const parsed = parseJsonText(data);
      if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined;
      events.push(parsed as PhoneRuntimeEvent);
      const terminal = classifyAutoglmTerminalEvent(parsed);
      return terminal ? { ...terminal, events: [...events] } : undefined;
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decodeStreamChunk(decoder, value);

      let delimiterIndex = buffer.indexOf("\n\n");
      while (delimiterIndex !== -1) {
        const block = buffer.slice(0, delimiterIndex);
        buffer = buffer.slice(delimiterIndex + 2);
        const terminal = processBlock(block);
        if (terminal) return terminal;
        delimiterIndex = buffer.indexOf("\n\n");
      }

      if (done) break;
    }

    buffer += decoder.decode();
    if (buffer.trim()) {
      const terminal = processBlock(buffer);
      if (terminal) return terminal;
    }

    throw new PhoneError(
      "unavailable",
      "phone runtime stream ended before a terminal event was received",
    );
  } catch (error) {
    if (error instanceof PhoneError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PhoneError("unavailable", `phone runtime wait timed out after ${timeoutMs}ms`);
    }
    throw new PhoneError("unavailable", `phone runtime stream failed: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function requestJson(
  account: PhoneResolvedAccount,
  apiUrl: string,
  path: string,
  init?: RequestInit,
): Promise<JsonRecord> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.runtime.timeoutMs);

  try {
    const response = await fetch(resolvePathUrl(apiUrl, path), {
      ...init,
      headers: buildHeaders(account, init?.headers),
      signal: controller.signal,
    });
    const bodyText = await response.text();
    const parsed = parseJsonText(bodyText);

    if (!response.ok) {
      throw new PhoneError(
        response.status >= 500 ? "unavailable" : "invalid_request",
        extractErrorMessage(response.status, bodyText),
      );
    }

    if (isRecord(parsed)) return parsed;
    if (!bodyText.trim()) return {};
    throw new PhoneError("unavailable", `phone runtime returned non-object JSON for ${path}`);
  } catch (error) {
    if (error instanceof PhoneError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new PhoneError(
        "unavailable",
        `phone runtime request timed out after ${account.runtime.timeoutMs}ms`,
      );
    }
    throw new PhoneError("unavailable", `phone runtime request failed: ${getErrorMessage(error)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function postJson(
  account: PhoneResolvedAccount,
  apiUrl: string,
  path: string,
  payload: JsonRecord,
): Promise<JsonRecord> {
  return requestJson(account, apiUrl, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

function setIfDefined(target: JsonRecord, key: string, value: unknown) {
  if (value !== undefined) target[key] = value;
}

function readPayloadString(payload: JsonRecord, key: string): string | undefined {
  return normalizeOptionalString(payload[key]);
}

function readPayloadNumber(payload: JsonRecord, key: string): number | undefined {
  return normalizeOptionalNumber(payload[key]);
}

function readPayloadBoolean(payload: JsonRecord, key: string): boolean | undefined {
  return normalizeOptionalBoolean(payload[key]);
}

function normalizeDeviceRecord(
  value: unknown,
  fallbackDeviceType?: string,
): PhoneRuntimeDiscoveredDevice | null {
  if (!isRecord(value)) return null;

  const deviceId =
    normalizeOptionalString(value.device_id) ??
    normalizeOptionalString(value.deviceId) ??
    normalizeOptionalString(value.serial);
  if (!deviceId) return null;

  return {
    deviceId,
    deviceType:
      normalizeOptionalString(value.device_type) ??
      normalizeOptionalString(value.deviceType) ??
      fallbackDeviceType,
    state: normalizeOptionalString(value.state),
    label:
      normalizeOptionalString(value.label) ??
      normalizeOptionalString(value.name) ??
      normalizeOptionalString(value.model),
    raw: value,
  };
}

function parseDiscoverPayload(raw: JsonRecord) {
  const deviceType = normalizeOptionalString(raw.device_type);
  const devices = Array.isArray(raw.devices)
    ? raw.devices
        .map((entry) => normalizeDeviceRecord(entry, deviceType))
        .filter((entry): entry is PhoneRuntimeDiscoveredDevice => Boolean(entry))
    : [];

  return {
    raw,
    deviceType,
    devices,
    count: normalizeOptionalNumber(raw.count) ?? devices.length,
  };
}

function buildRunPayload(account: PhoneResolvedAccount, request: PhoneRunRequest): JsonRecord {
  const payload = isRecord(request.payload) ? { ...request.payload } : {};

  const payloadMode = normalizeOptionalString(payload.mode);
  const mode =
    request.mode ??
    (payloadMode === "monitor" ? "monitor" : payloadMode === "direct" ? "direct" : undefined) ??
    account.defaults.mode;
  if (mode) payload.mode = mode;

  const task = normalizeOptionalString(request.task) ?? readPayloadString(payload, "task");
  const goal = normalizeOptionalString(request.goal) ?? readPayloadString(payload, "goal");
  if (task) payload.task = task;
  if (goal) payload.goal = goal;

  if (mode === "monitor" && !goal && task) {
    payload.goal = task;
  }
  if (mode !== "monitor" && !task && goal) {
    payload.task = goal;
  }

  if (!normalizeOptionalString(payload.task) && !normalizeOptionalString(payload.goal)) {
    throw new PhoneError("invalid_request", "phone.run requires task or goal");
  }

  setIfDefined(
    payload,
    "device_type",
    normalizeOptionalString(request.deviceType) ??
      readPayloadString(payload, "device_type") ??
      account.deviceType,
  );
  setIfDefined(
    payload,
    "device_id",
    normalizeOptionalString(request.deviceId) ??
      readPayloadString(payload, "device_id") ??
      account.deviceId,
  );
  setIfDefined(
    payload,
    "lang",
    normalizeOptionalString(request.lang) ??
      readPayloadString(payload, "lang") ??
      account.defaults.lang,
  );
  setIfDefined(
    payload,
    "max_steps",
    request.maxSteps ?? readPayloadNumber(payload, "max_steps") ?? account.defaults.maxSteps,
  );
  setIfDefined(
    payload,
    "max_rounds",
    request.maxRounds ?? readPayloadNumber(payload, "max_rounds") ?? account.defaults.maxRounds,
  );
  setIfDefined(
    payload,
    "executor_max_steps",
    request.executorMaxSteps ??
      readPayloadNumber(payload, "executor_max_steps") ??
      account.defaults.executorMaxSteps,
  );
  setIfDefined(
    payload,
    "simulate",
    request.simulate ?? readPayloadBoolean(payload, "simulate") ?? account.defaults.simulate,
  );
  setIfDefined(payload, "dry_run", request.dryRun ?? readPayloadBoolean(payload, "dry_run"));
  setIfDefined(
    payload,
    "monitor_use_screenshot",
    request.monitorUseScreenshot ??
      readPayloadBoolean(payload, "monitor_use_screenshot") ??
      account.defaults.monitorUseScreenshot,
  );
  setIfDefined(
    payload,
    "temperature",
    request.temperature ?? readPayloadNumber(payload, "temperature") ?? account.model.temperature,
  );
  setIfDefined(
    payload,
    "base_url",
    normalizeOptionalString(request.baseUrl) ??
      readPayloadString(payload, "base_url") ??
      account.model.baseUrl,
  );
  setIfDefined(
    payload,
    "model",
    normalizeOptionalString(request.model) ??
      readPayloadString(payload, "model") ??
      account.model.model,
  );
  setIfDefined(
    payload,
    "api_key",
    normalizeOptionalString(request.apiKey) ??
      readPayloadString(payload, "api_key") ??
      account.model.apiKey,
  );
  setIfDefined(
    payload,
    "monitor_base_url",
    normalizeOptionalString(request.monitorBaseUrl) ??
      readPayloadString(payload, "monitor_base_url") ??
      account.model.monitorBaseUrl,
  );
  setIfDefined(
    payload,
    "monitor_model",
    normalizeOptionalString(request.monitorModel) ??
      readPayloadString(payload, "monitor_model") ??
      account.model.monitorModel,
  );
  setIfDefined(
    payload,
    "monitor_api_key",
    normalizeOptionalString(request.monitorApiKey) ??
      readPayloadString(payload, "monitor_api_key") ??
      account.model.monitorApiKey,
  );
  setIfDefined(
    payload,
    "monitor_temperature",
    request.monitorTemperature ??
      readPayloadNumber(payload, "monitor_temperature") ??
      account.model.monitorTemperature,
  );
  setIfDefined(
    payload,
    "monitor_prompt",
    normalizeOptionalString(request.monitorPrompt) ??
      readPayloadString(payload, "monitor_prompt") ??
      account.model.monitorPrompt,
  );

  return payload;
}

export function createAutoglmPhoneRuntime(): PhoneRuntimeAdapter {
  return {
    async discover(account) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const raw = await requestJson(account, apiUrl, "/devices");
      const parsed = parseDiscoverPayload(raw);
      return {
        account: toPhoneAccountSummary(account),
        runtime: toPhoneRuntimeSummary(account, apiUrl),
        count: parsed.count,
        deviceType: parsed.deviceType,
        devices: parsed.devices,
        raw: parsed.raw,
      };
    },

    async getStatus(account) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const runtime = toPhoneRuntimeSummary(account, apiUrl);
      const [health, devices] = await Promise.allSettled([
        requestJson(account, apiUrl, "/health"),
        requestJson(account, apiUrl, "/devices"),
      ]);

      return {
        account: toPhoneAccountSummary(account),
        runtime,
        ok:
          health.status === "fulfilled" &&
          (typeof health.value.ok !== "boolean" || health.value.ok === true),
        health: health.status === "fulfilled" ? health.value : null,
        devices: devices.status === "fulfilled" ? devices.value : null,
        healthError: health.status === "rejected" ? getErrorMessage(health.reason) : undefined,
        devicesError: devices.status === "rejected" ? getErrorMessage(devices.reason) : undefined,
      };
    },

    async checkConnectivity(account) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const check = await postJson(account, apiUrl, "/connectivity-check", {
        device_type: account.deviceType,
        device_id: account.deviceId,
      });
      return {
        account: toPhoneAccountSummary(account),
        runtime: toPhoneRuntimeSummary(account, apiUrl),
        check,
      };
    },

    async screen(account, request) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const response = await fetch(
        resolvePathUrl(apiUrl, `/screen${resolveScreenQuery(account, request)}`),
        {
          method: "GET",
          headers: buildHeaders(account),
        },
      );

      if (!response.ok) {
        const responseText = await response.text();
        throw new PhoneError("unavailable", extractErrorMessage(response.status, responseText));
      }

      const mimeType = normalizeOptionalString(response.headers.get("content-type")) ?? "image/png";
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new PhoneError("unavailable", "phone screen returned an empty image");
      }

      return {
        account: toPhoneAccountSummary(account),
        runtime: toPhoneRuntimeSummary(account, apiUrl),
        ok: true,
        screenshot: {
          deviceId:
            normalizeOptionalString(request?.deviceId) ?? normalizeOptionalString(account.deviceId),
          mimeType,
          base64: bytes.toString("base64"),
          bytes: bytes.byteLength,
        },
      };
    },

    async run(account, request) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const raw = await postJson(account, apiUrl, "/run", buildRunPayload(account, request));
      const runId = normalizeOptionalString(raw.run_id);
      const waitForCompletion = request.waitForCompletion === true;
      const terminal =
        waitForCompletion && runId
          ? await waitForAutoglmRunCompletion(
              account,
              apiUrl,
              runId,
              resolveRunWaitTimeoutMs(account, request),
            )
          : undefined;

      return {
        account: toPhoneAccountSummary(account),
        runtime: toPhoneRuntimeSummary(account, apiUrl),
        ok: terminal ? terminal.ok : raw.ok !== false,
        status: terminal?.status ?? "accepted",
        runId,
        message: terminal?.message,
        completed: Boolean(terminal),
        finalEvent: terminal?.finalEvent,
        events: terminal?.events,
        raw,
      };
    },

    async wait(account, request) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const terminal = await waitForAutoglmRunCompletion(
        account,
        apiUrl,
        request.runId,
        resolveWaitTimeoutMs(account, request),
      );
      return {
        account: toPhoneAccountSummary(account),
        runtime: toPhoneRuntimeSummary(account, apiUrl),
        ok: terminal.ok,
        status: terminal.status,
        runId: request.runId,
        message: terminal.message,
        completed: true,
        finalEvent: terminal.finalEvent,
        events: terminal.events,
        raw: {
          ok: terminal.ok,
          run_id: request.runId,
        },
      };
    },

    async stop(account, request) {
      const apiUrl = resolveAutoglmApiUrl(account);
      const payload: JsonRecord = {};
      setIfDefined(payload, "run_id", normalizeOptionalString(request?.runId));
      const raw = await postJson(account, apiUrl, "/run/stop", payload);
      return {
        account: toPhoneAccountSummary(account),
        runtime: toPhoneRuntimeSummary(account, apiUrl),
        ok: raw.ok !== false,
        stopped: raw.stopped === true,
        message: normalizeOptionalString(raw.message),
        raw,
      };
    },
  };
}
