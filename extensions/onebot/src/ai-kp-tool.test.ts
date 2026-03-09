import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

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

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("createOneBotAiKpTools", () => {
  it("returns null outside onebot conversations", () => {
    const tools = createOneBotAiKpTools(buildApi("/tmp/aikp", "/tmp/store") as any, {
      messageChannel: "telegram",
      sessionKey: "telegram:123",
      agentId: "main",
    } as any);
    expect(tools).toBeNull();
  });

  it("runs the semantic AI-KP flow through session, roll, scene-turn, and history tools", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-tool-"));
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
    expect(tools).toBeTruthy();

    const byName = Object.fromEntries((tools ?? []).map((tool) => [tool.name, tool]));

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

    const roll = await byName.onebot_aikp_roll.execute("3", {
      action: "traditional",
      occupationKey: "journalist",
      originalText: "先给我来张记者卡",
      senderName: "Dogami",
    });
    expect(roll.details.replyText).toContain("职业先定成 记者");
    expect(roll.details.usedMessage).toBe("/aikp roll journalist");

    const finalize = await byName.onebot_aikp_roll.execute("4", {
      action: "traditional",
      originalText: "自动分配",
      senderName: "Dogami",
    });
    expect(finalize.details.replyText).toContain("传统随机车卡 已经给你落好了");
    expect(finalize.details.replyText).toContain("Dogami｜记者");
    expect(finalize.details.usedMessage).toBe("自动分配");

    const turn = await byName.onebot_aikp_scene_turn.execute("5", {
      originalText: "I check the altar carefully",
      actionKind: "explore",
      intentSummary: "Inspect the altar for fresh scratches",
      skillKey: "Spot Hidden",
      targetArea: "祭坛区",
      targetClue: "祭坛背后的异常刮痕",
      senderName: "Dogami",
    });
    expect(turn.details.ok).toBe(true);
    expect(turn.details.replyText).toContain("Spot Hidden");
    expect(turn.details.semanticIntent.actionKind).toBe("explore");
    expect(turn.details.resolvedAction.revealClueId).toBe("clue-altar-scratch");
    expect(turn.details.matchedRuleId).toBe("altar-scratch-inspect");
    expect(turn.details.contextPacket).toBeTruthy();

    const history = await byName.onebot_aikp_history.execute("6", {
      section: "all",
      limit: 6,
    });
    expect(history.details.summaryChunks).toEqual(expect.any(Array));
    expect(history.details.recentChat.length).toBeGreaterThan(0);
    expect(history.details.recentOperations.length).toBeGreaterThan(0);
  });
});
