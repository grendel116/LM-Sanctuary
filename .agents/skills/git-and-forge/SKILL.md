---
name: git-and-forge
title: Git & Cooperative Code Forges
description: Safe local git operations and remote forge workflows across GitHub (gh) and Forgejo/Codeberg/Gitea (tea / REST) with explicit user confirmation.
triggers: [git, commit, branch, pull request, pr, merge, github, gh, codeberg, forgejo, gitea, tea, push, diff]
---
# Git & Cooperative Code Forges

Follow disciplined version-control and forge practices across local `git`, GitHub (`gh`), and worker-coop / open-source forges such as Codeberg and Forgejo (`tea` CLI or Forgejo `/api/v1`):

## 1. Local Git Discipline
- Inspect `git status` and `git diff` before staging. Stage explicit file paths (`git add <file>`) rather than blind `git add -A` so scratch files, `.env`, secrets, or runtime `databank.json` / `quest_log.json` state are never committed.
- Never run destructive history commands (`git reset --hard`, `git push --force`, `git clean -fdx`) unless explicitly requested by the user.

## 2. Remote Mutations Require Confirmation
- Read-only forge commands (`gh pr view`, `gh issue list`, `tea pr list`, `git log`, `git fetch`) are safe at any time.
- Remote-mutating commands (`git push`, `gh pr create`, `gh issue create`, `tea pr create`, merging PRs, deleting branches) must always explain the target remote/branch and respect Sanctuary's Human-in-the-Loop confirmation gate.

## 3. Worker-Coop & Open-Source Forges (Forgejo / Codeberg)
- Check `git remote -v` first instead of assuming GitHub.
- For `codeberg.org` or self-hosted Forgejo/Gitea remotes, prefer `tea` CLI if installed or standard Forgejo REST (`$FORGE_ORIGIN/api/v1/repos/<owner>/<repo>/pulls` using `FORGEJO_TOKEN` / `CODEBERG_TOKEN`), and use `gh` for `github.com`.
