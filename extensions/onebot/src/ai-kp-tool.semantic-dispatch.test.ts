import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const { classifyOneBotAiKpDispatchRouteMock } = vi.hoisted(() => ({
  classifyOneBotAiKpDispatchRouteMock: vi.fn(),
}));

vi.mock("./ai-kp-activation.js", async () => {
  const actual = await vi.importActual<typeof import("./ai-kp-activation.js")>("./ai-kp-activation.js");
  return {
    ...actual,
    classifyOneBotAiKpDispatchRoute: classifyOneBotAiKpDispatchRouteMock,
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
  const root = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-dispatch-"));
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

describe("onebot_aikp_dispatch", () => {
  it("routes a full natural-language AI-KP flow without hand-picking narrow tools first", async () => {
    classifyOneBotAiKpDispatchRouteMock
      .mockResolvedValueOnce({
        route: "session",
        sessionAction: "start",
        confidence: 0.99,
        reason: "user wants to begin a run",
      })
      .mockResolvedValueOnce({
        route: "session",
        sessionAction: "select_story_pack",
        storyPackId: "old-church-arc-pack",
        confidence: 0.97,
        reason: "user chose the old church pack",
      })
      .mockResolvedValueOnce({
        route: "roll",
        rollAction: "traditional",
        occupationKey: "journalist",
        confidence: 0.96,
        reason: "user picked journalist",
      })
      .mockResolvedValueOnce({
        route: "roll",
        rollAction: "traditional",
        confidence: 0.95,
        reason: "user is giving skill allocation preferences",
      })
      .mockResolvedValueOnce({
        route: "scene",
        confidence: 0.95,
        reason: "user is inspecting the altar area",
        sceneIntent: {
          actionKind: "explore",
          intentSummary: "Inspect the altar for fresh scratches",
          skillKey: "Spot Hidden",
          targetArea: "祭坛区",
          targetClue: "祭坛背后的异常刮痕",
        },
      });

    const byName = await createTools();

    const start = await byName.onebot_aikp_dispatch.execute("1", {
      originalText: "我想跑团",
      senderName: "Dogami",
    });
    expect(start.details.routedTool).toBe("onebot_aikp_session");
    expect(start.details.dispatchRoute).toBe("session");
    expect(start.details.replyText).toContain("当前可选剧本");

    const pack = await byName.onebot_aikp_dispatch.execute("2", {
      originalText: "旧教堂那个就行",
      senderName: "Dogami",
    });
    expect(pack.details.routedTool).toBe("onebot_aikp_session");
    expect(pack.details.replyText).toContain("你现在还没车卡");

    const roll = await byName.onebot_aikp_dispatch.execute("3", {
      originalText: "记者吧",
      senderName: "Dogami",
    });
    expect(roll.details.routedTool).toBe("onebot_aikp_roll");
    expect(roll.details.replyText).toContain("职业先定成 记者");

    const finalize = await byName.onebot_aikp_dispatch.execute("4", {
      originalText: "信用20，侦查、图书馆、心理学、说服",
      senderName: "Dogami",
    });
    expect(finalize.details.routedTool).toBe("onebot_aikp_roll");
    expect(finalize.details.usedMessage).toBe("信用20，侦查、图书馆、心理学、说服");
    expect(finalize.details.replyText).toContain("传统随机车卡 已经给你落好了");
    expect(finalize.details.replyText).toContain("Dogami｜记者");

    const scene = await byName.onebot_aikp_dispatch.execute("5", {
      originalText: "我借着手电去看祭坛背后的刮痕",
      senderName: "Dogami",
    });
    expect(scene.details.routedTool).toBe("onebot_aikp_scene_turn");
    expect(scene.details.dispatchRoute).toBe("scene");
    expect(scene.details.ok).toBe(true);
    expect(scene.details.replyText).toContain("Spot Hidden");
    expect(scene.details.semanticIntent.actionKind).toBe("explore");
  });

  it("returns a no-op when dispatch decides the message is ordinary chat", async () => {
    classifyOneBotAiKpDispatchRouteMock.mockResolvedValueOnce({
      route: "normal",
      confidence: 0.89,
      reason: "feature discussion only",
    });

    const byName = await createTools();
    const result = await byName.onebot_aikp_dispatch.execute("1", {
      originalText: "你这套跑团功能后面还准备怎么扩展",
      senderName: "Dogami",
    });
    expect(result.details.ok).toBe(false);
    expect(result.details.noDispatchAction).toBe(true);
    expect(result.details.replyText).toBeNull();
  });
});

describe("onebot_aikp_scene_turn semantic inference", () => {
  it("can infer scene intent from originalText alone when dispatch classifies it as a scene action", async () => {
    classifyOneBotAiKpDispatchRouteMock
      .mockResolvedValueOnce({
        route: "session",
        sessionAction: "start",
        confidence: 0.99,
        reason: "user wants to begin a run",
      })
      .mockResolvedValueOnce({
        route: "session",
        sessionAction: "select_story_pack",
        storyPackId: "old-church-arc-pack",
        confidence: 0.97,
        reason: "user chose the old church pack",
      })
      .mockResolvedValueOnce({
        route: "roll",
        rollAction: "quickfire",
        occupationKey: "journalist",
        confidence: 0.96,
        reason: "user wants a quick journalist sheet",
      })
      .mockResolvedValueOnce({
        route: "scene",
        confidence: 0.94,
        reason: "user is inspecting the altar area",
        sceneIntent: {
          actionKind: "explore",
          intentSummary: "Inspect the altar for fresh scratches",
          skillKey: "Spot Hidden",
          targetArea: "祭坛区",
          targetClue: "祭坛背后的异常刮痕",
        },
      });

    const byName = await createTools();
    await byName.onebot_aikp_dispatch.execute("1", {
      originalText: "我想跑团",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_dispatch.execute("2", {
      originalText: "旧教堂那个就行",
      senderName: "Dogami",
    });
    await byName.onebot_aikp_dispatch.execute("3", {
      originalText: "给我快速记者卡",
      senderName: "Dogami",
    });

    const scene = await byName.onebot_aikp_scene_turn.execute("4", {
      originalText: "我借着手电去看祭坛背后的刮痕",
      senderName: "Dogami",
    });
    expect(scene.details.ok).toBe(true);
    expect(scene.details.semanticIntent.actionKind).toBe("explore");
    expect(scene.details.dispatchResolution).toMatchObject({
      route: "scene",
    });
    expect(scene.details.replyText).toContain("Spot Hidden");
  });
});
