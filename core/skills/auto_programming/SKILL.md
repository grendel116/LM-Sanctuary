---
name: auto_programming
description: Write, run, and debug Python scripts, execute shell commands, launch local apps or servers, and inspect or edit workspace files.
summary: "Inspect workspaces, edit files, run shell commands, and execute Python scripts using [get_workspace_structure()], [find_files(pattern=\"...\")], [search_codebase(keyword=\"...\")], [read_file(path=\"...\", start_line=1, end_line=100)], [write_file(path=\"...\", content=\"...\")], [replace_in_file(path=\"...\", old_text=\"...\", new_text=\"...\")], [replace_file_content(path=\"...\", start_line=1, end_line=10, target_content=\"...\", replacement_content=\"...\")], [run_shell_command(command=\"...\")], and [run_command_async(command=\"...\")]"
retrieval: vector
triggers: script, code, program, debug, automate, python, coding, convert, process, command, shell, terminal, run, execute, launch, open, start, app, server, localhost, port, file, folder, directory, workspace, codebase, repo, project, build, install, edit, write, read, task, fix, bug, refactor, test
---
# SKILL: Auto Programming & Workspace Execution
Follow an **Inspect → Act → Verify** workflow whenever asked to run, build, or edit a project:

- **Path Rules**: Always use forward slashes `/` for all file and directory paths across all platforms (e.g., `C:/LLM/Alfred-Program/remediate.py`), including Windows. Never use backslashes in paths. For files outside the workspace, specify the full absolute path using forward slashes.

1. **Inspect First (Never Guess Commands or File Contents)**:
   - Before starting an app or editing code, inspect the workspace structure or config files (`package.json`, `pyproject.toml`, `README.md`):
     - `[get_workspace_structure()]` or `[find_files(pattern="...")]`
     - `[read_file(path="package.json")]` or `[search_codebase(keyword="...")]`
2. **Reading & Editing Files**:
   - Read a file with 1-indexed line numbers: `[read_file(path="...")]` or `[read_file(path="...", start_line=1, end_line=150)]`
   - Create or overwrite a file: `[write_file(path="...", content="...")]`
   - Replace an exact block of text: `[replace_in_file(path="...", old_text="...", new_text="...")]`
   - Replace a line-numbered block of code: `[replace_file_content(path="...", start_line=10, end_line=20, target_content="...", replacement_content="...")]`
3. **Starting Servers, Apps & Shell Commands**:
   - Run one-off commands (tests, linters, git, package installs) in the active workspace: `[run_shell_command(command="...")]` or `[run_shell_command(command="...", cwd="...")]`
   - Start long-running dev servers or apps (e.g., `npm run web`, `npx expo start --web --port <port>`, `python app.py`) in the background so they do not time out:
     1. `[run_command_async(command="...")]`
     2. `[wait_task(task_id="...", timeout=8)]` to confirm the server started cleanly.
     3. To open a URL in the user's browser once the server is running: `[run_shell_command(command="start <url>")]`
   - Manage background tasks: `[manage_task(action="status|list|kill|send_input", task_id="...")]`
4. **Custom Python Scripting**:
   - Save a scratch script: `[write_file(path="scratch/<script_name>.py", content="...")]`
   - Execute the script: `[run_shell_command(command="<Active Python Executable> scratch/<script_name>.py")]`

