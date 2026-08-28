"""
core/engine_diffusion.py — Native in-process image diffusion engine.

Eliminates the ComfyUI server dependency by running Stable Diffusion (SD1.5 / SDXL / Pony)
pipelines and LoRAs directly in-process via diffusers/torch with CUDA/DirectML/CPU acceleration.
"""

import os
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
_preferred_checkpoint: Optional[str] = None
_active_loras: List[str] = []


def set_active_checkpoint(name: str) -> bool:
    """Sets the active checkpoint model preference."""
    global _preferred_checkpoint
    _preferred_checkpoint = name
    return True


def get_active_checkpoint() -> Optional[str]:
    """Gets the active checkpoint model preference."""
    global _preferred_checkpoint, _active_checkpoint
    if _preferred_checkpoint:
        return _preferred_checkpoint
    if _active_checkpoint:
        return os.path.basename(_active_checkpoint)
    ckpts = list_checkpoints()
    return ckpts[0]["name"] if ckpts else None



def list_checkpoints() -> List[Dict[str, Any]]:
    """Scans models/checkpoints and models/ for diffusion weights."""
    checkpoints = []
    seen = set()

    for search_dir in (CHECKPOINTS_DIR, MODELS_DIR):
        if not os.path.exists(search_dir):
            continue
        try:
            for root, _, files in os.walk(search_dir):
                for f in files:
                    lower = f.lower()
                    if (lower.endswith(".safetensors") or lower.endswith(".ckpt")) and f not in seen:
                        # Skip if in loras or vae directory
                        rel = os.path.relpath(root, MODELS_DIR).lower()
                        if "lora" in rel or "vae" in rel:
                            continue
                        seen.add(f)
                        full_path = os.path.join(root, f)
                        size_gb = round(os.path.getsize(full_path) / (1024 ** 3), 2)
                        checkpoints.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_gb": size_gb,
                            "folder": os.path.relpath(root, MODELS_DIR)
                        })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning checkpoints in {search_dir}: {e}")

    return sorted(checkpoints, key=lambda x: x["name"])


def list_loras() -> List[Dict[str, Any]]:
    """Scans models/loras for LoRA weights."""
    loras = []
    seen = set()

    if os.path.exists(LORAS_DIR):
        try:
            for root, _, files in os.walk(LORAS_DIR):
                for f in files:
                    if f.lower().endswith(".safetensors") and f not in seen:
                        seen.add(f)
                        full_path = os.path.join(root, f)
                        size_mb = round(os.path.getsize(full_path) / (1024 ** 2), 1)
                        loras.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_mb": size_mb,
                            "folder": os.path.relpath(root, LORAS_DIR)
                        })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning loras: {e}")

    return sorted(loras, key=lambda x: x["name"])


def list_vaes() -> List[Dict[str, Any]]:
    """Scans models/vae for VAE files."""
    vaes = []
    seen = set()

    if os.path.exists(VAE_DIR):
        try:
            for root, _, files in os.walk(VAE_DIR):
                for f in files:
                    if (f.lower().endswith(".safetensors") or f.lower().endswith(".pt")) and f not in seen:
                        seen.add(f)
                        full_path = os.path.join(root, f)
                        size_mb = round(os.path.getsize(full_path) / (1024 ** 2), 1)
                        vaes.append({
                            "name": f,
                            "filename": f,
                            "path": full_path,
                            "size_mb": size_mb
                        })
        except Exception as e:
            print(f"[engine_diffusion] Error scanning VAEs: {e}")

    return sorted(vaes, key=lambda x: x["name"])


def resolve_checkpoint_path(ckpt_name: str) -> Optional[str]:
    """Resolves full path of a checkpoint file."""
    if not ckpt_name:
        return None
    if os.path.isabs(ckpt_name) and os.path.exists(ckpt_name):
        return ckpt_name
    for item in list_checkpoints():
        if item["name"].lower() == ckpt_name.lower() or item["filename"].lower() == ckpt_name.lower():
            return item["path"]
    direct = os.path.join(CHECKPOINTS_DIR, ckpt_name)
    if os.path.exists(direct):
        return direct
    return None


def resolve_lora_path(lora_name: str) -> Optional[str]:
    """Resolves full path of a LoRA file."""
    if not lora_name:
        return None
    if os.path.isabs(lora_name) and os.path.exists(lora_name):
        return lora_name
    for item in list_loras():
        if item["name"].lower() == lora_name.lower() or item["filename"].lower() == lora_name.lower():
            return item["path"]
    direct = os.path.join(LORAS_DIR, lora_name)
    if os.path.exists(direct):
        return direct
    return None


def unload_diffusion_pipeline() -> bool:
    """Unloads the active diffusion pipeline and clears GPU cache."""
    global _active_pipe, _active_checkpoint, _active_loras
    with _diffusion_lock:
        if _active_pipe is not None:
            del _active_pipe
            _active_pipe = None
            _active_checkpoint = None
            _active_loras = []
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            print("[engine_diffusion] Diffusion pipeline unloaded.")
            return True
    return False


def get_or_load_pipeline(
    checkpoint_name_or_path: Optional[str] = None,
    vae_name: Optional[str] = None,
    loras: Optional[List[Tuple[str, float]]] = None
):
    """Loads or retrieves the diffusion pipeline."""
    global _active_pipe, _active_checkpoint, _active_loras

    device = "cuda" if torch.cuda.is_available() else "cpu"
    dtype = torch.float16 if device == "cuda" else torch.float32

    # If no checkpoint specified, pick preferred or first available in models/checkpoints
    ckpt_path = None
    if checkpoint_name_or_path:
        ckpt_path = resolve_checkpoint_path(checkpoint_name_or_path)
    elif _preferred_checkpoint:
        ckpt_path = resolve_checkpoint_path(_preferred_checkpoint)

    if not ckpt_path:
        available = list_checkpoints()
        if available:
            ckpt_path = available[0]["path"]

    if not ckpt_path or not os.path.exists(ckpt_path):
        raise ValueError("No diffusion checkpoint found. Place your SafeTensors model in models/checkpoints/.")

    with _diffusion_lock:
        # Check if already loaded with same checkpoint
        if _active_pipe is not None and _active_checkpoint == ckpt_path:
            return _active_pipe

        # Unload previous pipeline
        if _active_pipe is not None:
            del _active_pipe
            _active_pipe = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

        from diffusers import AutoPipelineForText2Image, DPMSolverMultistepScheduler

        print(f"[engine_diffusion] Loading diffusion pipeline from {ckpt_path} on {device} ({dtype})...")
        pipe = AutoPipelineForText2Image.from_single_file(
            ckpt_path,
            torch_dtype=dtype,
            use_safetensors=ckpt_path.lower().endswith(".safetensors")
        )

        pipe.scheduler = DPMSolverMultistepScheduler.from_config(pipe.scheduler.config, use_karras_sigmas=True)
        pipe.to(device)

        # Enable memory optimizations if on CUDA
        if device == "cuda":
            try:
                pipe.enable_attention_slicing()
            except Exception:
                pass

        # Load specified LoRAs
        if loras:
            for lora_name, scale in loras:
                lora_path = resolve_lora_path(lora_name)
                if lora_path and os.path.exists(lora_path):
                    try:
                        print(f"[engine_diffusion] Loading LoRA '{lora_name}' (weight={scale})...")
                        adapter_name = os.path.splitext(os.path.basename(lora_name))[0]
                        pipe.load_lora_weights(os.path.dirname(lora_path), weight_name=os.path.basename(lora_path), adapter_name=adapter_name)
                        pipe.set_adapters([adapter_name], adapter_weights=[float(scale)])
                    except Exception as le:
                        print(f"[engine_diffusion] Warning loading LoRA {lora_name}: {le}")

        _active_pipe = pipe
        _active_checkpoint = ckpt_path
        print(f"[engine_diffusion] Diffusion pipeline loaded successfully.")
        return _active_pipe


def generate_portrait_image(
    prompt: str,
    negative_prompt: str = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text",
    checkpoint: Optional[str] = None,
    loras: Optional[List[Tuple[str, float]]] = None,
    width: int = 832,
    height: int = 1216,
    num_inference_steps: int = 24,
    guidance_scale: float = 6.0,
    seed: Optional[int] = None,
    save_path: Optional[str] = None
) -> str:
    """Generates an image directly in-process and writes the output PNG to save_path."""
    if seed is None or seed < 0:
        seed = random.randint(1, 2147483647)

    generator = torch.Generator(device="cuda" if torch.cuda.is_available() else "cpu").manual_seed(seed)

    pipe = get_or_load_pipeline(checkpoint_name_or_path=checkpoint, loras=loras)

    print(f"[engine_diffusion] Generating portrait (Steps={num_inference_steps}, CFG={guidance_scale}, Seed={seed}, Size={width}x{height})...")
    
    with torch.inference_mode():
        image = pipe(
            prompt=prompt,
            negative_prompt=negative_prompt,
            width=width,
            height=height,
            num_inference_steps=num_inference_steps,
            guidance_scale=guidance_scale,
            generator=generator
        ).images[0]

    if save_path:
        os.makedirs(os.path.dirname(save_path), exist_ok=True)
        image.save(save_path, "PNG")
        print(f"[engine_diffusion] Portrait saved to {save_path}")
        return save_path

    return ""
