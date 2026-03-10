import path from "node:path";

import { STATE_DIR_CLAWDBOT } from "../config/paths.js";
import { loadJsonFile, saveJsonFile } from "../infra/json-file.js";
import type { PhoneRunStatus, PhoneTrackedRunSummary } from "./types.js";

export type PhoneTrackedRunRecord = PhoneTrackedRunSummary & {
  waitTimeoutMs?: number;
};

type PersistedPhoneRunRegistry = {
  version: 1;
  runs: Record<string, PhoneTrackedRunRecord>;
};

const PHONE_RUN_REGISTRY_VERSION = 1 as const;
const PHONE_RUN_ARCHIVE_AFTER_MS = 12 * 60 * 60_000;
const MAX_COMPLETED_PHONE_RUNS = 50;
const shouldPersistPhoneRuns = process.env.NODE_ENV !== "test";
const trackedPhoneRuns = new Map<string, PhoneTrackedRunRecord>();
let trackedPhoneRunsRestored = false;

function resolvePhoneRunRegistryPath() {
  return path.join(STATE_DIR_CLAWDBOT, "phone", "runs.json");
}

function cloneTrackedPhoneRun(entry: PhoneTrackedRunRecord): PhoneTrackedRunRecord {
  return { ...entry };
}

function toTrackedPhoneRunSummary(entry: PhoneTrackedRunRecord): PhoneTrackedRunSummary {
  const { waitTimeoutMs: _waitTimeoutMs, ...summary } = entry;
  return summary;
}

function compareTrackedPhoneRuns(a: PhoneTrackedRunRecord, b: PhoneTrackedRunRecord) {
  if (a.completed !== b.completed) {
    return Number(a.completed) - Number(b.completed);
  }
  return b.updatedAt - a.updatedAt;
}

function pruneTrackedPhoneRuns(now = Date.now()) {
  for (const [runId, entry] of trackedPhoneRuns.entries()) {
    if (!entry.completed) continue;
    if (now - entry.updatedAt <= PHONE_RUN_ARCHIVE_AFTER_MS) continue;
    trackedPhoneRuns.delete(runId);
  }

  const completed = [...trackedPhoneRuns.entries()]
    .filter(([, entry]) => entry.completed)
    .sort((a, b) => b[1].updatedAt - a[1].updatedAt);
  for (const [runId] of completed.slice(MAX_COMPLETED_PHONE_RUNS)) {
    trackedPhoneRuns.delete(runId);
  }
}

function persistTrackedPhoneRuns() {
  if (!shouldPersistPhoneRuns) return;
  pruneTrackedPhoneRuns();
  const runs: Record<string, PhoneTrackedRunRecord> = {};
  for (const [runId, entry] of trackedPhoneRuns.entries()) {
    runs[runId] = cloneTrackedPhoneRun(entry);
  }
  saveJsonFile(resolvePhoneRunRegistryPath(), {
    version: PHONE_RUN_REGISTRY_VERSION,
    runs,
  } satisfies PersistedPhoneRunRegistry);
}

function restoreTrackedPhoneRunsOnce() {
  if (trackedPhoneRunsRestored) return;
  trackedPhoneRunsRestored = true;
  if (!shouldPersistPhoneRuns) return;

  const raw = loadJsonFile(resolvePhoneRunRegistryPath());
  if (!raw || typeof raw !== "object") return;
  const parsed = raw as Partial<PersistedPhoneRunRegistry>;
  if (parsed.version !== PHONE_RUN_REGISTRY_VERSION) return;
  if (!parsed.runs || typeof parsed.runs !== "object") return;

  for (const [runId, entry] of Object.entries(parsed.runs)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<PhoneTrackedRunRecord>;
    if (typeof record.runId !== "string" || !record.runId.trim()) continue;
    if (typeof record.accountId !== "string" || !record.accountId.trim()) continue;
    if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") continue;
    const status = record.status;
    if (
      status !== "accepted" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "stopped"
    ) {
      continue;
    }
    trackedPhoneRuns.set(runId, {
      runId,
      accountId: record.accountId,
      status,
      completed: record.completed === true,
      mode: record.mode,
      task: record.task,
      goal: record.goal,
      deviceId: record.deviceId,
      deviceType: record.deviceType,
      message: record.message,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      startedAt: typeof record.startedAt === "number" ? record.startedAt : undefined,
      endedAt: typeof record.endedAt === "number" ? record.endedAt : undefined,
      waitTimeoutMs: typeof record.waitTimeoutMs === "number" ? record.waitTimeoutMs : undefined,
    });
  }

  pruneTrackedPhoneRuns();
}

export function registerTrackedPhoneRun(entry: {
  runId: string;
  accountId: string;
  status: PhoneRunStatus;
  completed: boolean;
  mode?: PhoneTrackedRunRecord["mode"];
  task?: string;
  goal?: string;
  deviceId?: string;
  deviceType?: string;
  message?: string;
  createdAt?: number;
  startedAt?: number;
  endedAt?: number;
  waitTimeoutMs?: number;
}) {
  restoreTrackedPhoneRunsOnce();
  const now = Date.now();
  const existing = trackedPhoneRuns.get(entry.runId);
  const next: PhoneTrackedRunRecord = {
    runId: entry.runId,
    accountId: entry.accountId,
    status: entry.status,
    completed: entry.completed,
    mode: entry.mode ?? existing?.mode,
    task: entry.task ?? existing?.task,
    goal: entry.goal ?? existing?.goal,
    deviceId: entry.deviceId ?? existing?.deviceId,
    deviceType: entry.deviceType ?? existing?.deviceType,
    message: entry.message ?? existing?.message,
    createdAt: entry.createdAt ?? existing?.createdAt ?? now,
    updatedAt: now,
    startedAt: entry.startedAt ?? existing?.startedAt ?? now,
    endedAt: entry.endedAt ?? existing?.endedAt,
    waitTimeoutMs: entry.waitTimeoutMs ?? existing?.waitTimeoutMs,
  };
  if (next.completed && typeof next.endedAt !== "number") {
    next.endedAt = now;
  }
  trackedPhoneRuns.set(next.runId, next);
  persistTrackedPhoneRuns();
  return cloneTrackedPhoneRun(next);
}

export function updateTrackedPhoneRun(
  runId: string,
  patch: Partial<Omit<PhoneTrackedRunRecord, "runId" | "accountId" | "createdAt">>,
) {
  restoreTrackedPhoneRunsOnce();
  const current = trackedPhoneRuns.get(runId);
  if (!current) return undefined;
  const now = Date.now();
  const next: PhoneTrackedRunRecord = {
    ...current,
    ...patch,
    updatedAt: now,
  };
  if (next.completed && typeof next.endedAt !== "number") {
    next.endedAt = now;
  }
  trackedPhoneRuns.set(runId, next);
  persistTrackedPhoneRuns();
  return cloneTrackedPhoneRun(next);
}

export function getTrackedPhoneRunRecord(runId: string) {
  restoreTrackedPhoneRunsOnce();
  const entry = trackedPhoneRuns.get(runId);
  return entry ? cloneTrackedPhoneRun(entry) : undefined;
}

export function getTrackedPhoneRun(runId: string) {
  const entry = getTrackedPhoneRunRecord(runId);
  return entry ? toTrackedPhoneRunSummary(entry) : undefined;
}

export function listTrackedPhoneRunRecords(opts?: {
  accountId?: string;
  includeCompleted?: boolean;
  limit?: number;
}) {
  restoreTrackedPhoneRunsOnce();
  const includeCompleted = opts?.includeCompleted === true;
  const accountId = opts?.accountId?.trim();
  const limit = typeof opts?.limit === "number" && opts.limit > 0 ? Math.floor(opts.limit) : 0;
  const entries = [...trackedPhoneRuns.values()]
    .filter((entry) => (!accountId ? true : entry.accountId === accountId))
    .filter((entry) => (includeCompleted ? true : !entry.completed))
    .sort(compareTrackedPhoneRuns)
    .map(cloneTrackedPhoneRun);
  return limit > 0 ? entries.slice(0, limit) : entries;
}

export function listTrackedPhoneRuns(opts?: {
  accountId?: string;
  includeCompleted?: boolean;
  limit?: number;
}) {
  return listTrackedPhoneRunRecords(opts).map(toTrackedPhoneRunSummary);
}

export function resolveLatestActiveTrackedPhoneRun(accountId: string) {
  return listTrackedPhoneRunRecords({
    accountId,
    includeCompleted: false,
    limit: 1,
  })[0];
}

export function resetTrackedPhoneRunsForTests() {
  trackedPhoneRuns.clear();
  trackedPhoneRunsRestored = false;
}
