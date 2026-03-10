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
import { sanitizeToolResultImages } from "../tool-images.js";
import { type AnyAgentTool, jsonResult, readNumberParam, readStringParam } from "./common.js";

const PHONE_TOOL_ACTIONS = [
  "list",
  "discover",
  "status",
  "check",
  "screen",
  "run",
  "stop",
] as const;
const PHONE_TOOL_MODES = ["direct", "monitor"] as const;
const MIN_PHONE_RUN_WAIT_TIMEOUT_MS = 60_000;

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
      "Use this for immediate phone control from natural-language requests such as '打开小红书', '去设置页面', '看看当前手机在什么界面', or '停止当前手机操作'. Use action=run for one-off phone actions, action=screen to inspect the current UI, and action=check/status when you need runtime health. Completion runs attach the post-action screen back to the model by default; set includeScreenshot=false only when you want to skip that image.",
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
        case "screen":
          return await buildPhoneToolResult(
            await manager.screen({
              accountId: readStringParam(params, "accountId"),
              deviceId: readStringParam(params, "deviceId"),
              deviceType: readStringParam(params, "deviceType"),
            }),
          );
        case "run": {
          const result = await manager.run(buildPhoneRunRequest(params));
          if (result.completed && result.ok === false) {
            throw new Error(result.message ?? `phone.run failed with status=${result.status}`);
          }
          return await buildPhoneToolResult(result);
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
