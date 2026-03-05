@echo off
setlocal EnableExtensions EnableDelayedExpansion

rem Enable a "portable" Docker gateway home by bind-mounting /home/node to .runtime/home.
rem
rem Why:
rem - Persist caches/downloads under the container home (e.g. ~/.cache) on the host
rem - Keep Clawdbot's persistent state under the repo's .runtime/* so it's easy to zip/move
rem
rem What it does:
rem - Ensures .runtime\home exists
rem - Writes/updates docker-compose.extra.yml (gitignored) to mount:
rem     .runtime/home  -> /home/node
rem     (and re-mounts config/workspace after, to avoid being hidden by /home/node mount)
rem - Restarts the gateway to apply changes

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
  echo [clawdbot] Tip: run scripts\win\clawdbot-start-gateway.bat first.
  set "RC=1"
  goto cleanup
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference='Stop';" ^
  "$repo = (Get-Location).Path;" ^
  "$envPath = Join-Path $repo '.env';" ^
  "$extraPath = Join-Path $repo 'docker-compose.extra.yml';" ^
  "$homeDir = Join-Path $repo '.runtime/home';" ^
  "New-Item -ItemType Directory -Force -Path $homeDir | Out-Null;" ^
  "" ^
  "$map = @{};" ^
  "foreach ($row in (Get-Content $envPath -ErrorAction Stop)) {" ^
  "  if ($row -match '^(\\s*#|\\s*$)') { continue }" ^
  "  $i = $row.IndexOf('=');" ^
  "  if ($i -lt 1) { continue }" ^
  "  $k = $row.Substring(0,$i).Trim();" ^
  "  $v = $row.Substring($i+1);" ^
  "  $map[$k] = $v;" ^
  "}" ^
  "$configDir = [string]$map['CLAWDBOT_CONFIG_DIR'];" ^
  "$workspaceDir = [string]$map['CLAWDBOT_WORKSPACE_DIR'];" ^
  "if (-not $configDir) { throw 'Missing CLAWDBOT_CONFIG_DIR in .env' }" ^
  "if (-not $workspaceDir) { throw 'Missing CLAWDBOT_WORKSPACE_DIR in .env' }" ^
  "" ^
  "$homeDirDocker = ($homeDir -replace '\\','/');" ^
  "$configDir = ($configDir -replace '\\','/');" ^
  "$workspaceDir = ($workspaceDir -replace '\\','/');" ^
  "" ^
  "if (Test-Path $extraPath) { Copy-Item $extraPath ($extraPath + '.bak') -Force }" ^
  "$yamlLines = @(" ^
  "  'services:'," ^
  "  '  clawdbot-gateway:'," ^
  "  '    volumes:'," ^
  "  ('      - ' + $homeDirDocker + ':/home/node')," ^
  "  ('      - ' + $configDir + ':/home/node/.clawdbot')," ^
  "  ('      - ' + $workspaceDir + ':/home/node/clawd')," ^
  "  '  clawdbot-cli:'," ^
  "  '    volumes:'," ^
  "  ('      - ' + $homeDirDocker + ':/home/node')," ^
  "  ('      - ' + $configDir + ':/home/node/.clawdbot')," ^
  "  ('      - ' + $workspaceDir + ':/home/node/clawd')" ^
  ");" ^
  "$yaml = ($yamlLines -join \"`n\") + \"`n\";" ^
  "$utf8 = New-Object System.Text.UTF8Encoding($false);" ^
  "[System.IO.File]::WriteAllText($extraPath, $yaml, $utf8);" ^
  "Write-Host ('[clawdbot] Wrote docker-compose.extra.yml (portable /home/node).');" ^
  "Write-Host ('[clawdbot] Home dir: ' + $homeDirDocker);"

if errorlevel 1 (
  echo [clawdbot] ERROR: failed to write docker-compose.extra.yml
  set "RC=1"
  goto cleanup
)

set "CLAWDBOT_NO_PAUSE=1"
call "%~dp0clawdbot-restart-gateway.bat"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto cleanup

echo [clawdbot] Done. Your Docker gateway state is now portable under:
echo [clawdbot]   .runtime\config
echo [clawdbot]   .runtime\workspace
echo [clawdbot]   .runtime\home

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
