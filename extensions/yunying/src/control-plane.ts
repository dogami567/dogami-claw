import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  jsonResult,
  type ClawdbotConfig,
  type ClawdbotPluginApi,
} from "clawdbot/plugin-sdk";

import {
  inferPlatformFromGoal,
  loadSkillsFromDir,
  type YunyingSkill,
} from "./skill.js";
import {
  appendWorkerBrainNote,
  defaultWorkerDisplayName,
  ensureWorkerBrainSession,
  readWorkerBrainPreview,
} from "./brain.js";
import {
  createPhoneManager,
} from "./runtime.js";
import {
  type DeviceState,
  ensureStore,
  listJobs,
  listStageArtifacts,
  readDeviceState,
  readJob,
  readJobLogs,
  resolvePluginStateDir,
  listDeviceStates,
  listWorkerStates,
  type JobState,
} from "./store.js";
import {
  ensureWorkerState,
  getActiveRun,
  type PluginConfig,
  reconcileStaleJobs,
  startYunyingJob,
  stopActiveYunyingJob,
  writeWorkerProgress,
} from "./worker.js";
import { runAgentStep } from "../../../src/agents/tools/agent-step.js";

const ACTIONS = [
  "listSkills",
  "start",
  "replace",
  "resume",
  "rename",
  "brainSend",
  "stop",
  "status",
  "logs",
  "fleet",
] as const;

export const YUNYING_ACTIONS = ACTIONS;

function defaultSkillsDir() {
  return path.resolve(fileURLToPath(new URL("../skills", import.meta.url)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function readOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function resolveConfiguredDeviceId(config: ClawdbotConfig, accountId: string): string | undefined {
  const raw = config.phones?.accounts?.[accountId];
  return readOptionalString(raw?.deviceId);
}

function resolveConfiguredAccountName(config: ClawdbotConfig, accountId: string): string {
  return readOptionalString(config.phones?.accounts?.[accountId]?.name) ?? accountId;
}

export function resolveDefaultAccountId(config: ClawdbotConfig, pluginConfig: PluginConfig, accountId?: string) {
  const explicit = readOptionalString(accountId);
  if (explicit) return explicit;
  const pluginDefault = readOptionalString(pluginConfig.defaultAccountId);
  if (pluginDefault) return pluginDefault;
  const configuredDefault = readOptionalString(config.phones?.defaultAccountId);
  if (configuredDefault) return configuredDefault;
  const first = Object.keys(config.phones?.accounts ?? {})[0];
  if (first) return first;
  throw new Error("No phone accounts configured for yunying");
}

export function resolveDeviceKey(accountId: string, deviceId?: string) {
  return deviceId ? `device:${deviceId}` : `account:${accountId}`;
}

function listConfiguredFleetEntries(config: ClawdbotConfig) {
  return Object.entries(config.phones?.accounts ?? {}).map(([accountId, raw]) => {
    const deviceId = readOptionalString(raw.deviceId);
    return {
      accountId,
      accountName: readOptionalString(raw.name) ?? accountId,
      enabled: raw.enabled !== false,
      deviceId,
      deviceKey: resolveDeviceKey(accountId, deviceId),
    };
  });
}

type FleetDiscovery = {
  devicesById: Map<string, Record<string, unknown>>;
  error?: string;
};

async function collectFleetDiscoveries(
  api: ClawdbotPluginApi,
  configuredEntries: Array<{
    accountId: string;
    accountName: string;
    enabled: boolean;
    deviceId?: string;
    deviceKey: string;
  }>,
) {
  const discoveries = new Map<string, FleetDiscovery>();
  const manager = await createPhoneManager(api.config);

  await Promise.all(
    configuredEntries.map(async (entry) => {
      if (!entry.enabled) {
        discoveries.set(entry.accountId, { devicesById: new Map() });
        return;
      }
      try {
        const result = await manager.discover(entry.accountId);
        const devices = Array.isArray((result as { devices?: unknown }).devices)
          ? ((result as { devices: unknown[] }).devices.filter((item): item is Record<string, unknown> =>
              isRecord(item),
            ))
          : [];
        discoveries.set(
          entry.accountId,
          {
            devicesById: new Map(
              devices
                .map((device) => [readOptionalString(device.deviceId), device] as const)
                .filter((item): item is [string, Record<string, unknown>] => Boolean(item[0])),
            ),
          },
        );
      } catch (error) {
        discoveries.set(entry.accountId, {
          devicesById: new Map(),
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return discoveries;
}

function resolveFleetStatus(params: {
  enabled: boolean;
  deviceState?: DeviceState | null;
  workerState?: { state?: string } | null;
  runtimeDevice?: Record<string, unknown>;
  configuredDeviceId?: string;
  discoveryError?: string;
}) {
  if (!params.enabled) return "disabled";
  const workerState = readOptionalString(params.workerState?.state)?.toLowerCase();
  if (workerState === "running") return "running";
  if (workerState === "recovering") return "recovering";
  if (params.deviceState?.state === "running") return "running";
  if (params.deviceState?.state === "failed") return "failed";
  if (params.deviceState?.state === "stopped") return "stopped";

  const runtimeState = readOptionalString(params.runtimeDevice?.state)?.toLowerCase();
  if (runtimeState === "offline") return "offline";
  if (params.configuredDeviceId && !params.discoveryError && !params.runtimeDevice) return "missing";
  return "idle";
}

function resolveWorkerDisplayName(params: {
  worker?: { displayName?: string } | null;
  accountName?: string;
  runtimeDevice?: Record<string, unknown>;
  deviceId?: string;
  accountId: string;
  deviceKey: string;
}) {
  return defaultWorkerDisplayName({
    displayName: params.worker?.displayName,
    accountName: params.accountName,
    deviceLabel:
      readOptionalString(params.runtimeDevice?.label) ??
      readOptionalString(params.runtimeDevice?.name) ??
      readOptionalString(params.runtimeDevice?.model),
    deviceId: params.deviceId,
    accountId: params.accountId,
    deviceKey: params.deviceKey,
  });
}

function buildWorkerBrainPrompt(params: {
  displayName: string;
  deviceKey: string;
  desiredGoal?: string;
}) {
  return [
    "You are a persistent phone-specific运营 brain.",
    `Phone: ${params.displayName}`,
    `deviceKey: ${params.deviceKey}`,
    params.desiredGoal ? `Current goal: ${params.desiredGoal}` : undefined,
    "Use the existing transcript summaries as durable memory.",
    "Reply briefly and operationally. Do not invent that a task was completed if the transcript does not show it.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function loadSkills(api: ClawdbotPluginApi, pluginConfig: PluginConfig) {
  const configuredDir = readOptionalString(pluginConfig.skillsDir);
  const skillsDir = configuredDir ? api.resolvePath(configuredDir) : defaultSkillsDir();
  return {
    skillsDir,
    skills: await loadSkillsFromDir(skillsDir),
  };
}

export function selectSkill(
  skills: YunyingSkill[],
  params: { skillId?: string; platform?: string; goal?: string },
) {
  const requestedSkillId = readOptionalString(params.skillId);
  if (requestedSkillId) {
    const matched = skills.find((skill) => skill.id === requestedSkillId);
    if (!matched) throw new Error(`Unknown yunying skill: ${requestedSkillId}`);
    return matched;
  }

  const requestedPlatform = readOptionalString(params.platform) ?? inferPlatformFromGoal(params.goal);
  if (requestedPlatform) {
    const matched = skills.find((skill) => skill.platform === requestedPlatform);
    if (matched) return matched;
  }

  if (skills.length === 1) return skills[0];
  throw new Error("Unable to resolve yunying skill; provide skillId or platform");
}

export function isResumableStatus(status: JobState["status"]) {
  return status === "failed" || status === "stopped" || status === "replaced";
}

export function buildResumableSkill(params: {
  skill: YunyingSkill;
  completedStages: string[];
}) {
  const completed = new Set(params.completedStages);
  // Resume is stage-based for now: keep finished stages immutable and replay only the remainder.
  return {
    ...params.skill,
    stages: params.skill.stages.filter((stage) => !completed.has(stage.id)),
  };
}

export async function resolveResumeSourceJob(params: {
  root: string;
  deviceKey: string;
  jobId?: string;
}) {
  if (params.jobId) {
    const job = await readJob(params.root, params.jobId);
    if (!job) throw new Error(`Unknown yunying job: ${params.jobId}`);
    if (job.deviceKey !== params.deviceKey) {
      throw new Error(`Job ${params.jobId} does not belong to ${params.deviceKey}`);
    }
    return job;
  }

  const jobs = await listJobs(params.root);
  return (
    jobs.find((job) => job.deviceKey === params.deviceKey && isResumableStatus(job.status)) ?? null
  );
}

export async function resumeYunyingJob(params: {
  api: ClawdbotPluginApi;
  root: string;
  pluginConfig: PluginConfig;
  accountId: string;
  deviceId?: string;
  deviceKey: string;
  displayName?: string;
  jobId?: string;
  acceptedMessage?: string;
  resumeAttempt?: number;
}) {
  const sourceJob = await resolveResumeSourceJob({
    root: params.root,
    deviceKey: params.deviceKey,
    jobId: params.jobId,
  });
  if (!sourceJob) {
    throw new Error("No resumable yunying job found for this device");
  }
  if (!isResumableStatus(sourceJob.status)) {
    throw new Error(`Job ${sourceJob.jobId} is not resumable from status=${sourceJob.status}`);
  }

  const { skills } = await loadSkills(params.api, params.pluginConfig);
  if (skills.length === 0) {
    throw new Error("No yunying skills found; add *.skill.json under the configured skillsDir");
  }
  const skill = skills.find((entry) => entry.id === sourceJob.skillId);
  if (!skill) {
    throw new Error(`Unable to resume job ${sourceJob.jobId}; missing skill ${sourceJob.skillId}`);
  }

  const resumedSkill = buildResumableSkill({
    skill,
    completedStages: sourceJob.completedStages,
  });

  if (resumedSkill.stages.length === 0) {
    return {
      sourceJob,
      resumedSkill,
      resumedJob: null,
    };
  }

  const resumedJob = await startYunyingJob({
    config: params.api.config,
    root: params.root,
    pluginConfig: params.pluginConfig,
    accountId: params.accountId,
    deviceId: params.deviceId,
    deviceKey: params.deviceKey,
    displayName: params.displayName,
    goal: sourceJob.goal,
    skill: resumedSkill,
    acceptedMessage: params.acceptedMessage ?? `Resume accepted from ${sourceJob.jobId}`,
    resumedFromJobId: sourceJob.jobId,
    resumeAttempt: params.resumeAttempt,
  });

  return {
    sourceJob,
    resumedSkill,
    resumedJob,
  };
}

export async function startScheduledYunyingJob(params: {
  api: ClawdbotPluginApi;
  root: string;
  pluginConfig: PluginConfig;
  worker: {
    deviceKey: string;
    accountId: string;
    deviceId?: string;
    displayName?: string;
    boundSkillId?: string;
    desiredGoal?: string;
  };
  acceptedMessage?: string;
}) {
  const { skills } = await loadSkills(params.api, params.pluginConfig);
  if (skills.length === 0) {
    throw new Error("No yunying skills found; add *.skill.json under the configured skillsDir");
  }
  const skillId = readOptionalString(params.worker.boundSkillId);
  if (!skillId) throw new Error(`Worker ${params.worker.deviceKey} has no bound skill`);
  const skill = skills.find((entry) => entry.id === skillId);
  if (!skill) throw new Error(`Unable to wake worker ${params.worker.deviceKey}; missing skill ${skillId}`);
  const goal = readOptionalString(params.worker.desiredGoal);
  if (!goal) throw new Error(`Worker ${params.worker.deviceKey} has no desiredGoal to wake`);

  const job = await startYunyingJob({
    config: params.api.config,
    root: params.root,
    pluginConfig: params.pluginConfig,
    accountId: params.worker.accountId,
    deviceId: params.worker.deviceId,
    deviceKey: params.worker.deviceKey,
    displayName: params.worker.displayName,
    goal,
    skill,
    acceptedMessage: params.acceptedMessage ?? `Scheduled wake accepted for ${params.worker.deviceKey}`,
  });

  return { skill, job };
}

export function createYunyingControlPlane(api: ClawdbotPluginApi) {
  const pluginConfig = (api.pluginConfig ?? {}) as PluginConfig;
  const stateRoot = resolvePluginStateDir();

  return {
    async execute(rawParams: Record<string, unknown>) {
      await ensureStore(stateRoot);
      await reconcileStaleJobs(stateRoot, pluginConfig);
      const action = readOptionalString(rawParams.action);
      if (!action) throw new Error("action required");

      if (action === "listSkills") {
        const { skillsDir, skills } = await loadSkills(api, pluginConfig);
        return jsonResult({
          skillsDir,
          skills: skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            platform: skill.platform,
            summary: skill.summary,
            stageCount: skill.stages.length,
            stages: skill.stages.map((stage) => stage.name),
          })),
        });
      }

      if (action === "fleet") {
        const configuredEntries = listConfiguredFleetEntries(api.config);
        const [devices, workers, jobs, discoveries, ensuredWorkers] = await Promise.all([
          listDeviceStates(stateRoot),
          listWorkerStates(stateRoot),
          listJobs(stateRoot),
          collectFleetDiscoveries(api, configuredEntries),
          Promise.all(
            configuredEntries.map(async (entry) =>
              await ensureWorkerState({
                root: stateRoot,
                deviceKey: entry.deviceKey,
                accountId: entry.accountId,
                deviceId: entry.deviceId,
              }),
            ),
          ),
        ]);
        const deviceByKey = new Map(devices.map((device) => [device.deviceKey, device] as const));
        const workerByKey = new Map(
          [...workers, ...ensuredWorkers].map((worker) => [worker.deviceKey, worker] as const),
        );
        const latestJobByDeviceKey = new Map<string, JobState>();
        for (const job of jobs) {
          if (!latestJobByDeviceKey.has(job.deviceKey)) {
            latestJobByDeviceKey.set(job.deviceKey, job);
          }
        }

        const configuredDeviceKeys = new Set(configuredEntries.map((entry) => entry.deviceKey));
        const configuredOverview = await Promise.all(
          configuredEntries.map(async (entry) => {
            const device = deviceByKey.get(entry.deviceKey) ?? null;
            const runtimeDevice = entry.deviceId
              ? discoveries.get(entry.accountId)?.devicesById.get(entry.deviceId)
              : undefined;
            const existingWorker = workerByKey.get(entry.deviceKey) ?? null;
            const displayName = resolveWorkerDisplayName({
              worker: existingWorker,
              accountName: entry.accountName,
              runtimeDevice,
              deviceId: entry.deviceId,
              accountId: entry.accountId,
              deviceKey: entry.deviceKey,
            });
            const worker = await ensureWorkerState({
              root: stateRoot,
              deviceKey: entry.deviceKey,
              accountId: entry.accountId,
              deviceId: entry.deviceId,
              displayName,
            });
            await ensureWorkerBrainSession({
              config: api.config,
              sessionKey: worker.workerSessionKey ?? entry.deviceKey,
              displayName,
              subject: worker.desiredGoal,
              accountId: entry.accountId,
              deviceId: entry.deviceId,
              deviceKey: entry.deviceKey,
            });
            const activeJob =
              device?.activeJobId ? await readJob(stateRoot, device.activeJobId) : null;
            const latestJob = activeJob ?? latestJobByDeviceKey.get(entry.deviceKey) ?? null;
            const discovery = discoveries.get(entry.accountId);
            const brain = await readWorkerBrainPreview({
              config: api.config,
              sessionKey: worker.workerSessionKey,
            });
            return {
              deviceKey: entry.deviceKey,
              accountId: entry.accountId,
              accountName: entry.accountName,
              displayName,
              configuredDeviceId: entry.deviceId,
              enabled: entry.enabled,
              status: resolveFleetStatus({
                enabled: entry.enabled,
                deviceState: device,
                workerState: worker,
                runtimeDevice,
                configuredDeviceId: entry.deviceId,
                discoveryError: discovery?.error,
              }),
              runtimeDeviceState: readOptionalString(runtimeDevice?.state),
              runtimeDeviceLabel:
                readOptionalString(runtimeDevice?.label) ??
                readOptionalString(runtimeDevice?.name) ??
                readOptionalString(runtimeDevice?.model),
              discoveryError: discovery?.error,
              device,
              worker,
              brain,
              job: latestJob,
              lastError: latestJob?.error,
              updatedAt: worker?.updatedAt ?? device?.updatedAt ?? latestJob?.updatedAt ?? null,
            };
          }),
        );

        const orphanOverview = await Promise.all(
          devices
            .filter((device) => !configuredDeviceKeys.has(device.deviceKey))
            .map(async (device) => {
              const worker = workerByKey.get(device.deviceKey) ?? null;
              const displayName = resolveWorkerDisplayName({
                worker,
                accountName: resolveConfiguredAccountName(api.config, device.accountId),
                deviceId: device.deviceId,
                accountId: device.accountId,
                deviceKey: device.deviceKey,
              });
              return {
                deviceKey: device.deviceKey,
                accountId: device.accountId,
                accountName: resolveConfiguredAccountName(api.config, device.accountId),
                displayName,
                configuredDeviceId: device.deviceId,
                enabled: true,
                status: readOptionalString(workerByKey.get(device.deviceKey)?.state) ?? device.state,
                runtimeDeviceState: null,
                runtimeDeviceLabel: null,
                discoveryError: null,
                device,
                worker,
                brain: await readWorkerBrainPreview({
                  config: api.config,
                  sessionKey: worker?.workerSessionKey,
                }),
                job: device.activeJobId ? await readJob(stateRoot, device.activeJobId) : null,
                lastError: null,
                updatedAt: workerByKey.get(device.deviceKey)?.updatedAt ?? device.updatedAt,
                unmanaged: true,
              };
            }),
        );

        return jsonResult({
          devices: [...configuredOverview, ...orphanOverview].sort((left, right) =>
            String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")),
          ),
        });
      }

      const accountId = resolveDefaultAccountId(api.config, pluginConfig, rawParams.accountId);
      const deviceId = readOptionalString(rawParams.deviceId) ?? resolveConfiguredDeviceId(api.config, accountId);
      const deviceKey = resolveDeviceKey(accountId, deviceId);
      const limit = readOptionalNumber(rawParams.limit) ?? pluginConfig.maxLogEntries ?? 50;
      const activeRun = getActiveRun(deviceKey);
      const accountName = resolveConfiguredAccountName(api.config, accountId);
      const worker = await ensureWorkerState({
        root: stateRoot,
        deviceKey,
        accountId,
        deviceId,
        displayName: resolveWorkerDisplayName({
          accountName,
          deviceId,
          accountId,
          deviceKey,
        }),
      });
      await ensureWorkerBrainSession({
        config: api.config,
        sessionKey: worker.workerSessionKey ?? deviceKey,
        displayName:
          worker.displayName ??
          resolveWorkerDisplayName({
            accountName,
            deviceId,
            accountId,
            deviceKey,
          }),
        subject: worker.desiredGoal,
        accountId,
        deviceId,
        deviceKey,
      });
      const brain = await readWorkerBrainPreview({
        config: api.config,
        sessionKey: worker.workerSessionKey,
      });

      if (action === "status") {
        const jobId = readOptionalString(rawParams.jobId);
        const device = await readDeviceState(stateRoot, deviceKey);
        const job = jobId
          ? await readJob(stateRoot, jobId)
          : device?.activeJobId
            ? await readJob(stateRoot, device.activeJobId)
            : null;
        const logs = job ? await readJobLogs(stateRoot, job.jobId, Math.min(limit, 20)) : [];
        const artifacts = job ? await listStageArtifacts(stateRoot, job.jobId) : [];
        return jsonResult({
          deviceKey,
          displayName: worker.displayName ?? accountName,
          device,
          worker,
          brain,
          job,
          summary: job?.summary ?? null,
          artifacts,
          runningInProcess: Boolean(activeRun && job && activeRun.jobId === job.jobId),
          logs,
        });
      }

      if (action === "logs") {
        const requestedJobId =
          readOptionalString(rawParams.jobId) ??
          (await readDeviceState(stateRoot, deviceKey))?.activeJobId;
        if (!requestedJobId) throw new Error("No active or selected yunying job for logs");
        const job = await readJob(stateRoot, requestedJobId);
        return jsonResult({
          displayName: worker.displayName ?? accountName,
          job,
          worker,
          brain,
          summary: job?.summary ?? null,
          artifacts: await listStageArtifacts(stateRoot, requestedJobId),
          logs: await readJobLogs(stateRoot, requestedJobId, limit),
        });
      }

      if (action === "rename") {
        const nextName = readOptionalString(rawParams.name);
        if (!nextName) throw new Error("name required");
        const renamed = await writeWorkerProgress({
          root: stateRoot,
          deviceKey,
          accountId,
          deviceId,
          displayName: nextName,
          patch: {
            displayName: nextName,
            lastHeartbeatAt: new Date().toISOString(),
          },
        });
        await appendWorkerBrainNote({
          config: api.config,
          sessionKey: renamed.workerSessionKey ?? worker.workerSessionKey ?? deviceKey,
          displayName: nextName,
          accountId,
          deviceId,
          deviceKey,
          subject: renamed.desiredGoal,
          text: `手机已重命名为：${nextName}`,
        });
        return jsonResult({
          ok: true,
          action,
          deviceKey,
          displayName: nextName,
          worker: renamed,
          brain: await readWorkerBrainPreview({
            config: api.config,
            sessionKey: renamed.workerSessionKey,
          }),
        });
      }

      if (action === "brainSend") {
        const message = readOptionalString(rawParams.message);
        if (!message) throw new Error("message required");
        const displayName = worker.displayName ?? accountName;
        const reply =
          (await runAgentStep({
            sessionKey: worker.workerSessionKey ?? deviceKey,
            message,
            extraSystemPrompt: buildWorkerBrainPrompt({
              displayName,
              deviceKey,
              desiredGoal: worker.desiredGoal,
            }),
            timeoutMs: 45_000,
          })) ?? null;
        const preview = await readWorkerBrainPreview({
          config: api.config,
          sessionKey: worker.workerSessionKey,
        });
        if (preview?.lastMessage) {
          await writeWorkerProgress({
            root: stateRoot,
            deviceKey,
            accountId,
            deviceId,
            displayName,
            patch: {
              brainLastMessage: preview.lastMessage,
              brainSessionId: preview.sessionId,
              lastHeartbeatAt: new Date().toISOString(),
            },
          });
        }
        return jsonResult({
          ok: true,
          action,
          deviceKey,
          displayName,
          reply,
          brain: preview,
        });
      }

      if (action === "stop") {
        const result = await stopActiveYunyingJob({
          config: api.config,
          root: stateRoot,
          accountId,
          deviceKey,
          reason: {
            status: "stopped",
            message: "Stopped by yunying.stop",
          },
        });
        if (!result.stopped) {
          return jsonResult({
            ok: true,
            stopped: false,
            message: "No active yunying job for this device",
            deviceKey,
          });
        }

        return jsonResult({ ok: true, stopped: true, deviceKey });
      }

      if (action === "resume") {
        const currentDevice = await readDeviceState(stateRoot, deviceKey);
        if (currentDevice?.activeJobId) {
          throw new Error(
            `Device already has an active yunying job (${currentDevice.activeJobId}); stop or replace it first`,
          );
        }
        const resumed = await resumeYunyingJob({
          api,
          root: stateRoot,
          pluginConfig,
          accountId,
          deviceId,
          deviceKey,
          displayName: worker.displayName ?? accountName,
          jobId: readOptionalString(rawParams.jobId),
        });
        if (!resumed.resumedJob) {
          return jsonResult({
            ok: true,
            resumed: false,
            deviceKey,
            sourceJobId: resumed.sourceJob.jobId,
            message: "No remaining stages to resume",
          });
        }

        return jsonResult({
          ok: true,
          accepted: true,
          action,
          resumed: true,
          deviceKey,
          accountId,
          deviceId,
          sourceJobId: resumed.sourceJob.jobId,
          jobId: resumed.resumedJob.jobId,
          remainingStageCount: resumed.resumedSkill.stages.length,
          skill: {
            id: resumed.resumedSkill.id,
            name: resumed.resumedSkill.name,
            platform: resumed.resumedSkill.platform,
            stageCount: resumed.resumedSkill.stages.length,
          },
        });
      }

      const goal = readOptionalString(rawParams.goal);
      if (!goal) throw new Error("goal required");

      const { skills } = await loadSkills(api, pluginConfig);
      if (skills.length === 0) {
        throw new Error("No yunying skills found; add *.skill.json under the configured skillsDir");
      }
      const skill = selectSkill(skills, {
        skillId: readOptionalString(rawParams.skillId),
        platform: readOptionalString(rawParams.platform),
        goal,
      });

      const currentDevice = await readDeviceState(stateRoot, deviceKey);
      if (currentDevice?.activeJobId && action !== "replace") {
        throw new Error(
          `Device already has an active yunying job (${currentDevice.activeJobId}); use replace`,
        );
      }

      if (currentDevice?.activeJobId && action === "replace") {
        await stopActiveYunyingJob({
          config: api.config,
          root: stateRoot,
          accountId,
          deviceKey,
          reason: {
            status: "replaced",
            message: "Replaced by a newer yunying job",
          },
        });
      }

      const job = await startYunyingJob({
        config: api.config,
        root: stateRoot,
        pluginConfig,
        accountId,
        deviceId,
        deviceKey,
        displayName: worker.displayName ?? accountName,
        goal,
        skill,
        acceptedMessage: action === "replace" ? "Replacement job accepted" : "Background job accepted",
      });

      return jsonResult({
        ok: true,
        accepted: true,
        action,
        deviceKey,
        accountId,
        deviceId,
        jobId: job.jobId,
        skill: {
          id: skill.id,
          name: skill.name,
          platform: skill.platform,
          stageCount: skill.stages.length,
        },
      });
    },
  };
}
