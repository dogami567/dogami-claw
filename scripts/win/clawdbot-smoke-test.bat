@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Smoke test: call the Gateway's OpenAI-compatible endpoint and validate JSON.

call :resolve_repo_root || exit /b 1
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  exit /b 1
)

if not exist ".env" (
  echo [clawdbot] ERROR: missing .env in repo root.
  popd >nul
  exit /b 1
)

set "GATEWAY_TOKEN="
set "GATEWAY_PORT=18789"

for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  if /i "%%A"=="CLAWDBOT_GATEWAY_TOKEN" set "GATEWAY_TOKEN=%%B"
  if /i "%%A"=="CLAWDBOT_GATEWAY_PORT" set "GATEWAY_PORT=%%B"
)

if not defined GATEWAY_TOKEN (
  echo [clawdbot] ERROR: CLAWDBOT_GATEWAY_TOKEN is missing in .env
  popd >nul
  exit /b 1
)

set "URL=http://127.0.0.1:%GATEWAY_PORT%/v1/chat/completions"
set "OUT=%TEMP%\clawdbot-smoke-%RANDOM%.json"
set "CODE_FILE=%OUT%.code"
set "BODY={\"model\":\"clawdbot\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}]}"

echo [clawdbot] Waiting for gateway to be ready...
set "READY_URL=http://127.0.0.1:%GATEWAY_PORT%/"
set /a READY_TRIES=0
:wait_ready
set /a READY_TRIES+=1
set "READY_CODE="
curl -sS -m 3 -o NUL -w "%%{http_code}" "%READY_URL%" > "%CODE_FILE%" 2>nul
if not errorlevel 1 (
  set /p READY_CODE=<"%CODE_FILE%"
)
del "%CODE_FILE%" >nul 2>&1
if "%READY_CODE%"=="200" goto ready
if %READY_TRIES% GEQ 20 (
  echo [clawdbot] ERROR: gateway not ready after %READY_TRIES% tries.
  popd >nul
  exit /b 1
)
ping -n 3 127.0.0.1 >nul
goto wait_ready
:ready

echo [clawdbot] Smoke test: %URL%

curl -sS -m 180 ^
  -o "%OUT%" ^
  -w "%%{http_code}" ^
  -H "Authorization: Bearer %GATEWAY_TOKEN%" ^
  -H "Content-Type: application/json" ^
  -H "x-clawdbot-agent-id: main" ^
  --data-raw "%BODY%" ^
  "%URL%" > "%CODE_FILE%"

if errorlevel 1 (
  echo [clawdbot] ERROR: request failed.
  echo [clawdbot] Response saved at: %OUT%
  popd >nul
  exit /b 1
)

set /p HTTP_CODE=<"%CODE_FILE%"
del "%CODE_FILE%" >nul 2>&1

if not "%HTTP_CODE%"=="200" (
  echo [clawdbot] ERROR: HTTP %HTTP_CODE%
  echo [clawdbot] Response saved at: %OUT%
  popd >nul
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$j = Get-Content -Raw '%OUT%' | ConvertFrom-Json;" ^
  "$content = $j.choices[0].message.content;" ^
  "if (-not $content) { throw 'Missing choices[0].message.content' }" ^
  "Write-Host ('[clawdbot] OK: ' + $content.Trim())"

if errorlevel 1 (
  echo [clawdbot] ERROR: response JSON invalid.
  echo [clawdbot] Response saved at: %OUT%
  popd >nul
  exit /b 1
)

del "%OUT%" >nul 2>&1
popd >nul
exit /b 0

:resolve_repo_root
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
exit /b 0
