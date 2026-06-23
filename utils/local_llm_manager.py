import os
import requests
import re
import time
import threading
from utils import local_runner

import json

download_status = {}
_local_models_list_cached = None
_local_models_list_cache_time = 0.0


def get_server_path(): return "llama-server"
def check_installed(): return os.path.exists(local_runner.SERVER_EXE)
def install_server():
    success = local_runner.download_llama_server()
    if success:
        return True, "llama-server successfully installed."
    return False, "Failed to download llama-server."
def check_status(force_refresh=False): return local_runner.check_local_server_status()
def start_server():
    model_name = os.getenv("LOCAL_MODEL_NAME", "")
    if not local_runner.resolve_model_path(model_name):
        downloaded = list_local_models()
        if downloaded:
            model_name = downloaded[0]
            try:
                env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
                if os.path.exists(env_path):
                    with open(env_path, 'r', encoding='utf-8') as f: lines = f.readlines()
                    updated = False
                    for i, line in enumerate(lines):
                        if line.strip().startswith('LOCAL_MODEL_NAME='):
                            lines[i] = f"LOCAL_MODEL_NAME={model_name}\n"
                            updated = True
                            break
                    if not updated: lines.append(f"\nLOCAL_MODEL_NAME={model_name}\n")
                    with open(env_path, 'w', encoding='utf-8') as f: f.writelines(lines)
                os.environ["LOCAL_MODEL_NAME"] = model_name
            except Exception: pass
    return local_runner.start_local_server(model_name)
def stop_server():
    return local_runner.stop_local_server()

def extract_quantization_tag(filename):
    tags = ["IQ1_M", "IQ1_S", "IQ2_XXS", "IQ2_XS", "IQ2_S", "IQ2_M", "Q2_K_S", "Q2_K", "IQ3_XXS", "IQ3_XS", "Q3_K_S", "IQ3_S", "IQ3_M", "Q3_K_M", "Q3_K_L", "IQ4_XS", "IQ4_NL", "Q4_0", "Q4_1", "Q4_K_M", "Q4_K_S", "Q5_0", "Q5_1", "Q5_K_M", "Q5_K_S", "Q6_K", "Q8_0", "F16", "BF16", "FP16"]
    filename_upper = filename.upper()
    for tag in tags:
        if re.search(rf"\b{tag}\b|[\.\-_]{tag}[\.\-_]|[\.\-_]{tag}$", filename_upper): return tag
    match = re.search(r'[qQ][iI]?[0-9]_[A-Za-z0-9_]+', filename)
    return match.group(0).upper() if match else None

def search_huggingface_repos(query):
    results = []
    query = query.strip()
    if not query: return results
    cleaned_query = query
    if ".gguf" in cleaned_query.lower():
        cleaned_query = re.sub(r'[\.\-_](?:i\d+[\.\-_]?)?[qQ]\d+[a-zA-Z0-9_]*', '', cleaned_query.split(".gguf")[0]).strip()
    if "huggingface.co/" in cleaned_query:
        parts = cleaned_query.split("huggingface.co/")[1].split("/")
        if len(parts) >= 2: cleaned_query = f"{parts[0]}/{parts[1]}"
        
    try:
        url = f"https://huggingface.co/api/models?search={cleaned_query}&filter=gguf&sort=likes&direction=-1&limit=20"
        resp = requests.get(url, headers={"User-Agent": "LM-Sanctuary-Client/1.0"}, timeout=5.0).json()
        for item in resp:
            model_id = item.get("id")
            results.append({
                "id": model_id,
                "likes": item.get("likes", 0),
                "downloads": item.get("downloads", 0),
                "author": model_id.split("/")[0] if "/" in model_id else "Unknown",
                "extracted_quant": None
            })
    except Exception as e:
        print(f"[search_huggingface_repos] Error: {e}")
    return results

def get_huggingface_repo_files(repo_id):
    files = []
    try:
        url = f"https://huggingface.co/api/models/{repo_id}/tree/main"
        resp = requests.get(url, headers={"User-Agent": "LM-Sanctuary-Client/1.0"}, timeout=5.0).json()
        for item in resp:
            if item.get("type") == "file" and item.get("path", "").lower().endswith(".gguf"):
                filename = item.get("path")
                files.append({
                    "filename": filename,
                    "size": item.get("size", 0),
                    "quantization": extract_quantization_tag(filename)
                })
    except Exception as e:
        print(f"[get_huggingface_repo_files] Error: {e}")
    return files

def trigger_download(model_name, quantization=None):
    repo_id = model_name
    filename = quantization
    tracking_name = f"{repo_id}@{filename}"
    
    base_models_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")
    dest_dir = os.path.join(base_models_dir, repo_id)
    os.makedirs(dest_dir, exist_ok=True)
    dest_path = os.path.join(dest_dir, filename)
    
    download_url = f"https://huggingface.co/{repo_id}/resolve/main/{filename}"
    
    def download_thread():
        try:
            download_status[tracking_name] = {
                "status": "downloading", "downloaded_bytes": 0, "total_size_bytes": 0, "bytes_per_second": 0, "error": None
            }
            with requests.get(download_url, stream=True, timeout=15.0) as r:
                r.raise_for_status()
                total_size = int(r.headers.get('content-length', 0))
                download_status[tracking_name]["total_size_bytes"] = total_size
                
                downloaded = 0
                start_time = time.time()
                with open(dest_path, 'wb') as f:
                    for chunk in r.iter_content(chunk_size=1024*1024):
                        if not chunk: continue
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        elapsed = time.time() - start_time
                        speed = downloaded / elapsed if elapsed > 0 else 0
                        download_status[tracking_name].update({
                            "downloaded_bytes": downloaded,
                            "bytes_per_second": speed,
                            "estimated_completion": max(0, (total_size - downloaded) / speed) if speed > 0 else 0
                        })
            download_status[tracking_name]["status"] = "completed"
        except Exception as e:
            download_status[tracking_name].update({"status": "failed", "error": str(e)})
            
    threading.Thread(target=download_thread, daemon=True).start()
    return True, "Download started."

def update_download_statuses(): pass

def scan_gguf_files(base_dir):
    models = []
    try:
        for root, _, files in os.walk(base_dir):
            for file in files:
                if file.lower().endswith(".gguf"):
                    rel_path = os.path.relpath(os.path.join(root, file), base_dir)
                    models.append(rel_path.replace("\\", "/"))
    except Exception: pass
    return models

def list_local_models(force_refresh=False):
    global _local_models_list_cached, _local_models_list_cache_time
    now = time.time()
    if not force_refresh and _local_models_list_cached is not None and (now - _local_models_list_cache_time < 5.0):
        return _local_models_list_cached
        
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    base_models_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")
    lm_studio_models_dir = os.path.join(user_profile, ".lmstudio", "models")
    
    models = []
    if os.path.exists(base_models_dir):
        models.extend(scan_gguf_files(base_models_dir))
    if os.path.exists(lm_studio_models_dir):
        models.extend(scan_gguf_files(lm_studio_models_dir))
        
    _local_models_list_cached = sorted(list(set(models)))
    _local_models_list_cache_time = now
    return _local_models_list_cached

def load_local_model(model_name):
    success, msg = local_runner.start_local_server(model_name)
    if success:
        try:
            env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
            if os.path.exists(env_path):
                with open(env_path, 'r', encoding='utf-8') as f: lines = f.readlines()
                updated = False
                for i, line in enumerate(lines):
                    if line.strip().startswith('LOCAL_MODEL_NAME='):
                        lines[i] = f"LOCAL_MODEL_NAME={model_name}\n"
                        updated = True
                        break
                if not updated: lines.append(f"\nLOCAL_MODEL_NAME={model_name}\n")
                with open(env_path, 'w', encoding='utf-8') as f: f.writelines(lines)
            os.environ["LOCAL_MODEL_NAME"] = model_name
        except Exception: pass
    return success, msg

def unload_local_model(model_name=None):
    return local_runner.stop_local_server()

def delete_local_model(model_key):
    target_path = local_runner.resolve_model_path(model_key)
    if not target_path or not os.path.exists(target_path):
        return False, "Model file does not exist."
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    base_models_dir = os.path.normpath(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models"))
    lm_studio_models_dir = os.path.normpath(os.path.join(user_profile, ".lmstudio", "models"))
    if not (target_path.startswith(base_models_dir) or target_path.startswith(lm_studio_models_dir)):
        return False, "Access denied."
    try:
        os.remove(target_path)
        parent = os.path.dirname(target_path)
        while parent not in (base_models_dir, lm_studio_models_dir) and os.path.exists(parent):
            if not os.listdir(parent):
                os.rmdir(parent)
                parent = os.path.dirname(parent)
            else: break
        return True, "Deleted successfully."
    except Exception as e:
        return False, str(e)
