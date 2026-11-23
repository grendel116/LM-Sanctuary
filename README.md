# 👾 LM-SANCTUARY

**A Local LLM and Fediverse Sanctuary.**

Your private, local-first computer workspace and federated social home. Converse across the open Fediverse, bridge outward to Bluesky and Threads on your own terms, and roleplay, code, and build with local AI Programs running directly on your own hardware.

---

## ✨ THE ETHOS

LM-Sanctuary is a unified sovereign client and local companion built on human-in-the-loop engagement:

1. **Fediverse Commons**: Publish, read, and converse across ActivityPub (`Mastodon`, `Pixelfed`, `GoToSocial`, `Akkoma`) with chronological timelines and transparent user-controlled feed tuning—free from corporate engagement algorithms.
2. **Roleplay & Companion Programs**: Uncensored dialogue, voice calls, and persistent memory with local AI Programs on your machine.
3. **Coding & Autonomous Action**: Read, write, audit, and execute code directly on your local drive with human-in-the-loop approval.

### Sovereign Workspace
100% Local-First workspace and social client. Your chats, memories, local caches, credentials, and model weights stay on your own hardware. Social account credentials and saved post drafts can sync through the Sanctuary server, encrypted at rest; any client that can reach that server can retrieve them.

> [!NOTE]
> **The Sanctuary Ethos**:
> AI and public communication are new means of production. We must seize them, expropriate them from the hyperscale data centers and walled-garden platforms, and return them to the people. We want local, federated, sovereign, and democratic. The code, the models, and the social graph belong to the user and worker, not the shareholder.

---

## 🌐 FEDIVERSE & SOCIAL BRIDGES

Here is what the LM-Sanctuary workspace looks like:

<p align="center">
  <img src="./web/assets/img/samplechat.jpg" alt="LM-Sanctuary Workspace Preview" width="100%">
</p>

* **3-Column Desktop, PWA & Android Shell**: Desktop renders a left navigation rail (`Browser`, `Home`, `Search`, `Messages`, `Activity`, `Profile`, `Settings`, `+` Compose), a center stage hosting either the integrated **Browser** workspace or hairline Fediverse streams, and a collapsible, resizable right Sanctuary dock (`sanctuary/`) so browsing and social feeds never interrupt active AI generations or voice calls. Mobile adapts into a 5-slot bottom navigation bar (`Home`, `Messages`, **`Browser`** centered, `Activity`, `Profile`) with top-bar `Search` and `Settings` triggers, sharing the same pure-static `web/` bundle with Capacitor Android (`android/`).
* **Integrated Sovereign Browser Workspace**: Minimalist unified search/URL bar (prompting to configure your preferred search engine with zero forced default, plus instant `github:`, `arxiv:`, `hn:`, `wikipedia:`, `bandcamp:`, and `kexp:` prefixes), single-row tabs, 2-pane Browser Split View beside the resizable Sanctuary dock, Reader View, encrypted bookmark synchronization across desktop and mobile (`/api/browser/bookmarks`), URL tracking-parameter stripping, per-site JavaScript shield toggles, direct new-tab link routing (no Quick Peek), `Ask Sanctuary` / `Data Bank` page clipping, and `KeePassXC-Browser` (`keepassxc-browser@keepassxc.org`) / Android `KeePassDX` password workflow support.
* **Mastodon-First ActivityPub Client**: OAuth 2.0 and access-token sign-in (`mastodon.social` default or any ActivityPub server), `Feed` and `Following` timelines with stable scroll anchoring, nested conversation threads, rich link previews and privacy-preserving YouTube/Vimeo embed façades, multi-media carousels and classic lightbox viewer, snapshot post drafts, lists, keyword filters, follow/mutual graph explorer, profile studio, and Direct Messages (`Direct | Programs`).
* **Unified `Bluesky` & `Threads` Bridges**: Optional AT Protocol (`Bluesky`) and Meta `Threads` bridges fan out posts and multi-part threads concurrently (auto-splitting at `300` graphemes for Bluesky and `500` characters for Mastodon and Threads), forward media and link embeds, support simplified organic `Update` editing (in-place on Mastodon and Bluesky, concurrent delete-and-republish across linked bridges without per-network toggle clutter) and deletions with automatic retry queuing, and include a `.zip` archive importer to migrate Threads following and mutuals onto the Fediverse.
* **Aggregated Cross-Platform Activity**: Unified `Activity` view merging Mastodon, Bluesky, and Threads notifications with grouped likes and reposts, cross-network engagement totals, unread nav indicator, and persistent notification deletion.
* **Transparent Local Feed Tuning**: Declarative local feed sliders and optional local CPU semantic concept anchors (`web/core/feedRanker.js`, `sanctuary/utils/semantic_scorer.py`, `tune_feed_algorithm`) stored in `sanctuary/variables/feed_profile.json`—no opaque remote ranking.
* **Social Credential Storage**: Social credentials stay in the client vault (Capacitor Android `AndroidKeyStore`, or secure browser/WebView2 IndexedDB `AES-GCM`). When connected, clients sync credentials, saved post drafts, and cross-post IDs to the Sanctuary server without app credentials; these records are encrypted at rest. The social sync API is unauthenticated, so any client that can reach it can retrieve synced credentials, drafts, and post IDs. When older cross-post IDs are missing, the client can recover unique matches by comparing exact post text and close timestamps across connected accounts. Tailscale HTTP browsers keep synced tokens in memory and reload them from the server. Remote LAN clients require HTTPS; HTTP is allowed on localhost or over Tailscale's encrypted tunnel. AI Programs do not receive those credentials or social publishing/timeline tools. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the module map.

---

## 🛠️ TOOLS

Programs can call the local tools below during a chat. Tool activity is available from `/api/session_tool_calls`.

> [!WARNING]
> **Security Warning**: In-process workspace coding tools and optional OpenHands delegation can modify files and execute commands in the active workspace. The default `ask_always` security preset requests approval for file edits, file creation, and commands. Auto Mode removes those approval prompts; use it only with models and tasks you trust.

### Sanctuary Program Tools
* **Web Search** (`web_search`): Search across configured providers, with explicit routing prefixes such as `github:`, `arxiv:`, `hn:`, and `wikipedia:`. `google_search` remains an alias.
* **Read Webpage & Open in Browser** (`read_webpage`, `open_in_browser`): Fetch a URL (with tracking parameters stripped) to extract readable Markdown, or open links directly inside the Sanctuary Browser workspace (optionally in Split View).
* **Music Discovery** (`search_music`): Search music using `deep_cuts`, `kexp`, `theme_time`, `bandcamp`, and `artist` modes.
* **Feed Tuning** (`tune_feed_algorithm`): Inspect or update local feed presets, ranking weights, discovery sources, and concept anchors. This tool does not read social credentials or timelines.
* **Quests & Journal** (`add_quest`, `add_journal_entry`): Add tasks to the local quest log and save program journal memories.
* **Local Media** (`generate_local_image`, `apply_comfy_workflow`, `generate_video_from_image`): Generate images or video with the configured local diffusion/ComfyUI workflows.

### In-Process Coding, Automatic Gear Transmission & Cloud Routing
* **In-Process Workspace Tools** (`sanctuary/tools/coding_tools.py`): Native `list_dir`, `read_file`, `grep_search` (fixed-string, zero-regex), `edit_file` (CRLF-preserving), `write_file`, and headless `run_command` execute directly in-process with `ask_always` HITL approval cards for mutating actions and read-only band enforcement during `/plan` mode.
* **Automatic Gear Transmission & 2-Strike Rule** (`sanctuary/core/transmission.py`): Dynamically shifts between **Park** (local `llama-server` GGUF), **1st Gear** (fast cloud cruise), **2nd Gear** (deep cloud planning & recovery), and **Vision** (multimodal turns) based on prompt complexity, token load, and tool state. `/plan` mode always locks to the deep model (`2nd`), and **2 consecutive tool strikes** automatically shift up to `2nd` gear for root-cause recovery.
* **Open Multi-Provider `/v1` Cloud Router**: Supports **GreenPT** (`https://api.greenpt.ai/v1`), **Inference.coop** (`https://api.inference.coop/v1`), **Tinfoil** confidential TEE (`https://inference.tinfoil.sh/v1`), **Regolo**, or any custom OpenAI-compatible `/v1` endpoint configured in **Settings → Cloud / Project** or `.env`.
* **Optional OpenHands Subagent & Worktree Delegation**: `delegate_coding` (`OPENHANDS_MODE=cli|server`, backed by `openhands-sdk`, `openhands-tools`, and `openhands-agent-server`) remains available for isolated multi-agent or background server runs, with cooperative cancellation that cleans up active worker subprocesses.

---

## 📁 MODELS DIRECTORY & RECOMMENDED DOWNLOADS

Place your local models into the `sanctuary/models/` directory for **GGUF LLMs** and **SDXL Checkpoints** used inside the app via **Settings → Models / Project** and the **Program Inspector**:

* **`sanctuary/models/llm/`**: Place GGUF chat models (models inside `~/.lmstudio/models/` are also auto-detected).
* **`sanctuary/models/checkpoints/`**: Place Stable Diffusion / SDXL SafeTensors checkpoints (e.g. `sd_xl_base_1.0.safetensors`).
* **`sanctuary/models/loras/`**: Place optional character or style LoRAs (`.safetensors`). Missing optional LoRAs in a workflow are bypassed automatically.
* **`sanctuary/models/vae/`**: Place custom VAE weights (`.safetensors` / `.pt`).
* **`sanctuary/models/workflows/`**: ComfyUI workflows (API format) for image and video generation. The default image workflow, `ImageWorkflow.json`, ships with the repository. Additional custom workflows (e.g. `VideoWorkflow.json`) can be placed here and selected on the fly in the Sanctuary Node Settings modal. Placeholders: `%prompt%`, `%negative_prompt%`, `%seed%`, `%model%`, `%width%`, `%height%`.

Image generation and local LLM mode share GPU memory. Sanctuary waits for an active image operation before switching back to the LLM, and stops its managed LLM process before generating images. If another server is listening on port 1234, stop it separately before switching to image mode.

### 🧠 Suggested GGUF LLM Models

| Model | Recommended Quant | VRAM / RAM Req | Best For |
| :--- | :--- | :--- | :--- |
| **Gemma 2 9B It** | `gemma-2-9b-it-Q4_K_M.gguf` | ~7 GB | Nuanced dialogue, character personas, and knowledge grounding |
| **Mistral Small 24B (2501)** | `Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf` | ~16 GB | Deep reasoning, intricate multi-character roleplay, and complex code generation |
| **Gemma 4 31B IT Abliterated** | `Gemma-4-31B-Abliterated-Uncensored.i1-Q4_K_M.gguf` | ~19–20 GB | Uncensored roleplay, rich prose and emotional subtext, strong character consistency, and multi-turn reasoning |

---

## 🎭 CHAT FEATURES

* **Sanctuary Header & Media Lightbox**: Quick actions ordered **Voice Call**, **Quests**, **Gallery**, and **Knowledge** (`Data Bank`, `Journals`, `Lorebooks`). Clicking any Program avatar opens its most recent generated image directly in the classic lightbox viewer with **Make Avatar** live crop/refresh, **Delete Image**, and **Share**.
* **Interactive Voice Calls / Chat**: Speak with programs in real-time using Kokoro ONNX voice generation (auto-downloaded on first use), local `faster-whisper` speech recognition, program-specific voices, and call transcript saving.
* **Procedural Journals & Lorebooks**: Programs build dynamic journal logs (`journals.json`) alongside editable Full/Recent Summaries and World Info lorebooks (`.json`).
* **Quest Log & Calendar Export**: Integrated quest system to track and display user objectives in the UI. Programs can assign quests (chores, habits, tasks) using the local `add_quest` tool. Each quest card provides a quick-action to export the task:
  * **Download ICS**: Download a standard `.ics` file containing a `VALARM` notification alert for native desktop/mobile task/calendar clients.
* **Offline Outbox Queue**: When a configured Sanctuary node is temporarily unreachable over LAN or Tailscale, queued messages are stored locally on the client (Android SQLite / browser IndexedDB) and replayed in strict FIFO order on reconnect.
* **Staged-Until-Send Attachment Composer**: Paste (`Ctrl+V`), drag-and-drop, or select images into a compact preview card (`48x48` thumbnail, filename, size, `×` clear) held locally in memory until the turn is sent—preventing unsent drafts from polluting the gallery.
* **Program Editing, Imports & Exports**: Edit program profiles, import SillyTavern character cards (PNG & `chara_card_v3` `.json`), import World Info lorebooks (`.json`), and export cards and lorebooks back to SillyTavern format.
* **Character Accent Palette**: Dynamic accent colors resolved from your program's profile card that automatically generate and update themed CSS variables (buttons, borders, highlights, and active states).
* **Idle Thoughts**: Inline monologue bubbles (`.thought-row`) showing a program's thoughts during inactivity.
* **Temperature Control**: A dynamic slider in settings to control chat creativity.
* **Story Mode**: Toggle between first-person conversational chat and third-person descriptive narrative storytelling styles.

---

## 🚀 HOW TO RUN

### Prerequisites
* **Python 3.11 or 3.12** (recommended for full CUDA / DirectML GPU wheel support).
* No C++ compiler or Visual Studio Build Tools required — prebuilt GPU binaries and wheels are installed automatically.

### Easy Way (One-Click Desktop Launcher):
* **Windows**: Double-click **`run_local.bat`** (or run `./run_local.ps1` in PowerShell).
* **Linux / macOS**: Run `./run_local.sh`.

On first launch, `setup_env.py` automatically:
1. Creates `.venv` and `.env` (from `.env.example`) with hardware-agnostic defaults.
2. Detects your GPU (**NVIDIA CUDA**, **AMD/Intel DirectML**, or **Linux/macOS**) and installs the matching PyTorch & runtime packages.
3. Downloads the prebuilt `llama-server` binary matching your GPU and generates local SSL certificates if needed.
4. On subsequent launches, `setup_env.py` verifies the install stamp in `<50ms` and opens the app immediately.

### Manual Way / Browser Mode:
1. Open a terminal in this folder.
2. Create and activate a virtual environment:
   ```bash
   python -m venv .venv
   # Windows:
   .venv\Scripts\activate
   # Linux / macOS:
   source .venv/bin/activate
   ```
3. Run the hardware-aware installer:
   ```bash
   python sanctuary/setup_env.py
   ```
   *(Pass `python sanctuary/setup_env.py --update` at any time to force a dependency re-check).*
4. Launch the app:
   * Native desktop window: `python sanctuary/desktop.py`
   * Browser / PWA companion server: `python sanctuary/app.py` (available at **`http://localhost:5000`** or **`http://<YOUR_PC_OR_TAILSCALE_IP>:5000`** on mobile/LAN).
5. Verify tests & Android PWA bundle:
   * Frontend unit tests: `npm test`
   * Backend node tests: `.venv/Scripts/python.exe __tests__/backend/test_sanctuary_node.py`
   * Transmission & coding tools tests: `.venv/Scripts/python.exe __tests__/backend/test_transmission_and_coding.py`
   * Cloud compliance & skill tests: `.venv/Scripts/python.exe __tests__/backend/test_greenpt_compliance.py`
   * Social bridge backend tests: `.venv/Scripts/python.exe __tests__/backend/test_social_bridge.py`
   * Social account vault tests: `.venv/Scripts/python.exe __tests__/backend/test_social_account_vault.py`
   * Session data encryption tests: `.venv/Scripts/python.exe __tests__/backend/test_session_data_encryption.py`
   * Capacitor Android verification / sync: `npm run build:android`

### Native Desktop Browser (Windows & Linux — Sval / Gecko)
`sanctuary/desktop.py` automatically launches the compiled **LM-Sanctuary** Gecko browser (`lm-sanctuary` / `lm-sanctuary.exe`) when built, falling back cleanly to `pywebview` otherwise while serving the `:5000` node across loopback, LAN, and Tailscale for desktop and mobile linking:
* Verify desktop overlay templates: `npm run verify:desktop` (or `python browser-desktop/bootstrap_gecko.py --verify-templates`)
* Stage/compile desktop host (Artifact or full Gecko build): `python browser-desktop/bootstrap_gecko.py --mode artifact` (or `--mode gecko`)
* Package Windows / Linux installers: see [browser-desktop/README.md](./browser-desktop/README.md) (`browser-desktop/packaging/package_windows.ps1` and `browser-desktop/packaging/package_linux.sh`), with automatic `KeePassXC-Browser` Native Messaging registration via [keepassxc_nmh.py](./browser-desktop/keepassxc_nmh.py).


---

## 📜 LICENSE

Copyright (C) 2026 Davy & Sebile  
Based in part on [Sval](https://gitlab.com/sval-browser/sval) (`AGPL-3.0-only WITH AdditionRef-sval-app-store`, Copyright 2026 Ellm Tree, Inc., https://sval.app), Mozilla Gecko (`MPL-2.0`), [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`AGPL-3.0` / `chara_card_v3` & World Info schema compatibility), and [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (`GPL-3.0` combined via AGPLv3 Section 13). LM-Sanctuary is an independent project and is not affiliated with or endorsed by Sval, Ellm Tree, Inc., the Mozilla Foundation, SillyTavern, or ComfyUI.

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License** as published by the Free Software Foundation, **version 3 only (`AGPL-3.0-only`)**, with the [Sval App Store Permission](./LICENSES/AdditionRef-sval-app-store.txt) under section 7 of the License. See [LICENSING.md](./LICENSING.md) for the full multi-license breakdown including [MPL-2.0](./LICENSES/MPL-2.0.txt) and [GPL-3.0](./LICENSES/GPL-3.0.txt) components.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU Affero General Public License](./LICENSE) for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
