import type {
  PhoneAccountConfig,
  PhoneDefaultsConfig,
  PhoneModelConfig,
  PhoneRuntimeProvider,
} from "../config/types.phones.js";

export type PhoneMode = "direct" | "monitor";
export type PhoneErrorKind = "invalid_request" | "unavailable";

export class PhoneError extends Error {
  kind: PhoneErrorKind;

  constructor(kind: PhoneErrorKind, message: string) {
    super(message);
    this.name = "PhoneError";
    this.kind = kind;
  }
}

export type PhoneResolvedRuntime = {
  provider: PhoneRuntimeProvider;
  apiUrl?: string;
  uiUrl?: string;
  timeoutMs: number;
  headers?: Record<string, string>;
};

export type PhoneResolvedDefaults = PhoneDefaultsConfig & {
  mode: PhoneMode;
};

export type PhoneResolvedAccount = {
  id: string;
  name: string;
  enabled: boolean;
  deviceId?: string;
  deviceType: string;
  runtime: PhoneResolvedRuntime;
  model: PhoneModelConfig;
  defaults: PhoneResolvedDefaults;
  raw: PhoneAccountConfig;
};

export type PhoneAccountSummary = {
  id: string;
  name: string;
  enabled: boolean;
  deviceId?: string;
  deviceType: string;
  provider: PhoneRuntimeProvider;
  apiUrl?: string;
  uiUrl?: string;
};

export type PhoneRuntimeSummary = {
  provider: PhoneRuntimeProvider;
  apiUrl?: string;
  uiUrl?: string;
  timeoutMs: number;
};

export type PhoneListResult = {
  defaultAccountId?: string;
  accounts: PhoneAccountSummary[];
};

export type PhoneRuntimeDiscoveredDevice = {
  deviceId: string;
  deviceType?: string;
  state?: string;
  label?: string;
  raw: Record<string, unknown>;
};

export type PhoneRuntimeDiscoverResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  count: number;
  deviceType?: string;
  devices: PhoneRuntimeDiscoveredDevice[];
  raw: Record<string, unknown>;
};

export type PhoneDiscoveredDevice = PhoneRuntimeDiscoveredDevice & {
  configuredAccountId?: string;
  suggestedAccountId: string;
  suggestedName: string;
  autoPickEligible: boolean;
};

export type PhoneDiscoverResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  count: number;
  deviceType?: string;
  devices: PhoneDiscoveredDevice[];
  raw: Record<string, unknown>;
};

export type PhoneStatusResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  ok: boolean;
  health: Record<string, unknown> | null;
  devices: Record<string, unknown> | null;
  healthError?: string;
  devicesError?: string;
};

export type PhoneCheckResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  check: Record<string, unknown>;
};

export type PhoneScreenCapture = {
  deviceId?: string;
  mimeType: string;
  base64: string;
  bytes: number;
};

export type PhoneScreenRequest = {
  accountId?: string;
  deviceId?: string;
  deviceType?: string;
};

export type PhoneScreenResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  ok: boolean;
  screenshot: PhoneScreenCapture;
};

export type PhoneRuntimeEvent = Record<string, unknown> & {
  type: string;
};

export type PhoneRunRequest = {
  accountId?: string;
  mode?: PhoneMode;
  task?: string;
  goal?: string;
  waitForCompletion?: boolean;
  waitTimeoutMs?: number;
  payload?: Record<string, unknown>;
  deviceId?: string;
  deviceType?: string;
  lang?: string;
  maxSteps?: number;
  maxRounds?: number;
  executorMaxSteps?: number;
  simulate?: boolean;
  dryRun?: boolean;
  temperature?: number;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  monitorBaseUrl?: string;
  monitorModel?: string;
  monitorApiKey?: string;
  monitorUseScreenshot?: boolean;
  monitorTemperature?: number;
  monitorPrompt?: string;
  includeScreenshot?: boolean;
};

export type PhoneRunResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  ok: boolean;
  status: "accepted" | "completed" | "failed" | "stopped";
  runId?: string;
  message?: string;
  completed: boolean;
  finalEvent?: Record<string, unknown>;
  events?: PhoneRuntimeEvent[];
  screenshot?: PhoneScreenCapture;
  screenshotError?: string;
  raw: Record<string, unknown>;
};

export type PhoneWaitRequest = {
  accountId?: string;
  runId: string;
  waitTimeoutMs?: number;
  deviceId?: string;
  deviceType?: string;
  includeScreenshot?: boolean;
};

export type PhoneStopRequest = {
  accountId?: string;
  runId?: string;
};

export type PhoneStopResult = {
  account: PhoneAccountSummary;
  runtime: PhoneRuntimeSummary;
  ok: boolean;
  stopped: boolean;
  message?: string;
  raw: Record<string, unknown>;
};
