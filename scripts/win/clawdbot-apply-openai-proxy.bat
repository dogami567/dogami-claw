@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Ensure OpenAI built-in provider routes through the proxy baseUrl.
rem Reads CLAWDBOT_OPENAI_BASE_URL from .env and writes it into:
rem   .runtime\config\agents\main\agent\models.json  -> providers.openai.baseUrl

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

set "OPENAI_BASE_URL="
for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  if /i "%%A"=="CLAWDBOT_OPENAI_BASE_URL" set "OPENAI_BASE_URL=%%B"
)

if not defined OPENAI_BASE_URL (
  echo [clawdbot] ERROR: CLAWDBOT_OPENAI_BASE_URL is missing in .env
  popd >nul
  exit /b 1
)

set "MODELS_JSON=%REPO_ROOT%\.runtime\config\agents\main\agent\models.json"
if not exist "%MODELS_JSON%" (
  rem Create a minimal file if it doesn't exist yet.
  if not exist "%REPO_ROOT%\.runtime\config\agents\main\agent" (
    mkdir "%REPO_ROOT%\.runtime\config\agents\main\agent" >nul 2>&1
  )
  >"%MODELS_JSON%" echo { "providers": {} }
)

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $modelsPath='%MODELS_JSON%'; $baseUrl='%OPENAI_BASE_URL%'; $raw=Get-Content -Raw $modelsPath; if (-not $raw.Trim()) { $raw='{\"providers\":{}}' }; $obj=$raw | ConvertFrom-Json; if (-not $obj.providers) { $obj | Add-Member -MemberType NoteProperty -Name providers -Value (@{}) }; if (-not $obj.providers.openai) { $obj.providers | Add-Member -MemberType NoteProperty -Name openai -Value (@{}) }; $obj.providers.openai.baseUrl=$baseUrl.Trim(); $obj | ConvertTo-Json -Depth 100 | Set-Content -Encoding UTF8 $modelsPath; Write-Host '[clawdbot] OpenAI proxy baseUrl applied.';"

if errorlevel 1 (
  echo [clawdbot] ERROR: failed to update %MODELS_JSON%
  popd >nul
  exit /b 1
)

popd >nul
exit /b 0

:resolve_repo_root
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\..") do set "REPO_ROOT=%%~fI"
exit /b 0
