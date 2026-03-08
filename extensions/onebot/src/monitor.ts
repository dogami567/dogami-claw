import type {
  ClawdbotConfig,
  GroupToolPolicyConfig,
  ReplyPayload,
  RuntimeEnv,
} from "clawdbot/plugin-sdk";
import type { PluginRuntime } from "clawdbot/plugin-sdk";
import WebSocket from "ws";

import type { ResolvedOneBotAccount } from "./accounts.js";
import {
  loadOneBotAiKpContext,
  mergeOneBotGroupSystemPrompt,
  type OneBotAiKpContextState,
  resolveOneBotAiKpConfig,
} from "./ai-kp-context.js";
import { maybeHandleOneBotAiKpRuntime } from "./ai-kp-runtime.js";

type ChannelLog = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOneBotWsUrl(account: ResolvedOneBotAccount): string {
  if (account.wsUrl?.trim()) return account.wsUrl.trim();
  if (account.httpUrl?.trim()) {
    const http = account.httpUrl.trim();
    if (http.startsWith("http://")) return `ws://${http.slice("http://".length)}`;
    if (http.startsWith("https://")) return `wss://${http.slice("https://".length)}`;
  }
  throw new Error("OneBot requires channels.onebot.wsUrl (or httpUrl that can derive wsUrl)");
}

function buildPairingIdLine(senderId: string) {
  return `Your QQ id: ${senderId}`;
}

export async function monitorOneBotProvider(params: {
  account: ResolvedOneBotAccount;
  cfg: ClawdbotConfig;
  core: PluginRuntime;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  log?: ChannelLog;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  resolveGroupConfig: (groupId: string) => {
    requireMention: boolean;
    systemPrompt?: string;
    tools?: GroupToolPolicyConfig;
  };
  isAllowedSender: (senderId: string, allowFrom: Array<string | number> | undefined) => boolean;
  normalizeAllowFrom: (values: Array<string | number> | undefined) => string[];
  resolveMentionGatingWithBypass: typeof import("clawdbot/plugin-sdk").resolveMentionGatingWithBypass;
  extractTextAndMentions: (params: {
    message: unknown;
    selfId?: string | null;
  }) => { text: string; wasMentioned: boolean; hasAnyMention: boolean };
  sendText: (params: { target: string; text: string }) => Promise<{ messageId?: string }>;
}): Promise<void> {
  const { account, cfg, core, runtime, abortSignal, statusSink } = params;

  const logger = core.logging.getChildLogger({ module: "onebot" });
  const logVerbose = (message: string) => {
    if (!core.logging.shouldLogVerbose()) return;
    logger.debug?.(message);
  };

  const wsUrl = resolveOneBotWsUrl(account);
  let backoffMs = 1_000;

  const connectOnce = async (): Promise<void> => {
    const headers: Record<string, string> = {};
    if (account.accessToken) {
      headers.authorization = `Bearer ${account.accessToken}`;
    }

    const ws = new WebSocket(wsUrl, {
      headers,
    });

    const closeWs = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };

    const stop = () => closeWs();
    abortSignal.addEventListener("abort", stop, { once: true });

    const ready = new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });

    await ready;
    backoffMs = 1_000;
    params.log?.info?.(`[${account.accountId}] onebot ws connected`);

    const onMessage = (data: WebSocket.RawData) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      const evt = parsed as OneBotMessageEvent;
      if (evt.post_type !== "message") return;

      statusSink?.({ lastInboundAt: Date.now() });

      void processInboundMessage({
        evt,
        account,
        cfg,
        core,
        runtime,
        logVerbose,
        statusSink,
        helpers: params,
      }).catch((err) => {
        runtime.error?.(`onebot: inbound processing failed: ${String(err)}`);
      });
    };

    ws.on("message", onMessage);

    await new Promise<void>((resolve) => {
      const onClose = () => resolve();
      ws.once("close", onClose);
      ws.once("error", onClose);
      if (abortSignal.aborted) {
        closeWs();
        resolve();
      }
    });

    ws.off("message", onMessage);
    abortSignal.removeEventListener("abort", stop);
  };

  while (!abortSignal.aborted) {
    try {
      await connectOnce();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      params.log?.error?.(`[${account.accountId}] onebot ws error: ${message}`);
      logVerbose(`onebot: reconnect in ${backoffMs}ms`);
      await sleep(backoffMs);
      backoffMs = Math.min(30_000, backoffMs * 2);
    }
  }
}

async function processInboundMessage(params: {
  evt: OneBotMessageEvent;
  account: ResolvedOneBotAccount;
  cfg: ClawdbotConfig;
  core: PluginRuntime;
  runtime: RuntimeEnv;
  logVerbose: (message: string) => void;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  helpers: {
    resolveGroupConfig: (groupId: string) => {
      requireMention: boolean;
      systemPrompt?: string;
      tools?: GroupToolPolicyConfig;
    };
    isAllowedSender: (senderId: string, allowFrom: Array<string | number> | undefined) => boolean;
    normalizeAllowFrom: (values: Array<string | number> | undefined) => string[];
    resolveMentionGatingWithBypass: typeof import("clawdbot/plugin-sdk").resolveMentionGatingWithBypass;
    extractTextAndMentions: (params: {
      message: unknown;
      selfId?: string | null;
    }) => { text: string; wasMentioned: boolean; hasAnyMention: boolean };
    sendText: (params: { target: string; text: string }) => Promise<{ messageId?: string }>;
  };
}): Promise<void> {
  const { evt, account, cfg, core, runtime, logVerbose, statusSink, helpers } = params;
  const selfId = evt.self_id != null ? String(evt.self_id) : null;
  const senderId = evt.user_id != null ? String(evt.user_id) : "";
  if (!senderId) return;
  if (selfId && senderId === selfId) return;

  const isGroup = evt.message_type === "group" && evt.group_id != null;
  const groupId = isGroup ? String(evt.group_id) : null;

  const extracted = helpers.extractTextAndMentions({
    message: evt.message ?? evt.raw_message ?? "",
    selfId,
  });
  const rawBody = extracted.text;
  if (!rawBody.trim()) return;
  let aiKpContext: OneBotAiKpContextState | null = null;
  let effectiveWasMentioned = isGroup ? extracted.wasMentioned : true;
  let groupSystemPrompt: string | undefined;

  const onebotCfg = (cfg.channels as Record<string, unknown> | undefined)?.onebot as
    | {
        dmPolicy?: string;
        allowFrom?: Array<string | number>;
        groupPolicy?: string;
        groupAllowFrom?: Array<string | number>;
        groups?: Record<string, unknown>;
      }
    | undefined;

  const dmPolicy = (onebotCfg?.dmPolicy as string | undefined) ?? "pairing";
  const configAllowFrom = onebotCfg?.allowFrom ?? [];
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, cfg);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("onebot").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];

  const groupAllowFromConfigured = onebotCfg?.groupAllowFrom ?? [];
  const groupAllowFrom =
    groupAllowFromConfigured.length > 0
      ? groupAllowFromConfigured
      : effectiveAllowFrom.length > 0
        ? effectiveAllowFrom
        : [];

  const useAccessGroups = cfg.commands?.useAccessGroups !== false;
  const commandAllowFrom = isGroup ? groupAllowFrom : effectiveAllowFrom;
  const senderAllowedForCommands = helpers.isAllowedSender(senderId, commandAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (isGroup) {
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy =
      (onebotCfg?.groupPolicy as string | undefined) ?? defaultGroupPolicy ?? "allowlist";
    if (groupPolicy === "disabled") {
      logVerbose("onebot: drop group message (groupPolicy=disabled)");
      return;
    }
    if (groupPolicy === "allowlist") {
      if (groupAllowFrom.length === 0) {
        logVerbose("onebot: drop group message (groupPolicy=allowlist, no groupAllowFrom)");
        return;
      }
      if (!senderAllowedForCommands) {
        logVerbose(`onebot: drop group message (sender not allowed, user_id=${senderId})`);
        return;
      }
    }

    // Group allowlist by group id if groups config is present
    const groups = (onebotCfg?.groups ?? {}) as Record<string, unknown>;
    const groupAllowlistEnabled = Object.keys(groups).length > 0 && !Object.hasOwn(groups, "*");
    if (groupAllowlistEnabled && groupId && !Object.hasOwn(groups, groupId)) {
      logVerbose(`onebot: drop group message (group not allowlisted, group_id=${groupId})`);
      return;
    }

    const aiKpConfig = resolveOneBotAiKpConfig(cfg);
    const groupConfig = helpers.resolveGroupConfig(groupId ?? "");
    if (aiKpConfig.bypassMentionWhenActive) {
      aiKpContext = await loadOneBotAiKpContext({
        cfg,
        groupId,
        onError: logVerbose,
      });
    }
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg,
      surface: "onebot",
    });
    const mentionGate = helpers.resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention: groupConfig.requireMention,
      canDetectMention: true,
      wasMentioned: extracted.wasMentioned,
      implicitMention: Boolean(aiKpContext?.active && aiKpConfig.bypassMentionWhenActive),
      hasAnyMention: extracted.hasAnyMention,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, cfg),
      commandAuthorized: commandAuthorized === true,
    });
    if (mentionGate.shouldSkip) {
      logVerbose("onebot: drop group message (mention required)");
      return;
    }
    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    groupSystemPrompt = mergeOneBotGroupSystemPrompt([
      groupConfig.systemPrompt,
      aiKpContext?.active ? aiKpContext.promptBlock : undefined,
    ]);

    if (core.channel.commands.isControlCommandMessage(rawBody, cfg) && commandAuthorized !== true) {
      logVerbose(`onebot: drop control command from ${senderId}`);
      return;
    }

    const aiKpHandled = await maybeHandleOneBotAiKpRuntime({
      cfg,
      envelope: evt,
      wasMentioned: effectiveWasMentioned,
      isGroup: true,
      sendText: helpers.sendText,
      statusSink,
      onError: logVerbose,
    });
    if (aiKpHandled?.handled) {
      return;
    }

    aiKpContext =
      aiKpContext ??
      (await loadOneBotAiKpContext({
        cfg,
        groupId,
        onError: logVerbose,
      }));
    groupSystemPrompt = mergeOneBotGroupSystemPrompt([
      groupConfig.systemPrompt,
      aiKpContext?.active ? aiKpContext.promptBlock : undefined,
    ]);
  } else {
    if (dmPolicy === "disabled") return;
    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "onebot",
            id: senderId,
            meta: { name: resolveSenderName(evt) || undefined },
          });
          if (created) {
            logVerbose(`onebot pairing request sender=${senderId}`);
            try {
              await helpers.sendText({
                target: `user:${senderId}`,
                text: core.channel.pairing.buildPairingReply({
                  channel: "onebot",
                  idLine: buildPairingIdLine(senderId),
                  code,
                }),
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(`onebot: pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        }
        return;
      }
    }

    const aiKpHandled = await maybeHandleOneBotAiKpRuntime({
      cfg,
      envelope: evt,
      wasMentioned: true,
      isGroup: false,
      sendText: helpers.sendText,
      statusSink,
      onError: logVerbose,
    });
    if (aiKpHandled?.handled) {
      return;
    }
  }

  const peer = {
    kind: isGroup ? ("group" as const) : ("dm" as const),
    id: isGroup ? (groupId ?? senderId) : senderId,
  };

  const route = core.channel.routing.resolveAgentRoute({
    cfg,
    channel: "onebot",
    accountId: account.accountId,
    peer,
  });

  const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(cfg);
  const senderName = resolveSenderName(evt) || `user:${senderId}`;
  const groupLabel = groupId ? `group:${groupId}` : undefined;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "OneBot",
    from: senderName,
    timestamp: evt.time ? evt.time * 1000 : Date.now(),
    envelope: envelopeOptions,
    body: rawBody,
  });

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `onebot:user:${senderId}`,
    To: isGroup ? `onebot:group:${groupId}` : `onebot:user:${senderId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "group" : "direct",
    ConversationLabel: isGroup ? groupLabel : senderName,
    GroupSubject: isGroup ? groupLabel : undefined,
    GroupSystemPrompt: groupSystemPrompt,
    SenderName: senderName,
    SenderId: senderId,
    Provider: "onebot",
    Surface: "onebot",
    MessageSid: evt.message_id != null ? String(evt.message_id) : undefined,
    Timestamp: evt.time ? evt.time * 1000 : Date.now(),
    WasMentioned: effectiveWasMentioned,
    CommandAuthorized: commandAuthorized,
    OriginatingChannel: "onebot" as const,
    OriginatingTo: isGroup ? `group:${groupId}` : `user:${senderId}`,
  });

  await core.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    onRecordError: (err) => {
      runtime.error?.(`onebot: failed updating session meta: ${String(err)}`);
    },
  });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload: ReplyPayload) => {
        const text = payload.text ?? "";
        if (!text.trim()) return;
        const target = isGroup ? `group:${groupId}` : `user:${senderId}`;
        await helpers.sendText({ target, text });
        statusSink?.({ lastOutboundAt: Date.now() });
      },
    },
  });
}

function resolveSenderName(evt: OneBotMessageEvent): string | null {
  const sender = evt.sender ?? {};
  const name = sender.card?.trim() || sender.nickname?.trim();
  return name || null;
}
