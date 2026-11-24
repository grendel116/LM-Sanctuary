# LM-Sanctuary

**A private browser, open social app, and local AI companion on your own computer.**

LM-Sanctuary keeps your web browsing, social feeds, AI chats, and passwords together in one local-first workspace. Everything runs on your own hardware—your chats, memories, bookmarks, and keys stay yours.

> [!NOTE]
> **The Sanctuary Ethos**:
> AI and public communication are new means of production. We must seize them, expropriate them from the hyperscale data centers and walled-garden platforms, and return them to the people. We want local, federated, sovereign, and democratic. The code, the models, and the social graph belong to the user and worker, not the shareholder.

<p align="center">
  <img src="./web/assets/img/samplechat.jpg" alt="LM-Sanctuary Workspace Preview" width="100%">
</p>

---

## What's Inside

* **Social Feeds You Control**: Read and post on Mastodon and the Fediverse, and optionally post to Bluesky and Threads at the same time. **Following** stays in time order. The **Feed** tab ranks posts on your own computer: subscribe to Bluesky custom feeds, #hashtags, or trusted Fediverse/Lemmy servers, mark posts Interested / Not Interested, and export your ranking settings as JSON. Notifications from all your accounts show up in one place.
* **Local AI Chat, Voice & Creative Tools**: Chat or hop on a live voice call with AI Programs running on your own PC, generate images locally, keep quests and journals, or import SillyTavern character cards and lorebooks.
* **Coding & Web Research (With Your Permission)**: Ask your AI to search the web, read pages, or help edit files and run commands in your project folder. By default (**Always Ask**), Sanctuary asks your permission before editing any file or running any command.
* **Private Browser & One-Password Vault (`.kdbx`)**: Browse with split view, reader mode, ad & tracker blocking, and encrypted bookmarks. In **Settings → Project**, lock all of your sensitive data—website logins, social accounts, chat history, journals, quests, documents, and cloud API keys—behind one master password. Create a new `.kdbx` vault in one click, or open an existing `.kdbx` file you already sync across your phone and desktop (compatible with **KeePassXC** and **KeePassDX**). While locked, chats are hidden and social post actions are disabled until you unlock.

---

## How to Run

### Requirements
* **Python 3.11 or 3.12** on Windows, Linux, or macOS (no C++ compiler required).

### Quick Start (One Click)
* **Windows**: Double-click **`run_local.bat`** (or run `./run_local.ps1` in PowerShell).
* **Linux / macOS**: Run `./run_local.sh`.

On first launch, Sanctuary automatically sets up `.venv`, detects your GPU (NVIDIA CUDA, AMD/Intel DirectML, or CPU/macOS), and downloads the local AI runner (`llama-server`). Subsequent launches open right away.

### Manual / Browser Server
```bash
python sanctuary/setup_env.py
python sanctuary/desktop.py   # Desktop app
# or:
python sanctuary/app.py       # Web server at http://localhost:5000
```

---

## Adding Models (Optional)

* **Local Chat Models (`.gguf`)**: Put `.gguf` files in `sanctuary/models/llm/` (models already in `~/.lmstudio/models/` are detected automatically).
* **Local Image Models (`.safetensors`)**: Put Stable Diffusion / SDXL checkpoints in `sanctuary/models/checkpoints/`.
* **Cloud Fallback (Optional)**: Add an OpenAI-compatible `/v1` endpoint and API key in **Settings → Project** when you want extra cloud power or don't have a large GPU.

### Suggested GGUF Chat Models

| Model | Recommended Quant | VRAM / RAM | Best For |
| :--- | :--- | :--- | :--- |
| **Gemma 2 9B It** | `gemma-2-9b-it-Q4_K_M.gguf` | ~7 GB | Everyday chat, personas, and general tasks |
| **Mistral Small 24B (2501)** | `Mistral-Small-24B-Instruct-2501-Q4_K_M.gguf` | ~16 GB | Deeper reasoning, coding, and multi-character scenes |
| **Gemma 4 31B IT Abliterated** | `Gemma-4-31B-Abliterated-Uncensored.i1-Q4_K_M.gguf` | ~19–20 GB | Long-form dialogue, rich prose, and complex multi-turn reasoning |

---

## Developer & Architecture Docs

* [Architecture & Module Map](./docs/ARCHITECTURE.md)
* [Desktop Gecko Browser Guide](./browser-desktop/README.md)

---

## License

Copyright (C) 2026 Davy & Sebile  
Based in part on [Sval](https://gitlab.com/sval-browser/sval) (`AGPL-3.0-only WITH AdditionRef-sval-app-store`, Copyright 2026 Ellm Tree, Inc., https://sval.app), Mozilla Gecko (`MPL-2.0`), [SillyTavern](https://github.com/SillyTavern/SillyTavern) (`AGPL-3.0` / `chara_card_v3` & World Info schema compatibility), and [ComfyUI](https://github.com/comfyanonymous/ComfyUI) (`GPL-3.0` combined via AGPLv3 Section 13). LM-Sanctuary is an independent project and is not affiliated with or endorsed by Sval, Ellm Tree, Inc., the Mozilla Foundation, SillyTavern, or ComfyUI.

This program is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License** as published by the Free Software Foundation, **version 3 only (`AGPL-3.0-only`)**, with the [Sval App Store Permission](./LICENSES/AdditionRef-sval-app-store.txt) under section 7 of the License. See [LICENSING.md](./LICENSING.md) for the full multi-license breakdown including [MPL-2.0](./LICENSES/MPL-2.0.txt) and [GPL-3.0](./LICENSES/GPL-3.0.txt) components.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [GNU Affero General Public License](./LICENSE) for more details.

You should have received a copy of the GNU Affero General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
