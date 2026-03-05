@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Start the gateway container and run a quick smoke test.
rem - Uses docker-compose.yml + .env in the repo root.

set "RC=0"
set "DID_PUSHD="

call :resolve_repo_root || exit /b 1
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  set "RC=1"
  goto cleanup
)
set "DID_PUSHD=1"

if not exist ".env" (
  echo [clawdbot] ERROR: missing .env in repo root.
  set "RC=1"
  goto cleanup
)

set "COMPOSE_FILES=-f docker-compose.yml"
if exist "docker-compose.extra.yml" set "COMPOSE_FILES=%COMPOSE_FILES% -f docker-compose.extra.yml"

set "IMAGE_NAME=clawdbot:local"
for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  if /i "%%A"=="CLAWDBOT_IMAGE" set "IMAGE_NAME=%%B"
)
if not defined IMAGE_NAME set "IMAGE_NAME=clawdbot:local"

docker --version >nul 2>&1
if errorlevel 1 (
  echo [clawdbot] ERROR: docker CLI not found. Install Docker Desktop first.
  set "RC=1"
  goto cleanup
)

docker compose version >nul 2>&1
if errorlevel 1 (
  echo [clawdbot] ERROR: docker compose not available. Update Docker Desktop.
  set "RC=1"
  goto cleanup
)

docker info >nul 2>&1
if errorlevel 1 (
  echo [clawdbot] ERROR: docker engine not running. Start Docker Desktop.
  set "RC=1"
  goto cleanup
)

docker image inspect "%IMAGE_NAME%" >nul 2>&1
if errorlevel 1 (
  echo [clawdbot] Docker image missing: %IMAGE_NAME%
  echo [clawdbot] Building image; first run may take a while...
  docker build -t "%IMAGE_NAME%" -f "Dockerfile" "." >nul
  if errorlevel 1 (
    echo [clawdbot] ERROR: docker build failed.
    set "RC=1"
    goto cleanup
  )
)

call "%~dp0clawdbot-apply-openai-proxy.bat"
if errorlevel 1 (
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Starting gateway container...
docker compose %COMPOSE_FILES% up -d clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to start gateway container.
  echo [clawdbot] Tip: make sure Docker Desktop is running. docker context: desktop-linux
  set "RC=1"
  goto cleanup
)

call "%~dp0clawdbot-smoke-test.bat"
set "TEST_RC=%ERRORLEVEL%"
if not "%TEST_RC%"=="0" (
  echo [clawdbot] ERROR: gateway started but smoke test failed.
  set "RC=%TEST_RC%"
  goto cleanup
)

echo [clawdbot] Gateway started and OK.
echo [clawdbot] Logs: docker compose %COMPOSE_FILES% logs -f clawdbot-gateway

:cleanup
if defined DID_PUSHD popd >nul
call :maybe_pause %RC%
exit /b %RC%

:resolve_repo_root
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
exit /b 0

:maybe_pause
rem Keep the window open ONLY when double-clicked in Explorer.
rem - No pause when running from PowerShell, or when called by another .bat.
if defined CLAWDBOT_NO_PAUSE exit /b 0
set "SHOULD_PAUSE="
if defined CLAWDBOT_PAUSE set "SHOULD_PAUSE=1"
if not defined SHOULD_PAUSE (
  set "GP_NAME="
  for /f "usebackq delims=" %%G in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $pp=(Get-CimInstance Win32_Process -Filter \"ProcessId=$PID\").ParentProcessId; $gp=(Get-CimInstance Win32_Process -Filter \"ProcessId=$pp\").ParentProcessId; try { (Get-Process -Id $gp).Name } catch { '' }"`) do set "GP_NAME=%%G"
  echo(!CMDCMDLINE! | find /I "/c" >nul && echo(!CMDCMDLINE! | find /I "%~f0" >nul && if /I "!GP_NAME!"=="explorer" set "SHOULD_PAUSE=1"
)
if defined SHOULD_PAUSE (
  echo.
  pause
)
exit /b 0
