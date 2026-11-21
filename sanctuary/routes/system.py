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
        "gemini_api_key": os.getenv("GEMINI_API_KEY", "").strip(),
        "search_engine": "web_crawling",
        "searxng_url": "",
        "tts_voice": "af_heart"
    }
    
    if request.method == 'GET':
        if not os.path.exists(settings_path):
            try:
                with open(settings_path, "w", encoding="utf-8") as f:
                    json.dump(default_settings, f, indent=2)
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
                
                # Check if the first folder needs to be updated to the new program
                if "folders" in settings and len(settings["folders"]) > 0:
                    first_folder = os.path.normpath(settings["folders"][0])
                    cwd = os.path.normpath(os.getcwd())
                    is_old_program_dir = ("core" in first_folder and "programs" in first_folder) or first_folder == cwd
                    if is_old_program_dir and first_folder != default_folder:
                        settings["folders"][0] = default_folder
                        dirty = True
                
                if settings.get("search_engine") not in ("web_crawling", "wikipedia"):
                    settings["search_engine"] = "web_crawling"
                    dirty = True

                saved_key = str(settings.get("gemini_api_key") or "").strip()
                env_key = os.getenv("GEMINI_API_KEY", "").strip()
                if saved_key:
                    os.environ["GEMINI_API_KEY"] = saved_key
                elif env_key:
                    settings["gemini_api_key"] = env_key
                    dirty = True

                if dirty:
                    with open(settings_path, "w", encoding="utf-8") as f:
                        json.dump(settings, f, indent=2)
                return jsonify(settings)
            except Exception as e:
                print(f"Error reading project settings: {e}")
                return jsonify(default_settings)
                
    elif request.method == 'POST':
        try:
            data = request.get_json() or {}
            folders = data.get("folders", [])
            security_preset = data.get("security_preset", "ask_always")
            artifact_review_policy = data.get("artifact_review_policy", "ask_always")
            search_engine = data.get("search_engine", "web_crawling")
            searxng_url = data.get("searxng_url", "")
            tts_voice = data.get("tts_voice", "af_heart")
            
            cleaned_folders = []
            seen = set()
            
            # Ensure default_folder is always the first folder
            cleaned_folders.append(default_folder)
            seen.add(default_folder.lower() if os.name == 'nt' else default_folder)
            
            for folder in folders:
                if not folder:
                    continue
                norm = os.path.normpath(folder)
                key = norm.lower() if os.name == 'nt' else norm
                if key not in seen:
                    cleaned_folders.append(norm)
                    seen.add(key)
            
            # Load existing settings to preserve other keys (active_program, active_user)
            settings = {}
            if os.path.exists(settings_path):
                try:
                    with open(settings_path, "r", encoding="utf-8") as f:
                        settings = json.load(f)
                except Exception:
                    pass

            if "gemini_api_key" in data:
                gemini_api_key = str(data.get("gemini_api_key") or "").strip()
            else:
                gemini_api_key = str(settings.get("gemini_api_key") or "").strip()
            
            settings.update({
                "folders": cleaned_folders,
                "security_preset": security_preset,
                "artifact_review_policy": artifact_review_policy,
                "gemini_api_key": gemini_api_key,
                "search_engine": search_engine,
                "searxng_url": searxng_url,
                "tts_voice": tts_voice
            })
            
            # Keep environment variables and cached settings in sync
            os.environ["TTS_VOICE"] = tts_voice
            if gemini_api_key:
                os.environ["GEMINI_API_KEY"] = gemini_api_key
            elif "gemini_api_key" in data:
                os.environ.pop("GEMINI_API_KEY", None)
            
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)
            try:
                import runners.program as rp

                rp._settings_cache = None
                rp._settings_mtime = 0.0
            except Exception:
                pass
            return jsonify({"status": "success", "settings": settings})
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

