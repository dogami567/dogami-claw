export type PhoneRuntimeProvider = "autoglm";

export type PhoneRuntimeConfig = {
  /** Runtime adapter used by this phone account. */
  provider?: PhoneRuntimeProvider;
  /** Direct API base URL for the phone runtime (usually ends with /api). */
  apiUrl?: string;
  /** Human-facing Web UI URL for the phone runtime. */
  uiUrl?: string;
  /** Timeout for runtime HTTP calls (ms). */
  timeoutMs?: number;
  /** Extra HTTP headers for runtime requests (gateway token, proxy auth, etc.). */
  headers?: Record<string, string>;
};

export type PhoneModelConfig = {
  /** Executor model base URL. */
  baseUrl?: string;
  /** Executor model name. */
  model?: string;
  /** Executor model API key. */
  apiKey?: string;
  /** Shared/default temperature for runtime requests. */
  temperature?: number;
  /** Monitor model base URL. */
  monitorBaseUrl?: string;
  /** Monitor model name. */
  monitorModel?: string;
  /** Monitor model API key. */
  monitorApiKey?: string;
  /** Monitor model temperature override. */
  monitorTemperature?: number;
  /** Optional monitor prompt override. */
  monitorPrompt?: string;
};

export type PhoneMode = "direct" | "monitor";

export type PhoneDefaultsConfig = {
  /** Default execution mode for this phone account. */
  mode?: PhoneMode;
  /** Default runtime language hint. */
  lang?: string;
  /** Default executor max steps. */
  maxSteps?: number;
  /** Default monitor max rounds. */
  maxRounds?: number;
  /** Default executor burst steps when mode=monitor. */
  executorMaxSteps?: number;
  /** Default screenshot usage for monitor mode. */
  monitorUseScreenshot?: boolean;
  /** Default simulation flag. */
  simulate?: boolean;
  /** Default monitor simulation flag. */
  simulateMonitor?: boolean;
  /** Default executor simulation flag. */
  simulateExecutor?: boolean;
};

export type PhoneAccountConfig = {
  enabled?: boolean;
  name?: string;
  deviceId?: string;
  deviceType?: string;
  runtime?: PhoneRuntimeConfig;
  model?: PhoneModelConfig;
  defaults?: PhoneDefaultsConfig;
};

export type PhonesConfig = {
  defaultAccountId?: string;
  accounts?: Record<string, PhoneAccountConfig>;
};
