import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadSessionEntry: vi.fn(),
}));

vi.mock("../session-utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session-utils.js")>();
  return {
    ...actual,
    loadSessionEntry: mocks.loadSessionEntry,
  };
});

describe("chat.inject transcript recovery", () => {
  afterEach(() => {
    mocks.loadSessionEntry.mockReset();
  });

  it("creates a missing transcript before injecting the assistant message", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-chat-inject-"));
    try {
      const storePath = path.join(dir, "sessions.json");
      const transcriptPath = path.join(dir, "sess-main.jsonl");
      mocks.loadSessionEntry.mockReturnValue({
        storePath,
        entry: {
          sessionId: "sess-main",
        },
      });

      const { chatHandlers } = await import("./chat.js");
      const respond = vi.fn();
      const broadcast = vi.fn();
      const nodeSendToSession = vi.fn();

      await chatHandlers["chat.inject"]({
        params: {
          sessionKey: "main",
          message: "hello after repair",
        },
        respond,
        context: {
          broadcast,
          nodeSendToSession,
        } as never,
        req: { type: "req", id: "1", method: "chat.inject" },
        client: null,
        isWebchatConnect: () => false,
      });

      const transcript = await fs.readFile(transcriptPath, "utf-8");
      expect(transcript).toContain('"type":"session"');
      expect(transcript).toContain("hello after repair");

      expect(respond).toHaveBeenCalledWith(true, expect.objectContaining({ ok: true }));
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          sessionKey: "main",
          state: "final",
        }),
      );
      expect(nodeSendToSession).toHaveBeenCalledWith(
        "main",
        "chat",
        expect.objectContaining({
          sessionKey: "main",
          state: "final",
        }),
      );
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
