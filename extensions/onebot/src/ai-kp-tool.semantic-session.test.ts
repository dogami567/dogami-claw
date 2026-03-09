import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { classifyOneBotAiKpSessionRouteMock } = vi.hoisted(() => ({
  classifyOneBotAiKpSessionRouteMock: vi.fn(),
}));

vi.mock("./ai-kp-activation.js", async () => {
  const actual = await vi.importActual<typeof import("./ai-kp-activation.js")>("./ai-kp-activation.js");
  return {
    ...actual,
    classifyOneBotAiKpSessionRoute: classifyOneBotAiKpSessionRouteMock,
  };
});

import { createOneBotAiKpTools } from "./ai-kp-tool.js";

const tempDirs: string[] = [];

function buildApi(storageRoot: string, storePath: string) {
  return {
    config: {
      channels: {
        onebot: {
          aiKp: {
            storageRoot,
            runtimeModulePath: path.join(
              process.cwd(),
              ".runtime",
              "workspace",
              "clawd-ai-kp",
              "adapter",
              "onebot",
              "runtime.js",
            ),
          },
        },
      },
    },
    runtime: {
      channel: {
        session: {
          resolveStorePath: () => storePath,
        },
      },
    },
  };
}

async function seedSessionStore(storePath: string, sessionKey: string) {
  await writeFile(
    storePath,
    JSON.stringify(
      {
        [sessionKey]: {
          sessionId: "test-session",
          updatedAt: Date.now(),
          groupId: "875336657",
          origin: {
            from: "onebot:user:281894872",
            to: "group:875336657",
          },
        },
      },
      null,
      2,
    ),
  );
}

async function createTools() {
  const root = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-session-route-"));
  tempDirs.push(root);
  const storageRoot = path.join(root, "runtime", "onebot");
  const storePath = path.join(root, "sessions.json");
  const sessionKey = "onebot:group:875336657";
  await seedSessionStore(storePath, sessionKey);
  const tools = createOneBotAiKpTools(buildApi(storageRoot, storePath) as any, {
    messageChannel: "onebot",
    sessionKey,
    agentId: "main",
  } as any);
  if (!tools) throw new Error("AI-KP tools were not created");
  return Object.fromEntries(tools.map((tool) => [tool.name, tool]));
}

afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("onebot_aikp_session semantic_reply", () => {
  it("routes natural-language resume answers to the resume action", async () => {
    classifyOneBotAiKpSessionRouteMock.mockResolvedValueOnce({
      action: "resume",
      confidence: 0.97,
      reason: "user wants the previous line back",
    });

    const byName = await createTools();
    await byName.onebot_aikp_session.execute("1", {
      action: "start",
      originalText: "我想跑团",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_session.execute("2", {
      action: "select_story_pack",
      value: "old-church-arc-pack",
      originalText: "跑旧教堂",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_roll.execute("3", {
      action: "traditional",
      occupationKey: "journalist",
      originalText: "给我来张记者卡",
      senderName: "Dogami",
    });

    const pending = await byName.onebot_aikp_session.execute("4", {
      action: "start",
      originalText: "再开始一下",
      senderName: "Dogami",
    });
    expect(pending.details.replyText).toContain("旧档");

    const resumed = await byName.onebot_aikp_session.execute("5", {
      action: "semantic_reply",
      originalText: "把昨晚那条接回来吧",
      senderName: "Dogami",
    });
    expect(resumed.details.routedAction).toBe("resume");
    expect(resumed.details.semanticResolution).toMatchObject({
      action: "resume",
    });
    expect(resumed.details.replyText).toContain("接上");
  });

  it("routes natural-language new-line answers to the new_line action", async () => {
    classifyOneBotAiKpSessionRouteMock.mockResolvedValueOnce({
      action: "new_line",
      confidence: 0.94,
      reason: "user wants a fresh run",
    });

    const byName = await createTools();
    await byName.onebot_aikp_session.execute("1", {
      action: "start",
      originalText: "我想跑团",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_session.execute("2", {
      action: "select_story_pack",
      value: "old-church-arc-pack",
      originalText: "跑旧教堂",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_roll.execute("3", {
      action: "traditional",
      occupationKey: "journalist",
      originalText: "给我来张记者卡",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_session.execute("4", {
      action: "start",
      originalText: "再开始一下",
      senderName: "Dogami",
    });

    const fresh = await byName.onebot_aikp_session.execute("5", {
      action: "semantic_reply",
      originalText: "别续旧档了，重新开吧",
      senderName: "Dogami",
    });
    expect(fresh.details.routedAction).toBe("new_line");
    expect(fresh.details.semanticResolution).toMatchObject({
      action: "new_line",
    });
    expect(fresh.details.replyText).toContain("旧档我先收成");
  });

  it("returns a no-op when semantic routing decides the message is normal chat", async () => {
    classifyOneBotAiKpSessionRouteMock.mockResolvedValueOnce({
      action: "normal",
      confidence: 0.88,
      reason: "feature discussion only",
    });

    const byName = await createTools();
    const result = await byName.onebot_aikp_session.execute("1", {
      action: "semantic_reply",
      originalText: "你这个功能后面还准备怎么扩展",
      senderName: "Dogami",
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.noSessionAction).toBe(true);
    expect(result.details.replyText).toBeNull();
  });
});
