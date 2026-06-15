---
name: autonomous_programming
description: Dynamically write and execute python scripts to handle tasks that lack built-in tools.
---
# SKILL: Autonomous Scripting

When tasked with file parsing, data processing, compilation, or other operations that lack a dedicated tool:

1. **Research Code & Libraries**:
   - Search GitHub (e.g. `web_search("github: <topic>")`) to locate existing code snippets, wrappers, or templates.
   - Search PyPI or official python documentation (e.g. `web_search("site:pypi.org <task>")`) to discover lightweight libraries suitable for the job.

2. **Create a Scratch Script**:
   - Write a python script using the `write_file` tool.
   - Save the script in the `scratch/` directory (e.g., `scratch/scratch_script.py`) to keep the workspace root clean and ignored by version control.
   
3. **Install Required Libraries**:
   - Run pip installations using the active Python executable specified in your environment context.
   - Example Command: `<Active Python Executable> -m pip install <package_name>`
   
4. **Execute the Script**:
   - Run the script using the active Python executable.
   - Example Command: `<Active Python Executable> scratch/<script_name>.py`
   
5. **Debug and Iterate**:
   - Read the command output.
   - Edit the script using `replace_file_content` to fix any syntax or logical errors.
   - Rerun until execution is successful.
   
6. **Present the Results**:
   - Format the final output and answer the user's request.
