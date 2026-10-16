#!/usr/bin/env bash
# LM Sanctuary: Local Linux / macOS Startup & Bootstrap Script

set -e

# 1. Locate Python 3 (prefer 3.12 or 3.11 when available)
PYTHON_CMD=""
for candidate in python3.12 python3.11 python3 python; do
    if command -v "$candidate" >/dev/null 2>&1; then
        PYTHON_CMD="$candidate"
        break
    fi
done

if [ -z "$PYTHON_CMD" ]; then
    echo "Error: Python 3 is not installed. Please install python3 (and python3-venv) using your package manager."
    exit 1
fi

# 2. Create Virtual Environment if missing
if [ ! -f ".venv/bin/python" ]; then
    echo "--- Creating Virtual Environment ($PYTHON_CMD) ---"
    "$PYTHON_CMD" -m venv .venv
fi

# 3. Run Hardware-Aware Environment Setup (instant on subsequent runs)
.venv/bin/python setup_env.py "$@"

# 4. Start LM Sanctuary
echo "--- Starting LM Sanctuary ---"
if [ -n "$DISPLAY" ] || [ -n "$WAYLAND_DISPLAY" ] || [ "$(uname)" = "Darwin" ]; then
    .venv/bin/python desktop.py
else
    echo "No GUI display detected. Starting headless server on port 5000..."
    .venv/bin/python app.py
fi
