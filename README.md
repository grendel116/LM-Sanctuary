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

### Workspace Operations
* **Read File** (`read_file`) <font color="#10b981">*</font>: Looks inside a file on your drive to get information.
* **Write File** (`write_file`) <font color="#10b981">*</font>: Creates new files or writes over old ones to save code or text.
* **Edit File** (`replace_in_file`) <font color="#10b981">*</font>: Swaps out old text with new text inside your code files.
* **Shell Execution** (`run_shell_command`) <font color="#10b981">*</font>: Runs terminal commands to execute programs or build tools locally.
* **Map Directory** (`get_workspace_structure`) <font color="#10b981">*</font>: Shows the layout of all files and folders in your project.
* **Find Code** (`search_codebase`) <font color="#10b981">*</font>: Searches all files in your project to find specific words or configurations.

### External Retrieval & Research
* **Search Web** (`google_search`): Finds current facts or information using the internet (falls back to Wikipedia if offline).
* **Read URL** (`read_webpage`): Fetches and displays clean text from any HTTP/HTTPS link.
* **Research Hub** (`multi_platform_research`): Gathers discussions, repositories, and publications across Hacker News, GitHub, arXiv, Reddit, and YouTube to compile a complete report.

### Visual Rendering & Sentiment
* **Render Portrait** (`generate_companion_portrait`) <font color="#10b981">*</font>: Calls a local ComfyUI instance to draw the companion doing actions or in a specific scene.
* **Render Scene** (`generate_general_image`): Calls Imagen to draw general concepts, objects, or backgrounds.
* **Sense Mood** (`analyze_emotional_state`) <font color="#10b981">*</font>: Reads the conversation tone to adjust neon glows and animation speeds of the companion's display frame.

<font color="#10b981">* Local operations run entirely on your own machine, keeping your data and workspace sovereign.</font>

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
