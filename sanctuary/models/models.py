import sys
import os
import requests
import time

# Ensure the parent directory is in sys.path so we can import variables package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from variables.settings import LOCAL_MODELS_URL

_local_models_cache = None
_last_fetch_time = 0.0
CACHE_TTL = 5.0  # 5 seconds cache


def fetch_local_models(force_refresh=False) -> list:
    """Queries Local LLM server for loaded models. Returns empty list if offline (cached)."""
    global _local_models_cache, _last_fetch_time
    now = time.time()
    if not force_refresh and _local_models_cache is not None and (now - _last_fetch_time < CACHE_TTL):
        return _local_models_cache

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
        if isinstance(e, (requests.exceptions.ConnectionError, requests.exceptions.Timeout)):
            print(f"[Local LLM] Offline or unreachable at {LOCAL_MODELS_URL} (Server is not running or unreachable)")
        else:
            print(f"[Local LLM] Offline or unreachable at {LOCAL_MODELS_URL}: {e}")
        _local_models_cache = []
        _last_fetch_time = now
        return []
