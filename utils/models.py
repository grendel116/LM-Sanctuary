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
    """Queries LM Studio for loaded models. Returns empty list if offline (cached)."""
    global _local_models_cache, _last_fetch_time
    now = time.time()
    if not force_refresh and _local_models_cache is not None and (now - _last_fetch_time < CACHE_TTL):
        return _local_models_cache

    # Try using native REST API GET /api/v1/models to see which ones are loaded
    try:
        response = requests.get("http://localhost:1234/api/v1/models", timeout=0.2)
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
        print(f"[LM Studio] Native models listing offline: {e}")

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
        # Gracefully handle offline LM Studio
        print(f"[LM Studio] Offline or unreachable at {LOCAL_MODELS_URL}: {e}")
        _local_models_cache = []
        _last_fetch_time = now
        return []

def is_local_model(model: str) -> bool:
    """Determines if a model is local by querying LM Studio's active list."""
    if not model:
        return False
    if model == DEFAULT_LOCAL_MODEL:
        return True
    try:
        loaded_models = fetch_local_models()
        loaded_ids = [m["value"] for m in loaded_models]
        return model in loaded_ids
    except Exception:
        pass
    return False

