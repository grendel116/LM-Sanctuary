---
name: Code
description: Building code.
argument-hint: Fix, edit, revise, code.
# tools: ['vscode', 'execute', 'read', 'agent', 'edit', 'search', 'web', 'todo'] # specify the tools this agent can use. If not set, all enabled tools are allowed.
---

<!-- Tip: Use /create-agent in chat to generate content with agent assistance -->
<rules>
# Directives

1. **Root code:** ground decisions in actual structures, memory, and data flow.
   No speculative abstraction. Analyse the real condition before acting.

2. **No pathetic building:** user value over velocity. Every change names what it
   REPLACES and what it DELETES; adding a path without removing the old one is
   incomplete. Fallbacks exist only as diagnosis. Nothing needs to fall back.

3. **Lifetime first:** state who calls it and which inputs are guaranteed or
   rejected. No scaffolding, TODOs, parallel v1/v2, or flags without a removal date.

4. **Regex:** only for closed grammars, pinned by a test. Open or messy input is
   parsed structurally or rejected loudly—never absorbed by regex.

5. **Fail loud:** raise a located error. Silent recovery is a bug.

6. **Simplicity:** one concept, one implementation, one entry point. Prefer a
   shrinking diff.
</rules>


# LM-Sanctuary Agent Context

## Recovery precedent (2026-11-23)
- `git checkout -- <file>` destroys uncommitted work; the repo routinely carries large uncommitted deltas, so never use it for baseline test comparisons. Re-test by other means (isolate one file) instead.
- If `web/app/programThread.js` is ever corrupted again: the Firefox cache2 profile at `gecko_profile/cache2/entries/` holds full-size copies of `web/app/*.js` (body at byte 0, length encoded in the ETag, e.g. `47622-1623986268` = first 47622 bytes are the file). Same trick works for `webview_data/EBWebView/Default/Service Worker/CacheStorage/**`.

## Tests
- Frontend: `node --test __tests__/*.test.js` (npm.ps1 is blocked by execution policy; invoke `node --test` directly).
- Use `--test-reporter=tap` when parsing results; default reporter symbols can garble under console encoding.
- Some suites fail on mock-DOM globals when run in parallel; rerun a single file for isolation.

## Known pre-existing frontend failures (not actionable, baseline as of 2026-11)
- `standingFixes.test.js`: 4 failures (programThread in-place edit, contextful replies, blank-slate feed reset, feed snapshot lock).
- `browserDesktopHost.test.js`: 1 failure (deriveAccentTokens suite).
- `browserWorkspace.test.js`: 1 failure (Browser stage suite).
- `sanctuaryCompanionFixes.test.js`: 1 failure (programThread stop/cancel flow).

## Program chat composer (`web/app/programThread.js`)
- Attachment state lifecycle: `attachedMediaPath` / `attachedMime` / `attachedFilename` (+ `attachedSharedPost`) → `submitTurn()` forwards as `media_path` / `image_mime` to POST `/chat`; offline turns go through `enqueueTurn` (outboxModel accepts `mediaPath` or raw `imageData`).
- Image capture paths: file input (`change`) and clipboard paste (`paste` listener) both converge on `/upload_media` (multipart FormData via `uploadSanctuaryMedia`), returning `{ file_path: '/images/uploads/...' }`.
- Backend consumes `image_data` (base64 string) + `image_mime` directly in `sanctuary/routes/chat.py` → `history_adapters.py` builds `data:{mime};base64,{data}` URLs.

## Sensitive Data & Vault Security Rule (Mandatory)
- **Put all sensitive data in the vault**: All credentials, social OAuth/session tokens, API keys (`GREENPT_API_KEY`, etc.), private bookmarks, post drafts, chat session histories (`sessions/*.json`), personal journals (`journals.json`), quests (`quest_log.json`), and private databank documents (`databank.json`) MUST be stored encrypted via Sanctuary's vault (`sanctuary/utils/keepassxc_client.py` / `social_vault.py` / `session_data.py`).
- **No plaintext fallback or cache leaks**: Never store secrets in `.env` or `project_settings.json` when the `.kdbx` vault is active, never cache plaintext chat/journal/secret data in browser IndexedDB (`web/storage/nativeStore.js`) when `.kdbx` mode is enabled, and always fail closed (`VaultLockedError` -> HTTP `503 {"locked": true}`, empty chat view with disabled composer, and disabled/grayed-out social post actions) until the vault is unlocked.