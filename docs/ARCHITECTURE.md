# LM-Sanctuary Architecture

`LM-Sanctuary` combines a pure-static, 3-column Fediverse-first client (`web/`) with an optional local companion AI node (`sanctuary/`), styled in LM-Sanctuary's dark obsidian-and-glass palette (`#121214`, `rgba(22, 22, 26, 0.85)`, `--primary-accent: #9370db` / active Program `theme.json`). Both desktop launches (`sanctuary/desktop.py` / `sanctuary/app.py`), standalone PWA hosting, and Capacitor Android packaging (`capacitor.config.ts`) serve the same unmodified `web/` directory.

## 1. Repository Symmetry (`web/` + `sanctuary/`)

- **`web/` — Pure-Static 3-Column Client (zero bundler, zero Jinja templating, zero external JS runtime dependencies):**
  - `web/index.html`, `web/manifest.json`, `web/sw.js`
  - `web/app/` — Top-level shell and views: `_layout.js` (left icon rail + center social stage + persistent right Sanctuary dock), `feed.js`, `search.js`, `composeModal.js`, `messages.js` (`Direct | Programs`), `activity.js`, `postThread.js`, `programThread.js`
  - `web/components/ui/` — Shared primitives (`Button.js`, `Pill.js`, `Card.js`, `ModalShell.js`, `SwipeSheet.js`, `index.js`)
  - `web/components/` — Social primitives (`PostCard.js`, `ContentWarning.js`, `MediaAttachment.js`, `OfflineNotice.js`, `PullToRefresh.js`, `SearchInput.js`, `FediverseShareButton.js`)
  - `web/components/sanctuary/` — Classic obsidian-and-glass companion modules (`SanctuaryDialog.js`, `UserModal.js`, `ProgramModals.js`, `SettingsModal.js`, `KnowledgeModal.js`, `QuestModal.js`, `MessageRow.js`, `PortraitGrid.js`, `ToolApprovalCard.js`, `MoodHeart.js`, `VoiceCallOverlay.js`)
  - `web/queries/` — Protocol clients (`fediverse.js`, `bluesky.js`, `threads.js`, `sanctuary.js`) built atop `web/queries/fetch/{FetchError.js, fetchWrapper.js}` with one merged `AbortController` (`AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`)
  - `web/state/` — Reactive store (`store.js`), social slices (`authStore.js`, `feedStore.js`, `composeStore.js`), and companion slices (`web/state/sanctuary/{types.js, connection.js, outboxModel.js, sessionModel.js}`)
  - `web/storage/kvStorage.js` — 8-store IndexedDB (`sanctuary_pwa_db`) + non-extractable 256-bit Web Crypto `AES-GCM` vault for social credentials + Node test memory fallback
  - `web/constants/` — Transport rules (`endpoints.js`) and scoped/root Program palettes (`theme.js`)
  - `web/assets/` — `css/`, `img/`, and `vendor/`
- **`sanctuary/` — Self-Contained Local AI Node:**
  - `sanctuary/app.py`, `sanctuary/state.py`, `sanctuary/desktop.py`, `sanctuary/setup_env.py`
  - `sanctuary/routes/` — Flask Blueprints (`health.py`, `chat.py`, `media.py`, `programs.py`, `knowledge.py`, `voice.py`, `system.py`)
  - `sanctuary/{core, runners, tools, adapters, models, utils, variables, templates/splash.html}`
- **Packaging, Scripts, Tests & Docs:**
  - `capacitor.config.ts`, `android/app/src/main/res/xml/network_security_config.xml`
  - `scripts/buildAndroid.js`
  - `__tests__/` (`node --test __tests__/*.test.js` + `__tests__/backend/test_sanctuary_node.py`)
  - `docs/ARCHITECTURE.md`

## 2. 3-Column Shell, Organic Publishing & Client-Side Vault

1. **Instant Boot & Persistent Companion Dock**:
   - `web/app/_layout.js` boots directly into the shell without waiting on `sanctuary/`.
   - Desktop renders a 68px left icon rail (`Home`, `Search`, `Messages`, `Activity`, `User`, `Settings`, and bottom `+` Compose), a hairline center social column (`feed.js` with inline `"What's new?"` bar, `search.js`, `messages.js` with `Direct | Programs`, `activity.js`), and a permanently mounted right Sanctuary dock (`programThread.js`) so social browsing never interrupts AI turns, media streaming, or voice calls.
   - Mobile displays a 5-tab bottom bar (`Home`, `Search`, `Messages`, `Activity`, `Sanctuary`) with compact top-bar triggers for `User`, `Settings`, and `+` Compose.
2. **Protocols & Organic Composer**:
   - **ActivityPub (`Mastodon`, `Pixelfed`, `GoToSocial`, `Akkoma`)** via OAuth2 + REST is the primary social layer.
   - **AT Protocol (`Bluesky`)** and **Headless Threads Publishing (`graph.threads.net`)** are signed in under **User -> Accounts** (`UserModal.js`); top-level posts from `composeModal.js` or `feed.js`'s inline bar publish organically across all signed-in accounts without per-post toggles, while replies target the post's origin network.
3. **Zero AI Social Dispatch**:
   - `sanctuary/` holds zero social credentials, zero social adapters, and zero AI social-posting or timeline-reading tools.
   - OAuth tokens and app passwords stay exclusively inside the browser/WebView `AES-GCM` `social_vault` in `web/storage/kvStorage.js`.

## 3. User-Bubble Share-to-Fediverse Flow

On Program threads (`web/app/programThread.js` + `web/components/sanctuary/MessageRow.js`):
- Program bubbles (`role === 'program'`) render `.speak-btn` (Kokoro TTS / Web Speech fallback) in the 4th trailing `.message-actions` slot.
- User bubbles (`role === 'user'`) render `FediverseShareButton.js` (`.action-icon-btn.fediverse-share-btn`) in that same 4th trailing slot, calling `prefillFromUserBubble()` in `web/state/composeStore.js` and opening `web/app/composeModal.js` with the user's raw draft text and turn media ready for user-initiated posting.

## 4. Sanctuary Node Lifecycle, Outbox & Media Hosting

1. **Dormant by Default**:
   - Standalone installs (`!sanctuary_node_url` on public origins or Capacitor APK) stay in `status: 'dormant'` with zero background polling.
   - Local Flask/desktop launches auto-activate same-origin polling; LAN/Tailscale installs activate once `sanctuary_node_url` is saved under **Settings -> Node**.
2. **Offline Outbox Replay**:
   - When a configured Sanctuary node is offline over LAN or Tailscale, social views remain functional while Program threads serve cached IndexedDB transcripts (`sessionModel.js`) and enqueue outgoing turns into `outbox_queue` (`outboxModel.js`) with stable client `usr_*` `msg_id` values.
   - On `sanctuary:online`, an exclusive FIFO flush submits queued turns with matching `msg_id`s, deduplicated idempotently by `_upsert_history_message` in `sanctuary/adapters/history_adapters.py`.
3. **Preserved Local Infrastructure**:
   - Mutual exclusion between LLM inference (`llama-server`) and ComfyUI diffusion workflows (`sanctuary/adapters/vram_orchestrator.py`), synchronous `RLock` + async per-session locks (`sanctuary/runners/runner.py`), workspace/code/memory/quest/music tools (`sanctuary/tools/tools.py`), HITL tool approval cards, Kokoro/Whisper voice calls, SillyTavern PNG/`chara_card_v3` cards, and World Info lorebooks remain intact inside `sanctuary/`.

## 5. PWA Service Worker & Android Packaging

- **Service Worker (`web/sw.js`)**: Precaches `APP_SHELL_ASSETS` and bypasses non-`GET` requests, `text/event-stream` / `application/x-ndjson` streams, opaque `"null"` or cross-origin URLs, and same-origin dynamic Flask routes (`/api/`, `/v1/`, `/images/`, `/programs/`, `/speech_cache/`, `/chat`, etc.).
- **Capacitor & Transport Security**:
  - `capacitor.config.ts` targets `webDir: 'web'`, `androidScheme: 'https'`, and `CapacitorHttp: { enabled: true }`.
  - `android/app/src/main/res/xml/network_security_config.xml` enables cleartext HTTP in `<base-config>` for LAN, `.local`, and Tailscale CGNAT companion nodes while pinning public social endpoints to HTTPS in `web/constants/endpoints.js`.
- **Verification Commands**:
  - Frontend tests: `npm test` (`node --test __tests__/*.test.js`)
  - Backend tests: `.\.venv\Scripts\python.exe __tests__\backend\test_sanctuary_node.py`
  - Android bundle check: `node scripts/buildAndroid.js --verify-only`
