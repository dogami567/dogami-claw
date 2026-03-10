import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { resolveOneBotAiKpConfig } from "./ai-kp-context.js";
import {
  SCENE_ACTION_KINDS,
  SCENE_ACTION_MODES,
  SCENE_DURATIONS,
  SCENE_RISK_LEVELS,
  type SemanticSceneIntent,
} from "./ai-kp-semantic-scene.js";

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

export type OneBotAiKpRollRouteIntent =
  | "normal"
  | "traditional"
  | "quickfire"
  | "party_traditional"
  | "party_quickfire"
  | "sheet";

export type OneBotAiKpRollRouteDecision = {
  action: OneBotAiKpRollRouteIntent;
  confidence: number;
  reason: string;
  occupationKey?: string;
};

export type OneBotAiKpDispatchRouteIntent = "normal" | "session" | "roll" | "scene";

export type OneBotAiKpDispatchSessionAction =
  | "start"
  | "resume"
  | "new_line"
  | "pause"
  | "reply_to_prompt"
  | "list_saves"
  | "list_story_packs"
  | "select_story_pack"
  | "panel_state"
  | "panel_recap"
  | "panel_party";

export type OneBotAiKpDispatchDecision = {
  route: OneBotAiKpDispatchRouteIntent;
  confidence: number;
  reason: string;
  sessionAction?: OneBotAiKpDispatchSessionAction;
  storyPackId?: string;
  rollAction?: Exclude<OneBotAiKpRollRouteIntent, "normal">;
  occupationKey?: string;
  sceneIntent?: SemanticSceneIntent;
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

const VALID_ROLL_ROUTE_ACTIONS = new Set<OneBotAiKpRollRouteIntent>([
  "normal",
  "traditional",
  "quickfire",
  "party_traditional",
  "party_quickfire",
  "sheet",
]);

const VALID_DISPATCH_ROUTE_ACTIONS = new Set<OneBotAiKpDispatchRouteIntent>([
  "normal",
  "session",
  "roll",
  "scene",
]);

const VALID_DISPATCH_SESSION_ACTIONS = new Set<OneBotAiKpDispatchSessionAction>([
  "start",
  "resume",
  "new_line",
  "pause",
  "reply_to_prompt",
  "list_saves",
  "list_story_packs",
  "select_story_pack",
  "panel_state",
  "panel_recap",
  "panel_party",
]);

const VALID_DISPATCH_ROLL_ACTIONS = new Set<Exclude<OneBotAiKpRollRouteIntent, "normal">>([
  "traditional",
  "quickfire",
  "party_traditional",
  "party_quickfire",
  "sheet",
]);

const VALID_SCENE_ACTION_KINDS = new Set<string>(SCENE_ACTION_KINDS);
const VALID_SCENE_RISK_LEVELS = new Set<string>(SCENE_RISK_LEVELS);
const VALID_SCENE_ACTION_MODES = new Set<string>(SCENE_ACTION_MODES);
const VALID_SCENE_DURATIONS = new Set<string>(SCENE_DURATIONS);

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

function validateRollRouteDecision(raw: unknown): OneBotAiKpRollRouteDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const action = String((raw as { action?: unknown }).action ?? "").trim() as OneBotAiKpRollRouteIntent;
  if (!VALID_ROLL_ROUTE_ACTIONS.has(action)) return null;
  const occupationKey = String((raw as { occupationKey?: unknown }).occupationKey ?? "").trim() || undefined;
  return {
    action,
    confidence: clampConfidence((raw as { confidence?: unknown }).confidence),
    reason: String((raw as { reason?: unknown }).reason ?? "").trim(),
    occupationKey,
  };
}

function cleanOptionalString(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function cleanOptionalStringArray(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const values = raw
    .map((entry) => cleanOptionalString(entry))
    .filter((entry): entry is string => Boolean(entry));
  return values.length > 0 ? values : undefined;
}

function clampInteger(raw: unknown, min: number, max: number): number | undefined {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function validateDispatchSceneIntent(raw: unknown): SemanticSceneIntent | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const actionKind = cleanOptionalString((raw as { actionKind?: unknown }).actionKind);
  if (!actionKind || !VALID_SCENE_ACTION_KINDS.has(actionKind)) return undefined;
  const riskLevel = cleanOptionalString((raw as { riskLevel?: unknown }).riskLevel);
  const mode = cleanOptionalString((raw as { mode?: unknown }).mode);
  const duration = cleanOptionalString((raw as { duration?: unknown }).duration);
  return {
    actionKind: actionKind as SemanticSceneIntent["actionKind"],
    intentSummary: cleanOptionalString((raw as { intentSummary?: unknown }).intentSummary),
    normalizedAction: cleanOptionalString((raw as { normalizedAction?: unknown }).normalizedAction),
    skillKey: cleanOptionalString((raw as { skillKey?: unknown }).skillKey),
    targetNpc: cleanOptionalString((raw as { targetNpc?: unknown }).targetNpc),
    targetClue: cleanOptionalString((raw as { targetClue?: unknown }).targetClue),
    targetArea: cleanOptionalString((raw as { targetArea?: unknown }).targetArea),
    itemName: cleanOptionalString((raw as { itemName?: unknown }).itemName),
    riskLevel:
      riskLevel && VALID_SCENE_RISK_LEVELS.has(riskLevel)
        ? (riskLevel as SemanticSceneIntent["riskLevel"])
        : undefined,
    impactScore: clampInteger((raw as { impactScore?: unknown }).impactScore, 0, 5),
    leverageScore: clampInteger((raw as { leverageScore?: unknown }).leverageScore, 0, 5),
    narrativeBonus: clampInteger((raw as { narrativeBonus?: unknown }).narrativeBonus, 0, 5),
    mode:
      mode && VALID_SCENE_ACTION_MODES.has(mode)
        ? (mode as SemanticSceneIntent["mode"])
        : undefined,
    duration:
      duration && VALID_SCENE_DURATIONS.has(duration)
        ? (duration as SemanticSceneIntent["duration"])
        : undefined,
    revealClueId: cleanOptionalString((raw as { revealClueId?: unknown }).revealClueId),
    clueTitle: cleanOptionalString((raw as { clueTitle?: unknown }).clueTitle),
    clueKind: cleanOptionalString((raw as { clueKind?: unknown }).clueKind),
    clueQuality: cleanOptionalString((raw as { clueQuality?: unknown }).clueQuality),
    failureEventLabel: cleanOptionalString((raw as { failureEventLabel?: unknown }).failureEventLabel),
    onSuccessPrompt: cleanOptionalString((raw as { onSuccessPrompt?: unknown }).onSuccessPrompt),
    onFailPrompt: cleanOptionalString((raw as { onFailPrompt?: unknown }).onFailPrompt),
    routineHints: cleanOptionalStringArray((raw as { routineHints?: unknown }).routineHints),
    environmentTags: cleanOptionalStringArray((raw as { environmentTags?: unknown }).environmentTags),
  };
}

function validateDispatchDecision(
  raw: unknown,
  options?: { storyPackIds?: Set<string> },
): OneBotAiKpDispatchDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const route = cleanOptionalString((raw as { route?: unknown }).route) as OneBotAiKpDispatchRouteIntent | undefined;
  if (!route || !VALID_DISPATCH_ROUTE_ACTIONS.has(route)) return null;

  const base = {
    route,
    confidence: clampConfidence((raw as { confidence?: unknown }).confidence),
    reason: String((raw as { reason?: unknown }).reason ?? "").trim(),
  };

  if (route === "normal") {
    return base;
  }

  if (route === "session") {
    const sessionAction = cleanOptionalString((raw as { sessionAction?: unknown }).sessionAction) as
      | OneBotAiKpDispatchSessionAction
      | undefined;
    if (!sessionAction || !VALID_DISPATCH_SESSION_ACTIONS.has(sessionAction)) return null;
    const storyPackId = cleanOptionalString((raw as { storyPackId?: unknown }).storyPackId);
    if (sessionAction === "select_story_pack" && !storyPackId) return null;
    if (storyPackId && options?.storyPackIds && !options.storyPackIds.has(storyPackId)) {
      return null;
    }
    return {
      ...base,
      sessionAction,
      storyPackId,
    };
  }

  if (route === "roll") {
    const rollAction = cleanOptionalString((raw as { rollAction?: unknown }).rollAction) as
      | Exclude<OneBotAiKpRollRouteIntent, "normal">
      | undefined;
    if (!rollAction || !VALID_DISPATCH_ROLL_ACTIONS.has(rollAction)) return null;
    return {
      ...base,
      rollAction,
      occupationKey: cleanOptionalString((raw as { occupationKey?: unknown }).occupationKey),
    };
  }

  const sceneIntent = validateDispatchSceneIntent((raw as { sceneIntent?: unknown }).sceneIntent);
  if (!sceneIntent?.actionKind) return null;
  return {
    ...base,
    sceneIntent,
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
  partyMode?: string | null;
  partyLocked?: boolean;
  partyMemberCount?: number;
  pendingSessionBriefing?: boolean;
  pendingResumeChoice?: boolean;
  pendingDeleteChoice?: boolean;
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
    "群里像“算我一个”“我先旁观”“就这些人”“解锁队伍”这类 roster 管理语句，也属于 session；优先 reply_to_prompt，不要判 normal。",
    "如果 pendingSessionBriefing=true，像“好”“继续”“开始建卡”这种泛确认优先选 reply_to_prompt；如果只是想重看这段说明，也还是 reply_to_prompt。",
    "如果 pendingResumeChoice=true，优先在 resume / new_line / list_saves 之间判断；只有用户确实没表态，才选 reply_to_prompt。",
    "如果 pendingDeleteChoice=true，说明上一句在等删档确认；此时像“确认删除”“删掉吧”“算了别删”“先看看列表”都优先在 reply_to_prompt / list_saves 之间判断。",
    "如果 pendingStoryPackChoice=true，用户在说想跑哪个剧本、模组名、'就那个第一个' 之类时，优先选 reply_to_prompt；如果是在要列表，再选 list_story_packs。",
    "如果用户只是说 '好'、'行'、'继续' 但没有足够信息，选 reply_to_prompt，不要乱猜。",
    "示例：",
    "- “把昨晚那条接回来” => resume",
    "- “别续旧档，重新开吧” => new_line",
    "- “先让我看看有哪些存档” => list_saves",
    "- “旧教堂那个就行” => reply_to_prompt",
    "- “算我一个” => reply_to_prompt",
    "- “就这些人，开吧” => reply_to_prompt",
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
      partyMode: params.partyMode ?? "solo",
      partyLocked: params.partyLocked === true,
      partyMemberCount: typeof params.partyMemberCount === "number" ? params.partyMemberCount : 0,
      pendingSessionBriefing: params.pendingSessionBriefing === true,
      pendingResumeChoice: params.pendingResumeChoice === true,
      pendingDeleteChoice: params.pendingDeleteChoice === true,
      pendingStoryPackChoice: params.pendingStoryPackChoice === true,
      hasExistingContext: params.hasExistingContext === true,
      channel: "onebot-session-tool",
    },
    validate: validateSessionRouteDecision,
    errorLabel: "session router",
  });
}

export async function classifyOneBotAiKpRollRoute(params: {
  cfg: ClawdbotConfig;
  text: string;
  occupationOptions: Array<{ key: string; name?: string | null }>;
  agentId?: string | null;
  sessionMode?: string | null;
  partyMode?: string | null;
  partyLocked?: boolean;
  partyMemberCount?: number;
  pendingSessionBriefing?: boolean;
  hasCurrentInvestigator?: boolean;
  pendingInvestigatorDraftStage?: string | null;
  pendingInvestigatorDraftOccupationKey?: string | null;
  knownPlayerCount?: number;
  onError?: (message: string) => void;
}): Promise<OneBotAiKpRollRouteDecision | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.activationRouterEnabled) return null;

  const text = params.text.trim();
  if (!text) return null;

  const occupationList = params.occupationOptions
    .map((entry) => `${entry.key}${entry.name ? `(${entry.name})` : ""}`)
    .join(", ");

  const prompt = [
    "你是 QQ 机器人“麦麦”的 AI-KP 建卡路由器，只判断这句自然语言在调查员建卡/查看卡片环节应该触发什么动作。",
    '你必须只返回一个 JSON 对象：{"action":"normal|traditional|quickfire|party_traditional|party_quickfire|sheet","confidence":0..1,"reason":"简短中文说明","occupationKey":"可选职业key"}。',
    "不要要求用户复述固定命令，要按真实语义判断。",
    "动作含义：",
    "traditional：普通单人传统车卡。",
    "quickfire：普通单人快速车卡。",
    "party_traditional：多人一起传统车卡。",
    "party_quickfire：多人一起快速车卡。",
    "sheet：用户想查看自己当前的人物卡/调查员卡。",
    "normal：这句不是建卡/看卡动作。",
    "如果 pendingSessionBriefing=true，但用户已经明确给了职业、快速车卡或建卡要求，也还是判成建卡回复；只有泛确认才不归这里。",
    "如果 pendingInvestigatorDraftStage=occupation，说明属性已经掷完，当前更像是在等职业；此时像“记者吧”“医生”“算了给我快速医生卡”都还是建卡回复。",
    "如果 pendingInvestigatorDraftStage=skills，说明职业已经定了，当前更像是在等信用评级/技能偏好；此时像“信用20，侦查图书馆心理学”“自动分配”都应该判成 traditional，而不是 normal。",
    "如果 pendingInvestigatorDraftStage=profile，用户在补名字/年龄/外观/动机；这也属于 traditional 的自然回复。",
    "如果 pendingInvestigatorDraftStage=gear，用户在补携带物或说默认继续；这也属于 traditional 的自然回复。",
    "如果 pendingInvestigatorDraftStage=lock，用户在说“锁卡”“开场”“改资料”“改装备”；这也属于 traditional 的自然回复。",
    "如果用户只是回答一个职业，例如“记者吧”“医生”，默认判成 traditional，并给出对应 occupationKey。",
    "如果用户提到“快速”“快车卡”，优先 quickfire / party_quickfire。",
    "如果用户提到“大家一起”“全员”“一次全车”，优先 party_traditional / party_quickfire。",
    "如果是在群里补 roster、锁名单、退团，而不是实际建卡，不要判到这里。",
    "party_traditional / party_quickfire 只在明确是当前名单多人一起建卡时再选；单人默认还是 traditional / quickfire。",
    "如果用户是在要看当前角色卡、调查员卡、人物卡，选 sheet。",
    "occupationKey 必须尽量从允许列表里选；如果没有明确职业，可以留空。",
    `允许职业：${occupationList}`,
    "示例：",
    '- “记者吧” => traditional + journalist',
    '- “给我快速医生卡” => quickfire + doctor',
    '- “大家一起快速车卡，职业侦探” => party_quickfire + detective',
    '- “我看看我现在的人物卡” => sheet',
    '- “你这套建卡怎么做的” => normal',
  ].join(" ");

  return await runJsonRouter({
    cfg: params.cfg,
    agentId: params.agentId,
    onError: params.onError,
    prompt,
    input: {
      text,
      sessionMode: params.sessionMode ?? "idle",
      partyMode: params.partyMode ?? "solo",
      partyLocked: params.partyLocked === true,
      partyMemberCount: typeof params.partyMemberCount === "number" ? params.partyMemberCount : 0,
      pendingSessionBriefing: params.pendingSessionBriefing === true,
      hasCurrentInvestigator: params.hasCurrentInvestigator === true,
      pendingInvestigatorDraftStage: params.pendingInvestigatorDraftStage ?? null,
      pendingInvestigatorDraftOccupationKey: params.pendingInvestigatorDraftOccupationKey ?? null,
      knownPlayerCount: typeof params.knownPlayerCount === "number" ? params.knownPlayerCount : 1,
      occupationOptions: params.occupationOptions,
      channel: "onebot-roll-tool",
    },
    validate: (raw) => {
      const parsed = validateRollRouteDecision(raw);
      if (!parsed) return null;
      if (parsed.occupationKey) {
        const allowed = new Set(params.occupationOptions.map((entry) => entry.key));
        if (!allowed.has(parsed.occupationKey)) {
          return {
            ...parsed,
            occupationKey: undefined,
          };
        }
      }
      return parsed;
    },
    errorLabel: "roll router",
  });
}

export async function classifyOneBotAiKpDispatchRoute(params: {
  cfg: ClawdbotConfig;
  text: string;
  storyPackOptions: Array<{
    id: string;
    title?: string | null;
    campaignId?: string | null;
    campaignTitle?: string | null;
  }>;
  occupationOptions: Array<{ key: string; name?: string | null }>;
  agentId?: string | null;
  sessionMode?: string | null;
  partyMode?: string | null;
  partyLocked?: boolean;
  partyMemberCount?: number;
  hasSelectedStoryPack?: boolean;
  selectedStoryPackId?: string | null;
  pendingSessionBriefing?: boolean;
  pendingResumeChoice?: boolean;
  pendingDeleteChoice?: boolean;
  pendingStoryPackChoice?: boolean;
  pendingInvestigatorDraftStage?: string | null;
  pendingInvestigatorDraftOccupationKey?: string | null;
  pendingSceneChoice?: boolean;
  pendingSceneChoiceKind?: string | null;
  pendingSceneChoiceTargetNpc?: string | null;
  pendingSceneChoiceOptions?: string[];
  hasCurrentInvestigator?: boolean;
  currentInvestigatorName?: string | null;
  currentInvestigatorOccupation?: string | null;
  sceneSummary?: string | null;
  sceneLocation?: string | null;
  currentFocus?: string | null;
  revealedClues?: string[];
  npcNames?: string[];
  areaNames?: string[];
  knownPlayerCount?: number;
  onError?: (message: string) => void;
}): Promise<OneBotAiKpDispatchDecision | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.activationRouterEnabled) return null;

  const text = params.text.trim();
  if (!text) return null;

  const storyPackList = params.storyPackOptions
    .map((entry) =>
      [entry.id, entry.title ? `title:${entry.title}` : null, entry.campaignTitle ? `campaign:${entry.campaignTitle}` : null]
        .filter(Boolean)
        .join(" | "),
    )
    .join("; ");
  const occupationList = params.occupationOptions
    .map((entry) => `${entry.key}${entry.name ? `(${entry.name})` : ""}`)
    .join(", ");

  const prompt = [
    "你是 QQ 机器人“麦麦”的 AI-KP 总路由器，只判断这句自然语言在当前跑团上下文里应该走哪条工具链，并直接给出该工具需要的关键参数。",
    '你必须只返回一个 JSON 对象。格式只能是：',
    '{"route":"normal|session|roll|scene","confidence":0..1,"reason":"简短中文说明","sessionAction":"可选","storyPackId":"可选","rollAction":"可选","occupationKey":"可选","sceneIntent":{"actionKind":"...","intentSummary":"...","skillKey":"可选","targetNpc":"可选","targetClue":"可选","targetArea":"可选","itemName":"可选","riskLevel":"可选","mode":"可选","duration":"可选","revealClueId":"可选","clueTitle":"可选","failureEventLabel":"可选","onSuccessPrompt":"可选","onFailPrompt":"可选","routineHints":["可选"],"environmentTags":["可选"]}}',
    "route 含义：",
    "normal：普通聊天、功能讨论、问配置、闲聊，不该走 AI-KP 工具。",
    "session：开始/续档/新开/暂停/选剧本/看状态面板/回顾/队伍等会话控制。",
    "roll：建卡、快速车卡、批量车卡、看人物卡。",
    "scene：正式跑团中的场内动作，要给出 sceneIntent.actionKind 和尽量完整的语义字段。",
    "严格规则：",
    "如果 pendingSessionBriefing=true，像“好”“继续”“开始建卡”这种泛确认优先 route=session + sessionAction=reply_to_prompt；如果用户已经明确给职业、说快速车卡、要看人物卡，还是 route=roll。",
    "如果 pendingResumeChoice=true、pendingDeleteChoice=true 或 pendingStoryPackChoice=true，优先 route=session。",
    "如果没有选剧本而用户在回答想跑哪个模组/剧本，优先 route=session，并尽量直接给 sessionAction=select_story_pack + storyPackId；只有实在无法映射时才用 reply_to_prompt。",
    "如果 pendingInvestigatorDraftStage 有值，优先 route=roll。occupation 阶段在等职业；skills 阶段在等信用评级/技能偏好/自动分配；profile/gear/lock 阶段也都还是建卡回复。",
    "如果 pendingSceneChoice=true，说明上一句还在等玩家拍板场内选择；可能是在选心理学/说服/恐吓之类的走法，也可能是在选接受/推骰/花幸运。此时相关回复都优先 route=scene。",
    "如果用户是在建卡、回答职业、要看人物卡，route=roll。",
    "群里 roster 管理语句，例如“算我一个”“我先旁观”“就这些人”“解锁队伍”，优先 route=session + sessionAction=reply_to_prompt。",
    "只有当 sessionMode=kp 且已经有当前调查员，用户明确是在场内行动、调查、交涉、潜行、跟踪、使用道具时，才 route=scene。",
    "如果用户是在问“现在什么情况”“总结一下”“谁在场”，这属于 session 面板，不是 scene。",
    "sceneIntent.actionKind 只能是 explore/talk/use_item/risky_action/steal/follow。",
    "rollAction 只能是 traditional/quickfire/party_traditional/party_quickfire/sheet。",
    "sessionAction 只能是 start/resume/new_line/pause/reply_to_prompt/list_saves/list_story_packs/select_story_pack/panel_state/panel_recap/panel_party。",
    "如果你能把剧本映射到允许列表中的具体 storyPackId，就直接输出 select_story_pack，不要依赖固定口令。",
    `允许 story packs：${storyPackList || "none"}`,
    `允许 occupations：${occupationList || "none"}`,
    "示例：",
    '- “我想跑团” => route=session + sessionAction=start',
    '- “旧教堂那个就行” => route=session + sessionAction=select_story_pack + storyPackId=old-church-arc-pack',
    '- “算我一个” => route=session + sessionAction=reply_to_prompt',
    '- “就这些人，开吧” => route=session + sessionAction=reply_to_prompt',
    '- “记者吧” => route=roll + rollAction=traditional + occupationKey=journalist',
    '- “信用20，侦查图书馆心理学” => route=roll + rollAction=traditional',
    '- “自动分配” => route=roll + rollAction=traditional',
    '- “给我快速医生卡” => route=roll + rollAction=quickfire + occupationKey=doctor',
    '- “我看看我现在的人物卡” => route=roll + rollAction=sheet',
    '- “我借着手电去看祭坛背后的刮痕” => route=scene + sceneIntent.actionKind=explore',
    '- “你这个功能怎么配” => route=normal',
  ].join(" ");

  return await runJsonRouter({
    cfg: params.cfg,
    agentId: params.agentId,
    onError: params.onError,
    prompt,
    input: {
      text,
      sessionMode: params.sessionMode ?? "idle",
      partyMode: params.partyMode ?? "solo",
      partyLocked: params.partyLocked === true,
      partyMemberCount: typeof params.partyMemberCount === "number" ? params.partyMemberCount : 0,
      hasSelectedStoryPack: params.hasSelectedStoryPack === true,
      selectedStoryPackId: params.selectedStoryPackId ?? null,
      pendingSessionBriefing: params.pendingSessionBriefing === true,
      pendingResumeChoice: params.pendingResumeChoice === true,
      pendingDeleteChoice: params.pendingDeleteChoice === true,
      pendingStoryPackChoice: params.pendingStoryPackChoice === true,
      pendingInvestigatorDraftStage: params.pendingInvestigatorDraftStage ?? null,
      pendingInvestigatorDraftOccupationKey: params.pendingInvestigatorDraftOccupationKey ?? null,
      pendingSceneChoice: params.pendingSceneChoice === true,
      pendingSceneChoiceKind: params.pendingSceneChoiceKind ?? null,
      pendingSceneChoiceTargetNpc: params.pendingSceneChoiceTargetNpc ?? null,
      pendingSceneChoiceOptions: params.pendingSceneChoiceOptions ?? [],
      hasCurrentInvestigator: params.hasCurrentInvestigator === true,
      currentInvestigatorName: params.currentInvestigatorName ?? null,
      currentInvestigatorOccupation: params.currentInvestigatorOccupation ?? null,
      sceneSummary: params.sceneSummary ?? null,
      sceneLocation: params.sceneLocation ?? null,
      currentFocus: params.currentFocus ?? null,
      revealedClues: params.revealedClues ?? [],
      npcNames: params.npcNames ?? [],
      areaNames: params.areaNames ?? [],
      knownPlayerCount: typeof params.knownPlayerCount === "number" ? params.knownPlayerCount : 1,
      storyPackOptions: params.storyPackOptions,
      occupationOptions: params.occupationOptions,
      channel: "onebot-dispatch-tool",
    },
    validate: (raw) =>
      validateDispatchDecision(raw, {
        storyPackIds: new Set(params.storyPackOptions.map((entry) => entry.id)),
      }),
    errorLabel: "dispatch router",
  });
}
