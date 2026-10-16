# LM Sanctuary: Local Windows Startup & Bootstrap Script (PowerShell)

$ErrorActionPreference = "Stop"

# 1. Locate Python Interpreter (prefer 3.12 or 3.11 for full DirectML/CUDA wheel support)
$pyCmd = $null
if (Get-Command py -ErrorAction SilentlyContinue) {
    foreach ($ver in @("-3.12", "-3.11", "-3")) {
        try {
            & py $ver --version *> $null
            if ($LASTEXITCODE -eq 0) {
                $pyCmd = @("py", $ver)
                break
            }
        } catch {}
    }
}
if (-not $pyCmd -and (Get-Command python -ErrorAction SilentlyContinue)) {
    $pyCmd = @("python")
}

if (-not $pyCmd) {
    Write-Host "Error: Python 3 is not installed or not on PATH. Please install Python 3.12 from https://www.python.org/" -ForegroundColor Red
    exit 1
}

# 2. Create Virtual Environment if missing
if (!(Test-Path ".\.venv\Scripts\python.exe")) {
    Write-Host "--- Creating Virtual Environment ($($pyCmd -join ' ')) ---" -ForegroundColor Cyan
    if ($pyCmd.Count -gt 1) {
        & $pyCmd[0] $pyCmd[1] -m venv .venv
    } else {
        & $pyCmd[0] -m venv .venv
    }
}

# 3. Run Hardware-Aware Environment Setup (instant on subsequent runs)
& ".\.venv\Scripts\python.exe" setup_env.py @args
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: Environment setup failed." -ForegroundColor Red
    exit 1
}

# 4. Start LM Sanctuary Desktop
Write-Host "--- Starting LM Sanctuary Desktop ---" -ForegroundColor Green
Start-Process -FilePath ".\.venv\Scripts\pythonw.exe" -ArgumentList "desktop.py" -WindowStyle Hidden
