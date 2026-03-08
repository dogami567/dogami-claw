import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import {
  loadOneBotAiKpContext,
  mergeOneBotGroupSystemPrompt,
  resolveOneBotAiKpConfig,
} from "./ai-kp-context.js";

const tempDirs: string[] = [];

function buildConfig(storageRoot: string): ClawdbotConfig {
  return {
    channels: {
      onebot: {
        aiKp: {
          storageRoot,
        },
      },
    },
  } as ClawdbotConfig;
}

async function createConversationFiles(params: {
  storageRoot: string;
  conversationKey: string;
  sessionMode?: string;
  context?: Record<string, unknown>;
}) {
  const metaDir = path.join(params.storageRoot, "meta");
  const contextDir = path.join(params.storageRoot, "logs", params.conversationKey, "context");
  await mkdir(metaDir, { recursive: true });
  await mkdir(contextDir, { recursive: true });
  await writeFile(
    path.join(metaDir, `${params.conversationKey}.json`),
    JSON.stringify({ sessionMode: params.sessionMode ?? "kp" }, null, 2),
  );
  if (params.context) {
    await writeFile(
      path.join(contextDir, "latest.json"),
      JSON.stringify(params.context, null, 2),
    );
  }
}

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("loadOneBotAiKpContext", () => {
  it("builds a compact prompt block for active group sessions", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-"));
    tempDirs.push(storageRoot);
    const conversationKey = "onebot-group-875336657";
    await createConversationFiles({
      storageRoot,
      conversationKey,
      context: {
        sessionMode: "kp",
        runtimePrompt: [
          "你现在是 AI 跑团的 KP，名字叫麦麦。",
          "语气可爱、口语化，会自然带一点颜文字。",
          "公开骰一定给玩家看清楚点数、目标值和结果。",
        ].join("\n"),
        state: {
          scene: {
            summary: "旧教堂夜访",
            location: "旧教堂地下祭坛",
          },
          turnState: {
            currentActorName: "Dogami",
            round: 3,
          },
          revealedClues: ["祭坛刻痕", "湿泥脚印"],
          investigators: [
            { name: "Dogami", occupation: "记者" },
            { name: "Momo", occupation: "侦探" },
          ],
        },
        summaryChunks: [
          {
            fileName: "summary-0001.md",
            text: [
              "# AI-KP Summary 0001",
              "",
              "- 会话：onebot-group-875336657",
              "- 生成时间：2026-03-08T00:00:00.000Z",
              "",
              "## 状态摘要",
              "- 场景：旧教堂夜访",
              "",
              "## 对话摘录",
              "- KP：守墓人压低了声音。",
            ].join("\n"),
          },
        ],
        recentOperationLines: [
          "- Dogami 过侦查，80/60（失败）",
          "- 守墓人态度转为警惕",
        ],
        recentChatLines: [
          "- Dogami：我想看看祭坛后面",
          "- KP：你看到了一道新的刻痕。",
        ],
      },
    });

    const result = await loadOneBotAiKpContext({
      cfg: buildConfig(storageRoot),
      groupId: "875336657",
    });

    expect(result?.active).toBe(true);
    expect(result?.promptBlock).toContain("<onebot_ai_kp_context>");
    expect(result?.promptBlock).toContain("Scene: 旧教堂夜访");
    expect(result?.promptBlock).toContain("Round: 3");
    expect(result?.promptBlock).toContain("[Recent Summary]");
    expect(result?.promptBlock).toContain("[Recent Operations]");
    expect(result?.promptBlock).toContain("[Recent Chat]");
    expect(result?.promptBlock).toContain("Context file:");
    expect(result?.promptBlock).not.toContain("[Raw Log Paths]");
  });

  it("reports inactive when the AI-KP session is idle", async () => {
    const storageRoot = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-"));
    tempDirs.push(storageRoot);
    const conversationKey = "onebot-group-974862433";
    await createConversationFiles({
      storageRoot,
      conversationKey,
      sessionMode: "idle",
    });

    const result = await loadOneBotAiKpContext({
      cfg: buildConfig(storageRoot),
      groupId: "974862433",
    });

    expect(result).toMatchObject({
      active: false,
      sessionMode: "idle",
      conversationKey,
    });
    expect(result?.promptBlock).toBeUndefined();
  });
});

describe("mergeOneBotGroupSystemPrompt", () => {
  it("dedupes repeated AI-KP marker blocks", () => {
    expect(
      mergeOneBotGroupSystemPrompt([
        "Use short answers.",
        "<onebot_ai_kp_context>old</onebot_ai_kp_context>",
        "<onebot_ai_kp_context>new</onebot_ai_kp_context>",
      ]),
    ).toBe("Use short answers.\n\n<onebot_ai_kp_context>new</onebot_ai_kp_context>");
  });
});

describe("resolveOneBotAiKpConfig", () => {
  it("keeps mention bypass opt-in", () => {
    expect(resolveOneBotAiKpConfig(buildConfig("/tmp/onebot")).bypassMentionWhenActive).toBe(false);
    expect(
      resolveOneBotAiKpConfig({
        channels: {
          onebot: {
            aiKp: {
              storageRoot: "/tmp/onebot",
              bypassMentionWhenActive: true,
            },
          },
        },
      } as ClawdbotConfig).bypassMentionWhenActive,
    ).toBe(true);
  });
});
