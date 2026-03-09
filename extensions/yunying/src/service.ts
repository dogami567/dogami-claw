import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import {
  createYunyingControlPlane,
  YUNYING_ACTIONS,
} from "./control-plane.js";

export { YUNYING_ACTIONS };

export function createYunyingService(api: ClawdbotPluginApi) {
  return createYunyingControlPlane(api);
}
