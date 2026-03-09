import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

export type PhoneManagerLike = {
  discover: (accountId?: string) => Promise<Record<string, unknown>>;
  run: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  wait: (request: Record<string, unknown>) => Promise<Record<string, unknown>>;
  stop: (request?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

async function loadCreatePhoneManager() {
  try {
    const mod = await import("../../../src/phone/manager.js");
    if (typeof mod.createPhoneManager === "function") return mod.createPhoneManager;
  } catch {}

  const mod = await import("../../../phone/manager.js");
  if (typeof mod.createPhoneManager !== "function") {
    throw new Error("createPhoneManager is unavailable");
  }
  return mod.createPhoneManager;
}

export async function createPhoneManager(config: ClawdbotConfig): Promise<PhoneManagerLike> {
  const createManager = await loadCreatePhoneManager();
  return createManager(config) as PhoneManagerLike;
}

export function readRuntimeEvents(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is Record<string, unknown> => isRecord(entry));
}

export function normalizeRuntimeEventType(event: Record<string, unknown>): string {
  const rawType = readOptionalString(event.type) ?? "unknown";
  return `runtime.${rawType.replace(/[^a-z0-9_.-]+/gi, "_").toLowerCase()}`;
}

export function buildRuntimeEventData(event: Record<string, unknown>) {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key === "type" || key === "message" || key === "ts") continue;
    data[key] = value;
  }
  return Object.keys(data).length > 0 ? data : undefined;
}
