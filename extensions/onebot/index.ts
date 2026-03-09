import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { createOneBotAiKpTools } from "./src/ai-kp-tool.js";
import { ONEBOT_AIKP_TOOL_NAMES } from "./src/ai-kp-shared.js";
import { onebotPlugin } from "./src/channel.js";
import { setOneBotRuntime } from "./src/runtime.js";

const plugin = {
  id: "onebot",
  name: "OneBot",
  description: "OneBot channel plugin (QQ via NapCat and other OneBot bridges)",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    setOneBotRuntime(api.runtime);
    api.registerChannel({ plugin: onebotPlugin });
    api.registerTool((ctx) => createOneBotAiKpTools(api, ctx), {
      names: Object.values(ONEBOT_AIKP_TOOL_NAMES),
    });
  },
};

export default plugin;
