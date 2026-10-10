"""
core/engine_diffusion.py — Internal GPU-accelerated diffusion engine.

Executes SDXL image generation directly in-process with PyTorch/GPU acceleration,
using the exact parameters from ImageWorkflow.json.
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
from typing import List, Dict, Any, Optional, Tuple

import torch
from variables.settings import CHECKPOINTS_DIR, LORAS_DIR, VAE_DIR, MODELS_DIR
from utils import lifecycle

_diffusion_lock = threading.Lock()
_active_checkpoint: Optional[str] = None
_COMFY_NODE_CACHE: Dict[Tuple[Any, ...], Any] = {}
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
        
        # Clear cached checkpoint and dependent LoRAs if switched
        for key in list(_COMFY_NODE_CACHE.keys()):
            if key[0] in ("CheckpointLoaderSimple", "LoraLoader"):
                del _COMFY_NODE_CACHE[key]

        _persist_checkpoint_to_env(filename)
        print(f"[engine_diffusion] Active checkpoint set to: {filename}")
        return True
    except Exception as e:
        print(f"[engine_diffusion] Failed to set active checkpoint: {e}")
        return False


DIFFUSION_SERVER_PORT = 8189
DIFFUSION_SERVER_URL = f"http://127.0.0.1:{DIFFUSION_SERVER_PORT}"
# Retain aliases for backward compatibility
DIFFUSION_DAEMON_PORT = DIFFUSION_SERVER_PORT
DIFFUSION_DAEMON_URL = DIFFUSION_SERVER_URL

_server_proc: Optional[subprocess.Popen] = None
_daemon_proc = _server_proc
_server_lock = threading.Lock()
_daemon_lock = _server_lock


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


check_daemon_status = check_server_status


def ensure_server_running(timeout: float = 60.0) -> bool:
    """Starts the diffusion server worker if not already running."""
    global _server_proc, _daemon_proc
    if _server_proc is not None and _server_proc.poll() is None:
        return True

    if check_server_status():
        return True

    with _server_lock:
        if _server_proc is not None and _server_proc.poll() is None:
            return True

        if check_server_status():
            return True

        # Ensure no zombie process occupies the port before launching a new worker
        _cleanup_stale_port_process(DIFFUSION_SERVER_PORT)

        print("[engine_diffusion] Starting persistent diffusion server worker...", flush=True)
        py_exe = sys.executable
        env = os.environ.copy()
        env["DIFFUSION_WORKER"] = "1"
        env["PYTHONPATH"] = root_dir + os.pathsep + env.get("PYTHONPATH", "")

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
            _daemon_proc = _server_proc

        start_t = time.time()
        while time.time() - start_t < timeout:
            time.sleep(0.5)
            if check_server_status():
                print("[engine_diffusion] Persistent diffusion server worker is ready.", flush=True)
                return True
            if _server_proc and _server_proc.poll() is not None:
                print(f"[engine_diffusion] Server worker exited prematurely with code {_server_proc.poll()}.", flush=True)
                return False

        print("[engine_diffusion] Server worker startup timed out.", flush=True)
        return False


ensure_daemon_running = ensure_server_running


def unload_diffusion_models():
    """Unloads the diffusion server worker, releasing 100% of GPU VRAM back to the OS."""
    global _server_proc, _daemon_proc, _COMFY_NODE_CACHE, _active_checkpoint
    with _server_lock:
        try:
            import urllib.request
            req = urllib.request.Request(f"{DIFFUSION_SERVER_URL}/shutdown", method="POST", data=b"{}")
            urllib.request.urlopen(req, timeout=1.5)
        except Exception:
            pass

        if _server_proc is not None:
            try:
                _server_proc.terminate()
                _server_proc.wait(timeout=2.0)
            except Exception:
                try:
                    _server_proc.kill()
                    _server_proc.wait(timeout=1.0)
                except Exception:
                    pass
            _server_proc = None
            _daemon_proc = None

        _cleanup_stale_port_process(DIFFUSION_SERVER_PORT)

        _COMFY_NODE_CACHE.clear()
        _active_checkpoint = None

        gc.collect()


def execute_workflow_graph(
    workflow_path_or_dict: Any,
    replacements: Optional[Dict[str, Any]] = None,
    save_path: Optional[str] = None
) -> Tuple[Optional[Any], str]:
    """Dynamically executes any ComfyUI node graph JSON in-process with AMD DirectML GPU acceleration."""
    comfy_dir = os.path.normpath(os.path.join(root_dir, "core", "comfy_engine"))
    if comfy_dir not in sys.path:
        sys.path.insert(0, comfy_dir)

    import folder_paths
    folder_paths.folder_names_and_paths["checkpoints"] = ([os.path.join(root_dir, "models", "checkpoints")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["loras"] = ([os.path.join(root_dir, "models", "loras")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["vae"] = ([os.path.join(root_dir, "models", "vae")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["ultralytics"] = ([os.path.join(root_dir, "models", "ultralytics")], folder_paths.supported_pt_extensions)

    import nodes
    if "FaceDetailer" not in nodes.NODE_CLASS_MAPPINGS:
        try:
            import logging, asyncio
            prev_level = logging.getLogger().level
            logging.getLogger().setLevel(logging.ERROR)
            asyncio.run(nodes.init_extra_nodes(init_custom_nodes=True))
            logging.getLogger().setLevel(prev_level)
        except Exception as custom_node_err:
            print(f"[engine_diffusion] Warning initializing custom nodes: {custom_node_err}")

    import comfy.model_management

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

    executed_outputs: Dict[str, Any] = {}

    def get_input_val(val: Any) -> Any:
        if isinstance(val, list) and len(val) == 2 and isinstance(val[0], str) and val[0] in graph:
            src_id, src_out_idx = val[0], val[1]
            if src_id not in executed_outputs:
                execute_node(src_id)
            return executed_outputs[src_id][src_out_idx]
        return val

    def execute_node(node_id: str) -> Any:
        if node_id in executed_outputs:
            return executed_outputs[node_id]

        node_data = graph[node_id]
        class_type = node_data.get("class_type")
        if not class_type or class_type not in nodes.NODE_CLASS_MAPPINGS:
            print(f"[engine_diffusion] Skipping unmapped node [{node_id}] {class_type}")
            return None

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

        print(f"[engine_diffusion] Executing node [{node_id}] {class_type} -> {func_name}...")

        # Optimizations for DirectML GPU execution
        if class_type == "CheckpointLoaderSimple":
            ckpt_name = resolved_inputs.get("ckpt_name")
            cache_key = ("CheckpointLoaderSimple", ckpt_name)
            if cache_key in _COMFY_NODE_CACHE:
                print(f"[engine_diffusion] Reusing cached checkpoint model: {ckpt_name}")
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            # Invalidate older models and dependent LoRAs when switching checkpoints
            for k in list(_COMFY_NODE_CACHE.keys()):
                if k[0] in ("CheckpointLoaderSimple", "LoraLoader"):
                    del _COMFY_NODE_CACHE[k]

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
            cache_key = ("LoraLoader", lora_name, sm, sc, id(m_in), id(c_in))
            if cache_key in _COMFY_NODE_CACHE:
                print(f"[engine_diffusion] Reusing cached LoRA weights: {lora_name}")
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            outs = func(**resolved_inputs)
            _COMFY_NODE_CACHE[cache_key] = outs
            executed_outputs[node_id] = outs
            return outs

        if class_type == "UltralyticsDetectorProvider":
            m_name = resolved_inputs.get("model_name")
            cache_key = ("UltralyticsDetectorProvider", m_name)
            if cache_key in _COMFY_NODE_CACHE:
                print(f"[engine_diffusion] Reusing cached detector: {m_name}")
                executed_outputs[node_id] = _COMFY_NODE_CACHE[cache_key]
                return executed_outputs[node_id]

            outs = func(**resolved_inputs)
            _COMFY_NODE_CACHE[cache_key] = outs
            executed_outputs[node_id] = outs
            return outs

        outs = func(**resolved_inputs)
        executed_outputs[node_id] = outs

        if class_type in ("KSampler", "VAEDecode", "FaceDetailer"):
            gc.collect()
            try:
                import comfy.model_management as mm
                mm.soft_empty_cache()
            except Exception:
                pass
            if torch.cuda.is_available():
                try:
                    torch.cuda.empty_cache()
                except Exception:
                    pass
            try:
                import torch_directml
                if hasattr(torch_directml, "empty_cache"):
                    torch_directml.empty_cache()
            except Exception:
                pass

        return outs

    final_images = None
    with torch.inference_mode():
        # Priority search for terminal output node (PreviewImage / SaveImage -> FaceDetailer -> VAEDecode)
        target_nid = None
        for ptype in ("PreviewImage", "SaveImage", "FaceDetailer", "VAEDecode"):
            for nid, nd in graph.items():
                if nd.get("class_type") == ptype:
                    target_nid = nid
                    break
            if target_nid:
                break

        if target_nid:
            res = execute_node(target_nid)
            if res is not None:
                if isinstance(res, (list, tuple)) and len(res) > 0 and hasattr(res[0], "shape"):
                    final_images = res[0]
                elif isinstance(res, dict) and "images" in res:
                    final_images = res["images"]

        # Search executed outputs for any rendered image tensor if final_images wasn't directly returned by target_nid
        if final_images is None:
            for nid in reversed(list(executed_outputs.keys())):
                out = executed_outputs[nid]
                if isinstance(out, (list, tuple)) and len(out) > 0 and hasattr(out[0], "shape") and len(out[0].shape) == 4:
                    final_images = out[0]
                    break

    from PIL import Image
    import numpy as np

    result_image = None
    if final_images is not None:
        img_array = (final_images[0].detach().cpu().numpy() * 255).astype(np.uint8)
        result_image = Image.fromarray(img_array)
        if save_path:
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            result_image.save(save_path)
            print(f"[engine_diffusion] Image saved dynamically to {save_path}")
        del img_array

    # Explicitly release GPU tensor references and flush caches
    executed_outputs.clear()
    del final_images
    gc.collect()
    try:
        import comfy.model_management as mm
        mm.soft_empty_cache()
        mm.cleanup_models_gc()
    except Exception:
        pass
    if torch.cuda.is_available():
        try:
            torch.cuda.empty_cache()
        except Exception:
            pass
    try:
        import torch_directml
        if hasattr(torch_directml, "empty_cache"):
            torch_directml.empty_cache()
    except Exception:
        pass

    if result_image is not None:
        return result_image, save_path or ""

    return None, ""


def _generate_portrait_image_inprocess(
    prompt: str,
    negative_prompt: str = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text",
    checkpoint: Optional[str] = None,
    width: int = 832,
    height: int = 1248,
    num_inference_steps: int = 24,
    guidance_scale: float = 6.0,
    sampler_name: str = "euler",
    scheduler: str = "simple",
    seed: Optional[int] = None,
    workflow_path: Optional[str] = None,
    save_path: Optional[str] = None
) -> str:
    if seed is None:
        seed = random.randint(1, 1125899906842624)

    wf_file = workflow_path or os.getenv("COMFYUI_IMAGE_WORKFLOW", "core/skills/portrait_generation/ImageWorkflow.json")
    if not os.path.isabs(wf_file):
        wf_file = os.path.normpath(os.path.join(root_dir, wf_file))

    active_ckpt = checkpoint or get_active_checkpoint() or os.getenv("COMFYUI_CHECKPOINT")
    try:
        selected_checkpoint = os.path.basename(resolve_checkpoint_path(active_ckpt))
    except Exception:
        selected_checkpoint = active_ckpt or "sd_xl_base_1.0.safetensors"

    if os.path.exists(wf_file):
        print(f"[engine_diffusion] Adapting dynamically to workflow: {wf_file} with checkpoint: {selected_checkpoint}")
        replacements = {
            "%prompt%": prompt,
            "%negative_prompt%": negative_prompt,
            "%seed%": seed,
            "%model%": selected_checkpoint,
            "%vae%": ""
        }
        _, out_path = execute_workflow_graph(wf_file, replacements=replacements, save_path=save_path)
        if out_path and os.path.exists(out_path):
            return out_path

    # Fallback to direct node synthesis if no workflow file exists
    comfy_dir = os.path.normpath(os.path.join(root_dir, "core", "comfy_engine"))
    if comfy_dir not in sys.path:
        sys.path.insert(0, comfy_dir)

    import folder_paths
    folder_paths.folder_names_and_paths["checkpoints"] = ([os.path.join(root_dir, "models", "checkpoints")], folder_paths.supported_pt_extensions)
    folder_paths.folder_names_and_paths["loras"] = ([os.path.join(root_dir, "models", "loras")], folder_paths.supported_pt_extensions)

    import nodes
    import comfy.model_management

    ckpt_loader = nodes.CheckpointLoaderSimple()
    model, clip, vae = ckpt_loader.load_checkpoint(selected_checkpoint)
    try:
        model.model.to(torch.float16)
    except Exception:
        pass

    clip_encoder = nodes.CLIPTextEncode()
    positive = clip_encoder.encode(clip, prompt)[0]
    negative = clip_encoder.encode(clip, negative_prompt)[0]

    latent_node = nodes.EmptyLatentImage()
    latent = latent_node.generate(width, height, 1)[0]

    ksampler = nodes.KSampler()
    samples = ksampler.sample(model, seed, num_inference_steps, guidance_scale, sampler_name, scheduler, positive, negative, latent, 1.0)[0]

    try:
        vae.first_stage_model.to("cpu")
        vae.device = torch.device("cpu")
        vae.output_device = torch.device("cpu")
    except Exception:
        pass

    samples_cpu = {"samples": samples["samples"].to("cpu")}
    vae_decoder = nodes.VAEDecode()
    images = vae_decoder.decode(vae, samples_cpu)[0]

    from PIL import Image
    import numpy as np
    img_array = (images[0].detach().cpu().numpy() * 255).astype(np.uint8)
    image = Image.fromarray(img_array)

    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        image.save(save_path)
        print(f"[engine_diffusion] Portrait saved to {save_path}")

    return save_path or ""


def generate_portrait_image(
    prompt: str,
    negative_prompt: str = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text",
    checkpoint: Optional[str] = None,
    width: int = 832,
    height: int = 1248,
    num_inference_steps: int = 24,
    guidance_scale: float = 6.0,
    sampler_name: str = "euler",
    scheduler: str = "simple",
    seed: Optional[int] = None,
    workflow_path: Optional[str] = None,
    save_path: Optional[str] = None
) -> str:
    """Generates an image via persistent diffusion daemon, maintaining cached models across calls."""
    if os.getenv("DIFFUSION_WORKER") == "1":
        return _generate_portrait_image_inprocess(
            prompt=prompt,
            negative_prompt=negative_prompt,
            checkpoint=checkpoint,
            width=width,
            height=height,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            sampler_name=sampler_name,
            scheduler=scheduler,
            seed=seed,
            workflow_path=workflow_path,
            save_path=save_path
        )

    if not ensure_server_running():
        raise RuntimeError("Failed to start persistent diffusion server worker.")

    import urllib.request
    import urllib.error

    payload = {
        "prompt": prompt,
        "negative_prompt": negative_prompt,
        "checkpoint": checkpoint,
        "width": width,
        "height": height,
        "num_inference_steps": num_inference_steps,
        "guidance_scale": guidance_scale,
        "sampler_name": sampler_name,
        "scheduler": scheduler,
        "seed": seed,
        "workflow_path": workflow_path,
        "save_path": save_path
    }

    req_data = json.dumps(payload).encode("utf-8")

    for attempt in range(2):
        req = urllib.request.Request(
            f"{DIFFUSION_SERVER_URL}/generate",
            data=req_data,
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                res_json = json.loads(resp.read().decode("utf-8"))
                if res_json.get("status") == "ok":
                    return res_json.get("path", "")
                else:
                    raise RuntimeError(res_json.get("error", "Unknown diffusion error"))
        except urllib.error.HTTPError as http_err:
            try:
                err_body = json.loads(http_err.read().decode("utf-8"))
                detail = err_body.get("error", str(http_err))
            except Exception:
                detail = str(http_err)

            # If DirectML GPU device was suspended/removed by OS during LLM usage, restart worker and retry once
            is_device_err = any(k in detail.lower() for k in ("suspended", "deviceremoved", "device removed", "dxgi_error", "reset"))
            if attempt == 0 and is_device_err:
                print(f"[engine_diffusion] GPU device was suspended ({detail}). Restarting worker for clean GPU context...", flush=True)
                unload_diffusion_models()
                if ensure_server_running():
                    continue

            raise RuntimeError(f"Diffusion error: {detail}") from http_err
        except Exception as conn_err:
            if attempt == 0:
                print(f"[engine_diffusion] Connection to worker failed ({conn_err}). Restarting worker...", flush=True)
                unload_diffusion_models()
                if ensure_server_running():
                    continue
            raise conn_err


if __name__ == "__main__":
    import argparse
    from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

    parser = argparse.ArgumentParser()
    parser.add_argument("--server", action="store_true", help="Run as HTTP diffusion worker")
    args = parser.parse_args()

    if args.server:
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
                        try:
                            cfg = json.loads(body.decode("utf-8"))
                            out_path = _generate_portrait_image_inprocess(**cfg)
                            self.send_response(200)
                            self.send_header("Content-Type", "application/json")
                            self.end_headers()
                            self.wfile.write(json.dumps({"status": "ok", "path": out_path}).encode("utf-8"))
                        except Exception as ex:
                            self.send_response(500)
                            self.send_header("Content-Type", "application/json")
                            self.end_headers()
                            self.wfile.write(json.dumps({"status": "error", "error": str(ex)}).encode("utf-8"))
                        finally:
                            _worker_is_generating = False
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
