@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Ensure OpenAI built-in provider routes through the proxy baseUrl.
rem Reads CLAWDBOT_OPENAI_BASE_URL from .env and writes it into:
rem   .runtime\config\agents\main\agent\models.json  -> providers.openai.baseUrl

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

set "OPENAI_BASE_URL="
for /f "usebackq eol=# tokens=1* delims==" %%A in (".env") do (
  if /i "%%A"=="CLAWDBOT_OPENAI_BASE_URL" set "OPENAI_BASE_URL=%%B"
)

if not defined OPENAI_BASE_URL (
  echo [clawdbot] ERROR: CLAWDBOT_OPENAI_BASE_URL is missing in .env
  set "RC=1"
  goto cleanup
)

set "MODELS_JSON=%REPO_ROOT%\.runtime\config\agents\main\agent\models.json"
if not exist "%MODELS_JSON%" (
  rem Create a minimal file if it doesn't exist yet.
  if not exist "%REPO_ROOT%\.runtime\config\agents\main\agent" (
    mkdir "%REPO_ROOT%\.runtime\config\agents\main\agent" >nul 2>&1
  )
  >"%MODELS_JSON%" echo { "providers": {} }
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$modelsPath = '%MODELS_JSON%';" ^
  "$baseUrl = '%OPENAI_BASE_URL%'.Trim();" ^
  "$raw = (Get-Content -Raw -ErrorAction SilentlyContinue $modelsPath);" ^
  "if (-not $raw -or -not $raw.Trim()) { $raw = '{\"providers\":{}}' }" ^
  "$obj = $raw | ConvertFrom-Json;" ^
  "if (-not $obj.providers) { $obj | Add-Member -MemberType NoteProperty -Name providers -Value (@{}) }" ^
  "if (-not $obj.providers.openai) { $obj.providers | Add-Member -MemberType NoteProperty -Name openai -Value (@{}) }" ^
  "$obj.providers.openai.baseUrl = $baseUrl;" ^
  "$json = ($obj | ConvertTo-Json -Depth 100);" ^
  "$utf8 = New-Object System.Text.UTF8Encoding($false);" ^
  "[System.IO.File]::WriteAllText($modelsPath, $json + \"`n\", $utf8);" ^
  "Write-Host '[clawdbot] OpenAI proxy baseUrl applied.';"

if errorlevel 1 (
  echo [clawdbot] ERROR: failed to update %MODELS_JSON%
  set "RC=1"
  goto cleanup
)

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
