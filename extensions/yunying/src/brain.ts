import crypto from "node:crypto";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../../src/config/sessions.js";
import { appendAssistantMessageToSessionTranscript } from "../../../src/config/sessions/transcript.js";
import { resolveAgentIdFromSessionKey } from "../../../src/routing/session-key.js";
import { readSessionMessages } from "../../../src/gateway/session-utils.js";

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function summarizeText(value: string, maxChars = 240) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  return normalized.length > maxChars ? `${normalized.slice(0, maxChars - 1)}…` : normalized;
}

function buildBrainLabel(deviceKey: string) {
  const suffix = encodeURIComponent(deviceKey).slice(-24);
  return `yunying-${suffix}`;
}

function extractMessageText(message: Record<string, unknown>) {
  const content = message.content;
  if (typeof content === "string") return summarizeText(content);
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"))
    .filter((entry) => entry.type === "text" && typeof entry.text === "string")
    .map((entry) => String(entry.text))
    .join(" ")
    .trim();
  return text ? summarizeText(text) : undefined;
}

export function defaultWorkerDisplayName(params: {
  displayName?: string;
  accountName?: string;
  deviceLabel?: string;
  deviceId?: string;
  accountId: string;
  deviceKey: string;
}) {
  return (
    trimOptionalString(params.displayName) ??
    trimOptionalString(params.accountName) ??
    trimOptionalString(params.deviceLabel) ??
    trimOptionalString(params.deviceId) ??
    trimOptionalString(params.accountId) ??
    params.deviceKey
  );
}

export async function ensureWorkerBrainSession(params: {
  config: ClawdbotConfig;
  sessionKey: string;
  displayName: string;
  subject?: string;
  accountId: string;
  deviceId?: string;
  deviceKey: string;
}) {
  const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const storePath = resolveStorePath(params.config.session?.store, { agentId });
  let nextEntry: SessionEntry | undefined;
  let created = false;
  await updateSessionStore(storePath, (store) => {
    const existing = store[params.sessionKey];
    created = !existing;
    nextEntry = {
      ...existing,
      sessionId: existing?.sessionId ?? crypto.randomUUID(),
      updatedAt: Date.now(),
      label: existing?.label ?? buildBrainLabel(params.deviceKey),
      displayName: params.displayName,
      subject: trimOptionalString(params.subject) ?? existing?.subject,
      sendPolicy: existing?.sendPolicy ?? "allow",
      origin: {
        ...(existing?.origin ?? {}),
        label: "Yunying Worker Brain",
        provider: "yunying",
        surface: "yunying",
        accountId: params.accountId,
        to: params.deviceId ?? params.deviceKey,
      },
      channel: existing?.channel ?? "yunying",
    };
    store[params.sessionKey] = nextEntry;
  });

  if (!nextEntry) {
    throw new Error(`Failed to initialize worker brain session ${params.sessionKey}`);
  }

  if (created) {
    const initialNote = [
      `手机脑已绑定：${params.displayName}`,
      `deviceKey=${params.deviceKey}`,
      params.subject ? `当前目标：${params.subject}` : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    await appendAssistantMessageToSessionTranscript({
      agentId,
      sessionKey: params.sessionKey,
      text: initialNote,
      storePath,
    });
  }

  return {
    agentId,
    storePath,
    entry: nextEntry,
  };
}

export async function appendWorkerBrainNote(params: {
  config: ClawdbotConfig;
  sessionKey: string;
  displayName: string;
  accountId: string;
  deviceId?: string;
  deviceKey: string;
  subject?: string;
  text: string;
}) {
  const ensured = await ensureWorkerBrainSession({
    config: params.config,
    sessionKey: params.sessionKey,
    displayName: params.displayName,
    accountId: params.accountId,
    deviceId: params.deviceId,
    deviceKey: params.deviceKey,
    subject: params.subject,
  });
  const text = summarizeText(params.text, 800);
  if (!text) return ensured;
  await appendAssistantMessageToSessionTranscript({
    agentId: ensured.agentId,
    sessionKey: params.sessionKey,
    text,
    storePath: ensured.storePath,
  });
  return ensured;
}

export async function readWorkerBrainPreview(params: {
  config: ClawdbotConfig;
  sessionKey?: string;
  limit?: number;
}) {
  const sessionKey = trimOptionalString(params.sessionKey);
  if (!sessionKey) return null;
  const agentId = resolveAgentIdFromSessionKey(sessionKey);
  const storePath = resolveStorePath(params.config.session?.store, { agentId });
  const store = loadSessionStore(storePath, { skipCache: true });
  const entry = store[sessionKey];
  if (!entry?.sessionId) return null;
  const messages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
  const last = [...messages]
    .reverse()
    .find((message): message is Record<string, unknown> => Boolean(message && typeof message === "object"));
  return {
    sessionId: entry.sessionId,
    label: entry.label,
    displayName: entry.displayName,
    subject: entry.subject,
    lastMessage: last ? extractMessageText(last) : undefined,
  };
}
