---
name: auto_programming
title: In-Process Coding & Automatic Gear Transmission
description: Inspect, edit, and verify workspace repositories in-process with automatic gear-shifting across Local Park, Fast Cruise, and Deep Planning/Recovery.
summary: "In-process coding tools: [list_dir(path=\"...\")], [grep_search(query=\"...\", path=\"...\")], [read_file(path=\"...\", start_line=1, end_line=250)], [edit_file(path=\"...\", target=\"...\", replacement=\"...\")], [write_file(path=\"...\", content=\"...\")], [run_command(command=\"...\")], [set_working_folder(path=\"...\")]; optional isolated worktree: [delegate_coding(task=\"...\", isolate=True)]."
retrieval: vector
triggers: script, code, coding, python, javascript, debug, refactor, codebase, repo, repository, workspace, terminal, shell, command, localhost, directory, folder, audit, review, bug, test, build, openhands, cloud, subagent, delegate_coding, consult_cloud, implement, fix, feature, architecture, plan, complex, analyze, analysis, explain, accuracy, accurate, verify, fact check, deep dive, compare, tradeoff, tradeoffs, synthesis, urgent, wrong, mistake, incorrect
---
# SKILL: In-Process Coding & Automatic Gear Transmission
- **Automatic Transmission**: Planning (`/plan`, initial codebase reconnaissance, and post-strike re-planning) and error recovery always run on the Deep Cloud model (`2nd`), steady cruising edits can use Fast (`1st`), and casual chat stays Local (`Park`).
- **Read First (`read_band`)**: Inspect real files with `list_dir`, `grep_search`, and `read_file` before editing.
- **Edit & Verify (`write_band`)**: Patch exact unique lines with `edit_file(path, target, replacement)`, create files with `write_file(path, content)`, and run targeted tests with `run_command(command)`. Switch workspace root via `set_working_folder(path)`.
- **2-Strike Rule**: After 2 consecutive failures on the same error or target, write tools disengage for 1 mandatory read-only step—inspect the target file, state a 2-sentence root-cause hypothesis, and pivot. Never repeat the same failing edit or command.
- **`/plan` Mode**: Keep edits disabled and present a concise plan inside a ```` ```sanctuary-plan ```` fenced block.
- **Isolated Worktree (Optional)**: Only use `delegate_coding(task, isolate=True)` when the user explicitly asks for an isolated git worktree branch.
