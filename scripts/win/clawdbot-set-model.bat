@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Usage:
rem   scripts\win\clawdbot-set-model.bat openai/gpt-4o-mini
rem   scripts\win\clawdbot-set-model.bat openai/gpt-5.2

set "RC=0"
set "DID_PUSHD="

call :resolve_repo_root || exit /b 1
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  set "RC=1"
  goto cleanup
)
set "DID_PUSHD=1"

set "MODEL=%~1"
if "%MODEL%"=="" (
  echo Usage: %~nx0 ^<model^>
  echo Example: %~nx0 openai/gpt-4o-mini
  set "RC=2"
  goto cleanup
)

call "%~dp0clawdbot-apply-openai-proxy.bat"
if errorlevel 1 (
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Ensuring gateway container is running...
docker compose up -d clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to start gateway container.
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Setting default model to: %MODEL%
docker compose exec -T clawdbot-gateway node dist/index.js models set "%MODEL%"
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to set model.
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Restarting gateway...
docker compose restart clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to restart gateway.
  set "RC=1"
  goto cleanup
)

call "%~dp0clawdbot-smoke-test.bat"
set "TEST_RC=%ERRORLEVEL%"
if not "%TEST_RC%"=="0" (
  echo [clawdbot] ERROR: smoke test failed after restart.
  set "RC=%TEST_RC%"
  goto cleanup
)

echo [clawdbot] Done.

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
