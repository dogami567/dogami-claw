import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/phone/manager.js", () => ({
  createPhoneManager: vi.fn(() => ({
    discover: vi.fn(async (accountId?: string) => ({
      devices:
        accountId === "work"
          ? [{ deviceId: "55CQSWHYW4NJGAXW", state: "device", label: "Work Phone" }]
          : [],
    })),
    run: vi.fn(async () => ({
      ok: true,
      runId: "run-1",
      completed: false,
      status: "accepted",
    })),
    wait: vi.fn(async () => ({
      ok: true,
      completed: true,
      status: "completed",
      runId: "run-1",
      events: [
        { type: "log", message: "starting" },
        { type: "end", message: "done" },
      ],
    })),
    stop: vi.fn(async () => ({
      ok: true,
      stopped: true,
    })),
  })),
}));

vi.mock("../../../src/agents/tools/agent-step.js", () => ({
  runAgentStep: vi.fn(async ({ message }: { message?: string }) =>
    typeof message === "string" ? `brain:${message}` : "brain:ok",
  ),
}));

import { createPhoneManager } from "../../../src/phone/manager.js";
import { runAgentStep } from "../../../src/agents/tools/agent-step.js";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { createYunyingTool } from "./tool.js";
import { buildWorkerSessionKey } from "./worker-session.js";

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 300) {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function writeSkill(
  dir: string,
  stages: Array<Record<string, unknown>> = [
    {
      id: "stage-1",
      name: "Stage One",
      objective: "Do the first step",
      actions: ["Open app"],
      completionCriteria: ["Reached target screen"],
    },
  ],
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "demo.skill.json"),
    JSON.stringify({
      id: "demo-skill",
      name: "Demo Skill",
      platform: "xiaohongshu",
      stages,
      risks: []
    }),
    "utf8",
  );
}

function fakeApi(
  pluginConfig: Record<string, unknown>,
  config?: Record<string, unknown>,
): ClawdbotPluginApi {
  return {
    id: "yunying",
    name: "yunying",
    source: "test",
    config:
      ({
        phones: {
          defaultAccountId: "work",
          accounts: {
            work: {
              name: "Work Phone",
              deviceId: "55CQSWHYW4NJGAXW",
            },
          },
        },
        ...(config ?? {}),
      }) as any,
    pluginConfig,
    runtime: { version: "test" } as any,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    registerTool() {},
    registerHook() {},
    registerHttpHandler() {},
    registerHttpRoute() {},
    registerChannel() {},
    registerGatewayMethod() {},
    registerCli() {},
    registerService() {},
    registerProvider() {},
    registerCommand() {},
    resolvePath: (input) => path.resolve(input),
    on() {},
  };
}

describe("yunying tool", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    if (previousStateDir === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    }
  });

  it("lists local skills", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    await writeSkill(skillsDir);
    const tool = createYunyingTool(fakeApi({ skillsDir }));

    const result = await tool.execute("call1", { action: "listSkills" });

    expect(result.details).toMatchObject({
      skills: [{ id: "demo-skill", stageCount: 1 }],
    });
  });

  it("registers a stable worker session before and during runs", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir);
    const tool = createYunyingTool(fakeApi({ skillsDir }));
    const deviceKey = "device:55CQSWHYW4NJGAXW";
    const workerSessionKey = buildWorkerSessionKey(deviceKey);

    const idleStatus = await tool.execute("call-status-idle", {
      action: "status",
      accountId: "work",
    });

    expect(idleStatus.details).toMatchObject({
      deviceKey,
      worker: {
        workerId: `worker:${deviceKey}`,
        workerSessionKey,
        state: "idle",
        progressSummary: "Worker registered",
      },
      brain: {
        displayName: "Work Phone",
      },
      job: null,
    });

    const startResult = await tool.execute("call-start-stable-worker", {
      action: "start",
      accountId: "work",
      goal: "今天开始小红书日常运营",
    });

    const manager = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await waitFor(() => manager.wait.mock.calls.length === 1);

    const runningStatus = await tool.execute("call-status-running", {
      action: "status",
      accountId: "work",
      jobId: String((startResult.details as Record<string, unknown>).jobId),
    });

    expect(runningStatus.details).toMatchObject({
      worker: {
        workerSessionKey,
      },
    });

    const workerPath = path.join(
      stateDir,
      "plugins",
      "yunying",
      "workers",
      `${encodeURIComponent(deviceKey)}.json`,
    );
    const persistedWorker = JSON.parse(await fs.readFile(workerPath, "utf8")) as Record<string, unknown>;
    expect(persistedWorker.workerSessionKey).toBe(workerSessionKey);
  });

  it("starts a background job and calls phone.run", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir);
    const tool = createYunyingTool(fakeApi({ skillsDir }));

    const result = await tool.execute("call2", {
      action: "start",
      goal: "今天开始小红书日常运营",
    });

    expect(result.details).toMatchObject({
      accepted: true,
      skill: { id: "demo-skill" },
    });

    const manager = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await waitFor(() => manager.wait.mock.calls.length === 1);
    expect(manager.run).toHaveBeenCalledTimes(1);
    expect(manager.wait).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        runId: "run-1",
      }),
    );

    const jobId = String((result.details as Record<string, unknown>).jobId);
    const logPath = path.join(stateDir, "plugins", "yunying", "jobs", `${jobId}.jsonl`);
    await waitFor(async () => (await fs.readFile(logPath, "utf8")).includes("runtime.end"));
    const logText = await fs.readFile(logPath, "utf8");
    expect(logText).toContain("\"type\":\"runtime.log\"");
    expect(logText).toContain("\"type\":\"runtime.end\"");

    const artifactsRoot = path.join(stateDir, "plugins", "yunying", "artifacts", jobId);
    await waitFor(async () => {
      try {
        const summaryText = await fs.readFile(path.join(artifactsRoot, "_summary.json"), "utf8");
        return JSON.parse(summaryText).status === "completed";
      } catch {
        return false;
      }
    });
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactsRoot, "_summary.json"), "utf8"),
    ) as Record<string, unknown>;
    const stageArtifact = JSON.parse(
      await fs.readFile(path.join(artifactsRoot, `${encodeURIComponent("stage-1")}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      status: "completed",
      completedStageCount: 1,
      totalStageCount: 1,
      lastRunId: "run-1",
    });
    expect(stageArtifact).toMatchObject({
      stageId: "stage-1",
      status: "completed",
      runtimeEventCount: 2,
    });
    expect(stageArtifact.runtimeEventTypes).toEqual(
      expect.arrayContaining(["runtime.log", "runtime.end"]),
    );

    const statusResult = await tool.execute("call2-status", {
      action: "status",
      accountId: "work",
      jobId,
    });
    expect(statusResult.details).toMatchObject({
      worker: {
        state: "idle",
        desiredGoal: "今天开始小红书日常运营",
      },
      summary: {
        status: "completed",
        completedStageCount: 1,
      },
    });
    expect(
      (statusResult.details as { worker?: Record<string, unknown> }).worker?.progressSummary,
    ).toContain("Job completed");
    expect((statusResult.details as { artifacts?: Array<Record<string, unknown>> }).artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stageId: "stage-1",
          status: "completed",
        }),
      ]),
    );
  });

  it("resumes a partial job from the remaining stages", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir, [
      {
        id: "stage-1",
        name: "Stage One",
        objective: "Do the first step",
        actions: ["Open app"],
        completionCriteria: ["Reached target screen"],
      },
      {
        id: "stage-2",
        name: "Stage Two",
        objective: "Do the second step",
        actions: ["Open feed"],
        completionCriteria: ["Reached feed"],
      },
    ]);

    const root = path.join(stateDir, "plugins", "yunying");
    await fs.mkdir(path.join(root, "jobs"), { recursive: true });
    await fs.writeFile(
      path.join(root, "jobs", "job-partial.json"),
      JSON.stringify({
        jobId: "job-partial",
        deviceKey: "device:55CQSWHYW4NJGAXW",
        accountId: "work",
        deviceId: "55CQSWHYW4NJGAXW",
        skillId: "demo-skill",
        skillName: "Demo Skill",
        platform: "xiaohongshu",
        goal: "继续今天的小红书运营",
        status: "failed",
        createdAt: "2026-03-09T06:00:00.000Z",
        updatedAt: "2026-03-09T06:05:00.000Z",
        completedStages: ["stage-1"],
        currentStageId: "stage-2",
        currentStageName: "Stage Two",
        lastRunId: "run-partial",
        error: "context limit reached",
      }),
      "utf8",
    );

    const tool = createYunyingTool(fakeApi({ skillsDir }));
    const result = await tool.execute("call-resume", {
      action: "resume",
      accountId: "work",
    });

    expect(result.details).toMatchObject({
      accepted: true,
      resumed: true,
      sourceJobId: "job-partial",
      remainingStageCount: 1,
      skill: {
        id: "demo-skill",
        stageCount: 1,
      },
    });

    const manager = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await waitFor(() => manager.wait.mock.calls.length === 1);
    expect(manager.run).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        task: expect.stringContaining("当前阶段：Stage Two"),
      }),
    );

    const resumedJobId = String((result.details as Record<string, unknown>).jobId);
    const resumedJobPath = path.join(root, "jobs", `${resumedJobId}.json`);
    let resumedJob: Record<string, unknown> | undefined;
    await waitFor(async () => {
      try {
        resumedJob = JSON.parse(await fs.readFile(resumedJobPath, "utf8")) as Record<string, unknown>;
        return true;
      } catch {
        return false;
      }
    });
    expect(resumedJob).toBeTruthy();
    expect(resumedJob?.resumedFromJobId).toBe("job-partial");

    const resumedLog = await fs.readFile(path.join(root, "jobs", `${resumedJobId}.jsonl`), "utf8");
    expect(resumedLog).toContain("\"type\":\"job.resumed_from\"");
  });

  it("marks the accepted job as failed if the phone manager cannot start", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir);

    (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("runtime bootstrap failed");
    });

    const tool = createYunyingTool(fakeApi({ skillsDir }));
    await expect(
      tool.execute("call-start-fail", {
        action: "start",
        goal: "今天开始小红书日常运营",
      }),
    ).rejects.toThrow("runtime bootstrap failed");

    const root = path.join(stateDir, "plugins", "yunying");
    const [jobFile] = (await fs.readdir(path.join(root, "jobs"))).filter((entry) =>
      entry.endsWith(".json"),
    );
    const job = JSON.parse(await fs.readFile(path.join(root, "jobs", jobFile), "utf8")) as Record<
      string,
      unknown
    >;
    const device = JSON.parse(
      await fs.readFile(
        path.join(root, "devices", `${encodeURIComponent("device:55CQSWHYW4NJGAXW")}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;

    expect(job).toMatchObject({
      status: "failed",
      error: "runtime bootstrap failed",
    });
    expect(job).not.toHaveProperty("currentRunId");
    expect(device).toMatchObject({
      state: "failed",
    });
    expect(device).not.toHaveProperty("activeJobId");
    expect(device).not.toHaveProperty("activeRunId");

    const summary = JSON.parse(
      await fs.readFile(path.join(root, "artifacts", String(job.jobId), "_summary.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      status: "failed",
      message: "runtime bootstrap failed",
    });
  });

  it("stops the active yunying run with its recorded runId", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir);

    let releaseWait: (() => void) | undefined;
    (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      discover: vi.fn(async () => ({
        devices: [{ deviceId: "55CQSWHYW4NJGAXW", state: "device" }],
      })),
      run: vi.fn(async () => ({
        ok: true,
        runId: "run-stop-1",
        completed: false,
        status: "accepted",
      })),
      wait: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseWait = () =>
              resolve({
                ok: false,
                completed: true,
                status: "stopped",
                runId: "run-stop-1",
                message: "Stopped by yunying.stop",
              });
          }),
      ),
      stop: vi.fn(async () => {
        releaseWait?.();
        return {
          ok: true,
          stopped: true,
        };
      }),
    }));

    const tool = createYunyingTool(fakeApi({ skillsDir }));
    await tool.execute("call-start", {
      action: "start",
      goal: "今天开始小红书日常运营",
    });

    await waitFor(() => {
      const manager = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      return Boolean(manager?.wait?.mock.calls.length === 1);
    });

    const stopResult = await tool.execute("call-stop", {
      action: "stop",
      accountId: "work",
    });

    const managerCalls = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results;
    const stopManager = managerCalls[1]?.value;
    expect(stopManager.stop).toHaveBeenCalledWith({
      accountId: "work",
      runId: "run-stop-1",
    });
    expect(stopResult.details).toMatchObject({
      ok: true,
      stopped: true,
    });

    const root = path.join(stateDir, "plugins", "yunying");
    const [jobFile] = (await fs.readdir(path.join(root, "jobs"))).filter((entry) =>
      entry.endsWith(".json"),
    );
    const job = JSON.parse(await fs.readFile(path.join(root, "jobs", jobFile), "utf8")) as Record<
      string,
      unknown
    >;
    expect(job).toMatchObject({
      status: "stopped",
    });
    expect(job).not.toHaveProperty("currentRunId");

    const artifactsRoot = path.join(root, "artifacts", String(job.jobId));
    const summary = JSON.parse(
      await fs.readFile(path.join(artifactsRoot, "_summary.json"), "utf8"),
    ) as Record<string, unknown>;
    const stageArtifact = JSON.parse(
      await fs.readFile(path.join(artifactsRoot, `${encodeURIComponent("stage-1")}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      status: "stopped",
      message: "Stopped by yunying.stop",
    });
    expect(stageArtifact).toMatchObject({
      status: "stopped",
      runId: "run-stop-1",
      message: "Stopped by yunying.stop",
    });

    const statusResult = await tool.execute("call-stop-status", {
      action: "status",
      accountId: "work",
      jobId: String(job.jobId),
    });
    expect(statusResult.details).toMatchObject({
      worker: {
        state: "stopped",
        progressSummary: "Stopped by yunying.stop",
      },
    });
  });

  it("returns configured, running, missing, and offline devices in fleet view", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir);

    let releaseWait: (() => void) | undefined;

    (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      discover: vi.fn(async (accountId?: string) => ({
        devices:
          accountId === "work"
            ? [{ deviceId: "55CQSWHYW4NJGAXW", state: "device", label: "Work Phone" }]
            : accountId === "lab"
              ? []
              : accountId === "offline"
                ? [{ deviceId: "emulator-5554", state: "offline", label: "Offline Phone" }]
                : [],
      })),
      run: vi.fn(async () => ({
        ok: true,
        runId: "run-work",
        completed: false,
        status: "accepted",
      })),
      wait: vi.fn(
        async () =>
          await new Promise((resolve) => {
            releaseWait = () =>
              resolve({
                ok: true,
                completed: true,
                status: "completed",
                runId: "run-work",
              });
          }),
      ),
      stop: vi.fn(),
    }));

    const tool = createYunyingTool(
      fakeApi(
        { skillsDir },
        {
          phones: {
            defaultAccountId: "work",
            accounts: {
              work: { name: "Work Phone", deviceId: "55CQSWHYW4NJGAXW" },
              lab: { name: "Lab Phone", deviceId: "device-missing" },
              offline: { name: "Offline Phone", deviceId: "emulator-5554" },
              idle: { name: "Idle Phone" },
            },
          },
        },
      ),
    );

    await tool.execute("call-start", {
      action: "start",
      accountId: "work",
      goal: "今天开始小红书日常运营",
    });
    await waitFor(() => {
      const manager = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
      return Boolean(manager?.wait?.mock.calls.length === 1);
    });

    const result = await tool.execute("call-fleet", { action: "fleet" });
    const devices = (result.details as { devices?: Array<Record<string, unknown>> }).devices ?? [];

    expect(devices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: "work",
          displayName: "Work Phone",
          status: "running",
          runtimeDeviceState: "device",
          configuredDeviceId: "55CQSWHYW4NJGAXW",
          worker: expect.objectContaining({
            state: "running",
            activeJobId: expect.any(String),
          }),
          brain: expect.objectContaining({
            displayName: "Work Phone",
          }),
        }),
        expect.objectContaining({
          accountId: "lab",
          status: "missing",
          configuredDeviceId: "device-missing",
        }),
        expect.objectContaining({
          accountId: "offline",
          status: "offline",
          runtimeDeviceState: "offline",
        }),
        expect.objectContaining({
          accountId: "idle",
          status: "idle",
        }),
      ]),
    );
    releaseWait?.();
  });

  it("renames a worker and can send a message to its brain session", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir);
    const tool = createYunyingTool(fakeApi({ skillsDir }));

    const renameResult = await tool.execute("call-rename", {
      action: "rename",
      accountId: "work",
      name: "小红书1号机",
    });
    expect(renameResult.details).toMatchObject({
      ok: true,
      displayName: "小红书1号机",
      worker: {
        displayName: "小红书1号机",
      },
      brain: {
        displayName: "小红书1号机",
      },
    });

    const brainResult = await tool.execute("call-brain-send", {
      action: "brainSend",
      accountId: "work",
      message: "总结一下当前运营重点",
    });
    expect(runAgentStep).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "总结一下当前运营重点",
        sessionKey: buildWorkerSessionKey("device:55CQSWHYW4NJGAXW"),
      }),
    );
    expect(brainResult.details).toMatchObject({
      ok: true,
      action: "brainSend",
      displayName: "小红书1号机",
      reply: "brain:总结一下当前运营重点",
      brain: {
        displayName: "小红书1号机",
      },
    });
  });

  it("backfills workerSessionKey for legacy worker records", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    const root = path.join(stateDir, "plugins", "yunying");
    const deviceKey = "device:55CQSWHYW4NJGAXW";
    await fs.mkdir(path.join(root, "workers"), { recursive: true });
    await fs.writeFile(
      path.join(root, "workers", `${encodeURIComponent(deviceKey)}.json`),
      JSON.stringify({
        workerId: `worker:${deviceKey}`,
        deviceKey,
        accountId: "work",
        deviceId: "55CQSWHYW4NJGAXW",
        state: "idle",
        progressSummary: "legacy worker",
        updatedAt: "2026-03-09T06:00:00.000Z",
      }),
      "utf8",
    );

    const tool = createYunyingTool(fakeApi({}));
    const result = await tool.execute("call-status-legacy-worker", {
      action: "status",
      accountId: "work",
    });

    expect(result.details).toMatchObject({
      worker: {
        workerSessionKey: buildWorkerSessionKey(deviceKey),
        progressSummary: "legacy worker",
      },
    });

    const persistedWorker = JSON.parse(
      await fs.readFile(path.join(root, "workers", `${encodeURIComponent(deviceKey)}.json`), "utf8"),
    ) as Record<string, unknown>;
    expect(persistedWorker.workerSessionKey).toBe(buildWorkerSessionKey(deviceKey));
  });

  it("reconciles stale running jobs after restart", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    const root = path.join(stateDir, "plugins", "yunying");
    await fs.mkdir(path.join(root, "devices"), { recursive: true });
    await fs.mkdir(path.join(root, "jobs"), { recursive: true });

    await fs.writeFile(
      path.join(root, "devices", `${encodeURIComponent("device:55CQSWHYW4NJGAXW")}.json`),
      JSON.stringify({
        deviceKey: "device:55CQSWHYW4NJGAXW",
        accountId: "work",
        deviceId: "55CQSWHYW4NJGAXW",
        activeJobId: "job-stale",
        activeRunId: "run-stale",
        state: "running",
        updatedAt: "2026-03-09T06:00:00.000Z",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "jobs", "job-stale.json"),
      JSON.stringify({
        jobId: "job-stale",
        deviceKey: "device:55CQSWHYW4NJGAXW",
        accountId: "work",
        deviceId: "55CQSWHYW4NJGAXW",
        skillId: "demo-skill",
        skillName: "Demo Skill",
        platform: "xiaohongshu",
        goal: "stale",
        status: "running",
        createdAt: "2026-03-09T05:59:00.000Z",
        updatedAt: "2026-03-09T06:00:00.000Z",
        completedStages: [],
        currentStageId: "stage-1",
        currentStageName: "Stage One",
        currentRunId: "run-stale",
      }),
      "utf8",
    );

    const tool = createYunyingTool(fakeApi({}));
    const result = await tool.execute("call-status", {
      action: "status",
      accountId: "work",
      jobId: "job-stale",
    });

    expect(result.details).toMatchObject({
      job: {
        jobId: "job-stale",
        status: "failed",
        error: "Recovered stale yunying job after process restart",
      },
      summary: {
        status: "failed",
        recoveryAction: "stale_failed",
      },
      worker: {
        state: "recovering",
        lastError: "Recovered stale yunying job after process restart",
        resumeSourceJobId: "job-stale",
        nextWakeAt: expect.any(String),
      },
      device: {
        deviceKey: "device:55CQSWHYW4NJGAXW",
        state: "failed",
      },
    });

    const logText = await fs.readFile(path.join(root, "jobs", "job-stale.jsonl"), "utf8");
    expect(logText).toContain("\"type\":\"job.recovered_stale\"");
    const summary = JSON.parse(
      await fs.readFile(path.join(root, "artifacts", "job-stale", "_summary.json"), "utf8"),
    ) as Record<string, unknown>;
    const stageArtifact = JSON.parse(
      await fs.readFile(
        path.join(root, "artifacts", "job-stale", `${encodeURIComponent("stage-1")}.json`),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(summary).toMatchObject({
      status: "failed",
      recoveryAction: "stale_failed",
    });
    expect(stageArtifact).toMatchObject({
      status: "recovered_stale",
      runId: "run-stale",
    });
  });
});
