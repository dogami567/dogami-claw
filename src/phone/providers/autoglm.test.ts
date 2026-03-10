import { afterEach, describe, expect, it, vi } from "vitest";

import { createAutoglmPhoneRuntime } from "./autoglm.js";
import type { PhoneResolvedAccount } from "../types.js";

const account: PhoneResolvedAccount = {
  id: "work",
  name: "Work Phone",
  enabled: true,
  deviceId: "emulator-5554",
  deviceType: "adb",
  runtime: {
    provider: "autoglm",
    uiUrl: "http://127.0.0.1:8001",
    timeoutMs: 5_000,
  },
  model: {
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "autoglm-phone",
    apiKey: "EMPTY",
    monitorBaseUrl: "http://127.0.0.1:8000/v1",
    monitorModel: "autoglm-monitor",
    monitorApiKey: "EMPTY",
  },
  defaults: {
    mode: "monitor",
    lang: "cn",
    maxSteps: 12,
    maxRounds: 6,
    executorMaxSteps: 3,
    monitorUseScreenshot: true,
  },
  raw: {},
};

describe("autoglm phone runtime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("maps runtime device discovery into normalized devices", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            device_type: "adb",
            count: 2,
            devices: [
              { device_id: "55CQSWHYW4NJGAXW", state: "device" },
              { device_id: "emulator-5554", state: "offline" },
            ],
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.discover(account);

    expect(result.runtime.apiUrl).toBe("http://127.0.0.1:8001/api");
    expect(result.count).toBe(2);
    expect(result.deviceType).toBe("adb");
    expect(result.devices).toEqual([
      {
        deviceId: "55CQSWHYW4NJGAXW",
        deviceType: "adb",
        state: "device",
        label: undefined,
        raw: {
          device_id: "55CQSWHYW4NJGAXW",
          state: "device",
        },
      },
      {
        deviceId: "emulator-5554",
        deviceType: "adb",
        state: "offline",
        label: undefined,
        raw: {
          device_id: "emulator-5554",
          state: "offline",
        },
      },
    ]);
  });

  it("derives the api base URL from uiUrl and merges runtime payload defaults", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, run_id: "run-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.run(account, { task: "打开小红书" });

    expect(result.runId).toBe("run-1");
    expect(result.status).toBe("accepted");
    expect(result.completed).toBe(false);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8001/api/run");
    expect(calls[0]?.init?.method).toBe("POST");

    const requestBody = calls[0]?.init?.body;
    const body = JSON.parse(typeof requestBody === "string" ? requestBody : "{}");
    expect(body).toMatchObject({
      mode: "monitor",
      task: "打开小红书",
      goal: "打开小红书",
      device_type: "adb",
      device_id: "emulator-5554",
      lang: "cn",
      max_steps: 12,
      max_rounds: 6,
      executor_max_steps: 3,
      monitor_use_screenshot: true,
      base_url: "http://127.0.0.1:8000/v1",
      model: "autoglm-phone",
      api_key: "EMPTY",
      monitor_base_url: "http://127.0.0.1:8000/v1",
      monitor_model: "autoglm-monitor",
      monitor_api_key: "EMPTY",
    });
  });

  it("waits for the runtime stream when requested", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (url.endsWith("/run")) {
          return new Response(JSON.stringify({ ok: true, run_id: "run-2" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/run/stream?run_id=run-2")) {
          return new Response(
            [
              ": stream-start",
              "",
              'data: {"type":"log","message":"starting"}',
              "",
              'data: {"type":"end","message":"done"}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.run(account, {
      task: "打开设置",
      waitForCompletion: true,
      waitTimeoutMs: 15_000,
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.completed).toBe(true);
    expect(result.message).toBe("done");
    expect(result.finalEvent).toMatchObject({ type: "end", message: "done" });
    expect(result.events).toEqual([
      { type: "log", message: "starting" },
      { type: "end", message: "done" },
    ]);
    expect(calls.map((entry) => entry.url)).toEqual([
      "http://127.0.0.1:8001/api/run",
      "http://127.0.0.1:8001/api/run/stream?run_id=run-2",
    ]);
  });

  it("waits an existing run by runId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("/run/stream?run_id=run-9")) {
          return new Response(
            [": stream-start", "", 'data: {"type":"end","message":"done"}', ""].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.wait(account, {
      runId: "run-9",
    });

    expect(result).toMatchObject({
      ok: true,
      completed: true,
      status: "completed",
      runId: "run-9",
      message: "done",
    });
    expect(result.events).toEqual([{ type: "end", message: "done" }]);
  });

  it("captures the current screen as a PNG payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "http://127.0.0.1:8001/api/screen?device_id=emulator-5554") {
          return new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47]), {
            status: 200,
            headers: { "content-type": "image/png" },
          });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.screen(account);

    expect(result.ok).toBe(true);
    expect(result.screenshot).toMatchObject({
      deviceId: "emulator-5554",
      mimeType: "image/png",
      bytes: 4,
    });
    expect(result.screenshot.base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"));
  });

  it("classifies terminal model errors as failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/run")) {
          return new Response(JSON.stringify({ ok: true, run_id: "run-3" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (url.includes("/run/stream?run_id=run-3")) {
          return new Response(
            [
              ": stream-start",
              "",
              'data: {"type":"end","message":"Model error: Unknown Model"}',
              "",
            ].join("\n"),
            {
              status: 200,
              headers: { "content-type": "text/event-stream" },
            },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.run(account, {
      task: "打开设置",
      waitForCompletion: true,
      waitTimeoutMs: 15_000,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.message).toBe("Model error: Unknown Model");
  });

  it("passes run_id to the runtime stop endpoint", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        return new Response(JSON.stringify({ ok: true, stopped: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.stop(account, { runId: "run-7" });

    expect(result.stopped).toBe(true);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8001/api/run/stop");
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      run_id: "run-7",
    });
  });

  it("returns partial status when devices probing fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.endsWith("/health")) {
          return new Response(JSON.stringify({ ok: true, time: 123 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ detail: "adb not found" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const runtime = createAutoglmPhoneRuntime();
    const result = await runtime.getStatus(account);

    expect(result.ok).toBe(true);
    expect(result.runtime.apiUrl).toBe("http://127.0.0.1:8001/api");
    expect(result.health).toMatchObject({ ok: true, time: 123 });
    expect(result.devices).toBeNull();
    expect(result.devicesError).toMatch(/adb not found/i);
  });
});
