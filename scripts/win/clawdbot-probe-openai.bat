@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Probe a provider inside the gateway container and print JSON.
rem Default provider: openai
rem
rem Usage:
rem   scripts\win\clawdbot-probe-openai.bat
rem   scripts\win\clawdbot-probe-openai.bat gmn

set "RC=0"
set "DID_PUSHD="

set "PROVIDER=%~1"
if not defined PROVIDER set "PROVIDER=openai"

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

if /i "%PROVIDER%"=="openai" (
  set "BASE_URL="
  for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
    if /i "%%A"=="CLAWDBOT_OPENAI_BASE_URL" set "BASE_URL=%%B"
  )
  if defined BASE_URL echo [clawdbot] OPENAI_BASE_URL: %BASE_URL%
)

echo [clawdbot] Ensuring gateway container is running...
docker compose %COMPOSE_FILES% up -d clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to start gateway container.
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Probing provider: %PROVIDER%
docker compose %COMPOSE_FILES% exec -T clawdbot-gateway node dist/index.js models status --probe --probe-provider %PROVIDER% --json
set "RC=%ERRORLEVEL%"

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
