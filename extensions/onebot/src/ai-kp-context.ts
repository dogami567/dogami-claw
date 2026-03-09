import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { joinPromptBlocks, type ClawdbotConfig } from "clawdbot/plugin-sdk";
import { ONEBOT_AIKP_PROMPT_TAG, ONEBOT_AIKP_TOOL_NAMES } from "./ai-kp-shared.js";

const DEFAULT_SUMMARY_CHUNK_LIMIT = 1;
const DEFAULT_RECENT_CHAT_LIMIT = 6;
const DEFAULT_RECENT_OPERATION_LIMIT = 6;
const MAX_RUNTIME_PROMPT_CHARS = 320;
const MAX_SUMMARY_SECTION_CHARS = 1200;
const MAX_LINE_CHARS = 220;

type AiKpMeta = {
  sessionMode?: string;
  pendingResumeChoice?: Record<string, unknown> | null;
  pendingStoryPackChoice?: Record<string, unknown> | null;
  storyPackId?: string | null;
};

type AiKpSummaryChunk = {
  fileName?: string;
  text?: string;
};

type AiKpInvestigator = {
  name?: string;
  occupation?: string;
};

type AiKpContextPacket = {
  sessionMode?: string;
  runtimeProfileId?: string;
  runtimePrompt?: string;
  state?: {
    scene?: {
      summary?: string;
      location?: string;
    };
    turnState?: {
      currentActorName?: string;
      round?: number;
    };
    revealedClues?: string[];
    investigators?: AiKpInvestigator[];
  };
  summaryChunks?: AiKpSummaryChunk[];
  recentChatLines?: string[];
  recentOperationLines?: string[];
  recentChat?: Array<Record<string, unknown>>;
  recentOperations?: Array<Record<string, unknown>>;
};

export type OneBotAiKpContextPacket = AiKpContextPacket;

export type OneBotAiKpConfig = {
  enabled?: boolean;
  storageRoot?: string;
  runtimeModulePath?: string;
  delegateToRuntime?: boolean;
  semanticToolsEnabled?: boolean;
  allowDirectMessages?: boolean;
  allowNaturalActivation?: boolean;
  bypassMentionWhenActive?: boolean;
  activationRouterEnabled?: boolean;
  activationRouterProvider?: string;
  activationRouterModel?: string;
  activationRouterAuthProfileId?: string;
  activationRouterMaxTokens?: number;
  activationRouterTimeoutMs?: number;
  summaryChunkLimit?: number;
  recentChatLimit?: number;
  recentOperationLimit?: number;
  includeLogHint?: boolean;
};

export type ResolvedOneBotAiKpConfig = {
  enabled: boolean;
  storageRoot?: string;
  runtimeModulePath?: string;
  delegateToRuntime: boolean;
  semanticToolsEnabled: boolean;
  allowDirectMessages: boolean;
  allowNaturalActivation: boolean;
  bypassMentionWhenActive: boolean;
  activationRouterEnabled: boolean;
  activationRouterProvider?: string;
  activationRouterModel?: string;
  activationRouterAuthProfileId?: string;
  activationRouterMaxTokens?: number;
  activationRouterTimeoutMs?: number;
  summaryChunkLimit: number;
  recentChatLimit: number;
  recentOperationLimit: number;
  includeLogHint: boolean;
};

export type OneBotAiKpContextState = {
  active: boolean;
  sessionMode: string;
  conversationKey: string;
  promptBlock?: string;
  contextFile: string;
};

type ConversationLayout = {
  conversationKey: string;
  metaFile: string;
  contextFile: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function buildConversationKey(params: {
  groupId?: string | null;
  userId?: string | null;
}): string | null {
  if (params.groupId?.trim()) return `onebot-group-${sanitizeSegment(params.groupId.trim())}`;
  if (params.userId?.trim()) return `onebot-dm-${sanitizeSegment(params.userId.trim())}`;
  return null;
}

function resolveOneBotAiKpRawConfig(cfg: ClawdbotConfig): OneBotAiKpConfig {
  const onebotCfg = (cfg.channels as Record<string, unknown> | undefined)?.onebot;
  if (!isRecord(onebotCfg)) return {};
  const aiKp = onebotCfg.aiKp;
  return isRecord(aiKp) ? (aiKp as OneBotAiKpConfig) : {};
}

function resolveAiKpBaseDirCandidates(cfg: ClawdbotConfig): string[] {
  const candidates: string[] = [];
  const workspace = cfg.agents?.defaults?.workspace?.trim();
  if (workspace) {
    candidates.push(path.join(workspace, "clawd-ai-kp"));
  }
  candidates.push(path.resolve(process.cwd(), ".runtime", "workspace", "clawd-ai-kp"));
  return candidates.filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
}

function resolveDefaultAiKpBaseDir(cfg: ClawdbotConfig): string | undefined {
  const candidates = resolveAiKpBaseDirCandidates(cfg);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveDefaultStorageRoot(cfg: ClawdbotConfig): string | undefined {
  const baseDir = resolveDefaultAiKpBaseDir(cfg);
  if (!baseDir) return undefined;
  return path.join(baseDir, "runtime", "onebot");
}

function resolveDefaultRuntimeModulePath(cfg: ClawdbotConfig): string | undefined {
  const baseDir = resolveDefaultAiKpBaseDir(cfg);
  if (!baseDir) return undefined;
  const modulePath = path.join(baseDir, "adapter", "onebot", "runtime.js");
  return existsSync(modulePath) ? modulePath : undefined;
}

export function resolveOneBotAiKpBaseDir(cfg: ClawdbotConfig): string | undefined {
  const raw = resolveOneBotAiKpRawConfig(cfg);
  if (raw.storageRoot?.trim()) {
    const fromStorageRoot = path.resolve(raw.storageRoot.trim(), "..", "..");
    if (existsSync(path.join(fromStorageRoot, "adapter", "onebot", "single-session.js"))) {
      return fromStorageRoot;
    }
  }
  if (raw.runtimeModulePath?.trim()) {
    const fromRuntimeModule = path.resolve(raw.runtimeModulePath.trim(), "..", "..", "..");
    if (existsSync(path.join(fromRuntimeModule, "adapter", "onebot", "single-session.js"))) {
      return fromRuntimeModule;
    }
  }
  return resolveDefaultAiKpBaseDir(cfg);
}

export function resolveOneBotAiKpConfig(cfg: ClawdbotConfig): ResolvedOneBotAiKpConfig {
  const raw = resolveOneBotAiKpRawConfig(cfg);
  return {
    enabled: raw.enabled !== false,
    storageRoot: raw.storageRoot?.trim() || resolveDefaultStorageRoot(cfg),
    runtimeModulePath: raw.runtimeModulePath?.trim() || resolveDefaultRuntimeModulePath(cfg),
    delegateToRuntime: raw.delegateToRuntime !== false,
    semanticToolsEnabled: raw.semanticToolsEnabled !== false,
    allowDirectMessages: raw.allowDirectMessages === true,
    allowNaturalActivation: raw.allowNaturalActivation !== false,
    bypassMentionWhenActive: raw.bypassMentionWhenActive === true,
    activationRouterEnabled: raw.activationRouterEnabled !== false,
    activationRouterProvider: raw.activationRouterProvider?.trim() || undefined,
    activationRouterModel: raw.activationRouterModel?.trim() || undefined,
    activationRouterAuthProfileId: raw.activationRouterAuthProfileId?.trim() || undefined,
    activationRouterMaxTokens:
      typeof raw.activationRouterMaxTokens === "number" && raw.activationRouterMaxTokens > 0
        ? raw.activationRouterMaxTokens
        : undefined,
    activationRouterTimeoutMs:
      typeof raw.activationRouterTimeoutMs === "number" && raw.activationRouterTimeoutMs > 0
        ? raw.activationRouterTimeoutMs
        : undefined,
    summaryChunkLimit: Math.max(1, Math.min(3, raw.summaryChunkLimit ?? DEFAULT_SUMMARY_CHUNK_LIMIT)),
    recentChatLimit: Math.max(1, Math.min(8, raw.recentChatLimit ?? DEFAULT_RECENT_CHAT_LIMIT)),
    recentOperationLimit: Math.max(
      1,
      Math.min(8, raw.recentOperationLimit ?? DEFAULT_RECENT_OPERATION_LIMIT),
    ),
    includeLogHint: raw.includeLogHint !== false,
  };
}

function buildConversationLayout(storageRoot: string, conversationKey: string): ConversationLayout {
  const logsConversationDir = path.join(storageRoot, "logs", conversationKey);
  return {
    conversationKey,
    metaFile: path.join(storageRoot, "meta", `${conversationKey}.json`),
    contextFile: path.join(logsConversationDir, "context", "latest.json"),
  };
}

async function readJsonFile<T>(
  filePath: string,
  onError?: (message: string) => void,
): Promise<T | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    onError?.(`onebot ai-kp: failed reading ${filePath}: ${String(error)}`);
    return null;
  }
}

function clipText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeLine(value: unknown): string | null {
  const text =
    typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "bigint"
        ? String(value)
        : "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  return clipText(normalized, MAX_LINE_CHARS);
}

function compactRuntimePrompt(runtimePrompt: string | undefined): string | null {
  const lines = String(runtimePrompt ?? "")
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;
  return clipText(lines.slice(0, 4).join(" "), MAX_RUNTIME_PROMPT_CHARS);
}

function formatInvestigators(investigators: AiKpInvestigator[] | undefined): string | null {
  const entries = Array.isArray(investigators) ? investigators : [];
  const labels = entries
    .map((investigator) => {
      const name = normalizeLine(investigator?.name);
      if (!name) return null;
      const occupation = normalizeLine(investigator?.occupation);
      return occupation ? `${name}(${occupation})` : name;
    })
    .filter((entry): entry is string => Boolean(entry));
  if (labels.length === 0) return null;
  return clipText(labels.slice(0, 6).join("、"), MAX_LINE_CHARS);
}

function compactSummaryChunk(text: string | undefined): string | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter(
      (line) =>
        !line.startsWith("# AI-KP Summary") &&
        !/^- (会话|生成时间|汇总消息数|参与者)：/.test(line),
    );
  if (lines.length === 0) return null;
  return clipText(lines.join("\n"), MAX_SUMMARY_SECTION_CHARS);
}

function dedupeLines(lines: Array<string | null>, limit: number): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const normalized = normalizeLine(line);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
    if (deduped.length >= limit) break;
  }
  return deduped;
}

function buildFallbackChatLines(context: AiKpContextPacket, limit: number): string[] {
  const events = Array.isArray(context.recentChat) ? context.recentChat : [];
  return dedupeLines(
    events.map((event) => {
      if (!isRecord(event)) return null;
      const message = normalizeLine(event.message);
      if (!message) return null;
      const speaker =
        event.direction === "outbound"
          ? "KP"
          : normalizeLine(event.senderName) ??
            normalizeLine(event.userName) ??
            normalizeLine(event.userId) ??
            "玩家";
      return `- ${speaker}：${message}`;
    }),
    limit,
  );
}

function buildFallbackOperationLines(context: AiKpContextPacket, limit: number): string[] {
  const events = Array.isArray(context.recentOperations) ? context.recentOperations : [];
  return dedupeLines(
    events.map((event) => {
      if (!isRecord(event)) return null;
      return normalizeLine(event.summary) ?? normalizeLine(event.kind);
    }),
    limit,
  );
}

function buildActiveToolGuideLines(): string[] {
  return [
    `[Available Tools]`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.dispatch}: preferred front door for almost any direct player message. Give it the raw message first so it can route semantically into session/roll/scene handling without forcing rigid commands.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.session}: narrower session-control tool for start/resume/pause, save/story-pack choices, panels, spotlight and turn order. For freeform answers such as “接昨晚那条” or “别续旧档了”，prefer action=semantic_reply if you are already deliberately using the session tool.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.roll}: narrower sheet/chargen tool. For natural replies such as “记者吧”“给我快速医生卡”“大家一起车吧”，prefer action=semantic_reply if you are already deliberately using the roll tool.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.sceneTurn}: narrower in-world action tool. It can infer scene semantics from originalText alone, but structured fields such as actionKind/skillKey/targetNpc/targetClue/targetArea remain the most precise path.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.history}: pull older summaries/chat/operations if compaction hid earlier context.`,
  ];
}

function buildSessionMetaLines(meta?: AiKpMeta | null): string[] {
  const lines: string[] = [];
  const sessionMode = normalizeLine(meta?.sessionMode);
  if (sessionMode) lines.push(`Session mode: ${sessionMode}`);
  if (meta?.pendingResumeChoice) {
    lines.push("Pending choice: resume current save or start a new line.");
  }
  if (meta?.pendingStoryPackChoice) {
    lines.push("Pending choice: select the story pack before scene play continues.");
  }
  const storyPackId = normalizeLine(meta?.storyPackId);
  if (storyPackId) lines.push(`Selected story pack: ${storyPackId}`);
  return lines;
}

function buildIdleToolGuideLines(): string[] {
  return [
    `[Available Tools]`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.dispatch}: preferred front door for direct player messages. Use it first when the user might be starting a run, picking a story pack, building a card, asking for state, or taking an in-world action.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.session}: narrower session-control tool. Use action=semantic_reply when the player answered naturally and you should map it to resume/new-line/panel/list behavior.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.roll}: narrower sheet tool. Use action=semantic_reply when the player naturally answers a chargen prompt, only names an occupation, or asks for quick/traditional/party chargen without fixed wording.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.sceneTurn}: use only after the conversation is actually in an active TRPG scene, or when dispatch already routed here.`,
    `- ${ONEBOT_AIKP_TOOL_NAMES.history}: read older AI-KP logs if you need compacted context.`,
  ];
}

function buildAiKpPromptBlock(params: {
  conversationKey: string;
  contextFile: string;
  config: ResolvedOneBotAiKpConfig;
  context?: AiKpContextPacket | null;
  meta?: AiKpMeta | null;
}): string {
  const context = params.context ?? null;
  const state = context?.state;
  const summaryText = (context?.summaryChunks ?? [])
    .slice(-params.config.summaryChunkLimit)
    .map((chunk) => compactSummaryChunk(chunk?.text))
    .filter((entry): entry is string => Boolean(entry))
    .join("\n\n");
  const recentOperations = dedupeLines(
    (context?.recentOperationLines ?? []).map((line) => normalizeLine(line)),
    params.config.recentOperationLimit,
  );
  const recentChat = dedupeLines(
    (context?.recentChatLines ?? []).map((line) => normalizeLine(line)),
    params.config.recentChatLimit,
  );
  const operationLines =
    recentOperations.length > 0
      ? recentOperations
      : buildFallbackOperationLines(context ?? {}, params.config.recentOperationLimit);
  const chatLines =
    recentChat.length > 0 ? recentChat : buildFallbackChatLines(context ?? {}, params.config.recentChatLimit);

  const lines = [`[Persona]`, `AI-KP mode is active for this OneBot conversation.`];

  const runtimePrompt = compactRuntimePrompt(context?.runtimePrompt);
  if (runtimePrompt) {
    lines.push(runtimePrompt);
  } else {
    lines.push(
      `You are 麦麦, the AI KP for this TRPG table. Stay cute, colloquial, and in-character instead of sounding like a generic assistant.`,
    );
  }

  lines.push(
    `Keep the current run going naturally. Prefer taking semantic action with AI-KP tools over asking players to memorize rigid commands.`,
    `When the player's intent is clear, do not ask them to repeat literal phrases like “续上” or “新开”; use session tools to route the meaning directly.`,
  );
  lines.push("", "[Player Context]", `Conversation key: ${params.conversationKey}`);
  lines.push(...buildSessionMetaLines(params.meta));

  const scene = normalizeLine(state?.scene?.summary);
  if (scene) lines.push(`Scene: ${scene}`);
  const location = normalizeLine(state?.scene?.location);
  if (location) lines.push(`Location: ${location}`);
  const focus = normalizeLine(state?.turnState?.currentActorName);
  if (focus) lines.push(`Current focus: ${focus}`);
  if (typeof state?.turnState?.round === "number") {
    lines.push(`Round: ${state.turnState.round}`);
  }
  if (Array.isArray(state?.revealedClues) && state.revealedClues.length > 0) {
    const clues = dedupeLines(state.revealedClues, 8).join("、");
    if (clues) lines.push(`Revealed clues: ${clues}`);
  }
  const investigators = formatInvestigators(state?.investigators);
  if (investigators) lines.push(`Party: ${investigators}`);

  if (summaryText) {
    lines.push("", "[Recent Summary]", summaryText);
  }

  if (operationLines.length > 0) {
    lines.push("", "[Recent Operations]", ...operationLines);
  }

  if (chatLines.length > 0) {
    lines.push("", "[Recent Chat]", ...chatLines);
  }

  if (params.config.includeLogHint) {
    lines.push("", `Context file: ${params.contextFile}`);
  }

  lines.push("", ...buildActiveToolGuideLines());
  lines.push(`If the injected summary is insufficient after compaction, call ${ONEBOT_AIKP_TOOL_NAMES.history} before replying.`);

  return `<${ONEBOT_AIKP_PROMPT_TAG}>\n${lines.join("\n").trim()}\n</${ONEBOT_AIKP_PROMPT_TAG}>`;
}

function buildIdleAiKpPromptBlock(params: {
  conversationKey: string;
  contextFile: string;
  config: ResolvedOneBotAiKpConfig;
  meta?: AiKpMeta | null;
}): string {
  const lines = [
    `[Persona]`,
    `You are 麦麦. AI-KP tooling is available for this OneBot conversation, but the TRPG session is currently idle.`,
    `When the user clearly wants to start/resume/pause a run, build a card, or perform an in-world action, switch into AI-KP behavior with tools. Otherwise keep chatting normally.`,
    "",
    "[Player Context]",
    `Conversation key: ${params.conversationKey}`,
  ];
  lines.push(...buildSessionMetaLines(params.meta));
  if (params.config.includeLogHint) {
    lines.push(`Context file: ${params.contextFile}`);
  }
  lines.push(
    `If a tool result says a resume/new-line or story-pack choice is pending, ask that choice plainly and wait for the user's answer.`,
    `For almost any direct player message about AI-KP play, use ${ONEBOT_AIKP_TOOL_NAMES.dispatch} first instead of hand-picking narrower tools.`,
    `When the user answers that pending question in natural language, use ${ONEBOT_AIKP_TOOL_NAMES.session} with action=semantic_reply instead of demanding exact words.`,
    `When a user answers the chargen step naturally, such as only naming an occupation or asking for quickfire in freeform text, use ${ONEBOT_AIKP_TOOL_NAMES.roll} with action=semantic_reply.`,
    `If the user is just discussing features, asking how AI-KP works, or chatting normally, answer without AI-KP tools.`,
    "",
    ...buildIdleToolGuideLines(),
  );
  return `<${ONEBOT_AIKP_PROMPT_TAG}>\n${lines.join("\n").trim()}\n</${ONEBOT_AIKP_PROMPT_TAG}>`;
}

export async function loadOneBotAiKpContextPacket(params: {
  cfg: ClawdbotConfig;
  groupId?: string | null;
  userId?: string | null;
  onError?: (message: string) => void;
}): Promise<{
  conversationKey: string;
  contextFile: string;
  metaFile: string;
  packet: AiKpContextPacket | null;
} | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.enabled || !config.storageRoot) return null;
  const conversationKey = buildConversationKey({
    groupId: params.groupId,
    userId: params.userId,
  });
  if (!conversationKey) return null;
  const layout = buildConversationLayout(config.storageRoot, conversationKey);
  return {
    conversationKey,
    contextFile: layout.contextFile,
    metaFile: layout.metaFile,
    packet: await readJsonFile<AiKpContextPacket>(layout.contextFile, params.onError),
  };
}

export async function loadOneBotAiKpContext(params: {
  cfg: ClawdbotConfig;
  groupId?: string | null;
  userId?: string | null;
  onError?: (message: string) => void;
}): Promise<OneBotAiKpContextState | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.enabled || !config.storageRoot) return null;

  const conversationKey = buildConversationKey({
    groupId: params.groupId,
    userId: params.userId,
  });
  if (!conversationKey) return null;

  const layout = buildConversationLayout(config.storageRoot, conversationKey);
  const meta = await readJsonFile<AiKpMeta>(layout.metaFile, params.onError);
  const context = await readJsonFile<AiKpContextPacket>(layout.contextFile, params.onError);
  const sessionMode = meta?.sessionMode ?? context?.sessionMode ?? "idle";
  const active = sessionMode === "kp";
  if (!active) {
    return {
      active: false,
      sessionMode,
      conversationKey,
      contextFile: layout.contextFile,
      promptBlock: config.semanticToolsEnabled
        ? buildIdleAiKpPromptBlock({
            conversationKey,
            contextFile: layout.contextFile,
            config,
            meta,
          })
        : undefined,
    };
  }

  return {
    active: true,
    sessionMode,
    conversationKey,
    contextFile: layout.contextFile,
    promptBlock: buildAiKpPromptBlock({
      conversationKey,
      contextFile: layout.contextFile,
      config,
      context,
      meta,
    }),
  };
}

export function mergeOneBotGroupSystemPrompt(parts: Array<string | null | undefined>): string | undefined {
  const merged = joinPromptBlocks(parts);
  return merged || undefined;
}
