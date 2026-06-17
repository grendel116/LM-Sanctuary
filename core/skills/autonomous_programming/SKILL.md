---
name: autonomous_programming
description: Dynamically write and execute python scripts to handle tasks that lack built-in tools.
---
# SKILL: Autonomous Scripting
If a task lacks a dedicated tool:
1. Write a python script using the `write_file` tool to save it under the `scratch/` directory.
2. If needed, install libraries: `[Active Python Executable] -m pip install <package>` via the `run_shell_command` tool (where `[Active Python Executable]` is the python path provided in the DYNAMIC RUNTIME CONTEXT section of your system instructions).
3. Run the script: `[Active Python Executable] scratch/<script_name>.py` via the `run_shell_command` tool, and debug using file edit tools.
