import { AssistantMessageEventStream } from "@mariozechner/pi-ai";
import type { Context, Model } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  _internal,
  wrapEmbeddedStreamFnWithOpenAIResponsesFallback,
} from "./openai-responses-fallback.js";

function buildModel(provider = "gmn", id = "gpt-5.4"): Model<"openai-responses"> {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://example.com/v1",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.1 },
    contextWindow: 128_000,
    maxTokens: 16_384,
    headers: { "X-Test": "1" },
  };
}

const buildContext = (): Context => ({
  systemPrompt: "You are helpful.",
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
  tools: [
    {
      name: "phone.run",
      description: "Run phone actions.",
      parameters: Type.Object({ goal: Type.String() }, { additionalProperties: false }),
    },
  ],
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("openai-responses fallback", () => {
  it("only enables non-stream fallback for gmn openai-responses models", () => {
    expect(_internal.shouldUseNonStreamingResponses(buildModel("gmn"))).toBe(true);
    expect(_internal.shouldUseNonStreamingResponses(buildModel("openai"))).toBe(false);
    expect(
      _internal.shouldUseNonStreamingResponses({
        ...buildModel("gmn"),
        api: "openai-completions",
      } as Model<"openai-responses">),
    ).toBe(false);
  });

  it("delegates to the original stream function for other providers", async () => {
    const baseStreamFn = vi.fn(() => {
      const stream = new AssistantMessageEventStream();
      queueMicrotask(() => {
        stream.push({
          type: "done",
          reason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-5.4",
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            timestamp: Date.now(),
          },
        });
        stream.end();
      });
      return stream;
    });

    const wrapped = wrapEmbeddedStreamFnWithOpenAIResponsesFallback(baseStreamFn);
    const result = await wrapped(buildModel("openai"), buildContext(), {}).result();

    expect(baseStreamFn).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("stop");
  });

  it("uses a non-streaming responses request for gmn and preserves tool calls", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      expect(body.stream).toBe(false);
      expect(body.reasoning).toEqual({ effort: "low", summary: "auto" });

      return new Response(
        JSON.stringify({
          status: "completed",
          service_tier: "priority",
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens: 30,
            total_tokens: 150,
          },
          output: [
            {
              type: "reasoning",
              id: "rs_1",
              summary: [{ type: "summary_text", text: "plan first" }],
              encrypted_content: "enc",
            },
            {
              type: "message",
              id: "msg_1",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "calling phone.run", annotations: [] }],
            },
            {
              type: "function_call",
              id: "fc_1",
              call_id: "call_1",
              name: "phone.run",
              arguments: '{"goal":"open settings"}',
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    });

    vi.stubGlobal("fetch", fetchMock);
    const onPayload = vi.fn();
    const wrapped = wrapEmbeddedStreamFnWithOpenAIResponsesFallback(vi.fn());
    const result = await wrapped(buildModel("gmn"), buildContext(), {
      apiKey: "sk-test",
      reasoning: "low",
      onPayload,
    }).result();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onPayload).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("toolUse");
    expect(result.usage.input).toBe(100);
    expect(result.usage.cacheRead).toBe(20);
    expect(result.usage.output).toBe(30);
    expect(result.usage.totalTokens).toBe(150);
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinking: "plan first",
    });
    expect(result.content[1]).toMatchObject({
      type: "text",
      text: "calling phone.run",
      textSignature: "msg_1",
    });
    expect(result.content[2]).toMatchObject({
      type: "toolCall",
      id: "call_1|fc_1",
      name: "phone.run",
      arguments: { goal: "open settings" },
    });
  });

  it("parses SSE payloads when an upstream returns event-stream despite stream=false", async () => {
    const fetchMock = vi.fn(async () => {
      const sse = [
        "event: response.created",
        'data: {"type":"response.created","response":{"status":"in_progress"}}',
        "",
        "event: response.completed",
        'data: {"type":"response.completed","response":{"status":"completed","service_tier":"priority","usage":{"input_tokens":80,"input_tokens_details":{"cached_tokens":10},"output_tokens":12,"total_tokens":92},"output":[{"type":"message","id":"msg_sse","content":[{"type":"output_text","text":"done from sse"}]},{"type":"function_call","id":"fc_sse","call_id":"call_sse","name":"phone.run","arguments":"{\\"goal\\":\\"open settings\\"}"}]}}',
        "",
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });

    vi.stubGlobal("fetch", fetchMock);
    const wrapped = wrapEmbeddedStreamFnWithOpenAIResponsesFallback(vi.fn());
    const result = await wrapped(buildModel("gmn"), buildContext(), {
      apiKey: "sk-test",
      reasoning: "low",
    }).result();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("toolUse");
    expect(result.usage.input).toBe(70);
    expect(result.usage.cacheRead).toBe(10);
    expect(result.usage.output).toBe(12);
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "done from sse",
      textSignature: "msg_sse",
    });
    expect(result.content[1]).toMatchObject({
      type: "toolCall",
      id: "call_sse|fc_sse",
      name: "phone.run",
      arguments: { goal: "open settings" },
    });
  });
});
