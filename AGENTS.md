# LM-Sanctuary Workspace Guardrails

Always-active engineering and repository boundaries for transforming `LM-Sanctuary` into a Mastodon-first native client (`web/` + `social/` + Android native SQLite/Keystore) paired with a modular local Sanctuary AI node (`sanctuary/`).

## 1. Repository Layout

- **`web/`** — Pure-static SPA served unmodified by Flask (`sanctuary/app.py`), `sanctuary/desktop.py`, browser PWA, and Capacitor Android (`webDir: "web"`):
  - `web/index.html`, `web/manifest.json`, `web/sw.js` (zero Jinja templating, zero bundler, zero IndexedDB).
  - `web/app/` — 1:1 route screens and 3-column desktop shell (`_layout.js`, `feed.js`, `search.js`, `composeModal.js`, `messages.js`, `activity.js`, `profile.js`, `postThread.js`, `programThread.js`).
  - `web/core/` (`schema/unifiedItem.js`, `feedRanker.js`) & `web/adapters/` (`base.js`, `mastodon/index.js`, `bluesky/index.js`, `threads/index.js`) — Symmetric client `UnifiedItem` schema, local transparent feed re-ranker, & protocol adapters for standalone Capacitor Android.
  - `web/components/` — Reusable UI primitives under `web/components/ui/` (`Button.js`, `Pill.js`, `Card.js`, `ModalShell.js`, `SwipeSheet.js`, `index.js`), single-purpose social components (`PostCard.js`, `FeedTuningModal.js`, `AuthorSheetModal.js`, `ContentWarning.js`, `MediaAttachment.js`, `OfflineNotice.js`, `PullToRefresh.js`, `SearchInput.js`, `FediverseShareButton.js`), and companion UI modules under `web/components/sanctuary/` (`SanctuaryDialog.js`, `UserModal.js`, `ProgramModals.js`, `SettingsModal.js`, `KnowledgeModal.js`, `QuestModal.js`, `MessageRow.js`, `PortraitGrid.js`, `ToolApprovalCard.js`, `VoiceCallOverlay.js`, `MoodHeart.js`). Keep modules small and focused; never re-create monolithic view scripts.
  - `web/queries/` — Protocol clients (`socialClient.js`, `fediverse.js`, `bluesky.js`, `threads.js`, `sanctuary.js`) built over `web/queries/fetch/{FetchError.js, fetchWrapper.js}` with one merged `AbortController` per request (caller signal + timeout).
  - `web/state/` — Lightweight reactive store (`store.js`: `get`, `set`, `subscribe`, `Object.is` slice selectors) + domain slices (`authStore.js`, `feedStore.js`, `composeStore.js`, `web/state/sanctuary/{connection.js, sessionModel.js, outboxModel.js, types.js}`).
  - `web/storage/` (`nativeStore.js` routing to `/api/social/*` local SQLite + OS Keychain on Desktop or `SanctuaryNativeStorePlugin` on Android; `kvStorage.js` compatibility facade — zero `indexedDB`), `web/constants/` (`endpoints.js`, `theme.js`), and `web/assets/` (`css/`, `img/`, `vendor/`).
- **`social/`** — Local-first Mastodon & automatic bridge client subsystem (Desktop & LAN host on `127.0.0.1`):
  - `social/core/schema/unified_item.py` (`UnifiedItem` normalization, sanitization, Bridgy/Threads canonical deduplication).
  - `social/adapters/{base.py, mastodon/{adapter.py, streaming.py}, bluesky/adapter.py, threads/adapter.py}` (symmetric `SocialAdapter` implementations).
  - `social/storage/{sqlite_store.py, keychain.py}` (disk SQLite WAL database `social/data/social.db` + Win32 Credential Manager / macOS Keychain / Linux secret-tool / encrypted fallback vault).
  - `social/sync_engine.py` & `social/routes.py` (`/api/social/*` Flask Blueprint mounted on `sanctuary/app.py`).
- **`android/`** — Capacitor Android native configuration & `SanctuaryNativeStorePlugin.java` (`SQLiteOpenHelper` + `AndroidKeyStore` AES-GCM vault).
- **`sanctuary/`** — Self-contained local AI companion node:
  - `sanctuary/app.py`, `sanctuary/state.py`, `sanctuary/desktop.py`, `sanctuary/setup_env.py`, and `sanctuary/routes/` Flask Blueprints (`health.py`, `chat.py`, `media.py`, `programs.py`, `knowledge.py`, `voice.py`).
  - `sanctuary/{core, runners, tools, adapters, models, utils, variables, templates/splash.html}`.
  - Keep `.venv/` at repository root so root launchers (`run_local.ps1`, `run_local.bat`, `run_local.sh`, `Dockerfile`) keep working without recreating virtual environments.
- **Root Tooling & Verification**: `__tests__/` (`node --test` + `__tests__/backend/`), `__mocks__/`, `scripts/`, `docs/`, `capacitor.config.ts`, `package.json`, `requirements.txt`.

## 2. Zero AI Social Dispatch, Credential Isolation & Preserved Local Engines

1. **No AI Social Tools or Program Credential Access**:
   - AI Programs must **not** hold social publishing, timeline-reading, or social credential tools. Do **not** create `sanctuary/tools/social_dispatch.py`, `sanctuary/core/skills/social_dispatch/`, `sanctuary/adapters/threads_adapter.py`, `sanctuary/adapters/fediverse_adapter.py`, or `sanctuary/variables/social_accounts.json`.
   - `sanctuary/runners/` and `sanctuary/tools/` must **never** import `social/` or read social credentials. All social OAuth tokens and bridge secrets remain exclusively in OS Credential Manager / Keychain (`social/storage/keychain.py`) on Desktop or `AndroidKeyStore` (`SanctuaryNativeStorePlugin.java`) on Android.
   - Programs identify the user directly from a token-free public Mastodon profile Markdown snapshot written to `sanctuary/variables/user_profiles/mastodon_<username>.md`.
   - Programs may tune the local feed re-ranker without approval prompts via `[tune_feed_algorithm(...)]` (`sanctuary/core/skills/feed_tuning/SKILL.md`, `sanctuary/core/feed_tuning.py`), which only reads/writes the token-free, timeline-free declarative weighting file `sanctuary/variables/feed_profile.json` synced via `/api/feed_profile`.

2. **Preserve GPU, VRAM, Runner & Tool Infrastructure**:
   - Preserve GPU auto-detection, `llama-server` lifecycle (`sanctuary/runners/local_server.py`), and VRAM mutual exclusion between Text Mode (`LLM`) and Image Mode (`IMG`) in `sanctuary/adapters/vram_orchestrator.py`, `sanctuary/core/engine_diffusion.py`, and `sanctuary/core/comfy_engine/`.
   - Preserve `OpenSourceRunner` concurrency and persistence invariants in `sanctuary/runners/runner.py` and `sanctuary/adapters/history_adapters.py`: synchronous `threading.RLock()` (`_lock`), per-session `_async_session_locks` (`wait_session_idle`), ref-counted `generating_sessions`, `_upsert_history_message` deduplication, atomic `.tmp` + `os.replace` writes, and transactional `edit_turn` rollback.
   - Preserve all 15 workspace, code intelligence, shell, and async task tools, research/memory/quest tools (`journals.json`, `.ics` VALARM export, `web_search`, `read_webpage`, `search_music`), portrait/video generation, `confirm_tool_execution` approval gates, SillyTavern PNG/`chara_card_v3` JSON import/export, World Info lorebooks, Story Mode, Temperature control, Character Accent Palette CSS variables, Kokoro/Whisper voice calls, and `.thought-row` idle monologues.
   - Only path anchoring required by the `sanctuary/` relocation (`REPO_ROOT`, `WEB_DIR`, `COMFYUI_DIR`, `PROGRAMS_DIR` in `_get_safe_local_path`, and `project_settings.json` folder path migration) and Mastodon public profile identification (`user_profiles/mastodon_<username>.md`) is allowed inside engine modules.
   - Never delete model weights (`sanctuary/models/`), workflows (`sanctuary/models/workflows/`), user profiles (`sanctuary/variables/user_profiles/`), lorebooks, or session files (`sanctuary/core/programs/*/sessions/*.json`).

## 3. Mastodon-First Client, User Page, User-Bubble Share & Transport Security

1. **Instant Mastodon-First Boot, Dedicated User Page & Companion Activation**:
   - `web/app/` boots directly into the Mastodon-first social client without waiting on `sanctuary/`.
   - Clicking the User icon opens `web/app/profile.js` to preview the user's public Mastodon profile, edit native Mastodon credentials (`PATCH /api/v1/accounts/update_credentials`), open `UserModal` (`Accounts & Bridges`), and manage own posts (`Posts`, `Replies`, `Media`, `Pinned`).
   - Activate the Sanctuary companion automatically on same-origin (`desktop.py` / Flask) or when `sanctuary_node_url` is configured under **Settings -> Node** (`sanctuary/routes/health.py` `GET /api/mobile/health` + `GET /api/config`); stay dormant with zero polling on unconfigured standalone installs.
   - Pass all Sanctuary API, SSE, and media URLs through `resolveNodeUrl(path)`.
   - Mastodon (`mastodon.social` default or any configurable ActivityPub instance via REST + `wss://<instance>/api/v1/streaming`) is primary; when Bluesky (AT Protocol) or Threads tokens are connected (`isBlueskyConnected`, `isThreadsConnected`), outbound publishing, synchronized deletion (`linked_posts`), and chronological notification merging operate automatically in the background using concurrent non-blocking fan-out.

2. **User-Authored Share-to-Fediverse Button**:
   - Render `FediverseShareButton.js` (`.action-icon-btn.fediverse-share-btn`) in the 4th trailing `.message-actions` slot of user bubbles (`role === 'user'`), opposite `.speak-btn` on Program bubbles (`role === 'program'`), opening `composeModal` pre-filled with that message's raw draft text and turn media.

3. **Native Offline Storage & Transport Security (Zero IndexedDB)**:
   - When a configured Sanctuary node is unreachable over LAN or Tailscale, social views stay functional using local SQLite cache (`social/data/social.db` or Android `SQLiteOpenHelper`) while Program threads render cached history and enqueue outgoing turns into SQLite `kv_store` (`outbox_queue`) with stable client `usr_*` IDs for ordered FIFO replay on `sanctuary:online`. Never use `indexedDB`.
   - Allow cleartext `http://` only for `localhost`, `127.0.0.1`, `.local`, `.ts.net`, RFC1918 subnets (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`), and Tailscale CGNAT (`100.64.0.0/10`); require `https://` for all Fediverse instances and public endpoints.

## 4. Engineering & Browser Standards

- Resolve root contradictions at the data schema, network contract, and DOM ownership level rather than post-hoc regex or substring patches (outside explicit logit suppression in `sanctuary/core/banned_words.py`).
- **Browser Support**: Target Baseline Widely Available web APIs (`<dialog>`, CSS custom properties, Web Crypto `AES-GCM`, `AbortSignal.timeout`, Service Worker, WebSocket); feature-detect Newly Available APIs with at most 20 lines of fallback and zero external runtime dependencies.
