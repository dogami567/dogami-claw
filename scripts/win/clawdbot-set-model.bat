@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Usage:
rem   scripts\win\clawdbot-set-model.bat openai/gpt-4o-mini
rem   scripts\win\clawdbot-set-model.bat openai/gpt-5.2

call :resolve_repo_root || exit /b 1
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  exit /b 1
)

set "MODEL=%~1"
if "%MODEL%"=="" (
  echo Usage: %~nx0 ^<model^>
  echo Example: %~nx0 openai/gpt-4o-mini
  popd >nul
  exit /b 2
)

call "%~dp0clawdbot-apply-openai-proxy.bat"
if errorlevel 1 (
  popd >nul
  exit /b 1
)

echo [clawdbot] Ensuring gateway container is running...
docker compose up -d clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to start gateway container.
  popd >nul
  exit /b 1
)

echo [clawdbot] Setting default model to: %MODEL%
docker compose exec -T clawdbot-gateway node dist/index.js models set "%MODEL%"
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to set model.
  popd >nul
  exit /b 1
)

echo [clawdbot] Restarting gateway...
docker compose restart clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to restart gateway.
  popd >nul
  exit /b 1
)

call "%~dp0clawdbot-smoke-test.bat"
set "TEST_RC=%ERRORLEVEL%"
if not "%TEST_RC%"=="0" (
  echo [clawdbot] ERROR: smoke test failed after restart.
  popd >nul
  exit /b %TEST_RC%
)

echo [clawdbot] Done.
popd >nul
exit /b 0

:resolve_repo_root
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
exit /b 0

