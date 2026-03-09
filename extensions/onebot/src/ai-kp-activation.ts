import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { resolveOneBotAiKpConfig } from "./ai-kp-context.js";

type RunEmbeddedPiAgentFn = (params: Record<string, unknown>) => Promise<unknown>;

export type OneBotAiKpActivationIntent =
  | "normal"
  | "start"
  | "resume"
  | "new"
  | "exit"
  | "roll";

export type OneBotAiKpActivationDecision = {
  action: OneBotAiKpActivationIntent;
  confidence: number;
  reason: string;
};

export type OneBotAiKpSessionRouteIntent =
  | "normal"
  | "start"
  | "resume"
  | "new_line"
  | "pause"
  | "reply_to_prompt"
  | "list_saves"
  | "list_story_packs"
  | "panel_state"
  | "panel_recap"
  | "panel_party";

export type OneBotAiKpSessionRouteDecision = {
  action: OneBotAiKpSessionRouteIntent;
  confidence: number;
  reason: string;
};

const VALID_ACTIONS = new Set<OneBotAiKpActivationIntent>([
  "normal",
  "start",
  "resume",
  "new",
  "exit",
  "roll",
]);

const VALID_SESSION_ROUTE_ACTIONS = new Set<OneBotAiKpSessionRouteIntent>([
  "normal",
  "start",
  "resume",
  "new_line",
  "pause",
  "reply_to_prompt",
  "list_saves",
  "list_story_packs",
  "panel_state",
  "panel_recap",
  "panel_party",
]);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 120;

async function loadRunEmbeddedPiAgent(): Promise<RunEmbeddedPiAgentFn> {
  try {
    const mod = await import("../../../src/agents/pi-embedded-runner.js");
    if (typeof (mod as { runEmbeddedPiAgent?: unknown }).runEmbeddedPiAgent === "function") {
      return (mod as { runEmbeddedPiAgent: RunEmbeddedPiAgentFn }).runEmbeddedPiAgent;
    }
  } catch {
    // ignore source checkout miss
  }

  const mod = await import("../../../agents/pi-embedded-runner.js");
  if (typeof (mod as { runEmbeddedPiAgent?: unknown }).runEmbeddedPiAgent !== "function") {
    throw new Error("Internal error: runEmbeddedPiAgent not available");
  }
  return (mod as { runEmbeddedPiAgent: RunEmbeddedPiAgentFn }).runEmbeddedPiAgent;
}

function collectText(payloads: Array<{ text?: string; isError?: boolean }> | undefined): string {
  return (payloads ?? [])
    .filter((payload) => !payload.isError && typeof payload.text === "string")
    .map((payload) => payload.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return (match?.[1] ?? trimmed).trim();
}

function normalizeAgentId(raw?: string | null): string | null {
  const value = raw?.trim().toLowerCase();
  return value ? value : null;
}

function resolveAgentModelValue(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    return raw.trim() || undefined;
  }
  if (raw && typeof raw === "object" && typeof (raw as { primary?: unknown }).primary === "string") {
    return ((raw as { primary: string }).primary || "").trim() || undefined;
  }
  return undefined;
}

function resolveConfiguredAgentModel(cfg: ClawdbotConfig, agentId?: string | null): string | undefined {
  const normalizedAgentId = normalizeAgentId(agentId);
  const agents = Array.isArray(cfg.agents?.list) ? cfg.agents?.list : [];
  if (normalizedAgentId) {
    const entry = agents.find((item) => normalizeAgentId(item?.id) === normalizedAgentId);
    const specific = resolveAgentModelValue(entry?.model);
    if (specific) return specific;
  }
  return resolveAgentModelValue(cfg.agents?.defaults?.model);
}

function splitProviderModel(raw?: string | null): { provider?: string; model?: string } {
  const value = raw?.trim();
  if (!value) return {};
  const slash = value.indexOf("/");
  if (slash <= 0 || slash >= value.length - 1) return { model: value };
  return {
    provider: value.slice(0, slash).trim() || undefined,
    model: value.slice(slash + 1).trim() || undefined,
  };
}

function resolveActivationModel(params: {
  cfg: ClawdbotConfig;
  agentId?: string | null;
}): { provider?: string; model?: string; authProfileId?: string; timeoutMs: number; maxTokens: number } {
  const config = resolveOneBotAiKpConfig(params.cfg);
  const configuredCombined = splitProviderModel(config.activationRouterModel);
  const configuredAgent = splitProviderModel(resolveConfiguredAgentModel(params.cfg, params.agentId));
  const provider =
    config.activationRouterProvider ||
    configuredCombined.provider ||
    configuredAgent.provider;
  const model = configuredCombined.model || configuredAgent.model;
  return {
    provider,
    model,
    authProfileId: config.activationRouterAuthProfileId,
    timeoutMs: config.activationRouterTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxTokens: config.activationRouterMaxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

function clampConfidence(raw: unknown): number {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function validateDecision(raw: unknown): OneBotAiKpActivationDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = String((raw as { action?: unknown }).action ?? "").trim() as OneBotAiKpActivationIntent;
  if (!VALID_ACTIONS.has(action)) return null;
  return {
    action,
    confidence: clampConfidence((raw as { confidence?: unknown }).confidence),
    reason: String((raw as { reason?: unknown }).reason ?? "").trim(),
  };
}

function validateSessionRouteDecision(raw: unknown): OneBotAiKpSessionRouteDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = String((raw as { action?: unknown }).action ?? "").trim() as OneBotAiKpSessionRouteIntent;
  if (!VALID_SESSION_ROUTE_ACTIONS.has(action)) return null;
  return {
    action,
    confidence: clampConfidence((raw as { confidence?: unknown }).confidence),
    reason: String((raw as { reason?: unknown }).reason ?? "").trim(),
  };
}

async function runJsonRouter<TDecision>(params: {
  cfg: ClawdbotConfig;
  agentId?: string | null;
  onError?: (message: string) => void;
  prompt: string;
  input: Record<string, unknown>;
  validate: (raw: unknown) => TDecision | null;
  errorLabel: string;
}): Promise<TDecision | null> {
  const resolved = resolveActivationModel({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  if (!resolved.provider || !resolved.model) {
    params.onError?.(`onebot ai-kp: ${params.errorLabel} skipped (provider/model unresolved)`);
    return null;
  }

  let tempDir: string | null = null;
  try {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "onebot-aikp-router-"));
    const sessionId = `onebot-aikp-router-${Date.now()}`;
    const sessionFile = path.join(tempDir, "session.json");
    const runEmbeddedPiAgent = await loadRunEmbeddedPiAgent();
    const result = await runEmbeddedPiAgent({
      sessionId,
      sessionFile,
      workspaceDir: params.cfg.agents?.defaults?.workspace ?? process.cwd(),
      config: params.cfg,
      prompt: `${params.prompt}\n\nINPUT_JSON:\n${JSON.stringify(params.input, null, 2)}\n`,
      timeoutMs: resolved.timeoutMs,
      runId: `onebot-aikp-router-${Date.now()}`,
      provider: resolved.provider,
      model: resolved.model,
      authProfileId: resolved.authProfileId,
      authProfileIdSource: resolved.authProfileId ? "user" : "auto",
      disableTools: true,
      thinkLevel: "minimal",
      verboseLevel: "off",
      reasoningLevel: "off",
      streamParams: {
        temperature: 0,
        maxTokens: resolved.maxTokens,
      },
    });

    const textOutput = collectText((result as { payloads?: Array<{ text?: string; isError?: boolean }> }).payloads);
    if (!textOutput) return null;
    const parsed = JSON.parse(stripCodeFences(textOutput)) as unknown;
    return params.validate(parsed);
  } catch (error) {
    params.onError?.(`onebot ai-kp: ${params.errorLabel} failed: ${String(error)}`);
    return null;
  } finally {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export async function classifyOneBotAiKpActivation(params: {
  cfg: ClawdbotConfig;
  text: string;
  agentId?: string | null;
  hasExistingContext?: boolean;
  onError?: (message: string) => void;
}): Promise<OneBotAiKpActivationDecision | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.activationRouterEnabled) return null;

  const text = params.text.trim();
  if (!text) return null;

  const prompt = [
    "你是 QQ 机器人“麦麦”的模式路由器，只负责判断这条消息要不要切进 AI-KP 跑团模式。",
    '你必须只返回一个 JSON 对象：{"action":"normal|start|resume|new|exit|roll","confidence":0..1,"reason":"简短中文说明"}。',
    '默认选 normal，除非用户是在明确发起、继续、结束、开新线、或者让麦麦帮忙车卡/建卡。',
    'start：用户现在就想开始跑团/开团/玩 CoC/TRPG。',
    'resume：用户想继续上次那条线、昨晚那个团、之前的存档。',
    'new：用户明确表示不要续旧档，要新开一条/新开一个团/新开线。',
    'exit：用户要暂停、收团、先不跑了、退出跑团，恢复普通聊天。',
    'roll：用户要车卡、建卡、开人物卡、调查员卡、职业卡，或者要从建卡开始进团。',
    'normal：普通聊天、闲聊、问能力、问配置、问怎么用、问能不能当 KP、调试讨论、功能讨论，都算 normal。',
    '不要要求用户必须说固定关键词，要按真实意图判断。',
    "示例：",
    '- “咱们今晚来一把克系调查吧” => start',
    '- “昨晚那条线继续跑” => resume',
    '- “别接旧档了，直接新开一条” => new',
    '- “先不跑了，回聊天吧” => exit',
    '- “帮我整张记者调查员卡” => roll',
    '- “你会不会跑团” => normal',
    '- “这个功能怎么配置” => normal',
  ].join(" ");

  const input = {
    text,
    hasExistingContext: params.hasExistingContext === true,
    channel: "onebot-group",
    currentMode: "idle",
  };
  return await runJsonRouter({
    cfg: params.cfg,
    agentId: params.agentId,
    onError: params.onError,
    prompt,
    input,
    validate: validateDecision,
    errorLabel: "activation router",
  });
}

export async function classifyOneBotAiKpSessionRoute(params: {
  cfg: ClawdbotConfig;
  text: string;
  agentId?: string | null;
  sessionMode?: string | null;
  pendingResumeChoice?: boolean;
  pendingStoryPackChoice?: boolean;
  hasExistingContext?: boolean;
  onError?: (message: string) => void;
}): Promise<OneBotAiKpSessionRouteDecision | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.activationRouterEnabled) return null;

  const text = params.text.trim();
  if (!text) return null;

  const prompt = [
    "你是 QQ 机器人“麦麦”的 AI-KP 会话路由器，只判断这句自然语言在跑团会话里应该触发什么会话动作。",
    '你必须只返回一个 JSON 对象：{"action":"normal|start|resume|new_line|pause|reply_to_prompt|list_saves|list_story_packs|panel_state|panel_recap|panel_party","confidence":0..1,"reason":"简短中文说明"}。',
    "不要要求用户复述固定口令，要按真实语义判断。",
    "动作含义：",
    "start：明确要开始跑团/开团/进团。",
    "resume：明确要接回旧档、继续昨晚/上次那条线。",
    "new_line：明确不要旧档，要新开一条。",
    "pause：明确要退出跑团、收团、回普通聊天。",
    "reply_to_prompt：用户是在自然回答当前会话里的开放问题，应该把原话交给下游继续处理；尤其适合回答“你想跑哪个剧本/模组”。",
    "list_saves：用户要看旧档/存档列表。",
    "list_story_packs：用户要看剧本/模组列表。",
    "panel_state：用户要看当前状态/现在什么情况。",
    "panel_recap：用户要你回顾、总结一下目前剧情。",
    "panel_party：用户要看队伍、谁在场、当前角色情况。",
    "normal：普通聊天、功能讨论、问配置、问怎么用，不该走 AI-KP 会话动作。",
    "如果 pendingResumeChoice=true，优先在 resume / new_line / list_saves 之间判断；只有用户确实没表态，才选 reply_to_prompt。",
    "如果 pendingStoryPackChoice=true，用户在说想跑哪个剧本、模组名、'就那个第一个' 之类时，优先选 reply_to_prompt；如果是在要列表，再选 list_story_packs。",
    "如果用户只是说 '好'、'行'、'继续' 但没有足够信息，选 reply_to_prompt，不要乱猜。",
    "示例：",
    "- “把昨晚那条接回来” => resume",
    "- “别续旧档，重新开吧” => new_line",
    "- “先让我看看有哪些存档” => list_saves",
    "- “旧教堂那个就行” => reply_to_prompt",
    "- “现在什么情况” => panel_state",
    "- “总结一下刚才发生了什么” => panel_recap",
    "- “现在谁在场” => panel_party",
    "- “你这功能怎么配” => normal",
  ].join(" ");

  return await runJsonRouter({
    cfg: params.cfg,
    agentId: params.agentId,
    onError: params.onError,
    prompt,
    input: {
      text,
      sessionMode: params.sessionMode ?? "idle",
      pendingResumeChoice: params.pendingResumeChoice === true,
      pendingStoryPackChoice: params.pendingStoryPackChoice === true,
      hasExistingContext: params.hasExistingContext === true,
      channel: "onebot-session-tool",
    },
    validate: validateSessionRouteDecision,
    errorLabel: "session router",
  });
}
