# LM Sanctuary: Local Windows Startup Script (PowerShell)

# 1. Check for Python
if (!(Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "Error: Python is not installed. Please install it from python.org" -ForegroundColor Red
    exit
}

# 2. Create Virtual Environment
if (!(Test-Path .venv311)) {
    Write-Host "--- Creating Virtual Environment ---"
    py -3.11 -m venv .venv311
}

# 3. Install Dependencies
Write-Host "--- Installing Dependencies ---"
.\.venv311\Scripts\python.exe -m pip install -r requirements.txt

# 4. Environment Variables
# Copy .env.example to .env if missing
if (!(Test-Path .env)) {
    Write-Host "--- Creating .env from .env.example ---"
    Copy-Item .env.example .env
}

# 5. Start LM Sanctuary
Write-Host "--- Starting LM Sanctuary ---"
.\.venv311\Scripts\python app.py
