---
name: auto_programming
title: In-Process OpenHands Coding & Automatic Gear Transmission
description: Inspect, edit, and verify workspace repositories using the in-process OpenHands + Git Bash harness with automatic gear-shifting across Local Park, Cloud Web/Chat, and OpenHands Coding.
summary: "In-process OpenHands tools: file_editor, grep, glob, terminal (Git Bash), web_search, read_webpage, http_probe, update_plan_step, task (researcher/implementer/verifier), ask_user, finish; optional isolated worktree: [delegate_coding(task=\"...\", isolate=True)]."
retrieval: vector
triggers: script, code, coding, python, javascript, debug, refactor, codebase, repo, repository, workspace, terminal, shell, command, localhost, directory, folder, audit, review, bug, test, build, openhands, cloud, subagent, delegate_coding, consult_cloud, implement, fix, feature, architecture, plan, complex, analyze, analysis, explain, accuracy, accurate, verify, fact check, deep dive, compare, tradeoff, tradeoffs, synthesis, urgent, wrong, mistake, incorrect, error, failed, failure, exception, http, api, endpoint, request, status, 401, 403, 404, 500, 501
---
# SKILL: In-Process OpenHands Coding & Automatic Gear Transmission
- **Single In-Process Harness**: Coding and `/plan` turns shift directly to `gear="openhands"` (`sanctuary/core/openhands_harness.py`), running OpenHands `Conversation` in-process with your persona, `LLMSummarizingCondenser`, `stuck_detection=True`, and Git Bash `terminal`.
- **Read & Trace First**: Inspect real files with `file_editor` (`view`), `grep`, `glob`, and `web_search`/`read_webpage` before editing.
- **Edit & Verify**: Apply minimal, consolidated edits with `file_editor` and run targeted tests with `terminal` (Git Bash everywhere; forward-slash paths; Python `.venv/Scripts/python.exe` on Windows or `.venv/bin/python` on Linux; JS `node --test __tests__/<file>.test.js`).
- **`/plan` Mode**: Mutations are blocked (`reject_pending_actions`); present a concise plan inside a ```` ```sanctuary-plan ```` fenced block and call `finish`.
- **Isolated Worktree (Optional)**: Only use `delegate_coding(task, isolate=True)` when the user explicitly asks for an isolated git worktree branch.
- **Plan Persistence (`update_plan_step`)**: When `# ACTIVE IMPLEMENTATION PLAN` is shown, call `update_plan_step(step=N, status="in_progress")` when starting a step and `update_plan_step(step=N, status="done", note="...")` only after its verification command passes.
