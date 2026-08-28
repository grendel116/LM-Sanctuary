#!/usr/bin/env bash
# LM Sanctuary: Local Linux Startup Script

set -e

# 1. Check for Python 3
if command -v python3 >/dev/null 2>&1; then
    PYTHON_CMD=python3
elif command -v python >/dev/null 2>&1; then
    PYTHON_CMD=python
else
    echo "Error: Python 3 is not installed. Please install python3 (and python3-venv) using your distribution's package manager."
    exit 1
fi

# 2. Create Virtual Environment
if [ ! -d ".venv" ]; then
    echo "--- Creating Virtual Environment ---"
    $PYTHON_CMD -m venv .venv
fi

# 3. Install Dependencies
echo "--- Installing Dependencies ---"
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q -r requirements.txt

# 4. Environment Variables
if [ ! -f ".env" ]; then
    echo "--- Creating .env from .env.example ---"
    cp .env.example .env
fi

# 5. Start LM Sanctuary
echo "--- Starting LM Sanctuary ---"
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ]; then
    .venv/bin/python desktop.py
else
    echo "No GUI display detected. Starting headless server on port 5000..."
    .venv/bin/python app.py
fi
