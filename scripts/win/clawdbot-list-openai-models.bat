@echo off
setlocal EnableExtensions EnableDelayedExpansion

call :resolve_repo_root || exit /b 1
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  exit /b 1
)

echo [clawdbot] Ensuring gateway container is running...
docker compose up -d clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to start gateway container.
  popd >nul
  exit /b 1
)

echo [clawdbot] OpenAI models (built-in catalog):
docker compose exec -T clawdbot-gateway node dist/index.js models list --all --provider openai --plain
set "RC=%ERRORLEVEL%"
popd >nul
exit /b %RC%

:resolve_repo_root
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
exit /b 0

