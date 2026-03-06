import { afterEach, expect, test } from "vitest";

import { createExecTool } from "./bash-tools.exec";
import { resetProcessRegistryForTests } from "./bash-process-registry";
import { sanitizeBinaryOutput } from "./shell-utils";

afterEach(() => {
  resetProcessRegistryForTests();
});

test("exec injects chat context env into child processes", async () => {
  const tool = createExecTool({
    allowBackground: false,
    host: "gateway",
    security: "full",
    ask: "off",
    sessionKey: "agent:main:onebot:group:974862433",
    messageProvider: "onebot",
    messageTo: "group:974862433",
    messageThreadId: "thread-42",
    agentAccountId: "bot-account",
  });

  const result = await tool.execute("toolcall", {
    command:
      'node -e "process.stdout.write(JSON.stringify({sessionKey:process.env.CLAWDBOT_SESSION_KEY ?? null,provider:process.env.CLAWDBOT_MESSAGE_PROVIDER ?? null,to:process.env.CLAWDBOT_MESSAGE_TO ?? null,threadId:process.env.CLAWDBOT_MESSAGE_THREAD_ID ?? null,accountId:process.env.CLAWDBOT_MESSAGE_ACCOUNT_ID ?? null}))"',
    env: {
      CLAWDBOT_MESSAGE_TO: "user:spoofed",
    },
  });

  expect(result.details.status).toBe("completed");
  const text = sanitizeBinaryOutput(result.content?.[0]?.text ?? "").trim();
  expect(JSON.parse(text)).toEqual({
    sessionKey: "agent:main:onebot:group:974862433",
    provider: "onebot",
    to: "group:974862433",
    threadId: "thread-42",
    accountId: "bot-account",
  });
});
