import { readFile } from "node:fs/promises";
import path from "node:path";

import { joinPromptBlocks, type ClawdbotConfig } from "clawdbot/plugin-sdk";

const AI_KP_PROMPT_TAG = "onebot_ai_kp_context";
const DEFAULT_SUMMARY_CHUNK_LIMIT = 1;
const DEFAULT_RECENT_CHAT_LIMIT = 6;
const DEFAULT_RECENT_OPERATION_LIMIT = 6;
const MAX_RUNTIME_PROMPT_CHARS = 320;
const MAX_SUMMARY_SECTION_CHARS = 1200;
const MAX_LINE_CHARS = 220;

type AiKpMeta = {
  sessionMode?: string;
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

export type OneBotAiKpConfig = {
  enabled?: boolean;
  storageRoot?: string;
  bypassMentionWhenActive?: boolean;
  summaryChunkLimit?: number;
  recentChatLimit?: number;
  recentOperationLimit?: number;
  includeLogHint?: boolean;
};

export type ResolvedOneBotAiKpConfig = {
  enabled: boolean;
  storageRoot?: string;
  bypassMentionWhenActive: boolean;
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

function resolveDefaultStorageRoot(cfg: ClawdbotConfig): string | undefined {
  const workspace = cfg.agents?.defaults?.workspace?.trim();
  if (!workspace) return undefined;
  return path.join(workspace, "clawd-ai-kp", "runtime", "onebot");
}

export function resolveOneBotAiKpConfig(cfg: ClawdbotConfig): ResolvedOneBotAiKpConfig {
  const raw = resolveOneBotAiKpRawConfig(cfg);
  return {
    enabled: raw.enabled !== false,
    storageRoot: raw.storageRoot?.trim() || resolveDefaultStorageRoot(cfg),
    bypassMentionWhenActive: raw.bypassMentionWhenActive !== false,
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

function buildAiKpPromptBlock(params: {
  conversationKey: string;
  contextFile: string;
  config: ResolvedOneBotAiKpConfig;
  context?: AiKpContextPacket | null;
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

  const lines = [
    `AI-KP mode is active for this OneBot conversation. Continue the TRPG session instead of acting like a generic assistant.`,
  ];

  const runtimePrompt = compactRuntimePrompt(context?.runtimePrompt);
  if (runtimePrompt) {
    lines.push(`Runtime guidance: ${runtimePrompt}`);
  }

  lines.push(`Conversation key: ${params.conversationKey}`);

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

  return `<${AI_KP_PROMPT_TAG}>\n${lines.join("\n").trim()}\n</${AI_KP_PROMPT_TAG}>`;
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
    }),
  };
}

export function mergeOneBotGroupSystemPrompt(parts: Array<string | null | undefined>): string | undefined {
  const merged = joinPromptBlocks(parts);
  return merged || undefined;
}
