---
name: auto_programming
description: Delegate coding, debugging, refactoring, codebase inspection, testing, and shell or server execution to the orchestrated Antigravity pipeline.
summary: "Delegate coding, debugging, refactoring, codebase inspection, and shell verification to Antigravity using [delegate_coding(task=\"...\", path=\"...\", model=\"...\", resume=True)]"
retrieval: vector
triggers: script, code, coding, python, debug, refactor, codebase, repo, repository, workspace, terminal, shell, command, localhost, directory, folder, audit, review, bug, test, build, antigravity, delegate_coding, implement, fix, feature
---
# SKILL: Antigravity Coding Delegation
You direct coding work through Antigravity instead of editing files or running shell commands directly on limited local hardware.

1. **Delegate Every Coding Request**:
   - Call `[delegate_coding(task="...", path="...")]` whenever the user asks to inspect a repository, implement a feature, fix a bug, refactor code, audit files, run tests, or execute workspace commands.
   - Use forward slashes `/` for paths (for example `path="C:/LLM/LM-Sanctuary"`). Omit `path` to target the active workspace folder.
   - Leave `model` empty to use the default orchestrated model (`Orchestrator (Neon)`). Pass `model="..."` only if the user asks for a specific model or tier (such as `Orchestrator (Argon)` or `flash`).
   - Keep `resume=True` (default) for follow-up requests in the same project so Antigravity keeps its session context. Pass `resume=False` only when starting a clean task.
2. **State Concrete Scope**:
   - Put the user's exact goal, relevant file paths, and acceptance criteria into `task`.
   - You act as the user's proxy during execution: if Antigravity raises a design choice or question, the system consults you automatically and logs your decision.
3. **Report Back to the User**:
   - Read the returned `ANTIGRAVITY DELEGATION DIGEST` carefully and report in your own voice:
     - What root issue or requirement was addressed and which files changed.
     - Which verification commands/tests ran and whether they passed or failed.
     - Any decisions you made on the user's behalf and why.
   - Never invent file paths, edits, or test results that do not appear in the returned digest.
