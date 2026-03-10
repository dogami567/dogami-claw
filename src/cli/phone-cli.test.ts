import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

const listMock = vi.fn(() => ({
  defaultAccountId: "work",
  accounts: [
    {
      id: "work",
      name: "Work Phone",
      enabled: true,
      provider: "autoglm",
      deviceId: "emulator-5554",
      deviceType: "adb",
      apiUrl: "http://127.0.0.1:8001/api",
      uiUrl: undefined,
    },
  ],
}));
const discoverMock = vi.fn(async () => ({
  count: 1,
  devices: [
    {
      deviceId: "55CQSWHYW4NJGAXW",
      state: "device",
      configuredAccountId: "work",
      suggestedAccountId: "work",
      autoPickEligible: false,
    },
  ],
}));
const statusMock = vi.fn(async () => ({
  ok: true,
  account: { id: "work" },
  runtime: { provider: "autoglm" },
  health: { ok: true },
  devices: { count: 1 },
}));
const checkMock = vi.fn(async () => ({
  account: { id: "work" },
  runtime: { provider: "autoglm" },
  check: { overall: "pass" },
}));
const runMock = vi.fn(async (request: unknown) => ({
  ok: true,
  runId: "run-1",
  request,
}));
const stopMock = vi.fn(async () => ({
  ok: true,
  stopped: true,
}));

const runtimeLogs: string[] = [];
const runtimeErrors: string[] = [];

vi.mock("../phone/manager.js", () => ({
  createPhoneManager: () => ({
    list: listMock,
    discover: discoverMock,
    status: statusMock,
    check: checkMock,
    run: runMock,
    stop: stopMock,
  }),
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: {
    log: (msg: string) => runtimeLogs.push(String(msg)),
    error: (msg: string) => runtimeErrors.push(String(msg)),
    exit: (code: number) => {
      throw new Error(`__exit__:${code}`);
    },
  },
}));

describe("phone cli", () => {
  it("registers phone list and prints JSON", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    const { registerPhoneCli } = await import("./phone-cli.js");
    const program = new Command();
    program.exitOverride();
    registerPhoneCli(program);

    await program.parseAsync(["phone", "list", "--json"], { from: "user" });

    expect(listMock).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"defaultAccountId": "work"');
  });

  it("maps run options into a normalized request", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    runMock.mockClear();

    const { registerPhoneCli } = await import("./phone-cli.js");
    const program = new Command();
    program.exitOverride();
    registerPhoneCli(program);

    await program.parseAsync(
      [
        "phone",
        "run",
        "--account",
        " work ",
        "--task",
        " 打开小红书 ",
        "--mode",
        "monitor",
        "--max-steps",
        "12",
        "--max-rounds",
        "6",
        "--executor-max-steps",
        "3",
        "--lang",
        " cn ",
        "--device",
        " emulator-5554 ",
        "--json",
      ],
      { from: "user" },
    );

    expect(runMock).toHaveBeenCalledTimes(1);
    expect(runMock.mock.calls[0]?.[0]).toEqual({
      accountId: "work",
      task: "打开小红书",
      goal: undefined,
      mode: "monitor",
      waitForCompletion: undefined,
      waitTimeoutMs: undefined,
      deviceId: "emulator-5554",
      deviceType: undefined,
      lang: "cn",
      maxSteps: 12,
      maxRounds: 6,
      executorMaxSteps: 3,
      simulate: undefined,
      dryRun: undefined,
      temperature: undefined,
      baseUrl: undefined,
      model: undefined,
      apiKey: undefined,
      monitorBaseUrl: undefined,
      monitorModel: undefined,
      monitorApiKey: undefined,
      monitorUseScreenshot: undefined,
      monitorTemperature: undefined,
      monitorPrompt: undefined,
    });
    expect(runtimeLogs.join("\n")).toContain('"runId": "run-1"');
  });

  it("registers phone discover and prints JSON", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    discoverMock.mockClear();
    const { registerPhoneCli } = await import("./phone-cli.js");
    const program = new Command();
    program.exitOverride();
    registerPhoneCli(program);

    await program.parseAsync(["phone", "discover", "--account", "work", "--json"], {
      from: "user",
    });

    expect(discoverMock).toHaveBeenCalledWith("work");
    expect(runtimeLogs.join("\n")).toContain('"suggestedAccountId": "work"');
  });

  it("passes wait flags through to phone.run", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    runMock.mockClear();

    const { registerPhoneCli } = await import("./phone-cli.js");
    const program = new Command();
    program.exitOverride();
    registerPhoneCli(program);

    await program.parseAsync(
      ["phone", "run", "--task", "打开设置", "--wait", "--wait-timeout-ms", "45000", "--json"],
      { from: "user" },
    );

    expect(runMock).toHaveBeenCalledWith(
      expect.objectContaining({
        task: "打开设置",
        waitForCompletion: true,
        waitTimeoutMs: 45000,
      }),
    );
  });
});
