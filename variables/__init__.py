import os

# Base directory of the Sanctuary application
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Variables directory path
VARIABLES_DIR = os.path.dirname(os.path.abspath(__file__))

# Configuration and data file paths
BANNED_WORDS_FILE = os.path.join(VARIABLES_DIR, "banned_words.json")
ACTIVE_AGENT_FILE = os.path.join(VARIABLES_DIR, "active_agent.txt")
USER_MD_FILE = os.path.join(VARIABLES_DIR, "user.md")
USER_PROFILES_DIR = os.path.join(VARIABLES_DIR, "user_profiles")
ACTIVE_USER_FILE = os.path.join(VARIABLES_DIR, "active_user.txt")

# Model and server configurations
DEFAULT_GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.1-flash-lite")
DEFAULT_LOCAL_MODEL = "local-lm-studio"
LOCAL_SERVER_URL = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")

# Dynamically derive models URL from LOCAL_SERVER_URL
try:
    from urllib.parse import urlparse
    _parsed = urlparse(LOCAL_SERVER_URL)
    if _parsed.path.endswith('/chat/completions'):
        _base_path = _parsed.path.rsplit('/chat/completions', 1)[0]
    else:
        _base_path = '/v1'
    LOCAL_MODELS_URL = f"{_parsed.scheme}://{_parsed.netloc}{_base_path}/models"
except Exception:
    LOCAL_MODELS_URL = "http://127.0.0.1:1234/v1/models"


# ComfyUI Image Generation configurations
COMFYUI_SERVER_URL = os.getenv("COMFYUI_SERVER_URL", "http://127.0.0.1:8188")
_env_comfyui_dir = os.getenv("COMFYUI_DIR")
COMFYUI_DIR = _env_comfyui_dir.strip() if (_env_comfyui_dir and _env_comfyui_dir.strip()) else os.path.normpath(os.path.join(BASE_DIR, "..", "ComfyUI"))
COMFYUI_CHECKPOINT = os.getenv("COMFYUI_CHECKPOINT", "sd_xl_base_1.0.safetensors")
COMFYUI_VAE = os.getenv("COMFYUI_VAE", "sdxl_vae.safetensors")

# Shared directory paths
AGENTS_DIR = os.path.join(BASE_DIR, "core", "agents")
AGENTS_DIR = AGENTS_DIR

