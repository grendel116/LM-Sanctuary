"""
adapters/vram_orchestrator.py — Consolidated GPU VRAM Resource Orchestrator.

Enforces strict mutual exclusivity between Text Mode (LLM) and Image Mode (SDXL Diffusion),
ensuring only one engine occupies GPU VRAM at any given time.
"""

import asyncio
import functools
import threading
from typing import Optional

_orchestrator_lock = threading.RLock()
_current_mode: Optional[str] = None  # "LLM" | "IMG" | None


def serialized_gpu_operation(func):
    """Keep mode transitions from interrupting an active GPU operation."""
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        with _orchestrator_lock:
            return func(*args, **kwargs)
    return wrapper


def start_img(cancel_event: Optional[threading.Event] = None) -> bool:
    """Activates Image Mode by suspending the local LLM server and starting the persistent
    diffusion worker. Diffusion models remain cached across image generations until Text Mode is explicitly activated.
    """
    global _current_mode
    with _orchestrator_lock:
        from runners import local_server
        from core import engine_diffusion

        llm_process_running = local_server._proc is not None and local_server._proc.poll() is None
        worker = engine_diffusion._server_proc
        worker_running = worker is not None and worker.poll() is None

        # Already in image mode: both processes are ours, so their handles answer without HTTP probes.
        if _current_mode == "IMG" and worker_running and not llm_process_running:
            return True

        llm_online = local_server.check_local_server_status()
        server_online = engine_diffusion.check_server_status()
        if _current_mode == "IMG" and not llm_online and not llm_process_running and server_online:
            return True

        print("[VRAM Orchestrator] Switching to Image Mode: Stopping local LLM and activating diffusion engine...", flush=True)
        if llm_online or llm_process_running or _current_mode != "IMG":
            stopped, message = local_server.stop_local_server()
            if not stopped:
                raise RuntimeError(f"Could not stop local LLM before image generation: {message}")

        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("Image generation cancelled.")
        if not engine_diffusion.ensure_server_running(cancel_event=cancel_event):
            raise RuntimeError("Could not start diffusion worker for image generation.")

        _current_mode = "IMG"
        return True


def start_llm(model_key: Optional[str] = None, timeout: float = 120.0, _cancelled: Optional[threading.Event] = None) -> bool:
    """Activates Text Mode by unloading all diffusion models and ensuring the local
    LLM server is running and serving the requested model.
    """
    global _current_mode
    with _orchestrator_lock:
        if _cancelled is not None and _cancelled.is_set():
            return False
        from runners import local_server
        if _current_mode == "LLM" and local_server.is_model_loaded(model_key):
            return True

        print(f"[VRAM Orchestrator] Switching to Text Mode (model: {model_key or 'default'})...", flush=True)

        # 1. Clear diffusion caches so GPU memory is 100% available for LLM
        try:
            from core import engine_diffusion
            engine_diffusion.unload_diffusion_models()
        except Exception as e:
            print(f"[VRAM Orchestrator] Failed to clear diffusion models: {e}", flush=True)
            return False

        # 2. Boot and verify local LLM server with requested model
        success = local_server.ensure_server_online(model_key, timeout=timeout)
        if success:
            _current_mode = "LLM"
        return success


async def start_llm_async(model_key: Optional[str] = None, timeout: float = 120.0) -> bool:
    """Wait for the same serialized transition without blocking the event loop."""
    cancelled = threading.Event()
    try:
        return await asyncio.to_thread(start_llm, model_key, timeout, cancelled)
    except asyncio.CancelledError:
        cancelled.set()
        raise


def get_current_mode() -> Optional[str]:
    """Returns current active VRAM mode: 'LLM', 'IMG', or None."""
    return _current_mode
