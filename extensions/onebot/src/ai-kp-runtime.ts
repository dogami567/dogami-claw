import { createRequire } from "node:module";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

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
  reason?: string | null;
  contextRef?: string | null;
  contextPacket?: unknown;
  routing?: unknown;
};

const requireForRuntime = createRequire(import.meta.url);
const runtimeModuleCache = new Map<string, AiKpRuntimeModule>();

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
  sendText: (params: { target: string; text: string }) => Promise<{ messageId?: string }>;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  onError?: (message: string) => void;
}): Promise<OneBotAiKpHandledResult | null> {
  const config = resolveOneBotAiKpConfig(params.cfg);
  if (!config.enabled || !config.delegateToRuntime || !config.runtimeModulePath) return null;
  if (!params.isGroup && !config.allowDirectMessages) return null;
  if (params.isGroup && !params.wasMentioned) return null;

  const runtimeModule = loadAiKpRuntimeModule(config.runtimeModulePath, params.onError);
  if (!runtimeModule) return null;

  const result = runtimeModule.handleOneBotEnvelope(params.envelope, {
    storageRoot: config.storageRoot,
    includeContextPacket: true,
    allowDirectMessages: config.allowDirectMessages,
    allowNaturalActivation: config.allowNaturalActivation,
  });
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
  const target = resolveAiKpTarget({ result, envelope: params.envelope });
  if (replyText.trim() && target) {
    await params.sendText({ target, text: replyText });
    params.statusSink?.({ lastOutboundAt: Date.now() });
  }

  return {
    handled: true,
    replyText: replyText || null,
    reason: result.reason ?? null,
    contextRef: result.contextRef ?? null,
    contextPacket: result.contextPacket,
    routing: result.routing,
  };
}
