import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { createPhoneManager } from "../../phone/manager.js";
import type {
  PhoneMode,
  PhoneRunRequest,
  PhoneRunResult,
  PhoneScreenCapture,
  PhoneScreenResult,
} from "../../phone/types.js";
import { optionalStringEnum, stringEnum } from "../schema/typebox.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { sanitizeToolResultImages } from "../tool-images.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const PHONE_TOOL_ACTIONS = [
  "list",
  "discover",
  "status",
  "check",
  "runs",
  "screen",
  "run",
  "wait",
  "stop",
] as const;
const PHONE_TOOL_MODES = ["direct", "monitor"] as const;
const MIN_PHONE_RUN_WAIT_TIMEOUT_MS = 60_000;
const DEFAULT_PHONE_TOOL_WAIT_TIMEOUT_MS = 15_000;
const MAX_PHONE_TOOL_WAIT_TIMEOUT_MS = 90_000;
const PHONE_RUN_TIMEOUT_HEADROOM_MS = 30_000;
const PHONE_BACKGROUND_DURATION_THRESHOLD_MS = 2 * 60_000;

const PhoneToolSchema = Type.Object({
  action: stringEnum(PHONE_TOOL_ACTIONS),
  accountId: Type.Optional(Type.String()),
  mode: optionalStringEnum(PHONE_TOOL_MODES),
  task: Type.Optional(Type.String()),
  goal: Type.Optional(Type.String()),
  waitForCompletion: Type.Optional(Type.Boolean()),
  waitTimeoutMs: Type.Optional(Type.Number()),
  deviceId: Type.Optional(Type.String()),
  deviceType: Type.Optional(Type.String()),
  lang: Type.Optional(Type.String()),
  maxSteps: Type.Optional(Type.Number()),
  maxRounds: Type.Optional(Type.Number()),
  executorMaxSteps: Type.Optional(Type.Number()),
  simulate: Type.Optional(Type.Boolean()),
  dryRun: Type.Optional(Type.Boolean()),
  temperature: Type.Optional(Type.Number()),
  baseUrl: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  apiKey: Type.Optional(Type.String()),
  monitorBaseUrl: Type.Optional(Type.String()),
  monitorModel: Type.Optional(Type.String()),
  monitorApiKey: Type.Optional(Type.String()),
  monitorUseScreenshot: Type.Optional(Type.Boolean()),
  monitorTemperature: Type.Optional(Type.Number()),
  monitorPrompt: Type.Optional(Type.String()),
  includeScreenshot: Type.Optional(Type.Boolean()),
  runId: Type.Optional(Type.String()),
});

function resolveRunMode(params: Record<string, unknown>): PhoneMode | undefined {
  if (params.mode === "direct" || params.mode === "monitor") {
    return params.mode;
  }
  return undefined;
}

function buildPhoneRunRequest(params: Record<string, unknown>): PhoneRunRequest {
  const task = readStringParam(params, "task");
  const goal = readStringParam(params, "goal");
  const explicitMode = resolveRunMode(params);
  const waitForCompletion =
    typeof params.waitForCompletion === "boolean" ? params.waitForCompletion : true;
  const includeScreenshot =
    typeof params.includeScreenshot === "boolean"
      ? params.includeScreenshot
      : waitForCompletion
        ? true
        : undefined;
  const waitTimeoutMs = readNumberParam(params, "waitTimeoutMs", { integer: true });
  // If only a monitor-style goal is provided, promote the request to monitor mode
  // so the agent does not have to remember the mode flag for the common case.
  const mode = explicitMode ?? (!task && goal ? "monitor" : undefined);

  if (!task && !goal) {
    throw new Error("phone.run requires task or goal");
  }
  if (mode === "direct" && !task) {
    throw new Error("phone.run requires task when mode=direct");
  }
  if (mode === "monitor" && !goal) {
    throw new Error("phone.run requires goal when mode=monitor");
  }

  return {
    accountId: readStringParam(params, "accountId"),
    mode,
    task,
    goal,
    waitForCompletion,
    // Models sometimes pick overly short waits (for example 20s) that race the
    // phone runtime and mask the actual terminal error. Keep a sane floor unless
    // waiting was explicitly disabled.
    waitTimeoutMs:
      waitForCompletion && typeof waitTimeoutMs === "number"
        ? Math.max(waitTimeoutMs, MIN_PHONE_RUN_WAIT_TIMEOUT_MS)
        : waitTimeoutMs,
    deviceId: readStringParam(params, "deviceId"),
    deviceType: readStringParam(params, "deviceType"),
    lang: readStringParam(params, "lang"),
    maxSteps: readNumberParam(params, "maxSteps", { integer: true }),
    maxRounds: readNumberParam(params, "maxRounds", { integer: true }),
    executorMaxSteps: readNumberParam(params, "executorMaxSteps", { integer: true }),
    simulate: typeof params.simulate === "boolean" ? params.simulate : undefined,
    dryRun: typeof params.dryRun === "boolean" ? params.dryRun : undefined,
    temperature: readNumberParam(params, "temperature"),
    baseUrl: readStringParam(params, "baseUrl"),
    model: readStringParam(params, "model"),
    apiKey: readStringParam(params, "apiKey"),
    monitorBaseUrl: readStringParam(params, "monitorBaseUrl"),
    monitorModel: readStringParam(params, "monitorModel"),
    monitorApiKey: readStringParam(params, "monitorApiKey"),
    monitorUseScreenshot:
      typeof params.monitorUseScreenshot === "boolean" ? params.monitorUseScreenshot : undefined,
    monitorTemperature: readNumberParam(params, "monitorTemperature"),
    monitorPrompt: readStringParam(params, "monitorPrompt"),
    includeScreenshot,
  };
}

function parseChineseNumberToken(token: string): number | undefined {
  if (!token) return undefined;
  if (token === "半") return 0.5;
  if (/^\d+(?:\.\d+)?$/.test(token)) return Number(token);
  const digits: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  let total = 0;
  let current = 0;
  for (const char of token) {
    if (char === "十") {
      total += (current || 1) * 10;
      current = 0;
      continue;
    }
    if (char === "百") {
      total += (current || 1) * 100;
      current = 0;
      continue;
    }
    const digit = digits[char];
    if (digit === undefined) return undefined;
    current = digit;
  }
  return total + current;
}

function extractRequestedDurationMs(text?: string): number | undefined {
  if (!text) return undefined;
  const matches = text.matchAll(
    /(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百半]+)\s*(小时|分钟|分|秒钟|秒|hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|sec|s)\b/gi,
  );
  let maxDurationMs: number | undefined;
  for (const match of matches) {
    const amount = parseChineseNumberToken(match[1]);
    if (amount === undefined || amount <= 0) continue;
    const unit = match[2].toLowerCase();
    const unitMs =
      unit.startsWith("小") || unit.startsWith("h")
        ? 3_600_000
        : unit.startsWith("秒") || unit.startsWith("s")
          ? 1_000
          : 60_000;
    const durationMs = Math.round(amount * unitMs);
    maxDurationMs =
      typeof maxDurationMs === "number" ? Math.max(maxDurationMs, durationMs) : durationMs;
  }
  return maxDurationMs;
}

function shouldDetachPhoneRun(opts: { request: PhoneRunRequest; config?: ClawdbotConfig }) {
  const { request, config } = opts;
  const agentTimeoutMs = resolveAgentTimeoutMs({
    cfg: config,
    minMs: MIN_PHONE_RUN_WAIT_TIMEOUT_MS,
  });
  if (request.waitForCompletion !== true) {
    return { detach: false, agentTimeoutMs };
  }

  if (
    typeof request.waitTimeoutMs === "number" &&
    request.waitTimeoutMs >=
      Math.max(MIN_PHONE_RUN_WAIT_TIMEOUT_MS, agentTimeoutMs - PHONE_RUN_TIMEOUT_HEADROOM_MS)
  ) {
    return {
      detach: true,
      agentTimeoutMs,
      reason: `requested wait (${request.waitTimeoutMs}ms) would outlive the current agent timeout (${agentTimeoutMs}ms)`,
    };
  }

  const requestedDurationMs = Math.max(
    extractRequestedDurationMs(request.goal) ?? 0,
    extractRequestedDurationMs(request.task) ?? 0,
  );
  if (requestedDurationMs >= PHONE_BACKGROUND_DURATION_THRESHOLD_MS) {
    return {
      detach: true,
      agentTimeoutMs,
      reason: `goal duration looks long (${requestedDurationMs}ms)`,
    };
  }

  const requestedSteps = Math.max(
    request.maxSteps ?? 0,
    request.maxRounds ?? 0,
    request.executorMaxSteps ?? 0,
  );
  if (requestedSteps >= 120 && (request.mode === "monitor" || Boolean(request.goal))) {
    return {
      detach: true,
      agentTimeoutMs,
      reason: `monitor run requested ${requestedSteps} steps/rounds`,
    };
  }

  return { detach: false, agentTimeoutMs };
}

function resolvePhoneToolWaitTimeoutMs(config: ClawdbotConfig | undefined, requestedMs?: number) {
  const agentTimeoutMs = resolveAgentTimeoutMs({
    cfg: config,
    minMs: MIN_PHONE_RUN_WAIT_TIMEOUT_MS,
  });
  const safeMaxMs = Math.max(
    DEFAULT_PHONE_TOOL_WAIT_TIMEOUT_MS,
    Math.min(MAX_PHONE_TOOL_WAIT_TIMEOUT_MS, agentTimeoutMs - PHONE_RUN_TIMEOUT_HEADROOM_MS),
  );
  const baseMs =
    typeof requestedMs === "number" && Number.isFinite(requestedMs)
      ? Math.max(1_000, Math.floor(requestedMs))
      : DEFAULT_PHONE_TOOL_WAIT_TIMEOUT_MS;
  return Math.min(baseMs, safeMaxMs);
}

function isPhoneWaitTimeoutError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /phone runtime wait timed out after/i.test(message);
}

function isPhoneScreenCapture(value: unknown): value is PhoneScreenCapture {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { base64?: unknown }).base64 === "string" &&
    typeof (value as { mimeType?: unknown }).mimeType === "string",
  );
}

function redactScreenCapture(screen: PhoneScreenCapture) {
  return {
    ...screen,
    base64: `[omitted base64 image payload: ${screen.bytes} bytes]`,
  };
}

function extractScreenCapture(payload: unknown): PhoneScreenCapture | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  if (isPhoneScreenCapture(payload)) return payload;
  const record = payload as { screenshot?: unknown };
  return isPhoneScreenCapture(record.screenshot) ? record.screenshot : undefined;
}

function redactPhonePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== "object") return payload;
  if (isPhoneScreenCapture(payload)) {
    return redactScreenCapture(payload);
  }
  const record = payload as Record<string, unknown>;
  if (!isPhoneScreenCapture(record.screenshot)) return payload;
  return {
    ...record,
    screenshot: redactScreenCapture(record.screenshot),
  };
}

async function buildPhoneToolResult(
  payload: PhoneScreenResult | PhoneRunResult,
): Promise<AgentToolResult<unknown>> {
  const screenshot = extractScreenCapture(payload);
  if (!screenshot) return jsonResult(payload);

  return await sanitizeToolResultImages(
    {
      content: [
        {
          type: "text",
          text: JSON.stringify(redactPhonePayload(payload), null, 2),
        },
        {
          type: "image",
          data: screenshot.base64,
          mimeType: screenshot.mimeType,
        },
      ],
      details: payload,
    },
    "phone",
  );
}

export function createPhoneTool(opts?: { config?: ClawdbotConfig }): AnyAgentTool {
  return {
    label: "Phone",
    name: "phone",
    description:
      "Use this for immediate phone control from natural-language requests such as '打开小红书', '去设置页面', '看看当前手机在什么界面', or '停止当前手机操作'. Use action=run for phone actions, action=screen to inspect the current UI, action=status/runs to inspect tracked phone work, and action=wait to briefly join an accepted background run. Long monitor goals are automatically detached into background tracking when waiting would exceed the current agent timeout. Completion runs attach the post-action screen back to the model by default; set includeScreenshot=false only when you want to skip that image.",
    parameters: PhoneToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const action = readStringParam(params, "action", { required: true });
      const manager = createPhoneManager(opts?.config);

      switch (action) {
        case "list":
          return jsonResult(manager.list());
        case "discover":
          return jsonResult(await manager.discover(readStringParam(params, "accountId")));
        case "status":
          return jsonResult(await manager.status(readStringParam(params, "accountId")));
        case "check":
          return jsonResult(await manager.check(readStringParam(params, "accountId")));
        case "runs":
          return jsonResult(manager.runs(readStringParam(params, "accountId")));
        case "screen":
          return await buildPhoneToolResult(
            await manager.screen({
              accountId: readStringParam(params, "accountId"),
              deviceId: readStringParam(params, "deviceId"),
              deviceType: readStringParam(params, "deviceType"),
            }),
          );
        case "run": {
          const requestedRun = buildPhoneRunRequest(params);
          const detachDecision = shouldDetachPhoneRun({
            request: requestedRun,
            config: opts?.config,
          });
          const effectiveRun =
            detachDecision.detach && requestedRun.waitForCompletion === true
              ? { ...requestedRun, waitForCompletion: false }
              : requestedRun;
          const result = await manager.run(effectiveRun);
          if (result.completed && result.ok === false) {
            throw new Error(result.message ?? `phone.run failed with status=${result.status}`);
          }
          const payload =
            detachDecision.detach && !result.completed
              ? {
                  ...result,
                  background: true,
                  trackingHint:
                    "Long phone job moved to background tracking. Use phone.runs, phone.status, phone.wait, or phone.stop with this runId.",
                  trackingReason: detachDecision.reason,
                  agentTimeoutMs: detachDecision.agentTimeoutMs,
                }
              : result;
          return await buildPhoneToolResult(payload);
        }
        case "wait": {
          const runId = readStringParam(params, "runId", { required: true });
          const includeScreenshot =
            typeof params.includeScreenshot === "boolean" ? params.includeScreenshot : true;
          try {
            return await buildPhoneToolResult(
              await manager.wait({
                accountId: readStringParam(params, "accountId"),
                runId,
                waitTimeoutMs: resolvePhoneToolWaitTimeoutMs(
                  opts?.config,
                  readNumberParam(params, "waitTimeoutMs", { integer: true }),
                ),
                deviceId: readStringParam(params, "deviceId"),
                deviceType: readStringParam(params, "deviceType"),
                includeScreenshot,
              }),
            );
          } catch (error) {
            if (!isPhoneWaitTimeoutError(error)) throw error;
            return jsonResult({
              ok: true,
              status: "accepted",
              completed: false,
              runId,
              message: `phone run ${runId} is still running`,
              tracking: manager.getRun(runId),
            });
          }
        }
        case "stop":
          return jsonResult(
            await manager.stop({
              accountId: readStringParam(params, "accountId"),
              runId: readStringParam(params, "runId"),
            }),
          );
        default:
          throw new Error(`Unknown action: ${action}`);
      }
    },
  };
}
