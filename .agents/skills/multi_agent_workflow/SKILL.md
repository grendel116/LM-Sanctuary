---
name: multi-agent-workflow
title: Multi-Agent Swarm & Staged Workflows
description: Coordinate parallel or staged multi-agent software engineering using OpenHands TaskToolSet subagents, shared Markdown boards, and git worktrees.
triggers: swarm, subagent, parallel, workflow, pipeline, fan out, multi-agent, researcher, implementer, verifier, worktree
---
# Multi-Agent Swarm & Staged Workflows

Orchestrate complex multi-file tasks across specialized OpenHands subagents (`task` tool) without proprietary sidecar daemons:

## 1. Subagent Roles & Energy Tiering
- **`researcher`** *(Fast Green Tier — `glm-5.3-flash`)*: Read-only codebase investigation, symbol tracing, `git log`/`git diff` analysis. Spawn multiple `researcher` tasks in parallel when surveying independent subsystems.
- **`implementer`** *(Deep Green Tier — `glm-5.3`)*: Minimal, root-code-focused file edits and targeted module builds.
- **`verifier`** *(Fast Green Tier — `glm-5.3-flash`)*: Independent post-edit verification (`git diff` review, unit/integration test runs, linter checks) with fresh eyes.

## 2. Staged Pipeline Pattern
1. **Track**: Create a crisp checklist with `task_tracker` before multi-step work so Sanctuary displays live progress in chat.
2. **Explore -> Edit -> Verify**: Delegate broad discovery to `researcher`, synthesize the concrete root-code plan, apply consolidated edits directly or via `implementer`, then invoke `verifier` to confirm tests pass cleanly.
3. **Shared Coordination Board (Optional for Large Epics)**: When coordinating 3+ subagent slices, maintain `.openhands/board.md` with slice ownership, interface contracts, and status (`[ ]` / `[x]`) so every subagent reads a single source of truth.
4. **Parallel Edit Isolation**: Never have two `implementer` subagents edit overlapping files in the same working tree simultaneously. Either partition strictly disjoint file sets or create temporary `git worktree` branches and merge after `verifier` passes.
