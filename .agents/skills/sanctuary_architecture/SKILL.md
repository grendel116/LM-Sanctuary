---
name: sanctuary-architecture
title: LM-Sanctuary Architecture & Customizations
description: Core architectural map, Root Code Focus rules, OpenAI-compatible /v1 compliance, and skill/subagent conventions for LM-Sanctuary.
triggers: sanctuary, cloud, skill.md, databank, runner.py, openhands_job, MessageRow, programThread
---
# LM-Sanctuary Architecture Guide

Ground every engineering decision in Sanctuary's concrete modules and strict code minimalism:

## 1. Governing Directives
- **Root Code Focus**: Read exact source definitions and data layouts before editing. Never guess imports, signatures, or DOM structures.
- **Rejection of Churn**: Replace obsolete or duplicated code rather than wrapping it. Keep modules consolidated and dependency-free where possible.
- **Vault-First Sensitive Data Rule**: All sensitive data (credentials, API keys, social tokens, chat sessions, `journals.json`, `quest_log.json`, `databank.json`, private bookmarks/drafts) MUST go through the encrypted vault (`keepassxc_client.py` / `social_vault.py` / `session_data.py`). Never cache plaintext chat/secrets in browser IndexedDB in `.kdbx` mode, and always fail closed (`VaultLockedError` -> `503`, empty chat view, disabled social post actions) while locked.
- **Cross-Platform Shell**: Prefer portable commands and forward-slash paths. Sanctuary's `run_command` uses bash (Git Bash on Windows); OpenHands' terminal is PowerShell on Windows (use `;` there). Python: `.venv/Scripts/python.exe` (Windows) or `.venv/bin/python` (Linux).

## 2. Key Subsystems
- **3-Gear Continuum**:
  - Gear 1 (Local GGUF): `sanctuary/runners/runner.py` + `sanctuary/adapters/history_adapters.py`
  - Gear 2 (Cloud `/v1` Endpoint): `sanctuary/core/greenpt_client.py` (`websearch`, `scrape_markdown`, `convert_document`, `rerank`, `sync_skill`, `chat_completion`) + `consult_cloud` in `sanctuary/tools/tools.py`
  - Gear 3 (In-Process OpenHands + Git Bash Coding): `sanctuary/core/openhands_harness.py` (`GitBashTerminalTool`, `FileEditorTool`, `GrepTool`, `GlobTool`, `LLMSummarizingCondenser`, `stuck_detection=True`, subagents)
- **Skills & Subagents**:
  - Companion skills (`sanctuary/core/skills/*/SKILL.md`): Indexed by `sanctuary/core/skill_retriever.py` and synced lazily to `/v1/skills` when supported. Must keep `name` (`[a-z0-9-_]`), `title`, and `description` (`<= 500` chars).
  - Engineering skills (`.agents/skills/*/SKILL.md`) & custom subagents (`.agents/agents/*.md`): Auto-loaded by OpenHands `AgentContext(load_project_skills=True)`.
- **Frontend (`web/`) & Tests (`__tests__/`)**:
  - Vanilla ES modules (`web/app/browser.js`, `web/state/browserStore.js`, `web/app/feed.js`, `web/queries/feedHarvester.js`, `web/components/sanctuary/MessageRow.js`, `ToolApprovalCard.js`, `SettingsModal.js`, `web/app/programThread.js`, `web/assets/css/shell.css`, `sanctuary.css`).
  - Embedded Gecko/Sval desktop browser host: `browser-desktop/`.
  - Backend Flask routes: `sanctuary/routes/` (`system.py`, `chat.py`, `browser_vault.py`, `programs.py`, `social_bridge.py`).
  - Verify backend changes with `.venv/Scripts/python.exe __tests__/backend/test_*.py` (or `.venv/bin/python` on Linux) and frontend changes with `node --test __tests__/*.test.js`.
