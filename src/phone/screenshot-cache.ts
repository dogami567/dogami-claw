import type { PhoneScreenResult } from "./types.js";

type PhoneScreenshotCacheEntry = {
  key: string;
  capturedAtMs: number;
  result: PhoneScreenResult;
};

const PHONE_SCREEN_CACHE_TTL_MS = 2_000;
const PHONE_SCREEN_CACHE_MAX_ENTRIES = 24;

const phoneScreenCache = new Map<string, PhoneScreenshotCacheEntry>();

function normalizeKeyPart(value?: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : "_";
}

function buildCacheKey(accountId: string, deviceId?: string): string {
  return `${normalizeKeyPart(accountId)}::${normalizeKeyPart(deviceId)}`;
}

function cleanupPhoneScreenCache(now = Date.now()) {
  // Keep the cache intentionally short-lived so we only dedupe immediate follow-up
  // screen reads after a completed action instead of serving stale UI for long.
  for (const [key, entry] of phoneScreenCache.entries()) {
    if (now - entry.capturedAtMs > PHONE_SCREEN_CACHE_TTL_MS) {
      phoneScreenCache.delete(key);
    }
  }

  while (phoneScreenCache.size > PHONE_SCREEN_CACHE_MAX_ENTRIES) {
    let oldestKey: string | undefined;
    let oldestCapturedAtMs = Number.POSITIVE_INFINITY;

    for (const [key, entry] of phoneScreenCache.entries()) {
      if (entry.capturedAtMs < oldestCapturedAtMs) {
        oldestCapturedAtMs = entry.capturedAtMs;
        oldestKey = key;
      }
    }

    if (!oldestKey) break;
    phoneScreenCache.delete(oldestKey);
  }
}

export function getCachedPhoneScreen(params: {
  accountId: string;
  deviceId?: string;
}): PhoneScreenResult | undefined {
  const now = Date.now();
  cleanupPhoneScreenCache(now);

  const entry = phoneScreenCache.get(buildCacheKey(params.accountId, params.deviceId));
  if (!entry) return undefined;

  if (now - entry.capturedAtMs > PHONE_SCREEN_CACHE_TTL_MS) {
    phoneScreenCache.delete(entry.key);
    return undefined;
  }

  return entry.result;
}

export function setCachedPhoneScreen(result: PhoneScreenResult): PhoneScreenResult {
  cleanupPhoneScreenCache();

  const key = buildCacheKey(
    result.account.id,
    result.screenshot.deviceId ?? result.account.deviceId,
  );
  phoneScreenCache.set(key, {
    key,
    capturedAtMs: Date.now(),
    result,
  });
  cleanupPhoneScreenCache();
  return result;
}

export function clearCachedPhoneScreen(params: { accountId: string; deviceId?: string }) {
  cleanupPhoneScreenCache();

  if (params.deviceId?.trim()) {
    phoneScreenCache.delete(buildCacheKey(params.accountId, params.deviceId));
    return;
  }

  const prefix = `${normalizeKeyPart(params.accountId)}::`;
  for (const key of phoneScreenCache.keys()) {
    if (key.startsWith(prefix)) {
      phoneScreenCache.delete(key);
    }
  }
}

export function clearAllCachedPhoneScreens() {
  phoneScreenCache.clear();
}
