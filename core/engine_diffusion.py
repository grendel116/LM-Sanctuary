"""
core/engine_diffusion.py — Internal GPU-accelerated diffusion engine.

Executes SDXL image generation directly in-process with PyTorch/GPU acceleration,
running the node graph from models/workflows/ImageWorkflow.json.
"""

import os
import sys
import gc
import json
import copy
import time
import random
import threading
import subprocess
from typing import List, Dict, Any, Optional, Tuple, Callable

from variables.settings import CHECKPOINTS_DIR, LORAS_DIR, VAE_DIR, MODELS_DIR, WORKFLOWS_DIR, get_workflow_path
from utils import lifecycle


def _sanitize_windows_gpu_env(env_map: Any) -> None:
    """Normalizes GPU allocator, OpenMP, and AOTriton settings on Windows before PyTorch initializes."""
    if os.name != "nt":
        return
    env_map.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
    env_map.setdefault("TORCH_ROCM_AOTRITON_ENABLE_EXPERIMENTAL", "0")
    raw_conf = (
        env_map.get("PYTORCH_ALLOC_CONF")
        or env_map.get("PYTORCH_HIP_ALLOC_CONF")
        or env_map.get("PYTORCH_CUDA_ALLOC_CONF")
        or ""
    )
    parts = [
        tok.strip()
        for tok in raw_conf.split(",")
        if tok.strip() and not tok.strip().lower().startswith("expandable_segments")
    ]
    if not any(p.lower().startswith("garbage_collection_threshold") for p in parts):
        parts.insert(0, "garbage_collection_threshold:0.8")
    if not any(p.lower().startswith("max_split_size_mb") for p in parts):
        parts.append("max_split_size_mb:512")
    env_map["PYTORCH_ALLOC_CONF"] = ",".join(parts)
    env_map.pop("PYTORCH_CUDA_ALLOC_CONF", None)
    env_map.pop("PYTORCH_HIP_ALLOC_CONF", None)


_sanitize_windows_gpu_env(os.environ)

_diffusion_lock = threading.Lock()
_active_checkpoint: Optional[str] = None
_active_workflow: Optional[str] = None
_COMFY_NODE_CACHE: Dict[Tuple[Any, ...], Any] = {}
_custom_nodes_loaded = False
_runtime_configured = False
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _persist_checkpoint_to_env(checkpoint_name: str) -> None:
    """Updates COMFYUI_CHECKPOINT in the .env configuration file."""
    try:
        env_file = os.path.join(root_dir, ".env")
        if not os.path.exists(env_file):
            return
        with open(env_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        updated = False
        for i, line in enumerate(lines):
            if line.strip().startswith("COMFYUI_CHECKPOINT="):
                lines[i] = f"COMFYUI_CHECKPOINT={checkpoint_name}\n"
                updated = True
                break
        if not updated:
            lines.append(f"\nCOMFYUI_CHECKPOINT={checkpoint_name}\n")
        with open(env_file, "w", encoding="utf-8") as f:
            f.writelines(lines)
    except Exception as e:
        print(f"[engine_diffusion] Warning persisting checkpoint to .env: {e}")


def _persist_workflow_to_env(workflow_name: str) -> None:
    """Updates COMFYUI_IMAGE_WORKFLOW in the .env configuration file."""
    try:
        env_file = os.path.join(root_dir, ".env")
        if not os.path.exists(env_file):
            return
        with open(env_file, "r", encoding="utf-8") as f:
            lines = f.readlines()
        updated = False
        for i, line in enumerate(lines):
            if line.strip().startswith("COMFYUI_IMAGE_WORKFLOW="):
                lines[i] = f"COMFYUI_IMAGE_WORKFLOW={workflow_name}\n"
                updated = True
                break
        if not updated:
            lines.append(f"\nCOMFYUI_IMAGE_WORKFLOW={workflow_name}\n")
        with open(env_file, "w", encoding="utf-8") as f:
            f.writelines(lines)
    except Exception as e:
        print(f"[engine_diffusion] Warning persisting workflow to .env: {e}")


def resolve_checkpoint_path(checkpoint_name: Optional[str] = None) -> str:
    """Resolves the absolute path to the requested, active, or configured checkpoint model."""
    if not checkpoint_name:
        checkpoint_name = _active_checkpoint or os.getenv("COMFYUI_CHECKPOINT")

    if checkpoint_name and os.path.isabs(checkpoint_name) and os.path.exists(checkpoint_name):
        return checkpoint_name

    candidates = []
    if checkpoint_name:
        candidates.append(os.path.join(CHECKPOINTS_DIR, checkpoint_name))
        candidates.append(os.path.join(MODELS_DIR, checkpoint_name))
        candidates.append(os.path.join(MODELS_DIR, "checkpoints", checkpoint_name))

    env_ckpt = os.getenv("COMFYUI_CHECKPOINT")
    if env_ckpt and env_ckpt != checkpoint_name:
        candidates.append(os.path.join(CHECKPOINTS_DIR, env_ckpt))
        candidates.append(os.path.join(MODELS_DIR, env_ckpt))

    for path in candidates:
        if os.path.exists(path):
            return path

    if os.path.exists(CHECKPOINTS_DIR):
        for f in os.listdir(CHECKPOINTS_DIR):
            if f.lower().endswith((".safetensors", ".ckpt")) and not f.startswith("."):
                return os.path.join(CHECKPOINTS_DIR, f)

    if os.path.exists(MODELS_DIR):
        for f in os.listdir(MODELS_DIR):
            if f.lower().endswith((".safetensors", ".ckpt")) and not f.startswith("."):
                return os.path.join(MODELS_DIR, f)

    raise FileNotFoundError(f"No checkpoint models found in {CHECKPOINTS_DIR} or {MODELS_DIR}.")


def resolve_lora_path(lora_name: str) -> Optional[str]:
    """Resolves absolute path to a LoRA weights file."""
    if os.path.exists(lora_name):
        return lora_name

    candidates = [
        os.path.join(LORAS_DIR, lora_name),
        os.path.join(MODELS_DIR, "loras", lora_name),
        os.path.join(MODELS_DIR, lora_name)
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def list_checkpoints() -> List[Dict[str, Any]]:
    """Lists all available SafeTensors/checkpoint files in models/checkpoints."""
    ckpts = []
    seen = set()
    if os.path.exists(CHECKPOINTS_DIR):
        try:
            for root, _, files in os.walk(CHECKPOINTS_DIR):
                for f in files:
                    if f.lower().endswith((".safetensors", ".ckpt")) and not f.startswith("."):
                        full_path = os.path.join(root, f)
                        if full_path in seen:
                            continue
                        seen.add(full_path)
                        size_gb = round(os.path.getsize(full_path) / (1024 ** 3), 2)
                        ckpts.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_gb": size_gb,
                            "folder": "checkpoints"
                        })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning checkpoints in {CHECKPOINTS_DIR}: {e}")

    if os.path.exists(MODELS_DIR):
        try:
            for f in os.listdir(MODELS_DIR):
                full_path = os.path.join(MODELS_DIR, f)
                if os.path.isfile(full_path) and f.lower().endswith((".safetensors", ".ckpt")) and not f.startswith("."):
                    if full_path in seen:
                        continue
                    seen.add(full_path)
                    size_gb = round(os.path.getsize(full_path) / (1024 ** 3), 2)
                    ckpts.append({
                        "name": f,
                        "filename": f,
                        "path": full_path,
                        "size_gb": size_gb,
                        "folder": "models"
                    })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning root MODELS_DIR: {e}")

    return sorted(ckpts, key=lambda x: x["name"])


def list_loras() -> List[Dict[str, Any]]:
    """Lists all available LoRAs in models/loras."""
    loras = []
    search_dirs = [LORAS_DIR, os.path.join(MODELS_DIR, "loras")]
    seen = set()
    for s_dir in search_dirs:
        if not os.path.exists(s_dir):
            continue
        try:
            for root, _, files in os.walk(s_dir):
                for f in files:
                    if f.lower().endswith((".safetensors", ".ckpt", ".pt")) and not f.startswith("."):
                        full_path = os.path.join(root, f)
                        if full_path in seen:
                            continue
                        seen.add(full_path)
                        size_mb = round(os.path.getsize(full_path) / (1024 ** 2), 1)
                        loras.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_mb": size_mb,
                            "folder": os.path.relpath(root, MODELS_DIR)
                        })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning LoRAs in {s_dir}: {e}")
    return sorted(loras, key=lambda x: x["name"])


def list_vaes() -> List[Dict[str, Any]]:
    """Lists all available VAE weights in models/vae."""
    vaes = []
    search_dirs = [VAE_DIR, os.path.join(MODELS_DIR, "vae")]
    seen = set()
    for s_dir in search_dirs:
        if not os.path.exists(s_dir):
            continue
        try:
            for root, _, files in os.walk(s_dir):
                for f in files:
                    if f.lower().endswith((".safetensors", ".pt", ".bin")) and not f.startswith("."):
                        full_path = os.path.join(root, f)
                        if full_path in seen:
                            continue
                        seen.add(full_path)
                        size_mb = round(os.path.getsize(full_path) / (1024 ** 2), 1)
                        vaes.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_mb": size_mb,
                            "folder": os.path.relpath(root, MODELS_DIR)
                        })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning VAEs in {s_dir}: {e}")
    return sorted(vaes, key=lambda x: x["name"])


def get_active_checkpoint() -> Optional[str]:
    """Returns the name of the currently selected checkpoint."""
    global _active_checkpoint
    if _active_checkpoint and os.path.exists(_active_checkpoint):
        return os.path.basename(_active_checkpoint)

    env_ckpt = os.getenv("COMFYUI_CHECKPOINT")
    if env_ckpt:
        try:
            resolved = resolve_checkpoint_path(env_ckpt)
            if resolved and os.path.exists(resolved):
                _active_checkpoint = resolved
                return os.path.basename(resolved)
        except Exception:
            pass

    ckpts = list_checkpoints()
    for c in ckpts:
        if "illustrious" in c["filename"].lower() or "sdxl" in c["filename"].lower():
            _active_checkpoint = c["path"]
            return c["filename"]
    if ckpts:
        _active_checkpoint = ckpts[0]["path"]
        return ckpts[0]["filename"]
    return None


def set_active_checkpoint(checkpoint_name: str) -> bool:
    """Sets the active diffusion checkpoint and persists it to environment and .env."""
    global _active_checkpoint, _COMFY_NODE_CACHE
    try:
        resolved = resolve_checkpoint_path(checkpoint_name)
        _active_checkpoint = resolved
        filename = os.path.basename(resolved)
        os.environ["COMFYUI_CHECKPOINT"] = filename
        
        # Clear cached checkpoint and dependent LoRAs/CLIP encodings if switched
        for key in list(_COMFY_NODE_CACHE.keys()):
            if key[0] in ("CheckpointLoaderSimple", "LoraLoader", "CLIPTextEncode"):
                del _COMFY_NODE_CACHE[key]

        _persist_checkpoint_to_env(filename)
        print(f"[engine_diffusion] Active checkpoint set to: {filename}")
        return True
    except Exception as e:
        print(f"[engine_diffusion] Failed to set active checkpoint: {e}")
        return False


def list_workflows() -> List[Dict[str, Any]]:
    """Lists all available image workflow JSON templates in models/workflows."""
    workflows = []
    if not os.path.exists(WORKFLOWS_DIR):
        return workflows
    try:
        for f in os.listdir(WORKFLOWS_DIR):
            if f.lower().endswith(".json") and not f.startswith("."):
                if f.lower().startswith("video"):
                    continue
                full_path = os.path.join(WORKFLOWS_DIR, f)
                if os.path.isfile(full_path):
                    size_kb = round(os.path.getsize(full_path) / 1024, 1)
                    display_name = os.path.splitext(f)[0]
                    workflows.append({
                        "name": display_name,
                        "filename": f,
                        "path": full_path,
                        "size_kb": size_kb
                    })
    except Exception as e:
        print(f"[engine_diffusion] Error scanning workflows in {WORKFLOWS_DIR}: {e}")
    return sorted(workflows, key=lambda x: (x["filename"] != "ImageWorkflow.json", x["name"].lower()))


def get_active_workflow() -> str:
    """Returns the filename of the currently selected image workflow."""
    global _active_workflow
    if _active_workflow and os.path.exists(_active_workflow):
        return os.path.basename(_active_workflow)

    env_wf = os.getenv("COMFYUI_IMAGE_WORKFLOW")
    if env_wf:
        resolved = os.path.join(WORKFLOWS_DIR, os.path.basename(env_wf))
        if os.path.exists(resolved):
            _active_workflow = resolved
            return os.path.basename(resolved)

    default_wf = os.path.join(WORKFLOWS_DIR, "ImageWorkflow.json")
    if os.path.exists(default_wf):
        _active_workflow = default_wf
        return "ImageWorkflow.json"

    wfs = list_workflows()
    if wfs:
        _active_workflow = wfs[0]["path"]
        return wfs[0]["filename"]

    return "ImageWorkflow.json"


def set_active_workflow(workflow_name: str) -> bool:
    """Sets the active image workflow and persists it to environment and .env."""
    global _active_workflow
    try:
        filename = os.path.basename(workflow_name)
        resolved = os.path.join(WORKFLOWS_DIR, filename)
        if not os.path.exists(resolved):
            print(f"[engine_diffusion] Workflow template not found: {resolved}")
            return False
        _active_workflow = resolved
        os.environ["COMFYUI_IMAGE_WORKFLOW"] = filename
        _persist_workflow_to_env(filename)
        print(f"[engine_diffusion] Active image workflow set to: {filename}")
        return True
    except Exception as e:
        print(f"[engine_diffusion] Failed to set active workflow: {e}")
        return False


DIFFUSION_SERVER_PORT = 8189
DIFFUSION_SERVER_URL = f"http://127.0.0.1:{DIFFUSION_SERVER_PORT}"

_server_proc: Optional[subprocess.Popen] = None
_server_lock = threading.Lock()


def _cleanup_stale_port_process(port: int):
    """Terminates any stale process listening on the specified port."""
    if os.name != 'nt':
        return
    try:
        flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000
        output = subprocess.check_output("netstat -ano", shell=True, creationflags=flags).decode('utf-8', errors='ignore')
        for line in output.splitlines():
            if f":{port}" in line and "LISTENING" in line:
                parts = line.strip().split()
                if len(parts) >= 5:
                    pid = int(parts[-1])
                    if pid != os.getpid():
                        try:
                            import psutil
                            proc = psutil.Process(pid)
                            proc.kill()
                        except Exception:
                            subprocess.run(["taskkill", "/F", "/PID", str(pid)], creationflags=flags, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except Exception:
        pass


def check_server_status() -> bool:
    """Checks if the diffusion server worker is online."""
    try:
        import urllib.request
        req = urllib.request.Request(f"{DIFFUSION_SERVER_URL}/health", method="GET")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False




def ensure_server_running(timeout: float = 60.0, cancel_event: Optional[threading.Event] = None) -> bool:
    """Starts the diffusion server worker if not already running."""
    global _server_proc
    if cancel_event is not None and cancel_event.is_set():
        return False
    if _server_proc is not None and _server_proc.poll() is None:
        return True

    if check_server_status():
        return True

    with _server_lock:
        if cancel_event is not None and cancel_event.is_set():
            return False
        if _server_proc is not None and _server_proc.poll() is None:
            return True

        if check_server_status():
            return True

        print("[engine_diffusion] Starting persistent diffusion server worker...", flush=True)
        py_exe = sys.executable
        env = os.environ.copy()
        env["PYTHONPATH"] = root_dir + os.pathsep + env.get("PYTHONPATH", "")
        _sanitize_windows_gpu_env(env)

        logs_dir = os.path.join(root_dir, "logs")
        os.makedirs(logs_dir, exist_ok=True)
        popen_kwargs = {}
        if os.name == 'nt':
            si = subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            si.wShowWindow = 0
            popen_kwargs["startupinfo"] = si
            popen_kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000

        with open(os.path.join(logs_dir, "diffusion_daemon.log"), "a", encoding="utf-8") as daemon_log:
            _server_proc = lifecycle.track(subprocess.Popen(
                [py_exe, os.path.abspath(__file__), "--server"],
                env=env,
                cwd=root_dir,
                stdout=daemon_log,
                stderr=daemon_log,
                **popen_kwargs
            ))

        start_t = time.time()
        while time.time() - start_t < timeout:
            if cancel_event is not None and cancel_event.is_set():
                return False
            time.sleep(0.5)
            if check_server_status():
                print("[engine_diffusion] Persistent diffusion server worker is ready.", flush=True)
                return True
            if _server_proc and _server_proc.poll() is not None:
                print(f"[engine_diffusion] Server worker exited prematurely with code {_server_proc.poll()}.", flush=True)
                return False

        print("[engine_diffusion] Server worker startup timed out.", flush=True)
        return False




def _move_cached_tensors_to_cpu(obj: Any) -> Any:
    """Recursively moves any GPU tensors in cached conditioning structures to CPU."""
    import torch
    if isinstance(obj, torch.Tensor):
        return obj.to("cpu") if obj.device.type != "cpu" else obj
    if isinstance(obj, list):
        return [_move_cached_tensors_to_cpu(item) for item in obj]
    if isinstance(obj, tuple):
        return tuple(_move_cached_tensors_to_cpu(item) for item in obj)
    if isinstance(obj, dict):
        return {k: _move_cached_tensors_to_cpu(v) for k, v in obj.items()}
    return obj


def _configure_comfy_runtime() -> Any:
    """Configures ComfyUI CLI flags, SDPA backends, and VRAM reserves before and during model_management init."""
    global _runtime_configured
    import torch
    comfy_dir = os.path.normpath(os.path.join(root_dir, "core", "comfy_engine"))
    if comfy_dir not in sys.path:
        sys.path.insert(0, comfy_dir)

    is_win_rocm = os.name == "nt" and bool(getattr(torch.version, "hip", None))
    if not _runtime_configured and is_win_rocm:
        from comfy.cli_args import args as comfy_args
        # Disable AOTriton Flash/Mem-Efficient attention kernels on Windows ROCm/WDDM:
        # arbitrary FaceDetailer crop dimensions hang gfx1100 shader engines under WDDM.
        comfy_args.use_quad_cross_attention = True
        # Disable hipHostRegister pinning and multi-stream async weight offload races on WDDM.
        comfy_args.disable_pinned_memory = True
        comfy_args.disable_async_offload = True
        comfy_args.disable_dynamic_vram = True
        if comfy_args.reserve_vram is None:
            comfy_args.reserve_vram = 2.5

        torch.backends.cuda.enable_flash_sdp(False)
        torch.backends.cuda.enable_mem_efficient_sdp(False)
        if hasattr(torch.backends.cuda, "enable_cudnn_sdp"):
            torch.backends.cuda.enable_cudnn_sdp(False)
        torch.backends.cuda.enable_math_sdp(True)

    import comfy.model_management as mm

    if not _runtime_configured:
        if is_win_rocm:
            mm.MAX_PINNED_MEMORY = -1
            mm.ENABLE_PYTORCH_ATTENTION = False
            try:
                import comfy.ops
                from torch.nn.attention import SDPBackend
                comfy.ops.SDPA_BACKEND_PRIORITY = [SDPBackend.MATH]
            except Exception:
                pass

        dev = mm.get_torch_device()
        total_vram = mm.get_total_memory(dev)
        vae_dt = mm.vae_dtype(dev, [torch.bfloat16, torch.float32])
        print(
            f"[engine_diffusion] Runtime configured: device={dev}, vram_mb={total_vram // (1024 * 1024)}, "
            f"vram_state={mm.vram_state.name}, reserved_vram_mb={mm.extra_reserved_memory() // (1024 * 1024)}, "
            f"pytorch_attn={mm.pytorch_attention_enabled()}, pinned_mem={mm.MAX_PINNED_MEMORY}, vae_dtype={vae_dt}",
            flush=True,
        )
        _runtime_configured = True

    return mm


def offload_models_to_ram() -> Dict[str, Any]:
    """Moves all resident diffusion, CLIP, VAE, and detector weights from GPU VRAM to host RAM."""
    import torch
    mm = _configure_comfy_runtime()

    for key, val in list(_COMFY_NODE_CACHE.items()):
        if key[0] == "CLIPTextEncode":
            _COMFY_NODE_CACHE[key] = _move_cached_tensors_to_cpu(val)
        elif key[0] == "UltralyticsDetectorProvider" and isinstance(val, (tuple, list)):
            for det in val:
                yolo_obj = getattr(det, "bbox_model", None)
                if yolo_obj is not None:
                    try:
                        yolo_obj.to("cpu")
                    except Exception:
                        pass
                    if hasattr(yolo_obj, "predictor") and yolo_obj.predictor is not None:
                        yolo_obj.predictor = None

    mm.unload_all_models()
    mm.reset_cast_buffers()
    gc.collect()
    mm.soft_empty_cache()

    vram_alloc_mb = 0.0
    vram_reserved_mb = 0.0
    if torch.cuda.is_available():
        vram_alloc_mb = round(torch.cuda.memory_allocated() / (1024 ** 2), 1)
        vram_reserved_mb = round(torch.cuda.memory_reserved() / (1024 ** 2), 1)

    print(
        f"[engine_diffusion] Offloaded models to host RAM (vram_allocated={vram_alloc_mb} MB, "
        f"vram_reserved={vram_reserved_mb} MB).",
        flush=True,
    )
    return {
        "status": "offloaded",
        "requires_shutdown": bool(mm.is_directml_enabled()),
        "vram_allocated_mb": vram_alloc_mb,
        "vram_reserved_mb": vram_reserved_mb,
    }


def interrupt_diffusion_generation() -> bool:
    """Requests immediate step-level interruption of an active diffusion generation without killing the worker."""
    try:
        import urllib.request
        req = urllib.request.Request(f"{DIFFUSION_SERVER_URL}/interrupt", method="POST")
        with urllib.request.urlopen(req, timeout=1.5) as resp:
            return resp.status == 200
    except Exception:
        return False


def unload_diffusion_models(kill_worker: bool = False):
    """Releases GPU VRAM back to the OS. Keeps the worker warm in host RAM on ROCm/CUDA unless kill_worker=True."""
    global _server_proc, _COMFY_NODE_CACHE, _active_checkpoint
    with _server_lock:
        if not kill_worker and check_server_status():
            try:
                import urllib.request
                req = urllib.request.Request(f"{DIFFUSION_SERVER_URL}/offload", method="POST")
                with urllib.request.urlopen(req, timeout=15.0) as resp:
                    info = json.loads(resp.read().decode("utf-8"))
                    if info.get("status") == "offloaded" and not info.get("requires_shutdown"):
                        return
            except Exception as e:
                print(f"[engine_diffusion] Warm RAM offload failed ({e}); shutting down worker...", flush=True)

        if check_server_status():
            try:
                import urllib.request
                req = urllib.request.Request(f"{DIFFUSION_SERVER_URL}/shutdown", method="POST")
                with urllib.request.urlopen(req, timeout=1.5):
                    pass
            except Exception:
                pass

        if _server_proc is not None:
            if _server_proc.poll() is None:
                try:
                    import psutil
                    parent = psutil.Process(_server_proc.pid)
                    for child in parent.children(recursive=True):
                        try:
                            child.kill()
                        except Exception:
                            pass
                except Exception:
                    pass
                try:
                    _server_proc.terminate()
                    _server_proc.wait(timeout=2.0)
                except (OSError, subprocess.TimeoutExpired):
                    try:
                        _server_proc.kill()
                        _server_proc.wait(timeout=1.0)
                    except (OSError, subprocess.TimeoutExpired):
                        pass
            _server_proc = None

        _cleanup_stale_port_process(DIFFUSION_SERVER_PORT)

        _COMFY_NODE_CACHE.clear()
        _active_checkpoint = None

        gc.collect()


def execute_workflow_graph(
    workflow_path_or_dict: Any,
    replacements: Optional[Dict[str, Any]] = None,
    save_path: Optional[str] = None,
    save_paths: Optional[List[str]] = None,
    batch_size: int = 1,
    empty_cache_after: bool = False,
    on_image_saved: Optional[Callable[[int, str], None]] = None,
) -> Tuple[Optional[Any], Any]:
    """Dynamically executes a ComfyUI node graph JSON in-process with GPU acceleration."""
    import torch
    mm = _configure_comfy_runtime()
    import folder_paths
    folder_paths.folder_names_and_paths["checkpoints"] = ([os.path.join(root_dir, "models", "checkpoints")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["loras"] = ([os.path.join(root_dir, "models", "loras")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["vae"] = ([os.path.join(root_dir, "models", "vae")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["ultralytics"] = ([os.path.join(root_dir, "models", "ultralytics")], folder_paths.supported_pt_extensions)

    mm.interrupt_current_processing(False)

    import nodes
    global _custom_nodes_loaded
    if not _custom_nodes_loaded:
        try:
            import logging, asyncio
            prev_level = logging.getLogger().level
            logging.getLogger().setLevel(logging.ERROR)
            asyncio.run(nodes.init_extra_nodes(init_custom_nodes=True))
            logging.getLogger().setLevel(prev_level)
        except Exception as custom_node_err:
            print(f"[engine_diffusion] Warning initializing custom nodes: {custom_node_err}")
        _custom_nodes_loaded = True

    if isinstance(workflow_path_or_dict, str):
        with open(workflow_path_or_dict, "r", encoding="utf-8") as f:
            graph = json.load(f)
    elif isinstance(workflow_path_or_dict, dict):
        graph = copy.deepcopy(workflow_path_or_dict)
    else:
        graph = json.loads(str(workflow_path_or_dict))

    if replacements:
        def apply_replacements(val: Any) -> Any:
            if isinstance(val, dict):
                return {k: apply_replacements(v) for k, v in val.items()}
            elif isinstance(val, list):
                return [apply_replacements(item) for item in val]
            elif isinstance(val, str):
                res = val
                for k, v in replacements.items():
                    if res == k:
                        return v
                    if k in res:
                        res = res.replace(k, str(v) if v is not None else "")
                return res
            return val

        graph = apply_replacements(graph)

    effective_batch = max(1, int(batch_size or 1))
    if effective_batch > 1:
        for nd in graph.values():
            if isinstance(nd, dict) and nd.get("class_type") == "EmptyLatentImage":
                nd.setdefault("inputs", {})["batch_size"] = effective_batch

    from PIL import Image
    import numpy as np

    target_paths = list(save_paths) if save_paths else ([save_path] if save_path else [])
    saved_paths: List[str] = []
    saved_indices: set[int] = set()
    result_image = None

    def _save_tensor_image(img_tensor_3d: torch.Tensor, idx: int) -> None:
        nonlocal result_image
        if idx in saved_indices:
            return
        img_array = (img_tensor_3d.detach().cpu().numpy() * 255).clip(0, 255).astype(np.uint8)
        pil_img = Image.fromarray(img_array)
        del img_array
        if idx == 0:
            result_image = pil_img
        if idx < len(target_paths) and target_paths[idx]:
            out_p = target_paths[idx]
            os.makedirs(os.path.dirname(out_p), exist_ok=True)
            pil_img.save(out_p, compress_level=1)
            saved_paths.append(out_p)
            saved_indices.add(idx)
            print(f"[engine_diffusion] Image saved dynamically to {out_p}", flush=True)
            if on_image_saved is not None:
                on_image_saved(idx, out_p)

    # Identify terminal image-producing node, unwrapping PreviewImage/SaveImage so no throwaway temp PNGs are written
    target_nid = None
    for ptype in ("PreviewImage", "SaveImage", "FaceDetailer", "VAEDecode"):
        for nid, nd in graph.items():
            if nd.get("class_type") == ptype:
                target_nid = nid
                break
        if target_nid:
            break

    terminal_image_nid = target_nid
    terminal_image_out_idx = 0
    if target_nid and graph[target_nid].get("class_type") in ("PreviewImage", "SaveImage"):
        img_link = graph[target_nid].get("inputs", {}).get("images")
        if isinstance(img_link, list) and len(img_link) == 2 and isinstance(img_link[0], str) and img_link[0] in graph:
            terminal_image_nid = img_link[0]
            terminal_image_out_idx = int(img_link[1])

    executed_outputs: Dict[str, Any] = {}

    def get_input_val(val: Any) -> Any:
        if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] in graph:
            src_id, src_out_idx = val[0], val[1]
            if src_id not in executed_outputs:
                execute_node(src_id)
            src_out = executed_outputs.get(src_id)
            if isinstance(src_out, (list, tuple)) and len(src_out) > src_out_idx:
                return src_out[src_out_idx]
            return None
        return val

    def execute_node(node_id: str) -> Any:
        if node_id in executed_outputs:
            return executed_outputs[node_id]

        mm.throw_exception_if_processing_interrupted()

        node_data = graph[node_id]
        class_type = node_data.get("class_type")
        if not class_type or class_type not in nodes.NODE_CLASS_MAPPINGS:
            raise RuntimeError(
                f"Workflow node [{node_id}] '{class_type}' is not registered. "
                f"Install the custom node pack that provides it into core/comfy_engine/custom_nodes."
            )

        cls = nodes.NODE_CLASS_MAPPINGS[class_type]
        instance = cls()

        resolved_inputs = {}
        for inp_k, inp_v in node_data.get("inputs", {}).items():
            val = get_input_val(inp_v)
            if inp_k == "seed" and isinstance(val, str) and val.isdigit():
                val = int(val)
            resolved_inputs[inp_k] = val

        func_name = getattr(cls, "FUNCTION", "execute")
        func = getattr(instance, func_name)

        print(f"[engine_diffusion] Executing node [{node_id}] {class_type} -> {func_name}...", flush=True)

        if class_type == "CheckpointLoaderSimple":
            ckpt_name = resolved_inputs.get("ckpt_name")
            cache_key = ("CheckpointLoaderSimple", ckpt_name)
            if cache_key in _COMFY_NODE_CACHE:
                print(f"[engine_diffusion] Reusing cached checkpoint model: {ckpt_name}", flush=True)
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            for k in list(_COMFY_NODE_CACHE.keys()):
                if k[0] in ("CheckpointLoaderSimple", "LoraLoader", "CLIPTextEncode"):
                    del _COMFY_NODE_CACHE[k]

            outs = func(**resolved_inputs)
            _COMFY_NODE_CACHE[cache_key] = outs
            executed_outputs[node_id] = outs
            return outs

        if class_type == "CLIPTextEncode":
            text_val = resolved_inputs.get("text")
            c_in = resolved_inputs.get("clip")
            cache_key = ("CLIPTextEncode", text_val, id(c_in))
            if cache_key in _COMFY_NODE_CACHE:
                print("[engine_diffusion] Reusing cached CLIP text encoding", flush=True)
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            outs = func(**resolved_inputs)
            _COMFY_NODE_CACHE[cache_key] = outs
            executed_outputs[node_id] = outs
            return outs

        if class_type == "LoraLoader":
            lora_name = resolved_inputs.get("lora_name")
            sm = resolved_inputs.get("strength_model")
            sc = resolved_inputs.get("strength_clip")
            m_in = resolved_inputs.get("model")
            c_in = resolved_inputs.get("clip")
            if not lora_name or (not resolve_lora_path(lora_name) and not folder_paths.get_full_path("loras", lora_name)):
                print(f"[engine_diffusion] Optional LoRA '{lora_name}' not found in models/loras; bypassing LoraLoader node.", flush=True)
                outs = (m_in, c_in)
                executed_outputs[node_id] = outs
                return outs
            cache_key = ("LoraLoader", lora_name, sm, sc, id(m_in), id(c_in))
            if cache_key in _COMFY_NODE_CACHE:
                print(f"[engine_diffusion] Reusing cached LoRA weights: {lora_name}", flush=True)
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            outs = func(**resolved_inputs)
            _COMFY_NODE_CACHE[cache_key] = outs
            executed_outputs[node_id] = outs
            return outs

        if class_type == "UltralyticsDetectorProvider":
            m_name = resolved_inputs.get("model_name")
            if not m_name or not folder_paths.get_full_path("ultralytics", m_name):
                raise FileNotFoundError(
                    f"Detector model '{m_name}' not found. Expected at "
                    f"{os.path.join(root_dir, 'models', 'ultralytics', m_name or '')}"
                )
            cache_key = ("UltralyticsDetectorProvider", m_name)
            if cache_key in _COMFY_NODE_CACHE:
                print(f"[engine_diffusion] Reusing cached detector: {m_name}", flush=True)
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            outs = func(**resolved_inputs)
            _COMFY_NODE_CACHE[cache_key] = outs
            executed_outputs[node_id] = outs
            return outs

        if class_type == "FaceDetailer":
            images_in = resolved_inputs.get("image")
            if isinstance(images_in, torch.Tensor) and images_in.ndim == 4 and images_in.shape[0] > 1:
                base_seed = int(resolved_inputs.get("seed") or 0)
                enhanced_batches = []
                last_slice_out = None
                for idx in range(images_in.shape[0]):
                    mm.throw_exception_if_processing_interrupted()
                    slice_inputs = dict(resolved_inputs)
                    slice_inputs["image"] = images_in[idx:idx + 1]
                    slice_inputs["seed"] = base_seed + idx
                    slice_out = func(**slice_inputs)
                    last_slice_out = slice_out
                    slice_img = slice_out[0]
                    enhanced_batches.append(slice_img)
                    if node_id == terminal_image_nid and terminal_image_out_idx == 0:
                        _save_tensor_image(slice_img[0], idx)
                combined_img = torch.cat(enhanced_batches, dim=0)
                outs = (combined_img,) + tuple(last_slice_out[1:]) if isinstance(last_slice_out, tuple) and len(last_slice_out) > 1 else (combined_img,)
                executed_outputs[node_id] = outs
                return outs

        outs = func(**resolved_inputs)
        executed_outputs[node_id] = outs
        return outs

    final_images = None
    try:
        with torch.inference_mode():
            if terminal_image_nid:
                res = execute_node(terminal_image_nid)
                if res is not None:
                    if isinstance(res, (list, tuple)) and len(res) > terminal_image_out_idx and hasattr(res[terminal_image_out_idx], "shape"):
                        final_images = res[terminal_image_out_idx]
                    elif isinstance(res, dict) and "images" in res:
                        final_images = res["images"]

            if final_images is None:
                for nid in reversed(list(executed_outputs.keys())):
                    out = executed_outputs[nid]
                    if isinstance(out, (list, tuple)) and len(out) > 0 and hasattr(out[0], "shape") and len(out[0].shape) == 4:
                        final_images = out[0]
                        break

        if final_images is not None:
            num_out = final_images.shape[0]
            for idx in range(num_out):
                _save_tensor_image(final_images[idx], idx)
    finally:
        executed_outputs.clear()
        final_images = None
        try:
            if empty_cache_after:
                mm.unload_all_models()
                mm.soft_empty_cache()
                gc.collect()
            elif mm.is_directml_enabled():
                mm.soft_empty_cache()
                gc.collect()
        except Exception:
            pass

    if save_paths is not None:
        return result_image, saved_paths
    if result_image is not None:
        return result_image, (saved_paths[0] if saved_paths else (save_path or ""))

    return None, ""


def _generate_portrait_image_inprocess(
    prompt: str,
    negative_prompt: str = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text",
    checkpoint: Optional[str] = None,
    seed: Optional[int] = None,
    workflow_path: Optional[str] = None,
    save_path: Optional[str] = None,
    save_paths: Optional[List[str]] = None,
    replacements: Optional[Dict[str, Any]] = None,
    on_image_saved: Optional[Callable[[int, str], None]] = None,
) -> Any:
    if seed is None:
        seed = random.randint(1, 1125899906842624)

    from variables.settings import get_workflow_path
    wf_file = workflow_path or get_workflow_path("Image")
    if not os.path.isabs(wf_file):
        wf_file = os.path.normpath(os.path.join(root_dir, wf_file))

    active_ckpt = checkpoint or get_active_checkpoint() or os.getenv("COMFYUI_CHECKPOINT")
    try:
        selected_checkpoint = os.path.basename(resolve_checkpoint_path(active_ckpt))
    except Exception:
        selected_checkpoint = active_ckpt or "sd_xl_base_1.0.safetensors"

    with open(wf_file, "r", encoding="utf-8") as f:
        wf_template = json.load(f)

    final_replacements = {
        "%prompt%": prompt,
        "%negative_prompt%": negative_prompt,
        "%seed%": seed,
        "%model%": selected_checkpoint,
        "%vae%": "",
        "%width%": 832,
        "%height%": 1248,
    }
    if replacements:
        final_replacements.update(replacements)

    if save_paths is not None:
        mm = _configure_comfy_runtime()
        print(
            f"[engine_diffusion] Running progressive sequential workflow ({len(save_paths)} slot(s), batch_size=1): "
            f"{wf_file} with checkpoint: {selected_checkpoint}",
            flush=True,
        )
        completed_paths: List[str] = []
        for idx, target_out_path in enumerate(save_paths):
            mm.throw_exception_if_processing_interrupted()
            slot_replacements = dict(final_replacements)
            slot_replacements["%seed%"] = seed + idx

            def _slot_cb(_inner_idx: int, saved_p: str, slot_idx: int = idx) -> None:
                if on_image_saved is not None:
                    on_image_saved(slot_idx, saved_p)

            _, out_p = execute_workflow_graph(
                wf_template,
                replacements=slot_replacements,
                save_path=target_out_path,
                batch_size=1,
                on_image_saved=_slot_cb if on_image_saved is not None else None,
            )
            if out_p and os.path.exists(out_p):
                completed_paths.append(out_p)
        return completed_paths

    print(f"[engine_diffusion] Running workflow: {wf_file} with checkpoint: {selected_checkpoint}", flush=True)
    _, out_result = execute_workflow_graph(
        wf_template,
        replacements=final_replacements,
        save_path=save_path,
        on_image_saved=on_image_saved,
    )
    return out_result


def generate_portrait_image(
    prompt: str = "",
    negative_prompt: str = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text",
    checkpoint: Optional[str] = None,
    seed: Optional[int] = None,
    workflow_path: Optional[str] = None,
    save_path: Optional[str] = None,
    save_paths: Optional[List[str]] = None,
    replacements: Optional[Dict[str, Any]] = None,
    cancel_event: Optional[threading.Event] = None,
    on_image_ready: Optional[Callable[[int, str], None]] = None,
) -> Any:
    """Generates one or more images via the persistent diffusion worker, keeping models cached across calls.
    Image size, steps, and sampler settings come from the workflow file."""
    if cancel_event is not None and cancel_event.is_set():
        raise RuntimeError("Image generation cancelled.")
    if not ensure_server_running(cancel_event=cancel_event):
        raise RuntimeError("Failed to start persistent diffusion server worker.")

    import urllib.request
    import urllib.error

    resolved_workflow = workflow_path or get_workflow_path("Image")
    resolved_checkpoint = checkpoint or get_active_checkpoint() or os.getenv("COMFYUI_CHECKPOINT")
    use_stream = on_image_ready is not None

    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "checkpoint": resolved_checkpoint,
        "seed": seed,
        "workflow_path": resolved_workflow,
        "save_path": save_path,
        "save_paths": save_paths,
        "replacements": replacements,
        "stream": use_stream,
    }

    req_data = json.dumps(payload).encode("utf-8")

    for attempt in range(2):
        if cancel_event is not None and cancel_event.is_set():
            raise RuntimeError("Image generation cancelled.")
        req = urllib.request.Request(
            f"{DIFFUSION_SERVER_URL}/generate",
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                if use_stream:
                    final_paths = None
                    final_path = ""
                    for raw_line in resp:
                        line = raw_line.decode("utf-8", errors="replace").strip()
                        if not line:
                            continue
                        evt = json.loads(line)
                        etype = evt.get("event")
                        if etype == "image":
                            if cancel_event is not None and cancel_event.is_set():
                                interrupt_diffusion_generation()
                                raise RuntimeError("Image generation cancelled.")
                            on_image_ready(int(evt.get("index", 0)), evt.get("path", ""))
                        elif etype == "done":
                            final_paths = evt.get("paths")
                            final_path = evt.get("path", "")
                        elif etype == "cancelled":
                            raise RuntimeError("Image generation cancelled.")
                        elif etype == "error":
                            raise RuntimeError(evt.get("error", "Unknown diffusion error"))
                    if cancel_event is not None and cancel_event.is_set():
                        raise RuntimeError("Image generation cancelled.")
                    return final_paths if save_paths is not None else final_path
                else:
                    res_json = json.loads(resp.read().decode("utf-8"))
                    if cancel_event is not None and cancel_event.is_set():
                        raise RuntimeError("Image generation cancelled.")
                    if res_json.get("status") == "ok":
                        return res_json.get("paths") if save_paths is not None else res_json.get("path", "")
                    if res_json.get("status") == "cancelled":
                        raise RuntimeError("Image generation cancelled.")
                    raise RuntimeError(res_json.get("error", "Unknown diffusion error"))
        except urllib.error.HTTPError as http_err:
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError("Image generation cancelled.") from http_err
            if http_err.code == 499:
                raise RuntimeError("Image generation cancelled.") from http_err
            try:
                err_body = json.loads(http_err.read().decode("utf-8"))
                detail = err_body.get("error", str(http_err))
            except Exception:
                detail = str(http_err)

            is_device_err = any(
                k in detail.lower()
                for k in (
                    "suspended",
                    "deviceremoved",
                    "device removed",
                    "dxgi_error",
                    "reset",
                    "not enough gpu video memory",
                    "could not allocate tensor",
                    "out of memory",
                )
            )
            if attempt == 0 and is_device_err:
                print(f"[engine_diffusion] GPU memory/device error ({detail}). Restarting worker for clean GPU context...", flush=True)
                unload_diffusion_models(kill_worker=True)
                if ensure_server_running(cancel_event=cancel_event):
                    continue

            raise RuntimeError(f"Diffusion error: {detail}") from http_err
        except RuntimeError:
            raise
        except Exception as conn_err:
            if cancel_event is not None and cancel_event.is_set():
                raise RuntimeError("Image generation cancelled.") from conn_err
            if attempt == 0:
                print(f"[engine_diffusion] Connection to worker failed ({conn_err}). Restarting worker...", flush=True)
                unload_diffusion_models(kill_worker=True)
                if ensure_server_running(cancel_event=cancel_event):
                    continue
            raise conn_err


if __name__ == "__main__":
    import argparse
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true", help="Run as HTTP diffusion worker")
    args = parser.parse_args()

    if args.server:
        _configure_comfy_runtime()

        _worker_generation_lock = threading.Lock()
        _worker_is_generating = False

        class DiffusionHandler(BaseHTTPRequestHandler):
            def log_message(self, format, *args):
                pass  # Suppress access logs

            def do_GET(self):
                if self.path == "/health":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    status_text = "busy" if _worker_is_generating else "ready"
                    self.wfile.write(json.dumps({"status": status_text, "generating": _worker_is_generating}).encode("utf-8"))
                else:
                    self.send_response(404)
                    self.end_headers()

            def do_POST(self):
                global _worker_is_generating
                if self.path == "/generate":
                    content_len = int(self.headers.get("Content-Length", 0))
                    body = self.rfile.read(content_len)
                    with _worker_generation_lock:
                        _worker_is_generating = True
                        cfg = json.loads(body.decode("utf-8"))
                        stream_mode = bool(cfg.pop("stream", False))
                        if stream_mode:
                            self.send_response(200)
                            self.send_header("Content-Type", "application/x-ndjson")
                            self.send_header("Cache-Control", "no-cache")
                            self.end_headers()

                            def _emit_slot(idx: int, saved_p: str) -> None:
                                line = json.dumps({"event": "image", "index": idx, "path": saved_p}) + "\n"
                                self.wfile.write(line.encode("utf-8"))
                                self.wfile.flush()

                            try:
                                out_res = _generate_portrait_image_inprocess(**cfg, on_image_saved=_emit_slot)
                                done_payload = (
                                    {"event": "done", "status": "ok", "paths": out_res, "path": out_res[0] if out_res else ""}
                                    if isinstance(out_res, list)
                                    else {"event": "done", "status": "ok", "path": out_res}
                                )
                                self.wfile.write((json.dumps(done_payload) + "\n").encode("utf-8"))
                                self.wfile.flush()
                            except BaseException as ex:
                                import comfy.model_management as mm
                                if isinstance(ex, mm.InterruptProcessingException):
                                    self.wfile.write((json.dumps({"event": "cancelled", "status": "cancelled"}) + "\n").encode("utf-8"))
                                    self.wfile.flush()
                                elif isinstance(ex, Exception):
                                    err_msg = str(ex)
                                    ex.__traceback__ = None
                                    self.wfile.write((json.dumps({"event": "error", "status": "error", "error": err_msg}) + "\n").encode("utf-8"))
                                    self.wfile.flush()
                                else:
                                    raise
                            finally:
                                _worker_is_generating = False
                        else:
                            try:
                                out_res = _generate_portrait_image_inprocess(**cfg)
                                self.send_response(200)
                                self.send_header("Content-Type", "application/json")
                                self.end_headers()
                                if isinstance(out_res, list):
                                    self.wfile.write(json.dumps({"status": "ok", "paths": out_res, "path": out_res[0] if out_res else ""}).encode("utf-8"))
                                else:
                                    self.wfile.write(json.dumps({"status": "ok", "path": out_res}).encode("utf-8"))
                            except BaseException as ex:
                                import comfy.model_management as mm
                                if isinstance(ex, mm.InterruptProcessingException):
                                    self.send_response(499)
                                    self.send_header("Content-Type", "application/json")
                                    self.end_headers()
                                    self.wfile.write(b'{"status":"cancelled","error":"Image generation cancelled."}')
                                elif isinstance(ex, Exception):
                                    err_msg = str(ex)
                                    ex.__traceback__ = None
                                    self.send_response(500)
                                    self.send_header("Content-Type", "application/json")
                                    self.end_headers()
                                    self.wfile.write(json.dumps({"status": "error", "error": err_msg}).encode("utf-8"))
                                else:
                                    raise
                            finally:
                                _worker_is_generating = False
                elif self.path == "/interrupt":
                    try:
                        import comfy.model_management as mm
                        mm.interrupt_current_processing(True)
                    except Exception:
                        pass
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"status":"interrupted"}')
                elif self.path == "/offload":
                    try:
                        import comfy.model_management as mm
                        if _worker_is_generating:
                            mm.interrupt_current_processing(True)
                        with _worker_generation_lock:
                            info = offload_models_to_ram()
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps(info).encode("utf-8"))
                    except Exception as ex:
                        self.send_response(500)
                        self.send_header("Content-Type", "application/json")
                        self.end_headers()
                        self.wfile.write(json.dumps({"status": "error", "error": str(ex)}).encode("utf-8"))
                elif self.path == "/shutdown":
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"status":"shutting_down"}')
                    threading.Thread(target=lambda: (time.sleep(0.5), os._exit(0))).start()
                else:
                    self.send_response(404)
                    self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", DIFFUSION_SERVER_PORT), DiffusionHandler)
        server.daemon_threads = True
        print(f"[engine_diffusion server] Listening on http://127.0.0.1:{DIFFUSION_SERVER_PORT}", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
