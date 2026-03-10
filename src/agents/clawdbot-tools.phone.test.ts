import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createPhoneManagerMock,
  listMock,
  discoverMock,
  statusMock,
  checkMock,
  screenMock,
  runMock,
  stopMock,
} = vi.hoisted(() => ({
  createPhoneManagerMock: vi.fn(),
  listMock: vi.fn(),
  discoverMock: vi.fn(),
  statusMock: vi.fn(),
  checkMock: vi.fn(),
  screenMock: vi.fn(),
  runMock: vi.fn(),
  stopMock: vi.fn(),
}));

vi.mock("../phone/manager.js", () => ({
  createPhoneManager: createPhoneManagerMock,
}));

import "./test-helpers/fast-core-tools.js";
import { createClawdbotTools } from "./clawdbot-tools.js";

describe("phone tool", () => {
  beforeEach(() => {
    listMock.mockReset();
    discoverMock.mockReset();
    statusMock.mockReset();
    checkMock.mockReset();
    screenMock.mockReset();
    runMock.mockReset();
    stopMock.mockReset();
    createPhoneManagerMock.mockReset();
    createPhoneManagerMock.mockReturnValue({
      list: listMock,
      discover: discoverMock,
      status: statusMock,
      check: checkMock,
      screen: screenMock,
      run: runMock,
      stop: stopMock,
    });
  });

  it("registers the phone tool and proxies list", async () => {
    listMock.mockReturnValue({
      defaultAccountId: "work",
      accounts: [{ id: "work" }],
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    const result = await tool.execute("call1", { action: "list" });
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(result.details).toMatchObject({
      defaultAccountId: "work",
    });
  });

  it("proxies discover for device templating", async () => {
    discoverMock.mockResolvedValue({
      count: 1,
      devices: [{ deviceId: "55CQSWHYW4NJGAXW", suggestedAccountId: "work" }],
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    const result = await tool.execute("call-discover", { action: "discover", accountId: "work" });
    expect(discoverMock).toHaveBeenCalledWith("work");
    expect(result.details).toMatchObject({
      count: 1,
      devices: [{ suggestedAccountId: "work" }],
    });
  });

  it("maps monitor-style runs and auto-promotes goal-only requests", async () => {
    runMock.mockResolvedValue({
      ok: true,
      runId: "run-123",
      raw: { ok: true },
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    await tool.execute("call2", {
      action: "run",
      accountId: "work",
      goal: "打开设置并检查通知权限",
      maxRounds: 4,
      monitorUseScreenshot: true,
      simulate: true,
    });

    expect(runMock).toHaveBeenCalledWith({
      accountId: "work",
      mode: "monitor",
      goal: "打开设置并检查通知权限",
      task: undefined,
      waitForCompletion: true,
      waitTimeoutMs: undefined,
      deviceId: undefined,
      deviceType: undefined,
      lang: undefined,
      maxSteps: undefined,
      maxRounds: 4,
      executorMaxSteps: undefined,
      simulate: true,
      dryRun: undefined,
      temperature: undefined,
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      monitorBaseUrl: undefined,
      monitorModel: undefined,
      monitorApiKey: undefined,
      monitorUseScreenshot: true,
      monitorTemperature: undefined,
      monitorPrompt: undefined,
      includeScreenshot: true,
    });
  });

  it("returns the current phone screen as an image tool result", async () => {
    screenMock.mockResolvedValue({
      ok: true,
      screenshot: {
        deviceId: "55CQSWHYW4NJGAXW",
        mimeType: "image/png",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
        bytes: 68,
      },
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    const result = await tool.execute("call-screen", {
      action: "screen",
      accountId: "work",
      deviceId: "55CQSWHYW4NJGAXW",
    });

    expect(screenMock).toHaveBeenCalledWith({
      accountId: "work",
      deviceId: "55CQSWHYW4NJGAXW",
      deviceType: undefined,
    });
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]),
    );
  });

  it("rejects empty phone.run requests with a clear error", async () => {
    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    await expect(tool.execute("call3", { action: "run", accountId: "work" })).rejects.toThrow(
      "phone.run requires task or goal",
    );
    expect(runMock).not.toHaveBeenCalled();
  });

  it("throws when phone.run completes with a runtime failure", async () => {
    runMock.mockResolvedValue({
      ok: false,
      status: "failed",
      completed: true,
      message: "Model error: Unknown Model",
      raw: { ok: true, run_id: "run-404" },
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    await expect(
      tool.execute("call4", {
        action: "run",
        accountId: "work",
        task: "Inspect current screen only",
      }),
    ).rejects.toThrow("Model error: Unknown Model");
  });

  it("clamps short waitTimeoutMs values for completion runs", async () => {
    runMock.mockResolvedValue({
      ok: true,
      status: "accepted",
      completed: false,
      runId: "run-125",
      raw: { ok: true, run_id: "run-125" },
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    await tool.execute("call5", {
      action: "run",
      accountId: "work",
      task: "打开手机设置应用",
      waitForCompletion: true,
      waitTimeoutMs: 20_000,
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        waitForCompletion: true,
        waitTimeoutMs: 60_000,
      }),
    );
  });

  it("attaches a screenshot to phone.run when includeScreenshot=true", async () => {
    runMock.mockResolvedValue({
      ok: true,
      status: "completed",
      completed: true,
      runId: "run-126",
      screenshot: {
        deviceId: "55CQSWHYW4NJGAXW",
        mimeType: "image/png",
        base64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
        bytes: 68,
      },
      raw: { ok: true, run_id: "run-126" },
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    const result = await tool.execute("call6", {
      action: "run",
      accountId: "work",
      task: "打开设置",
      includeScreenshot: true,
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeScreenshot: true,
      }),
    );
    expect(result.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "text" }),
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]),
    );
  });

  it("lets callers opt out of the default completion screenshot", async () => {
    runMock.mockResolvedValue({
      ok: true,
      status: "completed",
      completed: true,
      runId: "run-127",
      raw: { ok: true, run_id: "run-127" },
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "phone");
    expect(tool).toBeDefined();
    if (!tool) throw new Error("missing phone tool");

    await tool.execute("call7", {
      action: "run",
      accountId: "work",
      task: "打开设置",
      includeScreenshot: false,
    });

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includeScreenshot: false,
      }),
    );
  });
});
