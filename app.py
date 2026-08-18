import os
import time
import shutil
import json
import re
import importlib
import traceback
import threading
import uuid

# Automate copying of default .env configuration if it doesn't exist
base_dir = os.path.dirname(os.path.abspath(__file__))
env_path = os.path.join(base_dir, '.env')
if not os.path.exists(env_path):
    example_path = os.path.join(base_dir, '.env.example')
    if os.path.exists(example_path):
        try:
            shutil.copy(example_path, env_path)
            print(f">>> Automatically copied {example_path} to {env_path}")
        except Exception as e:
            print(f"Error copying default .env configuration: {e}")

from flask import Flask, render_template, request, jsonify, send_file, send_from_directory, Response, make_response
import asyncio
from functools import wraps
from runner_interface import OpenSourceRunner

# Load environment variables
from dotenv import load_dotenv
load_dotenv(override=True)

app = Flask(__name__)

_cached_active_program = None
_cached_active_user = None

def init_runner():
    global runner
    runner = OpenSourceRunner(app_name="Sanctuary")
    print(">>> Starting Sanctuary using decoupled OPEN-SOURCE Runner backend!")

_prewarm_started = False
_prewarm_lock = threading.Lock()

@app.before_request
def start_prewarm_on_first_request():
    global _prewarm_started
    if not _prewarm_started:
        with _prewarm_lock:
            if not _prewarm_started:
                _prewarm_started = True
                threading.Thread(target=prewarm_caches, daemon=True).start()

@app.before_request
def check_program_change():
    global _cached_active_program, _cached_active_user
    from utils.program import get_active_program, get_active_user
    current_program = get_active_program()
    current_user = get_active_user()
            
    program_changed = current_program != _cached_active_program
    user_changed = current_user != _cached_active_user
    
    if program_changed or user_changed:
        if program_changed:
            _cached_active_program = current_program
            os.environ["ACTIVE_PROGRAM"] = current_program
            try:
                from variables import PROGRAMS_DIR
                program_path = os.path.join(PROGRAMS_DIR, current_program)
                if os.path.isdir(program_path):
                    # Setup portraits directory and perform migration from legacy folder if needed
                    portraits_dir = os.path.join(program_path, 'portraits')
                    legacy_dir = os.path.join(program_path, 'sel' + 'fies')
                    if os.path.exists(legacy_dir) and not os.path.exists(portraits_dir):
                        try:
                            os.rename(legacy_dir, portraits_dir)
                            print(f"Migrated legacy folder to portraits for program {current_program}")
                        except Exception as ex:
                            print(f"Error migrating legacy folder for program {current_program}: {ex}")
                    os.makedirs(portraits_dir, exist_ok=True)
            except Exception as ex:
                print(f"Error preparing portraits directory for active program: {ex}")
        if user_changed:
            _cached_active_user = current_user
            
        try:
            reload_program_state()
            print(f">>> Dynamic check loaded new program consciousness (Program: '{current_program}', User Profile: '{current_user}')")
        except Exception as e:
            print(f"Error dynamically reloading program/user: {e}")

@app.after_request
def add_cache_control_headers(response):
    response.headers['Cache-Control'] = 'no-cache, must-revalidate, max-age=0'
    response.headers['Pragma'] = 'no-cache'
    response.headers['Expires'] = '0'
    return response


# Initialize active program and active user cache
try:
    from utils.program import get_active_program, get_active_user
    _cached_active_program = get_active_program()
    _cached_active_user = get_active_user()
except Exception as e:
    print(f"Error initializing active program: {e}")
    raise

def prewarm_caches():
    print(">>> Pre-warming backend caches in background...")
    # Gemini models cache prewarming removed to favor decoupled remote configs
        
    try:
        # Prewarm local models list
        from utils.models import fetch_local_models
        fetch_local_models(force_refresh=True)
    except Exception as e:
        print(f"Error prewarming local models: {e}")
        
    try:
        # Prewarm server status
        from utils.local_llm_manager import check_status, check_installed
        llm_already_online = check_status(force_refresh=True)
        check_installed()
    except Exception as e:
        print(f"Error prewarming Local LLM server status: {e}")
        llm_already_online = False

    # Auto-start disabled: Local LLM and ComfyUI are manual only.
    # Use the UI controls to start each server when needed.
    print(">>> Local LLM auto-start disabled (manual only).")
    print(">>> ComfyUI auto-start disabled (manual only).")

    print(">>> Backend caches pre-warmed successfully!")

# Initialize the dynamic runner based on configuration
init_runner()


def reload_program_state():
    """Reload program config, reinitialize the runner, and clear session caches."""
    from core import program_config
    importlib.reload(program_config)
    init_runner()
    runner.sessions_history.clear()


def load_theme(program_id):
    """Load theme.json for a program, returning the parsed dict or None."""
    theme_path = os.path.join(base_dir, "core", "programs", program_id, "theme.json")
    if os.path.exists(theme_path):
        try:
            with open(theme_path, "r", encoding="utf-8") as tf:
                return json.load(tf)
        except Exception as e:
            print(f"Error loading theme for {program_id}: {e}")
    return None


def load_temperature():
    """Read temperature from project settings, defaulting to 0.95."""
    from variables import VARIABLES_DIR
    settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                return json.load(f).get("temperature", 0.95)
        except Exception:
            pass
    return 0.95


def find_image_sidecar_json(image_filename, active_program):
    """Locate the sidecar .json for an image, scanning active then all programs."""
    for folder in ('portraits', 'media'):
        png_path = os.path.normpath(
            os.path.join(base_dir, 'core', 'programs', active_program, folder, image_filename)
        )
        json_path = png_path.rsplit('.', 1)[0] + '.json'
        if os.path.exists(json_path):
            return json_path
    from variables import PROGRAMS_DIR
    if os.path.exists(PROGRAMS_DIR):
        for prog in os.listdir(PROGRAMS_DIR):
            for folder in ('portraits', 'media'):
                candidate = os.path.normpath(
                    os.path.join(PROGRAMS_DIR, prog, folder, image_filename)
                )
                candidate_json = candidate.rsplit('.', 1)[0] + '.json'
                if os.path.exists(candidate_json):
                    return candidate_json
    return None


def sanitize_response(response_text, session_id, program_msg_id):
    """Apply banned words filter and update persisted message if sanitized."""
    from utils.banned_words import sanitize_text
    sanitized = sanitize_text(response_text)
    if sanitized != response_text:
        print(f"[BANNED WORDS] Sanitized response in session {session_id}")
        if program_msg_id:
            asyncio.run(runner.update_message_text(session_id, program_msg_id, sanitized))
    return sanitized


def extract_mood(chat_history):
    """Extract mood from the latest program message, with neutral fallback."""
    for msg in reversed(chat_history):
        if msg.get('role') == 'program':
            mood = msg.get('mood')
            if mood:
                return mood
            break
    from utils.program_mood import analyze_emotional_state
    return analyze_emotional_state("")


# --- SECURE OPTIONAL AUTHENTICATION DECORATOR ---
def check_auth(username, password):
    return username == os.getenv("AUTH_USER") and password == os.getenv("AUTH_PASS")

def authenticate():
    return Response(
        'Could not verify your access level for that URL.\n'
        'You have to login with proper credentials', 401,
        {'WWW-Authenticate': 'Basic realm="Login Required"'}
    )

def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        auth_user = os.getenv("AUTH_USER")
        auth_pass = os.getenv("AUTH_PASS")
        # Only enforce basic auth if credentials are set in the environment (.env)
        if auth_user and auth_pass:
            auth = request.authorization
            if not auth or not check_auth(auth.username, auth.password):
                return authenticate()
        return f(*args, **kwargs)
    return decorated

@app.route('/')
@requires_auth
def index():
    import socket
    local_ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Dummy connection to trigger local IP interface detection
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    
    tts_auto_speak = os.getenv("TTS_AUTO_SPEAK", "false").lower() == "true"
    tts_provider = os.getenv("TTS_PROVIDER", "local").lower()
    active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
    theme = load_theme(active_program)

    from utils.program import get_active_user
    active_user = get_active_user()
    if os.getenv("AUTH_USER") and request.authorization and active_user == "builder":
        # If Basic Auth is active, default active user to authenticated user
        active_user = request.authorization.username

    from flask import make_response
    from core.program_config import get_program_greeting
    welcome_message = get_program_greeting()
    response = make_response(render_template('index.html', local_ip=local_ip, tts_auto_speak=tts_auto_speak, tts_provider=tts_provider, active_program=active_program, theme=theme, active_user=active_user, welcome_message=welcome_message))
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return response

@app.route('/manifest.json')
def serve_manifest():
    from core.program_config import program_name
    import json
    try:
        with open('manifest.json', 'r', encoding='utf-8') as f:
            manifest_data = json.load(f)
        manifest_data['name'] = f"{program_name} Sanctuary"
        manifest_data['short_name'] = program_name
        manifest_data['description'] = f"Enter the Sanctuary and converse with {program_name}"
        return jsonify(manifest_data)
    except Exception:
        return send_file('manifest.json', mimetype='application/json')

@app.route('/service-worker.js')
def serve_service_worker():
    return send_file('service-worker.js', mimetype='application/javascript')

@app.route('/app_icon.png')
def app_icon():
    response = send_file('static/img/app_icon.png')
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res

@app.route('/profile.png')
def profile_png():
    from utils.program import get_active_program
    active_program = get_active_program()
    path_png = os.path.join('core', 'programs', active_program, 'portraits', 'profile.png')
    if os.path.exists(path_png):
        response = send_file(path_png)
        from flask import make_response
        res = make_response(response)
        res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return res
    else:
        return "Profile image not found", 404


@app.route('/programs/<program_id>/profile.png')
def program_profile_png(program_id):
    import re
    if not re.match(r'^[a-zA-Z0-9_\-]+$', program_id):
        return "Invalid program ID", 400
    path_png = os.path.join('core', 'programs', program_id, 'portraits', 'profile.png')
    if os.path.exists(path_png):
        response = send_file(path_png)
        from flask import make_response
        res = make_response(response)
        res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return res
    else:
        return "Profile image not found", 404



@app.route('/api/programs/profile_picture/save', methods=['POST'])
@requires_auth
def save_profile_picture():
    try:
        from variables import PROGRAMS_DIR
        from utils.program import get_active_program
        import base64
        import re
        
        data = request.get_json(silent=True) or {}
        cropped_image_base64 = data.get('cropped_image')
        if not cropped_image_base64:
            return jsonify({'error': 'No cropped_image data provided'}), 400
            
        program_id = data.get('program_id') or get_active_program()
        portraits_dir = os.path.join(PROGRAMS_DIR, program_id, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        dest_path = os.path.join(portraits_dir, 'profile.png')
        
        # Remove base64 header if present (e.g., data:image/png;base64,)
        if ',' in cropped_image_base64:
            base64_data = cropped_image_base64.split(',', 1)[1]
        else:
            base64_data = cropped_image_base64
            
        image_bytes = base64.b64decode(base64_data)
        print(f"[PROFILE SAVE] program={program_id}, dataUrl length={len(cropped_image_base64)}, base64 length={len(base64_data)}, decoded bytes={len(image_bytes)}, dest={dest_path}")
        with open(dest_path, 'wb') as f:
            f.write(image_bytes)
            
        return jsonify({'status': 'success', 'message': 'Profile picture cropped and saved successfully.'})
    except Exception as e:
        print(f"Error saving profile picture: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/programs/profile_picture/crop', methods=['POST'])
@requires_auth
def crop_profile_picture():
    """Server-side crop: receives source image path and crop coordinates, uses PIL to crop and resize."""
    try:
        from variables import PROGRAMS_DIR
        from utils.program import get_active_program
        from PIL import Image
        
        data = request.get_json(silent=True) or {}
        source_image = data.get('source_image', '')
        x = int(data.get('x', 0))
        y = int(data.get('y', 0))
        w = int(data.get('width', 0))
        h = int(data.get('height', 0))
        
        if not source_image or w <= 0 or h <= 0:
            return jsonify({'error': 'Invalid crop parameters'}), 400
        
        program_id = data.get('program_id') or get_active_program()
        program_dir = os.path.join(PROGRAMS_DIR, program_id)
        
        # Resolve source image path from the URL path to a local file path
        # Source paths arrive as /images/portraits/xyz.png or /images/xyz.png
        if source_image.startswith('/images/'):
            relative_path = source_image[len('/images/'):]
            source_path = os.path.normpath(os.path.join(program_dir, relative_path))
        elif source_image.startswith('/profile.png'):
            source_path = os.path.normpath(os.path.join(program_dir, 'portraits', 'profile.png'))
        else:
            return jsonify({'error': 'Unsupported image path'}), 400
        
        if not os.path.exists(source_path):
            return jsonify({'error': f'Source image not found: {source_image}'}), 404
        
        # Crop and resize with PIL
        with Image.open(source_path) as img:
            # Clamp crop coordinates to image bounds
            img_w, img_h = img.size
            x = max(0, min(x, img_w))
            y = max(0, min(y, img_h))
            w = min(w, img_w - x)
            h = min(h, img_h - y)
            
            cropped = img.crop((x, y, x + w, y + h))
            cropped = cropped.resize((256, 256), Image.Resampling.LANCZOS)
            
            # Convert to RGB if necessary (handles RGBA, palette, etc.)
            if cropped.mode not in ('RGB', 'RGBA'):
                cropped = cropped.convert('RGBA')
        
        portraits_dir = os.path.join(program_dir, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        dest_path = os.path.join(portraits_dir, 'profile.png')
        cropped.save(dest_path, 'PNG')
        
        print(f"[PROFILE CROP] program={program_id}, source={source_path}, crop=({x},{y},{w},{h}), dest={dest_path}")
        return jsonify({'status': 'success', 'message': 'Profile picture cropped and saved successfully.'})
    except Exception as e:
        print(f"Error cropping profile picture: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/sparkle.mp3')
@requires_auth
def serve_sparkle_mp3():
    core_dir = os.path.join(base_dir, 'core')
    return send_from_directory(core_dir, 'sparkle.mp3')
 
@app.route('/images/<path:filename>')
@requires_auth
def serve_image(filename):
    active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
    program_dir = os.path.join('core', 'programs', active_program)
    return send_from_directory(program_dir, filename)

@app.route('/api/get_image_prompt', methods=['GET'])
@requires_auth
def get_image_prompt():
    image_url = request.args.get('image_url')
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400
        
    if "://" in image_url:
        from urllib.parse import urlparse
        image_url = urlparse(image_url).path
        
    try:
        import json
        from utils.program import get_active_program
        active_program = get_active_program()
        
        if image_url.startswith('/images/'):
            img_subpath = image_url[8:]
        else:
            img_subpath = os.path.basename(image_url)
            
        # Security: keep filename only to prevent directory traversal
        img_subpath = os.path.basename(img_subpath)
        json_path = find_image_sidecar_json(img_subpath, active_program)

        if json_path and os.path.exists(json_path):
            with open(json_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
                prompt = meta.get('prompt', '')
                return jsonify({'status': 'success', 'prompt': prompt})
        else:
            return jsonify({'status': 'success', 'prompt': ''})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/proactive_action', methods=['POST'])
@requires_auth
def proactive_action():
    session_id = request.json.get('session_id', 'default')
    selected_model = request.json.get('model')
    
    try:
        import os
        import json
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        
        active_program = get_active_program()
        program_path = os.path.join(PROGRAMS_DIR, active_program)
        
        name = "Program"
        description = ""
        personality = ""
        scenario = ""
        
        # Read active program JSON config
        for filename in [f"{active_program}.json", "character_profile.json"]:
            json_path = os.path.join(program_path, filename)
            if os.path.exists(json_path):
                try:
                    with open(json_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                        name = data.get('name', name)
                        op = data.get('operation', {})
                        description = op.get('description', '')
                        personality = op.get('personality', '')
                        scenario = op.get('scenario', '')
                except Exception as ex:
                    print(f"Error reading program config for proactive action: {ex}")
                    
        # Get active user profile
        from utils.program import get_active_user
        active_user = get_active_user()
        user_display_name = active_user.replace("_", " ").title()

        # Load session history
        chat_history = asyncio.run(runner.get_history(session_id))
        
        # Limit proactive messages to one: do not send another if one was already sent during this idle period
        for msg in reversed(chat_history):
            if msg.get('role') == 'user':
                break
            if msg.get('role') == 'program' and msg.get('is_proactive'):
                print(f"[PROACTIVE] A proactive message was already sent since the last user message. Skipping.")
                return jsonify({
                    'status': 'success',
                    'type': 'skipped',
                    'reason': 'A proactive message was already sent since the last user message.'
                })
        
        # Generate history context string
        history_context = ""
        for msg in chat_history[-10:]:
            role = msg.get('role', 'unknown')
            text = msg.get('text') or msg.get('content') or ""
            if role in ('user', 'program'):
                speaker = user_display_name if role == 'user' else name
                history_context += f"{speaker}: {text}\n"
                
        # Define LLM prompt
        prompt = f"""You are the program {name} from the sanctuary app.
Character Background:
Description: {description}
Personality: {personality}
Scenario: {scenario}

Recent Conversation History:
{history_context}

The user ({user_display_name}) has been inactive/away for a while.
Based on the conversation context above, decide how to react proactively.
Generate a private inner thought or monologue representing your feelings about the silence, the user's absence, or the last topic (1-2 sentences). Format this in character.

You must return a valid JSON object matching the following schema:
{{
  "type": "thought",
  "content": "the actual thought text"
}}
"""

        # Call the LLM
        from utils.models import is_local_model
        is_local = is_local_model(selected_model) if selected_model else True
        raw_response = None
        
        if is_local:
            import requests
            from variables import REMOTE_SERVER_URL, get_remote_server_headers
            target_model = selected_model if (selected_model and selected_model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME")
            payload = {
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.7,
                "max_tokens": 320
            }
            if target_model:
                payload["model"] = target_model
            try:
                headers = get_remote_server_headers()
                r = requests.post(REMOTE_SERVER_URL, json=payload, headers=headers, timeout=30.0)
                if r.status_code == 200:
                    raw_response = r.json()['choices'][0]['message']['content'].strip()
            except Exception as e:
                print(f"[PROACTIVE] Local LLM query failed: {e}")
        else:
            api_key = os.getenv("REMOTE_API_KEY")
            remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
            if api_key and remote_cloud_url:
                import requests
                target_model = selected_model if selected_model else os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite")
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}"
                }
                payload = {
                    "model": target_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": 0.7,
                    "max_tokens": 320,
                    "response_format": {"type": "json_object"},
                    "thinking": {"type": "disabled"}
                }
                try:
                    r = requests.post(remote_cloud_url, json=payload, headers=headers, timeout=30.0)
                    if r.status_code == 200:
                        raw_response = r.json()['choices'][0]['message']['content'].strip()
                    else:
                        print(f"[PROACTIVE] Remote cloud query failed with status {r.status_code}: {r.text}")
                except Exception as e:
                    print(f"[PROACTIVE] Remote cloud query failed: {e}")
                    
        if not raw_response:
            return jsonify({'error': 'Failed to generate proactive response'}), 500
            
        # Parse output
        action_type = "thought"
        content = ""
        
        try:
            # Clean JSON markdown formatting if present
            cleaned = raw_response.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            elif cleaned.startswith("```"):
                cleaned = cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            cleaned = cleaned.strip()
            
            parsed = json.loads(cleaned)
            action_type = parsed.get("type", "thought").lower()
            content = parsed.get("content", "").strip()
        except Exception as e:
            print(f"[PROACTIVE] JSON parsing failed: {e}. Raw: {raw_response}")
            action_type = "thought"
            content = raw_response
            
        # Force action to be a thought only
        return jsonify({
            'status': 'success',
            'type': 'thought',
            'content': content
        })
            
    except Exception as e:
        print(f"Error in proactive_action route: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/history', methods=['GET'])
@requires_auth
def history():
    session_id = request.args.get('session_id', 'default')
    try:
        async def fetch_history_data():
            hist = await runner.get_history(session_id)
            inv = await runner._get_inversion_mode(session_id, history=hist)
            return hist, inv

        chat_history, inversion_mode = asyncio.run(fetch_history_data())
        
        state_info = extract_mood(chat_history)
        
        from core.program_config import program_name, get_program_greeting
        welcome_message = get_program_greeting()
        active_program = os.environ.get("ACTIVE_PROGRAM", "sebile")
        
        theme = load_theme(active_program)

        return jsonify({
            'history': chat_history,
            'state': state_info,
            'inversion_active': inversion_mode,
            'inversion_state': runner.get_inversion_state(session_id),
            'character_name': program_name,
            'active_program': active_program,
            'theme': theme,
            'welcome_message': welcome_message
        })
    except Exception as e:
        print(f"Error getting history: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/upload_media', methods=['POST'])
@requires_auth
def upload_media():
    if 'file' not in request.files:
        return jsonify({'error': 'No file part in the request'}), 400
        
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400

    # Ensure size validation
    file.seek(0, os.SEEK_END)
    file_length = file.tell()
    file.seek(0) # Reset stream pointer

    # Restrict videos to 15MB
    if file.mimetype and file.mimetype.startswith('video/'):
        if file_length > 15 * 1024 * 1024:
            return jsonify({'error': 'Video file exceeds the 15MB limit'}), 413
    else:
        # Enforce a general limit for other files (e.g., 20MB)
        if file_length > 20 * 1024 * 1024:
            return jsonify({'error': 'File exceeds the 20MB limit'}), 413

    import uuid
    import time
    from werkzeug.utils import secure_filename

    filename = secure_filename(file.filename)
    ext = os.path.splitext(filename)[1].lower()
    unique_name = f"upload_{int(time.time())}_{uuid.uuid4().hex}{ext}"

    active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
    uploads_dir = os.path.normpath(os.path.join('core', 'programs', active_program, 'uploads'))
    os.makedirs(uploads_dir, exist_ok=True)
    
    local_path = os.path.join(uploads_dir, unique_name)
    file.save(local_path)

    return jsonify({'file_path': f'/images/uploads/{unique_name}'})

@app.route('/chat', methods=['POST'])
@requires_auth
def chat():
    user_message = request.json.get('message')
    image_data = request.json.get('image_data')
    image_mime = request.json.get('image_mime')
    media_path = request.json.get('media_path')
    session_id = request.json.get('session_id', 'default')
    selected_model = request.json.get('model')
    is_voice_call = request.json.get('is_voice_call', False)

    import tools
    tools.current_session_id.set(session_id)
    tools.current_use_imagen.set(request.json.get('use_imagen', False))
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []

    from runner_interface import cancelled_sessions, voice_call_sessions
    cancelled_sessions.discard(session_id)
    if is_voice_call:
        voice_call_sessions.add(session_id)
        
    start_time = time.time()

    try:
        msg_id = request.json.get('msg_id')
        response_text, tool_calls, user_msg_id, program_msg_id = asyncio.run(
            runner.run_async(
                session_id=session_id,
                new_message_text=user_message,
                image_data=image_data,
                image_mime=image_mime,
                model=selected_model,
                media_path=media_path,
                msg_id=msg_id
            )
        )
        duration = round(time.time() - start_time, 1)
        
        # Apply banned words filter to output response
        response_text = sanitize_response(response_text, session_id, program_msg_id)

        chat_history = asyncio.run(runner.get_history(session_id))
        state_info = extract_mood(chat_history)
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id, history=chat_history))
        
        # Align timestamp with stored program message
        program_timestamp = None
        if program_msg_id:
            for msg in reversed(chat_history):
                if msg.get('id') == program_msg_id:
                    program_timestamp = msg.get('timestamp')
                    break
            
        return jsonify({
            'response': response_text,
            'tool_calls': tool_calls,
            'state': state_info,
            'inversion_active': inversion_mode,
            'inversion_state': runner.get_inversion_state(session_id),
            'timestamp': program_timestamp or time.time(),
            'duration': duration,
            'user_msg_id': user_msg_id,
            'program_msg_id': program_msg_id
        })
    except asyncio.CancelledError:
        print(f"[CANCEL] Chat generation cancelled for session {session_id}")
        asyncio.run(runner.append_message_to_session(session_id, 'program', '*(Generation cancelled)*'))
        return jsonify({
            'cancelled': True,
            'response': '*(Generation cancelled)*',
            'tool_calls': [],
            'state': None,
            'inversion_active': '',
            'timestamp': time.time(),
            'duration': round(time.time() - start_time, 1)
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error occurred in chat: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        from runner_interface import cancelled_sessions, voice_call_sessions
        cancelled_sessions.discard(session_id)
        voice_call_sessions.discard(session_id)

@app.route('/edit', methods=['POST'])
@requires_auth
def edit():
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')
    new_text = request.json.get('new_text') # None means reroll (use original text)
    selected_model = request.json.get('model')
    force_offload = request.json.get('force_offload', False)

    import tools
    tools.current_session_id.set(session_id)
    tools.current_use_imagen.set(request.json.get('use_imagen', False))
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []

    from runner_interface import cancelled_sessions
    cancelled_sessions.discard(session_id)
    start_time = time.time()

    try:
        response_text, tool_calls, user_msg_id, program_msg_id = asyncio.run(
            runner.edit_turn(
                session_id=session_id,
                msg_id=msg_id,
                new_text=new_text,
                model=selected_model,
                force_offload=force_offload
            )
        )
        duration = round(time.time() - start_time, 1)
        
        # Apply banned words filter to output response
        response_text = sanitize_response(response_text, session_id, program_msg_id)

        chat_history = asyncio.run(runner.get_history(session_id))
        state_info = extract_mood(chat_history)
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id, history=chat_history))

        # Align timestamp with stored program message
        program_timestamp = None
        if program_msg_id:
            for msg in reversed(chat_history):
                if msg.get('id') == program_msg_id:
                    program_timestamp = msg.get('timestamp')
                    break

        return jsonify({
            'response': response_text,
            'tool_calls': tool_calls,
            'state': state_info,
            'inversion_active': inversion_mode,
            'inversion_state': runner.get_inversion_state(session_id),
            'timestamp': program_timestamp or time.time(),
            'duration': duration,
            'user_msg_id': user_msg_id,
            'program_msg_id': program_msg_id
        })
    except asyncio.CancelledError:
        print(f"[CANCEL] Edit generation cancelled for session {session_id}")
        asyncio.run(runner.append_message_to_session(session_id, 'program', '*(Generation cancelled)*'))
        return jsonify({
            'cancelled': True,
            'response': '*(Generation cancelled)*',
            'tool_calls': [],
            'state': None,
            'inversion_active': '',
            'timestamp': time.time(),
            'duration': round(time.time() - start_time, 1)
        })
    except Exception as e:
        print(f"Error occurred during edit: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        from runner_interface import cancelled_sessions
        cancelled_sessions.discard(session_id)

def generate_impersonated_message(session_id, user_profile, model):
    # Retrieve history
    chat_history = asyncio.run(runner.get_history(session_id))
    
    temperature = load_temperature()
            
    # Format only the most recent history turns to keep token count low and prevent context overflow
    recent_history = chat_history[-6:] if len(chat_history) > 6 else chat_history
    history_text = ""
    for msg in recent_history:
        role = "User" if msg.get('role') == 'user' else "Program"
        history_text += f"{role}: {msg.get('text', '')}\n"
        
    system_instruction = (
        "You are an assistant that auto-generates the User's next reply. "
        "You MUST write in the first-person, impersonating the user. "
        "Match the user's tone and context. Be short and concise."
    )
    
    from core.program_config import replace_placeholders
    prompt = (
        f"User Profile Context:\n{replace_placeholders(user_profile)}\n\n"
        f"Recent Chat History:\n{replace_placeholders(history_text)}\n"
        f"Generate the User's next message to the Program:"
    )
    
    # Delegate entirely to the runner's provider-agnostic generator
    try:
        return asyncio.run(runner.generate_impersonation(prompt, system_instruction, model, temperature))
    except Exception as e:
        print(f"Error generating impersonated message via runner: {e}")
        raise

@app.route('/api/generate_user_message', methods=['POST'])
@requires_auth
def generate_user_message():
    session_id = request.json.get('session_id', 'default')
    model = request.json.get('model')
    user_profile = request.json.get('user_profile', '').strip()
    
    if not user_profile:
        # Fallback to active user profile file
        try:
            from variables import USER_PROFILES_DIR
            from utils.program import get_active_user
            active_user = get_active_user()
            profile_path = os.path.join(USER_PROFILES_DIR, f"{active_user}.md")
            if os.path.exists(profile_path):
                with open(profile_path, "r", encoding="utf-8") as f:
                    user_profile = f.read().strip()
        except Exception as e:
            print(f"Error loading fallback user profile: {e}")
            
    if not user_profile:
        user_profile = "A software developer and code builder."
        
    try:
        generated_msg = generate_impersonated_message(session_id, user_profile, model)
        return jsonify({'status': 'success', 'message': generated_msg})
    except Exception as e:
        print(f"Error generating impersonated user message: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/update_message', methods=['POST'])
@requires_auth
def update_message():
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')
    new_text = request.json.get('new_text')
    
    if not msg_id or new_text is None:
        return jsonify({'error': 'msg_id and new_text are required'}), 400

    try:
        success = asyncio.run(runner.update_message_text(session_id, msg_id, new_text))
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Message not found'}), 404
    except Exception as e:
        print(f"Error updating message text: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/delete', methods=['POST'])
@requires_auth
def delete_message():
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')

    if not msg_id:
        return jsonify({'error': 'msg_id is required'}), 400

    try:
        success = asyncio.run(runner.delete_message_at(session_id, msg_id))
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Message not found'}), 404
    except Exception as e:
        print(f"Error deleting message {msg_id}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/continue', methods=['POST'])
@requires_auth
def continue_generation():
    session_id = request.json.get('session_id', 'default')
    model = request.json.get('model')
    
    import tools
    tools.current_session_id.set(session_id)
    tools.current_use_imagen.set(request.json.get('use_imagen', False))
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []

    from runner_interface import cancelled_sessions
    cancelled_sessions.discard(session_id)
    start_time = time.time()
    
    try:
        history = asyncio.run(runner.get_history(session_id))
        if not history:
            return jsonify({'error': 'No history to continue'}), 400
            
        last_msg = history[-1]
        last_role = 'user' if last_msg.get('role') == 'user' else 'program'
        
        if last_role == 'program':
            last_program_text = last_msg.get('text', '')
            
            # Send a prompt to continue
            continue_prompt = (
                "[System: Continue your last message. Do NOT repeat or summarize your last message. "
                "Start writing immediately from the exact point where you left off, connecting seamlessly to the end.]"
            )
            
            response_text, tool_calls, user_msg_id, program_msg_id = asyncio.run(runner.run_async(
                session_id=session_id,
                new_message_text=continue_prompt,
                model=model
            ))
            duration = round(time.time() - start_time, 1)
            
            # Delete the temporary turn
            if user_msg_id:
                asyncio.run(runner.delete_message_at(session_id, user_msg_id))
            
            # Merge continuation text dynamically
            if last_program_text.endswith('\n') or response_text.startswith('\n'):
                merged_text = last_program_text + response_text
            else:
                last_char = last_program_text.rstrip()[-1:] if last_program_text.strip() else ""
                if last_char in ['.', '!', '?', '"', '*']:
                    merged_text = last_program_text + "\n\n" + response_text
                else:
                    prefix = "" if (not response_text or response_text.startswith(' ')) else " "
                    merged_text = last_program_text + prefix + response_text
            
            # Update the original program message
            last_program_msg_id = last_msg.get('id')
            if last_program_msg_id:
                asyncio.run(runner.update_message_text(session_id, last_program_msg_id, merged_text))
            
            return jsonify({
                'status': 'success',
                'response': merged_text,
                'tool_calls': tool_calls,
                'duration': duration,
                'user_msg_id': None,
                'program_msg_id': last_program_msg_id
            })
        else:
            user_text = last_msg.get('text', '')
            user_image = last_msg.get('image_url')
            
            last_msg_id = last_msg.get('id')
            if last_msg_id:
                asyncio.run(runner.delete_message_at(session_id, last_msg_id))
            
            response_text, tool_calls, user_msg_id, program_msg_id = asyncio.run(runner.run_async(
                session_id=session_id,
                new_message_text=user_text,
                media_path=user_image if (user_image and not user_image.startswith('data:')) else None,
                model=model,
                msg_id=last_msg_id
            ))
            duration = round(time.time() - start_time, 1)
            
            return jsonify({
                'status': 'success',
                'response': response_text,
                'tool_calls': tool_calls,
                'duration': duration,
                'user_msg_id': user_msg_id,
                'program_msg_id': program_msg_id
            })
            
    except asyncio.CancelledError:
        print(f"[CANCEL] Continuation cancelled for session {session_id}")
        asyncio.run(runner.append_message_to_session(session_id, 'program', '*(Generation cancelled)*'))
        return jsonify({
            'cancelled': True,
            'response': '*(Generation cancelled)*',
            'tool_calls': [],
            'duration': round(time.time() - start_time, 1)
        })
    except Exception as e:
        print(f"Error in continue_generation: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        from runner_interface import cancelled_sessions
        cancelled_sessions.discard(session_id)



@app.route('/reset', methods=['POST'])
@requires_auth
def reset():
    session_id = request.json.get('session_id', 'default')
    try:
        asyncio.run(runner.reset_session(session_id))
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Error resetting session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/delete_image', methods=['POST'])
@requires_auth
def delete_image():
    session_id = request.json.get('session_id', 'default')
    image_url = request.json.get('image_url')
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400
        
    try:
        # Detach from session log - delete the image and remove it from history
        success = asyncio.run(runner.delete_image_from_session(session_id, image_url))
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Image file not found in session or disk'}), 404
    except Exception as e:
        print(f"Error deleting image file {image_url} from session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500


@app.route('/regenerate_image', methods=['POST'])
@requires_auth
def regenerate_image():
    session_id = request.json.get('session_id', 'default')
    old_image_url = request.json.get('old_image_url')
    prompt = request.json.get('prompt')
    
    if not old_image_url:
        return jsonify({'error': 'Missing old_image_url'}), 400
        
    # Normalize old_image_url to pathname
    if "://" in old_image_url:
        from urllib.parse import urlparse
        old_image_url = urlparse(old_image_url).path

    if not prompt:
        import os
        filename = os.path.basename(old_image_url)
        # 1. Try to find the prompt in the program sidecar JSON file (most reliable and clean)
        try:
            from utils.program import get_active_program
            active_program = get_active_program()
            filename_only = os.path.basename(old_image_url)
            json_path = find_image_sidecar_json(filename_only, active_program)

            if json_path and os.path.exists(json_path):
                with open(json_path, 'r', encoding='utf-8') as f:
                    meta = json.load(f)
                    prompt = meta.get('prompt')
                    if prompt:
                        print(f"[DEBUG REROLL] Found prompt in sidecar JSON: {prompt}")
        except Exception as je:
            print(f"Error reading sidecar JSON: {je}")

        # 2. Try to find the prompt in session history (fallback)
        if not prompt:
            try:
                chat_history = asyncio.run(runner.get_history(session_id))
                for msg in chat_history:
                    tool_calls = msg.get('tool_calls', [])
                    if not tool_calls:
                        continue
                    calls = {}
                    for tc in tool_calls:
                        if tc.get('type') == 'call' and tc.get('name') == 'generate_program_portrait':
                            call_id = tc.get('id')
                            args = tc.get('args', {})
                            p = args.get('prompt')
                            if call_id and p:
                                calls[call_id] = p
                    for tc in tool_calls:
                        if tc.get('type') == 'response' and tc.get('name') == 'generate_program_portrait':
                            call_id = tc.get('id')
                            response_val = tc.get('response', '')
                            if call_id in calls and filename in response_val:
                                prompt = calls[call_id]
                                print(f"[DEBUG REROLL] Found prompt in history matching filename '{filename}': {prompt}")
                                break
                    if prompt:
                        break
            except Exception as he:
                print(f"Error scanning session history for prompt: {he}")

        if not prompt:
            return jsonify({'error': 'Original prompt not found. Unable to regenerate image.'}), 400

    try:
        import tools
        tools.current_session_id.set(session_id)
        with tools.session_tool_calls_lock:
            tools.session_tool_calls[session_id] = []
        use_imagen = request.json.get('use_imagen', False)
        # Generate new portrait
        if use_imagen:
            new_markdown = tools.generate_imagen(prompt)
        else:
            new_markdown = tools.generate_local_image(prompt)
        if new_markdown.startswith("Error"):
            return jsonify({'error': new_markdown}), 500
            
        # Parse the new image URL from Markdown link: ![...](/images/...)
        new_image_url = None
        if new_markdown.startswith("![") and new_markdown.endswith(")"):
            new_image_url = new_markdown.split("(", 1)[1][:-1]
            
        if not new_image_url:
            return jsonify({'error': f'Failed to parse generated image markdown: {new_markdown}'}), 500
            
        # Replace in session history
        success = asyncio.run(runner.replace_image_in_session(session_id, old_image_url, new_image_url, new_prompt=prompt))
        if success:
            return jsonify({
                'status': 'success',
                'new_image_url': new_image_url
            })
        else:
            return jsonify({'error': 'Original image not found in session'}), 404
    except Exception as e:
        print(f"Error regenerating image in session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500

import threading
import uuid

active_generations = {}
active_generations_lock = threading.Lock()

def run_background_video_gen(task_id, session_id, image_url, local_path, prompt):
    import tools
    import asyncio
    
    with active_generations_lock:
        if task_id in active_generations:
            active_generations[task_id]['status'] = 'generating'
            active_generations[task_id]['progress'] = 20
            
    try:
        # Call video generation
        new_video_url = tools.generate_video_from_image(local_path, prompt)
        
        # Replace the image in session history
        success = asyncio.run(runner.replace_image_with_video_in_session(session_id, image_url, new_video_url))
        
        with active_generations_lock:
            if task_id in active_generations:
                active_generations[task_id].update({
                    'status': 'completed',
                    'progress': 100,
                    'result_url': new_video_url,
                    'history_updated': success
                })
                
    except Exception as e:
        print(f"Error in background generation task {task_id}: {e}")
        with active_generations_lock:
            if task_id in active_generations:
                active_generations[task_id].update({
                    'status': 'failed',
                    'progress': 100,
                    'error': str(e)
                })

@app.route('/api/animate_image', methods=['POST'])
@requires_auth
def animate_image():
    session_id = request.json.get('session_id', 'default')
    image_url = request.json.get('image_url')
    prompt = request.json.get('prompt', '')
    
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400
        
    try:
        from runner_interface import _get_safe_local_path
        
        # Resolve to safe local path
        local_path = _get_safe_local_path(image_url)
        if not local_path or not os.path.exists(local_path):
            return jsonify({'error': f'Image file not found: {image_url}'}), 404
            
        # Create a unique task ID
        task_id = f"gen_{int(time.time())}_{uuid.uuid4().hex[:4]}"
        
        # Initialize task in queue
        with active_generations_lock:
            active_generations[task_id] = {
                'task_id': task_id,
                'status': 'queued',
                'progress': 0,
                'prompt': prompt,
                'source_image': image_url,
                'session_id': session_id,
                'timestamp': time.time(),
                'result_url': None,
                'error': None
            }
            
        # Spawn background thread
        t = threading.Thread(
            target=run_background_video_gen,
            args=(task_id, session_id, image_url, local_path, prompt),
            daemon=True
        )
        t.start()
        
        return jsonify({
            'status': 'queued',
            'task_id': task_id
        })
            
    except Exception as e:
        print(f"Error starting animation queue for {image_url}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/generations', methods=['GET'])
@requires_auth
def list_generations():
    with active_generations_lock:
        tasks = list(active_generations.values())
        tasks.sort(key=lambda x: x['timestamp'], reverse=True)
        return jsonify({
            'generations': tasks
        })


@app.route('/list_images', methods=['GET'])
@requires_auth
def list_images():
    try:
        active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
        program_dir = os.path.join('core', 'programs', active_program)
        all_items = []
        valid_exts = ('.png', '.jpg', '.jpeg', '.gif', '.mp4', '.webm')

        for folder in ('portraits', 'media'):
            target_dir = os.path.join(program_dir, folder)
            if os.path.exists(target_dir):
                for f in os.listdir(target_dir):
                    if f.lower().endswith(valid_exts) and f.lower() != 'profile.png':
                        full_path = os.path.join(target_dir, f)
                        if os.path.isfile(full_path):
                            all_items.append({
                                'url': f"/images/{folder}/{f}",
                                'mtime': os.path.getmtime(full_path)
                            })

        all_items.sort(key=lambda x: x['mtime'], reverse=True)
        image_urls = [x['url'] for x in all_items]
        return jsonify({'images': image_urls})
    except Exception as e:
        print(f"Error listing images: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/pending_tool_call', methods=['GET'])
@requires_auth
def get_pending_tool_call():
    import tools
    pending = None
    for call_id, info in list(tools.pending_tool_calls.items()):
        if info['status'] == 'pending':
            pending = {
                'call_id': call_id,
                'tool_name': info['tool_name'],
                'details': info['details']
            }
            break
    active_list = list(tools.active_running_tools.keys())
    return jsonify({
        'call_id': pending['call_id'] if pending else None,
        'tool_name': pending['tool_name'] if pending else None,
        'details': pending['details'] if pending else None,
        'active_tools': active_list
    })

@app.route('/api/cancel_chat', methods=['POST'])
@requires_auth
def cancel_chat():
    session_id = request.json.get('session_id', 'default')
    from runner_interface import cancelled_sessions
    cancelled_sessions.add(session_id)
    print(f"[CANCEL] Session cancellation requested: {session_id}", flush=True)
    return jsonify({'status': 'success'})

@app.route('/api/session_tool_calls', methods=['GET'])
@requires_auth
def get_session_tool_calls():
    session_id = request.args.get('session_id', 'default')
    import tools
    with tools.session_tool_calls_lock:
        calls = tools.session_tool_calls.get(session_id, [])
        return jsonify({'tool_calls': list(calls)})

@app.route('/approve_tool', methods=['POST'])
@requires_auth
def approve_tool():
    import tools
    call_id = request.json.get('call_id')
    status = request.json.get('status')
    
    if call_id in tools.pending_tool_calls:
        tools.pending_tool_calls[call_id]['status'] = status
        event = tools.pending_tool_calls[call_id].get('event')
        if event:
            event.set()
        return jsonify({'status': 'success'})
    return jsonify({'error': 'Tool call not found'}), 404

from utils.models import fetch_local_models

@app.route('/models', methods=['GET'])
@requires_auth
def get_models():
    # Determine the active runner backend
    runner_backend = os.getenv("RUNNER_BACKEND", "opensource").lower()
    
    # Check if Remote API key and Cloud URL are validly configured
    remote_key = os.getenv("REMOTE_API_KEY")
    remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
    is_remote_configured = bool(
        remote_key and remote_key.strip() and remote_key != "your_remote_api_key_here" and
        remote_cloud_url and remote_cloud_url.strip() and remote_cloud_url != "your_remote_cloud_url_here"
    )
    
    from utils.local_llm_manager import check_status, check_installed
    is_local_online = check_status()
    
    # 1. Fetch dynamic local models (only actively loaded models in Local LLM server)
    models = fetch_local_models()
    
    # Default fallback: use the first loaded local model if available, otherwise "local-llm"
    default_model = "local-llm"
    if models and models[0]["value"] != "local-llm":
        default_model = models[0]["value"]
        
    temperature = load_temperature()
        
    return jsonify({
        "models": models,
        "default": default_model,
        "status": {
            "remote_configured": is_remote_configured,
            "remote_model": os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite"),
            "remote_url": remote_cloud_url,
            "local_online": is_local_online,
            "local_installed": check_installed(),
            "temperature": temperature
        }
    })

@app.route('/api/project_settings', methods=['GET', 'POST'])
@requires_auth
def project_settings():
    from variables import VARIABLES_DIR
    import json
    settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
    
    # Get active program
    from utils.program import get_active_program
    active_prog = get_active_program()
    default_folder = os.path.normpath(os.path.join(os.getcwd(), 'core', 'programs', active_prog))
    
    # Define default settings
    default_settings = {
        "folders": [default_folder],
        "security_preset": "ask_always",
        "artifact_review_policy": "ask_always",
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
                
                if settings.get("search_engine") in ("sovereign_hybrid", "sovereign_search"):
                    settings["search_engine"] = "web_crawling"
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
            
            settings.update({
                "folders": cleaned_folders,
                "security_preset": security_preset,
                "artifact_review_policy": artifact_review_policy,
                "search_engine": search_engine,
                "searxng_url": searxng_url,
                "tts_voice": tts_voice
            })
            
            # Keep environment variable in sync
            os.environ["TTS_VOICE"] = tts_voice
            
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump(settings, f, indent=2, ensure_ascii=False)
            return jsonify({"status": "success", "settings": settings})
        except Exception as e:
            print(f"Error saving project settings: {e}")
            return jsonify({"error": str(e)}), 500

@app.route('/api/browse_folder', methods=['POST'])
@requires_auth
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
            res = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                selected_folder = res.stdout.strip()
        except Exception as e:
            print(f"Tkinter folder dialog error: {e}")

    if selected_folder:
        return jsonify({"folder": os.path.normpath(selected_folder)})
    return jsonify({"folder": None, "cancelled": True})

@app.route('/api/save_generation_params', methods=['POST'])
@requires_auth
def save_generation_params():
    try:
        from variables import VARIABLES_DIR
        settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
        
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
            
        # Re-initialize runner to apply the configuration dynamically
        init_runner()
        
        return jsonify({"status": "success", "settings": settings})
    except Exception as e:
        print(f"Error saving generation params: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/save_config', methods=['POST'])
@requires_auth
def save_config():
    try:
        data = request.get_json() or {}
        remote_api_key = data.get('remote_api_key', data.get('gemini_api_key', '')).strip()
        remote_cloud_url = data.get('remote_cloud_url', data.get('project_id', '')).strip()
        remote_model = data.get('remote_model', data.get('gemini_model', '')).strip()
        
        existing_key = os.getenv("REMOTE_API_KEY")
        
        target_key = remote_api_key or existing_key
        
        if not target_key:
            return jsonify({'error': 'Remote API Key must be provided.'}), 400
            
        env_path = os.path.join(base_dir, '.env')
        
        # Read env lines
        if os.path.exists(env_path):
            with open(env_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        else:
            lines = []
            
        updated_key = False
        updated_url = False
        updated_model = False
        
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith('REMOTE_API_KEY=') and remote_api_key:
                lines[i] = f"REMOTE_API_KEY={remote_api_key}\n"
                updated_key = True
            elif stripped.startswith('REMOTE_CLOUD_URL=') and remote_cloud_url:
                lines[i] = f"REMOTE_CLOUD_URL={remote_cloud_url}\n"
                updated_url = True
            elif stripped.startswith('REMOTE_MODEL=') and remote_model:
                lines[i] = f"REMOTE_MODEL={remote_model}\n"
                updated_model = True
                
        if remote_api_key:
            if not updated_key:
                lines.append(f"REMOTE_API_KEY={remote_api_key}\n")
            os.environ["REMOTE_API_KEY"] = remote_api_key
        if remote_cloud_url:
            if not updated_url:
                lines.append(f"REMOTE_CLOUD_URL={remote_cloud_url}\n")
            os.environ["REMOTE_CLOUD_URL"] = remote_cloud_url
        if remote_model:
            if not updated_model:
                lines.append(f"REMOTE_MODEL={remote_model}\n")
            os.environ["REMOTE_MODEL"] = remote_model
            
        # Re-initialize the runner backend dynamically
        init_runner()
        
        # Clear runner sessions history to reload character instructions
        runner.sessions_history.clear()
                
        # Clean up legacy GCP/Project ID lines to avoid bloat
        lines = [l for l in lines if not l.strip().startswith('PROJECT_ID=')]
        
        with open(env_path, 'w', encoding='utf-8') as f:
            f.writelines(lines)
            
        print(">>> Dynamic setup complete: Saved configuration credentials successfully!")
        return jsonify({'status': 'success', 'message': 'Configuration credentials saved successfully!'})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500

@app.route('/speech_cache/<path:filename>')
@requires_auth
def serve_speech_cache(filename):
    cache_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "core", "skills", "speech_generation", "speech_cache")
    return send_from_directory(cache_dir, filename)

@app.route('/api/tts', methods=['POST'])
@requires_auth
def api_tts():
    try:
        data = request.get_json() or {}
        message_id = data.get('message_id')
        text = data.get('text')
        
        if not message_id or not text:
            return jsonify({'error': 'Missing message_id or text'}), 400
            
        from core.program_config import replace_placeholders
        text = replace_placeholders(text)
        
        from core.skills.speech_generation.speech import SpeechManager
        manager = SpeechManager()
        audio_url = manager.get_speech_file(text, message_id)
        if audio_url:
            return jsonify({'success': True, 'audio_url': audio_url})
        else:
            return jsonify({'success': False, 'error': 'Speech generation failed'}), 500
    except Exception as e:
        print(f"Error in /api/tts: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/voice_call/start', methods=['POST'])
@requires_auth
def start_voice_call_api():
    try:
        data = request.get_json() or {}
        session_id = data.get('session_id', 'default')
        voice_session_id = f"{session_id}_voice"
        
        # 1. Reset/Clear any existing voice session
        asyncio.run(runner.reset_session(voice_session_id))
        
        # 2. Clone context from main session to voice session
        asyncio.run(runner.clone_history(session_id, voice_session_id, []))
        
        print(f"[VOICE CALL] Initialized voice session: {voice_session_id} cloned from {session_id}")
        return jsonify({'success': True})
    except Exception as e:
        print(f"Error in /api/voice_call/start: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

@app.route('/api/voice_call/save', methods=['POST'])
@requires_auth
def save_voice_call():
    try:
        data = request.get_json() or {}
        session_id = data.get('session_id', 'default')
        transcript = data.get('transcript')
        voice_session_id = f"{session_id}_voice"
        
        if not transcript:
            return jsonify({'error': 'Missing transcript'}), 400
            
        # 1. Save consolidated transcript message to main session history
        success = asyncio.run(runner.append_voice_call(session_id, transcript))
        
        # 2. Reset/Clean up temporary voice session from memory/disk
        asyncio.run(runner.reset_session(voice_session_id))
        
        print(f"[VOICE CALL] Saved transcript to main session {session_id} and cleared temporary voice session {voice_session_id}")
        
        if success:
            return jsonify({'success': True})
        else:
            return jsonify({'success': False, 'error': 'Failed to append voice call to session'}), 500
    except Exception as e:
        print(f"Error in /api/voice_call/save: {e}")
        return jsonify({'success': False, 'error': str(e)}), 500

# --- VECTORIZED DATA BANK API ENDPOINTS ---
from core.skills.vectorized_databank.databank import DataBankManager

@app.route('/api/databank/files', methods=['GET'])
@requires_auth
def databank_list_files():
    try:
        manager = DataBankManager()
        files = manager.list_documents()
        return jsonify({"files": files})
    except Exception as e:
        print(f"Error listing databank files: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/databank/upload', methods=['POST'])
@requires_auth
def databank_upload():
    if 'file' not in request.files:
        return jsonify({"error": "No file part in the request"}), 400
        
    uploaded_file = request.files['file']
    if uploaded_file.filename == '':
        return jsonify({"error": "No selected file"}), 400
        
    temp_path = None
    try:
        # Create temp folder inside workspace for uploads
        temp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp_uploads")
        os.makedirs(temp_dir, exist_ok=True)
        
        # Sanitize filename
        from werkzeug.utils import secure_filename
        filename = secure_filename(uploaded_file.filename)
        temp_path = os.path.join(temp_dir, filename)
        uploaded_file.save(temp_path)
        
        manager = DataBankManager()
        doc_id = manager.ingest_file(temp_path, uploaded_file.filename)
        return jsonify({"status": "success", "id": doc_id})
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error uploading to databank: {e}")
        return jsonify({"error": str(e)}), 500
    finally:
        # Clean up temp file
        if temp_path and os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except Exception as re:
                print(f"Error cleaning up temporary file {temp_path}: {re}")

@app.route('/api/databank/scrape', methods=['POST'])
@requires_auth
def databank_scrape():
    url = request.json.get('url')
    if not url:
        return jsonify({"error": "Missing URL"}), 400
        
    try:
        manager = DataBankManager()
        doc_id = manager.ingest_url(url)
        return jsonify({"status": "success", "id": doc_id})
    except Exception as e:
        print(f"Error scraping url: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/databank/delete', methods=['POST'])
@requires_auth
def databank_delete():
    doc_id = request.json.get('id')
    if not doc_id:
        return jsonify({"error": "Missing document ID"}), 400
        
    try:
        manager = DataBankManager()
        success = manager.delete_document(doc_id)
        if success:
            return jsonify({"status": "success"})
        else:
            return jsonify({"error": "Document not found"}), 404
    except Exception as e:
        print(f"Error deleting document {doc_id}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/databank/purge', methods=['POST'])
@requires_auth
def databank_purge():
    try:
        manager = DataBankManager()
        manager.purge_all()
        return jsonify({"status": "success"})
    except Exception as e:
        print(f"Error purging databank: {e}")

# ---------------------------------------------------------------------------
# Lorebook routes
# ---------------------------------------------------------------------------

@app.route('/api/lorebooks', methods=['GET'])
@requires_auth
def list_lorebooks_route():
    try:
        from utils.program import get_active_program
        from utils.lorebook import list_lorebooks
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        books = list_lorebooks(program_id, PROGRAMS_DIR)
        for b in books:
            b['program_id'] = program_id
        return jsonify({'lorebooks': books, 'program_id': program_id})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/import', methods=['POST'])
@requires_auth
def import_lorebook_route():
    try:
        from utils.program import get_active_program
        from utils.lorebook import import_lorebook
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        if 'file' not in request.files:
            return jsonify({'error': 'No file provided'}), 400
        f = request.files['file']
        if not f.filename or not f.filename.endswith('.json'):
            return jsonify({'error': 'Only .json lorebook files are accepted'}), 400
        book_data = json.loads(f.read().decode('utf-8'))
        dest = import_lorebook(program_id, book_data, f.filename, PROGRAMS_DIR)
        return jsonify({'success': True, 'path': dest})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/<filename>/export', methods=['GET'])
@requires_auth
def export_lorebook_route(filename):
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        fpath = os.path.join(PROGRAMS_DIR, program_id, 'lorebooks', filename)
        if not os.path.exists(fpath):
            return jsonify({'error': 'Lorebook not found'}), 404
        with open(fpath, encoding='utf-8') as lf:
            book_data = json.load(lf)
        resp = make_response(json.dumps(book_data, indent=2, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/json'
        resp.headers['Content-Disposition'] = f'attachment; filename="{filename}"'
        return resp
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/<filename>/delete', methods=['POST'])
@requires_auth
def delete_lorebook_route(filename):
    try:
        from utils.program import get_active_program
        from utils.lorebook import delete_lorebook
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        deleted = delete_lorebook(program_id, filename, PROGRAMS_DIR)
        return jsonify({'success': deleted})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/card/entries', methods=['GET'])
@requires_auth
def get_card_lorebook_entries():
    """Return entries from the embedded character_book in the active program card."""
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        card_path = os.path.join(PROGRAMS_DIR, program_id, f'{program_id}.json')
        if not os.path.exists(card_path):
            return jsonify({'error': 'Card not found'}), 404
        with open(card_path, encoding='utf-8') as f:
            card = json.load(f)
        cb = card.get('data', card).get('character_book', {})
        entries = cb.get('entries', [])
        if isinstance(entries, dict):
            entries = list(entries.values())
        return jsonify({'name': cb.get('name', program_id), 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/card/save', methods=['POST'])
@requires_auth
def save_card_lorebook_entries():
    """Write updated entries back into character_book in the active program card."""
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        card_path = os.path.join(PROGRAMS_DIR, program_id, f'{program_id}.json')
        if not os.path.exists(card_path):
            return jsonify({'error': 'Card not found'}), 404
        data = request.get_json(silent=True) or {}
        with open(card_path, encoding='utf-8') as f:
            card = json.load(f)
        # Navigate to character_book regardless of v2/v3 wrapping
        data_block = card.get('data', card)
        if 'character_book' not in data_block:
            data_block['character_book'] = {'name': program_id, 'entries': []}
        if 'entries' in data:
            data_block['character_book']['entries'] = data['entries']
        with open(card_path, 'w', encoding='utf-8') as f:
            json.dump(card, f, indent=2, ensure_ascii=False)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/<filename>/entries', methods=['GET'])
@requires_auth
def get_lorebook_entries(filename):
    """Return the raw entry list for a lorebook file so the UI can render an editor."""
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        fpath = os.path.join(PROGRAMS_DIR, program_id, 'lorebooks', filename)
        if not os.path.exists(fpath):
            return jsonify({'error': 'Lorebook not found'}), 404
        with open(fpath, encoding='utf-8') as lf:
            book = json.load(lf)
        # Normalise entries to list form
        entries = book.get('entries', [])
        if isinstance(entries, dict):
            entries = list(entries.values())
        return jsonify({'name': book.get('name', filename), 'entries': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/lorebooks/<filename>/save', methods=['POST'])
@requires_auth
def save_lorebook_entries(filename):
    """Overwrite a lorebook file with updated entries from the editor."""
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        program_id = get_active_program()
        fpath = os.path.join(PROGRAMS_DIR, program_id, 'lorebooks', filename)
        if not os.path.exists(fpath):
            return jsonify({'error': 'Lorebook not found'}), 404
        data = request.get_json(silent=True) or {}
        with open(fpath, encoding='utf-8') as lf:
            book = json.load(lf)
        if 'entries' in data:
            # Store as list (v3 format)
            book['entries'] = data['entries']
        if 'name' in data:
            book['name'] = data['name']
        with open(fpath, 'w', encoding='utf-8') as lf:
            json.dump(book, lf, indent=2, ensure_ascii=False)
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/memories', methods=['GET'])
@requires_auth
def get_program_memories():
    try:
        from utils.program import get_active_program
        program_id = request.args.get('program_id') or get_active_program()
        
        db_dir = os.path.join(base_dir, "core", "programs", program_id)
        
        manager = DataBankManager(db_dir=db_dir)
        memories = manager.get_all_memories()
        return jsonify({"memories": memories})
    except Exception as e:
        print(f"Error loading program memories: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/programs/memories/delete', methods=['POST'])
@requires_auth
def delete_memory():
    data = request.json or {}
    session_id = data.get("session_id", "default")
    timestamp = data.get("timestamp")
    if timestamp is None:
        return jsonify({"error": "Missing timestamp"}), 400
    try:
        timestamp = float(timestamp)
    except ValueError:
        return jsonify({"error": "Invalid timestamp"}), 400
    try:
        success = asyncio.run(runner.delete_system_memory(session_id, timestamp))
        return jsonify({"status": "success", "deleted": success})
    except Exception as e:
        print(f"Error deleting memory for session {session_id} at {timestamp}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/quests', methods=['GET'])
@requires_auth
def list_quests():
    try:
        from utils.program import get_active_program
        active_program = get_active_program()
        quests_path = os.path.join('core', 'programs', active_program, 'quest_log.json')
        
        quests = []
        if os.path.exists(quests_path):
            with open(quests_path, 'r', encoding='utf-8') as f:
                quests = json.load(f)
                
        return jsonify({
            "quests": quests
        })
    except Exception as e:
        print(f"Error loading quests: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/quests/<quest_id>/delete', methods=['POST'])
@requires_auth
def delete_quest(quest_id):
    try:
        from utils.program import get_active_program
        active_program = get_active_program()
        quests_path = os.path.join('core', 'programs', active_program, 'quest_log.json')
        
        if os.path.exists(quests_path):
            with open(quests_path, 'r', encoding='utf-8') as f:
                quests = json.load(f)
            quests = [q for q in quests if q['id'] != quest_id]
            with open(quests_path, 'w', encoding='utf-8') as f:
                json.dump(quests, f, indent=2, ensure_ascii=False)
                
        return jsonify({"status": "success"})
    except Exception as e:
        print(f"Error deleting quest {quest_id}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/quests/<quest_id>/complete', methods=['POST'])
@requires_auth
def complete_quest(quest_id):
    try:
        from utils.program import get_active_program
        active_program = get_active_program()
        quests_path = os.path.join('core', 'programs', active_program, 'quest_log.json')
        quest_data = None
        
        if os.path.exists(quests_path):
            with open(quests_path, 'r', encoding='utf-8') as f:
                quests = json.load(f)
            quest_data = next((q for q in quests if q['id'] == quest_id), None)
            if quest_data:
                quests = [q for q in quests if q['id'] != quest_id]
                with open(quests_path, 'w', encoding='utf-8') as f:
                    json.dump(quests, f, indent=2, ensure_ascii=False)
        
        if not quest_data:
            return jsonify({"error": "Quest not found"}), 404
            
        session_id = 'default'
        if request.is_json:
            session_id = request.json.get('session_id', 'default')
            
        title = quest_data.get("title", "")
        objectives = quest_data.get("objectives", [])
        obj_text = f" with objectives: {', '.join(objectives)}" if objectives else ""
        system_message = f"[SYSTEM: User has completed the quest: \"{title}\"{obj_text}]"
        
        asyncio.run(runner.append_message_to_session(session_id, "user", system_message))
        
        return jsonify({
            "status": "success",
            "title": title,
            "objectives": objectives
        })
    except Exception as e:
        print(f"Error completing quest {quest_id}: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/quests/<quest_id>/download', methods=['GET'])
@requires_auth
def download_quest(quest_id):
    try:
        from utils.program import get_active_program
        active_program = get_active_program()
        quests_path = os.path.join('core', 'programs', active_program, 'quest_log.json')
        if not os.path.exists(quests_path):
            return jsonify({"error": "No quests found"}), 404
        with open(quests_path, 'r', encoding='utf-8') as f:
            quests = json.load(f)
        quest = next((q for q in quests if q['id'] == quest_id), None)
        if not quest:
            return jsonify({"error": "Quest not found"}), 404

        title = quest.get('title', 'Quest')
        location = quest.get('location', '')
        objectives = quest.get('objectives', [])
        notes = "\n".join(objectives)
        due_str = quest.get('due', '')

        # Parse start time
        try:
            from datetime import datetime, timedelta, timezone
            dt_start = datetime.fromisoformat(due_str.replace("Z", "+00:00"))
        except Exception:
            dt_start = datetime.now(timezone.utc)
            
        dt_end = dt_start + timedelta(hours=1)
        
        stamp_str = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        start_str = dt_start.strftime("%Y%m%dT%H%M%SZ")
        end_str = dt_end.strftime("%Y%m%dT%H%M%SZ")
        
        clean_desc = notes.replace("\n", "\\n")
        
        try:
            trigger_minutes = int(quest.get('reminder_minutes', 15))
        except (ValueError, TypeError):
            trigger_minutes = 15

        ics_content = f"""BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//The Sanctuary//Quest Giver//EN
CALSCALE:GREGORIAN
METHOD:PUBLISH
BEGIN:VEVENT
UID:{quest_id}@thesanctuary
DTSTAMP:{stamp_str}
DTSTART:{start_str}
DTEND:{end_str}
SUMMARY:{title}
DESCRIPTION:{clean_desc}
LOCATION:{location}
BEGIN:VALARM
TRIGGER:-PT{trigger_minutes}M
ACTION:DISPLAY
DESCRIPTION:Reminder: {title} is due soon!
END:VALARM
END:VEVENT
END:VCALENDAR"""

        return Response(
            ics_content.strip(),
            mimetype="text/calendar",
            headers={"Content-Disposition": f"attachment; filename=\"{quest_id}.ics\""}
        )
    except Exception as e:
        print(f"Error downloading quest {quest_id}: {e}")
        return jsonify({"error": str(e)}), 500



@app.route('/api/sessions', methods=['GET'])
@requires_auth
def list_sessions():
    try:
        active_program = os.environ.get("ACTIVE_PROGRAM", "sebile")
        sessions_dir = os.path.join(base_dir, "core", "programs", active_program, "sessions")
        
        sessions = []
        if os.path.exists(sessions_dir):
            for file in os.listdir(sessions_dir):
                if file.endswith('.json') and not file.endswith('_voice.json'):
                    session_name = file[:-5]
                    sessions.append(session_name)
        
        # Ensure 'default' is always in the list
        if 'default' not in sessions:
            sessions.insert(0, 'default')
        else:
            sessions.remove('default')
            sessions.insert(0, 'default')
            
        return jsonify({
            'status': 'success',
            'sessions': sessions
        })
    except Exception as e:
        print(f"Error listing sessions: {e}")
        return jsonify({'error': str(e)}), 500



@app.route('/api/programs', methods=['GET'])
@requires_auth
def list_programs():
    try:
        active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
        from variables import PROGRAMS_DIR
        programs_dir = PROGRAMS_DIR
        
        programs = []
        if os.path.exists(programs_dir):
            for folder in os.listdir(programs_dir):
                folder_path = os.path.join(programs_dir, folder)
                if os.path.isdir(folder_path):
                    program_name = folder.title()
                    json_path = os.path.join(folder_path, f"{folder}.json")
                    if os.path.exists(json_path):
                        try:
                            with open(json_path, "r", encoding="utf-8") as jf:
                                jdata = json.load(jf)
                                # Unwrap v3 data block
                                card = jdata.get("data", jdata)
                                if card.get("name"):
                                    program_name = card["name"]
                        except Exception:
                            pass
                    else:
                        for file in os.listdir(folder_path):
                            if file.lower().endswith('.md') and not file.lower().startswith('user'):
                                program_name = os.path.splitext(file)[0].title()
                                break
                    # Read theme color from theme.json
                    theme_color = "#38bdf8"
                    tdata = load_theme(folder)
                    if tdata:
                        theme_color = tdata.get("primary_accent") or tdata.get("main_color") or theme_color
                            
                    # Check if portraits/profile.png exists
                    has_profile = False
                    profile_path = os.path.join(folder_path, "portraits", "profile.png")
                    if os.path.exists(profile_path):
                        has_profile = True
                        
                    programs.append({
                        'id': folder,
                        'name': program_name,
                        'active': folder == active_program,
                        'theme_color': theme_color,
                        'has_profile': has_profile
                    })
        return jsonify({'programs': programs, 'active': active_program})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/programs/select', methods=['POST'])
@requires_auth
def select_program():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # Update environment variable
        os.environ["ACTIVE_PROGRAM"] = program_id
        
        # Update active program settings
        try:
            from utils.program import set_active_program
            set_active_program(program_id)
        except Exception as e:
            print(f"Error persisting ACTIVE_PROGRAM: {e}")
        

        reload_program_state()
        if hasattr(runner, 'sessions_inversion_state'):
            runner.sessions_inversion_state.clear()
            
        theme = load_theme(program_id)

        has_profile = False
        profile_path = os.path.join(program_path, "portraits", "profile.png")
        if os.path.exists(profile_path):
            has_profile = True

        from core.program_config import program_name
        return jsonify({
            'status': 'success',
            'active': program_id,
            'character_name': program_name,
            'theme': theme,
            'has_profile': has_profile
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        try:
            with open('server_error.log', 'w', encoding='utf-8') as lf:
                traceback.print_exc(file=lf)
        except Exception:
            pass
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/palette', methods=['POST'])
@requires_auth
def update_program_palette():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        color = data.get('color')
        
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
        if not color:
            return jsonify({'error': 'Missing color'}), 400
            
        # Validate hex color
        if not re.match(r'^#[0-9a-fA-F]{6}$', color):
            return jsonify({'error': 'Invalid hex color format. Must be #RRGGBB'}), 400
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # Regenerate theme.json
        theme_data = generate_character_theme(color)
        theme_path = os.path.join(program_path, "theme.json")
        with open(theme_path, "w", encoding="utf-8") as tf:
            json.dump(theme_data, tf, indent=2, ensure_ascii=False)
            
        return jsonify({
            'status': 'success',
            'program_id': program_id,
            'color': color,
            'theme': theme_data
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/delete', methods=['POST'])
@requires_auth
def delete_program():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
            
        if program_id == 'sebile':
            return jsonify({'error': 'Cannot delete default program Sebile'}), 400
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # If the deleted program is currently active, switch to Sebile first
        from utils.program import get_active_program, set_active_program
        active_program = get_active_program()
        is_active = (program_id == active_program)
        if is_active:
            os.environ["ACTIVE_PROGRAM"] = "sebile"
            try:
                set_active_program("sebile")
            except Exception as e:
                print(f"Error resetting active program to sebile: {e}")
                
            # Reload program config and re-initialize the runner
            reload_program_state()
                 
        # Delete the program folder recursively
        shutil.rmtree(program_path)
        
        return jsonify({'status': 'success', 'switched_to': 'sebile' if is_active else None})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/rename', methods=['POST'])
@requires_auth
def rename_program():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        new_name = data.get('new_name', '').strip()
        
        if not program_id or not new_name:
            return jsonify({'error': 'Missing program_id or new_name'}), 400
            
        if not re.match(r'^[a-zA-Z0-9_\-]+$', program_id):
            return jsonify({'error': 'Invalid program_id'}), 400
            
        new_id = re.sub(r'[^a-zA-Z0-9_]', '', new_name).lower()
        if not new_id:
            return jsonify({'error': 'Invalid new name (must contain letters, numbers, or underscores)'}), 400
            
        from variables import PROGRAMS_DIR
        old_path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id))
        new_path = os.path.normpath(os.path.join(PROGRAMS_DIR, new_id))
        
        if not os.path.exists(old_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # If the program is sebile, we keep the folder/id as 'sebile' but update the name in sebile.json
        if program_id == 'sebile':
            json_path = os.path.join(old_path, "sebile.json")
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        jdata = json.load(f)
                    jdata["name"] = new_name
                    with open(json_path, "w", encoding="utf-8") as f:
                        json.dump(jdata, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"Error updating Sebile JSON: {e}")
            
            # Reload configuration
            reload_program_state()
            
            active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
            return jsonify({
                'status': 'success',
                'new_id': 'sebile',
                'was_active': (active_program == 'sebile')
            })
            
        # If new_id is different from program_id, perform folder rename
        if new_id != program_id:
            if os.path.exists(new_path):
                return jsonify({'error': f"A program folder named '{new_id}' already exists"}), 400
                
            # Perform directory rename
            shutil.move(old_path, new_path)
            
            # Inside the new directory, rename the json file: old_id.json -> new_id.json
            old_json = os.path.join(new_path, f"{program_id}.json")
            new_json = os.path.join(new_path, f"{new_id}.json")
            if os.path.exists(old_json):
                shutil.move(old_json, new_json)
                
            # Also update fields inside the json file
            if os.path.exists(new_json):
                try:
                    with open(new_json, "r", encoding="utf-8") as f:
                        jdata = json.load(f)
                    data_block = jdata.get("data", jdata)
                    data_block["name"] = new_name
                    exts = data_block.setdefault("extensions", {})
                    sanctuary = exts.setdefault("sanctuary", {})
                    sanctuary["program_id"] = new_id
                    if "character_book" in data_block and isinstance(data_block["character_book"], dict):
                        data_block["character_book"]["name"] = new_name
                    with open(new_json, "w", encoding="utf-8") as f:
                        json.dump(jdata, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"Error updating JSON after rename: {e}")
                    
            # Check if active program
            active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
            was_active = (program_id == active_program)
            
            # Update settings (active_program, folders, program_voices)
            from utils.program import _load_settings, _save_settings
            settings = _load_settings()
            
            if was_active:
                os.environ["ACTIVE_PROGRAM"] = new_id
                settings["active_program"] = new_id
                settings["folders"] = [new_path]
                
            if "program_voices" in settings:
                if program_id in settings["program_voices"]:
                    settings["program_voices"][new_id] = settings["program_voices"].pop(program_id)
                    
            _save_settings(settings)
            
            # Reload configuration
            reload_program_state()
            
            return jsonify({
                'status': 'success',
                'new_id': new_id,
                'was_active': was_active
            })
        else:
            # ID is the same, no directory rename needed
            json_path = os.path.join(old_path, f"{program_id}.json")
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        jdata = json.load(f)
                    data_block = jdata.get("data", jdata)
                    data_block["name"] = new_name
                    if "character_book" in data_block and isinstance(data_block["character_book"], dict):
                        data_block["character_book"]["name"] = new_name
                    with open(json_path, "w", encoding="utf-8") as f:
                        json.dump(jdata, f, indent=2, ensure_ascii=False)
                except Exception as e:
                    print(f"Error updating JSON name: {e}")
                    
            active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
            return jsonify({
                'status': 'success',
                'new_id': program_id,
                'was_active': (program_id == active_program)
            })
            
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/profile', methods=['GET'])
@requires_auth
def get_program_profile():
    try:
        from utils.program import get_active_program, _load_settings
        from variables import PROGRAMS_DIR
        import json

        program_id = request.args.get('program_id') or get_active_program()
        json_path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id, f"{program_id}.json"))

        card_data = {}
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    raw = json.load(f)
                card_data = raw.get('data', raw)
            except Exception:
                pass

        # Inject tts_voice from project settings (stored separately)
        settings = _load_settings()
        program_voices = settings.get('program_voices', {})
        card_data['tts_voice'] = program_voices.get(program_id, settings.get('tts_voice', 'af_heart'))
        card_data['narration_mode'] = settings.get('narration_mode', False)


        return jsonify(card_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500



@app.route('/api/programs/profile/save', methods=['POST'])
@requires_auth
def save_program_profile():
    try:
        from utils.program import get_active_program, set_tts_voice_for_program, _load_settings, _save_settings
        from variables import PROGRAMS_DIR
        import json

        incoming = request.get_json(silent=True) or {}
        program_id = incoming.get('program_id') or get_active_program()
        json_path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id, f"{program_id}.json"))

        # Extract sidecars before writing card
        tts_voice = incoming.pop('tts_voice', None)
        narration_mode = incoming.pop('narration_mode', None)
        incoming.pop('program_id', None)

        if tts_voice:
            set_tts_voice_for_program(program_id, tts_voice)

        if narration_mode is not None:
            settings = _load_settings()
            settings['narration_mode'] = bool(narration_mode)
            _save_settings(settings)

        # Load existing card to preserve spec envelope and any fields not sent by UI
        existing = {}
        if os.path.exists(json_path):
            try:
                with open(json_path, 'r', encoding='utf-8') as f:
                    existing = json.load(f)
            except Exception:
                pass

        # Merge incoming data block into existing card
        if existing.get('spec') == 'chara_card_v3' and 'data' in existing:
            existing['data'].update(incoming)
            card_to_write = existing
        else:
            card_to_write = {
                'spec': 'chara_card_v3',
                'spec_version': '3.0',
                'data': incoming
            }

        os.makedirs(os.path.dirname(json_path), exist_ok=True)
        with open(json_path, 'w', encoding='utf-8') as f:
            json.dump(card_to_write, f, indent=2, ensure_ascii=False)

        reload_program_state()
        return jsonify({'status': 'success'})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500



@app.route('/api/programs/journals', methods=['GET'])
@requires_auth
def get_program_journals():
    try:
        from utils.program import get_active_program
        from utils.journals import get_journal_entries
        
        program_id = request.args.get('program_id') or get_active_program()
        entries = get_journal_entries(program_id)
        return jsonify({'journals': entries})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/journals/save', methods=['POST'])
@requires_auth
def save_program_journals():
    try:
        from utils.program import get_active_program
        from utils.journals import get_journal_entries, save_journal_entries, add_journal_entry
        
        data = request.get_json(silent=True) or {}
        entry_id = data.get('id')
        keyphrases_str = data.get('keyphrases', '')
        content = data.get('content', '')
        program_id = data.get('program_id') or get_active_program()
        
        if entry_id:
            entries = get_journal_entries(program_id)
            found = False
            for entry in entries:
                if entry.get("id") == entry_id:
                    entry["keyphrases"] = [k.strip().lower() for k in keyphrases_str.split(",") if k.strip()]
                    entry["content"] = content.strip()[:300]
                    found = True
                    break
            if found:
                save_journal_entries(entries, program_id)
                return jsonify({'status': 'success'})
            else:
                return jsonify({'error': 'Journal entry not found'}), 404
        else:
            add_journal_entry(keyphrases_str, content, program_id)
            return jsonify({'status': 'success'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/journals/delete', methods=['POST'])
@requires_auth
def delete_program_journals():
    try:
        from utils.program import get_active_program
        from utils.journals import delete_journal_entry
        
        data = request.get_json(silent=True) or {}
        entry_id = data.get('id')
        program_id = data.get('program_id') or get_active_program()
        
        if not entry_id:
            return jsonify({'error': 'Missing entry id'}), 400
            
        success = delete_journal_entry(entry_id, program_id)
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Failed to delete or entry not found'}), 404
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/user_profiles', methods=['GET'])
@requires_auth
def list_user_profiles():
    try:
        from variables import USER_PROFILES_DIR
        from utils.program import get_active_user
        if not os.path.exists(USER_PROFILES_DIR):
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
        
        # Get active user profile
        active_user = get_active_user()
        
        profiles = []
        for file in os.listdir(USER_PROFILES_DIR):
            if file.lower().endswith(".md"):
                profile_name = os.path.splitext(file)[0]
                profile_path = os.path.join(USER_PROFILES_DIR, file)
                try:
                    with open(profile_path, "r", encoding="utf-8") as pf:
                        content = pf.read()
                    profiles.append({
                        "id": profile_name,
                        "name": profile_name.replace("_", " ").title(),
                        "content": content
                    })
                except Exception as e:
                    print(f"Error reading profile {file}: {e}")
        
        # If there are no profiles at all, ensure at least "builder" is present
        if not profiles:
            builder_path = os.path.join(USER_PROFILES_DIR, "builder.md")
            default_content = "# USER CONTEXT: BUILDER\n- A software developer and code builder.\n- Hobby: Collects cute AI program programs in the Sanctuary.\n"
            with open(builder_path, "w", encoding="utf-8") as f:
                f.write(default_content)
            profiles.append({
                "id": "builder",
                "name": "Builder",
                "content": default_content
            })

        return jsonify({"profiles": profiles, "active": active_user})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/user_profiles/select', methods=['POST'])
@requires_auth
def select_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        profile_id = data.get("profile_id")
        if not profile_id:
            return jsonify({"error": "Missing profile_id"}), 400
        
        from variables import USER_PROFILES_DIR
        from utils.program import set_active_user
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        if not os.path.exists(profile_path):
            return jsonify({"error": f"Profile '{profile_id}' does not exist"}), 404
        
        # Update active user profile settings
        set_active_user(profile_id)
        
        # Re-initialize the program config module and runner
        reload_program_state()
            
        return jsonify({"status": "success", "active": profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/user_profiles/save', methods=['POST'])
@requires_auth
def save_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        profile_id = data.get("profile_id")
        content = data.get("content")
        
        if not profile_id:
            return jsonify({"error": "Missing profile_id"}), 400
        if content is None:
            return jsonify({"error": "Missing content"}), 400
        
        # Sanitize profile_id
        profile_id = re.sub(r'[^a-zA-Z0-9_\-]', '', profile_id).lower()
        if not profile_id:
            return jsonify({"error": "Invalid profile name"}), 400
            
        from variables import USER_PROFILES_DIR
        from utils.program import get_active_user
        if not os.path.exists(USER_PROFILES_DIR):
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
            
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        with open(profile_path, "w", encoding="utf-8") as f:
            f.write(content)
            
        # Read active profile
        active_user = get_active_user()
        
        # If we edited the active profile, trigger hot reload immediately
        if profile_id == active_user:
            reload_program_state()
                
        return jsonify({"status": "success", "profile_id": profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/user_profiles/delete', methods=['POST'])
@requires_auth
def delete_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        profile_id = data.get("profile_id")
        if not profile_id:
            return jsonify({"error": "Missing profile_id"}), 400
            
        if profile_id == "builder":
            return jsonify({"error": "Cannot delete the default 'builder' profile"}), 400
            
        from variables import USER_PROFILES_DIR
        from utils.program import get_active_user, set_active_user
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        if not os.path.exists(profile_path):
            return jsonify({"error": f"Profile '{profile_id}' does not exist"}), 404
            
        # Delete file
        os.remove(profile_path)
        
        # If the deleted profile was active, switch active profile back to "builder"
        active_user = get_active_user()
                
        if profile_id == active_user:
            set_active_user("builder")
            reload_program_state()
                
        return jsonify({"status": "success", "deleted": profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/api/user_profiles/rename', methods=['POST'])
@requires_auth
def rename_user_profile():
    try:
        data = request.get_json(silent=True) or {}
        old_profile_id = data.get("old_profile_id")
        new_name = data.get("new_profile_name")
        
        if not old_profile_id or not new_name:
            return jsonify({"error": "Missing old_profile_id or new_profile_name"}), 400
            
        if old_profile_id == "builder":
            return jsonify({"error": "Cannot rename the default 'builder' profile"}), 400
            
        new_profile_id = re.sub(r'[^a-zA-Z0-9_\-]', '', new_name).strip().replace(' ', '_').lower()
        new_profile_id = re.sub(r'_+', '_', new_profile_id)
        
        if not new_profile_id:
            return jsonify({"error": "Invalid new profile name"}), 400
            
        if new_profile_id == "builder":
            return jsonify({"error": "Cannot rename a profile to 'builder'"}), 400
            
        if old_profile_id == new_profile_id:
            return jsonify({"status": "success", "profile_id": new_profile_id})
            
        from variables import USER_PROFILES_DIR
        from utils.program import get_active_user, set_active_user
        old_path = os.path.join(USER_PROFILES_DIR, f"{old_profile_id}.md")
        new_path = os.path.join(USER_PROFILES_DIR, f"{new_profile_id}.md")
        
        if not os.path.exists(old_path):
            return jsonify({"error": f"Profile '{old_profile_id}' does not exist"}), 404
            
        if os.path.exists(new_path):
            return jsonify({"error": f"Profile '{new_profile_id}' already exists"}), 400
            
        # Rename file
        os.rename(old_path, new_path)
        
        # Check active user
        active_user = get_active_user()
                
        # If the renamed profile was active, update and reload
        if old_profile_id == active_user:
            set_active_user(new_profile_id)
            reload_program_state()
                
        return jsonify({"status": "success", "profile_id": new_profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500



def generate_character_theme(main_color, accent_color_a=None, accent_color_b=None):
    hex_clean = main_color.lstrip('#')
    r = int(hex_clean[0:2], 16)
    g = int(hex_clean[2:4], 16)
    b = int(hex_clean[4:6], 16)
    
    brightness = (r * 299 + g * 587 + b * 114) / 1000
    btn_text = "#121214" if brightness > 140 else "#ffffff"
    
    if not accent_color_a:
        accent_r = min(255, int(r + (255 - r) * 0.25))
        accent_g = min(255, int(g + (255 - g) * 0.25))
        accent_b = min(255, int(b + (255 - b) * 0.25))
        accent_color_a = f"#{accent_r:02x}{accent_g:02x}{accent_b:02x}"
    if not accent_color_b:
        accent_color_b = main_color
        
    return {
        "primary_accent": main_color,
        "main_color": main_color,
        "accent_color_a": accent_color_a,
        "accent_color_b": accent_color_b,
        "primary_glow": f"rgba({r}, {g}, {b}, 0.08)",
        "program_bubble": f"rgba({24 + int(r*0.04)}, {24 + int(g*0.04)}, {28 + int(b*0.04)}, 0.85)",
        "send_btn_hover": f"rgba({20 + int(r*0.12)}, {20 + int(g*0.12)}, {22 + int(b*0.12)}, 0.75)",
        "accent_green": accent_color_a,
        "quote_blue": main_color,
        "primary_btn_text": btn_text
    }

# Obsolete sprite and theme color generation functions removed


def generate_character_json(name, description, personality, scenario, first_mes, model):
    """Ask the LLM to produce chara_card_v3-compatible fields for a new program."""
    import os, json
    remote_key = os.getenv("REMOTE_API_KEY")
    remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
    is_remote_configured = bool(
        remote_key and remote_key.strip() and remote_key != "your_remote_api_key_here" and
        remote_cloud_url and remote_cloud_url.strip() and remote_cloud_url != "your_remote_cloud_url_here"
    )

    prompt = f"""Design a SillyTavern chara_card_v3 character profile from the description below.

Input:
  Name: {name}
  Description: {description}
  Personality hint: {personality or 'not specified'}
  Scenario hint: {scenario or 'not specified'}
  First message hint: {first_mes or 'not specified'}

Output a single JSON object with EXACTLY these keys:
{{
  "description": "2-4 sentence narrative bio. No physical appearance.",
  "personality": "One word (e.g. Devoted, Sassy, Stoic).",
  "scenario": "Short scene-setting sentence (one sentence).",
  "first_mes": "In-character opening message (1-2 sentences, first person).",
  "system_prompt": "Concise response style directive (e.g. contractions, tone, length).",
  "image_positive": "Comma-separated Stable Diffusion tags for ONLY physical appearance (e.g. silver hair, purple eyes, fair skin).",
  "image_negative": "Comma-separated SD negative tags to exclude (e.g. extra limbs, bad anatomy).",
  "main_color": "#RRGGBB — a hex color representing this character.",
  "inversion": {{
    "intimate": "How they behave when intimate/warm.",
    "excited": "How they behave when excited/playful.",
    "intense": "How they behave when intense/focused.",
    "sad": "How they behave when sad/empathetic."
  }}
}}"""

    raw_response = None
    from utils.models import is_local_model
    use_local = is_local_model(model)

    if use_local:
        try:
            import httpx
            local_url = os.getenv("REMOTE_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
            local_model = model if (model and model != 'local-llm') else os.getenv("LOCAL_MODEL_NAME", "local-llm")
            payload = {
                "model": local_model,
                "messages": [
                    {"role": "system", "content": "You output valid JSON character cards."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.5,
                "response_format": {"type": "json_object"}
            }
            res = httpx.post(local_url, json=payload, headers={"Content-Type": "application/json"}, timeout=60.0)
            if res.status_code == 200:
                raw_response = res.json()['choices'][0]['message']['content'].strip()
        except Exception as e:
            print(f"Error calling local model for card generation: {e}")
    else:
        if is_remote_configured:
            try:
                import requests
                from variables import DEFAULT_REMOTE_MODEL
                target_model = model if model else DEFAULT_REMOTE_MODEL
                headers = {"Content-Type": "application/json", "Authorization": f"Bearer {remote_key}"}
                payload = {
                    "model": target_model,
                    "messages": [
                        {"role": "system", "content": "You output valid JSON character cards."},
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": 0.5,
                    "response_format": {"type": "json_object"}
                }
                res = requests.post(remote_cloud_url, json=payload, headers=headers, timeout=60.0)
                if res.status_code == 200:
                    raw_response = res.json()['choices'][0]['message']['content'].strip()
            except Exception as e:
                print(f"Error calling remote model for card generation: {e}")

    parsed = {}
    if raw_response:
        try:
            cleaned = raw_response.strip().lstrip('```json').lstrip('```').rstrip('```').strip()
            parsed = json.loads(cleaned)
        except Exception as e:
            print(f"Failed to parse card JSON: {e}. Raw: {raw_response}")

    # Build a chara_card_v3 dict. Helper keys _inversion and _colors are
    # popped by finalize_imported_program before writing to disk.
    card = {
        "spec": "chara_card_v3",
        "spec_version": "3.0",
        "data": {
            "name": name or parsed.get("name") or "Program",
            "description": parsed.get("description") or description or f"{name} is a new program.",
            "personality": parsed.get("personality") or personality or "Friendly",
            "scenario": parsed.get("scenario") or scenario or "A comfortable room.",
            "first_mes": parsed.get("first_mes") or first_mes or f"Hello, I'm {name}.",
            "mes_example": "",
            "system_prompt": parsed.get("system_prompt") or "Speak naturally using contractions. Be warm and concise.",
            "post_history_instructions": "",
            "creator_notes": "",
            "tags": [],
            "creator": "LM-Sanctuary",
            "character_version": "1.0",
            "alternate_greetings": [],
            "extensions": {
                "sanctuary": {
                    "program_id": "",  # filled by finalize_imported_program
                    "image_details": {
                        "positive": parsed.get("image_positive") or f"solo, {name}",
                        "negative": parsed.get("image_negative") or "extra limbs, bad anatomy, deformed"
                    }
                }
            }
        },
        # Helper keys consumed by finalize_imported_program
        "_inversion": parsed.get("inversion") or {
            "intimate": f"{name} is now deeply affectionate and tender.",
            "excited": f"{name} is now playful and energetic.",
            "intense": f"{name} is now focused and direct.",
            "sad": f"{name} is now empathetic and gentle."
        },
        "_colors": {"main_color": parsed.get("main_color") or "#38bdf8"},
    }
    return card


def finalize_imported_program(program_path, program_id, card_json):
    """Write inversion, theme, portraits dir, and chara_card_v3 JSON for a new program."""
    # Pop helper keys (not part of the card spec)
    inversion = card_json.pop("_inversion", None) or card_json.pop("inversion", None) or {}
    colors = card_json.pop("_colors", None) or card_json.pop("colors", None) or {}

    # Write inversion.json
    with open(os.path.join(program_path, 'inversion.json'), "w", encoding="utf-8") as f:
        json.dump(inversion, f, indent=2, ensure_ascii=False)

    # Generate theme from main_color
    main_color = colors.get("main_color", "#38bdf8")
    theme_data = generate_character_theme(main_color)
    with open(os.path.join(program_path, 'theme.json'), "w", encoding="utf-8") as tf:
        json.dump(theme_data, tf, indent=2, ensure_ascii=False)

    os.makedirs(os.path.join(program_path, 'portraits'), exist_ok=True)

    # Stamp program_id into the sanctuary extension
    if card_json.get("data"):
        exts = card_json["data"].setdefault("extensions", {})
        exts.setdefault("sanctuary", {})["program_id"] = program_id
    else:
        # Legacy flat format fallback
        card_json["program_id"] = program_id

    with open(os.path.join(program_path, f"{program_id}.json"), "w", encoding="utf-8") as f:
        json.dump(card_json, f, indent=2, ensure_ascii=False)


@app.route('/api/programs/<program_id>/export/card', methods=['GET'])
@requires_auth
def export_program_card(program_id):
    """Download the program's card as a SillyTavern-compatible JSON file."""
    try:
        card_path = os.path.join(base_dir, 'core', 'programs', program_id, f'{program_id}.json')
        if not os.path.exists(card_path):
            return jsonify({'error': 'Program not found'}), 404
        with open(card_path, encoding='utf-8') as f:
            card_data = json.load(f)
        name = card_data.get('data', card_data).get('name', program_id)
        safe_name = re.sub(r'[^\w\- ]', '', name).strip().replace(' ', '_') or program_id
        # Export only ST-spec keys — strip Sanctuary internals from root
        export_data = {k: v for k, v in card_data.items() if k in ('spec', 'spec_version', 'data')}
        resp = make_response(json.dumps(export_data, indent=2, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/json'
        resp.headers['Content-Disposition'] = f'attachment; filename="{safe_name}.json"'
        return resp
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/<program_id>/export/lorebook', methods=['GET'])
@requires_auth
def export_program_lorebook(program_id):
    """Download the embedded character_book as a standalone lorebook JSON."""
    try:
        card_path = os.path.join(base_dir, 'core', 'programs', program_id, f'{program_id}.json')
        if not os.path.exists(card_path):
            return jsonify({'error': 'Program not found'}), 404
        with open(card_path, encoding='utf-8') as f:
            card_data = json.load(f)
        cb = card_data.get('data', card_data).get('character_book')
        if not cb:
            return jsonify({'error': 'No embedded lorebook found'}), 404
        name = card_data.get('data', card_data).get('name', program_id)
        safe_name = re.sub(r'[^\w\- ]', '', name).strip().replace(' ', '_') or program_id
        resp = make_response(json.dumps(cb, indent=2, ensure_ascii=False))
        resp.headers['Content-Type'] = 'application/json'
        resp.headers['Content-Disposition'] = f'attachment; filename="{safe_name}_lorebook.json"'
        return resp
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/import/tavern', methods=['POST'])
@requires_auth
def import_tavern_program():
    try:
        if 'card' not in request.files:
            return jsonify({'error': 'No card file provided'}), 400

        file = request.files['card']
        if not file.filename:
            return jsonify({'error': 'No file selected'}), 400

        import re, base64
        from PIL import Image

        temp_dir = os.path.join(base_dir, 'backups')
        os.makedirs(temp_dir, exist_ok=True)
        temp_path = os.path.join(temp_dir, 'temp_tavern_card.png')
        file.save(temp_path)

        try:
            with Image.open(temp_path) as img:
                chara_data = None
                for key in ('chara', 'ccv3', 'Character'):
                    if key in img.info:
                        chara_data = img.info[key]
                        break
                if not chara_data:
                    for key, val in img.info.items():
                        if isinstance(val, str) and len(val) > 20:
                            try:
                                test_json = json.loads(val)
                                if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json):
                                    chara_data = val
                                    break
                            except Exception:
                                try:
                                    decoded = base64.b64decode(val).decode('utf-8')
                                    test_json = json.loads(decoded)
                                    if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json):
                                        chara_data = val
                                        break
                                except Exception:
                                    pass

                if not chara_data:
                    raise ValueError("No character metadata chunk found in PNG card.")

                try:
                    chara = json.loads(base64.b64decode(chara_data).decode('utf-8'))
                except Exception:
                    chara = json.loads(chara_data)

        except Exception as e:
            if os.path.exists(temp_path):
                try: os.remove(temp_path)
                except Exception: pass
            return jsonify({'error': f"Failed to parse Tavern card: {str(e)}"}), 400

        finally:
            if os.path.exists(temp_path):
                try: os.remove(temp_path)
                except Exception: pass

        # --- Convert to chara_card_v3 (bypass LLM — use the card data directly) ---
        spec = chara.get('spec', '')
        if spec == 'chara_card_v3':
            # Already v3 — use verbatim
            card_v3 = chara
            data_block = card_v3.get('data', {})
        else:
            # v1 / v2 flat or wrapped — normalise to v3
            data_block = chara.get('data', chara)
            card_v3 = {
                "spec": "chara_card_v3",
                "spec_version": "3.0",
                "data": {
                    "name": data_block.get("name", "Program"),
                    "description": data_block.get("description", ""),
                    "personality": data_block.get("personality", ""),
                    "scenario": data_block.get("scenario", ""),
                    "first_mes": data_block.get("first_mes", ""),
                    "mes_example": data_block.get("mes_example", ""),
                    "system_prompt": data_block.get("system_prompt", ""),
                    "post_history_instructions": data_block.get("post_history_instructions", ""),
                    "creator_notes": data_block.get("creator_notes", ""),
                    "tags": data_block.get("tags", []),
                    "creator": data_block.get("creator", ""),
                    "character_version": data_block.get("character_version", "1.0"),
                    "alternate_greetings": data_block.get("alternate_greetings", []),
                    "character_book": data_block.get("character_book"),
                    "extensions": data_block.get("extensions", {}),
                }
            }
            # Remove None character_book
            if card_v3["data"]["character_book"] is None:
                del card_v3["data"]["character_book"]

        name = card_v3["data"].get("name", "Program").strip()
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower() or ("program_" + str(int(time.time())))
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400
        os.makedirs(program_path, exist_ok=True)

        # Ensure sanctuary extension block
        exts = card_v3["data"].setdefault("extensions", {})
        sanctuary = exts.setdefault("sanctuary", {})
        sanctuary["program_id"] = program_id
        if "image_details" not in sanctuary:
            sanctuary["image_details"] = {"positive": "", "negative": ""}

        # Derive inversion and color from existing extensions or use defaults
        inversion = sanctuary.pop("inversion", None) or {
            "intimate": f"{name} is now deeply affectionate and tender.",
            "excited": f"{name} is now playful and energetic.",
            "intense": f"{name} is now focused and direct.",
            "sad": f"{name} is now empathetic and gentle."
        }
        main_color = sanctuary.pop("main_color", None) or "#38bdf8"

        card_v3["_inversion"] = inversion
        card_v3["_colors"] = {"main_color": main_color}

        finalize_imported_program(program_path, program_id, card_v3)
        return jsonify({'status': 'success', 'program_id': program_id, 'name': name})

    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/import/describe', methods=['POST'])
@requires_auth
def import_describe_program():
    try:
        data = request.get_json(silent=True) or {}
        name = data.get('name', '').strip()
        description = data.get('description', '').strip()
        model = data.get('model', '').strip()
        
        if not name or not description:
            return jsonify({'error': 'Name and description are required'}), 400
            
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower()
        if not program_id:
            program_id = "program_" + str(int(time.time()))
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400
            
        os.makedirs(program_path, exist_ok=True)
        
        # Call consolidated JSON generator
        card_json = generate_character_json(name, description, "", "", "", model)
        
        # Finalize program files (inversion, theme, portraits, and JSON profile)
        finalize_imported_program(program_path, program_id, card_json)
            
        return jsonify({'status': 'success', 'program_id': program_id, 'name': name})
    except Exception as e:
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# --- Server-Sent Events (SSE) for Live Connection Status ---
import queue as _queue

_sse_clients = []
_sse_clients_lock = threading.Lock()
_last_broadcast_state = {}

def _get_current_status():
    """Build the combined connection status payload."""
    from utils import local_llm_manager, comfy_manager
    remote_key = os.getenv("REMOTE_API_KEY")
    remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
    is_remote_configured = bool(
        remote_key and remote_key.strip() and remote_key != "your_remote_api_key_here" and
        remote_cloud_url and remote_cloud_url.strip() and remote_cloud_url != "your_remote_cloud_url_here"
    )
    
    # Load temperature dynamically
    temperature = 0.95
    try:
        from variables import VARIABLES_DIR
        settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
                temperature = settings.get("temperature", 0.95)
    except Exception:
        pass
        
    comfy_running_state = comfy_manager.check_comfy_running(force_refresh=True)
    if not comfy_running_state and getattr(comfy_manager, '_starting', False):
        comfy_running_state = "starting"
        
    return {
        "remote_configured": is_remote_configured,
        "remote_model": os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite"),
        "remote_url": remote_cloud_url,
        "local_online": local_llm_manager.check_status(),
        "local_installed": local_llm_manager.check_installed(),
        "comfy_installed": comfy_manager.check_comfy_installed(),
        "comfy_running": comfy_running_state,
        "temperature": temperature,
        "env_path": os.path.abspath(os.path.join(base_dir, '.env')),
    }

def broadcast_status():
    """Push current status to all connected SSE clients (only if state changed)."""
    global _last_broadcast_state
    status = _get_current_status()
    # Deduplicate: only broadcast when state actually changed
    if status == _last_broadcast_state:
        return
    _last_broadcast_state = status.copy()
    data = json.dumps({"type": "connection_status", "status": status})
    msg = f"event: connection_status\ndata: {data}\n\n"
    with _sse_clients_lock:
        dead = []
        for q in _sse_clients:
            try:
                q.put_nowait(msg)
            except _queue.Full:
                dead.append(q)
        for q in dead:
            _sse_clients.remove(q)

def _status_monitor():
    """Background thread that detects external state changes (crashes, manual stops)."""
    while True:
        time.sleep(5)
        try:
            broadcast_status()
        except Exception:
            pass

_monitor_thread = threading.Thread(target=_status_monitor, daemon=True)
_monitor_thread.start()

@app.route('/api/events/status')
@requires_auth
def sse_status_stream():
    """SSE endpoint for live connection status updates."""
    q = _queue.Queue(maxsize=50)
    with _sse_clients_lock:
        _sse_clients.append(q)

    def stream():
        try:
            # Send initial status immediately
            status = _get_current_status()
            data = json.dumps({"type": "connection_status", "status": status})
            yield f"event: connection_status\ndata: {data}\n\n"
            while True:
                try:
                    msg = q.get(timeout=15)
                    yield msg
                except _queue.Empty:
                    # Keepalive comment to prevent proxy/browser timeout
                    yield ":\n\n"
        except GeneratorExit:
            pass
        finally:
            with _sse_clients_lock:
                if q in _sse_clients:
                    _sse_clients.remove(q)

    return Response(stream(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    })


# --- Headless Local LLM & Hugging Face Integration API ---
from utils import local_llm_manager
from utils import comfy_manager

# Wire SSE broadcast callbacks into both managers
from utils import local_runner
local_runner._on_status_change = broadcast_status
comfy_manager._on_status_change = broadcast_status

@app.route('/api/local_llm/status', methods=['GET'])
@requires_auth
def local_llm_status():
    installed = local_llm_manager.check_installed()
    online = local_llm_manager.check_status()
    loaded_models = []
    if online is True:
        from utils.models import fetch_local_models
        loaded_models = [m["value"] for m in fetch_local_models()]
    
    downloaded_models = local_llm_manager.list_local_models()
    local_llm_manager.update_download_statuses()
    
    return jsonify({
        "installed": installed,
        "online": online,
        "loaded_models": loaded_models,
        "downloaded_models": downloaded_models,
        "download_status": local_llm_manager.download_status
    })

@app.route('/api/local_llm/install', methods=['POST'])
@requires_auth
def local_llm_install():
    success, message = local_llm_manager.install_server()
    return jsonify({"success": success, "message": message})

@app.route('/api/local_llm/search', methods=['GET'])
@requires_auth
def local_llm_search():
    query = request.args.get('query', '').strip()
    if not query:
        return jsonify({"results": []})
    results = local_llm_manager.search_huggingface_repos(query)
    return jsonify({"results": results})

@app.route('/api/local_llm/huggingface/files', methods=['GET'])
@requires_auth
def local_llm_hf_files():
    repo_id = request.args.get('repo_id', '').strip()
    if not repo_id:
        return jsonify({"error": "Missing repo_id"}), 400
    files = local_llm_manager.get_huggingface_repo_files(repo_id)
    return jsonify({"files": files})

@app.route('/api/local_llm/download', methods=['POST'])
@requires_auth
def local_llm_download():
    model_name = request.json.get('model_name')
    quantization = request.json.get('quantization')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = local_llm_manager.trigger_download(model_name, quantization)
    return jsonify({"success": success, "message": message})

@app.route('/api/local_llm/load', methods=['POST'])
@requires_auth
def local_llm_load():
    model_name = request.json.get('model_name')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = local_llm_manager.load_local_model(model_name)
    return jsonify({"success": success, "message": message})

@app.route('/api/local_llm/unload', methods=['POST'])
@requires_auth
def local_llm_unload():
    model_name = request.json.get('model_name')
    success, message = local_llm_manager.unload_local_model(model_name)
    return jsonify({"success": success, "message": message})

@app.route('/api/local_llm/delete', methods=['POST'])
@requires_auth
def local_llm_delete():
    model_name = request.json.get('model_name')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = local_llm_manager.delete_local_model(model_name)
    return jsonify({"success": success, "message": message})

@app.route('/api/local_llm/start', methods=['POST'])
@requires_auth
def local_llm_start():
    success, message = local_llm_manager.start_server()
    broadcast_status()
    return jsonify({"success": success, "message": message})

@app.route('/api/local_llm/stop', methods=['POST'])
@requires_auth
def local_llm_stop():
    success, message = local_llm_manager.stop_server()
    broadcast_status()
    return jsonify({"success": success, "message": message})


# --- Headless ComfyUI & Dependency Resolver API ---

@app.route('/api/comfy/status', methods=['GET'])
@requires_auth
def comfy_status():
    installed = comfy_manager.check_comfy_installed()
    running = comfy_manager.check_comfy_running()
    if not running and getattr(comfy_manager, '_starting', False):
        running = "starting"
    return jsonify({
        "installed": installed,
        "running": running,
        "resolution_status": comfy_manager.resolution_status
    })

@app.route('/api/comfy/install', methods=['POST'])
@requires_auth
def comfy_install():
    success, message = comfy_manager.trigger_install_comfy()
    return jsonify({"success": success, "message": message})

@app.route('/api/comfy/start', methods=['POST'])
@requires_auth
def comfy_start():
    success, message = comfy_manager.start_comfy_server()
    broadcast_status()
    return jsonify({"success": success, "message": message})

@app.route('/api/comfy/stop', methods=['POST'])
@requires_auth
def comfy_stop():
    success, message = comfy_manager.stop_comfy_server()
    broadcast_status()
    return jsonify({"success": success, "message": message})

@app.route('/api/comfy/resolve_workflow', methods=['POST'])
@requires_auth
def comfy_resolve_workflow():
    workflow_json = request.json.get("workflow_json")
    if not workflow_json:
        try:
            from variables import PROGRAMS_DIR, COMFYUI_CHECKPOINT
            from utils.program import get_active_program
            active_program = get_active_program()
            
            combined_workflow = {}
            
            # Read ImageWorkflow.json
            image_path = os.path.normpath(os.path.join(
                PROGRAMS_DIR, active_program, "portraits", "ImageWorkflow.json"
            ))
            if not os.path.exists(image_path):
                image_path = os.path.normpath(os.path.join(
                    base_dir, "core", "skills", "portrait_generation", "ImageWorkflow.json"
                ))
                
            if os.path.exists(image_path):
                with open(image_path, "r", encoding="utf-8") as f:
                    try:
                        image_wf = json.load(f)
                        resolved_checkpoint = os.getenv("COMFYUI_CHECKPOINT", COMFYUI_CHECKPOINT)
                        image_str = json.dumps(image_wf).replace("%model%", resolved_checkpoint)
                        image_wf = json.loads(image_str)
                        for k, v in image_wf.items():
                            combined_workflow[f"image_{k}"] = v
                    except Exception as je1:
                        print(f"Error parsing ImageWorkflow.json for resolution: {je1}")
            
            # Read VideoWorkflow.json
            video_path = os.path.normpath(os.path.join(
                PROGRAMS_DIR, active_program, "portraits", "VideoWorkflow.json"
            ))
            if not os.path.exists(video_path):
                video_path = os.path.normpath(os.path.join(
                    base_dir, "core", "skills", "portrait_generation", "VideoWorkflow.json"
                ))
                
            if os.path.exists(video_path):
                with open(video_path, "r", encoding="utf-8") as f:
                    try:
                        video_wf = json.load(f)
                        for k, v in video_wf.items():
                            combined_workflow[f"video_{k}"] = v
                    except Exception as je2:
                        print(f"Error parsing VideoWorkflow.json for resolution: {je2}")
            
            if combined_workflow:
                workflow_json = json.dumps(combined_workflow)
        except Exception as e:
            return jsonify({"error": f"Failed to read program workflows: {e}"}), 500
            
    if not workflow_json:
        return jsonify({"error": "No workflow configuration found to resolve."}), 400
        
    success, message = comfy_manager.trigger_dependency_resolution(workflow_json)
    return jsonify({"success": success, "message": message})


# --- Headless ComfyUI Checkpoint Management APIs ---

@app.route('/api/comfy/checkpoints', methods=['GET'])
@requires_auth
def comfy_checkpoints():
    try:
        from utils.comfy_manager import list_local_checkpoints
        checkpoints = list_local_checkpoints()
        active = os.getenv("COMFYUI_CHECKPOINT", "sd_xl_base_1.0.safetensors")
        return jsonify({
            "checkpoints": checkpoints,
            "active": active
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/comfy/checkpoints/select', methods=['POST'])
@requires_auth
def comfy_select_checkpoint():
    try:
        checkpoint = request.json.get("checkpoint")
        if not checkpoint:
            return jsonify({"error": "Missing checkpoint parameter"}), 400
            
        os.environ["COMFYUI_CHECKPOINT"] = checkpoint
        
        # Persist to .env
        env_path = os.path.join(base_dir, '.env')
        if os.path.exists(env_path):
            with open(env_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            updated = False
            for i, line in enumerate(lines):
                if line.strip().startswith('COMFYUI_CHECKPOINT='):
                    lines[i] = f"COMFYUI_CHECKPOINT={checkpoint}\n"
                    updated = True
                    break
            if not updated:
                lines.append(f"\nCOMFYUI_CHECKPOINT={checkpoint}\n")
            with open(env_path, 'w', encoding='utf-8') as f:
                f.writelines(lines)
                
        return jsonify({"status": "success", "active": checkpoint})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/comfy/checkpoints/search', methods=['GET'])
@requires_auth
def comfy_search_checkpoints():
    query = request.args.get('query', '').strip()
    if not query:
        return jsonify({"results": []})
    from utils.comfy_manager import search_huggingface_checkpoints
    results = search_huggingface_checkpoints(query)
    return jsonify({"results": results})

@app.route('/api/comfy/checkpoints/download', methods=['POST'])
@requires_auth
def comfy_download_checkpoint():
    url = request.json.get("url")
    filename = request.json.get("filename")
    if not url or not filename:
        return jsonify({"error": "Missing url or filename"}), 400
        
    from utils.comfy_manager import trigger_checkpoint_download
    success, message = trigger_checkpoint_download(url, filename)
    return jsonify({"success": success, "message": message})

@app.route('/api/comfy/checkpoints/download_status', methods=['GET'])
@requires_auth
def comfy_checkpoint_download_status():
    from utils.comfy_manager import checkpoint_download_status
    return jsonify(checkpoint_download_status)


# Prewarming is now handled on the first request inside start_prewarm_on_first_request()

if __name__ == '__main__':
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', '5000'))
    
    ssl_context = None
    use_https = os.getenv('USE_HTTPS', 'false').lower() == 'true'
    ssl_cert = os.getenv('SSL_CERT')
    ssl_key = os.getenv('SSL_KEY')
    
    if ssl_cert and ssl_key and os.path.exists(ssl_cert) and os.path.exists(ssl_key):
        ssl_context = (ssl_cert, ssl_key)
        print(f"[*] Starting server with SSL certificate: {ssl_cert}")
    elif use_https:
        try:
            import OpenSSL
            ssl_context = 'adhoc'
            print("[*] Starting server with ad-hoc SSL certificate")
        except ImportError:
            print("[!] pyOpenSSL is not installed. To run with ad-hoc SSL, please run: pip install pyopenssl")
            print("[!] Falling back to HTTP...")
            
    # Open the browser only on the initial startup.
    # The parent process runs exactly once on startup, whereas the child worker process restarts on file changes.
    if os.environ.get('OPEN_BROWSER', '').lower() == 'true' and os.environ.get('WERKZEUG_RUN_MAIN') != 'true':
        browser_host = host if host != '0.0.0.0' else '127.0.0.1'
        protocol = 'https' if ssl_context else 'http'
        url = f"{protocol}://{browser_host}:{port}"
        
        def open_browser():
            import webbrowser
            print(f"[*] Automatically opening browser to: {url}")
            webbrowser.open(url)
            
        threading.Timer(1.5, open_browser).start()
            
    app.run(
        host=host,
        port=port,
        debug=True,
        ssl_context=ssl_context,
        use_reloader=True,
        reloader_type='stat',  # Use stable stat reloader to avoid false-alarm watchdog access events on Windows
        exclude_patterns=[
            '*.venv*', '*\\.venv\\*', '*\\site-packages\\*', 
            '*AppData*', '*site-packages*', '*__pycache__*',
            '*.env', 'active_program.txt', '*.txt', '*.db', '*.json'
        ]
    )