import { Type } from "@sinclair/typebox";

import {
  stringEnum,
  type ClawdbotPluginApi,
} from "clawdbot/plugin-sdk";

import { createYunyingService, YUNYING_ACTIONS } from "./service.js";

export function createYunyingTool(api: ClawdbotPluginApi) {
  const service = createYunyingService(api);

  return {
    name: "yunying",
    description:
      "Use this for natural-language background运营 goals that should keep running per phone, such as '根据小红书运营 skill 开始今天的运营', '把手机1从小红书切到大众点评', '继续手机1刚才中断的任务', '让手机1按这个 skill 持续巡检/定时运营', '把这台手机命名为小红书1号机', '让手机1的后台脑总结当前策略', '停掉当前运营任务', or '查看每台手机的运营状态与日志'. It manages one background job per phone, supports replace/resume/stop, keeps a persistent per-phone brain session, and exposes fleet/status/logs for ongoing work.",
    parameters: Type.Object({
      action: stringEnum(YUNYING_ACTIONS),
      accountId: Type.Optional(Type.String()),
      deviceId: Type.Optional(Type.String()),
      skillId: Type.Optional(Type.String()),
      platform: Type.Optional(Type.String()),
      goal: Type.Optional(Type.String()),
      name: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
      jobId: Type.Optional(Type.String()),
      limit: Type.Optional(Type.Number({ minimum: 1, maximum: 500 })),
    }),
    async execute(_toolCallId: string, rawParams: Record<string, unknown>) {
      return await service.execute(rawParams);
    },
  };
}
