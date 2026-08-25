import os
from dotenv import load_dotenv

# Base directory of the Sanctuary application
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(BASE_DIR, ".env"), override=True)

# Variables directory path
VARIABLES_DIR = os.path.dirname(os.path.abspath(__file__))

# Configuration and data file paths
BANNED_WORDS_FILE = os.path.join(VARIABLES_DIR, "banned_words.json")
USER_MD_FILE = os.path.join(VARIABLES_DIR, "user.md")
USER_PROFILES_DIR = os.path.join(VARIABLES_DIR, "user_profiles")

# Model and server configurations
DEFAULT_REMOTE_MODEL = os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite")
DEFAULT_LOCAL_MODEL = "local-llm"
REMOTE_SERVER_URL = os.getenv("REMOTE_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
REMOTE_API_KEY = os.getenv("REMOTE_API_KEY")
REMOTE_CLOUD_URL = os.getenv("REMOTE_CLOUD_URL")

import os

# Ensure it pulls from the environment (with a sensible local fallback if needed)
LOCAL_SERVER_URL = os.getenv("LOCAL_SERVER_URL", "http://localhost:8080")

# If you also need the headers function referenced in the traceback:
def get_local_server_headers():
    headers = {"Content-Type": "application/json"}
    api_key = os.getenv("LOCAL_SERVER_API_KEY")
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers

def get_remote_server_headers():
    headers = {"Content-Type": "application/json"}
    if REMOTE_API_KEY:
        headers["Authorization"] = f"Bearer {REMOTE_API_KEY}"
    return headers

# Thinking configuration for LLM requests
DISABLED_THINKING = {
    "thinking": {"type": "disabled"},
    "reasoning_budget": 0
}

def is_thinking_enabled(is_cloud: bool = False) -> bool:
    env_val = os.getenv("THINKING_ENABLED")
    if env_val is not None:
        return env_val.lower() in ("true", "1", "yes")
    return True if is_cloud else False

# Dynamically derive models URL from REMOTE_SERVER_URL
try:
    from urllib.parse import urlparse
    _parsed = urlparse(REMOTE_SERVER_URL)
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
PROGRAMS_DIR = os.path.join(BASE_DIR, "core", "programs")
PROGRAMS_DIR = PROGRAMS_DIR

