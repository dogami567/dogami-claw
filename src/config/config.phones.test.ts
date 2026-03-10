import { describe, expect, it, vi } from "vitest";

describe("phones config", () => {
  it("accepts phone account config", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      phones: {
        defaultAccountId: "work",
        accounts: {
          work: {
            name: "Work Phone",
            deviceId: "emulator-5554",
            runtime: {
              provider: "autoglm",
              apiUrl: "http://127.0.0.1:8001/api",
            },
            model: {
              baseUrl: "http://127.0.0.1:8000/v1",
              model: "autoglm-phone",
            },
            defaults: {
              mode: "monitor",
              maxSteps: 12,
              maxRounds: 6,
            },
          },
        },
      },
    });

    expect(res.ok).toBe(true);
  });

  it("rejects unknown default phone account ids", async () => {
    vi.resetModules();
    const { validateConfigObject } = await import("./config.js");
    const res = validateConfigObject({
      phones: {
        defaultAccountId: "missing",
        accounts: {
          work: {
            runtime: {
              apiUrl: "http://127.0.0.1:8001/api",
            },
          },
        },
      },
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.issues[0]?.path).toBe("phones.defaultAccountId");
    }
  });
});
