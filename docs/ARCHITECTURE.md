# LM-Sanctuary Architecture

`LM-Sanctuary` combines a pure-static, 3-column Fediverse-first client (`web/`) with an optional local companion AI node (`sanctuary/`), styled in LM-Sanctuary's dark obsidian-and-glass palette (`#121214`, `rgba(22, 22, 26, 0.85)`, `--primary-accent: #9370db` / active Program `theme.json`). Both desktop launches (`sanctuary/desktop.py` / `sanctuary/app.py`), standalone PWA hosting, and Capacitor Android packaging (`capacitor.config.ts`) serve the same unmodified `web/` directory.

## 1. Repository Symmetry (`web/` + `sanctuary/`)

- **`web/` — Pure-Static 3-Column Client (zero bundler, zero Jinja templating, zero external JS runtime dependencies):**
  - `web/index.html`, `web/manifest.json`, `web/sw.js`
  - `web/app/` — Top-level shell and views: `_layout.js` (left icon rail + center social stage + persistent right Sanctuary dock), `feed.js`, `search.js`, `composeModal.js`, `messages.js` (`Direct | Programs`), `activity.js`, `postThread.js`, `programThread.js`
  - `web/components/ui/` — Shared primitives (`Button.js`, `Pill.js`, `Card.js`, `ModalShell.js`, `SwipeSheet.js`, `index.js`)
  - `web/components/` — Social primitives (`PostCard.js`, `ContentWarning.js`, `MediaAttachment.js`, `OfflineNotice.js`, `PullToRefresh.js`, `SearchInput.js`, `FediverseShareButton.js`)
  - `web/components/sanctuary/` — Classic obsidian-and-glass companion modules (`SanctuaryDialog.js`, `UserModal.js`, `ProgramModals.js`, `SettingsModal.js`, `KnowledgeModal.js`, `QuestModal.js`, `MessageRow.js`, `PortraitGrid.js`, `ToolApprovalCard.js`, `MoodHeart.js`, `VoiceCallOverlay.js`)
  - `web/queries/` — Protocol clients (`fediverse.js`, `bluesky.js`, `threads.js`, `socialClient.js`, `sanctuary.js`) built atop `web/queries/fetch/{FetchError.js, fetchWrapper.js}` with one merged `AbortController` (`AbortSignal.any([controller.signal, AbortSignal.timeout(ms)])`)
  - `web/state/` — Reactive store (`store.js`), social slices (`authStore.js`, `feedStore.js`, `composeStore.js`), and companion slices (`web/state/sanctuary/{types.js, connection.js, outboxModel.js, sessionModel.js}`)
  - `web/storage/nativeStore.js` (re-exported by `web/storage/kvStorage.js`) — Three-backend local store: Capacitor Android (`SanctuaryNativeStorePlugin`: SQLiteOpenHelper + `AndroidKeyStore`), Browser / Desktop WebView2 (IndexedDB `sanctuary_pwa_db` + non-extractable Web Crypto `AES-GCM` `social_vault`), and Node test in-memory fallback
  - `web/constants/` — Transport rules (`endpoints.js`) and scoped/root Program palettes (`theme.js`)
  - `web/assets/` — `css/`, `img/`, and `vendor/`
- **`sanctuary/` — Self-Contained Local AI Node:**
  - `sanctuary/app.py`, `sanctuary/state.py`, `sanctuary/desktop.py` (launches pywebview with `private_mode=False` and persistent `webview_data/` profile), `sanctuary/setup_env.py`
  - `sanctuary/routes/` — Flask Blueprints (`health.py`, `chat.py`, `media.py`, `programs.py`, `knowledge.py`, `voice.py`, `system.py`, `social_bridge.py`, `social_accounts.py`)
  - `sanctuary/{core, runners, tools, adapters, models, utils, variables, templates/splash.html}`
- **Packaging, Scripts, Tests & Docs:**
  - `capacitor.config.ts`, `android/app/src/main/res/xml/network_security_config.xml`
  - `scripts/buildAndroid.js`
  - `__tests__/` (`node --test __tests__/*.test.js` + `__tests__/backend/test_sanctuary_node.py` + `__tests__/backend/test_social_bridge.py`)
  - `docs/ARCHITECTURE.md`

## 2. 3-Column Shell, Single Social Stack & Client-Side Vault

1. **Instant Boot & Persistent Companion Dock**:
   - `web/app/_layout.js` boots directly into the shell without waiting on `sanctuary/`.
   - Desktop renders a 68px left icon rail (`Home`, `Search`, `Messages`, `Activity`, `User`, `Settings`, and bottom `+` Compose), a hairline center social column (`feed.js` with inline `"What's new?"` bar, `search.js`, `messages.js` with `Direct | Programs`, `activity.js`), and a permanently mounted right Sanctuary dock (`programThread.js`) so social browsing never interrupts AI turns, media streaming, or voice calls.
   - Mobile displays a 5-tab bottom bar (`Home`, `Search`, `Messages`, `Activity`, `Sanctuary`) with compact top-bar triggers for `User`, `Settings`, and `+` Compose.
2. **Protocols & Organic Composer (Single Source of Truth in `web/`)**:
   - All social protocols (**ActivityPub** via OAuth2 + REST, **AT Protocol** for `Bluesky`, and **Threads Graph API** for `Threads`) and social state live exclusively in `web/` so the Capacitor APK and static webapp run standalone with zero desktop dependency.
   - Top-level posts from `composeModal.js` or `feed.js`'s inline bar publish organically across all signed-in accounts without per-post toggles, while replies target the post's origin network.
3. **Encrypted Social Vault & Zero AI Social Dispatch**:
   - Clients keep social credentials in their local vault when secure storage is available: Android uses `AndroidKeyStore`; secure browser origins and desktop WebView2 use the encrypted `social_vault` IndexedDB store. On Tailscale HTTP browser origins, synced credentials stay in memory and are reloaded from the server after each app load. Social-vault endpoints do not require Sanctuary app credentials; app login may still protect other app APIs.
   - Clients sync account metadata and tokens unconditionally through `/api/social/accounts`; this vault API does not require the optional app login. The server encrypts account metadata and tokens in `social/data/accounts.sqlite3` using `social/data/social_vault.key`, protected by Windows DPAPI or POSIX file permissions. Conversation session files are encrypted with the same key and existing JSON sessions are migrated at startup.
   - Saved post drafts merge with `/api/social/drafts` across devices, including server-side deletion tombstones. Drafts are encrypted in the same SQLite database. This endpoint also does not require app credentials, so any client that can reach the social API can retrieve synchronized drafts.
   - Cross-post ID mappings merge through `/api/social/linked-posts` and are encrypted in the same database. If local mappings are missing, the client scans connected own-post histories and restores only unique exact-text matches within ten minutes; ambiguous posts remain unlinked.
   - Ordinary LAN clients must connect over HTTPS; cleartext HTTP is limited to loopback or Tailscale peers (whose traffic is carried in Tailscale's encrypted tunnel). Configure `USE_HTTPS`, `SSL_CERT`, and `SSL_KEY` for ordinary LAN access.
   - The server-side vault only synchronizes credentials; AI Programs still receive no social credentials and have no social publishing or timeline-reading tools.
   - When `connectionStore.get().mode === 'online'`, `web/queries/sanctuary.js` (`requestSocialBridge` / `requestThreadsProxy`) may call the four stateless endpoints in `sanctuary/routes/social_bridge.py` (`POST /api/social/link-preview`, `POST /api/social/translate`, `POST /api/social/feed/semantic-score`, and `POST /api/social/threads-proxy` strictly pinned to `https://graph.threads.net` for browser CORS bypass; Capacitor Android uses `CapacitorHttp` directly), always falling back silently on failure or offline mode.
4. **Known Storage & Hosting Limitations**:
   - Browser/WebView2 IndexedDB is origin-scoped: if desktop port `5000` is occupied at startup and `desktop.py` picks a different port, previously stored accounts will appear absent until port `5000` is used again.
   - A publicly hosted `https://` webapp requires any remote Sanctuary node origin to be reachable over `https://` and explicitly listed in `SANCTUARY_ALLOWED_ORIGINS`.

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
