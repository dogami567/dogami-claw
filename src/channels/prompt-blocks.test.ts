import { describe, expect, it } from "vitest";

import { joinPromptBlocks } from "./prompt-blocks.js";

describe("joinPromptBlocks", () => {
  it("dedupes repeated plain-text prompt blocks", () => {
    expect(joinPromptBlocks(["Alpha", "Alpha", "Beta"])).toBe("Alpha\n\nBeta");
  });

  it("dedupes marker blocks by tag name and keeps the latest block", () => {
    expect(
      joinPromptBlocks([
        "<onebot_ai_kp_context>old</onebot_ai_kp_context>",
        "Group prompt",
        "<onebot_ai_kp_context>new</onebot_ai_kp_context>",
      ]),
    ).toBe("Group prompt\n\n<onebot_ai_kp_context>new</onebot_ai_kp_context>");
  });

  it("ignores empty blocks", () => {
    expect(joinPromptBlocks([" ", undefined, "\n\n", "Prompt"])).toBe("Prompt");
  });
});
