import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";

import { maybeHandleOneBotAiKpRuntime } from "./ai-kp-runtime.js";

const tempDirs: string[] = [];

async function createRuntimeModule(source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "onebot-aikp-runtime-"));
  tempDirs.push(root);
  const modulePath = path.join(root, "runtime.cjs");
  await mkdir(root, { recursive: true });
  await writeFile(modulePath, source, "utf8");
  return modulePath;
}

function buildConfig(runtimeModulePath: string): ClawdbotConfig {
  return {
    channels: {
      onebot: {
        aiKp: {
          runtimeModulePath,
          storageRoot: "/tmp/aikp-runtime",
        },
      },
    },
  } as ClawdbotConfig;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("maybeHandleOneBotAiKpRuntime", () => {
  it("delegates handled group messages to the AI-KP runtime and sends the reply", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return {
            ignored: false,
            reason: null,
            replyText: "KP reply",
            sendAction: { action: "send_group_msg", params: { group_id: "875336657", message: "KP reply" } },
            contextRef: "/tmp/context.json"
          };
        }
      };
    `);
    const sendText = vi.fn(async () => ({ messageId: "1" }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 我想跑团",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });

    expect(result).toMatchObject({
      handled: true,
      replyText: "KP reply",
      contextRef: "/tmp/context.json",
    });
    expect(sendText).toHaveBeenCalledWith({
      target: "group:875336657",
      text: "KP reply",
    });
  });

  it("falls back when the AI-KP runtime ignores the message", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return {
            ignored: true,
            reason: "inactive_group_session",
            replyText: null,
            sendAction: null
          };
        }
      };
    `);
    const sendText = vi.fn(async () => ({ messageId: "1" }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 今天几点了",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });

    expect(result).toMatchObject({
      handled: false,
      reason: "inactive_group_session",
    });
    expect(sendText).not.toHaveBeenCalled();
  });

  it("reroutes ignored idle messages through the activation classifier", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope(envelope) {
          const text = String(envelope.raw_message || envelope.message || "");
          if (text === "我想跑团") {
            return {
              ignored: false,
              reason: null,
              replyText: "AI-KP entered",
              sendAction: { action: "send_group_msg", params: { group_id: "875336657", message: "AI-KP entered" } },
              contextRef: "/tmp/context.json"
            };
          }
          return {
            ignored: true,
            reason: "inactive_group_session",
            replyText: null,
            sendAction: null
          };
        }
      };
    `);
    const sendText = vi.fn(async () => ({ messageId: "1" }));
    const classifyActivationIntent = vi.fn(async () => ({
      action: "start" as const,
      confidence: 0.92,
      reason: "direct play request",
    }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 咱们今晚来一把克系调查吧",
      },
      cleanedText: "咱们今晚来一把克系调查吧",
      wasMentioned: true,
      isGroup: true,
      sendText,
      classifyActivationIntent,
    });

    expect(result).toMatchObject({
      handled: true,
      replyText: "AI-KP entered",
    });
    expect(classifyActivationIntent).toHaveBeenCalledOnce();
    expect(sendText).toHaveBeenCalledWith({
      target: "group:875336657",
      text: "AI-KP entered",
    });
  });

  it("keeps ordinary chat on the normal fallback path when the classifier says normal", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return {
            ignored: true,
            reason: "inactive_group_session",
            replyText: null,
            sendAction: null
          };
        }
      };
    `);
    const sendText = vi.fn(async () => ({ messageId: "1" }));
    const classifyActivationIntent = vi.fn(async () => ({
      action: "normal" as const,
      confidence: 0.81,
      reason: "ordinary chat",
    }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 今天午饭吃啥",
      },
      cleanedText: "今天午饭吃啥",
      wasMentioned: true,
      isGroup: true,
      sendText,
      classifyActivationIntent,
    });

    expect(result).toMatchObject({
      handled: false,
      reason: "inactive_group_session",
    });
    expect(classifyActivationIntent).toHaveBeenCalledOnce();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("does not delegate unmentioned group messages", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return { ignored: false, replyText: "should not run" };
        }
      };
    `);
    const sendText = vi.fn(async () => ({ messageId: "1" }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "我想跑团",
      },
      wasMentioned: false,
      isGroup: true,
      sendText,
    });

    expect(result).toBeNull();
    expect(sendText).not.toHaveBeenCalled();
  });

  it("serializes same-group AI-KP runtime turns", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      let count = 0;
      module.exports = {
        handleOneBotEnvelope() {
          count += 1;
          return {
            ignored: false,
            reason: null,
            replyText: "KP reply " + count,
            sendAction: { action: "send_group_msg", params: { group_id: "875336657", message: "KP reply " + count } }
          };
        }
      };
    `);

    let releaseFirst: (() => void) | null = null;
    let firstSendEntered: (() => void) | null = null;
    const firstSendReady = new Promise<void>((resolve) => {
      firstSendEntered = resolve;
    });
    const sendText = vi.fn(async ({ text }: { target: string; text: string }) => {
      if (text === "KP reply 1") {
        firstSendEntered?.();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { messageId: text };
    });

    const first = maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 第一条",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });
    await firstSendReady;

    const second = maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "9527",
        raw_message: "@麦麦 第二条",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sendText).toHaveBeenCalledTimes(1);

    releaseFirst?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ handled: true, replyText: "KP reply 1" });
    expect(secondResult).toMatchObject({ handled: true, replyText: "KP reply 2" });
    expect(sendText).toHaveBeenNthCalledWith(1, {
      target: "group:875336657",
      text: "KP reply 1",
    });
    expect(sendText).toHaveBeenNthCalledWith(2, {
      target: "group:875336657",
      text: "KP reply 2",
    });
  });

  it("keeps different-group AI-KP runtime turns independent", async () => {
    const runtimeModulePath = await createRuntimeModule(`
      let count = 0;
      module.exports = {
        handleOneBotEnvelope(envelope) {
          count += 1;
          const groupId = String(envelope.group_id || "");
          return {
            ignored: false,
            reason: null,
            replyText: "KP reply " + count + "@" + groupId,
            sendAction: { action: "send_group_msg", params: { group_id: groupId, message: "KP reply " + count + "@" + groupId } }
          };
        }
      };
    `);

    const started: string[] = [];
    let releaseAll: (() => void) | null = null;
    const allowFinish = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const sendText = vi.fn(async ({ target }: { target: string; text: string }) => {
      started.push(target);
      await allowFinish;
      return { messageId: target };
    });

    const first = maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 A 组",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });
    const second = maybeHandleOneBotAiKpRuntime({
      cfg: buildConfig(runtimeModulePath),
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "95270001",
        user_id: "9527",
        raw_message: "@麦麦 B 组",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(started).toEqual(expect.arrayContaining(["group:875336657", "group:95270001"]));
    expect(sendText).toHaveBeenCalledTimes(2);

    releaseAll?.();

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toMatchObject({ handled: true });
    expect(secondResult).toMatchObject({ handled: true });
  });

  it("splits over-limit AI-KP replies into ordered segments", async () => {
    const replyText = [
      "【开场简报】",
      "调查员们先在教堂门口汇合，确认钟楼和地下室都可能有线索。",
      "",
      "【当前线索】",
      "钟楼传来第二次异响，地下室入口出现新的泥痕。",
      "",
      "【建议行动】",
      "先分两人去钟楼压制风险，剩下的人守住地下室入口并准备照明。",
    ].join("\n")
      .repeat(5);
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return {
            ignored: false,
            reason: null,
            replyText: ${JSON.stringify(replyText)},
            sendAction: { action: "send_group_msg", params: { group_id: "875336657", message: "ignored" } }
          };
        }
      };
    `);
    const sendText = vi.fn(async ({ text }: { target: string; text: string }) => ({
      messageId: String(text.length),
    }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: {
        ...buildConfig(runtimeModulePath),
        channels: {
          onebot: {
            aiKp: {
              runtimeModulePath,
              storageRoot: "/tmp/aikp-runtime",
            },
            textChunkLimit: 120,
            chunkMode: "newline",
          },
        },
      } as ClawdbotConfig,
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 开场",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });

    expect(result).toMatchObject({
      handled: true,
      replyMode: "segments",
    });
    expect(result?.replySegments?.length).toBeGreaterThan(1);
    expect(sendText).toHaveBeenCalledTimes(result?.replySegments?.length ?? 0);
    expect((result?.replySegments ?? []).join("")).toBe(replyText);
    expect(sendText.mock.calls.map(([call]) => call.text).join("")).toBe(replyText);
  });

  it("keeps short multi-paragraph AI-KP replies as a single send", async () => {
    const replyText = [
      "【状态更新】",
      "你们暂时安全。",
      "",
      "【下一步】",
      "可以先盘点装备，再决定是否继续深入。",
    ].join("\n");
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return {
            ignored: false,
            reason: null,
            replyText: ${JSON.stringify(replyText)},
            sendAction: { action: "send_group_msg", params: { group_id: "875336657", message: "ignored" } }
          };
        }
      };
    `);
    const sendText = vi.fn(async () => ({ messageId: "1" }));

    const result = await maybeHandleOneBotAiKpRuntime({
      cfg: {
        ...buildConfig(runtimeModulePath),
        channels: {
          onebot: {
            aiKp: {
              runtimeModulePath,
              storageRoot: "/tmp/aikp-runtime",
            },
            textChunkLimit: 4000,
            chunkMode: "newline",
          },
        },
      } as ClawdbotConfig,
      envelope: {
        post_type: "message",
        message_type: "group",
        group_id: "875336657",
        user_id: "281894872",
        raw_message: "@麦麦 状态",
      },
      wasMentioned: true,
      isGroup: true,
      sendText,
    });

    expect(result).toMatchObject({
      handled: true,
      replyMode: "single",
      replySegments: [replyText],
    });
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(sendText).toHaveBeenCalledWith({
      target: "group:875336657",
      text: replyText,
    });
  });

  it("reports the failed AI-KP segment before rethrowing send errors", async () => {
    const replyText = `${"第一段线索。".repeat(12)}\n\n${"第二段线索。".repeat(12)}`;
    const runtimeModulePath = await createRuntimeModule(`
      module.exports = {
        handleOneBotEnvelope() {
          return {
            ignored: false,
            reason: null,
            replyText: ${JSON.stringify(replyText)},
            sendAction: { action: "send_group_msg", params: { group_id: "875336657", message: "ignored" } }
          };
        }
      };
    `);
    const onError = vi.fn();
    const sendText = vi
      .fn<({ target, text }: { target: string; text: string }) => Promise<{ messageId?: string }>>()
      .mockImplementationOnce(async () => ({ messageId: "first" }))
      .mockImplementationOnce(async () => {
        throw new Error("send failed");
      });

    await expect(
      maybeHandleOneBotAiKpRuntime({
        cfg: {
          ...buildConfig(runtimeModulePath),
          channels: {
            onebot: {
              aiKp: {
                runtimeModulePath,
                storageRoot: "/tmp/aikp-runtime",
              },
              textChunkLimit: 90,
              chunkMode: "newline",
            },
          },
        } as ClawdbotConfig,
        envelope: {
          post_type: "message",
          message_type: "group",
          group_id: "875336657",
          user_id: "281894872",
          raw_message: "@麦麦 继续",
        },
        wasMentioned: true,
        isGroup: true,
        sendText,
        onError,
      }),
    ).rejects.toThrow("send failed");

    expect(sendText).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledWith(
      expect.stringContaining("failed sending reply segment 2/2 to group:875336657"),
    );
  });
});
