import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Context, Model } from "@mariozechner/pi-ai";
import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";

import { wrapStreamFnForStreamReadErrorRecovery } from "./stream-read-error-recovery.js";

function makeUsage(params?: Partial<AssistantMessage["usage"]>): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    ...params,
  };
}

function makeAssistant(params?: Partial<AssistantMessage>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "mock",
    usage: makeUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
    ...params,
  };
}

const model = {
  id: "gpt-test",
  name: "gpt-test",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://example.com/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 16_000,
  maxTokens: 2048,
} satisfies Model<"openai-responses">;

const context: Context = {
  messages: [],
};

describe("wrapStreamFnForStreamReadErrorRecovery", () => {
  it("promotes stream_read_error to done when output looks complete", async () => {
    const base: StreamFn = () => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        const partial = makeAssistant();
        stream.push({ type: "start", partial });
        const error = makeAssistant({
          content: [{ type: "text", text: "hello", textSignature: "msg_123" }],
          stopReason: "error",
          errorMessage: "stream_read_error",
          usage: makeUsage({ totalTokens: 123 }),
        });
        stream.push({ type: "error", reason: "error", error });
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnForStreamReadErrorRecovery(base, { maxRetries: 0 });
    const stream = (await Promise.resolve(
      wrapped(model, context, {}),
    )) as unknown as AssistantMessageEventStream;

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }

    expect(events).toEqual(["start", "done"]);
    const final = await stream.result();
    expect(final.stopReason).toBe("stop");
    expect(final.errorMessage).toBeUndefined();
    expect(final.content).toEqual([{ type: "text", text: "hello", textSignature: "msg_123" }]);
  });

  it("retries when stream_read_error happens before start", async () => {
    let calls = 0;
    const base: StreamFn = () => {
      calls += 1;
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        if (calls === 1) {
          const error = makeAssistant({
            stopReason: "error",
            errorMessage: "stream_read_error",
          });
          stream.push({ type: "error", reason: "error", error });
        } else {
          const partial = makeAssistant();
          stream.push({ type: "start", partial });
          const done = makeAssistant({
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            usage: makeUsage({ totalTokens: 2 }),
          });
          stream.push({ type: "done", reason: "stop", message: done });
        }
        stream.end();
      });
      return stream;
    };

    const wrapped = wrapStreamFnForStreamReadErrorRecovery(base, { maxRetries: 1 });
    const stream = (await Promise.resolve(
      wrapped(model, context, {}),
    )) as unknown as AssistantMessageEventStream;

    const events: string[] = [];
    for await (const event of stream) {
      events.push(event.type);
    }

    expect(calls).toBe(2);
    expect(events).toEqual(["start", "done"]);
    const final = await stream.result();
    expect(final.stopReason).toBe("stop");
    expect(final.errorMessage).toBeUndefined();
    expect(final.content).toEqual([{ type: "text", text: "ok" }]);
  });
});
