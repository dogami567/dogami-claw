import { describe, expect, it } from "vitest";

import { extractOneBotTextAndMentions } from "./message.js";

describe("onebot message parsing", () => {
  it("detects CQ at mention for self_id", () => {
    const parsed = extractOneBotTextAndMentions({
      message: "[CQ:at,qq=123] hello",
      selfId: "123",
    });
    expect(parsed.wasMentioned).toBe(true);
    expect(parsed.hasAnyMention).toBe(true);
    expect(parsed.text).toBe("@123 hello");
  });

  it("parses segment arrays", () => {
    const parsed = extractOneBotTextAndMentions({
      message: [
        { type: "text", data: { text: "hi " } },
        { type: "at", data: { qq: "all" } },
        { type: "text", data: { text: " world" } },
      ],
      selfId: "999",
    });
    expect(parsed.wasMentioned).toBe(false);
    expect(parsed.hasAnyMention).toBe(true);
    expect(parsed.text).toBe("hi @all world");
  });
});

