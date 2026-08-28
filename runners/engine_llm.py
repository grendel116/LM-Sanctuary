"""
runners/engine_llm.py — In-process native GGUF LLM engine using llama-cpp-python.

Eliminates the need for external processes (LM Studio, llama-server.exe)
by executing models directly in-process with C/CUDA acceleration, thread-safe
token streaming, and dynamic GGUF model discovery in models/llm/.
"""

import os
import gc
import threading
import time
from typing import Generator, List, Dict, Any, Optional

from variables.settings import LLM_MODELS_DIR, MODELS_DIR

_model_lock = threading.Lock()
_active_llm = None
_active_model_name: Optional[str] = None
_active_model_path: Optional[str] = None


def list_gguf_models() -> List[Dict[str, Any]]:
    """Scans models/llm and models/ for user-placed GGUF models."""
    models = []
    seen = set()

    for search_dir in (LLM_MODELS_DIR, MODELS_DIR):
        if not os.path.exists(search_dir):
            continue
        try:
            for root, _, files in os.walk(search_dir):
                for f in files:
                    if f.lower().endswith(".gguf") and f not in seen:
                        seen.add(f)
                        full_path = os.path.join(root, f)
                        size_gb = round(os.path.getsize(full_path) / (1024 ** 3), 2)
                        models.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_gb": size_gb,
                            "folder": os.path.relpath(root, MODELS_DIR)
                        })
        except Exception as e:
            print(f"[engine_llm] Error scanning directory {search_dir}: {e}")

    return sorted(models, key=lambda x: x["name"])


def resolve_model_path(model_name: str) -> Optional[str]:
    """Finds the full absolute path of a GGUF model by filename or full path."""
    if not model_name:
        return None
    if os.path.isabs(model_name) and os.path.exists(model_name):
        return model_name

    for item in list_gguf_models():
        if item["name"].lower() == model_name.lower() or item["filename"].lower() == model_name.lower():
            return item["path"]

    # Direct check inside LLM_MODELS_DIR
    direct = os.path.join(LLM_MODELS_DIR, model_name)
    if os.path.exists(direct):
        return direct
    if not model_name.lower().endswith(".gguf"):
        direct_gguf = os.path.join(LLM_MODELS_DIR, f"{model_name}.gguf")
        if os.path.exists(direct_gguf):
            return direct_gguf

    return None


def is_loaded() -> bool:
    """Returns True if a model is currently loaded in memory."""
    return _active_llm is not None


def get_loaded_model_name() -> Optional[str]:
    """Returns the name of the currently loaded model."""
    return _active_model_name


def unload_model() -> bool:
    """Unloads the active model and releases GPU/RAM memory."""
    global _active_llm, _active_model_name, _active_model_path
    with _model_lock:
        if _active_llm is not None:
            del _active_llm
            _active_llm = None
            _active_model_name = None
            _active_model_path = None
            gc.collect()
            print("[engine_llm] Model successfully unloaded from memory.")
            return True
    return False


def load_model(
    model_name_or_path: str,
    n_ctx: Optional[int] = None,
    n_gpu_layers: Optional[int] = None,
    n_threads: Optional[int] = None,
    verbose: bool = False
) -> tuple[bool, str]:
    """Loads a GGUF model into memory using llama-cpp-python."""
    global _active_llm, _active_model_name, _active_model_path

    if n_ctx is None:
        try:
            n_ctx = int(os.getenv("LOCAL_CONTEXT", "16384"))
        except Exception:
            n_ctx = 16384

    if n_gpu_layers is None:
        try:
            n_gpu_layers = int(os.getenv("LOCAL_GPU_LAYERS", "99"))
        except Exception:
            n_gpu_layers = -1

    path = resolve_model_path(model_name_or_path)
    if not path or not os.path.exists(path):
        return False, f"Model file not found: '{model_name_or_path}'. Place .gguf files in models/llm/."

    with _model_lock:
        if _active_model_path == path and _active_llm is not None:
            # Check if active model already has requested context size
            if getattr(_active_llm, "n_ctx", lambda: None)() == n_ctx:
                return True, f"Model '{os.path.basename(path)}' is already loaded."

        try:
            import llama_cpp
        except ImportError:
            return False, "llama-cpp-python is not installed. Please install llama-cpp-python."

        # Unload previous model before loading new one
        if _active_llm is not None:
            del _active_llm
            _active_llm = None
            gc.collect()

        try:
            flash_attn = os.getenv("LOCAL_FLASH_ATTN", "true").lower() == "true"
            print(f"[engine_llm] Loading GGUF model: {path} (n_ctx={n_ctx}, n_gpu_layers={n_gpu_layers}, flash_attn={flash_attn})...")
            
            kwargs = {
                "model_path": path,
                "n_ctx": n_ctx,
                "n_gpu_layers": n_gpu_layers,
                "n_threads": n_threads or max(1, (os.cpu_count() or 4) - 1),
                "verbose": verbose
            }
            try:
                llm = llama_cpp.Llama(**kwargs, flash_attn=flash_attn)
            except Exception:
                # Fallback if flash_attn is not supported on this backend build
                llm = llama_cpp.Llama(**kwargs)

            _active_llm = llm
            _active_model_name = os.path.basename(path)
            _active_model_path = path
            print(f"[engine_llm] Model '{_active_model_name}' loaded successfully into memory (Context: {n_ctx}).")
            return True, f"Model '{_active_model_name}' loaded successfully (Context: {n_ctx})."
        except Exception as e:
            _active_llm = None
            _active_model_name = None
            _active_model_path = None
            gc.collect()
            print(f"[engine_llm] Error loading model {path}: {e}")
            return False, f"Failed to load GGUF model: {str(e)}"


def stream_chat(
    messages: List[Dict[str, str]],
    temperature: float = 0.7,
    max_tokens: int = 1024,
    stop: Optional[List[str]] = None,
    top_p: float = 0.9,
    repeat_penalty: float = 1.1
) -> Generator[str, None, None]:
    """Generates streaming tokens from the in-process model for chat messages with automatic context pruning."""
    global _active_llm

    if _active_llm is None:
        # Try to auto-load first available model in models/llm
        available = list_gguf_models()
        if available:
            success, msg = load_model(available[0]["path"])
            if not success:
                yield f"[Error: {msg}]"
                return
        else:
            yield "[Error: No GGUF model loaded. Please place a .gguf model in models/llm/.]"
            return

    stop_tokens = stop or ["<|im_end|>", "<|eot_id|>", "</s>", "User:", "\nUser:", "### User:"]
    curr_messages = list(messages)
    max_retries = 6

    for attempt in range(max_retries):
        try:
            response_stream = _active_llm.create_chat_completion(
                messages=curr_messages,
                temperature=temperature,
                max_tokens=max_tokens,
                top_p=top_p,
                repeat_penalty=repeat_penalty,
                stop=stop_tokens,
                stream=True
            )

            for chunk in response_stream:
                choices = chunk.get("choices", [])
                if choices:
                    delta = choices[0].get("delta", {})
                    content = delta.get("content")
                    if content:
                        yield content
            return

        except Exception as e:
            err_str = str(e)
            if "exceed" in err_str.lower() and "context" in err_str.lower():
                # Prune oldest non-system turn to fit context window
                print(f"[engine_llm] Context exceeded ({len(curr_messages)} messages). Auto-pruning oldest history turn...")
                if len(curr_messages) > 2:
                    removed = False
                    for idx in range(len(curr_messages)):
                        if curr_messages[idx].get("role") != "system":
                            curr_messages.pop(idx)
                            if idx < len(curr_messages) and curr_messages[idx].get("role") != "system":
                                curr_messages.pop(idx)
                            removed = True
                            break
                    if removed:
                        continue
            print(f"[engine_llm] Inference error: {e}")
            yield f"\n[Inference Error: {str(e)}]"
            return



def generate_text(
    prompt_or_messages: Any,
    temperature: float = 0.7,
    max_tokens: int = 512,
    stop: Optional[List[str]] = None
) -> str:
    """Non-streaming text generation for auxiliary tasks (mood inversion, summaries, thoughts)."""
    global _active_llm

    if _active_llm is None:
        available = list_gguf_models()
        if available:
            load_model(available[0]["path"])
        else:
            return ""

    if isinstance(prompt_or_messages, list):
        full_text = ""
        for token in stream_chat(prompt_or_messages, temperature=temperature, max_tokens=max_tokens, stop=stop):
            full_text += token
        return full_text
    else:
        try:
            out = _active_llm(
                str(prompt_or_messages),
                max_tokens=max_tokens,
                temperature=temperature,
                stop=stop or ["\n\n", "</s>"]
            )
            return out.get("choices", [{}])[0].get("text", "")
        except Exception as e:
            print(f"[engine_llm] Generate text error: {e}")
            return ""
