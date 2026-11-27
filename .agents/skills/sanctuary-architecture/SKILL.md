---
name: sanctuary-architecture
title: LM-Sanctuary Architecture & Customizations
description: Core architectural map, Root Code Focus rules, OpenAI-compatible /v1 compliance, and skill/subagent conventions for LM-Sanctuary.
---
# LM-Sanctuary Architecture Guide

## Key Subsystems
- **3-Gear Continuum**:
  - Gear 1 (Local GGUF): `sanctuary/runners/runner.py` + `sanctuary/adapters/history_adapters.py`
  - Gear 2 (Cloud `/v1` Endpoint): `sanctuary/core/v1_client.py` + `sanctuary/core/transmission.py` (`websearch`, `scrape_markdown`, `convert_document`, `rerank`, `sync_skill`, `chat_completion`) + `consult_cloud` in `sanctuary/tools/tools.py`
  - Gear 3 (In-Process OpenHands + Git Bash Coding): `sanctuary/core/openhands_harness.py` (`GitBashTerminalTool`, `FileEditorTool`, `GrepTool`, `GlobTool`, `LLMSummarizingCondenser`, `stuck_detection=True`, subagents)
- **Skills & Subagents**:
  - Companion skills (`sanctuary/core/skills/*/SKILL.md`): Indexed by `sanctuary/core/skill_retriever.py` and synced lazily to `/v1/skills` when supported. Must keep `name` (`[a-z0-9-_]`), `title`, and `description` (`<= 500` chars).
  - Engineering skills (`.agents/skills/*/SKILL.md`) & custom subagents (`.agents/agents/*.md`): Auto-loaded by OpenHands `AgentContext(load_project_skills=True)`.
- **Frontend (`web/`) & Tests (`__tests__/`)**:
  - Vanilla ES modules (`web/app/browser.js`, `web/state/browserStore.js`, `web/app/feed.js`, `web/queries/feedHarvester.js`, `web/components/sanctuary/MessageRow.js`, `ToolApprovalCard.js`, `SettingsModal.js`, `web/app/programThread.js`, `web/assets/css/shell.css`, `sanctuary.css`).
  - Embedded Gecko/Sval desktop browser host: `browser-desktop/`.
  - Backend Flask routes: `sanctuary/routes/` (`system.py`, `chat.py`, `browser_vault.py`, `programs.py`, `social_bridge.py`).
  - Verify backend changes with `.venv/Scripts/python.exe __tests__/backend/test_*.py` (or `.venv/bin/python` on Linux) and frontend changes with `node --test __tests__/*.test.js`.
