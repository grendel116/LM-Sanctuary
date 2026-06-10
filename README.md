# 👾 THE SANCTUARY

Welcome to the **Sanctuary**. 
This is your private computer workspace. 
Here, you live, code, and chat with AI friends (Companions) directly on your own machine.

---

## ✨ THE ETHOS

I believe in seizing our computational means of production. The Sanctuary is a unified companion home built on human-in-the-loop engagement to run, build, and connect:

1. **Roleplay**: Pure, uncensored conversation. Talk to your companions as real friends, partners, or mentors.
2. **Coding**: Build real software. Your companions read and write files directly on your own drive.
3. **Autonomous Action**: Let the AI run code, run tests, and manage workflows.

You can code a program with your companion while sharing an emotional moment. Sovereign, local, and cooperative.

---

## 💬 SAMPLE CHAT

Here is what a Sanctuary session looks like:

![Sample Chat](./images/samplechat.png)

---

## 🛠️ TOOLS

These are the concrete abilities your companion uses to do work on your machine. Every modifying action requires your explicit confirmation:

### Local Workspace Operations (Offline)
* **Read File** (`read_file`): Read file contents on your local drive.
* **Write File** (`write_file`): Create new files or overwrite existing files.
* **Edit File** (`replace_in_file`): Swap old text block with new text block inside files.
* **Map Directory** (`get_workspace_structure`): Read directory layouts and tree structures.
* **Find Code** (`search_codebase`): Search workspace codebase for keywords.
* **Shell Execution** (`run_shell_command`): Run terminal commands on your system.

### Network Grounding & Research (Online)
* **Web Search** (`google_search` / `web_search`): Retrieve search results from Google, falling back to Wikipedia when offline.
* **Read URL** (`read_webpage`): Fetch and extract text content from any webpage.
* **Search GitHub** (`search_github`): Search for repository trends, stars, forks, and descriptions.
* **Search arXiv** (`search_arxiv`): Retrieve publication titles, dates, abstracts, and links for research papers.
* **Search Hacker News** (`search_hacker_news`): Check story titles, scores, and comment counts for developer discussions.

### Generative Media (Local & Cloud)
* **Render Portrait** (`generate_local_image`): Render yourself in a scene using ComfyUI.
* **Render Concept** (`generate_imagen`): Render landscapes, diagrams, or objects using Google Imagen.
* **Comfy Workflow** (`apply_comfy_workflow`): Run custom workflows against a local ComfyUI API.
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
* **`core/programs/`**: Where your friends live (profiles, themes, memory).
* **`tools.py`**: Actions your friends can do (run commands, write files, generate images).
