import os
import time
import zipfile
import subprocess
import requests
import atexit

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LLAMA_BIN_DIR = os.path.join(BASE_DIR, "utils", "llama-bin")
SERVER_EXE = os.path.join(LLAMA_BIN_DIR, "llama-server.exe") if os.name == 'nt' else os.path.join(LLAMA_BIN_DIR, "llama-server")
_proc = None

def download_llama_server():
    os.makedirs(LLAMA_BIN_DIR, exist_ok=True)
    api_url = "https://api.github.com/repos/ggml-org/llama.cpp/releases/latest"
    try:
        resp = requests.get(api_url, headers={"User-Agent": "LM-Sanctuary-Client/1.0"}, timeout=10.0).json()
        asset = next(a for a in resp.get("assets", []) if "win-vulkan-x64" in a.get("name", "").lower() and a.get("name", "").endswith(".zip"))
        
        temp_zip = os.path.join(LLAMA_BIN_DIR, asset["name"])
        with requests.get(asset["browser_download_url"], stream=True) as r:
            with open(temp_zip, 'wb') as f:
                for chunk in r.iter_content(8192): f.write(chunk)
                
        with zipfile.ZipFile(temp_zip, 'r') as zip_ref:
            zip_ref.extractall(LLAMA_BIN_DIR)
        os.remove(temp_zip)
        return True
    except Exception as e:
        print(f"[llama-runner] Error installing: {e}")
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
    global _proc, _current_model
    is_online = check_local_server_status()
    if is_online and _current_model == model_key:
        return True, "Already running"
    if is_online:
        stop_local_server()
        
    if not os.getenv("LOCAL_MODEL_NAME") and model_key:
        os.environ["LOCAL_MODEL_NAME"] = model_key
        
    if not os.path.exists(SERVER_EXE):
        if not download_llama_server(): return False, "Failed download"
        
    model_path = resolve_model_path(model_key)
    if not model_path: return False, f"Model not found: {model_key}"
    
    cmd = [SERVER_EXE, "-m", model_path, "-c", "4096", "--port", "1234", "--host", "127.0.0.1", "-ngl", "32", "--no-warmup"]
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
        
        for _ in range(60):
            time.sleep(1.0)
            if check_local_server_status():
                _current_model = model_key
                return True, "Online"
            if _proc and _proc.poll() is not None: break
        return False, "Failed to start"
    except Exception as e:
        return False, str(e)

def stop_local_server():
    global _proc, _current_model
    _current_model = None
    
    pids_to_terminate = set()
    if _proc:
        pids_to_terminate.add(_proc.pid)
        _proc = None
        
    import psutil
    for proc in psutil.process_iter(['name', 'pid']):
        try:
            if "llama-server" in proc.info['name'].lower():
                pids_to_terminate.add(proc.info['pid'])
        except Exception: pass
        
    if pids_to_terminate:
        processes = []
        for pid in pids_to_terminate:
            try:
                processes.append(psutil.Process(pid))
            except Exception: pass
            
        for p in processes:
            try: p.terminate()
            except Exception: pass
            
        gone, alive = psutil.wait_procs(processes, timeout=3.0)
        for p in alive:
            try: p.kill()
            except Exception: pass
            
        time.sleep(1.5)
        
    return True, "Stopped"

def check_local_server_status():
    try:
        return requests.get("http://127.0.0.1:1234/health", timeout=0.2).status_code == 200
    except Exception:
        return False

atexit.register(stop_local_server)
