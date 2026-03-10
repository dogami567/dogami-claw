import { createAutoglmPhoneRuntime } from "./providers/autoglm.js";
import { PhoneError } from "./types.js";
import type {
  PhoneCheckResult,
  PhoneRuntimeDiscoverResult,
  PhoneResolvedAccount,
  PhoneScreenRequest,
  PhoneScreenResult,
  PhoneRunRequest,
  PhoneRunResult,
  PhoneWaitRequest,
  PhoneStatusResult,
  PhoneStopRequest,
  PhoneStopResult,
} from "./types.js";

export type PhoneRuntimeAdapter = {
  discover: (account: PhoneResolvedAccount) => Promise<PhoneRuntimeDiscoverResult>;
  getStatus: (account: PhoneResolvedAccount) => Promise<PhoneStatusResult>;
  checkConnectivity: (account: PhoneResolvedAccount) => Promise<PhoneCheckResult>;
  screen: (
    account: PhoneResolvedAccount,
    request?: PhoneScreenRequest,
  ) => Promise<PhoneScreenResult>;
  run: (account: PhoneResolvedAccount, request: PhoneRunRequest) => Promise<PhoneRunResult>;
  wait: (account: PhoneResolvedAccount, request: PhoneWaitRequest) => Promise<PhoneRunResult>;
  stop: (account: PhoneResolvedAccount, request?: PhoneStopRequest) => Promise<PhoneStopResult>;
};

export function getPhoneRuntime(account: PhoneResolvedAccount): PhoneRuntimeAdapter {
  switch (account.runtime.provider) {
    case "autoglm":
      return createAutoglmPhoneRuntime();
    default:
      throw new PhoneError(
        "invalid_request",
        `unsupported phone runtime provider: ${account.runtime.provider}`,
      );
  }
}
