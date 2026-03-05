import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "clawdbot/plugin-sdk";

import type { OneBotConfig } from "./config-schema.js";

export type ResolvedOneBotAccount = {
  accountId: string;
  name?: string;
  enabled: boolean;
  configured: boolean;
  httpUrl?: string;
  wsUrl?: string;
  accessToken?: string;
  apiTimeoutMs?: number;
  config: OneBotConfig;
};

function resolveRawOneBotConfig(cfg: ClawdbotConfig): OneBotConfig | undefined {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return channels?.onebot as OneBotConfig | undefined;
}

function deriveWsUrlFromHttp(httpUrl: string): string | undefined {
  const trimmed = httpUrl.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("http://")) return `ws://${trimmed.slice("http://".length)}`;
  if (trimmed.startsWith("https://")) return `wss://${trimmed.slice("https://".length)}`;
  return undefined;
}

function deriveHttpUrlFromWs(wsUrl: string): string | undefined {
  const trimmed = wsUrl.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("ws://")) return `http://${trimmed.slice("ws://".length)}`;
  if (trimmed.startsWith("wss://")) return `https://${trimmed.slice("wss://".length)}`;
  return undefined;
}

export function listOneBotAccountIds(cfg: ClawdbotConfig): string[] {
  const onebotCfg = resolveRawOneBotConfig(cfg);
  if (!onebotCfg) return [];
  const hasAnyUrl = Boolean(onebotCfg.wsUrl?.trim() || onebotCfg.httpUrl?.trim());
  return hasAnyUrl ? [DEFAULT_ACCOUNT_ID] : [];
}

export function resolveDefaultOneBotAccountId(cfg: ClawdbotConfig): string {
  const ids = listOneBotAccountIds(cfg);
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

export function resolveOneBotAccount(opts: {
  cfg: ClawdbotConfig;
  accountId?: string | null;
}): ResolvedOneBotAccount {
  const accountId = opts.accountId ?? DEFAULT_ACCOUNT_ID;
  const raw = resolveRawOneBotConfig(opts.cfg) ?? {};
  const enabled = raw.enabled !== false;
  const httpUrl = raw.httpUrl?.trim() || deriveHttpUrlFromWs(raw.wsUrl ?? "");
  const wsUrl = raw.wsUrl?.trim() || deriveWsUrlFromHttp(raw.httpUrl ?? "");
  const configured = Boolean(wsUrl?.trim() || httpUrl?.trim());

  return {
    accountId,
    name: raw.name?.trim() || undefined,
    enabled,
    configured,
    httpUrl: httpUrl?.trim() || undefined,
    wsUrl: wsUrl?.trim() || undefined,
    accessToken: raw.accessToken?.trim() || undefined,
    apiTimeoutMs: raw.apiTimeoutMs,
    config: raw,
  };
}

