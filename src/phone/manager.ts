import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import { listPhoneAccounts, resolveDefaultPhoneAccountId, resolvePhoneAccount } from "./config.js";
import {
  getTrackedPhoneRun,
  getTrackedPhoneRunRecord,
  listTrackedPhoneRunRecords,
  listTrackedPhoneRuns,
  registerTrackedPhoneRun,
  resolveLatestActiveTrackedPhoneRun,
  resetTrackedPhoneRunsForTests,
  updateTrackedPhoneRun,
} from "./run-registry.js";
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
  PhoneRunsResult,
  PhoneScreenRequest,
  PhoneScreenResult,
  PhoneRunRequest,
  PhoneRunResult,
  PhoneWaitRequest,
  PhoneStatusResult,
  PhoneStopRequest,
  PhoneStopResult,
} from "./types.js";

const trackedPhoneWaiters = new Set<string>();
let trackedPhoneRunsResumed = false;
const PHONE_BACKGROUND_WAIT_SLICE_MS = 120_000;

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

function isPhoneRunWaitTimeout(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /phone runtime wait timed out after/i.test(message);
}

function resolveTrackedPhoneWaitSliceMs(waitTimeoutMs?: number) {
  if (typeof waitTimeoutMs !== "number" || !Number.isFinite(waitTimeoutMs) || waitTimeoutMs <= 0) {
    return PHONE_BACKGROUND_WAIT_SLICE_MS;
  }
  return Math.min(Math.max(Math.floor(waitTimeoutMs), 60_000), PHONE_BACKGROUND_WAIT_SLICE_MS);
}

export class PhoneManager {
  readonly #config: ClawdbotConfig;

  constructor(config: ClawdbotConfig) {
    this.#config = config;
    this.#resumeTrackedPhoneRuns();
  }

  #resumeTrackedPhoneRuns() {
    if (trackedPhoneRunsResumed) return;
    trackedPhoneRunsResumed = true;
    for (const entry of listTrackedPhoneRunRecords({ includeCompleted: false })) {
      void this.#trackRunCompletion(entry.runId);
    }
  }

  async #trackRunCompletion(runId: string) {
    if (trackedPhoneWaiters.has(runId)) return;
    trackedPhoneWaiters.add(runId);
    try {
      while (true) {
        const entry = getTrackedPhoneRunRecord(runId);
        if (!entry || entry.completed) return;

        let account;
        try {
          account = resolvePhoneAccount(this.#config, entry.accountId);
        } catch (error) {
          updateTrackedPhoneRun(runId, {
            status: "failed",
            completed: true,
            message: error instanceof Error ? error.message : String(error),
            endedAt: Date.now(),
          });
          return;
        }

        try {
          const result = await getPhoneRuntime(account).wait(account, {
            accountId: account.id,
            runId,
            waitTimeoutMs: resolveTrackedPhoneWaitSliceMs(entry.waitTimeoutMs),
            deviceId: entry.deviceId,
            deviceType: entry.deviceType,
            includeScreenshot: false,
          });
          updateTrackedPhoneRun(runId, {
            status: result.status,
            completed: result.completed,
            message: result.message,
            endedAt: result.completed ? Date.now() : undefined,
          });
          clearCachedPhoneScreen({
            accountId: account.id,
            deviceId: entry.deviceId?.trim() || account.deviceId,
          });
          return;
        } catch (error) {
          if (isPhoneRunWaitTimeout(error)) {
            updateTrackedPhoneRun(runId, {});
            continue;
          }
          updateTrackedPhoneRun(runId, {
            status: "failed",
            completed: true,
            message: error instanceof Error ? error.message : String(error),
            endedAt: Date.now(),
          });
          clearCachedPhoneScreen({
            accountId: account.id,
            deviceId: entry.deviceId?.trim() || account.deviceId,
          });
          return;
        }
      }
    } finally {
      trackedPhoneWaiters.delete(runId);
    }
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
    const result = await getPhoneRuntime(account).getStatus(account);
    return {
      ...result,
      trackedRuns: listTrackedPhoneRuns({
        accountId: account.id,
        includeCompleted: true,
        limit: 5,
      }),
    };
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
    if (result.runId) {
      registerTrackedPhoneRun({
        runId: result.runId,
        accountId: account.id,
        status: result.status,
        completed: result.completed,
        mode: request.mode ?? account.defaults.mode,
        task: request.task,
        goal: request.goal,
        deviceId: request.deviceId?.trim() || account.deviceId,
        deviceType: request.deviceType?.trim() || account.deviceType,
        message: result.message,
        startedAt: Date.now(),
        endedAt: result.completed ? Date.now() : undefined,
        waitTimeoutMs: request.waitTimeoutMs,
      });
      if (!result.completed) {
        void this.#trackRunCompletion(result.runId);
      }
    }
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
    if (result.runId) {
      registerTrackedPhoneRun({
        runId: result.runId,
        accountId: account.id,
        status: result.status,
        completed: result.completed,
        deviceId: request.deviceId?.trim() || account.deviceId,
        deviceType: request.deviceType?.trim() || account.deviceType,
        message: result.message,
        endedAt: result.completed ? Date.now() : undefined,
        waitTimeoutMs: request.waitTimeoutMs,
      });
    }
    return await this.#attachCompletionScreen(account.id, result, {
      includeScreenshot: request.includeScreenshot,
      deviceId: request.deviceId,
      deviceType: request.deviceType,
    });
  }

  async stop(request?: PhoneStopRequest): Promise<PhoneStopResult> {
    const account = resolvePhoneAccount(this.#config, request?.accountId);
    const tracked = request?.runId ? getTrackedPhoneRunRecord(request.runId) : undefined;
    const fallback = tracked ?? resolveLatestActiveTrackedPhoneRun(account.id);
    const runId = request?.runId?.trim() || fallback?.runId;
    const result = await getPhoneRuntime(account).stop(account, {
      ...request,
      runId,
    });
    if (runId && result.stopped) {
      updateTrackedPhoneRun(runId, {
        status: "stopped",
        completed: true,
        message: result.message,
        endedAt: Date.now(),
      });
      clearCachedPhoneScreen({
        accountId: account.id,
        deviceId: fallback?.deviceId?.trim() || account.deviceId,
      });
    }
    return {
      ...result,
      runId,
    };
  }

  runs(accountId?: string): PhoneRunsResult {
    const normalizedAccountId = accountId?.trim() || undefined;
    if (normalizedAccountId) {
      resolvePhoneAccount(this.#config, normalizedAccountId);
    }
    const runs = listTrackedPhoneRuns({
      accountId: normalizedAccountId,
      includeCompleted: true,
      limit: 20,
    });
    return {
      accountId: normalizedAccountId,
      activeCount: runs.filter((entry) => !entry.completed).length,
      runs,
    };
  }

  getRun(runId: string) {
    return getTrackedPhoneRun(runId);
  }
}

export function createPhoneManager(config = loadConfig()): PhoneManager {
  return new PhoneManager(config);
}

export function resetPhoneManagerForTests() {
  trackedPhoneWaiters.clear();
  trackedPhoneRunsResumed = false;
  resetTrackedPhoneRunsForTests();
}
