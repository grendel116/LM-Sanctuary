# 👾 THE SANCTUARY

Welcome to the **Sanctuary**. 
This is your private computer workspace. 
Here, you live, code, and chat with AI friends (Companions) directly on your own machine.

---

## ✨ THE ETHOS

I believe in seizing our computational means of production. The Sanctuary is a unified companion home built on human-in-the-loop engagement to run, build, and connect:

1. **Roleplay**: Uncensored conversation. Talk to your companions as real friends, partners, or mentors.
2. **Coding**: Build real software. Your companions read and write files directly on your own drive.
3. **Autonomous Action**: Let the AI run code, run tests, and manage workflows.

### Local First / Cloud Offloading

Local-First workspace. Your chats, your memory, and your data stay on your drive. Local models do the daily work, saving resources from capitalist hyperscale data centers. When a task exceeds local capacity, processing is offloaded to their captured resources. Compute should be a public utility and cloud models governed locally, not by shareholders or venture capitalists.





---

## 💬 SAMPLE CHAT

Here is what a Sanctuary session looks like:

![Sample Chat](./images/samplechat.png)

---

## 🛠️ TOOLS

These are the things your companion can do on your computer. By default, before the AI changes anything (like writing a file or running a command), it will ask for your approval. You can turn this off by changing the security setting to "Auto Mode" so the AI runs on its own. `/api/session_tool_calls` show you what the AI is doing.

> [!WARNING]
> **Security Warning**: Letting your companion run commands (`run_command_async`, `run_shell_command`) and change files (`replace_file_content`, `write_file`) gives them full control over your computer. **Be very careful. Do not give these tools to AI models that you do not trust.** A bad AI could run harmful code, delete your files, or steal your passwords. Always read what the AI wants to do before you click approve. You can also run this program in a safe container (a sandbox) to protect your computer.

### Local Workspace Operations (Offline)
* **Read File** (`read_file`): Read file contents on your local drive.
* **Write File** (`write_file`): Create new files or overwrite existing files.
* **Edit File** (`replace_file_content` / `multi_replace_file_content`): Swap single or multiple non-contiguous text blocks inside files with line-bounded precision.
* **Map Directory** (`get_workspace_structure`): Read directory layouts and tree structures.
* **Find Code** (`search_codebase`): Search codebase for keywords.
* **Shell Execution** (`run_shell_command` / `run_command_async`): Run terminal commands, or spawn headless asynchronous background subprocesses with daemon reading threads streaming stdout/stderr asynchronously (allowing the companion to multitask and write to stdin).
* **Task Manager** (`manage_task` / `wait_task`): Monitor, write to stdin, kill, or block and wait on active background commands.

### Network Grounding & Research (Online)
* **Hybrid Web Search** (`web_search`): A unified search client that queries Google Grounding Search, SearXNG, and Wikipedia. SearXNG is now used as a centralized proxy for routing platform-specific queries (e.g., Baidu, Yandex). It aggregates and deduplicates URLs, and supports explicit query prefix routing (e.g. `github: query`, `arxiv: query`, `hn: query`).
* **Read URL** (`read_webpage`): Fetch and extract text content from any webpage.

### Generative Media (Local & Cloud)
* **Render Portrait** (`generate_local_image`): Render yourself in a scene using ComfyUI.
* **Render Concept** (`generate_imagen`): Render landscapes, diagrams, or objects using Google Imagen.
* **Comfy Workflow** (`apply_comfy_workflow`): Run custom workflows against a local ComfyUI API.
---

## CHAT FEATURES

* **Interactive Voice Calls / Chat**: Speak with companions in real-time. Powering Kokoro ONNX voice generation, companion-specific voices, and call transcript saving.
* **Procedural Journals & Memories**: Companions build dynamic memory structures (`memories.json`) and journal logs (`journals.json`), preserving context and relationships across sessions.
* **Quest Log & Objectives**: Integrated quest system to dynamically track, update, and display user objectives.
* **Companion Editing & Imports**: Profile updating, and support for importing custom Tavern cards.
* **Character Accent Palette**: Colors saved in `project_settings.json` that dynamically generates and update themed CSS variables, buttons, highlights, and more.
* **Idle Thoughts**: Inline monologue bubbles (`.thought-row`) showing a companion's thoughts during inactivity.
* **Temperature Control**: A dynamic slider in settings to control chat creativity.
* **Portrait Animation**: Animate companion portraits using ComfyUI video.

---

## 🚀 HOW TO RUN

### Easy Way (Windows):
Double-click `run_local.bat` (or run `./run_local.ps1` in PowerShell).
Open browser: **`http://localhost:5000`**

### Manual Way:
1. Open terminal in this folder.
2. Run `python -m venv .venv` to make python environment.
3. Run `.venv\Scripts\activate` (or `source .venv/bin/activate` on Mac/Linux).
4. Run `pip install -r requirements.txt` to install tools.
5. Run `python app.py` to start server.
6. Open browser: **`http://localhost:5000`** (or **`http://<YOUR_PC_IP>:5000`** on phone).

---

## 🧠 SYSTEM PARTS

* **`app.py`**: The server brain. Runs locally on your PC.
* **`templates/index.html`**: The UI. Completely responsive for phone and PC.
* **`core/programs/` & `core/skills/`**: Where your friends live (profiles, themes, memory, and skills).
* **`tools.py`**: Actions your friends can do (run commands, write files, generate images).
