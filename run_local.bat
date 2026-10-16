@echo off
REM LM Sanctuary: Local Windows Startup & Bootstrap Script (Batch)
setlocal

REM 1. Locate Python Interpreter (prefer 3.12 or 3.11 for full DirectML/CUDA wheel support)
set "PY_CMD="
py -3.12 --version >nul 2>nul && set "PY_CMD=py -3.12"
if not defined PY_CMD (
    py -3.11 --version >nul 2>nul && set "PY_CMD=py -3.11"
)
if not defined PY_CMD (
    py -3 --version >nul 2>nul && set "PY_CMD=py -3"
)
if not defined PY_CMD (
    where python >nul 2>nul && set "PY_CMD=python"
)

if not defined PY_CMD (
    echo Error: Python 3 is not installed or not on PATH. Please install Python 3.12 from https://www.python.org/
    pause
    exit /b 1
)

REM 2. Create Virtual Environment if missing
if not exist ".venv\Scripts\python.exe" (
    echo --- Creating Virtual Environment using %PY_CMD% ---
    %PY_CMD% -m venv .venv
    if %errorlevel% neq 0 (
        echo Error: Failed to create virtual environment.
        pause
        exit /b 1
    )
)

REM 3. Run Hardware-Aware Environment Setup (instant on subsequent runs)
".venv\Scripts\python.exe" setup_env.py %*
if %errorlevel% neq 0 (
    echo Error: Environment setup encountered an issue.
    pause
    exit /b 1
)

REM 4. Start LM Sanctuary Desktop
echo --- Starting LM Sanctuary Desktop ---
start "" ".venv\Scripts\pythonw.exe" desktop.py
exit /b 0
