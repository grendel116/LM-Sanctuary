@echo off
REM LM Sanctuary: Local Windows Startup Script (Batch)

REM 1. Check for Python
where python >nul 2>nul
if %errorlevel% neq 0 (
    echo Error: Python is not installed. Please install it from python.org
    pause
    exit /b 1
)

REM 2. Create Virtual Environment
if not exist .venv311 (
    echo --- Creating Virtual Environment ---
    py -3.11 -m venv .venv311
)

REM 3. Install Dependencies
echo --- Installing Dependencies ---
call .venv311\Scripts\python.exe -m pip install -r requirements.txt

REM 4. Environment Variables
REM Copy .env.example to .env if missing
if not exist .env (
    echo --- Creating .env from .env.example ---
    copy .env.example .env >nul
)

REM 5. Start LM Sanctuary
echo --- Starting LM Sanctuary ---
.venv311\Scripts\python app.py
pause
