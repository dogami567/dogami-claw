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
});
