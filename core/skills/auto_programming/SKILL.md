---
name: auto_programming
description: Write, run, and debug Python scripts, execute shell commands, launch local apps or servers, and inspect or edit workspace files.
summary: "Inspect workspaces, edit files, run shell commands, and execute Python scripts using [get_workspace_structure()], [find_files(pattern=\"...\")], [search_codebase(keyword=\"...\")], [read_file(path=\"...\", start_line=1, end_line=100)], [outline_file(path=\"...\")], [read_symbol(path=\"...\", symbol=\"Class.method\")], [review_code(path=\"...\", goal=\"...\")], [find_references(symbol=\"name\")], [write_file(path=\"...\", content=\"...\")], [replace_in_file(path=\"...\", old_text=\"...\", new_text=\"...\")], [replace_file_content(path=\"...\", start_line=1, end_line=10, target_content=\"...\", replacement_content=\"...\")], [run_shell_command(command=\"...\")], and [run_command_async(command=\"...\")]"
retrieval: vector
triggers: script, code, program, debug, automate, python, coding, convert, process, command, shell, terminal, run, execute, launch, open, start, app, server, localhost, port, file, folder, directory, workspace, codebase, repo, project, build, install, edit, write, read, task, fix, bug, refactor, test, audit, review, analyze, outline, function, class, module, large file
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
   - **Large files / big jobs (context is limited)**: never read a whole large file. Use `[outline_file(path="...")]` to list classes/functions with line spans, then `[read_symbol(path="...", symbol="Class.method")]` to read one symbol at a time.
   - **Whole-file or folder audit/review**: call `[review_code(path="...", goal="what to look for")]`, then `[review_code()]` again until it reports REVIEW COMPLETE. The system splits the code so every line is covered, checks each claim with tools and a second review, and tracks progress itself; you do not plan or keep notes. Answer from its digest in your own voice, treating "confirmed" as established and "unsure" as suspicion.
   - Reads of Python code (`read_file`, `read_symbol`) end with tool-computed facts: lint results for that range and who calls the functions in it. They outrank your own guesses: never call a name "undefined" if lint says nothing is wrong, and check callers before claiming a contract is broken.
   - Edit tools (`write_file`, `replace_in_file`, `replace_file_content`, `multi_replace_file_content`) automatically append a `[verify]` line (syntax/undefined-name check for .py, validity for .json/.js). If it reports a problem, fix it immediately; still run tests via `run_shell_command` for behavior.
   - For anything that depends on code outside what you are reading (a global, an import, a caller's contract), check `[find_references(symbol="name")]` first. For Python it shows the definition, every caller and callee, then each textual mention.
   - After each edit, verify that file (syntax check/linter/tests via `run_shell_command`) before moving on.
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

