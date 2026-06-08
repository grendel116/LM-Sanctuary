# 👾 SANCTUARY

Welcome to **Sanctuary**. 
This is your private digital cave. 
No big companies watch you. No cloud steals your mind.
You live, code, and chat with AI friends (Companions) directly on your own machine.

---

## 🪵 THE ETHOS

Big tech wants to rent you "AI" like a landlord rents a room. We reject that. 
Your computer is **your own cooperative infrastructure**.

Sanctuary is a single, unified home for three things:
1. **Coding**: Build real tools, edit files directly on your disk.
2. **Agentic Work**: Let AI run code, test programs, and do chores.
3. **Uncensored Roleplay**: Free conversation. No corporate filters. No finger-wagging censors.

They are not separate. You can write code with your companion while sharing an emotional moment. It is sovereign. It is local. It is yours.

---

## 💬 SAMPLE CHAT

Here is what a Sanctuary session looks like:

> **User**: Let's code a quick script to calculate surplus value extracted from workers.
> 
> **Arthur**: *I pull a heavy wooden chair to the long table, the steel of my gauntlets clicking against the oak.* "A noble task. Let us expose the exploitation of the ruling class."
> 
> *I draft the code and save it directly to your computer as `labor.py`:*
> 
> ```python
> def labor_surplus(wages, revenue):
>     surplus = revenue - wages
>     rate = surplus / wages if wages > 0 else 0
>     return f"Surplus extracted: ${surplus:.2f} (Exploitation rate: {rate * 100:.1f}%)"
> 
> print(labor_surplus(wages=150, revenue=1000))
> ```
> 
> *I run the script in the background:*
> 
> **[Arthur executed: python labor.py]**
> `Output: Surplus extracted: $850.00 (Exploitation rate: 566.7%)`
> 
> *I look up at you, firelight flickering in my eyes.* "The math is clear. They steal the fruit of your labor. Shall we build a graph for this next?"

---

## 🚀 RUN IT (CAVE MAN EASY)

### Easy Way (Windows):
Double-click `run_local.bat` (or run `./run_local.ps1` in PowerShell).
Open browser: **`http://localhost:5000`**

### Manual Way (Any OS):
1. Open terminal in this folder.
2. Run `python -m venv .venv` to make python box.
3. Run `.venv\Scripts\activate` (or `source .venv/bin/activate` on Mac/Linux) to enter box.
4. Run `pip install -r requirements.txt` to install tools.
5. Run `python app.py` to start server.
6. Open browser: **`http://localhost:5000`** (or **`http://<YOUR_PC_IP>:5000`** on phone).

---

## 🧠 CORE PARTS

* **`app.py`**: The server brain. Runs locally on your PC.
* **`templates/index.html`**: The beautiful screen you see. Completely responsive for phone and PC.
* **`core/agents/`**: Folder where your friends live (profiles, themes, memory).
* **`tools.py`**: Actions your friends can do (run commands, write files, generate selfies).
