import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";

import type { ClawdbotConfig } from "../config/config.js";
import { PhoneManager } from "./manager.js";
import { clearAllCachedPhoneScreens } from "./screenshot-cache.js";

const config: ClawdbotConfig = {
  phones: {
    defaultAccountId: "work",
    accounts: {
      work: {
        name: "Work Phone",
        runtime: {
          apiUrl: "http://127.0.0.1:8001/api",
        },
      },
      lab: {
        enabled: false,
        runtime: {
          apiUrl: "http://127.0.0.1:8002/api",
        },
      },
    },
  },
};

describe("PhoneManager", () => {
  afterEach(() => {
    clearAllCachedPhoneScreens();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("lists accounts with the resolved default id", () => {
    const manager = new PhoneManager(config);
    expect(manager.list()).toEqual({
      defaultAccountId: "work",
      accounts: [
        {
          id: "work",
          name: "Work Phone",
          enabled: true,
          deviceId: undefined,
          deviceType: "adb",
          provider: "autoglm",
          apiUrl: "http://127.0.0.1:8001/api",
          uiUrl: undefined,
        },
        {
          id: "lab",
          name: "lab",
          enabled: false,
          deviceId: undefined,
          deviceType: "adb",
          provider: "autoglm",
          apiUrl: "http://127.0.0.1:8002/api",
          uiUrl: undefined,
        },
      ],
    });
  });

  it("blocks runs for disabled accounts before hitting the runtime", async () => {
    const manager = new PhoneManager(config);
    await expect(manager.run({ accountId: "lab", task: "Open the app" })).rejects.toMatchObject({
      message: 'phone account "lab" is disabled',
    });
  });

  it("captures the current screen for the selected account", async () => {
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

    const manager = new PhoneManager({
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

    const result = await manager.screen({ accountId: "work" });
    expect(result.ok).toBe(true);
    expect(result.screenshot).toMatchObject({
      deviceId: "55CQSWHYW4NJGAXW",
      mimeType: "image/png",
      bytes: 4,
    });
  });

  it("compresses oversized screenshots before returning them", async () => {
    const tallPng = await sharp({
      create: {
        width: 1440,
        height: 3120,
        channels: 3,
        background: { r: 248, g: 248, b: 248 },
      },
    })
      .png()
      .toBuffer();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://127.0.0.1:8001/api/screen?device_id=55CQSWHYW4NJGAXW") {
          return new Response(tallPng, {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const manager = new PhoneManager({
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

    const result = await manager.screen({ accountId: "work" });

    expect(result.screenshot.mimeType).toBe("image/jpeg");
    expect(result.screenshot.bytes).toBeLessThan(tallPng.byteLength);
  });

  it("reuses a fresh cached screen and refreshes it after the TTL expires", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-09T00:00:00.000Z"));

    const fetchMock = vi.fn(async (url: string) => {
      if (url !== "http://127.0.0.1:8001/api/screen?device_id=55CQSWHYW4NJGAXW") {
        throw new Error(`unexpected fetch: ${url}`);
      }
      return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
        status: 200,
        headers: { "content-type": "image/png" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const manager = new PhoneManager({
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

    await manager.screen({ accountId: "work" });
    await manager.screen({ accountId: "work" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-03-09T00:00:03.500Z"));
    await manager.screen({ accountId: "work" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("attaches a screenshot after phone.run when requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url === "http://127.0.0.1:8001/api/run") {
          return new Response(JSON.stringify({ ok: true, run_id: "run-1" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url === "http://127.0.0.1:8001/api/screen?device_id=55CQSWHYW4NJGAXW") {
          return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
      }),
    );

    const manager = new PhoneManager({
      phones: {
        defaultAccountId: "work",
        accounts: {
          work: {
            name: "Work Phone",
            deviceId: "55CQSWHYW4NJGAXW",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
            defaults: {
              mode: "direct",
            },
          },
        },
      },
    });

    const result = await manager.run({
      accountId: "work",
      task: "打开设置",
      includeScreenshot: true,
      waitForCompletion: false,
    });

    expect(result.screenshot).toMatchObject({
      deviceId: "55CQSWHYW4NJGAXW",
      mimeType: "image/png",
      bytes: 4,
    });
  });

  it("waits an existing run and attaches a completion screenshot", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://127.0.0.1:8001/api/run/stream?run_id=run-2") {
          return new Response(
            [": stream-start", "", 'data: {"type":"end","message":"done"}', ""].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        }
        if (url === "http://127.0.0.1:8001/api/screen?device_id=55CQSWHYW4NJGAXW") {
          return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const manager = new PhoneManager({
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

    const result = await manager.wait({
      accountId: "work",
      runId: "run-2",
      includeScreenshot: true,
    });

    expect(result).toMatchObject({
      ok: true,
      status: "completed",
      completed: true,
      runId: "run-2",
      screenshot: {
        deviceId: "55CQSWHYW4NJGAXW",
        mimeType: "image/png",
        bytes: 4,
      },
    });
  });

  it("decorates discovered devices with account suggestions", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            device_type: "adb",
            devices: [
              { device_id: "55CQSWHYW4NJGAXW", state: "device" },
              { device_id: "emulator-5554", state: "device" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const manager = new PhoneManager({
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
          auto: {
            name: "Auto Phone",
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
          },
        },
      },
    });

    const result = await manager.discover("auto");

    expect(result.devices).toEqual([
      expect.objectContaining({
        deviceId: "55CQSWHYW4NJGAXW",
        configuredAccountId: "work",
        suggestedAccountId: "work",
        suggestedName: "Work Phone",
        autoPickEligible: false,
      }),
      expect.objectContaining({
        deviceId: "emulator-5554",
        configuredAccountId: undefined,
        suggestedAccountId: "phone-emulator-5554",
        suggestedName: "Phone emulator",
        autoPickEligible: true,
      }),
    ]);
  });
});
