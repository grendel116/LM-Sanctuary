import os
import requests
import re
import json
import time

# Thread-safe storage/tracking for downloads
# download_status = { model_name: { 'status': 'idle'|'downloading'|'completed'|'failed', 'downloaded_bytes': ..., 'total_size_bytes': ..., 'bytes_per_second': ..., 'error': None } }
download_status = {}
active_jobs = {}  # model_name: job_id

_lms_cli_cached = None
_lms_cli_cache_time = 0.0

_daemon_status_cached = None
_daemon_status_cache_time = 0.0

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

def check_lms_cli():
    """Checks if the lms executable is functional (cached)."""
    global _lms_cli_cached, _lms_cli_cache_time
    now = time.time()
    if _lms_cli_cached is not None and (now - _lms_cli_cache_time < 30.0):
        return _lms_cli_cached
    try:
        lms_path = get_lms_path()
        import subprocess
        res = subprocess.run([lms_path, "--version"], capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False)
        _lms_cli_cached = (res.returncode == 0)
    except Exception:
        _lms_cli_cached = False
    _lms_cli_cache_time = now
    return _lms_cli_cached

def check_daemon_status(force_refresh=False):
    """Checks if the LM Studio daemon is running and responsive (cached)."""
    global _daemon_status_cached, _daemon_status_cache_time
    now = time.time()
    if not force_refresh and _daemon_status_cached is not None and (now - _daemon_status_cache_time < 3.0):
        return _daemon_status_cached
    try:
        from variables import LOCAL_MODELS_URL
        response = requests.get(LOCAL_MODELS_URL, timeout=0.2)
        _daemon_status_cached = (response.status_code == 200)
    except Exception:
        _daemon_status_cached = False
    _daemon_status_cache_time = now
    return _daemon_status_cached

def start_lms_daemon():
    """Starts the lms server daemon in the background."""
    try:
        lms_path = get_lms_path()
        import subprocess
        subprocess.Popen([lms_path, "server", "start"], shell=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        return True, "LM Studio daemon start initiated."
    except Exception as e:
        return False, f"Failed to start LM Studio daemon: {e}"

def stop_lms_daemon():
    """Stops the LM Studio daemon."""
    try:
        lms_path = get_lms_path()
        import subprocess
        process = subprocess.run([lms_path, "server", "stop"], shell=False, capture_output=True, text=True, encoding='utf-8', errors='ignore')
        if process.returncode == 0:
            return True, "LM Studio daemon stopped successfully."
        return False, f"Failed to stop LM Studio daemon: {process.stderr}"
    except Exception as e:
        return False, f"Failed to stop LM Studio daemon: {e}"

def extract_quantization_tag(filename):
    """Parses a quantization tag from a GGUF filename."""
    tags = [
        "IQ1_M", "IQ1_S", "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M",
        "Q2_K_S", "Q2_K", "IQ3_XXS", "IQ3_XS", "Q3_K_S", "IQ3_S", "IQ3_M", "Q3_K_M", "Q3_K_L",
        "IQ4_XS", "IQ4_NL", "Q4_0", "Q4_1", "Q4_K_M", "Q4_K_S", "Q5_0", "Q5_1", "Q5_K_M", "Q5_K_S",
        "Q6_K", "Q8_0", "F16", "BF16", "FP16"
    ]
    filename_upper = filename.upper()
    for tag in tags:
        pattern = rf"\b{tag}\b|[\.\-_]{tag}[\.\-_]|[\.\-_]{tag}$"
        if re.search(pattern, filename_upper):
            return tag
    # Fallback pattern
    match = re.search(r'[qQ][iI]?[0-9]_[A-Za-z0-9_]+', filename)
    if match:
        return match.group(0).upper()
    return None

def search_huggingface_repos(query):
    """Searches Hugging Face for GGUF model repositories."""
    results = []
    query = query.strip()
    if not query:
        return results

    # If user searched a full GGUF filename directly, strip suffix and extract quantization
    extracted_quant = None
    cleaned_query = query
    if ".gguf" in cleaned_query.lower():
        quant_match = re.search(r'(?:i\d+[\.\-_]?)?([qQ]\d+(?:_[a-zA-Z0-9_]+)?)', cleaned_query)
        if quant_match:
            extracted_quant = quant_match.group(1).upper()
        if cleaned_query.lower().endswith(".gguf"):
            cleaned_query = cleaned_query[:-5]
        else:
            idx = cleaned_query.lower().find(".gguf")
            cleaned_query = cleaned_query[:idx]
        # Strip quantization suffix patterns
        pattern = r'[\.\-_](?:i\d+[\.\-_]?)?[qQ]\d+[a-zA-Z0-9_]*'
        cleaned_query = re.sub(pattern, '', cleaned_query).strip()

    # Extract repo ID if user entered a full HF URL
    if "huggingface.co/" in cleaned_query:
        parts = cleaned_query.split("huggingface.co/")
        if len(parts) > 1:
            subparts = parts[1].split("/")
            if len(subparts) >= 2:
                cleaned_query = f"{subparts[0]}/{subparts[1]}"

    headers = {"User-Agent": "LM-Sanctuary-Client/1.0"}
    try:
        url = f"https://huggingface.co/api/models?search={cleaned_query}&filter=gguf&sort=likes&direction=-1&limit=20"
        response = requests.get(url, headers=headers, timeout=5.0)
        if response.status_code == 200:
            for item in response.json():
                model_id = item.get("id")
                likes = item.get("likes", 0)
                downloads = item.get("downloads", 0)
                
                results.append({
                    "id": model_id,
                    "likes": likes,
                    "downloads": downloads,
                    "author": model_id.split("/")[0] if "/" in model_id else "Unknown",
                    "extracted_quant": extracted_quant
                })
        
        # Fallback if query is directly "author/repo" and returned nothing
        if not results and "/" in cleaned_query:
            check_url = f"https://huggingface.co/api/models/{cleaned_query}"
            r = requests.get(check_url, headers=headers, timeout=3.0)
            if r.status_code == 200:
                results.append({
                    "id": cleaned_query,
                    "likes": r.json().get("likes", 0),
                    "downloads": r.json().get("downloads", 0),
                    "author": cleaned_query.split("/")[0],
                    "extracted_quant": extracted_quant
                })
    except Exception as e:
        print(f"[search_huggingface_repos] Error: {e}")
    return results

def get_huggingface_repo_files(repo_id):
    """Fetches all GGUF files in a repository using HF's tree API."""
    files = []
    headers = {"User-Agent": "LM-Sanctuary-Client/1.0"}
    try:
        url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
        response = requests.get(url, headers=headers, timeout=5.0)
        if response.status_code == 200:
            for item in response.json():
                if item.get("type") == "file" and item.get("path", "").lower().endswith(".gguf"):
                    filename = item.get("path")
                    size = item.get("size", 0)
                    quant = extract_quantization_tag(filename)
                    files.append({
                        "filename": filename,
                        "size": size,
                        "quantization": quant
                    })
    except Exception as e:
        print(f"[get_huggingface_repo_files] Error fetching files for {repo_id}: {e}")
    return files

def trigger_download(model_name, quantization=None):
    """Initiates a download job via LM Studio REST API."""
    try:
        # Start daemon if offline
        if not check_daemon_status():
            start_lms_daemon()

        repo_id = model_name
        if "@" in repo_id and not quantization:
            repo_id, quantization = repo_id.split("@", 1)

        # Normalize to full Hugging Face URL
        if not repo_id.startswith("http://") and not repo_id.startswith("https://") and "/" in repo_id:
            model_url = f"https://huggingface.co/{repo_id}"
        else:
            model_url = repo_id

        payload = {"model": model_url}
        if quantization:
            payload["quantization"] = quantization

        url = "http://localhost:1234/api/v1/models/download"
        resp = requests.post(url, json=payload, timeout=5.0)
        if resp.status_code == 200:
            data = resp.json()
            job_id = data.get("job_id")
            
            # Map tracking entry
            tracking_name = f"{repo_id}@{quantization}" if quantization else repo_id
            active_jobs[tracking_name] = job_id
            download_status[tracking_name] = {
                "status": "downloading",
                "downloaded_bytes": 0,
                "total_size_bytes": data.get("total_size_bytes", 0),
                "bytes_per_second": 0,
                "error": None
            }
            return True, "Download started."
        else:
            err = resp.json().get("error", {}).get("message", resp.text)
            return False, f"Failed to start download: {err}"
    except Exception as e:
        return False, str(e)

def update_download_statuses():
    """Polls LM Studio for progress on all active download jobs."""
    to_remove = []
    for model_name, job_id in list(active_jobs.items()):
        try:
            url = f"http://localhost:1234/api/v1/models/download/status/{job_id}"
            resp = requests.get(url, timeout=2.0)
            if resp.status_code == 200:
                data = resp.json()
                status = data.get("status", "downloading")
                download_status[model_name].update({
                    "status": status,
                    "downloaded_bytes": data.get("downloaded_bytes", 0),
                    "total_size_bytes": data.get("total_size_bytes", 0),
                    "bytes_per_second": data.get("bytes_per_second", 0),
                    "estimated_completion": data.get("estimated_completion")
                })
                if status in ["completed", "failed"]:
                    to_remove.append(model_name)
                    if status == "failed":
                        download_status[model_name]["error"] = "Download failed on LM Studio."
            else:
                download_status[model_name].update({
                    "status": "failed",
                    "error": f"API returned status {resp.status_code}"
                })
                to_remove.append(model_name)
        except Exception as e:
            print(f"[update_download_statuses] Error polling {job_id}: {e}")
            
    for model_name in to_remove:
        active_jobs.pop(model_name, None)

_local_models_list_cached = None
_local_models_list_cache_time = 0.0

def scan_gguf_files_depth_limited(base_dir, max_depth=4):
    """Recursively scans a directory for GGUF files up to a maximum depth."""
    models = []
    base_dir = os.path.normpath(base_dir)
    
    def _scan(current_dir, current_depth):
        if current_depth > max_depth:
            return
        try:
            with os.scandir(current_dir) as it:
                for entry in it:
                    if entry.is_file():
                        if entry.name.lower().endswith(".gguf"):
                            rel_path = os.path.relpath(entry.path, base_dir)
                            model_key = rel_path.replace("\\", "/")
                            models.append(model_key)
                    elif entry.is_dir():
                        _scan(entry.path, current_depth + 1)
        except Exception:
            pass
            
    _scan(base_dir, 1)
    return models

def list_local_models(force_refresh=False):
    """Returns a list of GGUF model keys by scanning the REST API or falling back to disk (cached)."""
    global _local_models_list_cached, _local_models_list_cache_time
    now = time.time()
    if not force_refresh and _local_models_list_cached is not None and (now - _local_models_list_cache_time < 5.0):
        return _local_models_list_cached
        
    models = []
    # If online, use native REST API to list models
    if check_daemon_status(force_refresh=force_refresh):
        try:
            url = "http://localhost:1234/api/v1/models"
            resp = requests.get(url, timeout=0.3)
            if resp.status_code == 200:
                for m in resp.json().get("models", []):
                    # Only show LLM models, exclude embedding models
                    if m.get("type") == "llm" and m.get("format") == "gguf":
                        key = m.get("key")
                        if key:
                            models.append(key)
                _local_models_list_cached = sorted(list(set(models)))
                _local_models_list_cache_time = now
                return _local_models_list_cached
        except Exception as e:
            print(f"[list_local_models] REST API listing failed: {e}")

    # Fallback to local disk scan if offline
    user_profile = os.environ.get("USERPROFILE")
    if user_profile:
        models_dir = os.path.join(user_profile, ".lmstudio", "models")
        if os.path.exists(models_dir):
            models = scan_gguf_files_depth_limited(models_dir, max_depth=4)
            
    _local_models_list_cached = sorted(list(set(models)))
    _local_models_list_cache_time = now
    return _local_models_list_cached

def _update_env_model_name(model_name):
    try:
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        env_path = os.path.join(base_dir, '.env')
        if os.path.exists(env_path):
            with open(env_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            updated = False
            for i, line in enumerate(lines):
                if line.strip().startswith('LOCAL_MODEL_NAME='):
                    lines[i] = f"LOCAL_MODEL_NAME={model_name}\n"
                    updated = True
                    break
            if not updated:
                lines.append(f"\nLOCAL_MODEL_NAME={model_name}\n")
            with open(env_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
        os.environ["LOCAL_MODEL_NAME"] = model_name
    except Exception as env_err:
        print(f"[lms_manager] Failed to update LOCAL_MODEL_NAME in env: {env_err}", flush=True)

def load_local_model(model_name):
    """Loads a model into memory via CLI or native REST API with GPU offload support."""
    try:
        if not check_daemon_status():
            start_lms_daemon()

        lms_context = os.getenv("LMS_CONTEXT")
        lms_gpu = os.getenv("LMS_GPU")
        
        # Try CLI first if functional
        if check_lms_cli():
            lms_path = get_lms_path()
            cmd = [lms_path, "load", model_name]
            if lms_gpu:
                cmd.extend(["--gpu", str(lms_gpu)])
            if lms_context:
                cmd.extend(["--context-length", str(lms_context)])
            
            import subprocess
            print(f"[lms_manager] Loading model via CLI: {' '.join(cmd)}", flush=True)
            res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False)
            if res.returncode == 0:
                _update_env_model_name(model_name)
                return True, f"Model {model_name} loaded successfully via CLI (GPU: {lms_gpu})."
            else:
                print(f"[lms_manager] CLI loading failed (code {res.returncode}): {res.stderr or res.stdout}. Falling back to REST API...", flush=True)

        payload = {"model": model_name}
        if lms_context:
            try:
                payload["context_length"] = int(lms_context)
            except ValueError:
                pass
        
        if lms_gpu:
            if lms_gpu == "max":
                payload["n_gpu_layers"] = -1
            else:
                try:
                    payload["n_gpu_layers"] = int(float(lms_gpu))
                except ValueError:
                    pass
            # Try to offload KV Cache if using GPU
            if lms_gpu != "off":
                payload["offload_kv_cache_to_gpu"] = True

        url = "http://localhost:1234/api/v1/models/load"
        resp = requests.post(url, json=payload, timeout=30.0)
        if resp.status_code == 200:
            _update_env_model_name(model_name)
            return True, f"Model {model_name} loaded successfully via API fallback (GPU settings: {lms_gpu})."
        else:
            err = resp.json().get("error", {}).get("message", resp.text)
            return False, f"Failed to load model: {err}"
    except Exception as e:
        return False, str(e)

def unload_local_model(model_name=None):
    """Unloads a loaded model or all models from VRAM via CLI or native REST API."""
    try:
        if check_lms_cli():
            lms_path = get_lms_path()
            if not model_name or model_name == "all":
                cmd = [lms_path, "unload", "--all"]
            else:
                cmd = [lms_path, "unload", model_name]
            import subprocess
            print(f"[lms_manager] Unloading model via CLI: {' '.join(cmd)}", flush=True)
            res = subprocess.run(cmd, capture_output=True, text=True, encoding='utf-8', errors='ignore', shell=False)
            if res.returncode == 0:
                return True, f"Model {model_name or 'all'} unloaded successfully via CLI."
            else:
                print(f"[lms_manager] CLI unloading failed (code {res.returncode}): {res.stderr or res.stdout}. Falling back to REST API...", flush=True)

        url = "http://localhost:1234/api/v1/models/unload"
        
        # If unloading all
        if not model_name or model_name == "all":
            models_url = "http://localhost:1234/api/v1/models"
            resp = requests.get(models_url, timeout=3.0)
            if resp.status_code == 200:
                unloaded_any = False
                for m in resp.json().get("models", []):
                    for instance in m.get("loaded_instances", []):
                        instance_id = instance.get("id")
                        if instance_id:
                            requests.post(url, json={"instance_id": instance_id}, timeout=10.0)
                            unloaded_any = True
                return True, "All models unloaded." if unloaded_any else "No active models loaded."
            return False, "Failed to fetch loaded models list."

        # Unload specific model key or instance
        models_url = "http://localhost:1234/api/v1/models"
        resp = requests.get(models_url, timeout=3.0)
        unloaded = False
        if resp.status_code == 200:
            for m in resp.json().get("models", []):
                if m.get("key", "").lower() == model_name.lower():
                    for instance in m.get("loaded_instances", []):
                        instance_id = instance.get("id")
                        if instance_id:
                            requests.post(url, json={"instance_id": instance_id}, timeout=10.0)
                            unloaded = True

        if unloaded:
            return True, f"Model {model_name} unloaded successfully."
            
        # Direct fallback call
        resp = requests.post(url, json={"instance_id": model_name}, timeout=10.0)
        if resp.status_code == 200:
            return True, f"Model {model_name} unloaded successfully."
        return False, f"Failed to unload model: {resp.text}"
    except Exception as e:
        return False, str(e)

def delete_local_model(model_key):
    """Deletes a GGUF model file and its empty parent directories from disk by matching the model key."""
    user_profile = os.environ.get("USERPROFILE")
    if not user_profile:
        return False, "User profile not found."
    
    models_dir = os.path.normpath(os.path.join(user_profile, ".lmstudio", "models"))
    if not os.path.exists(models_dir):
        return False, "Models directory does not exist."
        
    # First check exact direct file match
    target_path = os.path.normpath(os.path.join(models_dir, model_key))
    if not target_path.startswith(models_dir):
        return False, "Invalid model path."
        
    if not (os.path.exists(target_path) and os.path.isfile(target_path)):
        # Resolve via normalization matching
        resolved_path = None
        model_norm = re.sub(r'[^a-z0-9]', '', model_key.lower())
        for root, dirs, files in os.walk(models_dir):
            for file in files:
                if file.lower().endswith(".gguf"):
                    full_p = os.path.join(root, file)
                    rel_p = os.path.relpath(full_p, models_dir).replace("\\", "/")
                    if rel_p.lower() == model_key.lower():
                        resolved_path = full_p
                        break
                    file_norm = re.sub(r'[^a-z0-9]', '', rel_p.lower()).replace("gguf", "")
                    if model_norm in file_norm or file_norm in model_norm:
                        resolved_path = full_p
                        break
            if resolved_path:
                break
        if resolved_path:
            target_path = resolved_path
        else:
            return False, "Model file does not exist on disk."
            
    try:
        os.remove(target_path)
        # Clean up empty parent directories
        parent = os.path.dirname(target_path)
        while parent != models_dir:
            if not os.listdir(parent):
                os.rmdir(parent)
                parent = os.path.dirname(parent)
            else:
                break
        return True, "Model deleted successfully."
    except Exception as e:
        return False, f"Failed to delete model: {e}"
