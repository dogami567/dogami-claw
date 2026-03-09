import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { classifyOneBotAiKpRollRouteMock } = vi.hoisted(() => ({
  classifyOneBotAiKpRollRouteMock: vi.fn(),
}));

vi.mock("./ai-kp-activation.js", async () => {
  const actual = await vi.importActual<typeof import("./ai-kp-activation.js")>("./ai-kp-activation.js");
  return {
    ...actual,
    classifyOneBotAiKpRollRoute: classifyOneBotAiKpRollRouteMock,
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
  const root = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-roll-route-"));
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

async function enterChargenPrompt(byName: Record<string, any>) {
  const start = await byName.onebot_aikp_session.execute("1", {
    action: "start",
    originalText: "我想跑团",
    senderName: "Dogami",
  });
  expect(start.details.replyText).toContain("当前可选剧本");

  const pack = await byName.onebot_aikp_session.execute("2", {
    action: "select_story_pack",
    value: "old-church-arc-pack",
    originalText: "那就跑旧教堂",
    senderName: "Dogami",
  });
  expect(pack.details.replyText).toContain("你现在还没车卡");
}

afterEach(async () => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("onebot_aikp_roll semantic_reply", () => {
  it("routes occupation-only replies to a traditional roll", async () => {
    classifyOneBotAiKpRollRouteMock.mockResolvedValueOnce({
      action: "traditional",
      confidence: 0.97,
      reason: "occupation-only answer should create a standard sheet",
      occupationKey: "journalist",
    });

    const byName = await createTools();
    await enterChargenPrompt(byName);

    const rolled = await byName.onebot_aikp_roll.execute("3", {
      action: "semantic_reply",
      originalText: "记者吧",
      senderName: "Dogami",
    });
    expect(rolled.details.routedAction).toBe("traditional");
    expect(rolled.details.semanticResolution).toMatchObject({
      action: "traditional",
      occupationKey: "journalist",
    });
    expect(rolled.details.occupationKey).toBe("journalist");
    expect(rolled.details.usedMessage).toBe("/aikp roll journalist");
    expect(rolled.details.replyText).toContain("传统随机车卡 已经给你落好了");
    expect(rolled.details.replyText).toContain("Dogami｜记者");
  });

  it("routes quickfire freeform replies to quickfire with the inferred occupation", async () => {
    classifyOneBotAiKpRollRouteMock.mockResolvedValueOnce({
      action: "quickfire",
      confidence: 0.96,
      reason: "user asked for a quick doctor sheet",
      occupationKey: "doctor",
    });

    const byName = await createTools();
    await enterChargenPrompt(byName);

    const rolled = await byName.onebot_aikp_roll.execute("3", {
      action: "semantic_reply",
      originalText: "给我快速医生卡",
      senderName: "Dogami",
    });
    expect(rolled.details.routedAction).toBe("quickfire");
    expect(rolled.details.semanticResolution).toMatchObject({
      action: "quickfire",
      occupationKey: "doctor",
    });
    expect(rolled.details.occupationKey).toBe("doctor");
    expect(rolled.details.usedMessage).toBe("/aikp quickfire doctor");
    expect(rolled.details.replyText).toContain("快速车卡 已经给你落好了");
    expect(rolled.details.replyText).toContain("Dogami｜医生");
  });

  it("routes party chargen replies to the party roll action", async () => {
    classifyOneBotAiKpRollRouteMock.mockResolvedValueOnce({
      action: "party_quickfire",
      confidence: 0.95,
      reason: "user wants everyone to quickfire together",
      occupationKey: "detective",
    });

    const byName = await createTools();
    await enterChargenPrompt(byName);

    const rolled = await byName.onebot_aikp_roll.execute("3", {
      action: "semantic_reply",
      originalText: "大家一起快速车卡，职业侦探",
      senderName: "Dogami",
    });
    expect(rolled.details.routedAction).toBe("party_quickfire");
    expect(rolled.details.semanticResolution).toMatchObject({
      action: "party_quickfire",
      occupationKey: "detective",
    });
    expect(rolled.details.occupationKey).toBe("detective");
    expect(rolled.details.usedMessage).toBe("/aikp party-quickfire detective");
    expect(rolled.details.replyText).toContain("快速车卡");
    expect(rolled.details.replyText).toContain("Dogami");
  });

  it("routes freeform sheet requests to the sheet action", async () => {
    classifyOneBotAiKpRollRouteMock
      .mockResolvedValueOnce({
        action: "traditional",
        confidence: 0.95,
        reason: "user picked journalist",
        occupationKey: "journalist",
      })
      .mockResolvedValueOnce({
        action: "sheet",
        confidence: 0.94,
        reason: "user asked to inspect the current sheet",
      });

    const byName = await createTools();
    await enterChargenPrompt(byName);
    await byName.onebot_aikp_roll.execute("3", {
      action: "semantic_reply",
      originalText: "记者吧",
      senderName: "Dogami",
    });

    const sheet = await byName.onebot_aikp_roll.execute("4", {
      action: "semantic_reply",
      originalText: "我看看我现在的人物卡",
      senderName: "Dogami",
    });
    expect(sheet.details.routedAction).toBe("sheet");
    expect(sheet.details.semanticResolution).toMatchObject({
      action: "sheet",
    });
    expect(sheet.details.occupationKey).toBeNull();
    expect(sheet.details.usedMessage).toBe("/aikp sheet");
    expect(sheet.details.replyText).toContain("Dogami｜记者");
  });

  it("returns a no-op when the semantic roll router decides the message is normal chat", async () => {
    classifyOneBotAiKpRollRouteMock.mockResolvedValueOnce({
      action: "normal",
      confidence: 0.88,
      reason: "feature discussion only",
    });

    const byName = await createTools();
    const result = await byName.onebot_aikp_roll.execute("1", {
      action: "semantic_reply",
      originalText: "你这套车卡后面还准备怎么扩展",
      senderName: "Dogami",
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.noRollAction).toBe(true);
    expect(result.details.replyText).toBeNull();
    expect(result.details.semanticResolution).toMatchObject({
      action: "normal",
    });
  });
});
