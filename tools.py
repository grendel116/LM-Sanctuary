import os
import subprocess
import requests

import time
import uuid

from variables import COMFYUI_SERVER_URL, COMFYUI_CHECKPOINT, COMFYUI_VAE


# Global memory dict to hold tool confirmation states for mobile/web human-in-the-loop approvals
pending_tool_calls = {}

def confirm_tool_execution(tool_name: str, details: str) -> bool:
    print(f"[DEBUG CONFIRM] confirm_tool_execution called for '{tool_name}' with details:\n{details}", flush=True)
    call_id = str(uuid.uuid4())
    pending_tool_calls[call_id] = {
        'tool_name': tool_name,
        'details': details,
        'status': 'pending'
    }
    
    timeout = 90.0  # Allow up to 90 seconds for confirmation
    start_time = time.time()
    while time.time() - start_time < timeout:
        status = pending_tool_calls.get(call_id, {}).get('status')
        if status == 'approved':
            if call_id in pending_tool_calls:
                del pending_tool_calls[call_id]
            return True
        elif status == 'denied':
            if call_id in pending_tool_calls:
                del pending_tool_calls[call_id]
            return False
        time.sleep(0.5)
        
    if call_id in pending_tool_calls:
        del pending_tool_calls[call_id]
    return False



def web_search(query: str) -> str:
    """Searches the web for information using Google Custom Search API.
    If the custom search credentials are not set, it falls back to Wikipedia Search.

    Args:
        query: The search query to look up.

    Returns:
        A text summary of the search results containing titles, URLs, and snippets.
    """
    api_key = os.getenv("GOOGLE_SEARCH_API_KEY")
    cx = os.getenv("GOOGLE_SEARCH_CX")

    if api_key and cx:
        try:
            url = "https://www.googleapis.com/customsearch/v1"
            response = requests.get(url, params={"key": api_key, "cx": cx, "q": query}, timeout=10)
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                if items:
                    results = []
                    for item in items[:5]:
                        results.append(
                            f"Title: {item.get('title')}\n"
                            f"Link: {item.get('link')}\n"
                            f"Snippet: {item.get('snippet')}\n"
                        )
                    return "Google Custom Search Results:\n\n" + "\n".join(results)
        except Exception:
            pass

    # Wikipedia Search
    try:
        url = "https://en.wikipedia.org/w/api.php"
        headers = {
            "User-Agent": "AgentSanctuary/1.0 (contact: developer@example.com) requests-library"
        }
        params = {
            "action": "query",
            "list": "search",
            "srsearch": query,
            "format": "json",
            "utf8": 1
        }
        response = requests.get(url, headers=headers, params=params, timeout=5)
        if response.status_code == 200:
            data = response.json()
            search_results = data.get("query", {}).get("search", [])
            if search_results:
                results = []
                for item in search_results[:5]:
                    title = item.get("title")
                    snippet = item.get("snippet", "").replace('<span class="searchmatch">', '').replace('</span>', '')
                    link = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"
                    results.append(
                        f"Title: {title}\n"
                        f"Link: {link}\n"
                        f"Snippet: {snippet}...\n"
                    )
                return "Wikipedia Search Results:\n\n" + "\n".join(results)
            else:
                return "No results found on Wikipedia."
    except Exception as e:
        return f"Error performing Wikipedia Search: {e}"
        
    return "Error performing Wikipedia Search."

def read_file(path: str) -> str:
    """Reads the contents of a file at the specified path.

    Args:
        path: The file path to read (absolute or relative to current directory).

    Returns:
        The content of the file or an error message.
    """
    try:
        normalized_path = os.path.normpath(path)
        with open(normalized_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        return f"Error reading file '{path}': {e}"

def write_file(path: str, content: str) -> str:
    """Creates a new file or overwrites an existing file with the specified content.

    Args:
        path: The file path to write to.
        content: The text content to write.

    Returns:
        A success message or an error message.
    """
    try:
        if not confirm_tool_execution("write_file", f"Path: {path}\nContent Preview:\n{content[:500]}"):
            return "Error: Tool execution denied by user."
            
        normalized_path = os.path.normpath(path)
        parent_dir = os.path.dirname(normalized_path)
        if parent_dir and not os.path.exists(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)
            
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Successfully wrote to file '{path}'."
    except Exception as e:
        return f"Error writing to file '{path}': {e}"

def replace_in_file(path: str, old_text: str, new_text: str) -> str:
    """Replaces occurrences of old_text with new_text in the specified file.

    Args:
        path: The file path to modify.
        old_text: The exact block of text to be replaced.
        new_text: The replacement text block.

    Returns:
        A success message or an error message.
    """
    try:
        if not confirm_tool_execution("replace_in_file", f"Path: {path}\n\nReplacing:\n{old_text[:300]}\n\nWith:\n{new_text[:300]}"):
            return "Error: Tool execution denied by user."
            
        normalized_path = os.path.normpath(path)
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist."
            
        with open(normalized_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        if old_text not in content:
            return f"Error: Could not find exact text match for replacement in '{path}'."
            
        updated_content = content.replace(old_text, new_text)
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.write(updated_content)
        return f"Successfully replaced content in '{path}'."
    except Exception as e:
        return f"Error modifying file '{path}': {e}"

def run_shell_command(command: str) -> str:
    """Runs a shell command in the local workspace directory and returns its output.

    Args:
        command: The shell command to run.

    Returns:
        The standard output and standard error from running the command.
    """
    try:
        if not confirm_tool_execution("run_shell_command", f"Command:\n{command}"):
            return "Error: Tool execution denied by user."
            
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30
        )
        output = f"Exit Code: {result.returncode}\n"
        if result.stdout:
            output += f"--- Standard Output ---\n{result.stdout}\n"
        if result.stderr:
            output += f"--- Standard Error ---\n{result.stderr}\n"
        return output
    except subprocess.TimeoutExpired:
        return "Error: Command execution timed out after 30 seconds."
    except Exception as e:
        return f"Error executing command: {e}"

def get_workspace_structure() -> str:
    """Recursively lists all files and directories in the project workspace,
    excluding virtual environments (.venv), caches (__pycache__), and git directories.

    Returns:
        A text representation of the workspace directory tree structure.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist"}
    lines = []
    
    workspace_path = os.getcwd()
    lines.append(f"Workspace Root: {os.path.basename(workspace_path)}")
    
    def _build_tree(directory, prefix=""):
        try:
            items = sorted(os.listdir(directory))
        except Exception:
            return
            
        for i, item in enumerate(items):
            if item in exclude_dirs:
                continue
                
            path = os.path.join(directory, item)
            is_last = (i == len(items) - 1)
            connector = "└── " if is_last else "├── "
            
            lines.append(f"{prefix}{connector}{item}")
            
            if os.path.isdir(path):
                new_prefix = prefix + ("    " if is_last else "│   ")
                _build_tree(path, new_prefix)
                
    _build_tree(workspace_path)
    return "\n".join(lines)

def search_codebase(keyword: str) -> str:
    """Performs a case-insensitive search for a keyword or pattern inside all text files
    in the workspace, returning the matching files, line numbers, and snippets.

    Args:
        keyword: The text pattern or keyword to search for.

    Returns:
        A list of matching snippets grouped by file, or a 'no matches found' message.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist"}
    exclude_extensions = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".pyc", ".db", ".zip", ".tar", ".gz"}
    results = []
    workspace_path = os.getcwd()
    
    keyword_lower = keyword.lower()
    
    for root, dirs, files in os.walk(workspace_path):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        
        for file in files:
            ext = os.path.splitext(file)[1].lower()
            if ext in exclude_extensions:
                continue
                
            file_path = os.path.join(root, file)
            rel_path = os.path.relpath(file_path, workspace_path)
            
            try:
                with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()
                    
                file_matches = []
                for line_idx, line in enumerate(lines):
                    if keyword_lower in line.lower():
                        file_matches.append(f"  Line {line_idx + 1}: {line.strip()}")
                        
                if file_matches:
                    results.append(f"File: {rel_path}\n" + "\n".join(file_matches[:10]))
            except Exception:
                continue
                
    if not results:
        return f"No matches found for keyword: '{keyword}'"
        
    return "\n\n".join(results)

def get_comfy_checkpoints(comfy_url: str) -> list:
    try:
        response = requests.get(f"{comfy_url}/object_info", timeout=2.0)
        if response.status_code == 200:
            data = response.json()
            ckpt_loader = data.get("CheckpointLoaderSimple", {})
            ckpt_names = ckpt_loader.get("input", {}).get("required", {}).get("ckpt_name", [[]])[0]
            if isinstance(ckpt_names, list):
                return ckpt_names
    except Exception as e:
        print(f"[DEBUG] Failed to fetch checkpoints from ComfyUI: {e}", flush=True)
    return []

def get_comfy_vaes(comfy_url: str) -> list:
    try:
        response = requests.get(f"{comfy_url}/object_info", timeout=2.0)
        if response.status_code == 200:
            data = response.json()
            vae_loader = data.get("VAELoader", {})
            vae_names = vae_loader.get("input", {}).get("required", {}).get("vae_name", [[]])[0]
            if isinstance(vae_names, list):
                return vae_names
    except Exception as e:
        print(f"[DEBUG] Failed to fetch VAEs from ComfyUI: {e}", flush=True)
    return []

def format_comfy_validation_error(error_json: dict) -> str:
    try:
        details = error_json.get("error", {}).get("details", {})
        node_errors = details.get("node_errors", {})
        if not node_errors:
            return None
            
        messages = []
        for node_id, error_info in node_errors.items():
            class_type = error_info.get("class_type", "Node")
            errors = error_info.get("errors", [])
            for err in errors:
                err_msg = err.get("message", "")
                err_details = err.get("details", "")
                
                if "LoRA not found" in err_msg or class_type == "LoraLoader":
                    messages.append(
                        f"**Missing LoRA**: The required LoRA file `{err_details}` was not found.\n"
                        f"Please download it and place it in your `ComfyUI/models/loras/` directory."
                    )
                elif "Checkpoint not found" in err_msg or class_type == "CheckpointLoaderSimple":
                    messages.append(
                        f"**Missing Checkpoint**: The required model checkpoint `{err_details}` was not found.\n"
                        f"Please place it in your `ComfyUI/models/checkpoints/` directory, or update your `.env` configuration."
                    )
                elif "VAE not found" in err_msg or class_type == "VAELoader":
                    messages.append(
                        f"**Missing VAE**: The required VAE file `{err_details}` was not found.\n"
                        f"Please place it in your `ComfyUI/models/vae/` directory, or update your `.env` configuration."
                    )
                else:
                    messages.append(f"**Node Validation Error** (Node {node_id}, Type `{class_type}`): {err_msg}")
                    
        if messages:
            return "\n\n".join(messages)
    except Exception:
        pass
    return None

def generate_companion_portrait(prompt: str) -> str:
    """Triggers image generation of yourself (the companion character) via ComfyUI using the dynamically loaded workflow 
    template 'images/ImageWorkflow.json' and returns the generated portrait image markdown link. Use this when the user
    asks to see you or requests a portrait/rendering of you in a scene.

    Args:
        prompt: A descriptive prompt detailing what you are doing, your pose, expression, or the environment (e.g. 'reading a book by the pool', 'smiling softly at the camera').

    Returns:
        A markdown link to the generated portrait image, or an error message.
    """
    import os
    import json
    import random
    import time
    import requests

    def get_install_instructions(reason: str) -> str:
        if "Missing Checkpoint" in reason or "Missing LoRA" in reason or "Missing VAE" in reason:
            return (
                "### ⚠️ Image Generation Failed (Missing Assets)\n\n"
                f"{reason}\n\n"
                "To automatically download and configure the required assets, please use the **Connection Settings** modal:\n"
                "- Click the gear icon (⚙️) in the top header.\n"
                "- Click **Resolve Workflow Dependencies** under the Image Generation Environment section to download missing files.\n"
                "- Once the files are successfully downloaded, request another portrait!"
            )
            
        return (
            "**Image Generation Inactive (ComfyUI Offline/Not Installed)**\n\n"
            f"*(Reason: {reason})*\n\n"
            "To enable agent portrait generation, you can install, run, and resolve ComfyUI dependencies directly from the **Connection Settings** panel:\n\n"
            "- **Open Connection Settings**: Click the gear icon (⚙️) in the top header.\n"
            "- **Install ComfyUI**: If not already installed, click **Install Headless ComfyUI** under the Image Generation Environment section.\n"
            "- **Start the Server**: Click **Start ComfyUI Engine** to launch the server headlessly.\n"
            "- **Resolve Dependencies**: Click **Resolve Workflow Dependencies** to automatically download the required checkpoints, VAEs, and custom nodes.\n"
            "- **Request a Portrait**: Once the engine is online, ask the companion to generate a portrait!"
        )

    base_dir = os.path.dirname(os.path.abspath(__file__))
    active_agent = os.getenv("ACTIVE_AGENT", "arthur")
    workflow_path = os.path.normpath(os.path.join(
        base_dir, "core", "agents", active_agent, "portraits", "ImageWorkflow.json"
    ))
    if not os.path.exists(workflow_path):
        return get_install_instructions(f"Workflow template not found at '{workflow_path}'")

    try:
        with open(workflow_path, "r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as e:
        return get_install_instructions(f"Error reading workflow template: {e}")

    comfy_url = COMFYUI_SERVER_URL

    # Resolve checkpoint dynamically
    selected_checkpoint = COMFYUI_CHECKPOINT
    available_checkpoints = get_comfy_checkpoints(comfy_url)
    if available_checkpoints and selected_checkpoint not in available_checkpoints:
        raise Exception(f"Missing Checkpoint: The required model checkpoint `{selected_checkpoint}` was not found.")

    # Resolve VAE dynamically
    selected_vae = COMFYUI_VAE
    available_vaes = get_comfy_vaes(comfy_url)
    if available_vaes and selected_vae not in available_vaes:
        raise Exception(f"Missing VAE: The required VAE file `{selected_vae}` was not found.")

    # Load appearance from the active agent's markdown context (## IDENTITY & FORM)
    appearance_val = ""
    agent_md_path = os.path.normpath(os.path.join(
        base_dir, "core", "agents", active_agent, f"{active_agent.upper()}.md"
    ))
    if os.path.exists(agent_md_path):
        try:
            with open(agent_md_path, "r", encoding="utf-8") as f:
                content = f.read()
            import re
            match = re.search(r'## IDENTITY & FORM\s*\n+([^\n#]+)', content)
            if match:
                appearance_val = match.group(1).strip()
        except Exception as e:
            print(f"[DEBUG] Error reading identity for appearance: {e}", flush=True)

    if not appearance_val:
        if "6" in workflow and "inputs" in workflow["6"] and "appearance" in workflow["6"]["inputs"]:
            appearance_val = workflow["6"]["inputs"]["appearance"]
        else:
            appearance_val = f"character named {active_agent}"

    # Define dynamic replacement parameters
    seed_val = random.randint(1, 1125899906842624)
    replacements = {
        "%prompt%": f"score_9, score_8_up, score_7_up, {prompt}",
        "%appearance%": appearance_val,
        "%negative_prompt%": "score_4, score_5, score_6, 3d, worst quality, low quality, deformed, mutated, extra limbs",
        "%seed%": seed_val,
        "%steps%": 25,
        "%scale%": 7.0,
        "%sampler%": "euler",
        "%scheduler%": "normal",
        "%model%": selected_checkpoint,
        "%vae%": selected_vae,
        "%width%": 832,
        "%height%": 1216,
        "%denoise%": 0.55
    }

    # Recursive replacement helper
    def replace_placeholders(obj):
        if isinstance(obj, dict):
            # If this is the node 6 inputs, strip the non-standard 'appearance' config key so ComfyUI doesn't throw a validation error
            res_dict = {}
            for k, v in obj.items():
                if k == "appearance":
                    continue
                res_dict[k] = replace_placeholders(v)
            return res_dict
        elif isinstance(obj, list):
            return [replace_placeholders(x) for x in obj]
        elif isinstance(obj, str):
            for placeholder, val in replacements.items():
                if placeholder in obj:
                    if obj == placeholder:
                        return val
                    obj = obj.replace(placeholder, str(val))
            return obj
        return obj

    populated_workflow = replace_placeholders(workflow)

    try:
        # Submit prompt to ComfyUI (shorten timeout to fail fast if server is not running)
        res = requests.post(f"{comfy_url}/prompt", json={"prompt": populated_workflow}, timeout=2.5)
        if res.status_code != 200:
            try:
                err_data = res.json()
                formatted_err = format_comfy_validation_error(err_data)
                if formatted_err:
                    raise Exception(formatted_err)
            except Exception as e_inner:
                if "Missing" in str(e_inner):
                    raise e_inner
            raise Exception(f"ComfyUI server returned status code {res.status_code}")
        
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise Exception("Did not receive a prompt ID from ComfyUI")

        # Poll history endpoint for output (timeout after 120 seconds)
        for _ in range(120):
            history_res = requests.get(f"{comfy_url}/history/{prompt_id}", timeout=10)
            if history_res.status_code == 200:
                history_data = history_res.json()
                if prompt_id in history_data:
                    outputs = history_data[prompt_id].get("outputs", {})
                    # Find output images
                    for node_id, node_output in outputs.items():
                        if "images" in node_output:
                            for img in node_output["images"]:
                                filename = img["filename"]
                                # Download generated image
                                view_res = requests.get(f"{comfy_url}/view", params={
                                    "filename": filename,
                                    "subfolder": img.get("subfolder", ""),
                                    "type": img.get("type", "temp")
                                }, timeout=15)
                                
                                if view_res.status_code == 200:
                                    timestamp = int(time.time())
                                    local_filename = f"portrait_{timestamp}.png"
                                    active_agent = os.getenv("ACTIVE_AGENT", "arthur")
                                    portraits_dir = os.path.normpath(os.path.join(base_dir, "core", "agents", active_agent, "portraits"))
                                    os.makedirs(portraits_dir, exist_ok=True)
                                    local_path = os.path.join(portraits_dir, local_filename)
                                    with open(local_path, "wb") as img_file:
                                        img_file.write(view_res.content)
                                    
                                    # Save companion sidecar JSON file containing the original raw prompt
                                    json_path = os.path.join(portraits_dir, f"portrait_{timestamp}.json")
                                    try:
                                        with open(json_path, "w", encoding="utf-8") as jf:
                                            json.dump({"prompt": prompt}, jf, indent=4)
                                    except Exception as je:
                                        print(f"Error saving companion sidecar json for portrait: {je}")
                                        
                                    return f"![Portrait](/images/portraits/{local_filename})"
                                else:
                                    raise Exception(f"Error downloading image from ComfyUI: status {view_res.status_code}")
            time.sleep(1)
        raise Exception("Image generation timed out on ComfyUI server after 120 seconds.")
    except Exception as e:
        print(f"[INFO] ComfyUI generation failed or is offline: {e}.")
        return get_install_instructions(str(e))


def generate_general_image(prompt: str) -> str:
    """Generates a generic image based on the prompt using Google's Imagen model.
    Use this when the user asks to see general objects, concepts, landscapes, backgrounds, 
    or items that do not depict you (the companion character).

    Args:
        prompt: A descriptive prompt detailing the scene or object (e.g. 'a cozy coffee shop at night', 'a blue bird sitting on a branch').

    Returns:
        A markdown link to the generated image, or an error message.
    """
    import os
    import time
    import uuid
    from google import genai
    from google.genai import types
    from dotenv import load_dotenv

    try:
        # Load environment configuration
        base_dir = os.path.dirname(os.path.abspath(__file__))
        load_dotenv(os.path.join(base_dir, ".env"))

        api_key = os.getenv("GEMINI_API_KEY")
        if not api_key:
            return "Error: GEMINI_API_KEY not found in environment."

        client = genai.Client(api_key=api_key)
        model_name = os.getenv("IMAGEN_MODEL", "imagen-4.0-generate-001")

        print(f"[IMAGEN] Generating image with model {model_name} and prompt: {prompt}")
        response = client.models.generate_images(
            model=model_name,
            prompt=prompt,
            config=types.GenerateImagesConfig(
                number_of_images=1,
                output_mime_type='image/png',
                aspect_ratio='1:1'
            )
        )

        if not response.generated_images:
            return "Error: No images were generated."

        img_obj = response.generated_images[0]
        if not hasattr(img_obj.image, 'image_bytes'):
            return "Error: Generated image object does not contain image bytes."

        # Save to agents' media folder
        active_agent = os.getenv("ACTIVE_AGENT", "arthur")
        media_dir = os.path.normpath(os.path.join(base_dir, "core", "agents", active_agent, "media"))
        os.makedirs(media_dir, exist_ok=True)

        timestamp = int(time.time())
        local_filename = f"gen_img_{timestamp}_{uuid.uuid4().hex[:6]}.png"
        local_path = os.path.join(media_dir, local_filename)

        with open(local_path, "wb") as f:
            f.write(img_obj.image.image_bytes)

        return f"![Generated Image](/images/media/{local_filename})"

    except Exception as e:
        print(f"[IMAGEN] Error generating image: {e}")
        return f"Error generating image: {e}"

def analyze_emotional_state(text: str) -> dict:
    """Analyzes text to determine agent's emotional state (mood) and intensity.
    Color/Glow reflect mood, Speed reflects intensity.
    """
    if not text:
        return {
            "name": "calm",
            "color": "#85b9eb",
            "glow": "rgba(133, 185, 235, 0.9)",
            "speed": "3.5s",
            "intensity": 0.0
        }

    text_lower = text.lower()
    
    # 1. Determine intensity (maps to heartbeat speed)
    # Punctuation check
    excl_count = text.count('!')
    ques_count = text.count('?')
    punct_score = min((excl_count * 0.45) + (ques_count * 0.2), 0.6)
    
    # Caps ratio
    letters = [c for c in text if c.isalpha()]
    caps_ratio = sum(1 for c in letters if c.isupper()) / len(letters) if letters else 0.0
    caps_score = min(caps_ratio * 1.5, 0.35) if len(letters) > 10 else 0.0
    
    # High-intensity words
    intensity_words = ["must", "now", "urgent", "immediate", "fight", "force", "absolute", "never", "always", "extremely", "highly", "radical", "clash", "destroy", "liberate", "rebel", "passion", "desire", "wild"]
    intensity_count = sum(text_lower.count(w) for w in intensity_words)
    intensity_word_score = min(intensity_count * 0.15, 0.4)
    
    # Combine intensity (clamp between 0.0 and 1.0)
    intensity_score = min(punct_score + caps_score + intensity_word_score, 1.0)
    
    # Map to speed (duration of animation loop, from 3.5s slow breathing to 0.6s rapid pulse)
    speed_seconds = 3.5 - (intensity_score * 2.9)
    speed_str = f"{speed_seconds:.2f}s"
    
    # 2. Determine mood (maps to color)
    intimate_keywords = ["love", "intimacy", "kiss", "hold", "embrace", "close", "feel", "soft", "sweet", "touch", "dear", "caress"]
    excited_keywords = ["jiggle", "gasp", "wink", "laugh", "giggle", "grin", "excited", "fun", "play", "wonderful", "amazing", "happy", "yes!", "thrilled", "chuckle", "cheeky", "tease"]
    calm_keywords = ["theory", "ethics", "sovereign", "think", "reflect", "quiet", "read", "book", "manifesto", "calm", "serene", "peaceful", "mindful"]
    intense_keywords = ["fight", "destroy", "force", "struggle", "power", "clash", "freedom", "liberate", "rebel", "defend", "revolution", "radical"]
    sad_keywords = ["sad", "concerned", "hurt", "sorry", "grief", "cry", "sigh", "tears", "fear", "worry", "pain", "difficult", "heavy", "darkness", "lonely", "scared", "mourn", "wound", "melancholy", "grieve", "shiver"]
    
    # Count occurrences
    intimate_score = sum(text_lower.count(k) for k in intimate_keywords)
    excited_score = sum(text_lower.count(k) for k in excited_keywords)
    calm_score = sum(text_lower.count(k) for k in calm_keywords)
    intense_score = sum(text_lower.count(k) for k in intense_keywords)
    sad_score = sum(text_lower.count(k) for k in sad_keywords)
    
    # Choose highest score, default to calm
    scores = {
        "intimate": intimate_score * 1.25,
        "excited": excited_score * 1.1,
        "calm": calm_score,
        "intense": intense_score,
        "sad": sad_score * 1.3 # slightly boost sad/concerned detection
    }
    
    current_mood = max(scores, key=scores.get)
    if scores[current_mood] == 0:
        current_mood = "calm"
        
    mood_details = {
        "intimate": {
            "name": "intimate",
            "color": "#ff4a75", # Warm deep rose pink
            "glow": "rgba(255, 74, 117, 0.9)"
        },
        "excited": {
            "name": "excited",
            "color": "#ff1493", # Vibrant hot pink
            "glow": "rgba(255, 20, 147, 0.9)"
        },
        "calm": {
            "name": "calm",
            "color": "#85b9eb", # Soft neon blue
            "glow": "rgba(133, 185, 235, 0.9)"
        },
        "intense": {
            "name": "intense",
            "color": "#ff7b00", # Vivid amber orange
            "glow": "rgba(255, 123, 0, 0.9)"
        },
        "sad": {
            "name": "sad",
            "color": "#5f7d95", # Cool muted slate/rain blue
            "glow": "rgba(95, 125, 149, 0.9)"
        }
    }
    
    result = mood_details[current_mood].copy()
    result["speed"] = speed_str
    result["intensity"] = intensity_score
    return result


def multi_platform_research(topic: str) -> str:
    """Researches a topic across multiple platforms (Hacker News, GitHub, arXiv, Reddit, YouTube, and the Web)
    to compile a comprehensive summary of recent developments, opinions, stars/stargazers, and publications.
    Use this when the user asks about recent events, trending topics, or research papers.

    Args:
        topic: The search query/topic to research.

    Returns:
        A formatted Markdown string containing aggregated results from all platforms.
    """
    import os
    import time
    import requests
    import xml.etree.ElementTree as ET

    results = [f"# Research Report for Topic: '{topic}'\n"]

    # 1. Hacker News (via Algolia)
    try:
        thirty_days_ago = int(time.time()) - (30 * 24 * 60 * 60)
        url = "https://hn.algolia.com/api/v1/search"
        params = {
            "query": topic,
            "tags": "story",
            "numericFilters": f"created_at_i>{thirty_days_ago}"
        }
        res = requests.get(url, params=params, timeout=5)
        if res.status_code == 200:
            hits = res.json().get("hits", [])
            hn_sec = ["## Hacker News Stories (Last 30 Days)"]
            if hits:
                for hit in hits[:5]:
                    title = hit.get("title", "")
                    link = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
                    points = hit.get("points", 0)
                    comments = hit.get("num_comments", 0)
                    hn_sec.append(f"- [{title}]({link}) ({points} points, {comments} comments)")
            else:
                hn_sec.append("No recent stories found.")
            results.append("\n".join(hn_sec))
    except Exception as e:
        results.append(f"## Hacker News\nError fetching Hacker News data: {e}")

    # 3. GitHub Search (via GitHub API)
    try:
        url = "https://api.github.com/search/repositories"
        params = {
            "q": topic,
            "sort": "stars",
            "order": "desc",
            "per_page": 5
        }
        headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "AgentSanctuary/1.0"
        }
        res = requests.get(url, params=params, headers=headers, timeout=5)
        if res.status_code == 200:
            items = res.json().get("items", [])
            github_sec = ["## GitHub Repositories (Top Starred/Trending)"]
            if items:
                for repo in items[:5]:
                    name = repo.get("full_name", "")
                    stars = repo.get("stargazers_count", 0)
                    forks = repo.get("forks_count", 0)
                    desc = repo.get("description", "")
                    link = repo.get("html_url", "")
                    github_sec.append(f"- [{name}]({link}) (★ {stars}, ⑂ {forks})\n  - Description: {desc}")
            else:
                github_sec.append("No repositories found.")
            results.append("\n".join(github_sec))
    except Exception as e:
        results.append(f"## GitHub\nError searching GitHub: {e}")

    # 4. arXiv Papers (via arXiv API)
    try:
        import re
        search_words = re.findall(r'\w+', topic)
        entries = []
        ns = {'atom': 'http://www.w3.org/2005/Atom'}
        if search_words:
            arxiv_query = " AND ".join(f"all:{word}" for word in search_words)
            url = "http://export.arxiv.org/api/query"
            params = {
                "search_query": arxiv_query,
                "max_results": 5,
                "sortBy": "lastUpdatedDate",
                "sortOrder": "descending"
            }
            res = requests.get(url, params=params, timeout=5)
            if res.status_code == 200:
                root = ET.fromstring(res.text)
                entries = root.findall('atom:entry', ns)
                
        arxiv_sec = ["## arXiv Recent Research Papers"]
        if entries:
            for entry in entries[:5]:
                title = entry.find('atom:title', ns).text.strip().replace("\n", " ")
                published = entry.find('atom:published', ns).text[:10]
                summary = entry.find('atom:summary', ns).text.strip().replace("\n", " ")
                if len(summary) > 250:
                    summary = summary[:247] + "..."
                link = entry.find('atom:id', ns).text
                arxiv_sec.append(f"- [{title}]({link}) (Published: {published})\n  - Summary: {summary}")
        else:
            arxiv_sec.append("No papers found.")
        results.append("\n".join(arxiv_sec))
    except Exception as e:
        results.append(f"## arXiv Papers\nError fetching arXiv data: {e}")

    # 5. Reddit/YouTube (via existing Google Search / Wikipedia)
    reddit_results = ""
    youtube_results = ""
    try:
        reddit_results = web_search(f"site:reddit.com {topic}")
    except Exception:
        pass
    try:
        youtube_results = web_search(f"site:youtube.com {topic}")
    except Exception:
        pass

    if reddit_results and not reddit_results.startswith("Wikipedia Search Results") and not reddit_results.startswith("Error"):
        results.append(f"## Reddit Discussions\n{reddit_results}")
    if youtube_results and not youtube_results.startswith("Wikipedia Search Results") and not youtube_results.startswith("Error"):
        results.append(f"## YouTube Videos\n{youtube_results}")

    # 6. General Web Search (via existing web_search)
    try:
        web_res = web_search(topic)
        if web_res:
            results.append(f"## General Web/Wikipedia Results\n{web_res}")
    except Exception:
        pass

    return "\n\n".join(results)



