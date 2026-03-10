import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { listPhoneAccounts, resolveDefaultPhoneAccountId, resolvePhoneAccount } from "./config.js";
import { getPhoneRuntime } from "./runtime.js";
import { normalizePhoneScreenshot } from "./screenshot-normalize.js";
import {
  clearCachedPhoneScreen,
  getCachedPhoneScreen,
  setCachedPhoneScreen,
} from "./screenshot-cache.js";
import { PhoneError } from "./types.js";
import type {
  PhoneCheckResult,
  PhoneDiscoverResult,
  PhoneListResult,
  PhoneScreenRequest,
  PhoneScreenResult,
  PhoneRunRequest,
  PhoneRunResult,
  PhoneWaitRequest,
  PhoneStatusResult,
  PhoneStopRequest,
  PhoneStopResult,
} from "./types.js";

function slugifyDeviceId(deviceId: string): string {
  return (
    deviceId
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 24) || "device"
  );
}

function buildSuggestedAccountId(deviceId: string, usedIds: Set<string>): string {
  const base = `phone-${slugifyDeviceId(deviceId)}`;
  let candidate = base;
  let index = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}-${index}`;
    index += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function buildSuggestedName(deviceId: string): string {
  return `Phone ${deviceId.trim().slice(0, 8) || "device"}`;
}

export class PhoneManager {
  readonly #config: ClawdbotConfig;

  constructor(config: ClawdbotConfig) {
    this.#config = config;
  }

  list(): PhoneListResult {
    const accounts = listPhoneAccounts(this.#config);
    return {
      defaultAccountId: resolveDefaultPhoneAccountId(this.#config),
      accounts: accounts.map((account) => ({
        id: account.id,
        name: account.name,
        enabled: account.enabled,
        deviceId: account.deviceId,
        deviceType: account.deviceType,
        provider: account.runtime.provider,
        apiUrl: account.runtime.apiUrl,
        uiUrl: account.runtime.uiUrl,
      })),
    };
  }

  async discover(accountId?: string): Promise<PhoneDiscoverResult> {
    const account = resolvePhoneAccount(this.#config, accountId);
    const discovered = await getPhoneRuntime(account).discover(account);
    const accounts = listPhoneAccounts(this.#config);
    const usedAccountIds = new Set(accounts.map((entry) => entry.id));

    return {
      ...discovered,
      devices: discovered.devices.map((device) => {
        const configured = accounts.find(
          (entry) => entry.deviceId?.trim() && entry.deviceId === device.deviceId,
        );
        return {
          ...device,
          configuredAccountId: configured?.id,
          suggestedAccountId:
            configured?.id ?? buildSuggestedAccountId(device.deviceId, usedAccountIds),
          suggestedName: configured?.name ?? buildSuggestedName(device.deviceId),
          autoPickEligible: (device.state ?? "device") === "device" && !configured,
        };
      }),
    };
  }

  async status(accountId?: string): Promise<PhoneStatusResult> {
    const account = resolvePhoneAccount(this.#config, accountId);
    return getPhoneRuntime(account).getStatus(account);
  }

  async check(accountId?: string): Promise<PhoneCheckResult> {
    const account = resolvePhoneAccount(this.#config, accountId);
    return getPhoneRuntime(account).checkConnectivity(account);
  }

  async screen(request?: PhoneScreenRequest): Promise<PhoneScreenResult> {
    const account = resolvePhoneAccount(this.#config, request?.accountId);
    const deviceId = request?.deviceId?.trim() || account.deviceId;
    const cached = getCachedPhoneScreen({ accountId: account.id, deviceId });
    if (cached) return cached;

    return setCachedPhoneScreen(
      await this.#optimizeScreenResult(await getPhoneRuntime(account).screen(account, request)),
    );
  }

  async #optimizeScreenResult(result: PhoneScreenResult): Promise<PhoneScreenResult> {
    const screenshot = result.screenshot;
    const raw = Buffer.from(screenshot.base64, "base64");
    if (raw.byteLength === 0) return result;
    const normalized = await normalizePhoneScreenshot(raw);
    const nextBuffer = normalized.buffer;
    const nextMimeType = normalized.contentType ?? screenshot.mimeType;
    if (nextBuffer.equals(raw) && nextMimeType === screenshot.mimeType) {
      return result;
    }
    return {
      ...result,
      screenshot: {
        ...screenshot,
        mimeType: nextMimeType,
        base64: nextBuffer.toString("base64"),
        bytes: nextBuffer.byteLength,
      },
    };
  }

  async #attachCompletionScreen(
    accountId: string,
    runtimeResult: PhoneRunResult,
    request?: {
      includeScreenshot?: boolean;
      deviceId?: string;
      deviceType?: string;
    },
  ): Promise<PhoneRunResult> {
    if (request?.includeScreenshot !== true) return runtimeResult;

    const account = resolvePhoneAccount(this.#config, accountId);
    try {
      const screen = setCachedPhoneScreen(
        await this.#optimizeScreenResult(
          await getPhoneRuntime(account).screen(account, {
            accountId: account.id,
            deviceId: request.deviceId,
            deviceType: request.deviceType,
          }),
        ),
      );
      return {
        ...runtimeResult,
        screenshot: screen.screenshot,
      };
    } catch (error) {
      return {
        ...runtimeResult,
        screenshotError: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async run(request: PhoneRunRequest): Promise<PhoneRunResult> {
    const account = resolvePhoneAccount(this.#config, request.accountId);
    if (!account.enabled) {
      throw new PhoneError("invalid_request", `phone account "${account.id}" is disabled`);
    }

    clearCachedPhoneScreen({
      accountId: account.id,
      deviceId: request.deviceId?.trim() || account.deviceId,
    });

    const runtime = getPhoneRuntime(account);
    const result = await runtime.run(account, request);
    return await this.#attachCompletionScreen(account.id, result, {
      includeScreenshot: request.includeScreenshot,
      deviceId: request.deviceId,
      deviceType: request.deviceType,
    });
  }

  async wait(request: PhoneWaitRequest): Promise<PhoneRunResult> {
    const account = resolvePhoneAccount(this.#config, request.accountId);
    if (!account.enabled) {
      throw new PhoneError("invalid_request", `phone account "${account.id}" is disabled`);
    }
    const result = await getPhoneRuntime(account).wait(account, request);
    return await this.#attachCompletionScreen(account.id, result, {
      includeScreenshot: request.includeScreenshot,
      deviceId: request.deviceId,
      deviceType: request.deviceType,
    });
  }

  async stop(request?: PhoneStopRequest): Promise<PhoneStopResult> {
    const account = resolvePhoneAccount(this.#config, request?.accountId);
    return getPhoneRuntime(account).stop(account, request);
  }
}

export function createPhoneManager(config = loadConfig()): PhoneManager {
  return new PhoneManager(config);
}
