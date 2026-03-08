import { afterEach, describe, expect, it, vi } from "vitest";

import { createWebSearchTool } from "./web-search.js";

type MockResponse = {
  ok: boolean;
  status: number;
  text?: () => Promise<string>;
  json?: () => Promise<unknown>;
};

function errorResponse(status: number, message: string): MockResponse {
  return {
    ok: false,
    status,
    text: async () => message,
  };
}

function okResponse(payload: unknown): MockResponse {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
  };
}

describe("web_search exa provider", () => {
  const priorFetch = global.fetch;

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("rotates API keys on 403 and succeeds", async () => {
    const mockFetch = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const apiKey = headers["x-api-key"];

      if (apiKey === "key-1") {
        return Promise.resolve(errorResponse(403, "Forbidden")) as Promise<Response>;
      }
      if (apiKey === "key-2") {
        return Promise.resolve(
          okResponse({
            results: [
              {
                title: "Example",
                url: "https://example.com/",
                highlights: ["Example snippet"],
              },
            ],
          }),
        ) as Promise<Response>;
      }
      return Promise.resolve(errorResponse(401, "Unauthorized")) as Promise<Response>;
    });
    // @ts-expect-error mock fetch
    global.fetch = mockFetch;

    const tool = createWebSearchTool({
      config: {
        tools: {
          web: {
            search: {
              provider: "exa",
              cacheTtlMinutes: 0,
              exa: {
                apiKeys: ["key-1", "key-2"],
                searchType: "auto",
                contentMode: "highlights",
                maxCharacters: 123,
              },
            },
          },
        },
      },
      sandboxed: false,
    });

    const result = await tool?.execute?.("call", {
      query: "hello",
      count: 1,
      // Ignored for Exa (should not error)
      freshness: "pw",
      country: "US",
      search_lang: "en",
      ui_lang: "en",
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstHeaders = (mockFetch.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
    const secondHeaders = (mockFetch.mock.calls[1]?.[1]?.headers ?? {}) as Record<string, string>;
    expect(firstHeaders["x-api-key"]).toBe("key-1");
    expect(secondHeaders["x-api-key"]).toBe("key-2");

    const rawSecondBody = mockFetch.mock.calls[1]?.[1]?.body;
    const secondBodyText =
      typeof rawSecondBody === "string" ? rawSecondBody : JSON.stringify(rawSecondBody ?? {});
    const secondBody = JSON.parse(secondBodyText) as Record<string, unknown>;
    expect(secondBody).toMatchObject({
      query: "hello",
      num_results: 1,
      type: "auto",
      contents: { highlights: { max_characters: 123 } },
    });

    const details = result?.details as { provider?: string; results?: unknown[] };
    expect(details.provider).toBe("exa");
    expect(details.results?.[0]).toMatchObject({
      title: "Example",
      url: "https://example.com/",
      description: "Example snippet",
      siteName: "example.com",
    });
  });
});
