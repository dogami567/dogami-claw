import type { ClawdbotConfig } from "../config/config.js";
import type { PhoneAccountSummary, PhoneResolvedAccount, PhoneRuntimeSummary } from "./types.js";
import { PhoneError } from "./types.js";

const DEFAULT_PHONE_PROVIDER = "autoglm";
const DEFAULT_PHONE_DEVICE_TYPE = "adb";
const DEFAULT_PHONE_MODE = "direct";
const DEFAULT_PHONE_TIMEOUT_MS = 30_000;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function listPhoneAccounts(config: ClawdbotConfig): PhoneResolvedAccount[] {
  const entries = Object.entries(config.phones?.accounts ?? {});
  return entries.map(([id, raw]) => ({
    id,
    name: normalizeOptionalString(raw.name) ?? id,
    enabled: raw.enabled !== false,
    deviceId: normalizeOptionalString(raw.deviceId),
    deviceType: normalizeOptionalString(raw.deviceType) ?? DEFAULT_PHONE_DEVICE_TYPE,
    runtime: {
      provider: raw.runtime?.provider ?? DEFAULT_PHONE_PROVIDER,
      apiUrl: normalizeOptionalString(raw.runtime?.apiUrl),
      uiUrl: normalizeOptionalString(raw.runtime?.uiUrl),
      timeoutMs: raw.runtime?.timeoutMs ?? DEFAULT_PHONE_TIMEOUT_MS,
      headers: raw.runtime?.headers ? { ...raw.runtime.headers } : undefined,
    },
    model: {
      baseUrl: normalizeOptionalString(raw.model?.baseUrl),
      model: normalizeOptionalString(raw.model?.model),
      apiKey: normalizeOptionalString(raw.model?.apiKey),
      temperature: raw.model?.temperature,
      monitorBaseUrl: normalizeOptionalString(raw.model?.monitorBaseUrl),
      monitorModel: normalizeOptionalString(raw.model?.monitorModel),
      monitorApiKey: normalizeOptionalString(raw.model?.monitorApiKey),
      monitorTemperature: raw.model?.monitorTemperature,
      monitorPrompt: normalizeOptionalString(raw.model?.monitorPrompt),
    },
    defaults: {
      ...raw.defaults,
      lang: normalizeOptionalString(raw.defaults?.lang),
      mode: raw.defaults?.mode ?? DEFAULT_PHONE_MODE,
    },
    raw,
  }));
}

export function resolveDefaultPhoneAccountId(config: ClawdbotConfig): string | undefined {
  const accounts = listPhoneAccounts(config);
  if (accounts.length === 0) return undefined;
  const configured = normalizeOptionalString(config.phones?.defaultAccountId);
  if (configured) return configured;
  return accounts.find((account) => account.enabled)?.id ?? accounts[0]?.id;
}

export function resolvePhoneAccount(
  config: ClawdbotConfig,
  accountId?: string | null,
): PhoneResolvedAccount {
  const accounts = listPhoneAccounts(config);
  if (accounts.length === 0) {
    throw new PhoneError("invalid_request", "no phone accounts configured");
  }

  const resolvedId = normalizeOptionalString(accountId) ?? resolveDefaultPhoneAccountId(config);
  if (!resolvedId) {
    throw new PhoneError("invalid_request", "no phone account could be resolved");
  }

  const account = accounts.find((entry) => entry.id === resolvedId);
  if (!account) {
    throw new PhoneError("invalid_request", `unknown phone account: ${resolvedId}`);
  }
  return account;
}

export function toPhoneAccountSummary(account: PhoneResolvedAccount): PhoneAccountSummary {
  return {
    id: account.id,
    name: account.name,
    enabled: account.enabled,
    deviceId: account.deviceId,
    deviceType: account.deviceType,
    provider: account.runtime.provider,
    apiUrl: account.runtime.apiUrl,
    uiUrl: account.runtime.uiUrl,
  };
}

export function toPhoneRuntimeSummary(
  account: PhoneResolvedAccount,
  apiUrl?: string,
): PhoneRuntimeSummary {
  return {
    provider: account.runtime.provider,
    apiUrl: apiUrl ?? account.runtime.apiUrl,
    uiUrl: account.runtime.uiUrl,
    timeoutMs: account.runtime.timeoutMs,
  };
}
