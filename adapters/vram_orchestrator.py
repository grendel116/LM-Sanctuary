"""
adapters/vram_orchestrator.py — Consolidated GPU VRAM Resource Orchestrator.

Enforces strict mutual exclusivity between Text Mode (LLM) and Image Mode (SDXL Diffusion),
ensuring only one engine occupies GPU VRAM at any given time.
"""

import threading
from typing import Optional

_orchestrator_lock = threading.Lock()
_current_mode: Optional[str] = None  # "LLM" | "IMG" | None


def start_img() -> bool:
    """Activates Image Mode by suspending the local LLM server and starting the persistent
    diffusion daemon. Diffusion models remain cached across image generations until Text Mode is explicitly activated.
    """
    global _current_mode
    with _orchestrator_lock:
        if _current_mode == "IMG":
            return True

        print("[VRAM Orchestrator] Switching to Image Mode: Stopping local LLM and starting diffusion daemon...", flush=True)
        try:
            from adapters import local_llm_manager
            local_llm_manager.stop_server()
        except Exception as e:
            print(f"[VRAM Orchestrator] Note stopping local LLM: {e}", flush=True)

        try:
            from runners import engine_llm
            if engine_llm.is_loaded():
                engine_llm.unload_model()
        except Exception:
            pass

        try:
            from core import engine_diffusion
            engine_diffusion.ensure_daemon_running()
        except Exception as e:
            print(f"[VRAM Orchestrator] Note starting diffusion daemon: {e}", flush=True)

        _current_mode = "IMG"
        return True


def start_llm(model_key: Optional[str] = None, timeout: float = 120.0) -> bool:
    """Activates Text Mode by unloading all diffusion models and ensuring the local
    LLM server is running and serving the requested model.
    """
    global _current_mode
    with _orchestrator_lock:
        from runners import local_server
        if _current_mode == "LLM" and local_server.is_model_loaded(model_key):
            return True

        print(f"[VRAM Orchestrator] Switching to Text Mode (model: {model_key or 'default'})...", flush=True)

        # 1. Clear diffusion caches so GPU memory is 100% available for LLM
        try:
            from core import engine_diffusion
            engine_diffusion.unload_diffusion_models()
        except Exception as e:
            print(f"[VRAM Orchestrator] Note clearing diffusion models: {e}", flush=True)

        # 2. Boot and verify local LLM server with requested model
        success = local_server.ensure_server_online(model_key, timeout=timeout)
        if success:
            _current_mode = "LLM"
        return success


async def start_llm_async(model_key: Optional[str] = None, timeout: float = 120.0) -> bool:
    """Async variant of start_llm that yields control via asyncio."""
    global _current_mode
    from runners import local_server
    if _current_mode == "LLM" and local_server.is_model_loaded(model_key):
        return True

    print(f"[VRAM Orchestrator] Switching to Text Mode async (model: {model_key or 'default'})...", flush=True)

    try:
        from core import engine_diffusion
        engine_diffusion.unload_diffusion_models()
    except Exception as e:
        print(f"[VRAM Orchestrator] Note clearing diffusion models: {e}", flush=True)

    success = await local_server.ensure_server_online_async(model_key, timeout=timeout)
    if success:
        _current_mode = "LLM"
    return success


def get_current_mode() -> Optional[str]:
    """Returns current active VRAM mode: 'LLM', 'IMG', or None."""
    return _current_mode

