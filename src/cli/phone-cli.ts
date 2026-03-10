import type { Command } from "commander";

import { createPhoneManager } from "../phone/manager.js";
import { defaultRuntime } from "../runtime.js";
import { renderTable } from "../terminal/table.js";
import { colorize, isRich, theme } from "../terminal/theme.js";
import type { PhoneDiscoverResult, PhoneMode, PhoneRunRequest } from "../phone/types.js";
import { withProgress } from "./progress.js";
import { runCommandWithRuntime } from "./cli-utils.js";

type PhoneCommandOpts = {
  account?: string;
  json?: boolean;
  task?: string;
  goal?: string;
  mode?: string;
  wait?: boolean;
  waitTimeoutMs?: string;
  device?: string;
  deviceType?: string;
  lang?: string;
  maxSteps?: string;
  maxRounds?: string;
  executorMaxSteps?: string;
  simulate?: boolean;
  dryRun?: boolean;
  temperature?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  monitorBaseUrl?: string;
  monitorModel?: string;
  monitorApiKey?: string;
  monitorUseScreenshot?: boolean;
  monitorTemperature?: string;
  monitorPrompt?: string;
};

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseOptionalInt(value: unknown, label: string): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function parseOptionalFloat(value: unknown, label: string): number | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return parsed;
}

function parseMode(value: unknown): PhoneMode | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return undefined;
  if (normalized === "direct" || normalized === "monitor") return normalized;
  throw new Error(`mode must be "direct" or "monitor"`);
}

function printJsonOrHuman(value: unknown, json?: boolean) {
  if (json) {
    defaultRuntime.log(JSON.stringify(value, null, 2));
    return;
  }
  defaultRuntime.log(JSON.stringify(value, null, 2));
}

function printDiscoverResult(result: PhoneDiscoverResult, json?: boolean) {
  if (json) {
    defaultRuntime.log(JSON.stringify(result, null, 2));
    return;
  }

  const rich = isRich();
  defaultRuntime.log(colorize(rich, theme.heading, "Discovered Devices"));
  defaultRuntime.log(
    `${colorize(rich, theme.muted, "Via account:")} ${result.account.id}  ${colorize(
      rich,
      theme.muted,
      "Runtime:",
    )} ${result.runtime.apiUrl ?? result.runtime.uiUrl ?? result.runtime.provider}`,
  );

  if (result.devices.length === 0) {
    defaultRuntime.log(colorize(rich, theme.muted, "No devices reported by the runtime."));
    return;
  }

  defaultRuntime.log(
    renderTable({
      width: Math.max(90, (process.stdout.columns ?? 120) - 1),
      columns: [
        { key: "Device", header: "Device", minWidth: 18, flex: true },
        { key: "State", header: "State", minWidth: 8 },
        { key: "Type", header: "Type", minWidth: 8 },
        { key: "Configured", header: "Configured", minWidth: 12 },
        { key: "Suggested", header: "Suggested", minWidth: 18, flex: true },
        { key: "Auto", header: "Auto", minWidth: 6 },
      ],
      rows: result.devices.map((device) => ({
        Device: device.deviceId,
        State: device.state ?? "",
        Type: device.deviceType ?? result.deviceType ?? "",
        Configured: device.configuredAccountId ?? "",
        Suggested: device.suggestedAccountId,
        Auto: device.autoPickEligible ? "yes" : "no",
      })),
    }).trimEnd(),
  );
}

function runPhoneCommand(action: () => Promise<void>) {
  return runCommandWithRuntime(defaultRuntime, action, (error) => {
    defaultRuntime.error(String(error));
    defaultRuntime.exit(1);
  });
}

function buildRunRequest(opts: PhoneCommandOpts): PhoneRunRequest {
  return {
    accountId: normalizeOptionalString(opts.account),
    task: normalizeOptionalString(opts.task),
    goal: normalizeOptionalString(opts.goal),
    mode: parseMode(opts.mode),
    waitForCompletion: opts.wait === true ? true : undefined,
    waitTimeoutMs: parseOptionalInt(opts.waitTimeoutMs, "--wait-timeout-ms"),
    deviceId: normalizeOptionalString(opts.device),
    deviceType: normalizeOptionalString(opts.deviceType),
    lang: normalizeOptionalString(opts.lang),
    maxSteps: parseOptionalInt(opts.maxSteps, "--max-steps"),
    maxRounds: parseOptionalInt(opts.maxRounds, "--max-rounds"),
    executorMaxSteps: parseOptionalInt(opts.executorMaxSteps, "--executor-max-steps"),
    simulate: opts.simulate === true ? true : undefined,
    dryRun: opts.dryRun === true ? true : undefined,
    temperature: parseOptionalFloat(opts.temperature, "--temperature"),
    baseUrl: normalizeOptionalString(opts.baseUrl),
    model: normalizeOptionalString(opts.model),
    apiKey: normalizeOptionalString(opts.apiKey),
    monitorBaseUrl: normalizeOptionalString(opts.monitorBaseUrl),
    monitorModel: normalizeOptionalString(opts.monitorModel),
    monitorApiKey: normalizeOptionalString(opts.monitorApiKey),
    monitorUseScreenshot: opts.monitorUseScreenshot === true ? true : undefined,
    monitorTemperature: parseOptionalFloat(opts.monitorTemperature, "--monitor-temperature"),
    monitorPrompt: normalizeOptionalString(opts.monitorPrompt),
  };
}

export function registerPhoneCli(program: Command) {
  const phone = program.command("phone").description("Local phone runtime control");

  phone
    .command("list")
    .description("List configured phone accounts")
    .option("--json", "Output JSON", false)
    .action(async (opts: PhoneCommandOpts) => {
      await runPhoneCommand(async () => {
        const result = createPhoneManager().list();
        if (opts.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const rich = isRich();
        defaultRuntime.log(colorize(rich, theme.heading, "Phone Accounts"));
        if (result.defaultAccountId) {
          defaultRuntime.log(
            `${colorize(rich, theme.muted, "Default:")} ${result.defaultAccountId}`,
          );
        }
        if (result.accounts.length === 0) {
          defaultRuntime.log(colorize(rich, theme.muted, "No phone accounts configured."));
          return;
        }
        defaultRuntime.log(
          renderTable({
            width: Math.max(70, (process.stdout.columns ?? 120) - 1),
            columns: [
              { key: "Account", header: "Account", minWidth: 12 },
              { key: "Name", header: "Name", minWidth: 12, flex: true },
              { key: "Enabled", header: "Enabled", minWidth: 8 },
              { key: "Provider", header: "Provider", minWidth: 10 },
              { key: "Device", header: "Device", minWidth: 14, flex: true },
              { key: "API", header: "API", minWidth: 18, flex: true },
            ],
            rows: result.accounts.map((account) => ({
              Account: account.id,
              Name: account.name,
              Enabled: account.enabled ? "yes" : "no",
              Provider: account.provider,
              Device: account.deviceId ?? "",
              API: account.apiUrl ?? account.uiUrl ?? "",
            })),
          }).trimEnd(),
        );
      });
    });

  phone
    .command("discover")
    .description("Discover devices reported by the configured phone runtime")
    .option("--account <id>", "Phone account id")
    .option("--json", "Output JSON", false)
    .action(async (opts: PhoneCommandOpts) => {
      await runPhoneCommand(async () => {
        const result = await withProgress(
          {
            label: "Phone discover",
            indeterminate: true,
            enabled: opts.json !== true,
          },
          async () => await createPhoneManager().discover(normalizeOptionalString(opts.account)),
        );
        printDiscoverResult(result, opts.json);
      });
    });

  phone
    .command("status")
    .description("Check runtime health + device discovery for a phone account")
    .option("--account <id>", "Phone account id")
    .option("--json", "Output JSON", false)
    .action(async (opts: PhoneCommandOpts) => {
      await runPhoneCommand(async () => {
        const result = await withProgress(
          {
            label: "Phone status",
            indeterminate: true,
            enabled: opts.json !== true,
          },
          async () => await createPhoneManager().status(normalizeOptionalString(opts.account)),
        );
        printJsonOrHuman(result, opts.json);
      });
    });

  phone
    .command("check")
    .description("Run the runtime connectivity check (ADB + device + screenshot/input)")
    .option("--account <id>", "Phone account id")
    .option("--json", "Output JSON", false)
    .action(async (opts: PhoneCommandOpts) => {
      await runPhoneCommand(async () => {
        const result = await withProgress(
          {
            label: "Phone check",
            indeterminate: true,
            enabled: opts.json !== true,
          },
          async () => await createPhoneManager().check(normalizeOptionalString(opts.account)),
        );
        printJsonOrHuman(result, opts.json);
      });
    });

  phone
    .command("run")
    .description("Start a phone task through the configured runtime")
    .option("--account <id>", "Phone account id")
    .option("--task <text>", "Direct task text")
    .option("--goal <text>", "Monitor mode goal text")
    .option("--mode <mode>", 'Execution mode ("direct" or "monitor")')
    .option("--wait", "Wait for the runtime to finish before returning", false)
    .option("--wait-timeout-ms <n>", "Max time to wait for runtime completion")
    .option("--device <id>", "Device id / ADB serial override")
    .option("--device-type <type>", "Device transport type override")
    .option("--lang <lang>", "Language hint")
    .option("--max-steps <n>", "Executor max steps")
    .option("--max-rounds <n>", "Monitor max rounds")
    .option("--executor-max-steps <n>", "Executor burst max steps in monitor mode")
    .option("--simulate", "Enable runtime simulate mode", false)
    .option("--dry-run", "Enable runtime dry_run mode", false)
    .option("--temperature <n>", "Executor temperature")
    .option("--base-url <url>", "Executor model base URL")
    .option("--model <name>", "Executor model name")
    .option("--api-key <key>", "Executor model API key")
    .option("--monitor-base-url <url>", "Monitor model base URL")
    .option("--monitor-model <name>", "Monitor model name")
    .option("--monitor-api-key <key>", "Monitor model API key")
    .option("--monitor-use-screenshot", "Enable monitor screenshots", false)
    .option("--monitor-temperature <n>", "Monitor temperature")
    .option("--monitor-prompt <text>", "Monitor prompt override")
    .option("--json", "Output JSON", false)
    .action(async (opts: PhoneCommandOpts) => {
      await runPhoneCommand(async () => {
        const request = buildRunRequest(opts);
        const result = await withProgress(
          {
            label: "Phone run",
            indeterminate: true,
            enabled: opts.json !== true,
          },
          async () => await createPhoneManager().run(request),
        );
        printJsonOrHuman(result, opts.json);
      });
    });

  phone
    .command("stop")
    .description("Stop the active runtime task")
    .option("--account <id>", "Phone account id")
    .option("--json", "Output JSON", false)
    .action(async (opts: PhoneCommandOpts) => {
      await runPhoneCommand(async () => {
        const result = await withProgress(
          {
            label: "Phone stop",
            indeterminate: true,
            enabled: opts.json !== true,
          },
          async () =>
            await createPhoneManager().stop({
              accountId: normalizeOptionalString(opts.account),
            }),
        );
        printJsonOrHuman(result, opts.json);
      });
    });
}
