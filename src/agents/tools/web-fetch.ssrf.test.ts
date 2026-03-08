import { afterEach, describe, expect, it, vi } from "vitest";

import { resolvePinnedHostname } from "../../infra/net/ssrf.js";

function makeHeaders(map: Record<string, string>): { get: (key: string) => string | null } {
  return {
    get: (key) => map[key.toLowerCase()] ?? null,
  };
}

function redirectResponse(location: string): Response {
  return {
    ok: false,
    status: 302,
    headers: makeHeaders({ location }),
    body: { cancel: vi.fn() },
  } as Response;
}

function textResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    headers: makeHeaders({ "content-type": "text/plain" }),
    text: async () => body,
  } as Response;
}

describe("web_fetch SSRF protection", () => {
  const priorFetch = global.fetch;

  function createResolvePinnedHost(records: Record<string, string>) {
    return async (hostname: string) =>
      await resolvePinnedHostname(hostname, async (resolvedHostname) => {
        const address = records[resolvedHostname];
        if (!address) {
          throw new Error(`Unexpected hostname: ${resolvedHostname}`);
        }
        return [{ address, family: address.includes(":") ? 6 : 4 }];
      });
  }

  afterEach(() => {
    // @ts-expect-error restore
    global.fetch = priorFetch;
    vi.restoreAllMocks();
  });

  it("blocks localhost hostnames before fetch/firecrawl", async () => {
    const fetchSpy = vi.fn();
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

    const { createWebFetchTool } = await import("./web-tools.js");
    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: {
              cacheTtlMinutes: 0,
              firecrawl: { apiKey: "firecrawl-test" },
            },
          },
        },
      },
    });

    await expect(tool?.execute?.("call", { url: "http://localhost/test" })).rejects.toThrow(
      /Blocked hostname/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks private IP literals without DNS", async () => {
    const fetchSpy = vi.fn();
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

    const { createWebFetchTool } = await import("./web-tools.js");
    const tool = createWebFetchTool({
      config: {
        tools: { web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } } } },
      },
    });

    await expect(tool?.execute?.("call", { url: "http://127.0.0.1/test" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    await expect(tool?.execute?.("call", { url: "http://[::ffff:127.0.0.1]/" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks when DNS resolves to private addresses", async () => {
    const fetchSpy = vi.fn();
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

    const { createWebFetchTool } = await import("./web-tools.js");
    const tool = createWebFetchTool({
      config: {
        tools: { web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } } } },
      },
      resolvePinnedHost: createResolvePinnedHost({
        "private.test": "10.0.0.5",
      }),
    });

    await expect(tool?.execute?.("call", { url: "https://private.test/resource" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("blocks redirects to private hosts", async () => {
    const fetchSpy = vi.fn().mockResolvedValueOnce(redirectResponse("http://127.0.0.1/secret"));
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

    const { createWebFetchTool } = await import("./web-tools.js");
    const tool = createWebFetchTool({
      config: {
        tools: {
          web: {
            fetch: { cacheTtlMinutes: 0, firecrawl: { apiKey: "firecrawl-test" } },
          },
        },
      },
      resolvePinnedHost: createResolvePinnedHost({
        "example.com": "93.184.216.34",
      }),
    });

    await expect(tool?.execute?.("call", { url: "https://example.com" })).rejects.toThrow(
      /private|internal|blocked/i,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("allows public hosts", async () => {
    const fetchSpy = vi.fn().mockResolvedValue(textResponse("ok"));
    // @ts-expect-error mock fetch
    global.fetch = fetchSpy;

    const { createWebFetchTool } = await import("./web-tools.js");
    const tool = createWebFetchTool({
      config: {
        tools: { web: { fetch: { cacheTtlMinutes: 0, firecrawl: { enabled: false } } } },
      },
      resolvePinnedHost: createResolvePinnedHost({
        "example.com": "93.184.216.34",
      }),
    });

    const result = await tool?.execute?.("call", { url: "https://example.com" });
    expect(result?.details).toMatchObject({
      status: 200,
      extractor: "raw",
    });
  });
});
