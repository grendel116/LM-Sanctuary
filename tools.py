import os
import subprocess
import requests

import time
import uuid

from variables import COMFYUI_SERVER_URL, COMFYUI_CHECKPOINT, COMFYUI_VAE, DEFAULT_GEMINI_MODEL


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
def read_webpage(url: str) -> str:
    """Fetches and extracts the readable text content of a specific webpage URL.
    Use this when the user shares a URL/link in the chat and asks you to read, review, or analyze it.

    Args:
        url: The web address (HTTP/HTTPS URL) to fetch and read.

    Returns:
        The extracted clean text content of the webpage, or an error message.
    """
    import requests
    from bs4 import BeautifulSoup
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    if not url.startswith(("http://", "https://")):
        return "Error: Invalid URL. The URL must start with http:// or https://"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }

    try:
        response = requests.get(url, headers=headers, timeout=15, verify=False)
        if response.status_code != 200:
            return f"Error: Failed to fetch webpage. HTTP status code: {response.status_code}"

        encoding = response.encoding if response.encoding else 'utf-8'
        html_content = response.content.decode(encoding, errors='replace')

        soup = BeautifulSoup(html_content, 'html.parser')

        for element in soup(["script", "style", "nav", "header", "footer", "meta", "noscript", "svg", "iframe"]):
            element.decompose()

        text = soup.get_text(separator='\n')

        lines = (line.strip() for line in text.splitlines())
        chunks = (phrase.strip() for line in lines for phrase in line.split("  "))
        clean_text = '\n'.join(chunk for chunk in chunks if chunk)

        limit = 12000
        if len(clean_text) > limit:
            return clean_text[:limit] + f"\n\n... [Content truncated, total length: {len(clean_text)} characters] ..."

        if not clean_text.strip():
            return "Error: Webpage loaded, but no readable text content could be extracted."

        return clean_text

    except requests.exceptions.Timeout:
        return "Error: Connection timed out while attempting to load the webpage."
    except Exception as e:
        return f"Error loading webpage: {e}"


def web_search(query: str) -> str:
    """Searches the web and returns raw hits containing titles, links, and snippets.

    Args:
        query: The search query.

    Returns:
        A formatted string of matching pages with titles, URLs, and snippets.
    """
    import os
    import requests
    
    gemini_api_key = os.getenv("GEMINI_API_KEY")
    if gemini_api_key:
        try:
            from google import genai
            from google.genai import types
            
            client = genai.Client(api_key=gemini_api_key)
            grounding_tool = types.Tool(
                google_search=types.GoogleSearch()
            )
            config = types.GenerateContentConfig(
                tools=[grounding_tool],
                temperature=0.0
            )
            
            response = client.models.generate_content(
                model=DEFAULT_GEMINI_MODEL,
                contents=f"Perform a search for: {query}. Output only a list of search hits with their titles, URLs, and very brief snippets.",
                config=config
            )
            
            results = []
            metadata = response.candidates[0].grounding_metadata if (response.candidates and response.candidates[0]) else None
            if metadata and hasattr(metadata, 'grounding_chunks') and metadata.grounding_chunks:
                for chunk in metadata.grounding_chunks:
                    web = getattr(chunk, 'web', None)
                    if web and web.uri:
                        title = web.title or "Web Result"
                        results.append(f"Title: {title}\nURL: {web.uri}\nSnippet: {chunk.web.title if hasattr(chunk.web, 'title') else ''}")
            
            if results:
                return "\n\n".join(results[:6])
        except Exception as e:
            print(f"Google Search error: {e}")

    # Fallback to Wikipedia
    try:
        url = "https://en.wikipedia.org/w/api.php"
        headers = {
            "User-Agent": "ProgramSanctuary/1.0"
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
            hits = response.json().get("query", {}).get("search", [])
            results = []
            for hit in hits[:5]:
                title = hit.get("title")
                snippet = hit.get("snippet", "").replace('<span class="searchmatch">', '').replace('</span>', '')
                link = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"
                results.append(f"Title: {title}\nURL: {link}\nSnippet: {snippet}...")
            if results:
                return "\n\n".join(results)
    except Exception as e:
        return f"Error performing Wikipedia search: {e}"
        
    return "No search results found."


def google_search(query: str) -> str:
    """Wrapper that delegates search queries to web_search."""
    return web_search(query)

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


def apply_comfy_workflow(workflow_path: str, parameters: dict, save_path: str) -> str:
    """Executes a specified ComfyUI workflow JSON template with custom parameter mappings and saves the output.

    Args:
        workflow_path: Path to the workflow JSON file.
        parameters: Dictionary of placeholder keys and their replacement values.
        save_path: Path where the generated image should be saved.

    Returns:
        The filesystem path of the saved image, or an error message.
    """
    import os
    import json
    import requests
    import time

    if not os.path.exists(workflow_path):
        return f"Error: Workflow template not found at '{workflow_path}'"

    try:
        with open(workflow_path, "r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as e:
        return f"Error reading workflow template: {e}"

    # Recursive replacement helper
    def replace_placeholders(obj):
        if isinstance(obj, dict):
            res_dict = {}
            for k, v in obj.items():
                if k == "appearance":
                    continue
                res_dict[k] = replace_placeholders(v)
            return res_dict
        elif isinstance(obj, list):
            return [replace_placeholders(x) for x in obj]
        elif isinstance(obj, str):
            for placeholder, val in parameters.items():
                if placeholder in obj:
                    if obj == placeholder:
                        return val
                    obj = obj.replace(placeholder, str(val))
            return obj
        return obj

    populated_workflow = replace_placeholders(workflow)
    comfy_url = COMFYUI_SERVER_URL

    try:
        res = requests.post(f"{comfy_url}/prompt", json={"prompt": populated_workflow}, timeout=5.0)
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

        # Poll history endpoint for output
        for _ in range(120):
            history_res = requests.get(f"{comfy_url}/history/{prompt_id}", timeout=10)
            if history_res.status_code == 200:
                history_data = history_res.json()
                if prompt_id in history_data:
                    outputs = history_data[prompt_id].get("outputs", {})
                    for node_id, node_output in outputs.items():
                        if "images" in node_output:
                            for img in node_output["images"]:
                                filename = img["filename"]
                                view_res = requests.get(f"{comfy_url}/view", params={
                                    "filename": filename,
                                    "subfolder": img.get("subfolder", ""),
                                    "type": img.get("type", "temp")
                                }, timeout=15)
                                
                                if view_res.status_code == 200:
                                    parent_dir = os.path.dirname(save_path)
                                    if parent_dir:
                                        os.makedirs(parent_dir, exist_ok=True)
                                    with open(save_path, "wb") as img_file:
                                        img_file.write(view_res.content)
                                    return save_path
                                else:
                                    raise Exception(f"Error downloading image: status {view_res.status_code}")
            time.sleep(1)
        raise Exception("Image generation timed out on ComfyUI server after 120 seconds.")
    except Exception as e:
        return f"Error executing ComfyUI workflow: {e}"


def generate_local_image(prompt: str) -> str:
    """Generates a local image using ComfyUI with companion-specific workflow configurations.
    
    Args:
        prompt: A prompt describing what you are doing or the scene/expression.
        
    Returns:
        A markdown link to the generated portrait image, or an error message.
    """
    import os
    import random
    import time
    import json
    
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
            "To enable companion portrait generation, you can install, run, and resolve ComfyUI dependencies directly from the **Connection Settings** panel:\n\n"
            "- **Open Connection Settings**: Click the gear icon (⚙️) in the top header.\n"
            "- **Install ComfyUI**: If not already installed, click **Install Headless ComfyUI** under the Image Generation Environment section.\n"
            "- **Start the Server**: Click **Start ComfyUI Engine** to launch the server headlessly.\n"
            "- **Resolve Dependencies**: Click **Resolve Workflow Dependencies** to automatically download the required checkpoints, VAEs, and custom nodes.\n"
            "- **Request a Portrait**: Once the engine is online, ask the companion to generate a portrait!"
        )

    base_dir = os.path.dirname(os.path.abspath(__file__))
    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
    workflow_path = os.path.normpath(os.path.join(
        base_dir, "core", "programs", active_program, "portraits", "ImageWorkflow.json"
    ))
    
    if not os.path.exists(workflow_path):
        return get_install_instructions(f"Workflow template not found at '{workflow_path}'")

    comfy_url = COMFYUI_SERVER_URL

    try:
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

        # Load appearance from the active program's markdown context (## IDENTITY & FORM)
        appearance_val = ""
        program_md_path = os.path.normpath(os.path.join(
            base_dir, "core", "programs", active_program, f"{active_program.upper()}.md"
        ))
        if os.path.exists(program_md_path):
            try:
                with open(program_md_path, "r", encoding="utf-8") as f:
                    content = f.read()
                import re
                match = re.search(r'## IDENTITY & FORM\s*\n+([^\n#]+)', content)
                if match:
                    appearance_val = match.group(1).strip()
            except Exception as e:
                print(f"[DEBUG] Error reading identity for appearance: {e}", flush=True)

        if not appearance_val:
            appearance_val = f"character named {active_program}"

        # Define dynamic replacement parameters
        seed_val = random.randint(1, 1125899906842624)
        replacements = {
            "%prompt%": f"{prompt}",
            "%appearance%": appearance_val,
            "%negative_prompt%": "worst quality, low quality, deformed, mutated, extra limbs",
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

        timestamp = int(time.time())
        local_filename = f"portrait_{timestamp}.png"
        portraits_dir = os.path.normpath(os.path.join(base_dir, "core", "programs", active_program, "portraits"))
        local_path = os.path.join(portraits_dir, local_filename)

        result_path = apply_comfy_workflow(workflow_path, replacements, local_path)
        if result_path.startswith("Error"):
            raise Exception(result_path)

        # Save sidecar JSON
        json_path = os.path.join(portraits_dir, f"portrait_{timestamp}.json")
        try:
            with open(json_path, "w", encoding="utf-8") as jf:
                json.dump({"prompt": prompt}, jf, indent=4)
        except Exception as je:
            print(f"Error saving sidecar json: {je}")

        return f"![Portrait](/images/portraits/{local_filename})"
    except Exception as e:
        print(f"[INFO] ComfyUI generation failed or is offline: {e}.")
        return get_install_instructions(str(e))


def generate_imagen(prompt: str, aspect_ratio: str = '1:1') -> str:
    """Generates a cloud image based on the prompt using Google's Imagen model.

    Args:
        prompt: A descriptive prompt detailing the scene or object.
        aspect_ratio: Aspect ratio for the image (default '1:1').

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
                aspect_ratio=aspect_ratio
            )
        )

        if not response.generated_images:
            return "Error: No images were generated."

        img_obj = response.generated_images[0]
        if not hasattr(img_obj.image, 'image_bytes'):
            return "Error: Generated image object does not contain image bytes."

        active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
        media_dir = os.path.normpath(os.path.join(base_dir, "core", "programs", active_program, "media"))
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


def search_github(query: str) -> str:
    """Searches GitHub for repositories matching the query.

    Args:
        query: The search term.

    Returns:
        A formatted markdown list of matching repositories.
    """
    try:
        url = "https://api.github.com/search/repositories"
        params = {
            "q": query,
            "sort": "stars",
            "order": "desc",
            "per_page": 5
        }
        headers = {
            "Accept": "application/vnd.github.v3+json",
            "User-Agent": "ProgramSanctuary/1.0"
        }
        res = requests.get(url, params=params, headers=headers, timeout=5)
        if res.status_code == 200:
            items = res.json().get("items", [])
            sec = []
            for repo in items:
                name = repo.get("full_name", "")
                stars = repo.get("stargazers_count", 0)
                forks = repo.get("forks_count", 0)
                desc = repo.get("description", "") or "No description."
                link = repo.get("html_url", "")
                sec.append(f"- [{name}]({link}) (stars: {stars}, forks: {forks})\n  - Description: {desc}")
            if sec:
                return "\n".join(sec)
        return "No repositories found."
    except Exception as e:
        return f"Error searching GitHub: {e}"


def search_arxiv(query: str) -> str:
    """Searches arXiv for technical research papers matching the query.

    Args:
        query: The search term.

    Returns:
        A formatted markdown list of matching papers.
    """
    import re
    import xml.etree.ElementTree as ET
    try:
        search_words = re.findall(r'\w+', query)
        if not search_words:
            return "Invalid search query."
        
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
            ns = {'atom': 'http://www.w3.org/2005/Atom'}
            root = ET.fromstring(res.text)
            entries = root.findall('atom:entry', ns)
            sec = []
            for entry in entries:
                title = entry.find('atom:title', ns).text.strip().replace("\n", " ")
                published = entry.find('atom:published', ns).text[:10]
                summary = entry.find('atom:summary', ns).text.strip().replace("\n", " ")
                if len(summary) > 250:
                    summary = summary[:247] + "..."
                link = entry.find('atom:id', ns).text
                sec.append(f"- [{title}]({link}) (Published: {published})\n  - Summary: {summary}")
            if sec:
                return "\n".join(sec)
        return "No papers found."
    except Exception as e:
        return f"Error searching arXiv: {e}"


def search_hacker_news(query: str) -> str:
    """Searches Hacker News for recent stories matching the query.

    Args:
        query: The search term.

    Returns:
        A formatted markdown list of matching Hacker News stories.
    """
    try:
        thirty_days_ago = int(time.time()) - (30 * 24 * 60 * 60)
        url = "https://hn.algolia.com/api/v1/search"
        params = {
            "query": query,
            "tags": "story",
            "numericFilters": f"created_at_i>{thirty_days_ago}"
        }
        res = requests.get(url, params=params, timeout=5)
        if res.status_code == 200:
            hits = res.json().get("hits", [])
            sec = []
            for hit in hits[:5]:
                title = hit.get("title", "")
                link = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
                points = hit.get("points", 0)
                comments = hit.get("num_comments", 0)
                sec.append(f"- [{title}]({link}) ({points} points, {comments} comments)")
            if sec:
                return "\n".join(sec)
        return "No recent Hacker News stories found."
    except Exception as e:
        return f"Error searching Hacker News: {e}"



