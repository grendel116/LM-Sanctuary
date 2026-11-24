# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
param(
  [switch]$VerifyOnly,
  [ValidateSet("artifact", "gecko")]
  [string]$Mode = "gecko"
)

$ErrorActionPreference = "Stop"

$DesktopDir = Split-Path -Parent $PSScriptRoot
$RepoRoot = Split-Path -Parent $DesktopDir
$DistDir = Join-Path $DesktopDir "dist"
$ObjBase = Join-Path $DesktopDir "build\firefox\objdir-sanctuary-$Mode\dist"
$ObjDir = @(
  (Join-Path $ObjBase "lm-sanctuary"),
  (Join-Path $ObjBase "firefox")
) | Where-Object { Test-Path $_ } | Select-Object -First 1

$required = @(
  (Join-Path $DesktopDir "mozconfig"),
  (Join-Path $DesktopDir "branding\lm-sanctuary\moz.build"),
  (Join-Path $RepoRoot "LICENSING.md"),
  (Join-Path $RepoRoot "web\assets\img\app_icon.ico")
)
foreach ($item in $required) {
  if (!(Test-Path $item)) {
    throw "Missing Windows packaging prerequisite: $item"
  }
}

$launcherBody = @'
@echo off
setlocal
set ROOT_DIR=%~dp0
if exist "%ROOT_DIR%..\..\sanctuary\desktop.py" (
  "%ROOT_DIR%..\..\.venv\Scripts\pythonw.exe" "%ROOT_DIR%..\..\sanctuary\desktop.py" %*
  exit /b %ERRORLEVEL%
)
if exist "%ROOT_DIR%sanctuary-browser.exe" (
  start "" "%ROOT_DIR%sanctuary-browser.exe" --profile "%ROOT_DIR%gecko_profile" --no-remote --purgecaches %*
  exit /b 0
)
if exist "%ROOT_DIR%lm-sanctuary.exe" (
  start "" "%ROOT_DIR%lm-sanctuary.exe" --profile "%ROOT_DIR%gecko_profile" --no-remote --purgecaches %*
  exit /b 0
)
start "" "%ROOT_DIR%firefox.exe" --profile "%ROOT_DIR%gecko_profile" --no-remote --purgecaches %*
'@

if ($VerifyOnly) {
  if ($launcherBody -notmatch "sanctuary-browser\.exe") {
    throw "Launcher check failed"
  }
  Write-Output "WINDOWS_PACKAGING_VERIFIED"
  exit 0
}

if (!$ObjDir -or !(Test-Path $ObjDir)) {
  throw "Built Gecko distribution not found under $ObjBase. Run browser-desktop/bootstrap_gecko.py --mode $Mode inside MozillaBuild first."
}

New-Item -ItemType Directory -Force -Path $DistDir | Out-Null
$StageDir = Join-Path $DistDir "lm-sanctuary"
if (Test-Path $StageDir) {
  Remove-Item -Recurse -Force $StageDir
}
Copy-Item -Recurse -Force $ObjDir $StageDir

$FirefoxExe = Join-Path $StageDir "firefox.exe"
$LegacyExe = Join-Path $StageDir "lm-sanctuary.exe"
$SanctuaryExe = Join-Path $StageDir "sanctuary-browser.exe"
if (Test-Path $FirefoxExe) {
  Move-Item -Force $FirefoxExe $SanctuaryExe
} elseif (Test-Path $LegacyExe) {
  Move-Item -Force $LegacyExe $SanctuaryExe
}
$OldManifest = Join-Path $StageDir "firefox.VisualElementsManifest.xml"
$NewManifest = Join-Path $StageDir "sanctuary-browser.VisualElementsManifest.xml"
if (Test-Path $OldManifest) {
  Move-Item -Force $OldManifest $NewManifest
}
foreach ($UnusedRel in @("pingsender.exe", "private_browsing.exe", "private_browsing.VisualElementsManifest.xml")) {
  $UnusedPath = Join-Path $StageDir $UnusedRel
  if (Test-Path $UnusedPath) {
    Remove-Item -Force $UnusedPath
  }
}

$ProfileStartupCache = Join-Path $RepoRoot "gecko_profile\startupCache"
if (Test-Path $ProfileStartupCache) {
  Remove-Item -Recurse -Force $ProfileStartupCache
}
Set-Content -Path (Join-Path $StageDir "Sanctuary-Browser.cmd") -Value $launcherBody -Encoding ASCII
Set-Content -Path (Join-Path $StageDir "LM-Sanctuary-Browser.cmd") -Value $launcherBody -Encoding ASCII
Copy-Item -Force (Join-Path $RepoRoot "LICENSING.md") (Join-Path $StageDir "LICENSING.md")
Copy-Item -Recurse -Force (Join-Path $RepoRoot "LICENSES") (Join-Path $StageDir "LICENSES")

$AppIco = Join-Path $RepoRoot "web\assets\img\app_icon.ico"
foreach ($IconDir in @(
  (Join-Path $StageDir "browser\chrome\icons\default"),
  (Join-Path $StageDir "chrome\icons\default")
)) {
  New-Item -ItemType Directory -Force -Path $IconDir | Out-Null
  foreach ($IconName in @("main-window.ico", "default.ico", "privatebrowsing-window.ico")) {
    Copy-Item -Force $AppIco (Join-Path $IconDir $IconName)
  }
}

$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
$PythonExe = if (Test-Path $VenvPython) { $VenvPython } else { "python" }
& $PythonExe (Join-Path $DesktopDir "bootstrap_gecko.py") --rebrand-dist $StageDir --patch-pe-icons $StageDir
if ($LASTEXITCODE -ne 0) {
  throw "Failed to rebrand dist and patch Windows PE metadata in $StageDir"
}

$ZipOut = Join-Path $DistDir "Sanctuary-Browser-Windows-x64.zip"
if (Test-Path $ZipOut) {
  Remove-Item -Force $ZipOut
}
Compress-Archive -Path "$StageDir\*" -DestinationPath $ZipOut -CompressionLevel Optimal
Write-Output "Packaged $ZipOut"

if (Get-Command makensis -ErrorAction SilentlyContinue) {
  $nsiPath = Join-Path $DistDir "sanctuary-browser-installer.nsi"
  $exeOut = Join-Path $DistDir "Sanctuary-Browser-Setup.exe"
  @"
Name "Sanctuary Browser"
OutFile "$exeOut"
InstallDir "`$LOCALAPPDATA\Sanctuary Browser"
Page directory
Page instfiles
Section "Install"
  SetOutPath `$INSTDIR
  File /r "$StageDir\*.*"
  CreateShortCut "`$DESKTOP\Sanctuary Browser.lnk" "`$INSTDIR\Sanctuary-Browser.cmd" "" "`$INSTDIR\chrome\icons\default\default.ico"
SectionEnd
"@ | Set-Content -Path $nsiPath -Encoding ASCII
  & makensis $nsiPath
}
