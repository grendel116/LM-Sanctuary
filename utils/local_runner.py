import os
import time
import zipfile
import subprocess
import requests
import atexit
import threading

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LLAMA_BIN_DIR = os.path.join(BASE_DIR, "utils", "llama-bin")
SERVER_EXE = os.path.join(LLAMA_BIN_DIR, "llama-server.exe") if os.name == 'nt' else os.path.join(LLAMA_BIN_DIR, "llama-server")
_proc = None
_starting = False
_start_lock = threading.Lock()
_on_status_change = None  # Callback set by app.py to broadcast SSE events

def detect_gpu_type() -> str:
    """Detects if the system has an AMD, Nvidia, or Vulkan compatible GPU on Windows.
    Returns 'amd', 'nvidia', or 'vulkan'.
    """
    if os.name != 'nt':
        return 'vulkan'
        
    try:
        # Run PowerShell to get video controller names
        output = subprocess.check_output(
            'powershell -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
            shell=True,
            text=True,
            stderr=subprocess.DEVNULL
        )
        output_lower = output.lower()
        if "nvidia" in output_lower:
            return "nvidia"
        elif "amd" in output_lower or "radeon" in output_lower:
            return "amd"
    except Exception:
        pass
    return "vulkan"

def download_llama_server():
    os.makedirs(LLAMA_BIN_DIR, exist_ok=True)
    api_url = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
    try:
        resp = requests.get(api_url, headers={"User-Agent": "LM-Sanctuary-Client/1.0"}, timeout=10.0).json()
        assets = resp.get("assets", [])
        
        gpu_type = detect_gpu_type()
        print(f"[llama-runner] Detected GPU type: {gpu_type}", flush=True)
        
        target_keyword = "win-vulkan-x64"
        if gpu_type == "amd":
            target_keyword = "win-hip-radeon-x64"
        elif gpu_type == "nvidia":
            target_keyword = "win-cuda-12.4-x64"
            
        # Try to find the target asset
        asset = None
        for a in assets:
            name = a.get("name", "").lower()
            if target_keyword in name and name.endswith(".zip"):
                asset = a
                break
                
        # If target asset not found, fallback to Vulkan
        if not asset:
            print(f"[llama-runner] Target asset '{target_keyword}' not found, falling back to Vulkan", flush=True)
            asset = next(a for a in assets if "win-vulkan-x64" in a.get("name", "").lower() and a.get("name", "").endswith(".zip"))
            
        print(f"[llama-runner] Downloading {asset['name']}...", flush=True)
        temp_zip = os.path.join(LLAMA_BIN_DIR, asset["name"])
        with requests.get(asset["browser_download_url"], stream=True) as r:
            with open(temp_zip, 'wb') as f:
                for chunk in r.iter_content(8192):
                    f.write(chunk)
                    
        # Clean existing bin directory before extracting to prevent DLL conflicts
        for f_name in os.listdir(LLAMA_BIN_DIR):
            f_path = os.path.join(LLAMA_BIN_DIR, f_name)
            if os.path.isfile(f_path) and f_name != asset["name"]:
                try:
                    os.remove(f_path)
                except Exception:
                    pass
                    
        with zipfile.ZipFile(temp_zip, 'r') as zip_ref:
            zip_ref.extractall(LLAMA_BIN_DIR)
        os.remove(temp_zip)
        print(f"[llama-runner] Successfully installed llama-server ({asset['name']})", flush=True)
        return True
    except Exception as e:
        print(f"[llama-runner] Error installing: {e}", flush=True)
        return False

def resolve_model_path(model_key):
    if not model_key or not model_key.strip(): return None
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    paths = [
        os.path.join(BASE_DIR, "models", model_key),
        os.path.join(user_profile, ".lmstudio", "models", model_key),
        model_key
    ]
    return next((os.path.normpath(p) for p in paths if os.path.isfile(p)), None)

_current_model = None

def start_local_server(model_key):
    global _proc, _current_model, _starting
    
    with _start_lock:
        if _starting:
            return True, "Already starting"
            
    is_online = check_local_server_status()
    model_path = resolve_model_path(model_key)
    if not model_path:
        return False, f"Model not found: {model_key}"
        
    # Check if server is running and has this model loaded
    if is_online is True:
        from utils.models import fetch_local_models
        loaded = fetch_local_models()
        if loaded:
            target_base = os.path.basename(model_path).lower()
            for m in loaded:
                val = m.get("value", "")
                if val:
                    val_base = os.path.basename(val).lower()
                    if val_base == target_base or val.lower() == model_key.lower():
                        _current_model = model_key
                        return True, "Online (already running)"
                        
    # If online but with another model, or booting up, stop first to be clean
    if is_online:
        stop_local_server()
        
    if not os.getenv("LOCAL_MODEL_NAME") and model_key:
        os.environ["LOCAL_MODEL_NAME"] = model_key
        
    gpu_type = detect_gpu_type()
    gpu_type_file = os.path.join(LLAMA_BIN_DIR, "installed_gpu_type.txt")
    
    reinstall = False
    if not os.path.exists(SERVER_EXE):
        reinstall = True
    else:
        installed_type = "unknown"
        if os.path.exists(gpu_type_file):
            try:
                with open(gpu_type_file, "r") as f:
                    installed_type = f.read().strip()
            except Exception:
                pass
        if installed_type != gpu_type:
            print(f"[llama-runner] Reinstalling llama-server: installed type '{installed_type}' differs from detected GPU type '{gpu_type}'", flush=True)
            reinstall = True
            stop_local_server()
            
    if reinstall:
        if not download_llama_server():
            return False, "Failed download"
        try:
            with open(gpu_type_file, "w") as f:
                f.write(gpu_type)
        except Exception:
            pass
            
    context_size = os.getenv("LOCAL_CONTEXT", "8192")
    gpu_layers = os.getenv("LOCAL_GPU_LAYERS", "99")
    flash_attn = os.getenv("LOCAL_FLASH_ATTN", "true").lower() == "true"
    
    cmd = [
        SERVER_EXE,
        "-m", model_path,
        "-c", context_size,
        "--port", "1234",
        "--host", "127.0.0.1",
        "-ngl", gpu_layers,
        "-np", "1",
        "--no-warmup",
        "--fit", "off"
    ]
    if flash_attn:
        cmd.extend(["-fa", "on"])
        
    try:
        log_file = os.path.join(BASE_DIR, "llama_server.log")
        with open(log_file, "a", encoding="utf-8") as log_fd:
            log_fd.write(f"\n--- START {time.asctime()} ---\n")
            if os.name == 'nt':
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0
                _proc = subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, startupinfo=si, shell=False)
            else:
                _proc = subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, shell=False)
                
        with _start_lock:
            _starting = True
            
        if _on_status_change:
            _on_status_change()
            
        def _wait_for_server():
            global _current_model, _starting
            try:
                for _ in range(300):
                    time.sleep(1.0)
                    status = check_local_server_status()
                    if status is True:
                        _current_model = model_key
                        break
                    if status is False:
                        break
                    if _proc and _proc.poll() is not None:
                        break
            finally:
                with _start_lock:
                    _starting = False
                if _on_status_change:
                    _on_status_change()
                    
        threading.Thread(target=_wait_for_server, daemon=True).start()
        return True, "Starting"
    except Exception as e:
        with _start_lock:
            _starting = False
        return False, str(e)

def _kill_all_llama_processes():
    if os.name == 'nt':
        try:
            subprocess.run(["taskkill", "/F", "/IM", "llama-server.exe"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass
    else:
        try:
            subprocess.run(["pkill", "-9", "-f", "llama-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

def stop_local_server():
    global _proc, _current_model, _starting
    _current_model = None
    
    with _start_lock:
        _starting = False
        
    if _proc:
        try:
            _proc.terminate()
            _proc.wait(timeout=1.0)
        except Exception:
            try:
                _proc.kill()
            except Exception:
                pass
        _proc = None
        
    _kill_all_llama_processes()
    time.sleep(0.5)
    return True, "Stopped"

def check_local_server_status():
    try:
        resp = requests.get("http://127.0.0.1:1234/health", timeout=1.0)
        if resp.status_code == 200:
            return True
        if resp.status_code == 503:
            return "starting"
    except Exception:
        pass
        
    if _proc and _proc.poll() is None:
        return "starting"
        
    return False

def _atexit_clean():
    # If Flask reloader is active, let the parent process handle cleanup on Ctrl+C
    # so we don't kill the server on child process reloads.
    if os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        return
    stop_local_server()

atexit.register(_atexit_clean)
