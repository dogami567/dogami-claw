---
summary: "QQ integration via OneBot bridges (NapCat, etc.)"
read_when:
  - You want to connect Clawdbot to QQ via NapCat or another OneBot bridge
---
# OneBot (plugin)

This channel connects Clawdbot to **OneBot 11** compatible bridges. It is commonly used to
integrate with QQ via third party bridges such as **NapCat**.

Important: OneBot bridges are typically not official platform APIs. Make sure your deployment
complies with the platform terms and any applicable laws.

## Plugin required

OneBot ships as a plugin and is not bundled with the core install.

Install via CLI (npm registry):

```bash
clawdbot plugins install @clawdbot/onebot
```

Local checkout (when running from a git repo):

```bash
clawdbot plugins install ./extensions/onebot
```

Details: [Plugins](/plugin)

## Setup

1) Run a OneBot compatible bridge and note its endpoints:
   - WebSocket URL for inbound events (example: `ws://127.0.0.1:3001`)
   - HTTP URL for outbound API calls (example: `http://127.0.0.1:3000`)
   - Optional access token
2) Configure `channels.onebot` in your Clawdbot config.
3) Restart the gateway.

Minimal config:

```json5
{
  channels: {
    onebot: {
      enabled: true,
      wsUrl: "ws://127.0.0.1:3001",
      httpUrl: "http://127.0.0.1:3000",
      accessToken: "REPLACE_ME",
      dmPolicy: "pairing",
      allowFrom: ["123456789"],
      groupPolicy: "allowlist",
      groupAllowFrom: ["123456789"],
      groups: {
        "*": { requireMention: true }
      }
    }
  }
}
```

## Targets

Outbound targets use a prefix:

- `user:<qq>` for direct messages
- `group:<group>` for group messages

Examples:

- `clawdbot message send --channel onebot --target user:123456789 --message "hi"`
- `clawdbot message send --channel onebot --target group:987654321 --message "hi"`
