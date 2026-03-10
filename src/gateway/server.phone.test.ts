import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";

import { writeConfigFile } from "../config/config.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  const started = await startServerWithClient();
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway server phone", () => {
  test("phone.list returns configured accounts", async () => {
    await writeConfigFile({
      phones: {
        defaultAccountId: "work",
        accounts: {
          work: {
            name: "Work Phone",
            deviceId: "emulator-5554",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
          },
        },
      },
    });

    const res = await rpcReq<{
      defaultAccountId?: string;
      accounts?: Array<{ id?: string; deviceId?: string; provider?: string }>;
    }>(ws, "phone.list", {});

    expect(res.ok).toBe(true);
    expect(res.payload?.defaultAccountId).toBe("work");
    expect(res.payload?.accounts?.[0]).toMatchObject({
      id: "work",
      deviceId: "emulator-5554",
      provider: "autoglm",
    });
  });

  test("phone.check and phone.run proxy runtime responses", async () => {
    await writeConfigFile({
      phones: {
        defaultAccountId: "work",
        accounts: {
          work: {
            name: "Work Phone",
            deviceId: "emulator-5554",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
            model: {
              baseUrl: "http://127.0.0.1:8000/v1",
              model: "autoglm-phone",
              apiKey: "EMPTY",
            },
            defaults: {
              mode: "direct",
            },
          },
        },
      },
    });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/connectivity-check")) {
        return new Response(
          JSON.stringify({ overall: "pass", checks: [{ name: "adb", ok: true }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.endsWith("/run")) {
        return new Response(JSON.stringify({ ok: true, run_id: "run-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const checkRes = await rpcReq<{ check?: { overall?: string } }>(ws, "phone.check", {
      accountId: "work",
    });
    expect(checkRes.ok).toBe(true);
    expect(checkRes.payload?.check?.overall).toBe("pass");

    const runRes = await rpcReq<{ runId?: string; raw?: { run_id?: string } }>(ws, "phone.run", {
      accountId: "work",
      task: "打开小红书",
    });
    expect(runRes.ok).toBe(true);
    expect(runRes.payload?.runId).toBe("run-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("phone.screen proxies the runtime screenshot response", async () => {
    await writeConfigFile({
      phones: {
        defaultAccountId: "work",
        accounts: {
          work: {
            name: "Work Phone",
            deviceId: "55CQSWHYW4NJGAXW",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
          },
        },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://127.0.0.1:8001/api/screen?device_id=55CQSWHYW4NJGAXW") {
          return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const res = await rpcReq<{ screenshot?: { mimeType?: string; bytes?: number } }>(
      ws,
      "phone.screen",
      {
        accountId: "work",
      },
    );

    expect(res.ok).toBe(true);
    expect(res.payload?.screenshot).toMatchObject({
      mimeType: "image/png",
      bytes: 4,
    });
  });

  test("phone.discover returns runtime devices with templating hints", async () => {
    await writeConfigFile({
      phones: {
        defaultAccountId: "auto",
        accounts: {
          auto: {
            name: "Auto Phone",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
          },
          work: {
            name: "Work Phone",
            deviceId: "55CQSWHYW4NJGAXW",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
          },
        },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/devices")) {
          return new Response(
            JSON.stringify({
              device_type: "adb",
              devices: [{ device_id: "55CQSWHYW4NJGAXW", state: "device" }],
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const res = await rpcReq<{
      devices?: Array<{ configuredAccountId?: string; suggestedAccountId?: string }>;
    }>(ws, "phone.discover", { accountId: "auto" });

    expect(res.ok).toBe(true);
    expect(res.payload?.devices?.[0]).toMatchObject({
      configuredAccountId: "work",
      suggestedAccountId: "work",
    });
  });
});
