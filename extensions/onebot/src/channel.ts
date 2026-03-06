import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  missingTargetError,
  PAIRING_APPROVED_MESSAGE,
  resolveMentionGatingWithBypass,
  type ChannelAccountSnapshot,
  type ChannelPlugin,
  type ClawdbotConfig,
  type GroupToolPolicyConfig,
} from "clawdbot/plugin-sdk";

import {
  listOneBotAccountIds,
  resolveDefaultOneBotAccountId,
  resolveOneBotAccount,
  type ResolvedOneBotAccount,
} from "./accounts.js";
import { onebotChannelConfigSchema } from "./config-schema.js";
import {
  getOneBotLoginInfo,
  sendOneBotGroupMessage,
  sendOneBotPrivateMessage,
} from "./api.js";
import { extractOneBotTextAndMentions, normalizeOneBotTarget } from "./message.js";
import { monitorOneBotProvider } from "./monitor.js";
import { getOneBotRuntime } from "./runtime.js";

const meta = {
  id: "onebot",
  label: "OneBot",
  selectionLabel: "QQ (OneBot)",
  docsPath: "/channels/onebot",
  docsLabel: "onebot",
  blurb: "QQ via OneBot bridges (works with NapCat); configure WS/HTTP endpoints.",
  order: 110,
  quickstartAllowFrom: true,
};

function normalizeAllowFromEntry(raw: string): string {
  return raw
    .replace(/^onebot:/i, "")
    .replace(/^qq:/i, "")
    .replace(/^(user|private|dm):/i, "")
    .trim();
}

function normalizeAllowFrom(values: Array<string | number> | undefined): string[] {
  const list = Array.isArray(values) ? values : [];
  return list
    .map((entry) => normalizeAllowFromEntry(String(entry)))
    .filter((entry) => entry && entry !== "*");
}

function isAllowedSender(senderId: string, allowFrom: Array<string | number> | undefined): boolean {
  const list = Array.isArray(allowFrom) ? allowFrom : [];
  if (list.some((entry) => String(entry).trim() === "*")) return true;
  return normalizeAllowFrom(list).includes(senderId);
}

function resolveOneBotGroupConfig(params: {
  cfg: ClawdbotConfig;
  groupId?: string | null;
}): { requireMention: boolean; tools?: GroupToolPolicyConfig } {
  const raw = (params.cfg.channels as Record<string, unknown> | undefined)?.onebot as
    | { groups?: Record<string, { requireMention?: boolean; tools?: GroupToolPolicyConfig }> }
    | undefined;
  const groups = raw?.groups ?? {};
  const groupId = params.groupId?.trim() ?? "";
  const entry = (groupId && groups[groupId]) || groups["*"] || {};
  return {
    requireMention: typeof entry.requireMention === "boolean" ? entry.requireMention : true,
    tools: entry.tools,
  };
}

async function sendOneBotText(params: {
  account: ResolvedOneBotAccount;
  target: string;
  text: string;
}): Promise<{ messageId?: string }> {
  const normalized = normalizeOneBotTarget(params.target);
  if (!normalized) {
    throw missingTargetError("OneBot", "<user:123|group:456>");
  }
  const httpUrl = params.account.httpUrl;
  if (!httpUrl) {
    throw new Error("OneBot requires channels.onebot.httpUrl (or wsUrl that can derive httpUrl)");
  }

  const timeoutMs = params.account.apiTimeoutMs;
  if (normalized.kind === "user") {
    const res = await sendOneBotPrivateMessage({
      httpUrl,
      accessToken: params.account.accessToken,
      timeoutMs,
      userId: normalized.id,
      message: params.text,
    });
    return { messageId: res.message_id != null ? String(res.message_id) : undefined };
  }

  const res = await sendOneBotGroupMessage({
    httpUrl,
    accessToken: params.account.accessToken,
    timeoutMs,
    groupId: normalized.id,
    message: params.text,
  });
  return { messageId: res.message_id != null ? String(res.message_id) : undefined };
}

export const onebotPlugin: ChannelPlugin<ResolvedOneBotAccount> = {
  id: "onebot",
  meta,
  capabilities: {
    chatTypes: ["direct", "group"],
    media: false,
  },
  reload: { configPrefixes: ["channels.onebot"] },
  configSchema: onebotChannelConfigSchema,
  config: {
    listAccountIds: (cfg) => listOneBotAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveOneBotAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultOneBotAccountId(cfg),
    isConfigured: (account) => Boolean(account.wsUrl || account.httpUrl),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.wsUrl || account.httpUrl),
      httpUrl: account.httpUrl,
      wsUrl: account.wsUrl,
    }),
    resolveAllowFrom: ({ cfg }) => {
      const raw = ((cfg.channels as Record<string, unknown> | undefined)?.onebot as
        | { allowFrom?: unknown[] }
        | undefined)?.allowFrom;
      return (raw ?? []).map((entry) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => normalizeAllowFromEntry(String(entry)))
        .filter(Boolean),
  },
  pairing: {
    idLabel: "qqUserId",
    normalizeAllowEntry: (entry) => normalizeAllowFromEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveOneBotAccount({ cfg, accountId: DEFAULT_ACCOUNT_ID });
      await sendOneBotText({
        account,
        target: `user:${id}`,
        text: PAIRING_APPROVED_MESSAGE,
      });
    },
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dmPolicy ?? "pairing",
      allowFrom: account.config.allowFrom ?? [],
      policyPath: "channels.onebot.dmPolicy",
      allowFromPath: "channels.onebot.allowFrom",
      approveHint: formatPairingApproveHint("onebot"),
      normalizeEntry: (raw) => normalizeAllowFromEntry(raw),
    }),
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        "- OneBot groups: groupPolicy=\"open\" allows any group to trigger (mention-gated). Set channels.onebot.groupPolicy=\"allowlist\" + channels.onebot.groupAllowFrom and/or channels.onebot.groups to restrict.",
      ];
    },
  },
  groups: {
    resolveRequireMention: ({ cfg, groupId }) =>
      resolveOneBotGroupConfig({ cfg, groupId }).requireMention,
    resolveToolPolicy: ({ cfg, groupId }) => resolveOneBotGroupConfig({ cfg, groupId }).tools,
  },
  messaging: {
    normalizeTarget: (raw) => {
      const normalized = normalizeOneBotTarget(raw);
      return normalized ? `${normalized.kind}:${normalized.id}` : undefined;
    },
    targetResolver: {
      looksLikeId: (raw) => Boolean(normalizeOneBotTarget(raw)),
      hint: "<user:123|group:456>",
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getOneBotRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 2000,
    resolveTarget: ({ to, allowFrom, mode }) => {
      const trimmed = to?.trim() ?? "";
      const allowList = normalizeAllowFrom(allowFrom);

      if (trimmed) {
        const normalized = normalizeOneBotTarget(trimmed);
        if (!normalized) {
          if ((mode === "implicit" || mode === "heartbeat") && allowList.length > 0) {
            return { ok: true, to: `user:${allowList[0]}` };
          }
          return {
            ok: false,
            error: missingTargetError("OneBot", "<user:123|group:456>"),
          };
        }
        return { ok: true, to: `${normalized.kind}:${normalized.id}` };
      }

      if (allowList.length > 0) {
        return { ok: true, to: `user:${allowList[0]}` };
      }
      return {
        ok: false,
        error: missingTargetError("OneBot", "<user:123|group:456>"),
      };
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveOneBotAccount({ cfg: cfg as ClawdbotConfig, accountId });
      const result = await sendOneBotText({ account, target: to, text });
      return {
        channel: "onebot",
        messageId: result.messageId ?? "",
      };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveOneBotAccount({ cfg: cfg as ClawdbotConfig, accountId });
      const combined = [text?.trim(), mediaUrl?.trim()].filter(Boolean).join("\n");
      const result = await sendOneBotText({ account, target: to, text: combined });
      return {
        channel: "onebot",
        messageId: result.messageId ?? "",
      };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
      lastInboundAt: null,
      lastOutboundAt: null,
    } satisfies ChannelAccountSnapshot,
    probeAccount: async ({ account, timeoutMs }) => {
      const httpUrl = account.httpUrl;
      if (!httpUrl) throw new Error("OneBot probe requires httpUrl");
      return await getOneBotLoginInfo({
        httpUrl,
        accessToken: account.accessToken,
        timeoutMs,
      });
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.wsUrl || account.httpUrl),
      httpUrl: account.httpUrl,
      wsUrl: account.wsUrl,
      selfId: (probe as { user_id?: number } | undefined)?.user_id ?? null,
      selfName: (probe as { nickname?: string } | undefined)?.nickname ?? null,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
    }),
    collectStatusIssues: (accounts: ChannelAccountSnapshot[]) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) return [];
        return [
          {
            channel: "onebot",
            accountId: account.accountId,
            kind: "runtime" as const,
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        httpUrl: account.httpUrl,
        wsUrl: account.wsUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (onebot)`);

      const core = getOneBotRuntime();
      const statusSink = (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => {
        ctx.setStatus({ ...patch });
      };

      return await monitorOneBotProvider({
        account,
        cfg: ctx.cfg as ClawdbotConfig,
        core,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        log: ctx.log,
        statusSink,
        resolveGroupConfig: (groupId) => resolveOneBotGroupConfig({ cfg: ctx.cfg, groupId }),
        isAllowedSender,
        normalizeAllowFrom,
        resolveMentionGatingWithBypass,
        extractTextAndMentions: extractOneBotTextAndMentions,
        sendText: async ({ target, text }) => {
          const tableMode = core.channel.text.resolveMarkdownTableMode({
            cfg: ctx.cfg as ClawdbotConfig,
            channel: "onebot",
            accountId: account.accountId,
          });
          const normalizedText = core.channel.text.convertMarkdownTables(text, tableMode);
          const res = await sendOneBotText({ account, target, text: normalizedText });
          statusSink({ lastOutboundAt: Date.now() });
          return res;
        },
      });
    },
  },
};
