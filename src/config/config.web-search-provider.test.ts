import { describe, expect, it } from "vitest";

import { validateConfigObject } from "./config.js";

describe("web search provider config", () => {
  it("accepts perplexity provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "perplexity",
            perplexity: {
              apiKey: "test-key",
              baseUrl: "https://api.perplexity.ai",
              model: "perplexity/sonar-pro",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("accepts exa provider and config", () => {
    const res = validateConfigObject({
      tools: {
        web: {
          search: {
            enabled: true,
            provider: "exa",
            exa: {
              apiKeys: ["test-key-1", "test-key-2"],
              baseUrl: "https://api.exa.ai",
              searchType: "auto",
              contentMode: "highlights",
              maxCharacters: 4000,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });
});
