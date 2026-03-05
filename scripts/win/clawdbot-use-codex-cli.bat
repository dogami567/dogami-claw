@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Sync Codex CLI settings (~/.codex/{auth.json,config.toml}) into Clawdbot's local docker .env.
rem - Sets:
rem     CLAWDBOT_OPENAI_API_KEY  <- auth.json: OPENAI_API_KEY
rem     CLAWDBOT_OPENAI_BASE_URL <- config.toml: [model_providers.<model_provider>].base_url
rem - Applies the baseUrl into .runtime\config\agents\main\agent\models.json (OpenAI provider)
rem - Restarts gateway and runs the smoke test
rem
rem Usage:
rem   scripts\win\clawdbot-use-codex-cli.bat [--project|--global|--codex-home "<abs path>"]
rem
rem Notes:
rem - Default behavior prefers repo-local .codex when present.
rem - Use --global to force %USERPROFILE%\.codex (or %CODEX_HOME% if set).

set "RC=0"
set "DID_PUSHD="

rem Resolve repo root early (before any argument shifting).
set "SCRIPT_PATH=%~f0"
set "SCRIPT_DIR=%~dp0"
for %%I in ("%SCRIPT_DIR%..\\..") do set "REPO_ROOT=%%~fI"
if not defined REPO_ROOT (
  echo [clawdbot] ERROR: cannot resolve repo root.
  exit /b 1
)

set "ARG_MODE="
set "ARG_CODEX_HOME="

:parse_args
if "%~1"=="" goto after_args
if /i "%~1"=="--help" goto help
if /i "%~1"=="-h" goto help
if /i "%~1"=="--global" (
  set "ARG_MODE=global"
  shift
  goto parse_args
)
if /i "%~1"=="--project" (
  set "ARG_MODE=project"
  shift
  goto parse_args
)
if /i "%~1"=="--codex-home" (
  shift
  if "%~1"=="" (
    echo [clawdbot] ERROR: --codex-home requires a directory path.
    set "RC=1"
    goto cleanup
  )
  set "ARG_CODEX_HOME=%~1"
  shift
  goto parse_args
)
echo [clawdbot] ERROR: unknown arg: %~1
set "RC=1"
goto cleanup

:after_args
pushd "%REPO_ROOT%" >nul || (
  echo [clawdbot] ERROR: cannot cd to repo root: "%REPO_ROOT%"
  set "RC=1"
  goto cleanup
)
set "DID_PUSHD=1"

if not exist ".env" (
  echo [clawdbot] ERROR: missing .env in repo root.
  echo [clawdbot] Tip: run docker-setup.sh ^(or create .env^) first.
  set "RC=1"
  goto cleanup
)

set "COMPOSE_FILES=-f docker-compose.yml"
if exist "docker-compose.extra.yml" set "COMPOSE_FILES=%COMPOSE_FILES% -f docker-compose.extra.yml"

rem Prefer per-project Codex config when present (default behavior):
rem   <repo>\.codex\config.toml / <repo>\.codex\auth.json
rem Allow forcing global or a custom CODEX_HOME via args.
set "PROJECT_CODEX_HOME=%REPO_ROOT%\.codex"

set "GLOBAL_CODEX_HOME=%CODEX_HOME%"
if not defined GLOBAL_CODEX_HOME set "GLOBAL_CODEX_HOME=%USERPROFILE%\.codex"

set "SELECTED_CODEX_HOME="
set "SELECTED_SOURCE="

if defined ARG_CODEX_HOME (
  set "SELECTED_CODEX_HOME=%ARG_CODEX_HOME%"
  set "SELECTED_SOURCE=custom"
) else if /i "%ARG_MODE%"=="global" (
  set "SELECTED_CODEX_HOME=%GLOBAL_CODEX_HOME%"
  set "SELECTED_SOURCE=global"
) else if /i "%ARG_MODE%"=="project" (
  set "SELECTED_CODEX_HOME=%PROJECT_CODEX_HOME%"
  set "SELECTED_SOURCE=project"
) else (
  if exist "%PROJECT_CODEX_HOME%\auth.json" if exist "%PROJECT_CODEX_HOME%\config.toml" (
    set "SELECTED_CODEX_HOME=%PROJECT_CODEX_HOME%"
    set "SELECTED_SOURCE=project"
  ) else (
    set "SELECTED_CODEX_HOME=%GLOBAL_CODEX_HOME%"
    set "SELECTED_SOURCE=global"
  )
)

set "CODEX_AUTH=%SELECTED_CODEX_HOME%\auth.json"
set "CODEX_CONFIG=%SELECTED_CODEX_HOME%\config.toml"

if not exist "%CODEX_AUTH%" (
  echo [clawdbot] ERROR: Codex auth file not found: "%CODEX_AUTH%"
  echo [clawdbot] Selected source: %SELECTED_SOURCE%
  set "RC=1"
  goto cleanup
)
if not exist "%CODEX_CONFIG%" (
  echo [clawdbot] ERROR: Codex config file not found: "%CODEX_CONFIG%"
  echo [clawdbot] Selected source: %SELECTED_SOURCE%
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Using Codex home (%SELECTED_SOURCE%): "%SELECTED_CODEX_HOME%"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$repo = (Get-Location).Path;" ^
  "$envPath = Join-Path $repo '.env';" ^
  "$authPath = '%CODEX_AUTH%';" ^
  "$cfgPath = '%CODEX_CONFIG%';" ^
  "$auth = Get-Content -Raw $authPath | ConvertFrom-Json;" ^
  "$apiKey = [string]$auth.OPENAI_API_KEY;" ^
  "if (-not $apiKey.Trim()) { throw ('Missing OPENAI_API_KEY in ' + $authPath) }" ^
  "$raw = Get-Content -Raw $cfgPath;" ^
  "$modelProvider = ([regex]::Match($raw, '(?m)^\s*model_provider\s*=\s*\x22(?<v>.+?)\x22\s*$')).Groups['v'].Value;" ^
  "if (-not $modelProvider) { throw ('Missing model_provider in ' + $cfgPath) }" ^
  "$sectionHeader = '[model_providers.' + $modelProvider + ']';" ^
  "$lines = $raw -split \"`r?`n\";" ^
  "$inSection = $false;" ^
  "$baseUrl = '';" ^
  "foreach ($line in $lines) {" ^
  "  $trim = $line.Trim();" ^
  "  if (-not $trim) { continue }" ^
  "  if ($trim.StartsWith('#')) { continue }" ^
  "  if ($trim.StartsWith('[') -and $trim.EndsWith(']')) {" ^
  "    $inSection = ($trim -eq $sectionHeader);" ^
  "    continue;" ^
  "  }" ^
  "  if (-not $inSection) { continue }" ^
  "  $m = [regex]::Match($trim, '^base_url\s*=\s*\x22(?<v>.+?)\x22\s*$');" ^
  "  if ($m.Success) { $baseUrl = $m.Groups['v'].Value; break }" ^
  "}" ^
  "if (-not $baseUrl.Trim()) { throw ('Missing base_url in ' + $sectionHeader + ' section of ' + $cfgPath) }" ^
  "try { [void](New-Object System.Uri($baseUrl.Trim())) } catch { throw ('Invalid base_url: ' + $baseUrl) }" ^
  "" ^
  "$updates = @{" ^
  "  'CLAWDBOT_OPENAI_API_KEY' = $apiKey.Trim();" ^
  "  'CLAWDBOT_OPENAI_BASE_URL' = $baseUrl.Trim();" ^
  "};" ^
  "$existing = @();" ^
  "if (Test-Path $envPath) { $existing = Get-Content $envPath -Raw -ErrorAction SilentlyContinue -Encoding utf8 }" ^
  "$text = if ($existing) { [string]$existing } else { '' }" ^
  "$rows = $text -split \"`r?`n\";" ^
  "$seen = @{};" ^
  "$out = New-Object System.Collections.Generic.List[string];" ^
  "foreach ($row in $rows) {" ^
  "  if ($row -match '^(\s*#|\s*$)') { $out.Add($row); continue }" ^
  "  if ($row -match '^\s*([^=\s]+)\s*=.*$') {" ^
  "    $k = $Matches[1];" ^
  "    if ($updates.ContainsKey($k)) {" ^
  "      $out.Add($k + '=' + $updates[$k]);" ^
  "      $seen[$k] = $true;" ^
  "      continue" ^
  "    }" ^
  "  }" ^
  "  $out.Add($row);" ^
  "}" ^
  "foreach ($k in $updates.Keys) {" ^
  "  if (-not $seen.ContainsKey($k)) { $out.Add($k + '=' + $updates[$k]) }" ^
  "}" ^
  "$final = ($out -join \"`n\").TrimEnd() + \"`n\";" ^
  "$utf8 = New-Object System.Text.UTF8Encoding($false);" ^
  "[System.IO.File]::WriteAllText($envPath, $final, $utf8);" ^
  "Write-Host ('[clawdbot] Synced Codex CLI settings to .env (provider=' + $modelProvider + ').');" ^
  "Write-Host ('[clawdbot] Base URL: ' + $baseUrl.Trim());"

if errorlevel 1 (
  echo [clawdbot] ERROR: failed to sync Codex settings into .env
  set "RC=1"
  goto cleanup
)

call "%SCRIPT_DIR%clawdbot-apply-openai-proxy.bat"
if errorlevel 1 (
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Ensuring gateway container is running...
docker compose %COMPOSE_FILES% up -d clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to start gateway container.
  set "RC=1"
  goto cleanup
)

echo [clawdbot] Restarting gateway...
docker compose %COMPOSE_FILES% restart clawdbot-gateway >nul
if errorlevel 1 (
  echo [clawdbot] ERROR: failed to restart gateway.
  set "RC=1"
  goto cleanup
)

call "%SCRIPT_DIR%clawdbot-smoke-test.bat"
set "TEST_RC=%ERRORLEVEL%"
if not "%TEST_RC%"=="0" (
  echo [clawdbot] ERROR: smoke test failed after applying Codex settings.
  set "RC=%TEST_RC%"
  goto cleanup
)

echo [clawdbot] Done.

:cleanup
if defined DID_PUSHD popd >nul
call :maybe_pause %RC%
exit /b %RC%

:help
echo Sync Codex CLI settings into Clawdbot Docker .env.
echo.
echo Usage:
echo   scripts\win\clawdbot-use-codex-cli.bat [--project^|--global^|--codex-home "D:\path\to\.codex"]
echo.
echo Default behavior:
echo   Prefer "<repo>\.codex" when present, otherwise use "%USERPROFILE%\.codex" ^(or %%CODEX_HOME%%^).
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
  echo(!CMDCMDLINE! | find /I "/c" >nul && echo(!CMDCMDLINE! | find /I "%SCRIPT_PATH%" >nul && if /I "!GP_NAME!"=="explorer" set "SHOULD_PAUSE=1"
)
if defined SHOULD_PAUSE (
  echo.
  pause
)
exit /b 0
