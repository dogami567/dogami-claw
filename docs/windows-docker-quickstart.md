# Clawdbot (Windows + Docker) Quickstart

## 1) Build image

From repo root:

```powershell
docker build -t clawdbot:local .
```

## 2) Create `.env`

Copy `.env.docker.example` to `.env` and fill:

- `CLAWDBOT_GATEWAY_TOKEN`
- `CLAWDBOT_OPENAI_API_KEY`
- `CLAWDBOT_OPENAI_BASE_URL` (OpenAI-compatible, usually ends with `/v1`)

## 3) Start / Restart (with self-test)

Double-click (or run in PowerShell):

```powershell
scripts\win\clawdbot-restart-gateway.bat
```

## 4) Open Control UI

Default: `http://127.0.0.1:18789/`

## 5) Change default model

```powershell
scripts\win\clawdbot-set-model.bat openai/gpt-5.2
scripts\win\clawdbot-set-model.bat openai/gpt-4o-mini
```

## 6) Quick checks

```powershell
scripts\win\clawdbot-smoke-test.bat
scripts\win\clawdbot-list-openai-models.bat
```

## Notes

- After changing `.env`, you must **recreate** the container for new env vars to take effect. `scripts\win\clawdbot-restart-gateway.bat` already does this.
- If chat “hangs/no reply”, restart the gateway and re-run the smoke test.
