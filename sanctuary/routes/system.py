import asyncio
import colorsys
import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid
from contextlib import nullcontext
from pathlib import Path

from flask import Blueprint, Response, jsonify, make_response, request, send_file, send_from_directory

import state as st
import variables.settings as vs
from runners.runner import cancelled_sessions, voice_call_sessions
from runners.program import (
    get_active_program,
    get_active_session,
    get_active_user,
    set_active_program,
    set_active_session,
)
from models.models import fetch_local_models

system_bp = Blueprint("system_bp", __name__)


@system_bp.route('/models', methods=['GET'])
@st.requires_auth
def get_models():
    # Check if Remote API key and Cloud URL are validly configured
    is_remote_configured, _, remote_cloud_url = st.remote_configuration()
    
    from runners.local_server import check_local_server_status
    is_local_online = check_local_server_status()
    
    # 1. Fetch dynamic local models (only actively loaded models in Local LLM server)
    models = fetch_local_models()
    
    # Default selection: use the first loaded local model if available, otherwise "local-llm"
    default_model = "local-llm"
    if models and models[0]["value"] != "local-llm":
        default_model = models[0]["value"]
        
    temperature = st.load_temperature()
        
    return jsonify({
        "models": models,
        "default": default_model,
        "status": {
            "remote_configured": is_remote_configured,
            "remote_model": os.getenv("REMOTE_MODEL", ""),
            "remote_url": remote_cloud_url,
            "local_online": is_local_online,
            "temperature": temperature
        }
    })


_VALID_BROWSER_SEARCH_ENGINES = frozenset({
    "duckduckgo",
    "ecosia",
    "startpage",
    "brave",
    "kagi",
    "qwant",
    "searxng",
    "wikipedia",
    "perplexity",
    "google",
    "bing",
    "custom",
})


def _normalize_browser_search_engine(raw: object) -> str:
    val = str(raw or "").strip().lower()
    if val == "ddg":
        return "duckduckgo"
    return val if val in _VALID_BROWSER_SEARCH_ENGINES else ""


_OPENHANDS_ENV_FIELDS = (
    ("greenpt_api_key", "GREENPT_API_KEY", ""),
    ("greenpt_base_url", "GREENPT_BASE_URL", "https://api.greenpt.ai/v1"),
    ("openhands_model", "OPENHANDS_MODEL", "glm-5.3"),
    ("cloud_fast_model", "CLOUD_FAST_MODEL", ""),
    ("cloud_vision_model", "CLOUD_VISION_MODEL", ""),
    ("cloud_private_model", "CLOUD_PRIVATE_MODEL", ""),
    ("cloud_checkpoint_model", "CLOUD_CHECKPOINT_MODEL", ""),
    ("routing_policy", "SANCTUARY_ROUTING_POLICY", "auto"),
)


def _sync_openhands_env(settings: dict) -> None:
    """Propagate OpenHands + GreenPT settings into process environment."""
    for field_key, env_key, default_val in _OPENHANDS_ENV_FIELDS:
        val = str(settings.get(field_key) or "").strip() or default_val
        if field_key == "greenpt_api_key" and not val:
            vault_key, _init, unlocked = _read_vault_greenpt_key()
            if unlocked and vault_key:
                val = vault_key
        if val:
            os.environ[env_key] = val
        else:
            os.environ.pop(env_key, None)
    for opt_key, env_key in (
        ("cloud_context_tokens", "CLOUD_CONTEXT_TOKENS"),
        ("cloud_max_output_tokens", "CLOUD_MAX_OUTPUT_TOKENS"),
    ):
        opt_val = str(settings.get(opt_key) or "").strip()
        if opt_val:
            os.environ[env_key] = opt_val
        else:
            os.environ.pop(env_key, None)
    for stale_env in ("OPENHANDS_MODE", "OPENHANDS_SERVER_PORT", "OPENHANDS_AUTO_START_SERVER"):
        os.environ.pop(stale_env, None)


def _read_vault_greenpt_key() -> tuple[str, bool, bool]:
    try:
        from utils.keepassxc_client import get_keepassxc_bridge

        bridge = get_keepassxc_bridge()
        initialized = bridge.is_initialized()
        unlocked = bridge.is_unlocked()
        if unlocked:
            return bridge.get_secret("greenpt_api_key"), initialized, True
        return "", initialized, False
    except Exception:
        return "", False, False


def _write_vault_greenpt_key(secret: str) -> bool:
    try:
        from utils.keepassxc_client import get_keepassxc_bridge

        bridge = get_keepassxc_bridge()
        if not bridge.is_unlocked():
            return False
        bridge.set_secret("greenpt_api_key", secret, title="Cloud API Key")
        return True
    except Exception:
        return False


def sync_vault_api_keys_to_env() -> None:
    val, _init, unlocked = _read_vault_greenpt_key()
    if unlocked and val:
        os.environ["GREENPT_API_KEY"] = val


def clear_vault_api_keys_from_env() -> None:
    settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
    try:
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
            if settings.get("greenpt_api_key_in_vault"):
                os.environ.pop("GREENPT_API_KEY", None)
    except Exception:
        pass


def mark_greenpt_key_in_vault(in_vault: bool, secret: str = "") -> None:
    if secret:
        os.environ["GREENPT_API_KEY"] = secret
    else:
        os.environ.pop("GREENPT_API_KEY", None)
    settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
    if not os.path.exists(settings_path):
        return
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        settings["greenpt_api_key"] = ""
        settings["greenpt_api_key_in_vault"] = bool(in_vault)
        from runners.program import _save_settings

        _save_settings(settings)
    except Exception:
        pass


def migrate_plaintext_api_keys_to_vault() -> None:
    settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
    if not os.path.exists(settings_path):
        return
    try:
        with open(settings_path, "r", encoding="utf-8") as f:
            settings = json.load(f)
        plain = str(settings.get("greenpt_api_key") or "").strip()
        if plain and _write_vault_greenpt_key(plain):
            settings["greenpt_api_key"] = ""
            settings["greenpt_api_key_in_vault"] = True
            from runners.program import _save_settings

            _save_settings(settings)
            os.environ["GREENPT_API_KEY"] = plain
    except Exception:
        pass


@system_bp.route('/api/project_settings', methods=['GET', 'POST'])
@st.requires_auth
def project_settings():
    import json
    settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
    
    # Get active program
    from runners.program import get_active_program
    active_prog = get_active_program()
    default_folder = os.path.normpath(os.path.join(str(st.base_dir), 'core', 'programs', active_prog))
    
    # Define default settings
    default_settings = {
        "folders": [default_folder],
        "security_preset": "ask_always",
        "artifact_review_policy": "ask_always",
        "greenpt_api_key": os.getenv("GREENPT_API_KEY", "").strip(),
        "greenpt_base_url": (os.getenv("GREENPT_BASE_URL", "https://api.greenpt.ai/v1").strip() or "https://api.greenpt.ai/v1"),
        "routing_policy": (os.getenv("SANCTUARY_ROUTING_POLICY", "auto").strip().lower() if os.getenv("SANCTUARY_ROUTING_POLICY", "auto").strip().lower() in ("auto", "local_only", "eco_flash", "private_tee") else "auto"),
        "openhands_model": (os.getenv("OPENHANDS_MODEL", "glm-5.3").strip() or "glm-5.3"),
        "cloud_fast_model": os.getenv("CLOUD_FAST_MODEL", "").strip(),
        "cloud_vision_model": os.getenv("CLOUD_VISION_MODEL", "").strip(),
        "cloud_private_model": os.getenv("CLOUD_PRIVATE_MODEL", "").strip(),
        "cloud_checkpoint_model": os.getenv("CLOUD_CHECKPOINT_MODEL", "").strip(),
        "search_engine": "web_crawling",
        "searxng_url": "",
        "browser_search_engine": "",
        "browser_custom_search_url": "",
        "tts_voice": "af_heart"
    }
    
    if request.method == 'GET':
        if not os.path.exists(settings_path):
            try:
                from runners.program import _save_settings

                _save_settings(default_settings)
                return jsonify(default_settings)
            except Exception as e:
                print(f"Error creating default project settings: {e}")
                return jsonify(default_settings)
        else:
            try:
                with open(settings_path, "r", encoding="utf-8") as f:
                    settings = json.load(f)
                # Ensure fields are present
                dirty = False
                for k, v in default_settings.items():
                    if k not in settings:
                        settings[k] = v
                        dirty = True
                
                # Only remap folders[0] automatically if it points to another managed program dir
                if "folders" in settings and len(settings["folders"]) > 0:
                    first_folder = os.path.normpath(settings["folders"][0])
                    programs_root = os.path.normpath(os.path.join(str(st.base_dir), 'core', 'programs'))
                    norm_first = os.path.normcase(first_folder)
                    norm_root = os.path.normcase(programs_root)
                    is_managed_prog = norm_first == norm_root or norm_first.startswith(norm_root + os.sep)
                    if is_managed_prog and first_folder != default_folder:
                        settings["folders"][0] = default_folder
                        dirty = True
                
                if settings.get("search_engine") not in ("web_crawling", "wikipedia"):
                    settings["search_engine"] = "web_crawling"
                    dirty = True

                norm_browser_eng = _normalize_browser_search_engine(settings.get("browser_search_engine"))
                if norm_browser_eng != settings.get("browser_search_engine"):
                    settings["browser_search_engine"] = norm_browser_eng
                    dirty = True

                if "gemini_api_key" in settings:
                    settings.pop("gemini_api_key", None)
                    dirty = True

                for stale_key in ("openhands_mode", "openhands_server_port", "openhands_auto_start_server"):
                    if stale_key in settings:
                        settings.pop(stale_key, None)
                        dirty = True

                if str(settings.get("cloud_context_tokens") or "").strip() == "262144":
                    settings.pop("cloud_context_tokens", None)
                    dirty = True
                if str(settings.get("cloud_max_output_tokens") or "").strip() == "32768":
                    settings.pop("cloud_max_output_tokens", None)
                    dirty = True

                for field_key, env_key, default_val in _OPENHANDS_ENV_FIELDS:
                    if field_key == "greenpt_api_key" and settings.get("greenpt_api_key_in_vault"):
                        continue
                    saved_val = str(settings.get(field_key) or "").strip()
                    env_val = os.getenv(env_key, "").strip()
                    if not saved_val and (env_val or default_val):
                        settings[field_key] = env_val or default_val
                        dirty = True

                norm_policy = str(settings.get("routing_policy") or "auto").strip().lower()
                if norm_policy not in ("auto", "local_only", "eco_flash"):
                    settings["routing_policy"] = "auto"
                    dirty = True

                _sync_openhands_env(settings)

                vault_key, vault_init, vault_unlocked = _read_vault_greenpt_key()
                if vault_unlocked and str(settings.get("greenpt_api_key") or "").strip():
                    if _write_vault_greenpt_key(str(settings["greenpt_api_key"]).strip()):
                        vault_key = str(settings["greenpt_api_key"]).strip()
                        settings["greenpt_api_key"] = ""
                        settings["greenpt_api_key_in_vault"] = True
                        dirty = True

                if dirty:
                    from runners.program import _save_settings

                    _save_settings(settings)

                resp_settings = dict(settings)
                if vault_init and vault_unlocked and vault_key:
                    resp_settings["greenpt_api_key"] = vault_key
                    resp_settings["greenpt_api_key_in_vault"] = True
                    resp_settings["vault_locked"] = False
                elif vault_init and not vault_unlocked and settings.get("greenpt_api_key_in_vault"):
                    resp_settings["greenpt_api_key"] = ""
                    resp_settings["greenpt_api_key_in_vault"] = True
                    resp_settings["vault_locked"] = True
                else:
                    resp_settings["greenpt_api_key_in_vault"] = bool(settings.get("greenpt_api_key_in_vault"))
                    resp_settings["vault_locked"] = bool(vault_init and not vault_unlocked)
                return jsonify(resp_settings)
            except Exception as e:
                print(f"Error reading project settings: {e}")
                return jsonify(default_settings)
                
    elif request.method == 'POST':
        try:
            data = request.get_json() or {}
            # Load existing settings first so partial updates preserve unrelated fields
            settings = {}
            if os.path.exists(settings_path):
                try:
                    with open(settings_path, "r", encoding="utf-8") as f:
                        settings = json.load(f)
                except Exception:
                    pass

            if "folders" in data:
                folders = data.get("folders") or []
                cleaned_folders = []
                seen = set()

                for folder in folders:
                    if not folder:
                        continue
                    norm = os.path.normpath(folder)
                    key = norm.lower() if os.name == 'nt' else norm
                    if key not in seen:
                        cleaned_folders.append(norm)
                        seen.add(key)
                if not cleaned_folders:
                    cleaned_folders = [default_folder]
            else:
                cleaned_folders = settings.get("folders") or [default_folder]

            security_preset = data.get(
                "security_preset",
                settings.get("security_preset", default_settings["security_preset"]),
            )
            artifact_review_policy = data.get(
                "artifact_review_policy",
                settings.get("artifact_review_policy", default_settings["artifact_review_policy"]),
            )
            search_engine = data.get(
                "search_engine",
                settings.get("search_engine", default_settings["search_engine"]),
            )
            searxng_url = str(
                data.get("searxng_url", settings.get("searxng_url", default_settings["searxng_url"])) or ""
            ).strip()
            browser_search_engine = _normalize_browser_search_engine(
                data.get(
                    "browser_search_engine",
                    settings.get("browser_search_engine", default_settings["browser_search_engine"]),
                )
            )
            browser_custom_search_url = str(
                data.get(
                    "browser_custom_search_url",
                    settings.get("browser_custom_search_url", default_settings["browser_custom_search_url"]),
                )
                or ""
            ).strip()
            tts_voice = data.get("tts_voice", settings.get("tts_voice", default_settings["tts_voice"]))

            settings.pop("gemini_api_key", None)
            os.environ.pop("GEMINI_API_KEY", None)

            for opt_key, default_stamped in (
                ("cloud_context_tokens", "262144"),
                ("cloud_max_output_tokens", "32768"),
            ):
                if opt_key in data:
                    raw_opt = str(data.get(opt_key) or "").strip()
                    if raw_opt:
                        settings[opt_key] = raw_opt
                    else:
                        settings.pop(opt_key, None)
                elif str(settings.get(opt_key) or "").strip() == default_stamped:
                    settings.pop(opt_key, None)

            oh_updates = {}
            for field_key, _env_key, default_val in _OPENHANDS_ENV_FIELDS:
                if field_key in data:
                    val = str(data.get(field_key) or "").strip()
                    allow_empty = field_key in ("greenpt_api_key", "cloud_fast_model", "cloud_vision_model", "cloud_private_model", "cloud_checkpoint_model")
                    oh_updates[field_key] = val if (val or allow_empty) else default_val
                else:
                    oh_updates[field_key] = (
                        str(settings.get(field_key) or "").strip()
                        or default_val
                    )

            if oh_updates["routing_policy"].lower() not in ("auto", "local_only", "eco_flash", "private_tee"):
                oh_updates["routing_policy"] = "auto"
            else:
                oh_updates["routing_policy"] = oh_updates["routing_policy"].lower()

            try:
                from core import v1_client
                v1_client.clear_quota_cooldown()
            except Exception:
                pass

            for stale_key in ("openhands_mode", "openhands_server_port", "openhands_auto_start_server"):
                settings.pop(stale_key, None)

            settings.update({
                "folders": cleaned_folders,
                "security_preset": security_preset,
                "artifact_review_policy": artifact_review_policy,
                **oh_updates,
                "search_engine": search_engine,
                "searxng_url": searxng_url,
                "browser_search_engine": browser_search_engine,
                "browser_custom_search_url": browser_custom_search_url,
                "tts_voice": tts_voice,
            })

            vault_key_before, vault_init, vault_unlocked = _read_vault_greenpt_key()
            if "greenpt_api_key" in data and vault_init:
                submitted_key = str(oh_updates.get("greenpt_api_key") or "").strip()
                if vault_unlocked:
                    _write_vault_greenpt_key(submitted_key)
                    settings["greenpt_api_key"] = ""
                    settings["greenpt_api_key_in_vault"] = bool(submitted_key)
                    vault_key_before = submitted_key
                elif not submitted_key and settings.get("greenpt_api_key_in_vault"):
                    settings["greenpt_api_key"] = ""
            elif vault_unlocked and not str(settings.get("greenpt_api_key") or "").strip() and vault_key_before:
                settings["greenpt_api_key_in_vault"] = True

            # Keep environment variables and cached settings in sync
            os.environ["TTS_VOICE"] = tts_voice
            _sync_openhands_env(settings)
            if vault_unlocked and vault_key_before:
                os.environ["GREENPT_API_KEY"] = vault_key_before

            from runners.program import _save_settings

            _save_settings(settings)
            resp_settings = dict(settings)
            if vault_init and vault_unlocked and vault_key_before:
                resp_settings["greenpt_api_key"] = vault_key_before
                resp_settings["greenpt_api_key_in_vault"] = True
                resp_settings["vault_locked"] = False
            else:
                resp_settings["greenpt_api_key_in_vault"] = bool(settings.get("greenpt_api_key_in_vault"))
                resp_settings["vault_locked"] = bool(vault_init and not vault_unlocked)
            return jsonify({"status": "success", "settings": resp_settings})
        except Exception as e:
            print(f"Error saving project settings: {e}")
            return jsonify({"error": str(e)}), 500


@system_bp.route('/api/browse_folder', methods=['POST'])
@st.requires_auth
def browse_folder():
    import sys, subprocess, os, json
    title = "Select Workspace Folder"
    selected_folder = ""

    if sys.platform == 'darwin':
        try:
            cmd = ['osascript', '-e', f'set f to choose folder with prompt {json.dumps(title)}', '-e', 'POSIX path of f']
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                selected_folder = res.stdout.strip()
        except Exception as e:
            print(f"macOS folder dialog error: {e}")
    elif sys.platform.startswith('linux'):
        try:
            cmd = ['zenity', '--file-selection', '--directory', f'--title={title}']
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                selected_folder = res.stdout.strip()
        except Exception:
            pass

    if not selected_folder:
        script = (
            "import tkinter as tk\n"
            "from tkinter import filedialog\n"
            "root = tk.Tk()\n"
            "root.withdraw()\n"
            "root.attributes('-topmost', True)\n"
            "root.focus_force()\n"
            f"folder = filedialog.askdirectory(title={json.dumps(title)})\n"
            "root.destroy()\n"
            "if folder:\n"
            "    print(folder)\n"
        )
        try:
            flags = subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0
            res = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, creationflags=flags)
            if res.returncode == 0 and res.stdout.strip():
                selected_folder = res.stdout.strip()
        except Exception as e:
            print(f"Tkinter folder dialog error: {e}")

    if selected_folder:
        return jsonify({"folder": os.path.normpath(selected_folder)})
    return jsonify({"folder": None, "cancelled": True})


@system_bp.route('/api/save_generation_params', methods=['POST'])
@st.requires_auth
def save_generation_params():
    try:
        pass
        settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
        
        data = request.get_json() or {}
        temperature = data.get("temperature")
        if temperature is None:
            return jsonify({"error": "Missing temperature"}), 400
            
        try:
            temperature = float(temperature)
        except ValueError:
            return jsonify({"error": "Invalid temperature value"}), 400
            
        settings = {}
        if os.path.exists(settings_path):
            try:
                with open(settings_path, "r", encoding="utf-8") as f:
                    settings = json.load(f)
            except Exception:
                pass
                
        settings["temperature"] = temperature
        
        with open(settings_path, "w", encoding="utf-8") as f:
            json.dump(settings, f, indent=2, ensure_ascii=False)
            
        return jsonify({"status": "success", "settings": settings})
    except Exception as e:
        print(f"Error saving generation params: {e}")
        return jsonify({"error": str(e)}), 500


@system_bp.route('/api/models/native/list', methods=['GET'])
@st.requires_auth
def list_native_models():
    """Lists all user-placed GGUF models, Diffusion Checkpoints, LoRAs, and VAEs."""
    try:
        from runners import local_server
        from core import engine_diffusion
        from variables.settings import MODELS_DIR, LLM_MODELS_DIR, CHECKPOINTS_DIR, LORAS_DIR, VAE_DIR, WORKFLOWS_DIR

        ggufs = local_server.list_gguf_models()
        checkpoints = engine_diffusion.list_checkpoints()
        loras = engine_diffusion.list_loras()
        vaes = engine_diffusion.list_vaes()
        workflows = engine_diffusion.list_workflows()

        return jsonify({
            "models_dir": MODELS_DIR,
            "llm_models_dir": LLM_MODELS_DIR,
            "checkpoints_dir": CHECKPOINTS_DIR,
            "loras_dir": LORAS_DIR,
            "vae_dir": VAE_DIR,
            "workflows_dir": WORKFLOWS_DIR,
            "gguf_models": ggufs,
            "checkpoints": checkpoints,
            "loras": loras,
            "vaes": vaes,
            "workflows": workflows,
            "active_llm": local_server.get_loaded_model_name(),
            "llm_loaded": local_server.check_local_server_status() is True,
            "active_checkpoint": engine_diffusion.get_active_checkpoint(),
            "active_workflow": engine_diffusion.get_active_workflow()
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@system_bp.route('/api/models/native/load_llm', methods=['POST'])
@st.requires_auth
def load_native_llm():
    """Loads a GGUF model into the local LLM server."""
    try:
        from runners import local_server
        data = request.get_json() or {}
        model_name = data.get("model_name", "")
        if data.get("n_ctx"):
            os.environ["LOCAL_CONTEXT"] = str(int(data.get("n_ctx")))
        if data.get("n_gpu_layers") is not None:
            os.environ["LOCAL_GPU_LAYERS"] = str(int(data.get("n_gpu_layers")))
        success, message = local_server.start_local_server(model_name)
        return jsonify({"success": success, "message": message, "active_model": local_server.get_loaded_model_name()})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@system_bp.route('/api/models/native/select_checkpoint', methods=['POST'])
@st.requires_auth
def select_native_checkpoint():
    """Sets the active in-process diffusion checkpoint."""
    try:
        from core import engine_diffusion
        data = request.get_json() or {}
        ckpt_name = data.get("checkpoint_name", "")
        success = engine_diffusion.set_active_checkpoint(ckpt_name)
        active_ckpt = engine_diffusion.get_active_checkpoint()
        if active_ckpt:
            os.environ["COMFYUI_CHECKPOINT"] = active_ckpt
        return jsonify({"success": success, "active_checkpoint": active_ckpt})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@system_bp.route('/api/models/native/select_workflow', methods=['POST'])
@st.requires_auth
def select_native_workflow():
    """Sets the active image workflow."""
    try:
        from core import engine_diffusion
        data = request.get_json() or {}
        workflow_name = data.get("workflow_name", "")
        success = engine_diffusion.set_active_workflow(workflow_name)
        active_wf = engine_diffusion.get_active_workflow()
        if active_wf:
            os.environ["COMFYUI_IMAGE_WORKFLOW"] = active_wf
        return jsonify({"success": success, "active_workflow": active_wf})
    except Exception as e:
        return jsonify({"success": False, "message": str(e)}), 500


@system_bp.route('/api/models/native/open_folder', methods=['POST'])
@st.requires_auth
def open_models_folder():
    """Opens the requested models folder in the native OS file explorer."""
    try:
        import subprocess, sys
        from variables.settings import MODELS_DIR, LLM_MODELS_DIR, CHECKPOINTS_DIR, LORAS_DIR, VAE_DIR, WORKFLOWS_DIR

        data = request.get_json(silent=True) or {}
        folder_type = data.get("folder", "root")

        target_map = {
            "root": MODELS_DIR,
            "llm": LLM_MODELS_DIR,
            "checkpoints": CHECKPOINTS_DIR,
            "loras": LORAS_DIR,
            "vae": VAE_DIR,
            "workflows": WORKFLOWS_DIR
        }
        target_dir = target_map.get(folder_type, MODELS_DIR)
        os.makedirs(target_dir, exist_ok=True)

        if sys.platform == 'win32':
            os.startfile(target_dir)
        elif sys.platform == 'darwin':
            subprocess.Popen(['open', target_dir])
        else:
            subprocess.Popen(['xdg-open', target_dir])

        return jsonify({"success": True, "path": target_dir})
    except Exception as e:
        return jsonify({"success": False, "error": str(e)}), 500


