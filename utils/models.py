import sys
import os
import requests

# Ensure the parent directory is in sys.path so we can import variables package
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from variables import LOCAL_MODELS_URL, DEFAULT_LOCAL_MODEL

def fetch_local_models() -> list:
    """Queries LM Studio for loaded models. Returns empty list if offline."""
    import subprocess
    import json
    
    # Try using lms CLI first for precise in-memory loaded status
    try:
        from utils.lms_manager import get_lms_path, check_lms_cli
        if check_lms_cli():
            lms_path = get_lms_path()
            res = subprocess.run([lms_path, "ps", "--json"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False, timeout=5)
            if res.returncode == 0:
                stdout_str = res.stdout.strip()
                if stdout_str:
                    loaded_data = json.loads(stdout_str)
                    local_models = []
                    for m in loaded_data:
                        model_id = m.get("identifier") or m.get("modelKey")
                        if model_id:
                            model_id_lower = model_id.lower()
                            if "embed" in model_id_lower or "nomic" in model_id_lower:
                                continue
                            disp = m.get("displayName") or model_id.split("/")[-1]
                            local_models.append({"value": model_id, "label": f"{disp} (Local)"})
                    return local_models
    except Exception as e:
        print(f"[LM Studio] Error querying loaded models via CLI: {e}")

    # Fallback to HTTP endpoint
    try:
        response = requests.get(LOCAL_MODELS_URL, timeout=0.5)
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
        return local_models
    except Exception as e:
        # Gracefully handle offline LM Studio
        print(f"[LM Studio] Offline or unreachable at {LOCAL_MODELS_URL}: {e}")
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
