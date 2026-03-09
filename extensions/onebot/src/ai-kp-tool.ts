
import { existsSync } from "node:fs";
import { createRequire } from "node:module";

import { Type } from "@sinclair/typebox";
import {
  jsonResult,
  readNumberParam,
  readStringParam,
  stringEnum,
  type ClawdbotConfig,
  type ClawdbotPluginApi,
  type ClawdbotPluginToolContext,
} from "clawdbot/plugin-sdk";

import {
  loadOneBotAiKpContextPacket,
  resolveOneBotAiKpBaseDir,
  resolveOneBotAiKpConfig,
} from "./ai-kp-context.js";
import {
  classifyOneBotAiKpRollRoute,
  classifyOneBotAiKpSessionRoute,
} from "./ai-kp-activation.js";
import {
  SCENE_ACTION_KINDS,
  SCENE_ACTION_MODES,
  SCENE_DURATIONS,
  SCENE_RISK_LEVELS,
  buildSemanticSceneAction,
  type SemanticSceneIntent,
} from "./ai-kp-semantic-scene.js";
import { ONEBOT_AIKP_TOOL_NAMES } from "./ai-kp-shared.js";

const SESSION_ACTIONS = [
  "status",
  "semantic_reply",
  "start",
  "reply_to_prompt",
  "pause",
  "list_saves",
  "list_story_packs",
  "select_story_pack",
  "resume",
  "new_line",
  "panel",
  "focus",
  "next_turn",
] as const;

const PANEL_ACTIONS = [
  "state",
  "scene",
  "party",
  "clues",
  "npcs",
  "campaign",
  "storypack",
  "recap",
  "sheet",
  "who",
] as const;

const ROLL_ACTIONS = [
  "traditional",
  "quickfire",
  "party_traditional",
  "party_quickfire",
  "sheet",
  "semantic_reply",
] as const;

const HISTORY_SECTIONS = ["summary", "chat", "operations", "all"] as const;
const DEFAULT_HISTORY_LIMIT = 12;

type SessionEntryLike = {
  groupId?: string;
  origin?: {
    from?: string;
    to?: string;
  };
  lastTo?: string;
};

type SyntheticOneBotEvent = {
  user_id?: string | number;
  group_id?: string | number;
  message?: string;
  raw_message?: string;
  text?: string;
  message_id?: string;
  message_type?: "group" | "private";
  mentionedSelf?: boolean;
  sender?: {
    card?: string;
    nickname?: string;
  };
};

type AiKpLayout = {
  conversationKey: string;
  sessionFile: string;
  chatLogFile: string;
  ledgerLogFile: string;
  summaryDir: string;
  contextFile: string;
};

type StateBundle = {
  layout: AiKpLayout;
  meta: Record<string, any>;
  sessionState: Record<string, any>;
  created: boolean;
};

type HandleMessageResult = {
  ok: boolean;
  reply?: string | null;
  reason?: string | null;
  contextPacket?: unknown;
};

type SingleSessionModule = {
  buildStorageLayout: (storageRoot: string, event: SyntheticOneBotEvent) => AiKpLayout;
  loadMeta: (layout: AiKpLayout) => Record<string, any> | null;
  saveMeta: (layout: AiKpLayout, meta: Record<string, any>) => void;
  getKpRuntimePrompt: () => string;
  handleOneBotMessage: (
    event: SyntheticOneBotEvent,
    options?: Record<string, unknown>,
  ) => HandleMessageResult;
  ensureConversationSession: (
    event: SyntheticOneBotEvent,
    options?: Record<string, unknown>,
  ) => StateBundle;
  ensureActorForUser: (
    event: SyntheticOneBotEvent,
    stateBundle: StateBundle,
    options?: Record<string, unknown>,
  ) => { actorId?: string | null };
  resolveActorSelection: (
    stateBundle: StateBundle,
    selector?: string,
  ) => { actorId?: string | null } | null;
  setCurrentActor: (stateBundle: StateBundle, actorId: string) => unknown;
  formatStateSummary: (sessionState: Record<string, any>, meta?: Record<string, any>) => string;
  formatPartySummary: (stateBundle: StateBundle) => string;
  formatTurnReply: (result: Record<string, any>, extras?: Record<string, unknown>) => string;
  formatSceneBeat: (sessionState: Record<string, any>) => string;
  formatOptionCue: (sessionState: Record<string, any>) => string | null;
  formatSpotlightCue: (stateBundle: StateBundle) => string | null;
};

type CoreModule = {
  submitAction: (...args: unknown[]) => unknown;
  listOccupationTemplates?: () => Array<{ key?: string; name?: string }>;
  processScenarioTurn: (
    sessionState: Record<string, any>,
    actorId: string,
    text: string,
    submitAction: (...args: unknown[]) => unknown,
    randomInt: (min: number, max: number) => number,
  ) => { ok: boolean; reply?: string; reason?: string; action?: Record<string, any>; result?: Record<string, any> };
  saveSessionApi: (sessionState: Record<string, any>, filePath: string, options?: Record<string, unknown>) => void;
};

type LogStoreModule = {
  appendChatLog: (layout: AiKpLayout, payload: Record<string, unknown>) => void;
  appendOperationLog: (layout: AiKpLayout, payload: Record<string, unknown>) => void;
  appendPlayerOperationLogs: (layout: AiKpLayout, payloads?: Array<Record<string, unknown>>) => void;
  writeStateSnapshot: (layout: AiKpLayout, payload: Record<string, unknown>) => void;
  writeContextSnapshot: (layout: AiKpLayout, payload: Record<string, unknown>) => void;
  buildContextPacket: (
    layout: AiKpLayout,
    meta: Record<string, any>,
    stateSnapshot: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Record<string, unknown>;
  maybeRollupSummaries: (
    layout: AiKpLayout,
    meta: Record<string, any>,
    stateSnapshot: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => { chunkName?: string; pendingChatCount?: number } | null;
  readSummaryChunks: (layout: AiKpLayout, limit?: number) => Array<Record<string, unknown>>;
  safeReadJsonLines: (filePath: string) => Array<Record<string, unknown>>;
};

type LoadedAiKpModules = {
  singleSession: SingleSessionModule;
  core: CoreModule;
  logStore: LogStoreModule;
};

type ConversationRuntimeContext = {
  cfg: ClawdbotConfig;
  aiKpConfig: ReturnType<typeof resolveOneBotAiKpConfig>;
  sessionKey: string;
  groupId?: string;
  userId: string;
  messageType: "group" | "private";
  senderName: string;
};

type LoadSessionStoreFn = (
  storePath: string,
  opts?: { skipCache?: boolean },
) => Record<string, SessionEntryLike>;

type SessionToolAction = (typeof SESSION_ACTIONS)[number];
type PanelAction = (typeof PANEL_ACTIONS)[number];
type RollAction = (typeof ROLL_ACTIONS)[number];
type HistorySection = (typeof HISTORY_SECTIONS)[number];
type RoutedSessionAction = Exclude<SessionToolAction, "status" | "semantic_reply">;
type RoutedRollAction = Exclude<RollAction, "semantic_reply">;

function readStringArrayParam(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key];
  if (!Array.isArray(value)) return undefined;
  const items = value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

const requireForAiKp = createRequire(import.meta.url);

async function loadSessionStoreFn(): Promise<LoadSessionStoreFn> {
  try {
    const mod = await import("../../../src/config/sessions/store.js");
    if (typeof mod.loadSessionStore === "function") return mod.loadSessionStore as LoadSessionStoreFn;
  } catch {
    // ignore source checkout miss
  }

  const mod = await import("../../../config/sessions/store.js");
  if (typeof mod.loadSessionStore !== "function") {
    throw new Error("Internal error: loadSessionStore not available");
  }
  return mod.loadSessionStore as LoadSessionStoreFn;
}

function loadAiKpModules(cfg: ClawdbotConfig): LoadedAiKpModules {
  const baseDir = resolveOneBotAiKpBaseDir(cfg);
  if (!baseDir) {
    throw new Error("AI-KP workspace path could not be resolved");
  }
  return {
    singleSession: requireForAiKp(`${baseDir}/adapter/onebot/single-session.js`) as SingleSessionModule,
    core: requireForAiKp(`${baseDir}/core/src/index.js`) as CoreModule,
    logStore: requireForAiKp(`${baseDir}/adapter/onebot/log-store.js`) as LogStoreModule,
  };
}

function parseOneBotPeer(raw?: string | null): { kind: "user" | "group"; id: string } | null {
  const value = raw?.trim();
  if (!value) return null;
  const match = value.match(/(?:^|:)(user|group):(.+)$/i);
  if (!match) return null;
  return {
    kind: match[1]?.toLowerCase() === "group" ? "group" : "user",
    id: match[2]?.trim() ?? "",
  };
}

async function resolveConversationRuntimeContext(
  api: ClawdbotPluginApi,
  ctx: ClawdbotPluginToolContext,
): Promise<ConversationRuntimeContext> {
  if (ctx.messageChannel !== "onebot") {
    throw new Error("OneBot AI-KP tools are only available in OneBot conversations");
  }
  if (!ctx.sessionKey?.trim()) {
    throw new Error("sessionKey required for OneBot AI-KP tools");
  }

  const cfg = api.config as ClawdbotConfig;
  const aiKpConfig = resolveOneBotAiKpConfig(cfg);
  if (!aiKpConfig.enabled || !aiKpConfig.storageRoot) {
    throw new Error("OneBot AI-KP is not configured");
  }

  const loadSessionStore = await loadSessionStoreFn();
  const storePath = api.runtime.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: ctx.agentId,
  });
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[ctx.sessionKey] as SessionEntryLike | undefined;
  if (!entry) {
    throw new Error(`Session entry not found for ${ctx.sessionKey}`);
  }

  const fromPeer = parseOneBotPeer(entry.origin?.from);
  const toPeer = parseOneBotPeer(entry.origin?.to ?? entry.lastTo);
  const groupId = entry.groupId?.trim() || (toPeer?.kind === "group" ? toPeer.id : undefined);
  const userId = fromPeer?.kind === "user" ? fromPeer.id : undefined;
  if (!userId) {
    throw new Error("Current OneBot sender could not be resolved from session metadata");
  }

  return {
    cfg,
    aiKpConfig,
    sessionKey: ctx.sessionKey,
    groupId,
    userId,
    messageType: groupId ? "group" : "private",
    senderName: `玩家${userId}`,
  };
}

function buildSyntheticEvent(
  runtime: ConversationRuntimeContext,
  params: {
    message: string;
    rawMessage?: string;
    senderName?: string;
  },
): SyntheticOneBotEvent {
  return {
    user_id: runtime.userId,
    group_id: runtime.groupId,
    message: params.message,
    raw_message: params.rawMessage ?? params.message,
    text: params.rawMessage ?? params.message,
    message_id: `tool-${Date.now()}`,
    message_type: runtime.messageType,
    mentionedSelf: true,
    sender: {
      nickname: params.senderName?.trim() || runtime.senderName,
    },
  };
}

function defaultRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildToolRuntimeOptions(config: ReturnType<typeof resolveOneBotAiKpConfig>): Record<string, unknown> {
  return {
    storageRoot: config.storageRoot,
    includeContextPacket: true,
    allowDirectMessages: config.allowDirectMessages,
    allowNaturalActivation: config.allowNaturalActivation,
    contextRecentChatLimit: config.recentChatLimit,
    contextRecentOperationLimit: config.recentOperationLimit,
    contextSummaryChunkLimit: config.summaryChunkLimit,
  };
}

function buildChatLogEntry(event: SyntheticOneBotEvent, direction: "inbound" | "outbound", message: string) {
  return {
    timestamp: new Date().toISOString(),
    direction,
    message,
    messageId: event.message_id || null,
    messageType: event.message_type || (event.group_id ? "group" : "private"),
    userId: event.user_id != null ? String(event.user_id) : null,
    senderName: event.sender?.card || event.sender?.nickname || `玩家${event.user_id || "unknown"}`,
  };
}
function collectNpcStateMap(sessionState: Record<string, any>): Map<string, Record<string, any>> {
  const npcs = Array.isArray(sessionState.scene?.participants?.npcs)
    ? sessionState.scene.participants.npcs
    : [];
  return new Map(npcs.map((npc: Record<string, any>) => [String(npc.id), structuredClone(npc)]));
}

function formatStateDelta(beforeSessionState: Record<string, any>, afterSessionState: Record<string, any>) {
  const lines: string[] = [];
  const beforeTime = Number(beforeSessionState.scene?.timeState?.timelineMinute || 0);
  const afterTime = Number(afterSessionState.scene?.timeState?.timelineMinute || 0);
  const beforeExposure = Number(beforeSessionState.scene?.threats?.exposure || 0);
  const afterExposure = Number(afterSessionState.scene?.threats?.exposure || 0);
  const beforePressure = Number(beforeSessionState.scene?.threats?.pressure || 0);
  const afterPressure = Number(afterSessionState.scene?.threats?.pressure || 0);

  if (afterTime !== beforeTime) lines.push(`时间 +${afterTime - beforeTime}`);
  if (afterExposure !== beforeExposure) lines.push(`暴露 ${beforeExposure}->${afterExposure}`);
  if (afterPressure !== beforePressure) lines.push(`压力 ${beforePressure}->${afterPressure}`);

  const beforeClues = new Set(
    (beforeSessionState.scene?.clues || [])
      .filter((item: Record<string, any>) => item.revealed)
      .map((item: Record<string, any>) => String(item.id)),
  );
  const newClues = (afterSessionState.scene?.clues || []).filter(
    (item: Record<string, any>) => item.revealed && !beforeClues.has(String(item.id)),
  );
  if (newClues.length > 0) {
    lines.push(`新线索：${newClues.map((item: Record<string, any>) => item.title).join("、")}`);
  }

  const beforeEvents = new Set(
    (beforeSessionState.scene?.events || [])
      .filter((item: Record<string, any>) => item.triggered)
      .map((item: Record<string, any>) => String(item.id)),
  );
  const newEvents = (afterSessionState.scene?.events || []).filter(
    (item: Record<string, any>) => item.triggered && !beforeEvents.has(String(item.id)),
  );
  if (newEvents.length > 0) {
    lines.push(`新事件：${newEvents.map((item: Record<string, any>) => item.label).join("、")}`);
  }

  const beforeNpcMap = collectNpcStateMap(beforeSessionState);
  for (const npc of afterSessionState.scene?.participants?.npcs || []) {
    const beforeNpc = beforeNpcMap.get(String(npc.id));
    if (!beforeNpc) continue;
    const npcChanges: string[] = [];
    if (beforeNpc.attitude !== npc.attitude) npcChanges.push(`态度 ${beforeNpc.attitude}->${npc.attitude}`);
    if ((beforeNpc.trust ?? 0) !== (npc.trust ?? 0)) npcChanges.push(`trust ${(beforeNpc.trust ?? 0)}->${(npc.trust ?? 0)}`);
    if ((beforeNpc.socialState?.suspicion ?? 0) !== (npc.socialState?.suspicion ?? 0)) {
      npcChanges.push(`戒心 ${(beforeNpc.socialState?.suspicion ?? 0)}->${(npc.socialState?.suspicion ?? 0)}`);
    }
    if ((beforeNpc.socialState?.fear ?? 0) !== (npc.socialState?.fear ?? 0)) {
      npcChanges.push(`恐惧 ${(beforeNpc.socialState?.fear ?? 0)}->${(npc.socialState?.fear ?? 0)}`);
    }
    if ((beforeNpc.socialState?.affinity ?? 0) !== (npc.socialState?.affinity ?? 0)) {
      npcChanges.push(`亲近 ${(beforeNpc.socialState?.affinity ?? 0)}->${(npc.socialState?.affinity ?? 0)}`);
    }
    if ((beforeNpc.socialState?.obligation ?? 0) !== (npc.socialState?.obligation ?? 0)) {
      npcChanges.push(`亏欠 ${(beforeNpc.socialState?.obligation ?? 0)}->${(npc.socialState?.obligation ?? 0)}`);
    }
    if (npcChanges.length > 0) {
      lines.push(`${npc.name}：${npcChanges.join("，")}`);
    }
  }

  if (lines.length === 0) return null;
  return `状态变化：\n- ${lines.join("\n- ")}`;
}

function describeOperationOutcome(resultEvent: Record<string, any> | undefined) {
  if (!resultEvent?.result) return null;
  if (resultEvent.mode === "hidden") {
    return `${resultEvent.skillKey}（暗骰 ${resultEvent.result.successLevel}）`;
  }
  return `${resultEvent.skillKey} 投掷 ${resultEvent.roll}/${resultEvent.targetValue}（${resultEvent.result.successLevel}）`;
}

function buildOperationEvent(kind: string, summary: string, payload: Record<string, unknown> = {}) {
  return {
    timestamp: new Date().toISOString(),
    kind,
    summary,
    ...payload,
  };
}

function buildStateSnapshot(stateBundle: StateBundle): Record<string, unknown> {
  const turnState = (stateBundle.meta.turnState as Record<string, any> | undefined) ?? {
    actorOrder: [],
    currentActorId: null,
    round: 1,
  };
  const currentActor = turnState.currentActorId
    ? stateBundle.sessionState.investigators?.[turnState.currentActorId]
    : null;
  return {
    updatedAt: new Date().toISOString(),
    conversationKey: stateBundle.layout.conversationKey,
    sessionMode: stateBundle.meta.sessionMode || "idle",
    runtimeProfileId: stateBundle.meta.runtimeProfileId || "maimai-kp-v1",
    summaryState: structuredClone(stateBundle.meta.summaryState || {}),
    knownUsers: structuredClone(stateBundle.meta.knownUsers || []),
    turnState: {
      actorOrder: [...(turnState.actorOrder || [])],
      currentActorId: turnState.currentActorId,
      currentActorName: currentActor?.name || null,
      round: turnState.round,
    },
    revealedClues: (stateBundle.sessionState.scene?.clues || [])
      .filter((item: Record<string, any>) => item.revealed)
      .map((item: Record<string, any>) => item.title),
    scene: {
      summary: stateBundle.sessionState.scene?.summary || null,
      location: stateBundle.sessionState.scene?.location || null,
      dangerLevel: stateBundle.sessionState.scene?.threats?.dangerLevel || null,
      exposure: stateBundle.sessionState.scene?.threats?.exposure ?? 0,
      pressure: stateBundle.sessionState.scene?.threats?.pressure ?? 0,
      timelineMinute: stateBundle.sessionState.scene?.timeState?.timelineMinute ?? 0,
      combatRound: stateBundle.sessionState.scene?.timeState?.combatRound ?? 0,
    },
    investigators: Object.values(stateBundle.sessionState.investigators || {}).map(
      (investigator: Record<string, any>) => ({
        id: investigator.id,
        name: investigator.name,
        occupation: investigator.occupation,
        occupationKey: investigator.occupationKey,
        hp: investigator.resources?.hp ?? null,
        san: investigator.resources?.san ?? null,
        luck: investigator.resources?.luck ?? null,
      }),
    ),
  };
}

function persistConversationArtifacts(params: {
  modules: LoadedAiKpModules;
  config: ReturnType<typeof resolveOneBotAiKpConfig>;
  stateBundle: StateBundle;
  event: SyntheticOneBotEvent;
  inboundText?: string;
  replyText?: string;
  operationEvents?: Array<Record<string, unknown>>;
}): Record<string, unknown> {
  const { modules, config, stateBundle, event, inboundText, replyText } = params;
  if (inboundText?.trim()) {
    modules.logStore.appendChatLog(stateBundle.layout, buildChatLogEntry(event, "inbound", inboundText.trim()));
  }
  if (replyText?.trim()) {
    modules.logStore.appendChatLog(stateBundle.layout, buildChatLogEntry(event, "outbound", replyText.trim()));
  }

  const operationEvents = params.operationEvents ?? [];
  for (const operationEvent of operationEvents) {
    modules.logStore.appendOperationLog(stateBundle.layout, operationEvent);
  }
  modules.logStore.appendPlayerOperationLogs(stateBundle.layout, operationEvents);

  modules.core.saveSessionApi(stateBundle.sessionState, stateBundle.layout.sessionFile, {
    meta: { conversationKey: stateBundle.layout.conversationKey },
  });
  stateBundle.meta.updatedAt = new Date().toISOString();
  modules.singleSession.saveMeta(stateBundle.layout, stateBundle.meta);

  let stateSnapshot = buildStateSnapshot(stateBundle);
  const summaryChunk = modules.logStore.maybeRollupSummaries(stateBundle.layout, stateBundle.meta, stateSnapshot, {});
  if (summaryChunk?.chunkName) {
    modules.logStore.appendOperationLog(
      stateBundle.layout,
      buildOperationEvent("summary.rollup", `生成摘要块 ${summaryChunk.chunkName}`, {
        chunkName: summaryChunk.chunkName,
        pendingChatCount: summaryChunk.pendingChatCount ?? 0,
      }),
    );
    stateSnapshot = buildStateSnapshot(stateBundle);
  }

  modules.logStore.writeStateSnapshot(stateBundle.layout, stateSnapshot);
  const contextPacket = modules.logStore.buildContextPacket(stateBundle.layout, stateBundle.meta, stateSnapshot, {
    runtimePrompt: modules.singleSession.getKpRuntimePrompt(),
    recentChatLimit: config.recentChatLimit,
    recentOperationLimit: config.recentOperationLimit,
    summaryChunkLimit: config.summaryChunkLimit,
  });
  modules.logStore.writeContextSnapshot(stateBundle.layout, contextPacket);
  return contextPacket;
}

function buildToolPayload(params: {
  action: string;
  conversationKey?: string;
  replyText?: string | null;
  shouldReplyVerbatim?: boolean;
  packet?: unknown;
  extra?: Record<string, unknown>;
}) {
  return {
    ok: true,
    action: params.action,
    conversationKey: params.conversationKey ?? null,
    replyText: params.replyText ?? null,
    shouldReplyVerbatim: params.shouldReplyVerbatim === true,
    contextPacket: params.packet ?? null,
    ...params.extra,
  };
}

function buildSessionStatus(params: {
  modules: LoadedAiKpModules;
  runtime: ConversationRuntimeContext;
}): Record<string, unknown> {
  const event = buildSyntheticEvent(params.runtime, { message: "status" });
  const layout = params.modules.singleSession.buildStorageLayout(params.runtime.aiKpConfig.storageRoot!, event);
  const meta = params.modules.singleSession.loadMeta(layout) ?? {};
  const replyLines = [`当前模式：${meta.sessionMode || "idle"}`, `当前会话：${layout.conversationKey}`];
  if (meta.pendingResumeChoice) {
    replyLines.push("当前待确认：续旧档 / 新开线");
  }
  if (meta.pendingStoryPackChoice) {
    replyLines.push("当前待确认：选择剧本");
  }
  if (meta.storyPackId) {
    replyLines.push(`当前剧本：${meta.storyPackId}`);
  }
  if (existsSync(layout.sessionFile)) {
    const stateBundle = params.modules.singleSession.ensureConversationSession(event, {
      storageRoot: params.runtime.aiKpConfig.storageRoot,
    });
    replyLines.push("");
    replyLines.push(params.modules.singleSession.formatStateSummary(stateBundle.sessionState, stateBundle.meta));
    replyLines.push("");
    replyLines.push(params.modules.singleSession.formatPartySummary(stateBundle));
  } else {
    replyLines.push("当前还没有初始化过 AI-KP 场景。需要时直接开始跑团即可。");
  }
  return {
    ok: true,
    action: "status",
    conversationKey: layout.conversationKey,
    replyText: replyLines.join("\n"),
    shouldReplyVerbatim: false,
    pendingResumeChoice: meta.pendingResumeChoice ?? null,
    pendingStoryPackChoice: meta.pendingStoryPackChoice ?? null,
    storyPackId: meta.storyPackId ?? null,
  };
}

function mapSemanticSessionRouteToToolAction(params: {
  action: string;
  originalText: string;
}): { action: RoutedSessionAction; panel?: PanelAction; value?: string } | null {
  switch (params.action) {
    case "start":
      return { action: "start" };
    case "resume":
      return { action: "resume" };
    case "new_line":
      return { action: "new_line" };
    case "pause":
      return { action: "pause" };
    case "reply_to_prompt":
      return { action: "reply_to_prompt", value: params.originalText };
    case "list_saves":
      return { action: "list_saves" };
    case "list_story_packs":
      return { action: "list_story_packs" };
    case "panel_state":
      return { action: "panel", panel: "state" };
    case "panel_recap":
      return { action: "panel", panel: "recap" };
    case "panel_party":
      return { action: "panel", panel: "party" };
    default:
      return null;
  }
}

async function resolveSemanticSessionAction(params: {
  runtime: ConversationRuntimeContext;
  modules: LoadedAiKpModules;
  agentId?: string | null;
  originalText: string;
  senderName?: string;
}): Promise<{
  routed: { action: RoutedSessionAction; panel?: PanelAction; value?: string } | null;
  decision: Awaited<ReturnType<typeof classifyOneBotAiKpSessionRoute>>;
}> {
  const seedEvent = buildSyntheticEvent(params.runtime, {
    message: params.originalText,
    rawMessage: params.originalText,
    senderName: params.senderName,
  });
  const stateBundle = params.modules.singleSession.ensureConversationSession(seedEvent, {
    storageRoot: params.runtime.aiKpConfig.storageRoot,
  });
  const hasExistingContext =
    existsSync(stateBundle.layout.sessionFile) ||
    (Array.isArray(stateBundle.meta.archiveHistory) && stateBundle.meta.archiveHistory.length > 0);
  const decision = await classifyOneBotAiKpSessionRoute({
    cfg: params.runtime.cfg,
    text: params.originalText,
    agentId: params.agentId,
    sessionMode: typeof stateBundle.meta.sessionMode === "string" ? stateBundle.meta.sessionMode : "idle",
    pendingResumeChoice: Boolean(stateBundle.meta.pendingResumeChoice),
    pendingStoryPackChoice: Boolean(stateBundle.meta.pendingStoryPackChoice),
    hasExistingContext,
  });
  const routed = decision
    ? mapSemanticSessionRouteToToolAction({
        action: decision.action,
        originalText: params.originalText,
      })
    : null;
  return { routed, decision };
}

function listOccupationOptions(modules: LoadedAiKpModules): Array<{ key: string; name?: string | null }> {
  const templates = typeof modules.core.listOccupationTemplates === "function"
    ? modules.core.listOccupationTemplates()
    : [];
  return templates
    .map((entry) => {
      const key = typeof entry?.key === "string" ? entry.key.trim() : "";
      if (!key) return null;
      const name = typeof entry?.name === "string" ? entry.name.trim() : null;
      return { key, name };
    })
    .filter((entry): entry is { key: string; name?: string | null } => Boolean(entry));
}

function mapSemanticRollRouteToToolAction(params: {
  action: string;
  occupationKey?: string;
}): { action: RoutedRollAction; occupationKey?: string } | null {
  switch (params.action) {
    case "traditional":
      return { action: "traditional", occupationKey: params.occupationKey };
    case "quickfire":
      return { action: "quickfire", occupationKey: params.occupationKey };
    case "party_traditional":
      return { action: "party_traditional", occupationKey: params.occupationKey };
    case "party_quickfire":
      return { action: "party_quickfire", occupationKey: params.occupationKey };
    case "sheet":
      return { action: "sheet" };
    default:
      return null;
  }
}

async function resolveSemanticRollAction(params: {
  runtime: ConversationRuntimeContext;
  modules: LoadedAiKpModules;
  agentId?: string | null;
  originalText: string;
  senderName?: string;
}): Promise<{
  routed: { action: RoutedRollAction; occupationKey?: string } | null;
  decision: Awaited<ReturnType<typeof classifyOneBotAiKpRollRoute>>;
}> {
  const seedEvent = buildSyntheticEvent(params.runtime, {
    message: params.originalText,
    rawMessage: params.originalText,
    senderName: params.senderName,
  });
  const stateBundle = params.modules.singleSession.ensureConversationSession(seedEvent, {
    storageRoot: params.runtime.aiKpConfig.storageRoot,
  });
  const occupationOptions = listOccupationOptions(params.modules);
  const actorId = stateBundle.meta.actorsByUserId?.[params.runtime.userId] as string | undefined;
  const knownPlayerCount = Array.isArray(stateBundle.meta.knownUsers) ? stateBundle.meta.knownUsers.length : 1;
  const decision = await classifyOneBotAiKpRollRoute({
    cfg: params.runtime.cfg,
    text: params.originalText,
    occupationOptions,
    agentId: params.agentId,
    sessionMode: typeof stateBundle.meta.sessionMode === "string" ? stateBundle.meta.sessionMode : "idle",
    hasCurrentInvestigator: Boolean(actorId && stateBundle.sessionState.investigators?.[actorId]),
    knownPlayerCount,
  });
  const routed = decision
    ? mapSemanticRollRouteToToolAction({
        action: decision.action,
        occupationKey: decision.occupationKey,
      })
    : null;
  return { routed, decision };
}

function sessionActionToText(action: RoutedSessionAction, panel: PanelAction | undefined, value?: string) {
  switch (action) {
    case "start":
      return "/aikp start";
    case "reply_to_prompt":
      return value ?? null;
    case "pause":
      return "先不跑了";
    case "list_saves":
      return "/aikp saves";
    case "list_story_packs":
      return "/aikp packs";
    case "select_story_pack":
      return `/aikp pack ${value ?? ""}`.trim();
    case "resume":
      return value ? `/aikp resume ${value}` : "/aikp resume";
    case "new_line":
      return "/aikp new";
    case "focus":
      return `/aikp focus ${value ?? ""}`.trim();
    case "next_turn":
      return "/aikp next";
    case "panel":
      return panel ? `/aikp ${panel}` : "/aikp state";
    default:
      return null;
  }
}
async function executeSessionTool(
  api: ClawdbotPluginApi,
  ctx: ClawdbotPluginToolContext,
  params: Record<string, unknown>,
) {
  const runtime = await resolveConversationRuntimeContext(api, ctx);
  const modules = loadAiKpModules(runtime.cfg);
  const action = readStringParam(params, "action", { required: true }) as SessionToolAction;
  if (action === "status") {
    const payload = buildSessionStatus({ modules, runtime });
    const packet = await loadOneBotAiKpContextPacket({
      cfg: runtime.cfg,
      groupId: runtime.groupId,
      userId: runtime.groupId ? undefined : runtime.userId,
    });
    return jsonResult({ ...payload, contextPacket: packet?.packet ?? null });
  }

  const originalText = readStringParam(params, "originalText");
  let effectiveAction = action as RoutedSessionAction | "semantic_reply";
  let panel = readStringParam(params, "panel") as PanelAction | undefined;
  let value = readStringParam(params, "value");
  const senderName = readStringParam(params, "senderName");
  let semanticResolution: Awaited<ReturnType<typeof classifyOneBotAiKpSessionRoute>> = null;
  if (action === "semantic_reply") {
    if (!originalText?.trim()) {
      throw new Error("action semantic_reply requires originalText");
    }
    const resolved = await resolveSemanticSessionAction({
      runtime,
      modules,
      agentId: ctx.agentId,
      originalText,
      senderName,
    });
    semanticResolution = resolved.decision;
    if (!resolved.routed) {
      const packet = await loadOneBotAiKpContextPacket({
        cfg: runtime.cfg,
        groupId: runtime.groupId,
        userId: runtime.groupId ? undefined : runtime.userId,
      });
      return jsonResult({
        ok: false,
        action,
        noSessionAction: true,
        shouldReplyVerbatim: false,
        replyText: null,
        reason: semanticResolution?.reason ?? "normal_chat",
        contextPacket: packet?.packet ?? null,
      });
    }
    effectiveAction = resolved.routed.action;
    panel = resolved.routed.panel;
    value = resolved.routed.value;
  }

  const message = sessionActionToText(effectiveAction, panel, value);
  if (!message?.trim()) {
    throw new Error(`action ${effectiveAction} requires a value`);
  }

  const event = buildSyntheticEvent(runtime, {
    message,
    rawMessage: originalText ?? message,
    senderName,
  });
  const result = modules.singleSession.handleOneBotMessage(event, buildToolRuntimeOptions(runtime.aiKpConfig));
  return jsonResult(
    buildToolPayload({
      action,
      conversationKey: (result.contextPacket as Record<string, unknown> | null)?.conversationKey as
        | string
        | undefined,
      replyText: result.reply ?? null,
      shouldReplyVerbatim: true,
      packet: result.contextPacket ?? null,
      extra: {
        reason: result.reason ?? null,
        usedMessage: message,
        routedAction: effectiveAction,
        routedPanel: panel ?? null,
        semanticResolution,
      },
    }),
  );
}

async function executeRollTool(
  api: ClawdbotPluginApi,
  ctx: ClawdbotPluginToolContext,
  params: Record<string, unknown>,
) {
  const runtime = await resolveConversationRuntimeContext(api, ctx);
  const modules = loadAiKpModules(runtime.cfg);
  const action = readStringParam(params, "action", { required: true }) as RollAction;
  const originalText = readStringParam(params, "originalText");
  let occupationKey = readStringParam(params, "occupationKey");
  const senderName = readStringParam(params, "senderName");
  let effectiveAction = action as RoutedRollAction | "semantic_reply";
  let semanticResolution: Awaited<ReturnType<typeof classifyOneBotAiKpRollRoute>> = null;
  if (action === "semantic_reply") {
    if (!originalText?.trim()) {
      throw new Error("action semantic_reply requires originalText");
    }
    const resolved = await resolveSemanticRollAction({
      runtime,
      modules,
      agentId: ctx.agentId,
      originalText,
      senderName,
    });
    semanticResolution = resolved.decision;
    if (!resolved.routed) {
      const packet = await loadOneBotAiKpContextPacket({
        cfg: runtime.cfg,
        groupId: runtime.groupId,
        userId: runtime.groupId ? undefined : runtime.userId,
      });
      return jsonResult({
        ok: false,
        action,
        noRollAction: true,
        shouldReplyVerbatim: false,
        replyText: null,
        reason: semanticResolution?.reason ?? "normal_chat",
        semanticResolution,
        contextPacket: packet?.packet ?? null,
      });
    }
    effectiveAction = resolved.routed.action;
    occupationKey = resolved.routed.occupationKey ?? occupationKey;
  }

  let message: string;
  switch (effectiveAction) {
    case "traditional":
      message = `/aikp roll ${occupationKey ?? "journalist"}`;
      break;
    case "quickfire":
      message = `/aikp quickfire ${occupationKey ?? "journalist"}`;
      break;
    case "party_traditional":
      message = `/aikp party-roll ${occupationKey ?? "journalist"}`;
      break;
    case "party_quickfire":
      message = `/aikp party-quickfire ${occupationKey ?? "journalist"}`;
      break;
    case "sheet":
      message = "/aikp sheet";
      break;
    default:
      throw new Error("Unsupported roll action");
  }
  const event = buildSyntheticEvent(runtime, {
    message,
    rawMessage: originalText ?? message,
    senderName,
  });
  const result = modules.singleSession.handleOneBotMessage(event, buildToolRuntimeOptions(runtime.aiKpConfig));
  return jsonResult(
    buildToolPayload({
      action,
      conversationKey: (result.contextPacket as Record<string, unknown> | null)?.conversationKey as
        | string
        | undefined,
      replyText: result.reply ?? null,
      shouldReplyVerbatim: true,
      packet: result.contextPacket ?? null,
      extra: {
        occupationKey:
          effectiveAction === "sheet"
            ? null
            : occupationKey ?? "journalist",
        usedMessage: message,
        routedAction: effectiveAction,
        semanticResolution,
      },
    }),
  );
}

async function executeSceneTurnTool(
  api: ClawdbotPluginApi,
  ctx: ClawdbotPluginToolContext,
  params: Record<string, unknown>,
) {
  const runtime = await resolveConversationRuntimeContext(api, ctx);
  const modules = loadAiKpModules(runtime.cfg);
  const originalText = readStringParam(params, "originalText", { required: true });
  const normalizedAction = readStringParam(params, "normalizedAction");
  const semanticIntent: SemanticSceneIntent = {
    actionKind: readStringParam(params, "actionKind") as SemanticSceneIntent["actionKind"] | undefined,
    intentSummary: readStringParam(params, "intentSummary"),
    normalizedAction,
    skillKey: readStringParam(params, "skillKey"),
    targetNpc: readStringParam(params, "targetNpc"),
    targetClue: readStringParam(params, "targetClue"),
    targetArea: readStringParam(params, "targetArea"),
    itemName: readStringParam(params, "itemName"),
    riskLevel: readStringParam(params, "riskLevel") as SemanticSceneIntent["riskLevel"] | undefined,
    impactScore: readNumberParam(params, "impactScore", { integer: true }),
    leverageScore: readNumberParam(params, "leverageScore", { integer: true }),
    narrativeBonus: readNumberParam(params, "narrativeBonus", { integer: true }),
    mode: readStringParam(params, "mode") as SemanticSceneIntent["mode"] | undefined,
    duration: readStringParam(params, "duration") as SemanticSceneIntent["duration"] | undefined,
    revealClueId: readStringParam(params, "revealClueId"),
    clueTitle: readStringParam(params, "clueTitle"),
    clueKind: readStringParam(params, "clueKind"),
    clueQuality: readStringParam(params, "clueQuality"),
    failureEventLabel: readStringParam(params, "failureEventLabel"),
    onSuccessPrompt: readStringParam(params, "onSuccessPrompt"),
    onFailPrompt: readStringParam(params, "onFailPrompt"),
    routineHints: readStringArrayParam(params, "routineHints"),
    environmentTags: readStringArrayParam(params, "environmentTags"),
  };
  const hasStructuredIntent = Boolean(semanticIntent.actionKind);
  if (!hasStructuredIntent && !normalizedAction?.trim()) {
    throw new Error("scene_turn requires actionKind for semantic execution or normalizedAction for legacy fallback");
  }
  const actorSelector = readStringParam(params, "actorSelector");
  const senderName = readStringParam(params, "senderName");
  const event = buildSyntheticEvent(runtime, {
    message: normalizedAction ?? semanticIntent.intentSummary ?? originalText,
    rawMessage: originalText,
    senderName,
  });
  const stateBundle = modules.singleSession.ensureConversationSession(event, {
    storageRoot: runtime.aiKpConfig.storageRoot,
  });

  if (stateBundle.meta.pendingResumeChoice || stateBundle.meta.pendingStoryPackChoice) {
    return jsonResult({
      ok: false,
      action: "scene_turn",
      needsSessionChoice: true,
      replyText: "这边还有续档/选剧本没确认，先把那个选项收掉，我再替你落场内动作。",
      shouldReplyVerbatim: true,
    });
  }

  if ((stateBundle.meta.sessionMode || "idle") !== "kp") {
    return jsonResult({
      ok: false,
      action: "scene_turn",
      needsSessionStart: true,
      replyText: "这条线现在还没正式跑起来。先接上旧档或开团，我再替你接场内动作。",
      shouldReplyVerbatim: true,
    });
  }

  let actorId = stateBundle.meta.actorsByUserId?.[runtime.userId] as string | undefined;
  if (actorSelector) {
    const selected = modules.singleSession.resolveActorSelection(stateBundle, actorSelector);
    actorId = selected?.actorId ?? actorId;
    if (selected?.actorId) {
      modules.singleSession.setCurrentActor(stateBundle, selected.actorId);
    }
  }
  if (!actorId) {
    const actorResult = modules.singleSession.ensureActorForUser(event, stateBundle, {
      autoCreateInvestigator: false,
    });
    actorId = actorResult.actorId ?? undefined;
  }

  if (!actorId) {
    const replyText =
      "你还没车卡喔。可以直接说“我想一次全车完卡，角色选记者”，或者“给我快速车卡，职业医生”；要继续用指令也行：`/aikp roll journalist`。";
    const contextPacket = persistConversationArtifacts({
      modules,
      config: runtime.aiKpConfig,
      stateBundle,
      event,
      inboundText: originalText,
      replyText,
      operationEvents: [
        buildOperationEvent("turn.blocked", `${senderName ?? runtime.senderName} 想行动，但还没有调查员卡`, {
          userId: runtime.userId,
        }),
      ],
    });
    return jsonResult({
      ok: false,
      action: "scene_turn",
      needsCharacter: true,
      replyText,
      shouldReplyVerbatim: true,
      contextPacket,
    });
  }

  const beforeSessionState = structuredClone(stateBundle.sessionState);
  let turn: {
    ok: boolean;
    reply?: string;
    reason?: string;
    action?: Record<string, any>;
    result?: Record<string, any>;
  };
  let resolvedSemanticAction:
    | ReturnType<typeof buildSemanticSceneAction>
    | null = null;

  if (hasStructuredIntent) {
    const investigator = stateBundle.sessionState.investigators?.[actorId] as Record<string, any> | undefined;
    if (!investigator) {
      turn = {
        ok: false,
        reason: "missing_actor",
        reply: "这位调查员还没进场，我现在没法替他落动作。",
      };
    } else {
      resolvedSemanticAction = buildSemanticSceneAction({
        sessionState: stateBundle.sessionState,
        actorId,
        originalText,
        intent: semanticIntent,
      });
      if (!resolvedSemanticAction.action) {
        turn = {
          ok: false,
          reason: resolvedSemanticAction.reason ?? "missing_semantic_action",
          reply:
            "这句场内动作我还没拿到完整的结构化意图。需要先确定 actionKind，再补目标/NPC/技能这些关键字段。",
        };
      } else {
        const requiredSkill = resolvedSemanticAction.action.skillKey
          ? investigator.skills?.find(
              (item: Record<string, any>) => item.key === resolvedSemanticAction?.action?.skillKey,
            ) ?? null
          : null;
        if (resolvedSemanticAction.action.skillKey && !requiredSkill) {
          turn = {
            ok: false,
            reason: "missing_skill",
            action: resolvedSemanticAction.action,
            reply: `我听懂你想做什么了，但这名调查员现在卡里没有 ${resolvedSemanticAction.action.skillKey}，这一步我还不能稳稳落。`,
          };
        } else {
          turn = {
            ok: true,
            action: resolvedSemanticAction.action,
            result: modules.core.submitAction(
              stateBundle.sessionState,
              resolvedSemanticAction.action,
              defaultRandomInt,
            ) as Record<string, any>,
          };
        }
      }
    }
  } else {
    turn = modules.core.processScenarioTurn(
      stateBundle.sessionState,
      actorId,
      normalizedAction!,
      modules.core.submitAction,
      defaultRandomInt,
    );
  }
  const replyText =
    turn.ok && turn.result
      ? modules.singleSession.formatTurnReply(turn.result, {
          deltaSummary: formatStateDelta(beforeSessionState, stateBundle.sessionState),
          sceneBeat: modules.singleSession.formatSceneBeat(stateBundle.sessionState),
          optionCue: modules.singleSession.formatOptionCue(stateBundle.sessionState) ?? undefined,
          spotlightCue: modules.singleSession.formatSpotlightCue(stateBundle) ?? undefined,
        })
      : turn.reply ?? "这句我先没稳稳对上现成动作。你可以试着说得更具体一点。";

  const operationSummary =
    describeOperationOutcome(turn.result?.event) || turn.action?.kind || turn.reason || "行动未处理";
  const contextPacket = persistConversationArtifacts({
    modules,
    config: runtime.aiKpConfig,
    stateBundle,
    event,
    inboundText: originalText,
    replyText,
    operationEvents: [
      buildOperationEvent(
        turn.ok ? "scene.turn" : "scene.turn_blocked",
        `${senderName ?? runtime.senderName}：${operationSummary}`,
        {
          userId: runtime.userId,
          actorId,
          normalizedAction,
          originalText,
          actionKind: turn.action?.kind ?? null,
          semanticActionKind: semanticIntent.actionKind ?? null,
          semanticTargetNpc: resolvedSemanticAction?.resolvedNpcId ?? null,
          semanticTargetClue: resolvedSemanticAction?.resolvedClueId ?? null,
          semanticTargetArea: resolvedSemanticAction?.resolvedAreaId ?? null,
          semanticRuleId: resolvedSemanticAction?.matchedRuleId ?? null,
        },
      ),
    ],
  });

  return jsonResult({
    ok: turn.ok,
    action: "scene_turn",
    actorId,
    normalizedAction: normalizedAction ?? null,
    originalText,
    replyText,
    shouldReplyVerbatim: true,
    contextPacket,
    turn: turn.ok ? turn.result ?? null : null,
    reason: turn.reason ?? null,
    semanticIntent,
    resolvedAction: turn.action ?? null,
    matchedRuleId: resolvedSemanticAction?.matchedRuleId ?? null,
  });
}

async function executeHistoryTool(
  api: ClawdbotPluginApi,
  ctx: ClawdbotPluginToolContext,
  params: Record<string, unknown>,
) {
  const runtime = await resolveConversationRuntimeContext(api, ctx);
  const modules = loadAiKpModules(runtime.cfg);
  const section = readStringParam(params, "section") as HistorySection | undefined;
  const limit = Math.max(
    1,
    Math.min(40, readNumberParam(params, "limit", { integer: true }) ?? DEFAULT_HISTORY_LIMIT),
  );
  const event = buildSyntheticEvent(runtime, { message: "history" });
  const layout = modules.singleSession.buildStorageLayout(runtime.aiKpConfig.storageRoot!, event);
  const packetRef = await loadOneBotAiKpContextPacket({
    cfg: runtime.cfg,
    groupId: runtime.groupId,
    userId: runtime.groupId ? undefined : runtime.userId,
  });
  const summaries = modules.logStore.readSummaryChunks(layout, Math.min(limit, 6));
  const chat = modules.logStore.safeReadJsonLines(layout.chatLogFile).slice(-limit);
  const operations = modules.logStore.safeReadJsonLines(layout.ledgerLogFile).slice(-limit);
  const activeSection = section ?? "all";
  return jsonResult({
    ok: true,
    action: "history",
    section: activeSection,
    conversationKey: packetRef?.conversationKey ?? layout.conversationKey,
    sessionMode: (packetRef?.packet as Record<string, unknown> | null)?.sessionMode ?? null,
    summaryChunks: activeSection === "chat" || activeSection === "operations" ? [] : summaries,
    recentChat: activeSection === "summary" || activeSection === "operations" ? [] : chat,
    recentOperations: activeSection === "summary" || activeSection === "chat" ? [] : operations,
    contextPacket: packetRef?.packet ?? null,
  });
}
export function createOneBotAiKpTools(api: ClawdbotPluginApi, ctx: ClawdbotPluginToolContext) {
  if (ctx.messageChannel !== "onebot") return null;
  if (!ctx.sessionKey?.trim()) return null;
  const config = resolveOneBotAiKpConfig(api.config as ClawdbotConfig);
  if (!config.enabled || !config.semanticToolsEnabled || !config.storageRoot) return null;

  return [
    {
      name: ONEBOT_AIKP_TOOL_NAMES.session,
      description:
        "Control AI-KP session state in OneBot QQ conversations. Use this when a user clearly wants to start, resume, pause, pick a story pack, inspect status/panels, or answer a pending resume/story-pack choice. Prefer action=semantic_reply when the user answered in natural language and you should infer the session-control meaning without forcing fixed phrases. If the user is just discussing AI-KP or asking general questions, do not call it.",
      parameters: Type.Object({
        action: stringEnum(SESSION_ACTIONS, { description: `Action to perform: ${SESSION_ACTIONS.join(", ")}` }),
        panel: Type.Optional(
          stringEnum(PANEL_ACTIONS, {
            description: `Panel to show when action=panel: ${PANEL_ACTIONS.join(", ")}`,
          }),
        ),
        value: Type.Optional(
          Type.String({ description: "Optional value for actions like select_story_pack, resume, or focus." }),
        ),
        originalText: Type.Optional(
          Type.String({
            description:
              "The user's original message. Required for action=semantic_reply and useful for reply_to_prompt or better routing/logging.",
          }),
        ),
        senderName: Type.Optional(
          Type.String({ description: "Optional player display name from the current OneBot message." }),
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => await executeSessionTool(api, ctx, params),
    },
    {
      name: ONEBOT_AIKP_TOOL_NAMES.roll,
      description:
        "Create or inspect investigator sheets in OneBot AI-KP conversations. Use this when the user wants to roll a traditional card, quickfire a card, batch-generate party cards, inspect their sheet, or answer a blocked chargen step naturally. Prefer action=semantic_reply when the player only names an occupation, asks for quick/traditional/party chargen in freeform language, or says they want to see the current sheet without fixed commands.",
      parameters: Type.Object({
        action: stringEnum(ROLL_ACTIONS, { description: `Action to perform: ${ROLL_ACTIONS.join(", ")}` }),
        occupationKey: Type.Optional(
          Type.String({
            description:
              "Optional explicit occupation key such as journalist, detective, doctor, professor, artist, veteran, or dilettante. semantic_reply can infer this automatically.",
            }),
        ),
        originalText: Type.Optional(
          Type.String({
            description:
              "The user's original message. Required for action=semantic_reply and useful for better routing/logging.",
          }),
        ),
        senderName: Type.Optional(
          Type.String({ description: "Optional player display name from the current OneBot message." }),
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => await executeRollTool(api, ctx, params),
    },
    {
      name: ONEBOT_AIKP_TOOL_NAMES.sceneTurn,
      description:
        "Resolve an in-world AI-KP scene action after you have semantically understood the player's intent. Prefer structured semantic fields such as actionKind, skillKey, targetNpc, targetClue, or targetArea. Use normalizedAction only as a legacy fallback.",
      parameters: Type.Object({
        originalText: Type.String({ description: "The player's original natural-language message." }),
        actionKind: Type.Optional(
          stringEnum(SCENE_ACTION_KINDS, {
            description: `Structured action kind: ${SCENE_ACTION_KINDS.join(", ")}`,
          }),
        ),
        intentSummary: Type.Optional(
          Type.String({
            description: "Short semantic summary of what the player is trying to do in-world.",
          }),
        ),
        normalizedAction: Type.Optional(
          Type.String({
            description:
              "Legacy fallback only: a short scene-matching phrase such as 侦查祭坛、跟踪守墓人、检查钟绳.",
          }),
        ),
        skillKey: Type.Optional(
          Type.String({
            description:
              "Preferred skill for the action, for example Spot Hidden, Listen, Persuade, Psychology, Stealth, or Fighting.",
          }),
        ),
        targetNpc: Type.Optional(
          Type.String({
            description: "NPC name or id when the player is talking to, following, stealing from, or otherwise targeting an NPC.",
          }),
        ),
        targetClue: Type.Optional(
          Type.String({
            description: "Clue title or clue id when the action is focused on a clue or hidden detail.",
          }),
        ),
        targetArea: Type.Optional(
          Type.String({
            description: "Scene area name/id when the action is focused on a location such as altar, stairs, or bell room.",
          }),
        ),
        itemName: Type.Optional(Type.String({ description: "Item or prop being used in the action." })),
        riskLevel: Type.Optional(
          stringEnum(SCENE_RISK_LEVELS, {
            description: `Optional risk override: ${SCENE_RISK_LEVELS.join(", ")}`,
          }),
        ),
        impactScore: Type.Optional(
          Type.Number({ description: "Optional impact score override (1-3)." }),
        ),
        leverageScore: Type.Optional(
          Type.Number({ description: "Optional leverage score override (0-3)." }),
        ),
        narrativeBonus: Type.Optional(
          Type.Number({ description: "Optional narrative bonus override (0-2)." }),
        ),
        mode: Type.Optional(
          stringEnum(SCENE_ACTION_MODES, {
            description: `Optional dice visibility override: ${SCENE_ACTION_MODES.join(", ")}`,
          }),
        ),
        duration: Type.Optional(
          stringEnum(SCENE_DURATIONS, {
            description: `Optional duration override: ${SCENE_DURATIONS.join(", ")}`,
          }),
        ),
        revealClueId: Type.Optional(Type.String({ description: "Clue id to reveal on success if you know it." })),
        clueTitle: Type.Optional(Type.String({ description: "Clue title to attach or reveal on success." })),
        clueKind: Type.Optional(Type.String({ description: "Optional clue kind label." })),
        clueQuality: Type.Optional(Type.String({ description: "Optional clue quality label." })),
        failureEventLabel: Type.Optional(Type.String({ description: "Optional failure-side event label." })),
        onSuccessPrompt: Type.Optional(Type.String({ description: "Optional custom narration on success." })),
        onFailPrompt: Type.Optional(Type.String({ description: "Optional custom narration on failure." })),
        routineHints: Type.Optional(
          Type.Array(Type.String({ description: "Optional routine hint." })),
        ),
        environmentTags: Type.Optional(
          Type.Array(Type.String({ description: "Optional environment tag." })),
        ),
        actorSelector: Type.Optional(
          Type.String({
            description: "Optional actor/player selector when the user is clearly acting as or switching to another investigator.",
          }),
        ),
        senderName: Type.Optional(
          Type.String({ description: "Optional player display name from the current OneBot message." }),
        ),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => await executeSceneTurnTool(api, ctx, params),
    },
    {
      name: ONEBOT_AIKP_TOOL_NAMES.history,
      description:
        "Read AI-KP summaries, recent chat lines, and operation logs for the current OneBot conversation. Use this when session context has compacted and you need older state before replying.",
      parameters: Type.Object({
        section: Type.Optional(
          stringEnum(HISTORY_SECTIONS, { description: `Section to read: ${HISTORY_SECTIONS.join(", ")}` }),
        ),
        limit: Type.Optional(Type.Number({ description: "How many recent chat/operation entries to read (1-40)." })),
      }),
      execute: async (_id: string, params: Record<string, unknown>) => await executeHistoryTool(api, ctx, params),
    },
  ];
}
