import os
import time
import zipfile
import subprocess
import requests
import threading

from utils import lifecycle

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LLAMA_BIN_DIR = os.path.join(BASE_DIR, "utils", "llama-bin")
SERVER_EXE = os.path.join(LLAMA_BIN_DIR, "llama-server.exe") if os.name == 'nt' else os.path.join(LLAMA_BIN_DIR, "llama-server")
_proc = None
_starting = False
_start_lock = threading.Lock()
_on_status_change = None  # Callback set by app.py to broadcast SSE events
_cached_gpu_type = None
_http_session = None

def _get_http_session() -> requests.Session:
    global _http_session
    if _http_session is None:
        _http_session = requests.Session()
    return _http_session

def _has_windows_rocm_sdk() -> bool:
    """Checks whether the full AMD ROCm/HIP BLAS runtime (hipblas.dll) is loadable on Windows.
    Standard AMD Adrenalin display drivers install amdhip64_*.dll into System32,
    but llama.cpp's win-rocm backend (ggml-hip.dll) also requires hipblas.dll and rocblas.dll
    from the external AMD ROCm SDK. Without hipblas.dll, ggml-hip.dll fails LoadLibrary and
    llama-server runs on CPU with 0 GPU devices.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        ctypes.WinDLL("hipblas.dll")
        return True
    except Exception:
        return False


def has_gpu_devices() -> bool:
    """Verifies that the installed llama-server binary enumerates at least one hardware GPU device."""
    if not os.path.exists(SERVER_EXE):
        return False
    try:
        flags = subprocess.CREATE_NO_WINDOW if (os.name == "nt" and hasattr(subprocess, "CREATE_NO_WINDOW")) else 0
        out = subprocess.check_output(
            [SERVER_EXE, "--list-devices"],
            text=True,
            stderr=subprocess.STDOUT,
            timeout=5.0,
            creationflags=flags,
        )
        return "(none)" not in out.lower() and ":" in out
    except Exception:
        return False


def detect_gpu_type() -> str:
    """Detects the optimal GPU backend ('amd', 'nvidia', 'vulkan', or 'metal') for llama-server."""
    global _cached_gpu_type
    forced_gpu = (os.getenv("LOCAL_GPU_TYPE") or "").strip().lower()
    if forced_gpu in ("amd", "nvidia", "vulkan", "metal"):
        if os.name == "nt" and forced_gpu == "amd" and not _has_windows_rocm_sdk():
            print("[llama-runner] AMD ROCm BLAS runtime (hipblas.dll) not found; using Vulkan backend for AMD GPU acceleration.", flush=True)
            return "vulkan"
        return forced_gpu

    if _cached_gpu_type:
        return _cached_gpu_type

    import sys
    if sys.platform == "darwin":
        _cached_gpu_type = "metal"
        return _cached_gpu_type

    if os.name != "nt":
        try:
            subprocess.check_output(["nvidia-smi"], stderr=subprocess.DEVNULL)
            _cached_gpu_type = "nvidia"
            return _cached_gpu_type
        except Exception:
            _cached_gpu_type = "vulkan"
            return _cached_gpu_type

    try:
        output = subprocess.check_output(
            'powershell -NoProfile -Command "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"',
            shell=True,
            text=True,
            stderr=subprocess.DEVNULL,
            timeout=5.0,
        )
        output_lower = output.lower()
        if "nvidia" in output_lower:
            _cached_gpu_type = "nvidia"
        elif "amd" in output_lower or "radeon" in output_lower:
            if _has_windows_rocm_sdk():
                _cached_gpu_type = "amd"
            else:
                _cached_gpu_type = "vulkan"
        else:
            _cached_gpu_type = "vulkan"
        return _cached_gpu_type
    except Exception:
        pass

    _cached_gpu_type = "vulkan"
    return _cached_gpu_type


def _download_and_extract_archive(asset: dict) -> None:
    import tarfile
    temp_archive = os.path.join(LLAMA_BIN_DIR, asset["name"])
    with requests.get(asset["browser_download_url"], stream=True, timeout=60.0) as r:
        r.raise_for_status()
        with open(temp_archive, "wb") as f:
            for chunk in r.iter_content(65536):
                if chunk:
                    f.write(chunk)
    if temp_archive.endswith(".zip"):
        with zipfile.ZipFile(temp_archive, "r") as zip_ref:
            zip_ref.extractall(LLAMA_BIN_DIR)
    elif temp_archive.endswith(".tar.gz"):
        with tarfile.open(temp_archive, "r:gz") as tar_ref:
            tar_ref.extractall(LLAMA_BIN_DIR)
    os.remove(temp_archive)


def download_llama_server(override_gpu_type: str | None = None):
    import sys
    import platform
    os.makedirs(LLAMA_BIN_DIR, exist_ok=True)
    api_url = "https://api.github.com/repos/ggml-org/llama.cpp/releases"
    try:
        resp = requests.get(api_url, headers={"User-Agent": "LM-Sanctuary-Client/1.0"}, timeout=10.0).json()
        release = next(r for r in resp if len(r.get("assets", [])) > 5)
        assets = release.get("assets", [])

        gpu_type = override_gpu_type or detect_gpu_type()
        print(f"[llama-runner] Detected GPU type: {gpu_type}", flush=True)

        if os.name == "nt":
            if gpu_type == "amd":
                target_keywords = ["win-rocm", "win-hip", "win-vulkan-x64"]
            elif gpu_type == "nvidia":
                target_keywords = ["win-cuda-12.4-x64", "win-cuda", "win-vulkan-x64"]
            else:
                target_keywords = ["win-vulkan-x64"]
        elif sys.platform == "darwin":
            arch = "arm64" if platform.machine().lower() in ("arm64", "aarch64") else "x64"
            target_keywords = [f"macos-{arch}"]
        else:
            target_keywords = ["ubuntu-vulkan-x64", "ubuntu-x64"]

        asset = None
        matched_kw = None
        for kw in target_keywords:
            for a in assets:
                name = a.get("name", "").lower()
                if name.startswith("llama-") and kw in name and (name.endswith(".zip") or name.endswith(".tar.gz")):
                    asset = a
                    matched_kw = kw
                    break
            if asset:
                break

        if not asset and os.name == "nt":
            print("[llama-runner] Target asset not found, using Vulkan build", flush=True)
            asset = next(
                (a for a in assets if a.get("name", "").lower().startswith("llama-") and "win-vulkan-x64" in a.get("name", "").lower() and a.get("name", "").endswith(".zip")),
                None,
            )

        if not asset:
            raise RuntimeError(f"No compatible llama-server release binary found for platform {sys.platform} ({gpu_type})")

        # Clean existing bin directory before extracting to prevent DLL conflicts
        for f_name in os.listdir(LLAMA_BIN_DIR):
            f_path = os.path.join(LLAMA_BIN_DIR, f_name)
            if os.path.isfile(f_path):
                try:
                    os.remove(f_path)
                except Exception:
                    pass

        print(f"[llama-runner] Downloading {asset['name']}...", flush=True)
        _download_and_extract_archive(asset)

        # On Windows NVIDIA CUDA builds, also extract the companion cudart archive so cublas/cudart DLLs are present
        if os.name == "nt" and gpu_type == "nvidia" and matched_kw and "win-cuda" in matched_kw:
            cudart_asset = next(
                (a for a in assets if a.get("name", "").lower().startswith("cudart-") and matched_kw in a.get("name", "").lower() and a.get("name", "").endswith(".zip")),
                None,
            )
            if cudart_asset:
                print(f"[llama-runner] Downloading CUDA runtime companion {cudart_asset['name']}...", flush=True)
                _download_and_extract_archive(cudart_asset)

        # If archive extracted into a nested subfolder (e.g. build/bin/llama-server), hoist binaries to LLAMA_BIN_DIR
        if not os.path.exists(SERVER_EXE):
            target_name = os.path.basename(SERVER_EXE)
            for root, _, files in os.walk(LLAMA_BIN_DIR):
                if target_name in files and os.path.abspath(root) != os.path.abspath(LLAMA_BIN_DIR):
                    import shutil
                    for item in os.listdir(root):
                        src = os.path.join(root, item)
                        dst = os.path.join(LLAMA_BIN_DIR, item)
                        if os.path.isfile(src):
                            shutil.move(src, dst)
                    break

        if os.name != "nt" and os.path.exists(SERVER_EXE):
            try:
                os.chmod(SERVER_EXE, 0o755)
            except Exception:
                pass

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
    resolved = next((os.path.normpath(p) for p in paths if os.path.isfile(p)), None)
    if resolved:
        return resolved

    clean_key = os.path.basename(model_key).lower()
    from adapters.local_llm_manager import list_local_models
    downloaded = list_local_models()
    for d in downloaded:
        if os.path.basename(d).lower() == clean_key or clean_key in d.lower():
            for p in [os.path.join(BASE_DIR, "models", d), os.path.join(user_profile, ".lmstudio", "models", d), d]:
                if os.path.isfile(p):
                    return os.path.normpath(p)
    return None

_current_model = None

def start_local_server(model_key=None):
    global _proc, _current_model, _starting
    
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    with _start_lock:
        if _starting:
            return True, "Already starting"
            
    is_online = check_local_server_status()
    model_path = resolve_model_path(model_key)
    if not model_path:
        from adapters.local_llm_manager import list_local_models
        downloaded = list_local_models()
        if downloaded:
            model_key = downloaded[0]
            model_path = resolve_model_path(model_key)
        if not model_path:
            return False, f"Model not found: {model_key}"
        
    gpu_type = detect_gpu_type()
    gpu_type_file = os.path.join(LLAMA_BIN_DIR, "installed_gpu_type.txt")
    installed_type = "unknown"
    if os.path.exists(gpu_type_file):
        try:
            with open(gpu_type_file, "r") as f:
                installed_type = f.read().strip()
        except Exception:
            pass

    # Check if server is running with the expected GPU backend and has this model loaded
    if is_online is True and installed_type == gpu_type:
        from models.models import fetch_local_models
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
                        
    # If online with another model, mismatched GPU backend, or booting up, stop first to be clean
    if is_online:
        stop_local_server()
        
    if not os.getenv("LOCAL_MODEL_NAME") and model_key:
        os.environ["LOCAL_MODEL_NAME"] = model_key
        
    reinstall = False
    if not os.path.exists(SERVER_EXE):
        reinstall = True
    elif installed_type != gpu_type:
        print(f"[llama-runner] Reinstalling llama-server: installed type '{installed_type}' differs from detected GPU type '{gpu_type}'", flush=True)
        reinstall = True
        stop_local_server()
    elif not has_gpu_devices():
        print(f"[llama-runner] Installed llama-server ({installed_type}) detected 0 GPU devices; reinstalling...", flush=True)
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
    no_mmap = os.getenv("LOCAL_NO_MMAP", "false").lower() == "true"
    batch_size = os.getenv("LOCAL_BATCH_SIZE", "2048")
    ubatch_size = os.getenv("LOCAL_UBATCH_SIZE", "2048")
    ctk = os.getenv("LOCAL_CACHE_TYPE_K", "q8_0")
    ctv = os.getenv("LOCAL_CACHE_TYPE_V", "q8_0")
    
    cmd = [
        SERVER_EXE,
        "-m", model_path,
        "-c", context_size,
        "-b", batch_size,
        "-ub", ubatch_size,
        "--port", "1234",
        "--host", "127.0.0.1",
        "-ngl", gpu_layers,
        "-np", "1",
        "--cache-reuse", "64",
        "-fa", "on",
        "-ctk", ctk,
        "-ctv", ctv,
        "--no-warmup"
    ]

    if no_mmap:
        cmd.append("--no-mmap")

    from variables.settings import is_thinking_enabled
    if not is_thinking_enabled():
        cmd.extend(["--reasoning", "off", "--reasoning-budget", "0"])

    if flash_attn and "-fa" not in cmd:
        cmd.extend(["-fa", "on"])
    # --- AUTOMATIC LOGIT BIAS INJECTION ---
    try:
        from core.banned_words import generate_llama_cli_args
        # Generates token-level bias flags dynamically from the active model's GGUF file
        bias_args = generate_llama_cli_args(model_path)
        if bias_args:
            cmd.extend(bias_args)
            print("[llama-runner] Applied logit bias suppression rules from banned_words.json", flush=True)
    except Exception as e:
        print(f"[llama-runner] Warning: Could not apply logit bias: {e}", flush=True)
    # --------------------------------------

    try:
        from variables.settings import LOGS_DIR
        log_file = os.path.join(LOGS_DIR, "llama_server.log")
        with open(log_file, "a", encoding="utf-8") as log_fd:
            log_fd.write(f"\n--- START {time.asctime()} ---\n")
            if os.name == 'nt':
                si = subprocess.STARTUPINFO()
                si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                si.wShowWindow = 0
                flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000
                _proc = lifecycle.track(subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, startupinfo=si, creationflags=flags, shell=False))
            else:
                _proc = lifecycle.track(subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, shell=False))
                
        with _start_lock:
            _starting = True
            
        if _on_status_change:
            _on_status_change()
            
        def _wait_for_server():
            global _current_model, _starting
            try:
                for _ in range(300):
                    time.sleep(1.0)
                    if _proc and _proc.poll() is not None:
                        break
                    status = check_local_server_status()
                    if status is True:
                        _current_model = model_key
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
            flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000
            subprocess.run(
                ["taskkill", "/F", "/IM", "llama-server.exe"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                creationflags=flags
            )
        except Exception:
            pass
    else:
        try:
            subprocess.run(["pkill", "-9", "-f", "llama-server"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except Exception:
            pass

def stop_local_server():
    global _proc, _current_model, _starting, _http_session
    _current_model = None
    
    with _start_lock:
        _starting = False
        
    if _http_session:
        try:
            _http_session.close()
        except Exception:
            pass
        _http_session = None

    if _proc:
        try:
            _proc.terminate()
            _proc.wait(timeout=1.5)
        except Exception:
            try:
                _proc.kill()
            except Exception:
                pass
        _proc = None
        
    _kill_all_llama_processes()
    time.sleep(1.0)
    return True, "Stopped"

def check_local_server_status():
    try:
        session = _get_http_session()
        resp = session.get("http://127.0.0.1:1234/health", timeout=1.0)
        if resp.status_code == 200:
            return True
        if resp.status_code == 503:
            return "starting"
    except Exception:
        pass
        
    global _starting
    if _starting:
        return "starting"
        
    return False

def is_model_loaded(model_key=None) -> bool:
    """Checks if the local server is running AND serving the requested model."""
    status = check_local_server_status()
    if status is not True:
        return False
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    target_path = resolve_model_path(model_key) if model_key else None
    if not target_path:
        from adapters.local_llm_manager import list_local_models
        downloaded = list_local_models()
        if downloaded:
            target_path = resolve_model_path(downloaded[0])

    if not target_path:
        return True

    target_base = os.path.basename(target_path).lower()

    global _current_model
    if _current_model:
        curr_path = resolve_model_path(_current_model)
        curr_base = os.path.basename(curr_path or _current_model).lower()
        if curr_base == target_base:
            return True

    from models.models import fetch_local_models
    loaded = fetch_local_models(force_refresh=True)
    if loaded:
        for m in loaded:
            val = m.get("value", "")
            if val:
                val_path = resolve_model_path(val)
                val_base = os.path.basename(val_path or val).lower()
                if val_base == target_base or (target_path and val_path and os.path.samefile(val_path, target_path)):
                    _current_model = val
                    return True
        return False
    return False

def ensure_server_online(model_key=None, timeout=120.0) -> bool:
    """Ensures local LLM server is up, responsive, and serving the requested model."""
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    if is_model_loaded(model_key):
        return True

    print(f"[Local LLM] Server offline or switching model. Starting server (model: {model_key or 'default'})...", flush=True)
    from adapters import local_llm_manager
    success, msg = local_llm_manager.start_server(model_key)
    if not success:
        print(f"[Local LLM] Failed to start local server: {msg}", flush=True)
        return False

    start_wait = time.time()
    poll_interval = 0.25
    while time.time() - start_wait < timeout:
        time.sleep(poll_interval)
        poll_interval = min(poll_interval * 2, 1.0)
        status = check_local_server_status()
        if status is True:
            # Server healthy — verify correct model is loaded
            if is_model_loaded(model_key):
                return True
        elif status is False and _proc and _proc.poll() is not None:
            print(f"[Local LLM] Server process exited during startup with code {_proc.poll()}.", flush=True)
            return False

    print(f"[Local LLM] Server startup timed out after {timeout}s.", flush=True)
    return False

async def ensure_server_online_async(model_key=None, timeout=120.0) -> bool:
    """Async variant of ensure_server_online that yields control via asyncio.sleep."""
    import asyncio
    if not model_key or model_key == "local-llm":
        model_key = os.getenv("LOCAL_MODEL_NAME", "")

    if is_model_loaded(model_key):
        return True

    print(f"[Local LLM] Server offline or switching model. Starting server async (model: {model_key or 'default'})...", flush=True)
    from adapters import local_llm_manager
    success, msg = local_llm_manager.start_server(model_key)
    if not success:
        print(f"[Local LLM] Failed to start local server: {msg}", flush=True)
        return False

    start_wait = time.time()
    poll_interval = 0.25
    while time.time() - start_wait < timeout:
        await asyncio.sleep(poll_interval)
        poll_interval = min(poll_interval * 2, 1.0)
        status = check_local_server_status()
        if status is True:
            if is_model_loaded(model_key):
                return True
        elif status is False and _proc and _proc.poll() is not None:
            print(f"[Local LLM] Server process exited during startup with code {_proc.poll()}.", flush=True)
            return False

    print(f"[Local LLM] Server startup timed out after {timeout}s.", flush=True)
    return False