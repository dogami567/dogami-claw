@echo off
setlocal EnableExtensions EnableDelayedExpansion

call :resolve_repo_root || exit /b 1
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  exit /b 1
)

call "%~dp0clawdbot-apply-openai-proxy.bat"
if errorlevel 1 (
  popd >nul
  exit /b 1
)

echo [clawdbot] Restarting gateway...
docker compose restart clawdbot-gateway
if errorlevel 1 (
  echo [clawdbot] ERROR: restart failed.
  popd >nul
  exit /b 1
)

echo [clawdbot] Restarted.
popd >nul
exit /b 0

:resolve_repo_root
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
exit /b 0

