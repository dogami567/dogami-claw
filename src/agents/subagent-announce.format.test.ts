import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
  let summaryRunId = 0;
  return {
    gatewayCalls: [] as Array<{ method?: string; params?: Record<string, unknown> }>,
    childReply: "raw subagent reply",
    summaryReply: "natural summary",
    nextSummaryRunId() {
      summaryRunId += 1;
      return `run-summary-${summaryRunId}`;
    },
    resetSummaryRunIds() {
      summaryRunId = 0;
    },
    agentSpy: vi.fn(async (req: { params?: Record<string, unknown> }) => {
      const sessionKey = String(req.params?.sessionKey ?? "");
      if (sessionKey.includes(":subagent:announce:")) {
        return { runId: state.nextSummaryRunId(), status: "ok" };
      }
      return { runId: "run-main", status: "ok" };
    }),
    agentWaitSpy: vi.fn(async (req: { params?: Record<string, unknown> }) => {
      const runId = String(req.params?.runId ?? "");
      if (runId.startsWith("run-summary-")) return { status: "ok" };
      return { status: "error", startedAt: 10, endedAt: 20, error: "boom" };
    }),
    sendSpy: vi.fn(async () => ({ messageId: "sent-1", channel: "whatsapp" })),
    chatInjectSpy: vi.fn(async () => ({ ok: true, messageId: "inject-1" })),
    sessionsPatchSpy: vi.fn(async () => ({})),
    sessionsDeleteSpy: vi.fn(async () => ({})),
  };
});

const embeddedRunMock = {
  isEmbeddedPiRunActive: vi.fn(() => false),
  isEmbeddedPiRunStreaming: vi.fn(() => false),
  queueEmbeddedPiMessage: vi.fn(() => false),
  waitForEmbeddedPiRunEnd: vi.fn(async () => true),
};

let sessionStore: Record<string, Record<string, unknown>> = {};
let configOverride: ReturnType<(typeof import("../config/config.js"))["loadConfig"]> = {
  session: {
    mainKey: "main",
    scope: "per-sender",
  },
};

vi.mock("../gateway/call.js", () => ({
  callGateway: vi.fn(async (req: unknown) => {
    const typed = req as { method?: string; params?: Record<string, unknown> };
    state.gatewayCalls.push(typed);
    if (typed.method === "agent") return await state.agentSpy(typed);
    if (typed.method === "agent.wait") return await state.agentWaitSpy(typed);
    if (typed.method === "send") return await state.sendSpy(typed);
    if (typed.method === "chat.inject") return await state.chatInjectSpy(typed);
    if (typed.method === "sessions.patch") return await state.sessionsPatchSpy(typed);
    if (typed.method === "sessions.delete") return await state.sessionsDeleteSpy(typed);
    return {};
  }),
}));

vi.mock("./tools/agent-step.js", () => ({
  readLatestAssistantReply: vi.fn(async ({ sessionKey }: { sessionKey: string }) => {
    if (String(sessionKey).includes(":subagent:announce:")) {
      return state.summaryReply;
    }
    return state.childReply;
  }),
}));

vi.mock("../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => sessionStore),
  resolveAgentIdFromSessionKey: () => "main",
  resolveStorePath: () => "/tmp/sessions.json",
  resolveMainSessionKey: () => "agent:main:main",
  readSessionUpdatedAt: vi.fn(() => undefined),
  recordSessionMetaFromInbound: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./pi-embedded.js", () => embeddedRunMock);

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: () => configOverride,
  };
});

describe("subagent announce formatting", () => {
  beforeEach(() => {
    state.gatewayCalls.length = 0;
    state.childReply = "raw subagent reply";
    state.summaryReply = "natural summary";
    state.resetSummaryRunIds();
    state.agentSpy.mockClear();
    state.agentWaitSpy.mockClear();
    state.sendSpy.mockClear();
    state.chatInjectSpy.mockClear();
    state.sessionsPatchSpy.mockClear();
    state.sessionsDeleteSpy.mockClear();
    embeddedRunMock.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    embeddedRunMock.queueEmbeddedPiMessage.mockReset().mockReturnValue(false);
    embeddedRunMock.waitForEmbeddedPiRunEnd.mockReset().mockResolvedValue(true);
    sessionStore = {};
    configOverride = {
      session: {
        mainKey: "main",
        scope: "per-sender",
      },
    };
  });

  it("summarizes in a hidden session and injects the clean reply", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-123",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: true,
      startedAt: 10,
      endedAt: 20,
    });

    expect(didAnnounce).toBe(true);
    expect(state.agentSpy).toHaveBeenCalledTimes(1);
    const hiddenAgentCall = state.agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    expect(String(hiddenAgentCall?.params?.sessionKey)).toContain(":subagent:announce:");
    expect(hiddenAgentCall?.params?.deliver).toBe(false);
    expect(hiddenAgentCall?.params?.channel).toBe("webchat");
    expect(hiddenAgentCall?.params?.spawnedBy).toBe("agent:main:main");

    const prompt = String(hiddenAgentCall?.params?.message ?? "");
    expect(prompt).toContain("background task");
    expect(prompt).toContain("failed");
    expect(prompt).toContain("boom");
    expect(prompt).toContain("Findings:");
    expect(prompt).toContain("raw subagent reply");
    expect(prompt).toContain("Stats:");
    expect(prompt).toContain("NO_REPLY");

    expect(state.chatInjectSpy).toHaveBeenCalledTimes(1);
    const injectCall = state.chatInjectSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    expect(injectCall?.params?.sessionKey).toBe("agent:main:main");
    expect(injectCall?.params?.message).toBe("natural summary");
    expect(state.sendSpy).not.toHaveBeenCalled();

    const requesterVisibleAgentCall = state.gatewayCalls.find(
      (call) =>
        call.method === "agent" &&
        String(call.params?.sessionKey ?? "") === "agent:main:main" &&
        call.params?.deliver === true,
    );
    expect(requesterVisibleAgentCall).toBeUndefined();
  });

  it("includes success status when outcome is ok", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-456",
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    const hiddenAgentCall = state.agentSpy.mock.calls[0]?.[0] as {
      params?: Record<string, unknown>;
    };
    expect(String(hiddenAgentCall?.params?.message ?? "")).toContain("completed successfully");
  });

  it("steers announcements into an active run when queue mode is steer", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(true);
    embeddedRunMock.queueEmbeddedPiMessage.mockReturnValue(true);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-123",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "steer",
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-789",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(embeddedRunMock.queueEmbeddedPiMessage).toHaveBeenCalledWith(
      "session-123",
      expect.stringContaining("background task"),
    );
    expect(state.agentSpy).not.toHaveBeenCalled();
    expect(state.sendSpy).not.toHaveBeenCalled();
    expect(state.chatInjectSpy).not.toHaveBeenCalled();
  });

  it("queues announce delivery with origin account routing", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-456",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        lastAccountId: "kev",
        queueMode: "collect",
        queueDebounceMs: 0,
      },
    };

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-999",
      requesterSessionKey: "main",
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const sendCall = state.sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(sendCall?.params?.channel).toBe("whatsapp");
    expect(sendCall?.params?.to).toBe("+1555");
    expect(sendCall?.params?.accountId).toBe("kev");
  });

  it("splits collect-mode queues when accountId differs", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(true);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);
    sessionStore = {
      "agent:main:main": {
        sessionId: "session-acc-split",
        lastChannel: "whatsapp",
        lastTo: "+1555",
        queueMode: "collect",
        queueDebounceMs: 80,
      },
    };

    await Promise.all([
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-a",
        childRunId: "run-a",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-a" },
        task: "do thing",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      }),
      runSubagentAnnounceFlow({
        childSessionKey: "agent:main:subagent:test-b",
        childRunId: "run-b",
        requesterSessionKey: "main",
        requesterDisplayKey: "main",
        requesterOrigin: { accountId: "acct-b" },
        task: "do thing",
        timeoutMs: 1000,
        cleanup: "keep",
        waitForCompletion: false,
        startedAt: 10,
        endedAt: 20,
        outcome: { status: "ok" },
      }),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(state.sendSpy).toHaveBeenCalledTimes(2);
    const accountIds = state.sendSpy.mock.calls.map(
      (call) => (call[0] as { params?: Record<string, unknown> }).params?.accountId,
    );
    expect(accountIds).toEqual(expect.arrayContaining(["acct-a", "acct-b"]));
  });

  it("uses requester origin for direct announce when not queued", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555", threadId: 42 },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const sendCall = state.sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(sendCall?.params?.channel).toBe("whatsapp");
    expect(sendCall?.params?.accountId).toBe("acct-123");
    expect(sendCall?.params?.to).toBe("+1555");
    expect(sendCall?.params?.threadId).toBe("42");
  });

  it("normalizes requesterOrigin for direct announce delivery", async () => {
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");
    embeddedRunMock.isEmbeddedPiRunActive.mockReturnValue(false);
    embeddedRunMock.isEmbeddedPiRunStreaming.mockReturnValue(false);

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-direct-origin",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: " whatsapp ", accountId: " acct-987 ", to: " +1666 " },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    const sendCall = state.sendSpy.mock.calls[0]?.[0] as { params?: Record<string, unknown> };
    expect(sendCall?.params?.channel).toBe("whatsapp");
    expect(sendCall?.params?.accountId).toBe("acct-987");
    expect(sendCall?.params?.to).toBe("+1666");
  });

  it("suppresses visible delivery when the hidden summary returns NO_REPLY", async () => {
    state.summaryReply = "NO_REPLY";
    const { runSubagentAnnounceFlow } = await import("./subagent-announce.js");

    const didAnnounce = await runSubagentAnnounceFlow({
      childSessionKey: "agent:main:subagent:test",
      childRunId: "run-silent",
      requesterSessionKey: "agent:main:main",
      requesterOrigin: { channel: "whatsapp", accountId: "acct-123", to: "+1555" },
      requesterDisplayKey: "main",
      task: "do thing",
      timeoutMs: 1000,
      cleanup: "keep",
      waitForCompletion: false,
      startedAt: 10,
      endedAt: 20,
      outcome: { status: "ok" },
    });

    expect(didAnnounce).toBe(true);
    expect(state.sendSpy).not.toHaveBeenCalled();
    expect(state.chatInjectSpy).not.toHaveBeenCalled();
    expect(state.agentSpy).toHaveBeenCalledTimes(1);
  });
});
