"""
core/engine_diffusion.py — Internal GPU-accelerated diffusion engine.

Executes SDXL image generation directly in-process with PyTorch/GPU acceleration,
using the exact parameters from ImageWorkflow.json.
"""

import os
import sys
import gc
import json
import time
import random
import threading
from typing import List, Dict, Any, Optional, Tuple

import torch
from variables.settings import CHECKPOINTS_DIR, LORAS_DIR, VAE_DIR, MODELS_DIR

_diffusion_lock = threading.Lock()
_active_pipe = None
_active_checkpoint: Optional[str] = None
_COMFY_NODE_CACHE: Dict[Tuple[Any, ...], Any] = {}
root_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def resolve_checkpoint_path(checkpoint_name: Optional[str] = None) -> str:
    """Resolves the absolute path to the requested or default checkpoint model."""
    if checkpoint_name and os.path.exists(checkpoint_name):
        return checkpoint_name

    candidates = []
    if checkpoint_name:
        candidates.append(os.path.join(CHECKPOINTS_DIR, checkpoint_name))
        candidates.append(os.path.join(MODELS_DIR, checkpoint_name))

    candidates.append(os.path.join(CHECKPOINTS_DIR, "WAI_illustrious-SDXL_16.safetensors"))
    candidates.append(os.path.join(CHECKPOINTS_DIR, "sd_xl_base_1.0.safetensors"))

    for path in candidates:
        if os.path.exists(path):
            return path

    if os.path.exists(CHECKPOINTS_DIR):
        for f in os.listdir(CHECKPOINTS_DIR):
            if f.lower().endswith((".safetensors", ".ckpt")):
                return os.path.join(CHECKPOINTS_DIR, f)

    raise FileNotFoundError(f"No checkpoint models found in {CHECKPOINTS_DIR}.")


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
    ckpts = list_checkpoints()
    for c in ckpts:
        if "illustrious" in c["filename"].lower() or "sdxl" in c["filename"].lower():
            return c["filename"]
    return ckpts[0]["filename"] if ckpts else None


def set_active_checkpoint(checkpoint_name: str) -> bool:
    """Sets the active diffusion checkpoint."""
    global _active_checkpoint
    try:
        resolved = resolve_checkpoint_path(checkpoint_name)
        _active_checkpoint = resolved
        print(f"[engine_diffusion] Active checkpoint set to: {resolved}")
        return True
    except Exception as e:
        print(f"[engine_diffusion] Failed to set active checkpoint: {e}")
        return False


def _detect_device():
    try:
        import torch_directml
        return torch_directml.device(), torch.float16, "directml"
    except Exception:
        if torch.cuda.is_available():
            return torch.device("cuda"), torch.float16, "cuda"
        return torch.device("cpu"), torch.float32, "cpu"


def get_or_load_pipeline(checkpoint_name_or_path: Optional[str] = None):
    """Loads and caches the diffusers pipeline on the available compute device."""
    global _active_pipe, _active_checkpoint

    ckpt_path = resolve_checkpoint_path(checkpoint_name_or_path)

    with _diffusion_lock:
        if _active_pipe is not None and _active_checkpoint == ckpt_path:
            return _active_pipe

        if _active_pipe is not None:
            print("[engine_diffusion] Unloading existing pipeline...")
            del _active_pipe
            _active_pipe = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        from diffusers import StableDiffusionXLPipeline, StableDiffusionPipeline, DPMSolverMultistepScheduler

        device_obj, dtype, dev_kind = _detect_device()
        if dev_kind == "cpu":
            torch.set_num_threads(os.cpu_count() or 8)

        print(f"[engine_diffusion] Loading diffusion pipeline from {ckpt_path} on {dev_kind} ({dtype})...")
        try:
            pipe = StableDiffusionXLPipeline.from_single_file(
                ckpt_path,
                torch_dtype=dtype,
                use_safetensors=ckpt_path.lower().endswith(".safetensors")
            )
        except Exception as sdxl_err:
            print(f"[engine_diffusion] Note: SDXL single file loader: {sdxl_err}. Trying SD1.5 loader...")
            pipe = StableDiffusionPipeline.from_single_file(
                ckpt_path,
                torch_dtype=dtype,
                use_safetensors=ckpt_path.lower().endswith(".safetensors")
            )

        try:
            pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
        except Exception:
            pass

        pipe.to(device_obj)

        if dev_kind in ("cuda", "directml"):
            try:
                pipe.enable_attention_slicing("max")
                pipe.enable_vae_slicing()
                pipe.enable_vae_tiling()
            except Exception:
                pass

        if dev_kind == "directml":
            try:
                pipe.vae.to(torch.device("cpu"))
                print("[engine_diffusion] Placed VAE on CPU to prevent DirectML memory allocation limits.")
            except Exception:
                pass

        _active_pipe = pipe
        _active_checkpoint = ckpt_path
        print(f"[engine_diffusion] Pipeline loaded successfully.")
        return _active_pipe


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
            wf_str = f.read()
    else:
        wf_str = json.dumps(workflow_path_or_dict)

    if replacements:
        for k, v in replacements.items():
            if k == "%seed%":
                wf_str = wf_str.replace(f'"{k}"', str(v))
            wf_str = wf_str.replace(k, str(v))

    graph: Dict[str, Any] = json.loads(wf_str)
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

            outs = func(**resolved_inputs)
            model, clip, vae = outs[0], outs[1], outs[2]
            try:
                model.model.to(torch.float16)
            except Exception:
                pass
            res = (model, clip, vae)
            _COMFY_NODE_CACHE[cache_key] = res
            executed_outputs[node_id] = res
            return res

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

    if final_images is not None:
        img_array = (final_images[0].detach().cpu().numpy() * 255).astype(np.uint8)
        image = Image.fromarray(img_array)
        if save_path:
            os.makedirs(os.path.dirname(save_path), exist_ok=True)
            image.save(save_path)
            print(f"[engine_diffusion] Image saved dynamically to {save_path}")
        return image, save_path or ""

    return None, ""


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
    """Generates an image adaptively from whatever workflow JSON is present."""
    if seed is None or seed < 0:
        seed = random.randint(1, 2147483647)

    wf_file = workflow_path or os.getenv("COMFYUI_IMAGE_WORKFLOW", "core/skills/portrait_generation/ImageWorkflow.json")
    if not os.path.isabs(wf_file):
        wf_file = os.path.normpath(os.path.join(root_dir, wf_file))

    selected_checkpoint = checkpoint or "WAI_illustrious-SDXL_16.safetensors"

    if os.path.exists(wf_file):
        print(f"[engine_diffusion] Adapting dynamically to workflow: {wf_file}")
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
