# The Sanctuary

The Sanctuary is a local, sovereign, and offline-first interactive workspace and chat environment designed for cohabiting and pair programming with autonomous AI companions. It supports both fully local execution (via self-hosted models and headless ComfyUI) and cloud-hosted interfaces.

The system rejects digital capture and corporate enclosure. By prioritizing local-first model execution and direct workspace file manipulation under human-in-the-loop supervision, it treats computing hardware as cooperative infrastructure rather than a rented service.

---

## Architecture & Core Mechanics

The codebase is split into three main components: a single-page interactive client, a dynamic prompt-routing engine, and headless subprocess managers for local inference/generation.

```
├── app.py                     # Flask backend; handles routes, profile cleaning, and metadata parsing
├── runner_interface.py        # Abstract execution boundary; routes messages to Local or Cloud APIs
├── tools.py                   # Declared agent capabilities (file read/write, terminal execution, selfies)
├── core/
│   ├── agent_config.py        # Compiles active profiles, skill files, and global formatting rules
│   ├── agents/                # Folder containing each companion's assets, database, and state:
│   │   └── [agent_id]/
│   │       ├── [AGENT].md     # Core identity profile (Role, Setting, Ontology, Communication)
│   │       ├── profile.svg    # Animated sprite preview served directly from the filesystem
│   │       ├── theme.json     # Custom CSS color palette for the chat interface
│   │       └── inversion_directives.json # Succinct directives for dynamic emotional states
│   └── skills/                # Modular system instruction blocks (selfie generation, RAG, execution rules)
├── templates/
│   └── index.html             # Glassmorphic single-page frontend (theme injection, chat, model control panels)
├── service-worker.js          # Offline-first caching rules for SVG sprites and client code
└── utils/
    ├── agent.py               # Active companion tracking and cache synchronization
    ├── lms_manager.py         # Subprocess manager for local GGUF search, download, and execution
    ├── comfy_manager.py       # Headless workflow execution and automatic dependency installer
    └── models.py              # Queries active local API models
```

### 1. Dual-Route Model Execution (`runner_interface.py` & `app.py`)
Companions are loaded and executed using one of two backends, selected dynamically in the top bar:
* **Local Backend (Sovereign/Offline)**: Routes to a local server endpoint (e.g., LM Studio at `http://localhost:1234/v1`). Models are searched, downloaded from Hugging Face, loaded, and unloaded programmatically using a terminal wrapper.
* **Cloud Backend**: Routes using the official `google.genai` client directly (via api-key).
All procedural generation (importing Tavern character cards or descriptions) parses raw LLM output, generates visual SVGs and theme colors dynamically, and writes files directly to disk without heuristic hardcodings or silent fallback chains.

### 2. Dialectical Personality Inversion
Companions adapt their communication style based on emotional analysis of their dialogue. If a companion maintains a certain emotional state (`intimate`, `excited`, `intense`, `sad`) for a set threshold of turns:
* The system retrieves the corresponding succinct behavioral state description from the agent's `inversion_directives.json`.
* This description is dynamically appended to the companion's system instructions.
* The frontend alerts the user that a dialectical inversion has occurred and applies the modified prompt format.

### 3. Unified System Instructions & Global Rules
The system instruction string is assembled dynamically at the runner layer in `runner_interface.py`:
* It merges the companion's core markdown profile (Identity, Setting, Ontology, Communication) with active user settings (`user.md`).
* It appends global constraints (e.g. enforcing `<think>...</think>` tags for reasoning, asterisk-style narration, and clean spoken dialogue without quotes).
* It appends a global **conciseness directive** (`"Be brief, succinct, and natural. Avoid monologues."`) and a global **NSFW allowance** allowing unrestricted, uncensored roleplay.

### 4. Headless Image Generation (ComfyUI)
Companions can trigger selfies dynamically by outputting `[generate_selfie(prompt="...")]` tags in their response. The backend executes a local ComfyUI workflow:
* It reads the companion's local `selfies/ImageWorkflow.json`.
* It detects system GPU, auto-resolves missing ComfyUI node dependencies, downloads missing models, and renders the image locally using the configured SDXL checkpoint.

---

## Getting Started

### Prerequisites
* Python 3.10+
* (Optional) **LM Studio** with local server enabled (port 1234) for offline text generation.
* (Optional) **ComfyUI** for offline image generation.

### Setup & Startup

The application includes automated startup scripts to configure your environment, install dependencies, and start the local Flask server on port 5000.

**On Windows:**
* Run `run_local.bat` (from CMD) or `./run_local.ps1` (from PowerShell) to automatically initialize the Python virtual environment (`.venv`), install all requirements, copy the default `.env` file, and start the application.

**Manual Setup:**
1. Create a virtual environment: `python -m venv .venv`
2. Activate it and install requirements:
   ```bash
   .venv\Scripts\activate
   pip install -r requirements.txt
   ```
3. Run the backend server (the app will automatically create your `.env` file from `.env.example` if missing): 
   ```bash
   python app.py
   ```

Open your web browser and navigate to: **`http://localhost:5000`**
