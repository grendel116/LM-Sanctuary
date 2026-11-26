---
name: auto_programming
title: In-Process Coding & Automatic Gear Transmission
description: Inspect, edit, and verify workspace repositories in-process with automatic gear-shifting across Local Park, Fast Cruise, and Deep Planning/Recovery.
summary: "In-process coding tools: [list_dir(path=\"...\")], [grep_search(query=\"...\", path=\"...\")], [read_file(path=\"...\", start_line=1, end_line=250)], [http_probe(url=\"...\", method=\"GET\", headers={...})], [edit_file(path=\"...\", target=\"...\", replacement=\"...\")], [write_file(path=\"...\", content=\"...\")], [run_command(command=\"...\")], [update_plan_step(step=1, status=\"in_progress\", note=\"...\")], [set_working_folder(path=\"...\")]; optional isolated worktree: [delegate_coding(task=\"...\", isolate=True)]."
retrieval: vector
triggers: script, code, coding, python, javascript, debug, refactor, codebase, repo, repository, workspace, terminal, shell, command, localhost, directory, folder, audit, review, bug, test, build, openhands, cloud, subagent, delegate_coding, consult_cloud, implement, fix, feature, architecture, plan, complex, analyze, analysis, explain, accuracy, accurate, verify, fact check, deep dive, compare, tradeoff, tradeoffs, synthesis, urgent, wrong, mistake, incorrect, error, failed, failure, exception, http, api, endpoint, request, status, 401, 403, 404, 500, 501
---
# SKILL: In-Process Coding & Automatic Gear Transmission
- **Automatic Transmission**: Planning (`/plan`, initial codebase reconnaissance, and post-strike re-planning) and error recovery always run on the Deep Cloud model (`2nd`), steady cruising edits can use Fast (`1st`), and casual chat stays Local (`Park`).
- **Read First (`read_band`)**: Inspect real files with `list_dir`, `grep_search`, and `read_file` before editing.
- **Edit & Verify (`write_band`)**: Patch exact unique lines with `edit_file(path, target, replacement)`, create files with `write_file(path, content)`, and run targeted tests with `run_command(command)` (bash everywhere — Git Bash on Windows; use forward-slash paths). Switch workspace root via `set_working_folder(path)`.
- **2-Strike Rule**: After 2 consecutive failures on the same error or target, write tools disengage for 1 mandatory read-only step - inspect the target file, state a 2-sentence root-cause hypothesis, and pivot. Never repeat the same failing edit or command.
- **`/plan` Mode**: Keep edits disabled and present a concise plan inside a ```` ```sanctuary-plan ```` fenced block.
- **Isolated Worktree (Optional)**: Only use `delegate_coding(task, isolate=True)` when the user explicitly asks for an isolated git worktree branch.
- **Debugging Protocol (errors the user reports)**:
  1. Get the exact error text and where it appears; `grep_search` that literal (and the alert title) to find the throwing call site.
  2. Trace the call chain to the outgoing request: which host, endpoint, method, headers, and token it uses. Compare sibling functions - inconsistencies between paths that should match are prime suspects.
  3. Reproduce with `http_probe` against the same host/endpoint (unauthenticated) and read the status: 501 = that host does not implement the method (wrong server), 401 = token missing/wrong audience, 400 = bad params or token scope, 404 = wrong path/record.
  4. State a 2-sentence root-cause hypothesis backed by the evidence, then fix it and run the relevant tests (`node --test __tests__/<file>.test.js`, `.venv/Scripts/python.exe -m unittest ...` on Windows or `.venv/bin/python -m unittest ...` on Linux).
  5. If the evidence needs the user's authenticated session, ask the user for the exact error dialog text (it now includes the HTTP status and host) instead of guessing.
- **Plan Persistence (`update_plan_step`)**: When `# ACTIVE IMPLEMENTATION PLAN` is shown, call `update_plan_step(step=N, status="in_progress")` when starting a step and `update_plan_step(step=N, status="done", note="...")` only after its verification command passes. On follow-up turns ("continue"), resume from the first unfinished step.
- **Test Grounding (Mandatory)**: Never invent DOM selectors, store methods, or mock helpers. Before writing or editing any test, `read_file` an existing passing test for the same module (and `__mocks__/mockDom.js` for frontend tests) plus the target module's actual selectors/exports, then run the test via `run_command` and confirm exit 0.
