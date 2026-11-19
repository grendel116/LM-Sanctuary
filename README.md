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
100% Local-First workspace and social client. Your chats, memories, local SQLite social caches, credentials, and model weights stay on your own hardware, where local models and native clients do the work without cloud telemetry.

> [!NOTE]
> **The Sanctuary Ethos**:
> AI and public communication are new means of production. We must seize them, expropriate them from the hyperscale data centers and walled-garden platforms, and return them to the people. We want local, federated, sovereign, and democratic. The code, the models, and the social graph belong to the user and worker, not the shareholder.

---

## 🌐 FEDIVERSE & SOCIAL BRIDGES

Here is what the LM-Sanctuary workspace looks like:

<p align="center">
  <img src="./web/assets/img/samplechat.jpg" alt="LM-Sanctuary Workspace Preview" width="100%">
</p>

* **3-Column Desktop, PWA & Android Shell**: Desktop renders a left navigation rail (`Home`, `Search`, `Messages`, `Activity`, `Profile`, `Settings`, `+` Compose), a hairline center Fediverse stage, and a collapsible right Sanctuary dock (`sanctuary/`) so social browsing never interrupts active AI generations or voice calls. Mobile adapts into a bottom navigation bar (`Home`, `Messages`, `Activity`, `Profile`) with top-bar `Search`, `Settings`, and floating `+` Compose triggers, sharing the same pure-static `web/` bundle with Capacitor Android (`android/`).
* **Mastodon-First ActivityPub Client**: OAuth 2.0 and access-token sign-in (`mastodon.social` default or any ActivityPub server), `Feed` and `Following` timelines with stable scroll anchoring, nested conversation threads, rich link previews and privacy-preserving YouTube/Vimeo embed façades, multi-media carousels and classic lightbox viewer, snapshot post drafts, lists, keyword filters, follow/mutual graph explorer, profile studio, and Direct Messages (`Direct | Programs`).
* **Unified `Bluesky` & `Threads` Bridges**: Optional AT Protocol (`Bluesky`) and Meta `Threads` bridges fan out posts and multi-part threads concurrently (auto-splitting at `300` graphemes for Bluesky and `500` characters for Mastodon and Threads), forward media and link embeds, synchronize post edits (in-place on Mastodon, delete-and-republish across bridges) and deletions with automatic retry queuing, and include a `.zip` archive importer to migrate Threads following and mutuals onto the Fediverse.
* **Aggregated Cross-Platform Activity**: Unified `Activity` view merging Mastodon, Bluesky, and Threads notifications with grouped likes and reposts, cross-network engagement totals, unread nav indicator, and persistent notification deletion.
* **Transparent Local Feed Tuning**: Declarative local feed sliders and optional local CPU semantic concept anchors (`web/core/feedRanker.js`, `social/semantic_scorer.py`, `tune_feed_algorithm`) stored in `sanctuary/variables/feed_profile.json`—zero opaque remote ranking.
* **Strict Credential Isolation (Zero AI Social Dispatch)**: Timeline caches use local SQLite (`social/data/social.db` on Desktop/LAN or Android `SQLiteOpenHelper`, zero `IndexedDB`), while social tokens stay strictly in OS Credential Manager / Keychain (`social/storage/keychain.py`) or `AndroidKeyStore`. AI Programs (`sanctuary/`) hold zero social credentials and zero social publishing or timeline-reading tools; cross-over is strictly user-initiated via **Share-to-Fediverse** on your chat bubbles, **Share-to-Program** on feed posts, and optional token-free public Mastodon profile snapshots. See [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) for the module map.

---

## 🛠️ TOOLS

These are the things your program can do on your computer. By default, before the AI changes anything (like writing a file or running a command), it will ask for your approval. You can turn this off by changing the security setting to "Auto Mode" so the AI runs on its own. `/api/session_tool_calls` show you what the AI is doing.

> [!WARNING]
> **Security Warning**: Letting your program run commands (`run_command_async`, `run_shell_command`) and change files (`replace_file_content`, `replace_in_file`, `write_file`) gives them full control over your computer. **Be very careful. Do not give these tools to AI models that you do not trust.** A bad AI could run harmful code, delete your files, or steal your passwords. Always read what the AI wants to do before you click approve. You can also run this program in a safe container (a sandbox) to protect your computer.

### Local Workspace Operations & Code Intelligence (Offline)
* **Read File** (`read_file`): Read file contents on your local drive with optional line boundaries. For Python files, automatically appends tool-verified lint diagnostics and caller facts for the inspected range.
* **Write File** (`write_file`): Create new files or overwrite existing files, followed by automatic syntax and lint verification.
* **Edit File** (`replace_file_content` / `multi_replace_file_content` / `replace_in_file`): Swap single or multiple non-contiguous text blocks inside files with line-bounded precision or exact text matching, followed by automatic syntax and lint verification.
* **Map Directory** (`get_workspace_structure`): Read directory layouts and tree structures.
* **Find Files** (`find_files`): Locate files across the workspace matching filename patterns and wildcards.
* **Find Code** (`search_codebase`): Search codebase content for keywords.
* **Outline Symbols** (`outline_file`): Read structural definitions (functions, classes, methods) and line spans across source files to navigate large files without overflowing context.
* **Read Symbol** (`read_symbol`): Inspect an exact function or class definition with line numbers, relevant file imports, in-range lint diagnostics, and call graph facts without loading entire large files into context.
* **Find References** (`find_references`): Map symbol usage across the project using AST-derived call graphs (callers and callees) alongside whole-repo textual references.
* **Audit & Review Code** (`review_code`): System-orchestrated large-code review engine. Partitions files into risk-ordered units with complete coverage, checks worker claims mechanically against code ranges, incorporates direct linter findings, and verifies reports through a skeptic pass before generating a structured digest.
* **Shell Execution** (`run_shell_command` / `run_command_async`): Run terminal commands, or spawn headless asynchronous background subprocesses with background reading threads streaming stdout/stderr asynchronously (allowing the program to multitask and write to stdin).
* **Task Manager** (`manage_task` / `wait_task`): Monitor, write to stdin, kill, or block and wait on active background commands.
* **Add Quest** (`add_quest`): Create and append a structured task or chore to the user's local quest log with objectives, target date/time, coordinates/address, and alarm offsets.
* **Add Journal Memory** (`add_journal_entry`): Autonomously record permanent personal facts, core relationships, and milestones into the program's long-term memory journal (`journals.json`).
* **Local Feed Weight Tuning** (`tune_feed_algorithm`): Read and adjust declarative local feed weights and concept anchors in `sanctuary/variables/feed_profile.json` without social tokens or timeline access.

### Network Grounding & Research (Online)
* **Unified Web Search** (`web_search`): A unified search client that queries SearXNG (for Baidu/Yandex/Bing), DuckDuckGo, Brave, and Tavily concurrently. It aggregates and deduplicates URLs, supports concurrent page content enrichment for thin search results, and provides explicit query prefix routing (e.g. `github: query`, `arxiv: query`, `hn: query`, `wikipedia: query`).
* **Read URL** (`read_webpage`): Fetch and extract text content from any webpage.
* **Music Discovery** (`search_music`): Explore deep cuts, forgotten artists, rare grooves, and liner-note lore across curated modes (`deep_cuts`, `kexp`, `theme_time`, `bandcamp`, `artist`).

### Generative Media Engines (Local)
* **Hardware-Aware Local LLM Engine (`llama-server`)**: Automatic GPU detection (NVIDIA CUDA, AMD ROCm/HIP, Vulkan, or Apple Metal) with automatic binary provisioning, KV prefix cache reuse (`--cache-reuse`), automatic context sizing fitted to free VRAM (`LOCAL_CONTEXT=auto`), and real-time token streaming. Also discovers existing `.gguf` models in `~/.lmstudio/models/` automatically.
* **Native In-Process Diffusion Engine** (`generate_local_image`): Real-time GPU-accelerated SDXL diffusion (CUDA or DirectML) using SafeTensors checkpoints and optional LoRAs, coordinated by an automatic VRAM orchestrator so LLM and Diffusion never compete for GPU memory.
* **ComfyUI Workflows** (`apply_comfy_workflow` / `generate_video_from_image`): Run ComfyUI image and video workflows via the local ComfyUI API backend with dynamic template parameter replacement.

---

## 📁 MODELS DIRECTORY & RECOMMENDED DOWNLOADS

Place your local models into the `sanctuary/models/` directory for **GGUF LLMs** and **SDXL Checkpoints** used inside the app via **Settings → Models / Project Settings** and the **Program Inspector**:

* **`sanctuary/models/llm/`**: Place GGUF chat models (models inside `~/.lmstudio/models/` are also auto-detected).
* **`sanctuary/models/checkpoints/`**: Place Stable Diffusion / SDXL SafeTensors checkpoints (e.g. `WAI_Illustrious-SDXL_v11.safetensors` or `sd_xl_base_1.0.safetensors`).
* **`sanctuary/models/loras/`**: Place optional character or style LoRAs (`.safetensors`). Missing optional LoRAs in a workflow are bypassed automatically.
* **`sanctuary/models/vae/`**: Place custom VAE weights (`.safetensors` / `.pt`).
* **`sanctuary/models/workflows/`**: ComfyUI workflows (API format) for image and video generation. The default image workflow, `ImageWorkflow.json`, ships with the repository. Additional custom workflows (e.g. `RealisticWorkflow.json`, `ToonWorkflow.json`, `VideoWorkflow.json`) can be placed here and selected on the fly in the Sanctuary Node Settings modal. Placeholders: `%prompt%`, `%negative_prompt%`, `%seed%`, `%model%`, `%width%`, `%height%`.

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
* **Offline Outbox Queue**: When a configured Sanctuary node is temporarily unreachable over LAN or Tailscale, queued messages are stored locally in SQLite and replayed in strict FIFO order on reconnect.
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
   * Social bridge backend tests: `.venv/Scripts/python.exe __tests__/backend/test_social_bridge.py`
   * Capacitor Android verification / sync: `npm run build:android`


---

## 📜 LICENSE

Copyright (C) 2026 Davy & Sebile

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License** as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU Affero General Public License](./LICENSE) for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
