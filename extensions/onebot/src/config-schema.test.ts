import { describe, expect, it } from "vitest";

import { onebotChannelConfigSchema } from "./config-schema.js";

describe("onebotChannelConfigSchema", () => {
  it("builds JSON Schema without throwing", () => {
    expect(onebotChannelConfigSchema.schema).toBeTruthy();
    expect(onebotChannelConfigSchema.schema).toMatchObject({
      type: "object",
      properties: expect.objectContaining({
        groups: expect.any(Object),
      }),
    });
  });
});
