import { createRequire } from "node:module";
import { existsSync } from "node:fs";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import {
  classifyOneBotAiKpActivation,
  type OneBotAiKpActivationDecision,
} from "./ai-kp-activation.js";
import { resolveOneBotAiKpConfig } from "./ai-kp-context.js";

type OneBotMessageEvent = {
  post_type?: string;
  message_type?: string;
  self_id?: string | number;
  user_id?: string | number;
  group_id?: string | number;
  message_id?: string | number;
  time?: number;
  message?: unknown;
  raw_message?: string;
  sender?: {
    nickname?: string;
    card?: string;
  };
};

type AiKpSendAction = {
  action?: string;
  params?: {
    group_id?: string | number;
    user_id?: string | number;
    message?: string;
  };
};

type AiKpEnvelopeResult = {
  ignored?: boolean;
  reason?: string | null;
  replyText?: string | null;
  sendAction?: AiKpSendAction | null;
  contextRef?: string | null;
  contextPacket?: unknown;
  routing?: unknown;
};

type AiKpRuntimeModule = {
  handleOneBotEnvelope: (
    envelope: OneBotMessageEvent,
    options?: Record<string, unknown>,
  ) => AiKpEnvelopeResult;
};

export type OneBotAiKpHandledResult = {
  handled: boolean;
  replyText?: string | null;
  replySegments?: string[];
  replyMode?: "single" | "segments";
  reason?: string | null;
  contextRef?: string | null;
  contextPacket?: unknown;
  routing?: unknown;
};

type OneBotAiKpReplyDeliveryPlan = {
  replySegments: string[];
  replyMode: "single" | "segments";
};

function buildSyntheticEnvelope(params: {
  envelope: OneBotMessageEvent;
  cleanedText?: string;
  decision: OneBotAiKpActivationDecision;
}): OneBotMessageEvent {
  const originalText =
    params.cleanedText?.trim() ||
    String(params.envelope.raw_message ?? params.envelope.message ?? "").trim();

  let rewritten = originalText;
  switch (params.decision.action) {
    case "start":
      rewritten = "我想跑团";
      break;
    case "resume":
      rewritten = "续上";
      break;
    case "new":
      rewritten = "新开";
      break;
    case "exit":
      rewritten = "先不跑了";
      break;
    case "roll":
      rewritten = `我要车卡，${originalText}`.trim();
      break;
    case "normal":
    default:
      break;
  }

  return {
    ...params.envelope,
    message: rewritten,
    raw_message: rewritten,
  };
}

const requireForRuntime = createRequire(import.meta.url);
const runtimeModuleCache = new Map<string, AiKpRuntimeModule>();
const DEFAULT_ONEBOT_TEXT_CHUNK_LIMIT = 4000;

function buildReplyPreview(text: string): string {
  const normalized = text.replace(/\r?\n/g, "\\n");
  return normalized.length > 96 ? `${normalized.slice(0, 96)}?` : normalized;
}

function resolveAiKpTextChunkLimit(cfg: ClawdbotConfig): number {
  const channelsConfig = cfg.channels as Record<string, unknown> | undefined;
  const onebotConfig = channelsConfig?.onebot as { textChunkLimit?: number } | undefined;
  return typeof onebotConfig?.textChunkLimit === "number" && onebotConfig.textChunkLimit > 0
    ? onebotConfig.textChunkLimit
    : DEFAULT_ONEBOT_TEXT_CHUNK_LIMIT;
}

function findReplySplitIndex(window: string): number {
  let paragraphBreakEnd = -1;
  for (const match of window.matchAll(/\r?\n[\t ]*\r?\n+/g)) {
    paragraphBreakEnd = (match.index ?? 0) + match[0].length;
  }
  if (paragraphBreakEnd > 0) return paragraphBreakEnd;

  const newlineIndex = window.lastIndexOf("\n");
  if (newlineIndex > 0) return newlineIndex + 1;

  for (let index = window.length - 1; index > 0; index -= 1) {
    if (/\s/.test(window[index] ?? "")) {
      return index + 1;
    }
  }
  return -1;
}

function splitReplyTextExactly(text: string, limit: number): string[] {
  if (!text) return [];
  if (limit <= 0 || text.length <= limit) return [text];

  const segments: string[] = [];
  let offset = 0;

  while (offset < text.length) {
    const remaining = text.length - offset;
    if (remaining <= limit) {
      segments.push(text.slice(offset));
      break;
    }

    const window = text.slice(offset, offset + limit);
    const splitIndex = findReplySplitIndex(window);
    const nextOffset = splitIndex > 0 ? offset + splitIndex : offset + limit;
    segments.push(text.slice(offset, nextOffset));
    offset = nextOffset;
  }

  return segments;
}

async function resolveAiKpReplyDeliveryPlan(params: {
  cfg: ClawdbotConfig;
  replyText: string;
}): Promise<OneBotAiKpReplyDeliveryPlan> {
  const { replyText } = params;
  if (!replyText.trim()) {
    return {
      replySegments: [],
      replyMode: "single",
    };
  }

  const textChunkLimit = resolveAiKpTextChunkLimit(params.cfg);
  if (replyText.length <= textChunkLimit) {
    return {
      replySegments: [replyText],
      replyMode: "single",
    };
  }

  // Keep exact text round-trippable: do not trim or skip separators between segments.
  const replySegments = splitReplyTextExactly(replyText, textChunkLimit).filter(
    (segment) => segment.length > 0,
  );
  return {
    replySegments: replySegments.length > 0 ? replySegments : [replyText],
    replyMode: replySegments.length > 1 ? "segments" : "single",
  };
}

function loadAiKpRuntimeModule(
  runtimeModulePath: string,
  onError?: (message: string) => void,
): AiKpRuntimeModule | null {
  const cached = runtimeModuleCache.get(runtimeModulePath);
  if (cached) return cached;
  try {
    const loaded = requireForRuntime(runtimeModulePath) as Partial<AiKpRuntimeModule>;
    if (typeof loaded.handleOneBotEnvelope !== "function") {
      onError?.(`onebot ai-kp: runtime module missing handleOneBotEnvelope (${runtimeModulePath})`);
      return null;
    }
    const runtimeModule = {
      handleOneBotEnvelope: loaded.handleOneBotEnvelope,
    };
    runtimeModuleCache.set(runtimeModulePath, runtimeModule);
    return runtimeModule;
  } catch (error) {
    onError?.(`onebot ai-kp: failed loading runtime module ${runtimeModulePath}: ${String(error)}`);
    return null;
  }
}

function resolveAiKpTarget(params: {
  result: AiKpEnvelopeResult;
  envelope: OneBotMessageEvent;
}): string | null {
  const { result, envelope } = params;
  const action = result.sendAction;
  if (action?.action === "send_group_msg" && action.params?.group_id != null) {
    return `group:${String(action.params.group_id)}`;
  }
  if (action?.action === "send_private_msg" && action.params?.user_id != null) {
    return `user:${String(action.params.user_id)}`;
  }
  if (envelope.message_type === "group" && envelope.group_id != null) {
    return `group:${String(envelope.group_id)}`;
  }
  if (envelope.user_id != null) {
    return `user:${String(envelope.user_id)}`;
  }
  return null;
}

export async function maybeHandleOneBotAiKpRuntime(params: {
  cfg: ClawdbotConfig;
  envelope: OneBotMessageEvent;
  wasMentioned: boolean;
  isGroup: boolean;
  cleanedText?: string;
  agentId?: string | null;
  sendText: (params: { target: string; text: string }) => Promise<{ messageId?: string }>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onError?: (message: string) => void;
  classifyActivationIntent?: (params: {
    cfg: ClawdbotConfig;
    text: string;
    agentId?: string | null;
    hasExistingContext?: boolean;
    onError?: (message: string) => void;
  }) => Promise<OneBotAiKpActivationDecision | null>;
}): Promise<OneBotAiKpHandledResult | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.enabled || !config.delegateToRuntime || !config.runtimeModulePath) return null;
  if (!params.isGroup && !config.allowDirectMessages) return null;
  if (params.isGroup && !params.wasMentioned) return null;

  const runtimeModule = loadAiKpRuntimeModule(config.runtimeModulePath, params.onError);
  if (!runtimeModule) return null;

  let result = runtimeModule.handleOneBotEnvelope(params.envelope, {
    storageRoot: config.storageRoot,
    includeContextPacket: true,
    allowDirectMessages: config.allowDirectMessages,
    allowNaturalActivation: config.allowNaturalActivation,
  });
  if (result?.ignored && config.activationRouterEnabled) {
    const classifyActivationIntent = params.classifyActivationIntent ?? classifyOneBotAiKpActivation;
    const decision = await classifyActivationIntent({
      cfg: params.cfg,
      text:
        params.cleanedText?.trim() ||
        String(params.envelope.raw_message ?? params.envelope.message ?? "").trim(),
      agentId: params.agentId,
      hasExistingContext:
        typeof result.contextRef === "string" && result.contextRef.length > 0
          ? existsSync(result.contextRef)
          : false,
      onError: params.onError,
    });
    if (decision && decision.action !== "normal" && result.reason === "inactive_group_session") {
      const syntheticEnvelope = buildSyntheticEnvelope({
        envelope: params.envelope,
        cleanedText: params.cleanedText,
        decision,
      });
      result = runtimeModule.handleOneBotEnvelope(syntheticEnvelope, {
        storageRoot: config.storageRoot,
        includeContextPacket: true,
        allowDirectMessages: config.allowDirectMessages,
        allowNaturalActivation: config.allowNaturalActivation,
      });
    }
  }
  if (!result || result.ignored) {
    return {
      handled: false,
      reason: result?.reason ?? null,
      contextRef: result?.contextRef ?? null,
      contextPacket: result?.contextPacket,
      routing: result?.routing,
    };
  }

  const replyText = typeof result.replyText === "string" ? result.replyText : "";
  const deliveryPlan = await resolveAiKpReplyDeliveryPlan({
    cfg: params.cfg,
    replyText,
  });
  const target = resolveAiKpTarget({ result, envelope: params.envelope });
  if (deliveryPlan.replySegments.length > 0 && target) {
    for (const [index, segment] of deliveryPlan.replySegments.entries()) {
      try {
        await params.sendText({ target, text: segment });
        params.statusSink?.({ lastOutboundAt: Date.now() });
      } catch (error) {
        const segmentLabel =
          deliveryPlan.replyMode === "segments"
            ? `reply segment ${index + 1}/${deliveryPlan.replySegments.length}`
            : "reply";
        params.onError?.(
          `onebot ai-kp: failed sending ${segmentLabel} to ${target}: ${String(error)} preview="${buildReplyPreview(segment)}"`,
        );
        throw error;
      }
    }
  }

  return {
    handled: true,
    replyText: replyText || null,
    replySegments: deliveryPlan.replySegments,
    replyMode: deliveryPlan.replyMode,
    reason: result.reason ?? null,
    contextRef: result.contextRef ?? null,
    contextPacket: result.contextPacket,
    routing: result.routing,
  };
}
