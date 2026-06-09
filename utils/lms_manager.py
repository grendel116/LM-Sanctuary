import os
import subprocess
import threading
import requests
import json

# Thread-safe storage for background downloads
download_status = {}  # model_name: { 'status': 'idle'|'downloading'|'completed'|'failed', 'error': None }

def get_lms_path():
    """Returns the absolute path to the lms executable if it exists, otherwise 'lms'."""
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        win_path = os.path.join(user_profile, ".lmstudio", "bin", "lms.exe")
        if os.path.exists(win_path):
            return win_path
    home = os.path.expanduser("~")
    unix_path = os.path.join(home, ".lmstudio", "bin", "lms")
    if os.path.exists(unix_path):
        return unix_path
    return "lms"

def resolve_model_key(model_name):
    """Resolves a model path or identifier to the correct modelKey recognized by lms CLI."""
    if not model_name:
        return model_name
    try:
        lms_path = get_lms_path()
        res = subprocess.run([lms_path, "ls", "--json"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False, timeout=5)
        if res.returncode == 0 and res.stdout.strip():
            models_data = json.loads(res.stdout)
            search_name = model_name.replace("\\", "/").lower()
            for m in models_data:
                m_key = m.get("modelKey")
                m_path = m.get("path")
                m_id = m.get("indexedModelIdentifier")
                
                if m_key and m_key.lower() == search_name:
                    return m_key
                if m_path and m_path.replace("\\", "/").lower() == search_name:
                    return m_key
                if m_id and m_id.replace("\\", "/").lower() == search_name:
                    return m_key
                if m_path and (search_name.endswith(m_path.replace("\\", "/").lower()) or m_path.replace("\\", "/").lower().endswith(search_name)):
                    return m_key
    except Exception as e:
        print(f"[resolve_model_key] Error resolving model key: {e}")
    return model_name

_lms_cli_installed_cached = None

def check_lms_cli():
    """Checks if the lms executable is in the system path and is fully functional."""
    global _lms_cli_installed_cached
    if _lms_cli_installed_cached is True:
        return True
        
    try:
        lms_path = get_lms_path()
        res = subprocess.run([lms_path, "--version"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False)
        if res.returncode != 0:
            return False
        
        # Check if the command complains about missing installation or daemon
        res2 = subprocess.run([lms_path, "ls"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False, timeout=5)
        combined = (res2.stdout + res2.stderr).lower()
        if "no valid installation" in combined:
            return False
            
        _lms_cli_installed_cached = True
        return True
    except Exception:
        return False

def check_daemon_status():
    """Checks if the LM Studio daemon is running and responsive."""
    try:
        # Check standard endpoint or see if API server port 1234 is up
        response = requests.get("http://127.0.0.1:1234/v1/models", timeout=0.5)
        if response.status_code == 200:
            return True
    except Exception:
        pass
    return False

def install_lms_cli():
    """Triggers the Windows headless installation script via PowerShell."""
    global _lms_cli_installed_cached
    try:
        # Reset cached status so it re-checks
        _lms_cli_installed_cached = None
        # Run the official PS1 installer command
        cmd = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://lmstudio.ai/install.ps1 | iex"'
        process = subprocess.Popen(cmd, shell=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = process.communicate()
        if process.returncode == 0:
            return True, "Installation triggered successfully."
        else:
            return False, stderr.decode('utf-8', errors='ignore')
    except Exception as e:
        return False, str(e)

def start_lms_daemon():
    """Starts the lms server daemon in the background."""
    try:
        lms_path = get_lms_path()
        subprocess.Popen([lms_path, "server", "start"], shell=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True, "LM Studio daemon start initiated."
    except Exception as e:
        return False, f"Failed to start LM Studio daemon: {e}"

def stop_lms_daemon():
    """Stops the LM Studio daemon using lms CLI server stop."""
    try:
        lms_path = get_lms_path()
        process = subprocess.run([lms_path, "server", "stop"], shell=False, capture_output=True, text=True, encoding='utf-8', errors='ignore')
        if process.returncode == 0:
            return True, "LM Studio daemon stopped successfully."
        return False, f"Failed to stop LM Studio daemon: {process.stderr}"
    except Exception as e:
        return False, f"Failed to stop LM Studio daemon: {e}"

def list_local_models():
    """Returns a list of downloaded models available in LM Studio by scanning files directly (fast)."""
    models = []
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        models_dir = os.path.join(user_profile, ".lmstudio", "models")
        if os.path.exists(models_dir):
            for root, dirs, files in os.walk(models_dir):
                for file in files:
                    if file.lower().endswith(".gguf"):
                        # Deduce model key from relative path (e.g. publisher/model/file.gguf)
                        rel_path = os.path.relpath(os.path.join(root, file), models_dir)
                        # Normalize path separators
                        model_key = rel_path.replace("\\", "/")
                        models.append(model_key)
    return sorted(list(set(models)))

def search_huggingface(query):
    """Searches Hugging Face for GGUF models directly via the HF API."""
    results = []
    try:
        # Search API for GGUF models
        url = f"https://huggingface.co/api/models?search={query}&filter=gguf&sort=likes&direction=-1&limit=20"
        response = requests.get(url, timeout=3.0)
        if response.status_code == 200:
            data = response.json()
            for item in data:
                model_id = item.get("id")
                likes = item.get("likes", 0)
                downloads = item.get("downloads", 0)
                results.append({
                    "id": model_id,
                    "likes": likes,
                    "downloads": downloads,
                    "author": model_id.split("/")[0] if "/" in model_id else "Unknown"
                })
    except Exception as e:
        print(f"Error searching Hugging Face: {e}")
    return results

def _download_worker(model_name):
    download_status[model_name] = {"status": "downloading", "error": None}
    try:
        # Start daemon if not running
        if not check_daemon_status():
            start_lms_daemon()
            
        lms_path = get_lms_path()
        # Run get command non-interactively
        cmd = [lms_path, "get", model_name, "-y"]
        process = subprocess.Popen(cmd, shell=False, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        stdout, stderr = process.communicate()
        
        if process.returncode == 0:
            download_status[model_name]["status"] = "completed"
        else:
            err_msg = stderr.decode('utf-8', errors='ignore') or stdout.decode('utf-8', errors='ignore')
            download_status[model_name]["status"] = "failed"
            download_status[model_name]["error"] = err_msg
    except Exception as e:
        download_status[model_name]["status"] = "failed"
        download_status[model_name]["error"] = str(e)

def trigger_download(model_name):
    """Starts the background downloader thread for a model."""
    if model_name in download_status and download_status[model_name]["status"] == "downloading":
        return False, "Already downloading."
        
    thread = threading.Thread(target=_download_worker, args=(model_name,))
    thread.daemon = True
    thread.start()
    return True, "Download started."

def load_local_model(model_name):
    """Loads a model into memory via CLI."""
    try:
        # Start daemon if not running
        if not check_daemon_status():
            start_lms_daemon()
            
        lms_path = get_lms_path()
        resolved_key = resolve_model_key(model_name)
        # Run lms load <model>
        res = subprocess.run([lms_path, "load", resolved_key, "-y"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False, timeout=15)
        return res.returncode == 0, res.stdout or res.stderr
    except Exception as e:
        return False, str(e)

def unload_local_model(model_name=None):
    """Unloads a loaded model from memory via CLI."""
    try:
        lms_path = get_lms_path()
        if not model_name or model_name == "all":
            res = subprocess.run([lms_path, "unload", "--all"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False, timeout=10)
        else:
            resolved_key = resolve_model_key(model_name)
            res = subprocess.run([lms_path, "unload", resolved_key], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False, timeout=10)
        return res.returncode == 0, res.stdout or res.stderr
    except Exception as e:
        return False, str(e)

def delete_local_model(model_name):
    """Deletes the GGUF model file and its parent folders from disk if they are empty."""
    user_profile = os.environ.get("USERPROFILE")
    if not user_profile:
        return False, "User profile not found."
    
    models_dir = os.path.normpath(os.path.join(user_profile, ".lmstudio", "models"))
    # Normalize model path to match OS style
    target_path = os.path.normpath(os.path.join(models_dir, model_name))
    
    # Verify that the path is actually inside the models directory (prevent directory traversal)
    if not target_path.startswith(models_dir):
        return False, "Invalid model path."
        
    if not os.path.exists(target_path):
        return False, "Model file does not exist on disk."
        
    try:
        # Delete file
        os.remove(target_path)
        
        # Clean up empty parent directories
        parent = os.path.dirname(target_path)
        while parent != models_dir:
            if not os.listdir(parent):
                os.rmdir(parent)
                parent = os.path.dirname(parent)
            else:
                break
        return True, "Model deleted successfully from disk."
    except Exception as e:
        return False, str(e)
