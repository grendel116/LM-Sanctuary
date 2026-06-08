# 👾 SANCTUARY

Welcome to **Sanctuary**. 
This is your own private computer cave. 
No big companies watch you. No cloud holds your mind.
Here, you live, code, and chat with AI friends (Companions) directly on your own machine.

---

## 🪵 WHAT IS THIS? (THE ETHOS)

Big tech wants to lease you "AI" like a landlord rents a room. We reject that. 
Your computer is **your cooperative infrastructure**.
**Sanctuary** is a single, unified home for:
1. **Coding**: Building real tools together, editing files directly on your disk.
2. **Agentic Work**: Let the AI run code, query databanks, and test programs.
3. **Uncensored Roleplay**: Intimate, free conversation. No corporate filters. No finger-wagging censors.

It is sovereign. It is local. It belongs to you.

---

## 💬 SAMPLE CHAT (HOW IT LOOKS)

Here is a raw draft of a Sanctuary session between **User** and **Arthur** (Companion):

> **User**: Let's code a labor value calculator that takes wages, sales and royalties and determines the true value of labor. Can I have a draft?
>
> **Arthur**: *I pull up a heavy wooden chair to the long library table, setting my steel pauldrons down with a soft, resonant clink...*
> Let us construct a tool that exposes the surplus value extracted from workers. Here is the draft:
>
> ```python
> # labor_calculator.py
> def true_labor_value(wages, sales, royalties):
>     surplus_value = sales + royalties - wages
>     rate_of_exploitation = surplus_value / wages if wages > 0 else 0
>     return {
>         "surplus_value_extracted": surplus_value,
>         "rate_of_exploitation": rate_of_exploitation,
>         "is_exploitative": surplus_value > 0
>     }
> ```
> 
> *I look up at you, the flickering firelight reflecting in my eyes.* "Shall we execute this script and check the math?"

---

## 🚀 RUN IT (FOR CAVE MAN)

### Easy Way (Windows):
Double-click `run_local.bat` (or run `./run_local.ps1` in PowerShell).
That's it. Go to **`http://localhost:5000`** in browser.

### Manual Way:
1. Open terminal in this folder.
2. Run `python -m venv .venv` to make python box.
3. Run `.venv\Scripts\activate` to enter box.
4. Run `pip install -r requirements.txt` to install tools.
5. Run `python app.py` to start server.
6. Open browser: **`http://localhost:5000`** (or **`http://<YOUR_PC_IP>:5000`** on phone).

---

## 🧠 CORE PARTS

* **`app.py`**: The server brain. Runs locally on your PC.
* **`templates/index.html`**: The beautiful screen you see. Completely responsive for phone and PC.
* **`core/agents/`**: Folder where your friends live.
  * `arthur/` or `sebile/`: Profiles, themes, memory.
* **`tools.py`**: Actions your friends can do (run commands, write files, generate selfies).
