import type { ClawdbotPluginApi, ClawdbotPluginService } from "clawdbot/plugin-sdk";

import { resolvePluginStateDir, ensureStore, listWorkerStates, readDeviceState } from "./store.js";
import { startScheduledYunyingJob, resumeYunyingJob } from "./control-plane.js";
import {
  ensureWorkerState,
  getActiveRun,
  type PluginConfig,
  reconcileStaleJobs,
  writeWorkerProgress,
} from "./worker.js";

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function resolveSupervisorPollMs(pluginConfig: PluginConfig) {
  return Math.max(1_000, pluginConfig.supervisorPollMs ?? 2_000);
}

function resolveNextWakeAtMs(value?: string) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isWakeDue(nextWakeAt?: string) {
  const wakeAtMs = resolveNextWakeAtMs(nextWakeAt);
  return wakeAtMs !== null && wakeAtMs <= Date.now();
}

function isScheduledWakeWorker(worker: {
  boundSkillId?: string;
  desiredGoal?: string;
  scheduleIntervalMs?: number;
}) {
  return (
    Boolean(readOptionalString(worker.boundSkillId)) &&
    Boolean(readOptionalString(worker.desiredGoal)) &&
    typeof worker.scheduleIntervalMs === "number" &&
    worker.scheduleIntervalMs > 0
  );
}

export async function runYunyingSupervisorSweep(params: {
  api: ClawdbotPluginApi;
  root?: string;
  pluginConfig?: PluginConfig;
}) {
  const pluginConfig = params.pluginConfig ?? ((params.api.pluginConfig ?? {}) as PluginConfig);
  const root = params.root ?? resolvePluginStateDir();

  await ensureStore(root);
  await reconcileStaleJobs(root, pluginConfig);

  const workers = (await listWorkerStates(root)).sort((left, right) =>
    String(left.nextWakeAt ?? "").localeCompare(String(right.nextWakeAt ?? "")),
  );

  for (const worker of workers) {
    if (!isWakeDue(worker.nextWakeAt)) continue;
    if (getActiveRun(worker.deviceKey)) continue;

    const device = await readDeviceState(root, worker.deviceKey);
    if (device?.activeJobId) continue;

    await ensureWorkerState({
      root,
      deviceKey: worker.deviceKey,
      accountId: worker.accountId,
      deviceId: worker.deviceId,
      desiredGoal: worker.desiredGoal,
    });

    try {
      if (readOptionalString(worker.resumeSourceJobId)) {
        const resumed = await resumeYunyingJob({
          api: params.api,
          root,
          pluginConfig,
          accountId: worker.accountId,
          deviceId: worker.deviceId,
          deviceKey: worker.deviceKey,
          jobId: worker.resumeSourceJobId,
          acceptedMessage: `Auto-resume accepted for ${worker.deviceKey}`,
          resumeAttempt: worker.resumeAttempts,
        });
        if (!resumed.resumedJob) {
          await writeWorkerProgress({
            root,
            deviceKey: worker.deviceKey,
            accountId: worker.accountId,
            deviceId: worker.deviceId,
            patch: {
              state: "idle",
              progressSummary: "No remaining stages to resume",
              nextWakeAt: undefined,
              resumeSourceJobId: undefined,
              resumeAttempts: 0,
              lastHeartbeatAt: new Date().toISOString(),
            },
          });
        }
        continue;
      }

      if (isScheduledWakeWorker(worker)) {
        await startScheduledYunyingJob({
          api: params.api,
          root,
          pluginConfig,
          worker,
          acceptedMessage: `Scheduled wake accepted for ${worker.deviceKey}`,
        });
        continue;
      }

      await writeWorkerProgress({
        root,
        deviceKey: worker.deviceKey,
        accountId: worker.accountId,
        deviceId: worker.deviceId,
        patch: {
          state: worker.state === "recovering" ? "failed" : worker.state,
          progressSummary: "Skipped wake: no resume source or recurring schedule",
          nextWakeAt: undefined,
          resumeSourceJobId: undefined,
          resumeAttempts: 0,
          lastHeartbeatAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeWorkerProgress({
        root,
        deviceKey: worker.deviceKey,
        accountId: worker.accountId,
        deviceId: worker.deviceId,
        patch: {
          state: "failed",
          progressSummary: `Supervisor wake failed: ${message}`,
          lastError: message,
          nextWakeAt: undefined,
          resumeSourceJobId: undefined,
          lastHeartbeatAt: new Date().toISOString(),
        },
      });
    }
  }
}

export function createYunyingSupervisorService(api: ClawdbotPluginApi): ClawdbotPluginService {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const root = resolvePluginStateDir();
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  let running = false;

  const schedule = (delayMs: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void tick();
    }, delayMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped) return;
    if (running) {
      schedule(resolveSupervisorPollMs(pluginConfig));
      return;
    }
    running = true;
    try {
      await runYunyingSupervisorSweep({
        api,
        root,
        pluginConfig,
      });
    } catch (error) {
      api.logger.warn(`yunying supervisor sweep failed: ${String(error)}`);
    } finally {
      running = false;
      schedule(resolveSupervisorPollMs(pluginConfig));
    }
  };

  return {
    id: "yunying-supervisor",
    async start() {
      stopped = false;
      await ensureStore(root);
      schedule(0);
      api.logger.info(`yunying supervisor started (poll=${resolveSupervisorPollMs(pluginConfig)}ms)`);
    },
    async stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      api.logger.info("yunying supervisor stopped");
    },
  };
}
