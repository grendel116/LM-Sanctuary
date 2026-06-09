import os
import subprocess
import threading
import requests
import json
import time

# Headless ComfyUI Manager

from variables import COMFYUI_DIR as _raw_comfy_dir

COMFYUI_DIR = _raw_comfy_dir

def resolve_comfy_dir():
    global COMFYUI_DIR
    _resolved_comfy_dir = _raw_comfy_dir
    if not os.path.exists(os.path.join(_resolved_comfy_dir, "main.py")):
        _alt = os.path.join(_resolved_comfy_dir, "ComfyUI")
        if os.path.exists(os.path.join(_alt, "main.py")):
            _resolved_comfy_dir = _alt
    COMFYUI_DIR = _resolved_comfy_dir
    return COMFYUI_DIR

resolve_comfy_dir()

from urllib.parse import urlparse
from variables import COMFYUI_SERVER_URL

try:
    _url = urlparse(COMFYUI_SERVER_URL)
    COMFYUI_PORT = _url.port or 8188
    COMFYUI_URL = COMFYUI_SERVER_URL.rstrip('/')
except Exception:
    COMFYUI_PORT = 8188
    COMFYUI_URL = f"http://127.0.0.1:{COMFYUI_PORT}"


# Global download/resolution status log
resolution_status = {
    "status": "idle",       # "idle", "resolving", "completed", "failed"
    "progress": "",
    "errors": []
}

def check_comfy_installed():
    """Checks if ComfyUI is installed at the designated path."""
    resolve_comfy_dir()
    main_py = os.path.join(COMFYUI_DIR, "main.py")
    return os.path.exists(main_py)

def check_comfy_running():
    """Checks if the ComfyUI server is responsive on port 8188."""
    try:
        res = requests.get(f"{COMFYUI_URL}/object_info", timeout=1.0)
        return res.status_code == 200
    except Exception:
        return False

def install_comfy():
    """Downloads the portable ComfyUI package matching the GPU architecture, extracts it, and registers ComfyUI-Manager."""
    global resolution_status
    try:
        resolve_comfy_dir()
        if check_comfy_installed():
            return True, "ComfyUI is already installed."
            
        parent_dir = os.path.dirname(COMFYUI_DIR)
        os.makedirs(parent_dir, exist_ok=True)
        
        # 1. Detect GPU Type
        gpu_type = "nvidia"  # Default fallback
        try:
            res = subprocess.run(["powershell", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"], capture_output=True, text=True, timeout=3.0)
            output = res.stdout.lower()
            if "nvidia" in output:
                gpu_type = "nvidia"
            elif "amd" in output or "radeon" in output:
                gpu_type = "amd"
            elif "intel" in output:
                gpu_type = "intel"
        except Exception:
            try:
                res = subprocess.run(["wmic", "path", "win32_VideoController", "get", "name"], capture_output=True, text=True, timeout=3.0)
                output = res.stdout.lower()
                if "nvidia" in output:
                    gpu_type = "nvidia"
                elif "amd" in output or "radeon" in output:
                    gpu_type = "amd"
                elif "intel" in output:
                    gpu_type = "intel"
            except Exception:
                pass
            
        # 2. Get Release URLs
        download_url = f"https://github.com/Comfy-Org/ComfyUI/releases/download/v0.24.0/ComfyUI_windows_portable_{gpu_type}.7z"
        
        # Try to dynamically query the latest release from GitHub API
        try:
            resolution_status["progress"] = "Querying latest ComfyUI releases..."
            print(f"[Installer] {resolution_status['progress']}", flush=True)
            res = requests.get("https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest", timeout=5.0)
            if res.status_code == 200:
                data = res.json()
                for asset in data.get("assets", []):
                    name = asset.get("name", "")
                    if f"ComfyUI_windows_portable_{gpu_type}.7z" in name:
                        download_url = asset.get("browser_download_url")
                        break
        except Exception as e:
            print(f"Failed to query latest release API: {e}", flush=True)
            
        # 3. Download the portable package
        archive_name = f"ComfyUI_windows_portable_{gpu_type}.7z"
        archive_path = os.path.join(parent_dir, archive_name)
        
        resolution_status["progress"] = f"Downloading {archive_name}..."
        print(f"[Installer] Starting download from: {download_url}", flush=True)
        
        res = requests.get(download_url, stream=True, timeout=30)
        res.raise_for_status()
        
        total_size = int(res.headers.get('content-length', 0))
        downloaded = 0
        last_reported_percent = -1
        
        with open(archive_path, "wb") as f:
            for chunk in res.iter_content(chunk_size=1024 * 1024):  # 1MB chunks
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = int((downloaded / total_size) * 100)
                        resolution_status["progress"] = f"Downloading ComfyUI Portable: {percent}% ({downloaded // (1024*1024)}MB / {total_size // (1024*1024)}MB)"
                        # Print to console every 5%
                        if percent % 5 == 0 and percent != last_reported_percent:
                            print(f"[Installer] {resolution_status['progress']}", flush=True)
                            last_reported_percent = percent
                    else:
                        resolution_status["progress"] = f"Downloading ComfyUI Portable: {downloaded // (1024*1024)}MB"
                        if (downloaded // (1024*1024)) % 50 == 0:
                            print(f"[Installer] {resolution_status['progress']}", flush=True)
                        
        # 4. Extract package using native tar (bsdtar)
        resolution_status["progress"] = f"Extracting {archive_name} using native system tar..."
        print(f"[Installer] {resolution_status['progress']}", flush=True)
        extract_cmd = ["tar", "-xf", archive_path, "-C", parent_dir]
        subprocess.run(extract_cmd, check=True)
        print(f"[Installer] Extraction finished.", flush=True)
        
        # 5. Rename extracted directory to 'ComfyUI'
        extracted_dir_name = None
        for item in os.listdir(parent_dir):
            if item.startswith("ComfyUI_windows_portable") and os.path.isdir(os.path.join(parent_dir, item)):
                extracted_dir_name = item
                break
                
        if not extracted_dir_name:
            extracted_dir_name = "ComfyUI_windows_portable"
            
        extracted_dir_path = os.path.join(parent_dir, extracted_dir_name)
        target_dir_path = os.path.join(parent_dir, "ComfyUI")
        
        if os.path.exists(extracted_dir_path):
            resolution_status["progress"] = "Configuring folder structure..."
            print(f"[Installer] {resolution_status['progress']}", flush=True)
            if os.path.exists(target_dir_path):
                for item in os.listdir(extracted_dir_path):
                    s = os.path.join(extracted_dir_path, item)
                    d = os.path.join(target_dir_path, item)
                    if os.path.exists(d):
                        if os.path.isdir(d):
                            import shutil
                            shutil.rmtree(d)
                        else:
                            os.remove(d)
                    os.rename(s, d)
                os.rmdir(extracted_dir_path)
            else:
                os.rename(extracted_dir_path, target_dir_path)
                
        # Clean up archive
        try:
            os.remove(archive_path)
        except Exception:
            pass
            
        # Update ComfyUI directory resolution globally
        resolve_comfy_dir()
        
        # 6. Install ComfyUI-Manager
        resolution_status["progress"] = "Cloning ComfyUI-Manager..."
        print(f"[Installer] {resolution_status['progress']}", flush=True)
        manager_dir = os.path.join(COMFYUI_DIR, "custom_nodes", "ComfyUI-Manager")
        subprocess.run(["git", "clone", "https://github.com/ltdrdata/ComfyUI-Manager.git", manager_dir], check=True)
        
        # 7. Install requirements in the embedded Python environment
        resolution_status["progress"] = "Installing ComfyUI-Manager requirements..."
        print(f"[Installer] {resolution_status['progress']}", flush=True)
        portable_python = os.path.join(os.path.dirname(COMFYUI_DIR), "python_embeded", "python.exe")
        if os.path.exists(portable_python):
            subprocess.run([portable_python, "-m", "pip", "install", "-r", os.path.join(manager_dir, "requirements.txt")], check=True)
            
        # 8. Configure ComfyUI-Manager to run in offline mode to prevent slow/stalling registry updates on boot
        try:
            config_dir = os.path.join(COMFYUI_DIR, "user", "__manager")
            os.makedirs(config_dir, exist_ok=True)
            config_path = os.path.join(config_dir, "config.ini")
            config_content = (
                "[default]\n"
                "preview_method = none\n"
                "git_exe = \n"
                "use_uv = False\n"
                "channel_url = https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main\n"
                "share_option = all\n"
                "bypass_ssl = False\n"
                "file_logging = True\n"
                "component_policy = workflow\n"
                "update_policy = stable-comfyui\n"
                "windows_selector_event_loop_policy = False\n"
                "model_download_by_agent = False\n"
                "downgrade_blacklist = \n"
                "security_level = normal\n"
                "always_lazy_install = False\n"
                "network_mode = offline\n"
                "db_mode = cache\n"
            )
            with open(config_path, "w", encoding="utf-8") as cfg_f:
                cfg_f.write(config_content)
            print("[Installer] ComfyUI-Manager configured in offline network_mode.", flush=True)
        except Exception as ce:
            print(f"[Installer] Warning: Failed to write config.ini: {ce}", flush=True)
            
        print("[Installer] ComfyUI Portable setup completed successfully!", flush=True)
        return True, "ComfyUI portable environment installed successfully!"
    except Exception as e:
        print(f"[Installer] ERROR: Installation failed: {e}", flush=True)
        return False, f"Failed to install ComfyUI portable: {e}"

def _install_worker():
    global resolution_status
    resolution_status["status"] = "resolving"
    resolution_status["progress"] = "Initializing installer..."
    resolution_status["errors"] = []
    
    success, msg = install_comfy()
    if success:
        resolution_status["status"] = "completed"
        resolution_status["progress"] = "ComfyUI installation completed successfully!"
    else:
        resolution_status["status"] = "failed"
        resolution_status["progress"] = f"Installation failed: {msg}"
        resolution_status["errors"].append(msg)

def trigger_install_comfy():
    """Starts the background thread to install ComfyUI."""
    if resolution_status["status"] == "resolving":
        return False, "An installation or dependency resolution is already running."
        
    thread = threading.Thread(target=_install_worker)
    thread.daemon = True
    thread.start()
    return True, "ComfyUI installation started in the background."

def is_amd_gpu():
    """Checks if the system has an AMD graphics card."""
    try:
        res = subprocess.run(["wmic", "path", "win32_VideoController", "get", "name"], capture_output=True, text=True, timeout=3.0)
        if "amd" in res.stdout.lower() or "radeon" in res.stdout.lower():
            return True
    except Exception:
        pass
    try:
        res = subprocess.run(["powershell", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"], capture_output=True, text=True, timeout=3.0)
        if "amd" in res.stdout.lower() or "radeon" in res.stdout.lower():
            return True
    except Exception:
        pass
    return False

def start_comfy_daemon():
    """Starts the headless ComfyUI server daemon in the background."""
    if check_comfy_running():
        return True, "ComfyUI is already running."
        
    if not check_comfy_installed():
        return False, "ComfyUI is not installed. Please trigger installation first."
        
    try:
        venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".venv", "Scripts", "python.exe")
        
        # Check if there is an embedded python in the ComfyUI folder or parent directory (portable standalone builds)
        portable_python = os.path.join(COMFYUI_DIR, "python_embeded", "python.exe")
        if not os.path.exists(portable_python):
            portable_python = os.path.join(os.path.dirname(os.path.normpath(COMFYUI_DIR)), "python_embeded", "python.exe")
            
        if os.path.exists(portable_python):
            venv_python = portable_python
        elif not os.path.exists(venv_python):
            venv_python = "python"
            
        main_py = os.path.join(COMFYUI_DIR, "main.py")
        
        # Check if CUDA is supported by the installed torch in the virtual environment
        cuda_supported = False
        try:
            check_cmd = [venv_python, "-c", "import torch; print(torch.cuda.is_available())"]
            res = subprocess.run(check_cmd, capture_output=True, text=True, timeout=30.0)
            if "True" in res.stdout:
                cuda_supported = True
        except Exception:
            pass
            
        # Check if DirectML is supported by torch in this environment
        dml_supported = False
        try:
            check_cmd = [venv_python, "-c", "import torch_directml; print(torch_directml.is_available())"]
            res = subprocess.run(check_cmd, capture_output=True, text=True, timeout=30.0)
            if "True" in res.stdout:
                dml_supported = True
        except Exception:
            pass
            
        try:
            _url = urlparse(COMFYUI_SERVER_URL)
            listen_ip = _url.hostname or "127.0.0.1"
            if listen_ip.lower() == "localhost":
                listen_ip = "127.0.0.1"
        except Exception:
            listen_ip = "127.0.0.1"

        cmd = [venv_python, main_py, "--listen", listen_ip, "--port", str(COMFYUI_PORT)]
        
        if cuda_supported:
            pass
        elif dml_supported:
            cmd.append("--directml")
        else:
            cmd.append("--cpu")

        # Append custom arguments from environment if defined, otherwise default to --lowvram
        # to prevent VRAM paging/spilling to system RAM on 24GB cards running large 14B models.
        comfy_args = os.getenv("COMFYUI_ARGS", "--lowvram")
        if comfy_args:
            import shlex
            cmd.extend(shlex.split(comfy_args))
            
        # Start ComfyUI headlessly (shell=False handles spaces in venv path automatically)
        log_file = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "comfy_server.log")
        with open(log_file, "a", encoding="utf-8") as log_fd:
            subprocess.Popen(cmd, stdout=log_fd, stderr=log_fd, shell=False)
        
        # Poll to confirm it starts (up to 60 seconds to accommodate initial database upgrades)
        for _ in range(30):
            time.sleep(2.0)
            if check_comfy_running():
                return True, "ComfyUI server started successfully."
                
        return False, "ComfyUI server did not start in time."
    except Exception as e:
        return False, f"Failed to start ComfyUI daemon: {e}"

# Custom Node Database
CUSTOM_NODE_DB_URL = "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/custom-node-list.json"
MODEL_DB_URL = "https://raw.githubusercontent.com/ltdrdata/ComfyUI-Manager/main/model-list.json"

def fetch_comfy_manager_databases():
    """Downloads registry lists from ComfyUI-Manager to map class types to Git repos and download URLs."""
    node_db_path = os.path.join(COMFYUI_DIR, "custom-node-list.json")
    model_db_path = os.path.join(COMFYUI_DIR, "model-list.json")
    
    try:
        if not os.path.exists(node_db_path) or (time.time() - os.path.getmtime(node_db_path) > 86400):
            res = requests.get(CUSTOM_NODE_DB_URL, timeout=5)
            if res.status_code == 200:
                with open(node_db_path, "w", encoding="utf-8") as f:
                    f.write(res.text)
                    
        if not os.path.exists(model_db_path) or (time.time() - os.path.getmtime(model_db_path) > 86400):
            res2 = requests.get(MODEL_DB_URL, timeout=5)
            if res2.status_code == 200:
                with open(model_db_path, "w", encoding="utf-8") as f:
                    f.write(res2.text)
    except Exception as e:
        print(f"Error fetching ComfyUI-Manager databases: {e}")

def parse_workflow_dependencies(workflow_json_str):
    """Parses workflow JSON to identify missing node classes and missing model filenames."""
    try:
        workflow = json.loads(workflow_json_str)
    except Exception:
        return [], []
        
    required_nodes = set()
    required_models = set() # (type, filename)
    
    # Standard format support (API format or workflow format)
    # 1. API format (dict key is node id, value is dict with "class_type" and "inputs")
    # 2. Workflow format (dict contains "nodes" array where each node has "type" and "widgets_values")
    
    if "nodes" in workflow and isinstance(workflow["nodes"], list):
        for node in workflow["nodes"]:
            node_type = node.get("type")
            if node_type:
                if "lora" in node_type.lower():
                    continue
                required_nodes.add(node_type)
            # Find widgets or fields containing filenames
            inputs = node.get("widgets_values", [])
            for val in inputs:
                if isinstance(val, str) and (val.endswith(".safetensors") or val.endswith(".sft") or val.endswith(".ckpt")):
                    if "lora" not in val.lower():
                        required_models.add(val)
    elif isinstance(workflow, dict):
        for node_id, node_data in workflow.items():
            if isinstance(node_data, dict):
                node_type = node_data.get("class_type")
                if node_type:
                    if "lora" in node_type.lower():
                        continue
                    required_nodes.add(node_type)
                inputs = node_data.get("inputs", {})
                for k, val in inputs.items():
                    if k == "lora_name" or "lora" in k.lower():
                        continue
                    if isinstance(val, str) and (val.endswith(".safetensors") or val.endswith(".sft") or val.endswith(".ckpt")):
                        if "lora" not in val.lower():
                            required_models.add(val)
                        
    return list(required_nodes), list(required_models)

def _resolver_worker(workflow_json_str):
    global resolution_status
    resolution_status = {"status": "resolving", "progress": "Starting dependency resolution...", "errors": []}
    
    try:
        # Ensure ComfyUI and databases are present
        if not check_comfy_installed():
            resolution_status["progress"] = "Installing ComfyUI..."
            success, msg = install_comfy()
            if not success:
                raise Exception(msg)
                
        fetch_comfy_manager_databases()
        
        required_nodes, required_models = parse_workflow_dependencies(workflow_json_str)
        
        # Ensure we always require the default checkpoint and VAE if not already present on disk
        from variables import COMFYUI_CHECKPOINT, COMFYUI_VAE
        ckpt_path = os.path.normpath(os.path.join(COMFYUI_DIR, "models", "checkpoints", COMFYUI_CHECKPOINT))
        if not os.path.exists(ckpt_path) and COMFYUI_CHECKPOINT not in required_models:
            required_models.append(COMFYUI_CHECKPOINT)
            
        vae_path = os.path.normpath(os.path.join(COMFYUI_DIR, "models", "vae", COMFYUI_VAE))
        if not os.path.exists(vae_path) and COMFYUI_VAE not in required_models:
            required_models.append(COMFYUI_VAE)
        
        # 1. Resolve custom nodes
        missing_nodes = []
        if check_comfy_running():
            try:
                res = requests.get(f"{COMFYUI_URL}/object_info", timeout=2)
                if res.status_code == 200:
                    installed_nodes = res.json().keys()
                    missing_nodes = [n for n in required_nodes if n not in installed_nodes]
            except Exception:
                missing_nodes = required_nodes
        else:
            missing_nodes = required_nodes
            
        # Try to map missing nodes to repositories
        node_db_path = os.path.join(COMFYUI_DIR, "custom-node-list.json")
        mapped_repos = set()
        if os.path.exists(node_db_path) and missing_nodes:
            with open(node_db_path, "r", encoding="utf-8") as f:
                db_data = json.load(f)
                
            custom_nodes_list = db_data.get("custom_nodes", [])
            for node_type in missing_nodes:
                found = False
                for node_info in custom_nodes_list:
                    # Check if the node class_type is listed inside the repository info
                    # ComfyUI-Manager list typically matches by nodename_pattern or class type lists
                    nodename_pattern = node_info.get("nodename_pattern", "")
                    title = node_info.get("title", "").lower()
                    repo_url = node_info.get("reference", "")
                    
                    if node_type.lower() in title or node_type.lower() in nodename_pattern.lower():
                        mapped_repos.add(repo_url)
                        found = True
                        break
                if not found:
                    print(f"[Resolver] Could not find mapping for node type: {node_type}")
                    
        # Clone resolved repositories
        venv_python = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".venv", "Scripts", "python.exe")
        if not os.path.exists(venv_python):
            venv_python = "python"
            
        for repo in mapped_repos:
            repo_name = repo.split("/")[-1].replace(".git", "")
            target_path = os.path.join(COMFYUI_DIR, "custom_nodes", repo_name)
            if not os.path.exists(target_path):
                resolution_status["progress"] = f"Cloning node repository: {repo_name}..."
                subprocess.run(["git", "clone", repo, target_path], check=True)
                # Install requirements if present
                req_txt = os.path.join(target_path, "requirements.txt")
                if os.path.exists(req_txt):
                    resolution_status["progress"] = f"Installing dependencies for {repo_name}..."
                    subprocess.run([venv_python, "-m", "pip", "install", "-r", req_txt], check=True)
                    
        # 2. Resolve missing models (Checkpoints, LoRAs, VAEs)
        model_db_path = os.path.join(COMFYUI_DIR, "model-list.json")
        mapped_models = []
        
        models_list = []
        if os.path.exists(model_db_path):
            try:
                with open(model_db_path, "r", encoding="utf-8") as f:
                    model_db = json.load(f)
                models_list = model_db.get("models", [])
            except Exception as e:
                print(f"Error loading model database: {e}")
                
        for filename in required_models:
            # Determine destination folders based on extension/type
            dest_subfolder = "checkpoints"
            if "lora" in filename.lower():
                dest_subfolder = "loras"
            elif "vae" in filename.lower():
                dest_subfolder = "vae"
                
            target_path = os.path.normpath(os.path.join(COMFYUI_DIR, "models", dest_subfolder, filename))
            if os.path.exists(target_path):
                continue # Already downloaded
                
            # Search ComfyUI-Manager model list for direct link
            download_url = None
            for m_info in models_list:
                m_filename = m_info.get("filename", "")
                if m_filename.lower() == filename.lower():
                    download_url = m_info.get("url")
                    break
                    
            # Hardcoded official stabilityai HF fallbacks for standard checkpoints/VAEs
            if not download_url:
                if filename == "sd_xl_base_1.0.safetensors":
                    download_url = "https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors"
                elif filename == "sdxl_vae.safetensors":
                    download_url = "https://huggingface.co/stabilityai/sdxl-vae/resolve/main/sdxl_vae.safetensors"
                    
            # Fallback to searching Hugging Face directly if still not listed
            if not download_url:
                try:
                    hf_url = f"https://huggingface.co/api/models?search={filename.replace('.safetensors','')}&limit=1"
                    res = requests.get(hf_url, timeout=3)
                    if res.status_code == 200 and res.json():
                        hf_repo = res.json()[0].get("id")
                        # Fetch file list from HF repo
                        files_url = f"https://huggingface.co/api/models/{hf_repo}/tree/main"
                        res_files = requests.get(files_url, timeout=3)
                        if res_files.status_code == 200:
                            for f_item in res_files.json():
                                if f_item.get("path", "").lower() == filename.lower():
                                    download_url = f"https://huggingface.co/{hf_repo}/resolve/main/{filename}"
                                    break
                except Exception:
                    pass
                    
            if download_url:
                mapped_models.append((download_url, target_path, filename))
            else:
                resolution_status["errors"].append(f"Model URL could not be resolved for: {filename}")
                    
        # Download resolved models
        for url, dest, filename in mapped_models:
            resolution_status["progress"] = f"Downloading model: {filename}..."
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            res = requests.get(url, stream=True, timeout=30)
            if res.status_code == 200:
                with open(dest, "wb") as f:
                    for chunk in res.iter_content(chunk_size=8192):
                        if chunk:
                            f.write(chunk)
            else:
                resolution_status["errors"].append(f"Failed to download {filename} (HTTP {res.status_code})")
                
        # Trigger restart if ComfyUI is running to reload custom nodes
        if check_comfy_running():
            resolution_status["progress"] = "Restarting ComfyUI to load new components..."
            # ComfyUI-Manager provides a /manager/reboot API endpoint
            try:
                requests.post(f"{COMFYUI_URL}/manager/reboot", timeout=2)
            except Exception:
                pass
                
        resolution_status["status"] = "completed"
        resolution_status["progress"] = "Dependency resolution completed successfully!"
    except Exception as e:
        resolution_status["status"] = "failed"
        resolution_status["progress"] = f"Failed during resolution: {e}"
        resolution_status["errors"].append(str(e))

def trigger_dependency_resolution(workflow_json_str):
    """Launches the background resolver thread to install missing nodes/models."""
    if resolution_status["status"] == "resolving":
        return False, "Already resolving dependencies."
        
    thread = threading.Thread(target=_resolver_worker, args=(workflow_json_str,))
    thread.daemon = True
    thread.start()
    return True, "Dependency resolution started in the background."

def stop_comfy_daemon():
    """Stops the ComfyUI server daemon by terminating its process."""
    import psutil
    try:
        terminated_any = False
        # 1. Search by command line contents
        for proc in psutil.process_iter(['pid', 'name', 'cmdline']):
            try:
                cmdline = proc.info.get('cmdline') or []
                cmdline_str = " ".join(cmdline).lower()
                if "python" in proc.info.get('name', '').lower() and "main.py" in cmdline_str and "comfy" in cmdline_str:
                    proc.terminate()
                    proc.wait(timeout=2.0)
                    terminated_any = True
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
                pass
                
        # 2. Search by connections (fallback)
        for proc in psutil.process_iter(['pid', 'name']):
            try:
                conns = proc.connections() if hasattr(proc, 'connections') else []
                for conn in conns:
                    if conn.laddr and conn.laddr.port == COMFYUI_PORT:
                        proc.terminate()
                        proc.wait(timeout=2.0)
                        terminated_any = True
                        break
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.TimeoutExpired):
                pass
                
        if terminated_any:
            return True, "ComfyUI daemon stopped successfully."
        return False, "ComfyUI daemon is not running."
    except Exception as e:
        return False, f"Failed to stop ComfyUI daemon: {e}"


# --- Checkpoint Management Functions ---

def list_local_checkpoints():
    """Scans ComfyUI/models/checkpoints/ directory and returns list of available filenames."""
    checkpoints = []
    checkpoints_dir = os.path.normpath(os.path.join(COMFYUI_DIR, "models", "checkpoints"))
    if os.path.exists(checkpoints_dir):
        for root, dirs, files in os.walk(checkpoints_dir):
            for file in files:
                if file.lower().endswith((".safetensors", ".ckpt", ".sft")):
                    rel_path = os.path.relpath(os.path.join(root, file), checkpoints_dir)
                    # Normalize path separators to forward slash
                    key = rel_path.replace("\\", "/")
                    checkpoints.append(key)
    return sorted(list(set(checkpoints)))

def search_huggingface_checkpoints(query):
    """Searches Hugging Face for text-to-image models and resolves their checkpoint filenames and download links."""
    results = []
    try:
        # Search for text-to-image repositories matching query
        url = f"https://huggingface.co/api/models?search={query}&filter=text-to-image&sort=likes&direction=-1&limit=15"
        res = requests.get(url, timeout=3.0)
        if res.status_code == 200:
            repos = res.json()
            for repo in repos:
                repo_id = repo.get("id")
                likes = repo.get("likes", 0)
                downloads = repo.get("downloads", 0)
                
                # Fetch files in this repo to find safetensors checkpoints
                try:
                    files_url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
                    files_res = requests.get(files_url, timeout=2.0)
                    if files_res.status_code == 200:
                        for item in files_res.json():
                            path = item.get("path", "")
                            if path.lower().endswith((".safetensors", ".ckpt")) and "vae" not in path.lower() and "lora" not in path.lower():
                                filename = path.split("/")[-1]
                                download_url = f"https://huggingface.co/{repo_id}/resolve/main/{path}"
                                results.append({
                                    "id": f"{repo_id}/{path}",
                                    "repo_id": repo_id,
                                    "filename": filename,
                                    "download_url": download_url,
                                    "likes": likes,
                                    "downloads": downloads
                                })
                        # Cap results to avoid blowing up memory/response size
                        if len(results) >= 20:
                            break
                except Exception:
                    pass
    except Exception as e:
        print(f"Error searching Hugging Face checkpoints: {e}")
    return results

checkpoint_download_status = {}  # filename: { 'status': 'idle'|'downloading'|'completed'|'failed', 'progress': 0, 'error': None }

def _checkpoint_download_worker(url, filename):
    checkpoint_download_status[filename] = {"status": "downloading", "progress": 0, "error": None}
    try:
        dest_dir = os.path.normpath(os.path.join(COMFYUI_DIR, "models", "checkpoints"))
        os.makedirs(dest_dir, exist_ok=True)
        dest_path = os.path.join(dest_dir, filename)
        
        # Download with chunk progress reporting
        res = requests.get(url, stream=True, timeout=30)
        res.raise_for_status()
        
        total_size = int(res.headers.get('content-length', 0))
        downloaded = 0
        
        with open(dest_path, "wb") as f:
            for chunk in res.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    downloaded += len(chunk)
                    if total_size > 0:
                        percent = int((downloaded / total_size) * 100)
                        checkpoint_download_status[filename]["progress"] = percent
                        
        checkpoint_download_status[filename]["status"] = "completed"
        checkpoint_download_status[filename]["progress"] = 100
    except Exception as e:
        checkpoint_download_status[filename]["status"] = "failed"
        checkpoint_download_status[filename]["error"] = str(e)

def trigger_checkpoint_download(url, filename):
    """Starts the background thread to download a checkpoint from a URL."""
    if filename in checkpoint_download_status and checkpoint_download_status[filename]["status"] == "downloading":
        return False, "Already downloading this checkpoint."
        
    thread = threading.Thread(target=_checkpoint_download_worker, args=(url, filename))
    thread.daemon = True
    thread.start()
    return True, "Checkpoint download started in background."
