import sys
import os
import requests
import time

# Ensure the parent directory is in sys.path so we can import variables package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from variables import LOCAL_MODELS_URL, DEFAULT_LOCAL_MODEL

_local_models_cache = None
_last_fetch_time = 0.0
CACHE_TTL = 5.0  # 5 seconds cache

def fetch_local_models(force_refresh=False) -> list:
    """Queries Local LLM server for loaded models. Returns empty list if offline (cached)."""
    global _local_models_cache, _last_fetch_time
    now = time.time()
    if not force_refresh and _local_models_cache is not None and (now - _last_fetch_time < CACHE_TTL):
        return _local_models_cache

    # Try using native REST API GET /api/v1/models to see which ones are loaded
    try:
        response = requests.get("http://127.0.0.1:1234/api/v1/models", timeout=0.2)
        if response.status_code == 200:
            local_models = []
            for m in response.json().get("models", []):
                # Only include loaded chat/LLM models, filter out embeddings
                if m.get("type") == "llm" and len(m.get("loaded_instances", [])) > 0:
                    model_id = m.get("key")
                    disp = m.get("display_name") or model_id.split("/")[-1]
                    local_models.append({"value": model_id, "label": f"{disp} (Local)"})
            _local_models_cache = local_models
            _last_fetch_time = now
            return local_models
    except Exception as e:
        if isinstance(e, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)):
            print("[Local LLM] Native models listing offline (Server is not running or unreachable)")
        else:
            print(f"[Local LLM] Native models listing offline: {e}")

    # Fallback to standard OpenAI compatibility endpoint /v1/models
    try:
        response = requests.get(LOCAL_MODELS_URL, timeout=0.2)
        response.raise_for_status()
        data = response.json()
        models_data = data.get("data", [])
        local_models = []
        for m in models_data:
            model_id = m.get("id")
            if model_id:
                model_id_lower = model_id.lower()
                # Filter out embedding models
                if "embed" in model_id_lower or "nomic" in model_id_lower:
                    continue
                display_name = model_id.split("/")[-1] if "/" in model_id else model_id
                local_models.append({"value": model_id, "label": f"{display_name} (Local)"})
        _local_models_cache = local_models
        _last_fetch_time = now
        return local_models
    except Exception as e:
        # Gracefully handle offline Local LLM server
        if isinstance(e, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)):
            print(f"[Local LLM] Offline or unreachable at {LOCAL_MODELS_URL} (Server is not running or unreachable)")
        else:
            print(f"[Local LLM] Offline or unreachable at {LOCAL_MODELS_URL}: {e}")
        _local_models_cache = []
        _last_fetch_time = now
        return []

def is_local_model(model: str) -> bool:
    """Determines if a model is local by checking name format, env vars, or active list."""
    if not model:
        return False
    m_norm = model.replace('\\', '/').strip().lower()
    local_env = os.getenv("LOCAL_MODEL_NAME", "").replace('\\', '/').strip().lower()
    if m_norm in ("local-llm", local_env) or m_norm.endswith(".gguf") or m_norm.endswith(".bin"):
        return True
    try:
        loaded_models = fetch_local_models()
        return any(m_norm == m["value"].replace('\\', '/').strip().lower() for m in loaded_models)
    except Exception:
        pass
    return False

