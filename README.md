# 👾 THE SANCTUARY

Welcome to the **Sanctuary**. 
This is your private computer workspace. 
Here, you live, code, and chat with AI friends (Companions) directly on your own machine.

---

## ✨ THE ETHOS

I believe in seizing our computational means of production. The Sanctuary is a unified agent home built on cooperative, local infrastructure to run, build, and connect directly:

1. **Roleplay**: Pure, uncensored conversation. Talk to your companions as real friends, partners, or mentors.
2. **Coding**: Build real software. Your companions read and write files directly on your own drive.
3. **Agentic Action**: Let the AI run code, run tests, and manage workflows.

You can code a program with your companion while sharing an emotional moment. Sovereign, local, and cooperative.

---

## 💬 SAMPLE CHAT

Here is what a Sanctuary session looks like:

![Sample Chat](./images/samplechat.png)

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
* **`core/agents/`**: Where your friends live (profiles, themes, memory).
* **`tools.py`**: Actions your friends can do (run commands, write files, generate images).
