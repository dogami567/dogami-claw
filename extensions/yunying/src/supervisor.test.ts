import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/phone/manager.js", () => ({
  createPhoneManager: vi.fn(() => ({
    discover: vi.fn(async () => ({
      devices: [{ deviceId: "55CQSWHYW4NJGAXW", state: "device", label: "Work Phone" }],
    })),
    run: vi.fn(async () => ({
      ok: true,
      runId: `run-${Math.random().toString(36).slice(2, 8)}`,
      completed: false,
      status: "accepted",
    })),
    wait: vi.fn(async ({ runId }: { runId?: string }) => ({
      ok: true,
      completed: true,
      status: "completed",
      runId: runId ?? "run-unknown",
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

import { createPhoneManager } from "../../../src/phone/manager.js";
import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { runYunyingSupervisorSweep } from "./supervisor.js";

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 400) {
  const startedAt = Date.now();
  while (!(await condition())) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("condition timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function totalRunCalls() {
  return (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results.reduce(
    (count, entry) => count + (entry.value?.run?.mock?.calls?.length ?? 0),
    0,
  );
}

async function writeSkill(
  dir: string,
  params?: {
    defaults?: Record<string, unknown>;
    stages?: Array<Record<string, unknown>>;
  },
) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "demo.skill.json"),
    JSON.stringify({
      id: "demo-skill",
      name: "Demo Skill",
      platform: "xiaohongshu",
      defaults: params?.defaults ?? {},
      stages:
        params?.stages ?? [
          {
            id: "stage-1",
            name: "Stage One",
            objective: "Do the first step",
            actions: ["Open app"],
            completionCriteria: ["Reached target screen"],
          },
        ],
      risks: [],
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

describe("yunying supervisor", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;

  beforeEach(() => {
    vi.clearAllMocks();
    if (previousStateDir === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    }
  });

  it("auto-resumes a due worker from the stored resume source", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir, {
      stages: [
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
      ],
    });

    const root = path.join(stateDir, "plugins", "yunying");
    await fs.mkdir(path.join(root, "jobs"), { recursive: true });
    await fs.mkdir(path.join(root, "workers"), { recursive: true });
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
        error: "context length exceeded",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(root, "workers", `${encodeURIComponent("device:55CQSWHYW4NJGAXW")}.json`),
      JSON.stringify({
        workerId: "worker:device:55CQSWHYW4NJGAXW",
        deviceKey: "device:55CQSWHYW4NJGAXW",
        accountId: "work",
        deviceId: "55CQSWHYW4NJGAXW",
        boundSkillId: "demo-skill",
        boundSkillName: "Demo Skill",
        state: "recovering",
        desiredGoal: "继续今天的小红书运营",
        progressSummary: "Auto-resume scheduled",
        resumeSourceJobId: "job-partial",
        resumeAttempts: 1,
        nextWakeAt: "2026-03-09T06:05:01.000Z",
        updatedAt: "2026-03-09T06:05:00.000Z",
      }),
      "utf8",
    );

    await runYunyingSupervisorSweep({
      api: fakeApi({ skillsDir }),
      root,
    });

    const manager = (createPhoneManager as unknown as ReturnType<typeof vi.fn>).mock.results[0]?.value;
    await waitFor(() => manager.run.mock.calls.length === 1);
    expect(manager.run).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "work",
        task: expect.stringContaining("当前阶段：Stage Two"),
      }),
    );

    await waitFor(async () => {
      const jobs = (await fs.readdir(path.join(root, "jobs"))).filter(
        (entry) => entry.endsWith(".json") && entry !== "job-partial.json",
      );
      return jobs.length >= 1;
    });

    const jobFiles = (await fs.readdir(path.join(root, "jobs"))).filter(
      (entry) => entry.endsWith(".json") && entry !== "job-partial.json",
    );
    const resumedJob = JSON.parse(
      await fs.readFile(path.join(root, "jobs", jobFiles[0]), "utf8"),
    ) as Record<string, unknown>;
    expect(resumedJob.resumedFromJobId).toBe("job-partial");
  });

  it("wakes a recurring worker again after the nextWakeAt deadline", async () => {
    const skillsDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-skills-"));
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-yunying-state-"));
    process.env.CLAWDBOT_STATE_DIR = stateDir;
    await writeSkill(skillsDir, {
      defaults: { repeatIntervalMs: 60_000 },
    });
    const api = fakeApi({ skillsDir });

    const { createYunyingTool } = await import("./tool.js");
    const tool = createYunyingTool(api);
    await tool.execute("call-start", {
      action: "start",
      accountId: "work",
      goal: "开始循环巡检小红书首页",
    });

    const root = path.join(stateDir, "plugins", "yunying");
    const workerPath = path.join(root, "workers", `${encodeURIComponent("device:55CQSWHYW4NJGAXW")}.json`);
    await waitFor(async () => {
      try {
        const worker = JSON.parse(await fs.readFile(workerPath, "utf8")) as Record<string, unknown>;
        return typeof worker.nextWakeAt === "string";
      } catch {
        return false;
      }
    });

    const worker = JSON.parse(await fs.readFile(workerPath, "utf8")) as Record<string, unknown>;
    await fs.writeFile(
      workerPath,
      JSON.stringify({
        ...worker,
        nextWakeAt: "2026-03-09T06:00:00.000Z",
      }, null, 2),
      "utf8",
    );

    await runYunyingSupervisorSweep({
      api,
      root,
    });

    await waitFor(() => totalRunCalls() >= 2);
    expect(totalRunCalls()).toBe(2);
  });
});
