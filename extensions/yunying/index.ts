import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";

import { createYunyingSupervisorService } from "./src/supervisor.js";
import { createYunyingTool } from "./src/tool.js";

export default function register(api: ClawdbotPluginApi) {
  api.registerTool(createYunyingTool(api));
  api.registerService(createYunyingSupervisorService(api));
}
