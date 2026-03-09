import { randomUUID } from "node:crypto";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { classifyFailoverReason, isLikelyContextOverflowError } from "../../../src/agents/pi-embedded-helpers.js";

import {
  buildStageTask,
  type YunyingStage,
  type YunyingSkill,
} from "./skill.js";
import {
  buildRuntimeEventData,
  createPhoneManager,
  normalizeRuntimeEventType,
  type PhoneManagerLike,
  readRuntimeEvents,
} from "./runtime.js";
import { appendWorkerBrainNote } from "./brain.js";
import { resolveWorkerSessionKey } from "./worker-session.js";
import {
  appendJobLog,
  type DeviceState,
  type JobRecovery,
  type JobSummary,
  listDeviceStates,
  readDeviceState,
  readJob,
  readStageArtifact,
  type JobState,
  type StageArtifact,
  type WorkerState,
  readWorkerState,
  writeDeviceState,
  writeJob,
  writeJobSummaryArtifact,
  writeStageArtifact,
  writeWorkerState,
} from "./store.js";

export type PhoneMode = "direct" | "monitor";

export type PluginConfig = {
  skillsDir?: string;
  defaultAccountId?: string;
  defaultMode?: PhoneMode;
  defaultWaitTimeoutMs?: number;
  maxLogEntries?: number;
  autoResumeEnabled?: boolean;
  autoResumeDelayMs?: number;
  autoResumeMaxDelayMs?: number;
  autoResumeMaxAttempts?: number;
  supervisorPollMs?: number;
};

export type ActiveRun = {
  jobId: string;
  accountId: string;
  deviceKey: string;
  abortController: AbortController;
  promise: Promise<void>;
  termination?: {
    status: "stopped" | "replaced";
    message?: string;
  };
};

const ACTIVE_RUNS = new Map<string, ActiveRun>();

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildWorkerId(deviceKey: string) {
  return `worker:${deviceKey}`;
}

function resolveWaitTimeoutMs(skill: YunyingSkill, pluginConfig: PluginConfig) {
  return skill.defaults?.waitTimeoutMs ?? pluginConfig.defaultWaitTimeoutMs ?? 180_000;
}

function resolveRepeatIntervalMs(skill: YunyingSkill) {
  return typeof skill.defaults?.repeatIntervalMs === "number" && skill.defaults.repeatIntervalMs > 0
    ? skill.defaults.repeatIntervalMs
    : undefined;
}

function isAutoResumeEnabled(pluginConfig: PluginConfig) {
  return pluginConfig.autoResumeEnabled !== false;
}

function resolveAutoResumeDelayMs(pluginConfig: PluginConfig) {
  return pluginConfig.autoResumeDelayMs ?? 5_000;
}

function resolveAutoResumeMaxDelayMs(pluginConfig: PluginConfig) {
  return pluginConfig.autoResumeMaxDelayMs ?? 5 * 60_000;
}

function resolveAutoResumeMaxAttempts(pluginConfig: PluginConfig) {
  return pluginConfig.autoResumeMaxAttempts ?? 12;
}

function formatDelaySummary(delayMs: number) {
  if (delayMs < 1000) return `${delayMs}ms`;
  if (delayMs % 60_000 === 0) return `${delayMs / 60_000}m`;
  return `${Math.ceil(delayMs / 1000)}s`;
}

function computeAutoResumeDelayMs(pluginConfig: PluginConfig, attempt: number) {
  const baseDelayMs = Math.max(1_000, resolveAutoResumeDelayMs(pluginConfig));
  const maxDelayMs = Math.max(baseDelayMs, resolveAutoResumeMaxDelayMs(pluginConfig));
  return Math.min(baseDelayMs * 2 ** Math.max(0, attempt - 1), maxDelayMs);
}

function isLikelyTransientRuntimeError(message?: string) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("temporarily unavailable") ||
    lower.includes("service unavailable") ||
    lower.includes("gateway timeout") ||
    lower.includes("timed out") ||
    lower.includes("timeout") ||
    lower.includes("overloaded") ||
    lower.includes("connection reset") ||
    lower.includes("socket hang up") ||
    lower.includes("econnreset") ||
    lower.includes("eai_again") ||
    lower.includes("network error") ||
    lower.includes("upstream")
  );
}

function shouldAutoResumeFailure(params: {
  pluginConfig: PluginConfig;
  message?: string;
  recovery?: JobRecovery;
}) {
  if (!isAutoResumeEnabled(params.pluginConfig)) return false;
  if (params.recovery?.action === "stale_failed") return true;
  if (isLikelyContextOverflowError(params.message)) return true;
  const reason = params.message ? classifyFailoverReason(params.message) : null;
  if (reason === "rate_limit" || reason === "timeout") return true;
  if (reason === "auth" || reason === "billing" || reason === "format") return false;
  return isLikelyTransientRuntimeError(params.message);
}

async function buildFailedWorkerPatch(params: {
  root: string;
  job: JobState;
  accountId: string;
  deviceId?: string;
  desiredGoal?: string;
  message?: string;
  pluginConfig: PluginConfig;
  recovery?: JobRecovery;
}) {
  const worker = await readOrCreateWorkerState({
    root: params.root,
    deviceKey: params.job.deviceKey,
    accountId: params.accountId,
    deviceId: params.deviceId,
    desiredGoal: params.desiredGoal ?? params.job.goal,
  });
  const retryable = shouldAutoResumeFailure({
    pluginConfig: params.pluginConfig,
    message: params.message,
    recovery: params.recovery,
  });
  if (!retryable) {
    return {
      state: params.recovery?.action === "stale_failed" ? ("recovering" as const) : ("failed" as const),
      activeJobId: undefined,
      currentStageId: undefined,
      currentStageName: undefined,
      desiredGoal: params.desiredGoal ?? params.job.goal,
      progressSummary:
        params.message ??
        (params.recovery?.action === "stale_failed"
          ? "Recovered stale worker state after restart"
          : "Job failed"),
      lastError: params.message,
      lastHeartbeatAt: nowIso(),
      lastCheckpointAt: nowIso(),
      nextWakeAt: undefined,
      resumeSourceJobId: undefined,
      resumeAttempts: 0,
    } satisfies Partial<WorkerState>;
  }

  const previousAttempts =
    worker.resumeSourceJobId === params.job.jobId ? Math.max(0, worker.resumeAttempts ?? 0) : 0;
  const nextAttempt = previousAttempts + 1;
  const maxAttempts = resolveAutoResumeMaxAttempts(params.pluginConfig);
  if (nextAttempt > maxAttempts) {
    return {
      state: "failed",
      activeJobId: undefined,
      currentStageId: undefined,
      currentStageName: undefined,
      desiredGoal: params.desiredGoal ?? params.job.goal,
      progressSummary: `Auto-resume paused after ${previousAttempts} attempts`,
      lastError: params.message,
      lastHeartbeatAt: nowIso(),
      lastCheckpointAt: nowIso(),
      nextWakeAt: undefined,
      resumeSourceJobId: undefined,
      resumeAttempts: previousAttempts,
    } satisfies Partial<WorkerState>;
  }

  const delayMs = computeAutoResumeDelayMs(params.pluginConfig, nextAttempt);
  return {
    state: "recovering",
    activeJobId: undefined,
    currentStageId: undefined,
    currentStageName: undefined,
    desiredGoal: params.desiredGoal ?? params.job.goal,
    progressSummary: `Auto-resume scheduled in ${formatDelaySummary(delayMs)}`,
    lastError: params.message,
    lastHeartbeatAt: nowIso(),
    lastCheckpointAt: nowIso(),
    nextWakeAt: new Date(Date.now() + delayMs).toISOString(),
    resumeSourceJobId: params.job.jobId,
    resumeAttempts: nextAttempt,
  } satisfies Partial<WorkerState>;
}

function toDeviceState(
  device: DeviceState,
  overrides: Partial<DeviceState>,
): DeviceState {
  return {
    ...device,
    ...overrides,
    updatedAt: nowIso(),
  };
}

function toWorkerState(
  worker: WorkerState,
  overrides: Partial<WorkerState>,
): WorkerState {
  return {
    ...worker,
    ...overrides,
    updatedAt: nowIso(),
  };
}

function resolveTotalStageCount(job: JobState, explicitTotalStageCount?: number) {
  return explicitTotalStageCount ?? job.summary?.totalStageCount;
}

function buildJobSummary(
  job: JobState,
  explicitTotalStageCount?: number,
  recovery?: JobRecovery,
): JobSummary {
  return {
    status: job.status,
    message: job.error,
    updatedAt: job.updatedAt,
    totalStageCount: resolveTotalStageCount(job, explicitTotalStageCount),
    completedStageCount: job.completedStages.length,
    currentStageId: job.currentStageId,
    currentStageName: job.currentStageName,
    lastRunId: job.lastRunId ?? job.currentRunId,
    recoveryAction: recovery?.action ?? job.recovery?.action,
  };
}

function withSummary(job: JobState, explicitTotalStageCount?: number, recovery?: JobRecovery): JobState {
  return {
    ...job,
    summary: buildJobSummary(job, explicitTotalStageCount, recovery),
    recovery: recovery ?? job.recovery,
  };
}

async function writeTrackedJob(root: string, job: JobState, explicitTotalStageCount?: number) {
  const tracked = withSummary(job, explicitTotalStageCount);
  await writeJob(root, tracked);
  if (tracked.summary) {
    await writeJobSummaryArtifact(root, tracked.jobId, tracked.summary);
  }
}

async function writeTrackedRecoveredJob(
  root: string,
  job: JobState,
  recovery: JobRecovery,
  explicitTotalStageCount?: number,
) {
  const tracked = withSummary(job, explicitTotalStageCount, recovery);
  await writeJob(root, tracked);
  if (tracked.summary) {
    await writeJobSummaryArtifact(root, tracked.jobId, tracked.summary);
  }
}

async function upsertStageArtifact(params: {
  root: string;
  jobId: string;
  stage?: YunyingStage;
  stageId?: string;
  stageName?: string;
  patch: Partial<StageArtifact> & Pick<StageArtifact, "status">;
}) {
  const stageId = params.stage?.id ?? params.stageId;
  if (!stageId) return;

  const existing = await readStageArtifact(params.root, params.jobId, stageId);
  const timestamp = nowIso();
  const artifact: StageArtifact = {
    jobId: params.jobId,
    stageId,
    stageName: params.stage?.name ?? params.stageName ?? existing?.stageName,
    status: params.patch.status,
    startedAt: existing?.startedAt ?? timestamp,
    updatedAt: timestamp,
    objective: params.stage?.objective ?? existing?.objective,
    actions: params.stage?.actions ?? existing?.actions,
    completionCriteria: params.stage?.completionCriteria ?? existing?.completionCriteria,
    runId: params.patch.runId ?? existing?.runId,
    runtimeStatus: params.patch.runtimeStatus ?? existing?.runtimeStatus,
    runtimeEventCount: params.patch.runtimeEventCount ?? existing?.runtimeEventCount,
    runtimeEventTypes: params.patch.runtimeEventTypes ?? existing?.runtimeEventTypes,
    message: params.patch.message ?? existing?.message,
    completedAt: params.patch.completedAt ?? existing?.completedAt,
  };
  if (
    !artifact.completedAt &&
    (artifact.status === "completed" ||
      artifact.status === "failed" ||
      artifact.status === "stopped" ||
      artifact.status === "replaced" ||
      artifact.status === "recovered_stale")
  ) {
    artifact.completedAt = timestamp;
  }
  await writeStageArtifact(params.root, artifact);
}

async function readOrCreateWorkerState(params: {
  root: string;
  deviceKey: string;
  accountId: string;
  deviceId?: string;
  desiredGoal?: string;
  displayName?: string;
}) {
  const existing = await readWorkerState(params.root, params.deviceKey);
  if (existing) {
    const workerSessionKey = resolveWorkerSessionKey({
      deviceKey: params.deviceKey,
      workerSessionKey: existing.workerSessionKey,
    });
    const resolvedDeviceId = params.deviceId ?? existing.deviceId;
    const resolvedDesiredGoal = params.desiredGoal ?? existing.desiredGoal;
    const resolvedDisplayName = existing.displayName ?? params.displayName;
    // Backfill legacy workers in-place so one device keeps one stable session identity over time.
    const needsWrite =
      existing.workerSessionKey !== workerSessionKey ||
      existing.accountId !== params.accountId ||
      existing.deviceId !== resolvedDeviceId ||
      existing.desiredGoal !== resolvedDesiredGoal ||
      existing.displayName !== resolvedDisplayName;
    if (!needsWrite) return existing;

    const hydrated = toWorkerState(existing, {
      accountId: params.accountId,
      deviceId: resolvedDeviceId,
      desiredGoal: resolvedDesiredGoal,
      displayName: resolvedDisplayName,
      workerSessionKey,
    });
    await writeWorkerState(params.root, hydrated);
    return hydrated;
  }

  const initial: WorkerState = {
    workerId: buildWorkerId(params.deviceKey),
    deviceKey: params.deviceKey,
    accountId: params.accountId,
    deviceId: params.deviceId,
    displayName: params.displayName,
    workerSessionKey: resolveWorkerSessionKey({ deviceKey: params.deviceKey }),
    state: "idle",
    desiredGoal: params.desiredGoal,
    progressSummary: "Worker registered",
    updatedAt: nowIso(),
  };
  await writeWorkerState(params.root, initial);
  return initial;
}

export async function ensureWorkerState(params: {
  root: string;
  deviceKey: string;
  accountId: string;
  deviceId?: string;
  desiredGoal?: string;
  displayName?: string;
}) {
  return await readOrCreateWorkerState(params);
}

export async function writeWorkerProgress(params: {
  root: string;
  deviceKey: string;
  accountId: string;
  deviceId?: string;
  displayName?: string;
  patch: Partial<WorkerState>;
}) {
  const worker = await readOrCreateWorkerState({
    root: params.root,
    deviceKey: params.deviceKey,
    accountId: params.accountId,
    deviceId: params.deviceId,
    desiredGoal: params.patch.desiredGoal,
    displayName: params.displayName ?? params.patch.displayName,
  });
  const next = toWorkerState(worker, params.patch);
  await writeWorkerState(params.root, next);
  return next;
}

async function finalizeJob(params: {
  root: string;
  activeRun: ActiveRun;
  deviceState: DeviceState;
  nextStatus: JobState["status"];
  error?: string;
  totalStageCount?: number;
  desiredGoal?: string;
  pluginConfig: PluginConfig;
  skill: YunyingSkill;
  config: ClawdbotConfig;
  displayName?: string;
}) {
  const job = await readJob(params.root, params.activeRun.jobId);
  if (!job) return;

  const status = params.activeRun.termination?.status ?? params.nextStatus;
  const message = params.activeRun.termination?.message ?? params.error;
  const updatedJob: JobState = {
    ...job,
    status,
    updatedAt: nowIso(),
    error: message,
    currentStageId: undefined,
    currentStageName: undefined,
    currentRunId: undefined,
  };
  await writeTrackedJob(params.root, updatedJob, params.totalStageCount);
  await appendJobLog(params.root, updatedJob.jobId, {
    ts: nowIso(),
    type: `job.${status}`,
    message,
  });
  await writeDeviceState(
    params.root,
    toDeviceState(params.deviceState, {
      activeJobId: undefined,
      activeRunId: undefined,
      state: status === "completed" ? "idle" : status === "failed" ? "failed" : "stopped",
    }),
  );
  const repeatIntervalMs = resolveRepeatIntervalMs(params.skill);
  const completedWorkerPatch =
    status === "completed" && repeatIntervalMs
      ? {
          state: "idle" as const,
          activeJobId: undefined,
          currentStageId: undefined,
          currentStageName: undefined,
          desiredGoal: params.desiredGoal ?? job.goal,
          progressSummary: `Job completed; next wake in ${formatDelaySummary(repeatIntervalMs)}`,
          lastError: undefined,
          lastHeartbeatAt: nowIso(),
          lastCheckpointAt: nowIso(),
          nextWakeAt: new Date(Date.now() + repeatIntervalMs).toISOString(),
          resumeSourceJobId: undefined,
          resumeAttempts: 0,
        }
      : null;
  const failedWorkerPatch =
    status === "failed"
      ? await buildFailedWorkerPatch({
          root: params.root,
          job,
          accountId: params.activeRun.accountId,
          deviceId: params.deviceState.deviceId,
          desiredGoal: params.desiredGoal ?? job.goal,
          message,
          pluginConfig: params.pluginConfig,
        })
      : null;
  await writeWorkerProgress({
    root: params.root,
    deviceKey: params.activeRun.deviceKey,
    accountId: params.activeRun.accountId,
    deviceId: params.deviceState.deviceId,
    patch: {
      boundSkillId: params.skill.id,
      boundSkillName: params.skill.name,
      scheduleIntervalMs: repeatIntervalMs,
      ...(completedWorkerPatch ??
        failedWorkerPatch ?? {
          state: status === "completed" ? "idle" : "stopped",
          activeJobId: undefined,
          currentStageId: undefined,
          currentStageName: undefined,
          desiredGoal: params.desiredGoal ?? job.goal,
          progressSummary: message ?? `Job ${status}`,
          lastError: undefined,
          lastHeartbeatAt: nowIso(),
          lastCheckpointAt: nowIso(),
          nextWakeAt: undefined,
          resumeSourceJobId: undefined,
          resumeAttempts: 0,
        }),
    },
  });
  await appendWorkerBrainNote({
    config: params.config,
    sessionKey: job.deviceKey ? resolveWorkerSessionKey({ deviceKey: job.deviceKey }) : params.activeRun.deviceKey,
    displayName: params.displayName ?? job.deviceId ?? job.accountId,
    accountId: params.activeRun.accountId,
    deviceId: params.deviceState.deviceId,
    deviceKey: params.activeRun.deviceKey,
    subject: params.desiredGoal ?? job.goal,
    text:
      completedWorkerPatch?.progressSummary ??
      failedWorkerPatch?.progressSummary ??
      (message ? `任务结束：${status} - ${message}` : `任务结束：${status}`),
  }).catch(() => {});
}

async function markJobFailedBeforeLaunch(params: {
  root: string;
  job: JobState;
  deviceState: DeviceState;
  error: string;
  totalStageCount?: number;
  pluginConfig: PluginConfig;
  skill: YunyingSkill;
  config: ClawdbotConfig;
  displayName?: string;
}) {
  await writeTrackedJob(params.root, {
    ...params.job,
    status: "failed",
    error: params.error,
    currentStageId: undefined,
    currentStageName: undefined,
    currentRunId: undefined,
    updatedAt: nowIso(),
  }, params.totalStageCount);
  await appendJobLog(params.root, params.job.jobId, {
    ts: nowIso(),
    type: "job.failed",
    message: params.error,
  });
  await writeDeviceState(
    params.root,
    toDeviceState(params.deviceState, {
      activeJobId: undefined,
      activeRunId: undefined,
      state: "failed",
    }),
  );
  const failedPatch = await buildFailedWorkerPatch({
    root: params.root,
    job: params.job,
    accountId: params.job.accountId,
    deviceId: params.job.deviceId,
    desiredGoal: params.job.goal,
    message: params.error,
    pluginConfig: params.pluginConfig,
  });
  await writeWorkerProgress({
    root: params.root,
    deviceKey: params.job.deviceKey,
    accountId: params.job.accountId,
    deviceId: params.job.deviceId,
    patch: {
      boundSkillId: params.skill.id,
      boundSkillName: params.skill.name,
      scheduleIntervalMs: resolveRepeatIntervalMs(params.skill),
      ...failedPatch,
    },
  });
  await appendWorkerBrainNote({
    config: params.config,
    sessionKey: resolveWorkerSessionKey({ deviceKey: params.job.deviceKey }),
    displayName: params.displayName ?? params.job.deviceId ?? params.job.accountId,
    accountId: params.job.accountId,
    deviceId: params.job.deviceId,
    deviceKey: params.job.deviceKey,
    subject: params.job.goal,
    text: `任务启动失败：${params.error}`,
  }).catch(() => {});
}

export function getActiveRun(deviceKey: string) {
  return ACTIVE_RUNS.get(deviceKey);
}

export async function reconcileStaleJobs(root: string, pluginConfig: PluginConfig = {}) {
  const devices = await listDeviceStates(root);
  for (const device of devices) {
    if (!device.activeJobId) continue;
    const activeRun = ACTIVE_RUNS.get(device.deviceKey);
    if (activeRun?.jobId === device.activeJobId) continue;

    const job = await readJob(root, device.activeJobId);
    if (job && (job.status === "accepted" || job.status === "running")) {
      const recovery: JobRecovery = {
        recoveredAt: nowIso(),
        action: "stale_failed",
        message: "Recovered stale yunying job after process restart",
        previousStatus: job.status,
        previousRunId: job.currentRunId,
      };
      await writeTrackedRecoveredJob(root, {
        ...job,
        status: "failed",
        error: "Recovered stale yunying job after process restart",
        currentStageId: undefined,
        currentStageName: undefined,
        currentRunId: undefined,
        updatedAt: nowIso(),
      }, recovery);
      await appendJobLog(root, job.jobId, {
        ts: nowIso(),
        type: "job.recovered_stale",
        message: "Recovered stale yunying job after process restart",
      });
      if (job.currentStageId) {
        await upsertStageArtifact({
          root,
          jobId: job.jobId,
          stageId: job.currentStageId,
          stageName: job.currentStageName,
          patch: {
            status: "recovered_stale",
            runId: job.currentRunId,
            message: "Recovered stale yunying job after process restart",
          },
        });
      }
    }

    await writeDeviceState(
      root,
      toDeviceState(device, {
        activeJobId: undefined,
        activeRunId: undefined,
        state: "failed",
      }),
    );
    const failedPatch = job
      ? await buildFailedWorkerPatch({
          root,
          job,
          accountId: device.accountId,
          deviceId: device.deviceId,
          desiredGoal: job.goal,
          message: "Recovered stale yunying job after process restart",
          pluginConfig,
          recovery: {
            recoveredAt: nowIso(),
            action: "stale_failed",
            message: "Recovered stale yunying job after process restart",
            previousStatus: job.status,
            previousRunId: job.currentRunId,
          },
        })
      : {
          state: "recovering" as const,
          activeJobId: undefined,
          currentStageId: undefined,
          currentStageName: undefined,
          progressSummary: "Recovered stale worker state after restart",
          lastError: "Recovered stale yunying job after process restart",
          lastHeartbeatAt: nowIso(),
          lastCheckpointAt: nowIso(),
        };
    await writeWorkerProgress({
      root,
      deviceKey: device.deviceKey,
      accountId: device.accountId,
      deviceId: device.deviceId,
      patch: failedPatch,
    });
  }
}

export async function stopActiveYunyingJob(params: {
  config: ClawdbotConfig;
  root: string;
  accountId: string;
  deviceKey: string;
  reason: {
    status: "stopped" | "replaced";
    message: string;
  };
}) {
  const activeRun = ACTIVE_RUNS.get(params.deviceKey);
  const device = await readDeviceState(params.root, params.deviceKey);
  const activeJob = device?.activeJobId ? await readJob(params.root, device.activeJobId) : null;
  const activeRunId =
    readOptionalString(device?.activeRunId) ?? readOptionalString(activeJob?.currentRunId);

  if (!device?.activeJobId && !activeRun) {
    return {
      stopped: false,
      device,
      job: activeJob,
    };
  }

  if (activeRun) {
    activeRun.termination = params.reason;
    activeRun.abortController.abort(params.reason.message);
  }

  const manager = await createPhoneManager(params.config);
  await manager.stop({ accountId: params.accountId, runId: activeRunId });
  if (activeRun) await activeRun.promise.catch(() => {});

  let updatedJob = activeJob;
  if (device?.activeJobId && activeJob && (activeJob.status === "accepted" || activeJob.status === "running")) {
    updatedJob = {
      ...activeJob,
      status: params.reason.status,
      updatedAt: nowIso(),
      error: params.reason.message,
      currentStageId: undefined,
      currentStageName: undefined,
      currentRunId: undefined,
    };
    await writeTrackedJob(params.root, updatedJob);
    await appendJobLog(params.root, activeJob.jobId, {
      ts: nowIso(),
      type: `job.${params.reason.status}`,
      message: params.reason.message,
    });
    if (activeJob.currentStageId) {
      await upsertStageArtifact({
        root: params.root,
        jobId: activeJob.jobId,
        stageId: activeJob.currentStageId,
        stageName: activeJob.currentStageName,
        patch: {
          status: params.reason.status,
          runId: activeRunId,
          message: params.reason.message,
        },
      });
    }
  }

  if (device) {
    await writeDeviceState(
      params.root,
      toDeviceState(device, {
        activeJobId: undefined,
        activeRunId: undefined,
        state: "stopped",
      }),
    );
  }
  await writeWorkerProgress({
    root: params.root,
    deviceKey: params.deviceKey,
    accountId: params.accountId,
    deviceId: device?.deviceId ?? activeJob?.deviceId,
    patch: {
      state: params.reason.status === "replaced" ? "running" : "stopped",
      activeJobId: undefined,
      currentStageId: undefined,
      currentStageName: undefined,
      desiredGoal: activeJob?.goal,
      progressSummary: params.reason.message,
      lastError: params.reason.status === "stopped" ? params.reason.message : undefined,
      lastHeartbeatAt: nowIso(),
      lastCheckpointAt: nowIso(),
      nextWakeAt: undefined,
      resumeSourceJobId: undefined,
      resumeAttempts: 0,
    },
  });

  return {
    stopped: true,
    device,
    job: updatedJob,
  };
}

export async function startYunyingJob(params: {
  config: ClawdbotConfig;
  root: string;
  pluginConfig: PluginConfig;
  accountId: string;
  deviceId?: string;
  deviceKey: string;
  displayName?: string;
  goal: string;
  skill: YunyingSkill;
  acceptedMessage?: string;
  resumedFromJobId?: string;
  resumeAttempt?: number;
}) {
  const totalStageCount = params.skill.stages.length;
  const repeatIntervalMs = resolveRepeatIntervalMs(params.skill);
  const job: JobState = {
    jobId: randomUUID(),
    deviceKey: params.deviceKey,
    accountId: params.accountId,
    deviceId: params.deviceId,
    resumedFromJobId: params.resumedFromJobId,
    skillId: params.skill.id,
    skillName: params.skill.name,
    platform: params.skill.platform,
    goal: params.goal,
    status: "accepted",
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedStages: [],
  };
  await writeTrackedJob(params.root, job, totalStageCount);
  await appendJobLog(params.root, job.jobId, {
    ts: nowIso(),
    type: "job.accepted",
    message: params.acceptedMessage ?? "Background job accepted",
  });
  if (params.resumedFromJobId) {
    await appendJobLog(params.root, job.jobId, {
      ts: nowIso(),
      type: "job.resumed_from",
      message: `Resumed from ${params.resumedFromJobId}`,
      data: { resumedFromJobId: params.resumedFromJobId },
    });
  }

  const deviceState: DeviceState = {
    deviceKey: params.deviceKey,
    accountId: params.accountId,
    deviceId: params.deviceId,
    activeJobId: job.jobId,
    activeRunId: undefined,
    state: "running",
    updatedAt: nowIso(),
  };
  await writeDeviceState(params.root, deviceState);
  await writeWorkerProgress({
    root: params.root,
    deviceKey: params.deviceKey,
    accountId: params.accountId,
    deviceId: params.deviceId,
    displayName: params.displayName,
    patch: {
      boundSkillId: params.skill.id,
      boundSkillName: params.skill.name,
      scheduleIntervalMs: repeatIntervalMs,
      state: "running",
      activeJobId: job.jobId,
      desiredGoal: params.goal,
      progressSummary: params.acceptedMessage ?? "Background job accepted",
      lastHeartbeatAt: nowIso(),
      lastCheckpointAt: nowIso(),
      nextWakeAt: undefined,
      resumeSourceJobId: undefined,
      resumeAttempts: params.resumedFromJobId ? Math.max(1, params.resumeAttempt ?? 1) : 0,
      lastResumedAt: params.resumedFromJobId ? nowIso() : undefined,
    },
  });
  await appendWorkerBrainNote({
    config: params.config,
    sessionKey: resolveWorkerSessionKey({ deviceKey: params.deviceKey }),
    displayName: params.displayName ?? params.deviceId ?? params.accountId,
    accountId: params.accountId,
    deviceId: params.deviceId,
    deviceKey: params.deviceKey,
    subject: params.goal,
    text: params.acceptedMessage ?? `新任务已接收：${params.skill.name}`,
  }).catch(() => {});

  let manager: PhoneManagerLike;
  try {
    manager = await createPhoneManager(params.config);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markJobFailedBeforeLaunch({
      root: params.root,
      job,
      deviceState,
      error: message,
      totalStageCount,
      pluginConfig: params.pluginConfig,
      skill: params.skill,
      config: params.config,
      displayName: params.displayName,
    });
    throw error;
  }

  const active: ActiveRun = {
    jobId: job.jobId,
    accountId: params.accountId,
    deviceKey: params.deviceKey,
    abortController: new AbortController(),
    promise: Promise.resolve(),
  };
  let activeStageContext:
    | {
        stage: YunyingStage;
        runId?: string;
        runtimeStatus?: string;
        runtimeEventTypes?: string[];
        runtimeEventCount?: number;
      }
    | undefined;

  active.promise = (async () => {
    let mutableJob: JobState = {
      ...job,
      status: "running",
      updatedAt: nowIso(),
    };
    await writeTrackedJob(params.root, mutableJob, totalStageCount);

    for (const stage of params.skill.stages) {
      if (active.abortController.signal.aborted) {
        throw new Error(active.termination?.message ?? "yunying run aborted");
      }

      mutableJob = {
        ...mutableJob,
        currentStageId: stage.id,
        currentStageName: stage.name,
        updatedAt: nowIso(),
      };
      await writeTrackedJob(params.root, mutableJob, totalStageCount);
      activeStageContext = { stage };
      await appendWorkerBrainNote({
        config: params.config,
        sessionKey: resolveWorkerSessionKey({ deviceKey: params.deviceKey }),
        displayName: params.displayName ?? params.deviceId ?? params.accountId,
        accountId: params.accountId,
        deviceId: params.deviceId,
        deviceKey: params.deviceKey,
        subject: params.goal,
        text: `进入阶段：${stage.name}`,
      }).catch(() => {});
      await writeWorkerProgress({
        root: params.root,
        deviceKey: params.deviceKey,
        accountId: params.accountId,
        deviceId: params.deviceId,
        displayName: params.displayName,
        patch: {
          boundSkillId: params.skill.id,
          boundSkillName: params.skill.name,
          scheduleIntervalMs: repeatIntervalMs,
          state: "running",
          activeJobId: mutableJob.jobId,
          currentStageId: stage.id,
          currentStageName: stage.name,
          desiredGoal: params.goal,
          progressSummary: `Stage started: ${stage.name}`,
          lastHeartbeatAt: nowIso(),
          lastCheckpointAt: nowIso(),
        },
      });
      await upsertStageArtifact({
        root: params.root,
        jobId: mutableJob.jobId,
        stage,
        patch: {
          status: "started",
        },
      });
      await appendJobLog(params.root, mutableJob.jobId, {
        ts: nowIso(),
        type: "stage.started",
        message: stage.name,
      });

      const accepted = await manager.run({
        accountId: params.accountId,
        deviceId: params.deviceId,
        mode: params.skill.defaults?.phoneMode ?? params.pluginConfig.defaultMode ?? "monitor",
        task: buildStageTask({ skill: params.skill, stage, goal: params.goal }),
        waitForCompletion: false,
        waitTimeoutMs: resolveWaitTimeoutMs(params.skill, params.pluginConfig),
        lang: params.skill.defaults?.lang,
        maxSteps: params.skill.defaults?.maxSteps,
        maxRounds: params.skill.defaults?.maxRounds,
        executorMaxSteps: params.skill.defaults?.executorMaxSteps,
        monitorUseScreenshot: params.skill.defaults?.monitorUseScreenshot,
      });
      const runId = readOptionalString(accepted.runId);
      if (!runId) {
        throw new Error("phone runtime did not return a runId");
      }
      activeStageContext = {
        ...activeStageContext,
        stage,
        runId,
      };

      mutableJob = {
        ...mutableJob,
        currentRunId: runId,
        lastRunId: runId,
        updatedAt: nowIso(),
      };
      await writeTrackedJob(params.root, mutableJob, totalStageCount);
      await writeDeviceState(
        params.root,
        toDeviceState(deviceState, {
          activeJobId: mutableJob.jobId,
          activeRunId: runId,
          state: "running",
        }),
      );
      await writeWorkerProgress({
        root: params.root,
        deviceKey: params.deviceKey,
        accountId: params.accountId,
        deviceId: params.deviceId,
        displayName: params.displayName,
        patch: {
          boundSkillId: params.skill.id,
          boundSkillName: params.skill.name,
          scheduleIntervalMs: repeatIntervalMs,
          state: "running",
          activeJobId: mutableJob.jobId,
          currentStageId: stage.id,
          currentStageName: stage.name,
          desiredGoal: params.goal,
          progressSummary: `Runtime accepted for ${stage.name}`,
          lastHeartbeatAt: nowIso(),
        },
      });
      await appendWorkerBrainNote({
        config: params.config,
        sessionKey: resolveWorkerSessionKey({ deviceKey: params.deviceKey }),
        displayName: params.displayName ?? params.deviceId ?? params.accountId,
        accountId: params.accountId,
        deviceId: params.deviceId,
        deviceKey: params.deviceKey,
        subject: params.goal,
        text: `阶段完成：${stage.name}`,
      }).catch(() => {});
      await upsertStageArtifact({
        root: params.root,
        jobId: mutableJob.jobId,
        stage,
        patch: {
          status: "started",
          runId,
        },
      });
      await appendJobLog(params.root, mutableJob.jobId, {
        ts: nowIso(),
        type: "runtime.accepted",
        message: `run accepted for ${stage.name}`,
        data: { runId },
      });

      const result = await manager.wait({
        accountId: params.accountId,
        runId,
        waitTimeoutMs: resolveWaitTimeoutMs(params.skill, params.pluginConfig),
      });
      const runtimeEvents = readRuntimeEvents((result as Record<string, unknown>).events);
      const runtimeEventTypes = [...new Set(runtimeEvents.map((runtimeEvent) => normalizeRuntimeEventType(runtimeEvent)))];
      for (const runtimeEvent of runtimeEvents) {
        await appendJobLog(params.root, mutableJob.jobId, {
          ts: nowIso(),
          type: normalizeRuntimeEventType(runtimeEvent),
          message: readOptionalString(runtimeEvent.message),
          data: buildRuntimeEventData(runtimeEvent),
        });
      }
      activeStageContext = {
        ...activeStageContext,
        stage,
        runId,
        runtimeStatus: readOptionalString((result as Record<string, unknown>).status),
        runtimeEventTypes,
        runtimeEventCount: runtimeEvents.length,
      };
      await writeWorkerProgress({
        root: params.root,
        deviceKey: params.deviceKey,
        accountId: params.accountId,
        deviceId: params.deviceId,
        displayName: params.displayName,
        patch: {
          boundSkillId: params.skill.id,
          boundSkillName: params.skill.name,
          scheduleIntervalMs: repeatIntervalMs,
          state: "running",
          activeJobId: mutableJob.jobId,
          currentStageId: stage.id,
          currentStageName: stage.name,
          desiredGoal: params.goal,
          progressSummary:
            readOptionalString((result as Record<string, unknown>).message) ??
            `Runtime finished ${stage.name}`,
          lastHeartbeatAt: nowIso(),
          lastCheckpointAt: nowIso(),
        },
      });

      if (active.abortController.signal.aborted) {
        throw new Error(active.termination?.message ?? "yunying run aborted");
      }

      if (isRecord(result) && result.completed === true && result.ok === false) {
        throw new Error(
          readOptionalString(result.message) ??
            `phone stage failed with status=${readOptionalString(result.status) ?? "unknown"}`,
        );
      }

      mutableJob = {
        ...mutableJob,
        completedStages: [...mutableJob.completedStages, stage.id],
        lastRunId: readOptionalString((result as Record<string, unknown>).runId) ?? runId,
        currentRunId: undefined,
        updatedAt: nowIso(),
      };
      await writeTrackedJob(params.root, mutableJob, totalStageCount);
      await writeDeviceState(
        params.root,
        toDeviceState(deviceState, {
          activeJobId: mutableJob.jobId,
          activeRunId: undefined,
          state: "running",
        }),
      );
      await writeWorkerProgress({
        root: params.root,
        deviceKey: params.deviceKey,
        accountId: params.accountId,
        deviceId: params.deviceId,
        displayName: params.displayName,
        patch: {
          boundSkillId: params.skill.id,
          boundSkillName: params.skill.name,
          scheduleIntervalMs: repeatIntervalMs,
          state: "running",
          activeJobId: mutableJob.jobId,
          currentStageId: undefined,
          currentStageName: undefined,
          desiredGoal: params.goal,
          progressSummary: `Stage completed: ${stage.name}`,
          lastHeartbeatAt: nowIso(),
          lastCheckpointAt: nowIso(),
        },
      });
      await upsertStageArtifact({
        root: params.root,
        jobId: mutableJob.jobId,
        stage,
        patch: {
          status: "completed",
          runId: readOptionalString((result as Record<string, unknown>).runId) ?? runId,
          runtimeStatus: readOptionalString((result as Record<string, unknown>).status),
          runtimeEventTypes,
          runtimeEventCount: runtimeEvents.length,
          message: readOptionalString((result as Record<string, unknown>).message),
        },
      });
      await appendJobLog(params.root, mutableJob.jobId, {
        ts: nowIso(),
        type: "stage.completed",
        message: stage.name,
        data: {
          runId: readOptionalString((result as Record<string, unknown>).runId) ?? runId,
          status: readOptionalString((result as Record<string, unknown>).status),
        },
      });
      activeStageContext = undefined;
    }

      await finalizeJob({
        root: params.root,
        activeRun: active,
        deviceState,
        nextStatus: "completed",
        totalStageCount,
        desiredGoal: params.goal,
        pluginConfig: params.pluginConfig,
        skill: params.skill,
        config: params.config,
        displayName: params.displayName,
      });
    })()
    .catch(async (error) => {
      if (activeStageContext) {
        await upsertStageArtifact({
          root: params.root,
          jobId: active.jobId,
          stage: activeStageContext.stage,
          patch: {
            status: active.termination ? active.termination.status : "failed",
            runId: activeStageContext.runId,
            runtimeStatus: activeStageContext.runtimeStatus,
            runtimeEventTypes: activeStageContext.runtimeEventTypes,
            runtimeEventCount: activeStageContext.runtimeEventCount,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      await finalizeJob({
        root: params.root,
        activeRun: active,
        deviceState,
        nextStatus: active.termination ? active.termination.status : "failed",
        error: error instanceof Error ? error.message : String(error),
        totalStageCount,
        desiredGoal: params.goal,
        pluginConfig: params.pluginConfig,
        skill: params.skill,
        config: params.config,
        displayName: params.displayName,
      });
    })
    .finally(() => {
      if (ACTIVE_RUNS.get(params.deviceKey)?.jobId === active.jobId) {
        ACTIVE_RUNS.delete(params.deviceKey);
      }
    });

  ACTIVE_RUNS.set(params.deviceKey, active);
  return job;
}
