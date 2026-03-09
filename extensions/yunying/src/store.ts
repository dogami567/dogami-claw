import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type DeviceState = {
  deviceKey: string;
  accountId: string;
  deviceId?: string;
  activeJobId?: string;
  activeRunId?: string;
  state: "idle" | "running" | "failed" | "stopped";
  updatedAt: string;
};

export type WorkerState = {
  workerId: string;
  deviceKey: string;
  accountId: string;
  deviceId?: string;
  displayName?: string;
  workerSessionKey?: string;
  brainSessionId?: string;
  brainLastMessage?: string;
  boundSkillId?: string;
  boundSkillName?: string;
  scheduleIntervalMs?: number;
  state: "idle" | "running" | "failed" | "stopped" | "recovering";
  activeJobId?: string;
  currentStageId?: string;
  currentStageName?: string;
  desiredGoal?: string;
  progressSummary?: string;
  lastError?: string;
  lastHeartbeatAt?: string;
  lastCheckpointAt?: string;
  resumeSourceJobId?: string;
  resumeAttempts?: number;
  lastResumedAt?: string;
  nextWakeAt?: string;
  updatedAt: string;
};

export type JobState = {
  jobId: string;
  deviceKey: string;
  accountId: string;
  deviceId?: string;
  resumedFromJobId?: string;
  skillId: string;
  skillName: string;
  platform: string;
  goal: string;
  status: "accepted" | "running" | "completed" | "failed" | "stopped" | "replaced";
  createdAt: string;
  updatedAt: string;
  currentStageId?: string;
  currentStageName?: string;
  currentRunId?: string;
  completedStages: string[];
  lastRunId?: string;
  error?: string;
  summary?: JobSummary;
  recovery?: JobRecovery;
};

export type JobEvent = {
  ts: string;
  type: string;
  message?: string;
  data?: Record<string, unknown>;
};

export type JobSummary = {
  status: JobState["status"];
  message?: string;
  updatedAt: string;
  totalStageCount?: number;
  completedStageCount: number;
  currentStageId?: string;
  currentStageName?: string;
  lastRunId?: string;
  recoveryAction?: string;
};

export type JobRecovery = {
  recoveredAt: string;
  action: "stale_failed";
  message: string;
  previousStatus?: string;
  previousRunId?: string;
};

export type StageArtifact = {
  jobId: string;
  stageId: string;
  stageName?: string;
  status: "started" | "completed" | "failed" | "stopped" | "replaced" | "recovered_stale";
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  objective?: string;
  actions?: string[];
  completionCriteria?: string[];
  runId?: string;
  runtimeStatus?: string;
  runtimeEventCount?: number;
  runtimeEventTypes?: string[];
  message?: string;
};

function jobsDir(root: string) {
  return path.join(root, "jobs");
}

function devicesDir(root: string) {
  return path.join(root, "devices");
}

function workersDir(root: string) {
  return path.join(root, "workers");
}

function artifactsRoot(root: string) {
  return path.join(root, "artifacts");
}

function jobArtifactsDir(root: string, jobId: string) {
  return path.join(artifactsRoot(root), jobId);
}

function jobPath(root: string, jobId: string) {
  return path.join(jobsDir(root), `${jobId}.json`);
}

function jobLogPath(root: string, jobId: string) {
  return path.join(jobsDir(root), `${jobId}.jsonl`);
}

function devicePath(root: string, deviceKey: string) {
  return path.join(devicesDir(root), `${encodeURIComponent(deviceKey)}.json`);
}

function workerPath(root: string, deviceKey: string) {
  return path.join(workersDir(root), `${encodeURIComponent(deviceKey)}.json`);
}

function stageArtifactPath(root: string, jobId: string, stageId: string) {
  return path.join(jobArtifactsDir(root, jobId), `${encodeURIComponent(stageId)}.json`);
}

function summaryArtifactPath(root: string, jobId: string) {
  return path.join(jobArtifactsDir(root, jobId), "_summary.json");
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

export function resolvePluginStateDir() {
  const override = process.env.CLAWDBOT_STATE_DIR?.trim();
  const root = override ? path.resolve(override) : path.join(os.homedir(), ".clawdbot");
  return path.join(root, "plugins", "yunying");
}

export async function ensureStore(root: string) {
  await fs.mkdir(jobsDir(root), { recursive: true });
  await fs.mkdir(devicesDir(root), { recursive: true });
  await fs.mkdir(workersDir(root), { recursive: true });
  await fs.mkdir(artifactsRoot(root), { recursive: true });
}

export async function readDeviceState(root: string, deviceKey: string) {
  return await readJsonFile<DeviceState>(devicePath(root, deviceKey));
}

export async function writeDeviceState(root: string, state: DeviceState) {
  await writeJsonFile(devicePath(root, state.deviceKey), state);
}

export async function readWorkerState(root: string, deviceKey: string) {
  return await readJsonFile<WorkerState>(workerPath(root, deviceKey));
}

export async function writeWorkerState(root: string, state: WorkerState) {
  await writeJsonFile(workerPath(root, state.deviceKey), state);
}

export async function readJob(root: string, jobId: string) {
  return await readJsonFile<JobState>(jobPath(root, jobId));
}

export async function writeJob(root: string, job: JobState) {
  await writeJsonFile(jobPath(root, job.jobId), job);
}

export async function appendJobLog(root: string, jobId: string, event: JobEvent) {
  await fs.mkdir(jobsDir(root), { recursive: true });
  await fs.appendFile(jobLogPath(root, jobId), `${JSON.stringify(event)}\n`, "utf8");
}

export async function readStageArtifact(root: string, jobId: string, stageId: string) {
  return await readJsonFile<StageArtifact>(stageArtifactPath(root, jobId, stageId));
}

export async function writeStageArtifact(root: string, artifact: StageArtifact) {
  await writeJsonFile(stageArtifactPath(root, artifact.jobId, artifact.stageId), artifact);
}

export async function listStageArtifacts(root: string, jobId: string) {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(jobArtifactsDir(root, jobId), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }

  const artifacts = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json") && entry.name !== "_summary.json")
      .map(async (entry) =>
        await readJsonFile<StageArtifact>(path.join(jobArtifactsDir(root, jobId), entry.name)),
      ),
  );
  return artifacts
    .filter((entry): entry is StageArtifact => Boolean(entry))
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt));
}

export async function readJobSummaryArtifact(root: string, jobId: string) {
  return await readJsonFile<JobSummary>(summaryArtifactPath(root, jobId));
}

export async function writeJobSummaryArtifact(root: string, jobId: string, summary: JobSummary) {
  await writeJsonFile(summaryArtifactPath(root, jobId), summary);
}

export async function readJobLogs(root: string, jobId: string, limit: number) {
  try {
    const raw = await fs.readFile(jobLogPath(root, jobId), "utf8");
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JobEvent)
      .slice(-limit);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }
}

export async function listDeviceStates(root: string) {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(devicesDir(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }

  const states = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<DeviceState>(path.join(devicesDir(root), entry.name))),
  );
  return states.filter((entry): entry is DeviceState => Boolean(entry));
}

export async function listWorkerStates(root: string) {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(workersDir(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }

  const states = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<WorkerState>(path.join(workersDir(root), entry.name))),
  );
  return states.filter((entry): entry is WorkerState => Boolean(entry));
}

export async function listJobs(root: string) {
  let entries: Array<{ name: string; isFile: () => boolean }> = [];
  try {
    entries = await fs.readdir(jobsDir(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
    throw error;
  }

  const jobs = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map(async (entry) => await readJsonFile<JobState>(path.join(jobsDir(root), entry.name))),
  );
  return jobs
    .filter((entry): entry is JobState => Boolean(entry))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
