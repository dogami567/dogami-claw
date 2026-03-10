import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(() => ({
    storePath: "/tmp/sessions.json",
    entry: { sessionId: "sess-1" },
  })),
  readSessionMessages: vi.fn(() => []),
}));

vi.mock("./session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
    readSessionMessages: mocks.readSessionMessages,
  };
});

import { createAgentEventHandler, createChatRunState } from "./server-chat.js";
import { registerAgentRunContext, resetAgentRunContextForTest } from "../infra/agent-events.js";

afterEach(() => {
  resetAgentRunContextForTest();
});

describe("agent event handler", () => {
  it("emits chat delta for assistant text-only events", () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-1", { sessionKey: "session-1", clientRunId: "client-1" });

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-1",
      seq: 1,
      stream: "assistant",
      ts: Date.now(),
      data: { text: "Hello world" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("delta");
    expect(payload.message?.content?.[0]?.text).toBe("Hello world");
    const sessionChatCalls = nodeSendToSession.mock.calls.filter(([, event]) => event === "chat");
    expect(sessionChatCalls).toHaveLength(1);
    nowSpy.mockRestore();
  });

  it("replays final chat text from transcript when no delta buffer exists", () => {
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-2", { sessionKey: "session-2", clientRunId: "client-2" });
    mocks.readSessionMessages.mockReturnValue([
      {
        role: "assistant",
        content: [{ type: "text", text: "hello from transcript" }],
      },
    ]);

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-2",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("final");
    expect(payload.message?.content?.[0]?.text).toBe("hello from transcript");
  });

  it("prefers the run context transcript over the session store transcript", () => {
    const broadcast = vi.fn();
    const nodeSendToSession = vi.fn();
    const agentRunSeq = new Map<string, number>();
    const chatRunState = createChatRunState();
    chatRunState.registry.add("run-3", { sessionKey: "session-3", clientRunId: "client-3" });
    registerAgentRunContext("client-3", {
      sessionKey: "session-3",
      sessionId: "run-session-3",
      sessionFile: "/tmp/run-session-3.jsonl",
    });
    mocks.readSessionMessages.mockImplementation(
      (sessionId: string, _storePath?: string, sessionFile?: string) => {
        if (sessionId === "run-session-3" && sessionFile === "/tmp/run-session-3.jsonl") {
          return [
            {
              role: "assistant",
              content: [{ type: "text", text: "fresh run transcript" }],
            },
          ];
        }
        return [
          {
            role: "assistant",
            content: [{ type: "text", text: "stale session transcript" }],
          },
        ];
      },
    );

    const handler = createAgentEventHandler({
      broadcast,
      nodeSendToSession,
      agentRunSeq,
      chatRunState,
      resolveSessionKeyForRun: () => undefined,
      clearAgentRunContext: vi.fn(),
    });

    handler({
      runId: "run-3",
      seq: 1,
      stream: "lifecycle",
      ts: Date.now(),
      data: { phase: "end" },
    });

    const chatCalls = broadcast.mock.calls.filter(([event]) => event === "chat");
    expect(chatCalls).toHaveLength(1);
    const payload = chatCalls[0]?.[1] as {
      state?: string;
      message?: { content?: Array<{ text?: string }> };
    };
    expect(payload.state).toBe("final");
    expect(payload.message?.content?.[0]?.text).toBe("fresh run transcript");
  });
});
