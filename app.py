import os
import time
import shutil
import json

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

from flask import Flask, render_template, request, jsonify, send_file, send_from_directory, Response
import asyncio
from functools import wraps
from runner_interface import GoogleAdkRunner, OpenSourceRunner

# Load environment variables
from dotenv import load_dotenv
load_dotenv(override=True)

app = Flask(__name__)

_cached_active_program = None
_cached_active_user = None

def init_runner():
    global runner
    runner_backend = os.getenv("RUNNER_BACKEND", "opensource").lower()
    if runner_backend == "google_adk":
        try:
            runner = GoogleAdkRunner(app_name="Sanctuary")
            print(">>> Starting Sanctuary using GOOGLE ADK Runner backend!")
        except Exception as e:
            print(f">>>> WARNING: Failed to initialize GoogleAdkRunner backend: {e}")
            print(">>>> Falling back to OpenSourceRunner (offline mode) so server can run.")
            runner = OpenSourceRunner(app_name="Sanctuary")
    else:
        runner = OpenSourceRunner(app_name="Sanctuary")
        print(">>> Starting Sanctuary using decoupled OPEN-SOURCE Runner backend!")

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
            from core import program_config
            import importlib
            importlib.reload(program_config)
            
            # Re-initialize the runner backend with the new consciousness/program/user config
            init_runner()
            
            if hasattr(runner, 'sessions_history'):
                runner.sessions_history.clear()
            if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
                runner.runner.session_service.sessions.clear()
            print(f">>> Dynamic check loaded new program consciousness (Program: '{current_program}', User Profile: '{current_user}')")
        except Exception as e:
            print(f"Error dynamically reloading program/user: {e}")

@app.after_request
def add_cache_control_headers(response):
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
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
        # Prewarm daemon status
        from utils.lms_manager import check_daemon_status, check_lms_cli
        check_daemon_status(force_refresh=True)
        check_lms_cli()
    except Exception as e:
        print(f"Error prewarming lms daemon status: {e}")

    try:
        # Start ComfyUI automatically
        from utils.comfy_manager import start_comfy_daemon
        print(">>> Starting ComfyUI server in background...")
        started, msg = start_comfy_daemon()
        print(f">>> ComfyUI startup: {msg}")
    except Exception as e:
        print(f"Error starting ComfyUI automatically: {e}")

    print(">>> Backend caches pre-warmed successfully!")

# Initialize the dynamic runner based on configuration
init_runner()


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
    import json
    theme = None
    theme_path = os.path.join(base_dir, "core", "programs", active_program, "theme.json")
    if os.path.exists(theme_path):
        try:
            with open(theme_path, "r", encoding="utf-8") as tf:
                theme = json.load(tf)
        except Exception as e:
            print(f"Error loading theme for {active_program}: {e}")

    from utils.program import get_active_user
    active_user = get_active_user()
    if os.getenv("AUTH_USER") and request.authorization and active_user == "builder":
        # If Basic Auth is active, default active user to authenticated user
        active_user = request.authorization.username

    from flask import make_response
    response = make_response(render_template('index.html', local_ip=local_ip, tts_auto_speak=tts_auto_speak, tts_provider=tts_provider, active_program=active_program, theme=theme, active_user=active_user))
    response.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return response

@app.route('/manifest.json')
def serve_manifest():
    from core.program_config import companion_name
    import json
    try:
        with open('manifest.json', 'r', encoding='utf-8') as f:
            manifest_data = json.load(f)
        manifest_data['name'] = f"{companion_name} Sanctuary"
        manifest_data['short_name'] = companion_name
        manifest_data['description'] = f"Enter the Sanctuary and converse with {companion_name}"
        return jsonify(manifest_data)
    except Exception:
        return send_file('manifest.json', mimetype='application/json')

@app.route('/service-worker.js')
def serve_service_worker():
    return send_file('service-worker.js', mimetype='application/javascript')

@app.route('/app_icon.png')
def app_icon():
    active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
    path_png = os.path.join('core', 'programs', active_program, 'portraits', 'profile.png')
    if os.path.exists(path_png):
        response = send_file(path_png)
    else:
        response = send_file('images/app_icon.png')
            
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res

@app.route('/profile.png')
def profile_png():
    active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
    path_png = os.path.join('core', 'programs', active_program, 'portraits', 'profile.png')
    if os.path.exists(path_png):
        response = send_file(path_png)
    else:
        response = send_file('images/app_icon.png')
        
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res

@app.route('/programs/<program_id>/profile.png')
def program_profile_png(program_id):
    if not program_id.isalnum() and '_' not in program_id:
        return "Invalid program ID", 400
    path_png = os.path.join('core', 'programs', program_id, 'portraits', 'profile.png')
    if os.path.exists(path_png):
        response = send_file(path_png)
    else:
        response = send_file('images/app_icon.png')
        
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res



@app.route('/api/programs/profile_picture/save', methods=['POST'])
@requires_auth
def save_profile_picture():
    try:
        from variables import PROGRAMS_DIR
        import base64
        import re
        
        data = request.get_json(silent=True) or {}
        cropped_image_base64 = data.get('cropped_image')
        if not cropped_image_base64:
            return jsonify({'error': 'No cropped_image data provided'}), 400
            
        active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
        portraits_dir = os.path.join(PROGRAMS_DIR, active_program, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        dest_path = os.path.join(portraits_dir, 'profile.png')
        
        # Remove base64 header if present (e.g., data:image/png;base64,)
        match = re.search(r'base64,(.*)', cropped_image_base64)
        if match:
            base64_data = match.group(1)
        else:
            base64_data = cropped_image_base64
            
        image_bytes = base64.b64decode(base64_data)
        with open(dest_path, 'wb') as f:
            f.write(image_bytes)
            
        return jsonify({'status': 'success', 'message': 'Profile picture cropped and saved successfully.'})
    except Exception as e:
        print(f"Error saving profile picture: {e}")
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
        png_path = os.path.normpath(os.path.join(base_dir, 'core', 'programs', active_program, 'portraits', img_subpath))
        
        json_path = png_path.rsplit('.', 1)[0] + '.json'
        
        # Fallback: scan all programs' portraits directories for the filename
        if not os.path.exists(json_path):
            from variables import PROGRAMS_DIR
            if os.path.exists(PROGRAMS_DIR):
                for prog in os.listdir(PROGRAMS_DIR):
                    candidate_path = os.path.normpath(os.path.join(PROGRAMS_DIR, prog, 'portraits', img_subpath))
                    candidate_json = candidate_path.rsplit('.', 1)[0] + '.json'
                    if os.path.exists(candidate_json):
                        json_path = candidate_json
                        break

        if os.path.exists(json_path):
            with open(json_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
                prompt = meta.get('prompt', '')
                return jsonify({'status': 'success', 'prompt': prompt})
        else:
            return jsonify({'status': 'success', 'prompt': ''})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

def append_companion_message_to_session(runner, session_id: str, content: str):
    import time
    if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
        # Google ADK Runner
        from google.adk.events.event import Event
        from google.genai import types
        adk_session = runner.runner.session_service.get_session(runner.app_name, "user", session_id)
        adk_session.events.append(Event(
            author="companion",
            content=types.Content(role="model", parts=[types.Part.from_text(text=content)]),
            id=f"companion-{int(time.time())}",
            timestamp=time.time()
        ))
        runner._save_session_to_disk(session_id)
    else:
        # Open Source Runner
        if session_id not in runner.sessions_history:
            runner._load_session_from_disk(session_id)
        runner.sessions_history[session_id].append({
            "role": "companion",
            "text": content,
            "timestamp": time.time()
        })
        runner._save_session_to_disk(session_id)

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
        
        name = "Companion"
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
        
        # Generate history context string
        history_context = ""
        for msg in chat_history[-10:]:
            role = msg.get('role', 'unknown')
            text = msg.get('text') or msg.get('content') or ""
            if role in ('user', 'companion'):
                speaker = user_display_name if role == 'user' else name
                history_context += f"{speaker}: {text}\n"
                
        # Define LLM prompt
        prompt = f"""You are the companion {name} from the sanctuary app.
Character Background:
Description: {description}
Personality: {personality}
Scenario: {scenario}

Recent Conversation History:
{history_context}

The user ({user_display_name}) has been inactive/away for a while.
Based on the conversation context above, decide how to react proactively.
You must choose exactly ONE of the following action types:
1. "thought": A private inner thought or monologue representing your feelings about the silence, the user's absence, or the last topic (1-2 sentences). Format this in character.
2. "message": A short, casual, concise follow-up text message to check in, continue the conversation, or react to the silence.

You must return a valid JSON object matching the following schema:
{{
  "type": "thought" | "message",
  "content": "the actual thought or message text"
}}
"""

        # Call the LLM
        from utils.models import is_local_model
        is_local = is_local_model(selected_model) if selected_model else True
        raw_response = None
        
        if is_local:
            import requests
            from variables import REMOTE_SERVER_URL, get_remote_server_headers
            target_model = selected_model if (selected_model and selected_model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
            payload = {
                "messages": [{"role": "user", "content": prompt}],
                "temperature": 0.7,
                "max_tokens": 512
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
                    "max_tokens": 512,
                    "response_format": {"type": "json_object"}
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
            
        if action_type == "message":
            # Append message to history
            append_companion_message_to_session(runner, session_id, content)
            return jsonify({
                'status': 'success',
                'type': 'message',
                'content': content
            })
        else: # thought
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
        
        # Retrieve parsed mood metadata directly from history payload
        state_info = None
        for msg in reversed(chat_history):
            if msg.get('role') == 'companion':
                state_info = msg.get('mood')
                break
        if not state_info:
            from utils.program_mood import analyze_emotional_state
            state_info = analyze_emotional_state("")
        
        from core.program_config import companion_name
        active_program = os.environ.get("ACTIVE_PROGRAM", "sebile")
        
        theme = None
        base_dir = os.path.dirname(os.path.abspath(__file__))
        theme_path = os.path.join(base_dir, "core", "programs", active_program, "theme.json")
        if os.path.exists(theme_path):
            try:
                import json
                with open(theme_path, "r", encoding="utf-8") as tf:
                    theme = json.load(tf)
            except Exception as e:
                print(f"Error loading theme for {active_program} in history: {e}")

        return jsonify({
            'history': chat_history,
            'state': state_info,
            'inversion_active': inversion_mode,
            'character_name': companion_name,
            'active_program': active_program,
            'theme': theme
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
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []

    from runner_interface import cancelled_sessions, voice_call_sessions
    cancelled_sessions.discard(session_id)
    if is_voice_call:
        voice_call_sessions.add(session_id)
        
    start_time = time.time()

    try:
        response_text, tool_calls = asyncio.run(
            runner.run_async(
                session_id=session_id,
                new_message_text=user_message,
                image_data=image_data,
                image_mime=image_mime,
                model=selected_model,
                media_path=media_path
            )
        )
        duration = round(time.time() - start_time, 1)
        
        # Apply banned words filter to output response
        from utils.banned_words import sanitize_text
        sanitized_response = sanitize_text(response_text)
        chat_history = None
        if sanitized_response != response_text:
            print(f"[BANNED WORDS] Sanitizing response: '{response_text}' -> '{sanitized_response}'")
            # Update the message text inside the runner history so that the change persists
            async def update_history_and_get():
                hist = await runner.get_history(session_id)
                companion_count = sum(1 for msg in hist if msg.get('role') == 'companion')
                if companion_count > 0:
                    await runner.update_message_text(session_id, 'companion', companion_count - 1, sanitized_response)
                    hist = await runner.get_history(session_id)
                return hist
            chat_history = asyncio.run(update_history_and_get())
            response_text = sanitized_response

        if chat_history is None:
            chat_history = asyncio.run(runner.get_history(session_id))
        state_info = None
        for msg in reversed(chat_history):
            if msg.get('role') == 'companion':
                state_info = msg.get('mood')
                break
        if not state_info:
            from utils.program_mood import analyze_emotional_state
            state_info = analyze_emotional_state("")
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id, history=chat_history))
        
        # Trigger background journaling check in a separate thread
        try:
            from utils.program import get_active_program
            from utils.journals import trigger_journal_in_background
            active_prog = get_active_program()
            trigger_journal_in_background(active_prog, session_id, selected_model)
        except Exception as e:
            print(f"Error launching background journaling: {e}")
            
        return jsonify({
            'response': response_text,
            'tool_calls': tool_calls,
            'state': state_info,
            'inversion_active': inversion_mode,
            'timestamp': time.time(),
            'duration': duration
        })
    except asyncio.CancelledError:
        print(f"[CANCEL] Chat generation cancelled for session {session_id}")
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
    user_message_index = request.json.get('user_message_index') # 0-based index of user messages
    new_text = request.json.get('new_text') # None means reroll (use original text)
    selected_model = request.json.get('model')

    import tools
    tools.current_session_id.set(session_id)
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []

    from runner_interface import cancelled_sessions
    cancelled_sessions.discard(session_id)
    start_time = time.time()

    try:
        response_text, tool_calls = asyncio.run(
            runner.edit_turn(
                session_id=session_id,
                user_message_index=user_message_index,
                new_text=new_text,
                model=selected_model
            )
        )
        duration = round(time.time() - start_time, 1)
        
        # Apply banned words filter to output response
        from utils.banned_words import sanitize_text
        sanitized_response = sanitize_text(response_text)
        chat_history = None
        if sanitized_response != response_text:
            print(f"[BANNED WORDS] Sanitizing edited response: '{response_text}' -> '{sanitized_response}'")
            # Update the message text inside the runner history so that the change persists
            async def update_history_and_get():
                hist = await runner.get_history(session_id)
                companion_count = sum(1 for msg in hist if msg.get('role') == 'companion')
                if companion_count > 0:
                    await runner.update_message_text(session_id, 'companion', companion_count - 1, sanitized_response)
                    hist = await runner.get_history(session_id)
                return hist
            chat_history = asyncio.run(update_history_and_get())
            response_text = sanitized_response

        if chat_history is None:
            chat_history = asyncio.run(runner.get_history(session_id))
        state_info = None
        for msg in reversed(chat_history):
            if msg.get('role') == 'companion':
                state_info = msg.get('mood')
                break
        if not state_info:
            from utils.program_mood import analyze_emotional_state
            state_info = analyze_emotional_state("")
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id, history=chat_history))
        return jsonify({
            'response': response_text,
            'tool_calls': tool_calls,
            'state': state_info,
            'inversion_active': inversion_mode,
            'timestamp': time.time(),
            'duration': duration
        })
    except asyncio.CancelledError:
        print(f"[CANCEL] Edit generation cancelled for session {session_id}")
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
    
    # Load dynamism (temperature) from project settings
    from variables import VARIABLES_DIR
    import json
    settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
    temperature = 0.95
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
                temperature = settings.get("temperature", 0.95)
        except Exception:
            pass
            
    # Format only the most recent history turns to keep token count low and prevent context overflow
    recent_history = chat_history[-6:] if len(chat_history) > 6 else chat_history
    history_text = ""
    for msg in recent_history:
        role = "User" if msg.get('role') == 'user' else "Companion"
        history_text += f"{role}: {msg.get('text', '')}\n"
        
    system_instruction = (
        "You are an assistant that auto-generates the User's next reply. "
        "You MUST write in the first-person, impersonating the user. "
        "Match the user's tone and context. Be short and concise."
    )
    
    prompt = (
        f"User Profile Context:\n{user_profile}\n\n"
        f"Recent Chat History:\n{history_text}\n"
        f"Generate the User's next message to the Companion:"
    )
    
    # Check if local model
    from utils.models import is_local_model
    if is_local_model(model) or model == 'local-lm-studio':
        import requests
        from variables import REMOTE_SERVER_URL, get_remote_server_headers
        payload = {
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": prompt}
            ],
            "temperature": temperature,
            "max_tokens": 512
        }
        target_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME")
        if target_model:
            payload["model"] = target_model
            
        try:
            headers = get_remote_server_headers()
            r = requests.post(REMOTE_SERVER_URL, json=payload, headers=headers, timeout=60.0)
            if r.status_code == 200:
                res_json = r.json()
                return res_json['choices'][0]['message']['content'].strip()
            else:
                raise Exception(f"Local server returned status code {r.status_code}: {r.text}")
        except Exception as e:
            print(f"Error generating impersonated message via local model: {e}")
            raise
    else:
        # Remote model
        from google import genai
        from google.genai import types
        api_key = os.getenv("REMOTE_API_KEY")
        if not api_key:
            raise Exception("REMOTE_API_KEY environment variable is not configured.")
        client = genai.Client(api_key=api_key)
        
        try:
            target_model = model if model else "gemini-2.5-flash"
            response = client.models.generate_content(
                model=target_model,
                contents=prompt,
                config=types.GenerateContentConfig(
                    system_instruction=system_instruction,
                    temperature=temperature,
                    max_output_tokens=512
                )
            )
            return response.text.strip()
        except Exception as e:
            print(f"Error generating impersonated message via Gemini: {e}")
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
    role = request.json.get('role')
    index = request.json.get('index')
    new_text = request.json.get('new_text')
    
    if role not in ['user', 'companion'] or index is None or new_text is None:
        return jsonify({'error': 'Invalid arguments'}), 400
        
    try:
        success = asyncio.run(runner.update_message_text(session_id, role, int(index), new_text))
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
    role = request.json.get('role')
    index = request.json.get('index')
    
    if role is None or index is None:
        user_message_index = request.json.get('user_message_index')
        if user_message_index is not None:
            try:
                asyncio.run(runner.delete_turn(session_id, user_message_index))
                return jsonify({'status': 'success'})
            except Exception as e:
                print(f"Error deleting turn in session {session_id}: {e}")
                return jsonify({'error': str(e)}), 500
        return jsonify({'error': 'Missing role/index or user_message_index parameters'}), 400
        
    try:
        success = asyncio.run(runner.delete_message_at(session_id, role, int(index)))
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Message not found'}), 404
    except Exception as e:
        print(f"Error deleting message at index {index} with role {role}: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/continue', methods=['POST'])
@requires_auth
def continue_generation():
    session_id = request.json.get('session_id', 'default')
    model = request.json.get('model')
    
    import tools
    tools.current_session_id.set(session_id)
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
        last_role = 'user' if last_msg.get('role') == 'user' else 'companion'
        
        if last_role == 'companion':
            last_companion_text = last_msg.get('text', '')
            
            # Send a prompt to continue
            continue_prompt = (
                "[System: Continue your last message. Do NOT repeat or summarize your last message. "
                "Start writing immediately from the exact point where you left off, connecting seamlessly to the end.]"
            )
            
            response_text, tool_calls = asyncio.run(runner.run_async(
                session_id=session_id,
                new_message_text=continue_prompt,
                model=model
            ))
            duration = round(time.time() - start_time, 1)
            
            # Delete the temporary turn
            updated_history = asyncio.run(runner.get_history(session_id))
            user_messages = [msg for msg in updated_history if msg.get('role') == 'user']
            last_user_index = len(user_messages) - 1
            asyncio.run(runner.delete_message_at(session_id, 'user', last_user_index))
            
            # Merge continuation text dynamically
            if last_companion_text.endswith('\n') or response_text.startswith('\n'):
                merged_text = last_companion_text + response_text
            else:
                last_char = last_companion_text.rstrip()[-1:] if last_companion_text.strip() else ""
                if last_char in ['.', '!', '?', '"', '*']:
                    merged_text = last_companion_text + "\n\n" + response_text
                else:
                    prefix = "" if (not response_text or response_text.startswith(' ')) else " "
                    merged_text = last_companion_text + prefix + response_text
            
            # Update the original companion message
            companion_messages = [msg for msg in asyncio.run(runner.get_history(session_id)) if msg.get('role') == 'companion']
            last_companion_index = len(companion_messages) - 1
            asyncio.run(runner.update_message_text(session_id, 'companion', last_companion_index, merged_text))
            
            return jsonify({
                'status': 'success',
                'response': merged_text,
                'tool_calls': tool_calls,
                'duration': duration
            })
        else:
            user_text = last_msg.get('text', '')
            user_image = last_msg.get('image_url')
            
            user_messages = [msg for msg in history if msg.get('role') == 'user']
            last_user_index = len(user_messages) - 1
            asyncio.run(runner.delete_message_at(session_id, 'user', last_user_index))
            
            response_text, tool_calls = asyncio.run(runner.run_async(
                session_id=session_id,
                new_message_text=user_text,
                media_path=user_image if (user_image and not user_image.startswith('data:')) else None,
                model=model
            ))
            duration = round(time.time() - start_time, 1)
            
            return jsonify({
                'status': 'success',
                'response': response_text,
                'tool_calls': tool_calls,
                'duration': duration
            })
            
    except asyncio.CancelledError:
        print(f"[CANCEL] Continuation cancelled for session {session_id}")
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

@app.route('/api/generate_portrait', methods=['POST'])
@requires_auth
def generate_portrait():
    session_id = request.json.get('session_id', 'default')
    model = request.json.get('model')
    
    import tools
    tools.current_session_id.set(session_id)
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []
        
    from runner_interface import cancelled_sessions
    cancelled_sessions.discard(session_id)
    start_time = time.time()
    
    prompt_message = (
        "[System: Based on the conversation history and your description, "
        "write a ComfyUI prompt of 10-15 comma-separated tags describing your current appearance, outfit, pose, expression, and environment. "
        "Output ONLY the tags (e.g. 'silver hair, purple eyes, smiling, sitting on cushions, castle interior'). "
        "Do NOT include any conversational text, headers, quotes, or markdown.]"
    )
    
    try:
        response_text, tool_calls = asyncio.run(
            runner.run_async(
                session_id=session_id,
                new_message_text=prompt_message,
                model=model
            )
        )
        duration = round(time.time() - start_time, 1)
        
        # Clean up response to extract clean tags
        clean_tags = response_text.strip()
        if clean_tags.startswith("```"):
            lines = clean_tags.split("\n")
            if len(lines) >= 3:
                clean_tags = "\n".join(lines[1:-1]).strip()
        for prefix in ["here are the tags:", "tags:", "prompt:", "comfyui prompt:"]:
            if clean_tags.lower().startswith(prefix):
                clean_tags = clean_tags[len(prefix):].strip()
        if clean_tags.startswith('"') and clean_tags.endswith('"'):
            clean_tags = clean_tags[1:-1].strip()
        if clean_tags.startswith("'") and clean_tags.endswith("'"):
            clean_tags = clean_tags[1:-1].strip()
            
        # Generate the portrait using ComfyUI
        new_markdown = tools.generate_local_image(clean_tags)
        
        # Update the chat history:
        # 1. Restore the user message to the original button text
        # 2. Update the companion message with the generated markdown image link
        original_user_message = "Send me a portrait of yourself based on the context of our last message/current dialogue!"
        try:
            async def update_history_and_get_inversion():
                hist = await runner.get_history(session_id)
                user_messages = [msg for msg in hist if msg.get('role') == 'user']
                if user_messages:
                    await runner.update_message_text(session_id, 'user', len(user_messages) - 1, original_user_message)
            async def update_history_and_get_inversion_and_mood():
                hist = await runner.get_history(session_id)
                companion_messages = [msg for msg in hist if msg.get('role') == 'companion']
                if companion_messages:
                    await runner.update_message_text(session_id, 'companion', len(companion_messages) - 1, new_markdown)
                
                # Fetch fresh history after updates for inversion calculation
                hist = await runner.get_history(session_id)
                inv = await runner._get_inversion_mode(session_id, history=hist)
                
                mood = None
                for msg in reversed(hist):
                    if msg.get('role') == 'companion':
                        mood = msg.get('mood')
                        break
                return inv, mood

            inversion_mode, state_info = asyncio.run(update_history_and_get_inversion_and_mood())
        except Exception as he:
            print(f"Error updating message text in history: {he}")
            inversion_mode = ""
            state_info = None
            
        if not state_info:
            from utils.program_mood import analyze_emotional_state
            state_info = analyze_emotional_state("")
        display_text = new_markdown
        
        return jsonify({
            'status': 'success',
            'response': display_text,
            'tool_calls': [],
            'state': state_info,
            'inversion_active': inversion_mode,
            'timestamp': time.time(),
            'duration': duration
        })
    except asyncio.CancelledError:
        print(f"[CANCEL] Portrait generation cancelled for session {session_id}")
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
        print(f"Error occurred in generate_portrait: {e}")
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
        # 1. Try to find the prompt in the companion sidecar JSON file (most reliable and clean)
        try:
            base_dir = os.path.dirname(os.path.abspath(__file__))
            from utils.program import get_active_program
            active_program = get_active_program()
            if old_image_url.startswith('/images/'):
                img_subpath = old_image_url[8:]
            else:
                img_subpath = os.path.basename(old_image_url)
            png_path = os.path.normpath(os.path.join(base_dir, 'core', 'programs', active_program, img_subpath))
            
            json_path = png_path.rsplit('.', 1)[0] + '.json'
            
            # Fallback: scan all programs
            if not os.path.exists(json_path):
                from variables import PROGRAMS_DIR
                filename_only = os.path.basename(img_subpath)
                for prog in os.listdir(PROGRAMS_DIR):
                    candidate_path = os.path.normpath(os.path.join(PROGRAMS_DIR, prog, 'portraits', filename_only))
                    candidate_json = candidate_path.rsplit('.', 1)[0] + '.json'
                    if os.path.exists(candidate_json):
                        json_path = candidate_json
                        break

            if os.path.exists(json_path):
                import json
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
                        if tc.get('type') == 'call' and tc.get('name') == 'generate_companion_portrait':
                            call_id = tc.get('id')
                            args = tc.get('args', {})
                            p = args.get('prompt')
                            if call_id and p:
                                calls[call_id] = p
                    for tc in tool_calls:
                        if tc.get('type') == 'response' and tc.get('name') == 'generate_companion_portrait':
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
        # Generate new portrait
        new_markdown = tools.generate_local_image(prompt)
        if new_markdown.startswith("Error"):
            return jsonify({'error': new_markdown}), 500
            
        # Parse the new image URL from Markdown link: ![Portrait](/images/portraits/portrait_123.png)
        new_image_url = None
        if new_markdown.startswith("![Portrait](") and new_markdown.endswith(")"):
            prefix_len = 12
            new_image_url = new_markdown[prefix_len:-1]
            
        if not new_image_url:
            return jsonify({'error': f'Failed to parse generated image markdown: {new_markdown}'}), 500
            
        # Replace in session history
        success = asyncio.run(runner.replace_image_in_session(session_id, old_image_url, new_image_url))
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
    prompt = request.json.get('prompt', 'gentle head turn, smiling, blinking, looking at camera')
    
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
        portraits_dir = os.path.join('core', 'programs', active_program, 'portraits')
        if not os.path.exists(portraits_dir):
            return jsonify({'images': []})
        files = os.listdir(portraits_dir)
        image_files = [f for f in files if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif', '.mp4', '.webm')) and f.lower() != 'profile.png']
        image_files.sort(key=lambda x: os.path.getmtime(os.path.join(portraits_dir, x)), reverse=True)
        image_urls = [f"/images/portraits/{f}" for f in image_files]
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
    
    from utils.lms_manager import check_daemon_status, list_local_models, check_lms_cli
    is_lm_studio_online = check_daemon_status()
    
    # 1. Fetch dynamic local models (only actively loaded models in LM Studio)
    models = fetch_local_models()
    
    # Default fallback: use the first loaded local model if available, otherwise "local-lm-studio"
    default_model = "local-lm-studio"
    if models and models[0]["value"] != "local-lm-studio":
        default_model = models[0]["value"]
        
    # Load settings to get temperature
    from variables import VARIABLES_DIR
    import json
    settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
    temperature = 0.95
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
                temperature = settings.get("temperature", 0.95)
        except Exception as e:
            print(f"Error reading project settings in get_models: {e}")
        
    return jsonify({
        "models": models,
        "default": default_model,
        "status": {
            "remote_configured": is_remote_configured,
            "remote_model": os.getenv("REMOTE_MODEL", "gemini-3.1-flash-lite"),
            "remote_url": remote_cloud_url,
            "lm_studio_online": is_lm_studio_online,
            "lms_installed": check_lms_cli(),
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
                
                # Check if the first folder needs to be updated to the new companion
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

@app.route('/api/save_generation_params', methods=['POST'])
@requires_auth
def save_generation_params():
    try:
        from variables import VARIABLES_DIR
        import json
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
            
        base_dir = os.path.dirname(os.path.abspath(__file__))
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
        if hasattr(runner, 'sessions_history'):
            runner.sessions_history.clear()
        if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
            runner.runner.session_service.sessions.clear()
                
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

@app.route('/api/programs/memories', methods=['GET'])
@requires_auth
def get_program_memories():
    try:
        from utils.program import get_active_program
        program_id = request.args.get('program_id') or get_active_program()
        
        base_dir = os.path.dirname(os.path.abspath(__file__))
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
        from variables import VARIABLES_DIR
        quests_path = os.path.join(VARIABLES_DIR, 'quest_log.json')
        if not os.path.exists(quests_path):
            return jsonify([])
        with open(quests_path, 'r', encoding='utf-8') as f:
            quests = json.load(f)
        return jsonify(quests)
    except Exception as e:
        print(f"Error loading quests: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/api/quests/<quest_id>/delete', methods=['POST'])
@requires_auth
def delete_quest(quest_id):
    try:
        from variables import VARIABLES_DIR
        quests_path = os.path.join(VARIABLES_DIR, 'quest_log.json')
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

@app.route('/api/quests/<quest_id>/download', methods=['GET'])
@requires_auth
def download_quest(quest_id):
    try:
        from variables import VARIABLES_DIR
        quests_path = os.path.join(VARIABLES_DIR, 'quest_log.json')
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
                    companion_name = folder.title()
                    json_path = os.path.join(folder_path, f"{folder}.json")
                    if os.path.exists(json_path):
                        try:
                            import json
                            with open(json_path, "r", encoding="utf-8") as jf:
                                jdata = json.load(jf)
                                if jdata.get("name"):
                                    companion_name = jdata["name"]
                        except Exception:
                            pass
                    else:
                        for file in os.listdir(folder_path):
                            if file.lower().endswith('.md') and not file.lower().startswith('user'):
                                companion_name = os.path.splitext(file)[0].title()
                                break
                    programs.append({
                        'id': folder,
                        'name': companion_name,
                        'active': folder == active_program
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
            
        base_dir = os.path.dirname(os.path.abspath(__file__))
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
        

        # Reload program config module to pick up new identity
        from core import program_config
        import importlib
        importlib.reload(program_config)
        
        # Re-initialize the runner backend with the new consciousness/program config
        init_runner()
        
        # Clear sessions memory in the runner so they reload from the new assistant's folders
        if hasattr(runner, 'sessions_history'):
            runner.sessions_history.clear()
        if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
            runner.runner.session_service.sessions.clear()
            
        theme = None
        theme_path = os.path.join(program_path, "theme.json")
        if os.path.exists(theme_path):
            try:
                import json
                with open(theme_path, "r", encoding="utf-8") as tf:
                    theme = json.load(tf)
            except Exception as e:
                print(f"Error loading theme for {program_id} in select_program: {e}")

        from core.program_config import companion_name
        return jsonify({'status': 'success', 'active': program_id, 'character_name': companion_name, 'theme': theme})
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
        import json
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        color = data.get('color')
        
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
        if not color:
            return jsonify({'error': 'Missing color'}), 400
            
        # Validate hex color
        import re
        if not re.match(r'^#[0-9a-fA-F]{6}$', color):
            return jsonify({'error': 'Invalid hex color format. Must be #RRGGBB'}), 400
            
        base_dir = os.path.dirname(os.path.abspath(__file__))
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
            return jsonify({'error': 'Cannot delete default companion Sebile'}), 400
            
        base_dir = os.path.dirname(os.path.abspath(__file__))
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # If the deleted program is currently active, switch to Sebile first
        active_program = os.getenv("ACTIVE_PROGRAM", "sebile")
        if program_id == active_program:
            os.environ["ACTIVE_PROGRAM"] = "sebile"
            try:
                from utils.program import set_active_program
                set_active_program("sebile")
            except Exception as e:
                print(f"Error resetting active program to sebile: {e}")
                
            # Reload program config and re-initialize the runner
            from core import program_config
            import importlib
            importlib.reload(program_config)
            init_runner()
            if hasattr(runner, 'sessions_history'):
                runner.sessions_history.clear()
            if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
                runner.runner.session_service.sessions.clear()
                
        # Delete the program folder recursively
        import shutil
        shutil.rmtree(program_path)
        
        return jsonify({'status': 'success', 'switched_to': 'sebile' if program_id == active_program else None})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/profile', methods=['GET'])
@requires_auth
def get_program_profile():
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        import json
        
        program_id = request.args.get('program_id') or get_active_program()
        program_path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id))
        json_path = os.path.join(program_path, f"{program_id}.json")
        old_json_path = os.path.join(program_path, "character_profile.json")
        
        profile_data = None
        for p in [json_path, old_json_path]:
            if os.path.exists(p):
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    # If this is the old structure, map it to new layout
                    if "operation" not in data and ("kindroid" in data or "ourdream" in data):
                        kindroid = data.get("kindroid", {})
                        ourdream = data.get("ourdream", {})
                        profile_data = {
                            "name": data.get("name", program_id.title()),
                            "operation": {
                                "description": kindroid.get("backstory", ""),
                                "response_directive": kindroid.get("response_directive", ""),
                                "example_message": kindroid.get("example_message", ""),
                                "ontology": kindroid.get("key_memories", ""),
                                "scenario": ourdream.get("scenario", ""),
                                "personality": ourdream.get("personality_type", "")
                            },
                            "description": {
                                "voice": "casual",
                                "hair style": "",
                                "hair color": "",
                                "ethnicity": "",
                                "breasts": "",
                                "butt": "",
                                "eyes": "",
                                "skin": "",
                                "body": ""
                            },
                            "image details": {
                                "image details": "",
                                "negative details": ""
                            }
                        }
                    else:
                        profile_data = data
                    break
                except Exception:
                    pass
                    
        if not profile_data:
            profile_data = {
                "name": program_id.title(),
                "operation": {
                    "description": "",
                    "response_directive": "",
                    "example_message": "",
                    "ontology": "",
                    "scenario": "",
                    "personality": ""
                },
                "description": {
                    "voice": "casual",
                    "hair style": "",
                    "hair color": "",
                    "ethnicity": "",
                    "breasts": "",
                    "butt": "",
                    "eyes": "",
                    "skin": "",
                    "body": ""
                },
                "image details": {
                    "image details": "",
                    "negative details": ""
                }
            }
        # Get the companion-specific voice from project settings
        from utils.program import _load_settings
        settings = _load_settings()
        companion_voices = settings.get("companion_voices", {})
        program_voice = companion_voices.get(program_id)
        if not program_voice:
            # Fallback to the global/fallback tts_voice key
            program_voice = settings.get("tts_voice", "af_heart")
        
        profile_data["tts_voice"] = program_voice
        return jsonify(profile_data)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/programs/profile/save', methods=['POST'])
@requires_auth
def save_program_profile():
    try:
        from utils.program import get_active_program
        from variables import PROGRAMS_DIR
        import json
        import importlib
        
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id') or get_active_program()
        program_path = os.path.normpath(os.path.join(PROGRAMS_DIR, program_id))
        json_path = os.path.join(program_path, f"{program_id}.json")
        
        if "operation" not in data and ("kindroid" in data or "ourdream" in data):
            kindroid = data.get("kindroid", {})
            ourdream = data.get("ourdream", {})
            existing_desc = {}
            existing_img = {}
            if os.path.exists(json_path):
                try:
                    with open(json_path, "r", encoding="utf-8") as f:
                        edata = json.load(f)
                        existing_desc = edata.get("description", {})
                        existing_img = edata.get("image details", {})
                except Exception:
                    pass
            
            final_data = {
                "name": data.get("name", program_id.title()),
                "operation": {
                    "description": kindroid.get("backstory", ""),
                    "response_directive": kindroid.get("response_directive", ""),
                    "example_message": kindroid.get("example_message", ""),
                    "ontology": kindroid.get("key_memories", ""),
                    "scenario": ourdream.get("scenario", ""),
                    "personality": ourdream.get("personality_type", "")
                },
                "description": {
                    "voice": existing_desc.get("voice", "casual"),
                    "hair style": existing_desc.get("hair style", ""),
                    "hair color": existing_desc.get("hair color", ""),
                    "ethnicity": existing_desc.get("ethnicity", ""),
                    "breasts": existing_desc.get("breasts", ""),
                    "butt": existing_desc.get("butt", ""),
                    "eyes": existing_desc.get("eyes", ""),
                    "skin": existing_desc.get("skin", ""),
                    "body": existing_desc.get("body", "")
                },
                "image details": {
                    "image details": existing_img.get("image details", ""),
                    "negative details": existing_img.get("negative details", "")
                }
            }
        else:
            final_data = data
            
        # Save companion-specific voice back to project settings
        from utils.program import set_tts_voice_for_program
        tts_voice = final_data.pop("tts_voice", None)
        if tts_voice:
            set_tts_voice_for_program(program_id, tts_voice)
            
        os.makedirs(program_path, exist_ok=True)
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(final_data, f, indent=2, ensure_ascii=False)
            
        # No sprite regeneration needed
            
        old_json_path = os.path.join(program_path, "character_profile.json")
        if os.path.exists(old_json_path):
            try:
                os.remove(old_json_path)
            except Exception:
                pass
                
        # Reload program configuration modules dynamically
        from core import program_config
        importlib.reload(program_config)
        init_runner()
        
        # Clear sessions memory in the runner to refresh instructions
        if hasattr(runner, 'sessions_history'):
            runner.sessions_history.clear()
        if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
            runner.runner.session_service.sessions.clear()
            
        return jsonify({'status': 'success'})
    except Exception as e:
        import traceback
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
            default_content = "# USER CONTEXT: BUILDER\n- A software developer and code builder.\n- Hobby: Collects cute AI companion programs in the Sanctuary.\n"
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
        
        # Re-initialize the program config module
        from core import program_config
        import importlib
        importlib.reload(program_config)
        
        # Re-initialize the runner
        init_runner()
        
        if hasattr(runner, 'sessions_history'):
            runner.sessions_history.clear()
        if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
            runner.runner.session_service.sessions.clear()
            
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
        import re
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
            from core import program_config
            import importlib
            importlib.reload(program_config)
            
            init_runner()
            if hasattr(runner, 'sessions_history'):
                runner.sessions_history.clear()
            if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
                runner.runner.session_service.sessions.clear()
                
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
                
            from core import program_config
            import importlib
            importlib.reload(program_config)
            init_runner()
            if hasattr(runner, 'sessions_history'):
                runner.sessions_history.clear()
            if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
                runner.runner.session_service.sessions.clear()
                
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
            
        import re
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
                
            from core import program_config
            import importlib
            importlib.reload(program_config)
            init_runner()
            if hasattr(runner, 'sessions_history'):
                runner.sessions_history.clear()
            if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
                runner.runner.session_service.sessions.clear()
                
        return jsonify({"status": "success", "profile_id": new_profile_id})
    except Exception as e:
        return jsonify({"error": str(e)}), 500



def generate_character_theme(main_color, accent_color_a=None, accent_color_b=None):
    import re
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
        "companion_bubble": f"rgba({24 + int(r*0.04)}, {24 + int(g*0.04)}, {28 + int(b*0.04)}, 0.85)",
        "send_btn_hover": f"rgba({20 + int(r*0.12)}, {20 + int(g*0.12)}, {22 + int(b*0.12)}, 0.75)",
        "accent_green": accent_color_a,
        "quote_blue": main_color,
        "primary_btn_text": btn_text
    }

# Obsolete sprite and theme color generation functions removed

def clean_and_normalize_profile(name, description, personality, text):
    """Cleans codeblock backticks and stray preambles from the LLM output, 
    ensuring it conforms to a raw markdown profile.
    """
    text = text.strip()
    lines = text.split("\n")
    clean_lines = []
    in_codeblock = False
    
    for line in lines:
        line_strip = line.strip()
        if line_strip.startswith("```"):
            in_codeblock = not in_codeblock
            continue
        # Skip common conversational intro/outro lines if outside codeblock
        if not in_codeblock:
            if any(line_strip.startswith(pfx) for pfx in ["Here is the", "I have translated", "Certainly!", "Sure, here", "Here is a", "Here's the"]):
                continue
        clean_lines.append(line)
        
    cleaned_text = "\n".join(clean_lines).strip()
    
    # Ensure it starts with # NAME: [Name]
    if cleaned_text.startswith("# ROLE:"):
        cleaned_text = cleaned_text.replace("# ROLE:", "# NAME:", 1)
    elif cleaned_text.startswith("#ROLE:"):
        cleaned_text = cleaned_text.replace("#ROLE:", "# NAME:", 1)
        
    role_header = f"# NAME: {name}"
    if not cleaned_text.startswith("# NAME:") and not cleaned_text.startswith("#NAME:"):
        cleaned_text = f"{role_header}\n\n{cleaned_text}"
        
    # Strip any stray profile_image= lines to keep it clean
    final_lines = [l for l in cleaned_text.split("\n") if "profile_image=" not in l]
    cleaned_text = "\n".join(final_lines).strip()
        
    return cleaned_text

def generate_character_json(name, description, personality, scenario, first_mes, model):
    import os
    import json
    remote_key = os.getenv("REMOTE_API_KEY")
    remote_cloud_url = os.getenv("REMOTE_CLOUD_URL")
    is_remote_configured = bool(
        remote_key and remote_key.strip() and remote_key != "your_remote_api_key_here" and
        remote_cloud_url and remote_cloud_url.strip() and remote_cloud_url != "your_remote_cloud_url_here"
    )
    
    prompt = f"""You are a professional companion designer. Based on the character card details below, design a structured companion profile JSON card.

Character Card Info:
Name: {name}
Description: {description}
Personality: {personality}
Scenario: {scenario}
First Message: {first_mes}

Output a single JSON object matching this exact schema:
{{
  "name": "{name}",
  "operation": {{
    "description": "Short bio summarizing who they are, their role, and devotion to the user (1-2 sentences)",
    "response_directive": "MANDATORY guidelines for response style. Keep them succinct, direct, natural, using contractions, and defining visual appearance details or traits",
    "ontology": "Core beliefs, values, or worldview of the companion",
    "example_message": "An example first-person dialogue line matching their style (e.g. *I sit next to you* I'm here.)",
    "personality": "Short keywords/phrases summarizing personality",
    "scenario": "A quiet roleplay setting or context for chat"
  }},
  "description": {{
    "voice": "casual",
    "ethnicity": "e.g. fay, asian, caucasion, etc.",
    "hair style": "e.g. long, short, wavy",
    "hair color": "e.g. silver, black, brown",
    "eyes": "e.g. purple, red, blue",
    "skin": "e.g. fair, pale, tanned",
    "breasts": "e.g. medium, large, huge",
    "butt": "e.g. medium, round",
    "body": "e.g. slim, voluptuous, fit"
  }},
  "image details": {{
    "image details": "Comma-separated prompt tags for image rendering (e.g. silver hair, purple eyes, solo, highly detailed)",
    "negative details": "blurry, low quality, distorted, extra limbs, bad anatomy"
  }},
  "colors": {{
    "main_color": "#XXXXXX (Harmonious hex color representing them)",
    "accent_color_a": "#XXXXXX (Secondary accent theme color)",
    "accent_color_b": "#XXXXXX (Highlight color)"
  }},
  "inversion": {{
    "intimate": "Direct instruction on how they behave when intimate/warm",
    "excited": "Direct instruction on how they behave when excited/playful",
    "intense": "Direct instruction on how they behave when intense/focused",
    "sad": "Direct instruction on how they behave when sad/empathetic"
  }}
}}
"""

    raw_response = None
    from utils.models import is_local_model
    use_local = is_local_model(model)
    
    if use_local:
        try:
            import httpx
            local_url = os.getenv("REMOTE_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
            local_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME", "local-lm-studio")
            payload = {
                "model": local_model,
                "messages": [
                    {"role": "system", "content": "You are a professional companion designer that outputs valid JSON character cards."},
                    {"role": "user", "content": prompt}
                ],
                "temperature": 0.5,
                "response_format": {"type": "json_object"}
            }
            res = httpx.post(local_url, json=payload, headers={"Content-Type": "application/json"}, timeout=60.0)
            if res.status_code == 200:
                raw_response = res.json()['choices'][0]['message']['content'].strip()
        except Exception as e:
            print(f"Error calling local model for JSON card generation: {e}")
    else:
        if is_remote_configured:
            try:
                import requests
                from variables import DEFAULT_REMOTE_MODEL
                target_model = model if model else DEFAULT_REMOTE_MODEL
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {remote_key}"
                }
                payload = {
                    "model": target_model,
                    "messages": [
                        {"role": "system", "content": "You are a professional companion designer that outputs valid JSON character cards."},
                        {"role": "user", "content": prompt}
                    ],
                    "temperature": 0.5,
                    "response_format": {"type": "json_object"}
                }
                res = requests.post(remote_cloud_url, json=payload, headers=headers, timeout=60.0)
                if res.status_code == 200:
                    raw_response = res.json()['choices'][0]['message']['content'].strip()
            except Exception as e:
                print(f"Error calling remote cloud model for JSON card generation: {e}")

    parsed = {}
    if raw_response:
        try:
            cleaned = raw_response.strip()
            if cleaned.startswith("```json"):
                cleaned = cleaned[7:]
            elif cleaned.startswith("```"):
                cleaned = cleaned[3:]
            if cleaned.endswith("```"):
                cleaned = cleaned[:-3]
            parsed = json.loads(cleaned.strip())
        except Exception as e:
            print(f"Failed to parse companion JSON card: {e}. Raw: {raw_response}")

    final_card = {
        "name": parsed.get("name") or name or "Companion",
        "operation": {
            "description": parsed.get("operation", {}).get("description") or description or f"{name} is a new companion.",
            "response_directive": parsed.get("operation", {}).get("response_directive") or "Speak naturally and directly.",
            "ontology": parsed.get("operation", {}).get("ontology") or "",
            "example_message": parsed.get("operation", {}).get("example_message") or first_mes or "",
            "personality": parsed.get("operation", {}).get("personality") or personality or "Friendly",
            "scenario": parsed.get("operation", {}).get("scenario") or scenario or "A comfortable room."
        },
        "description": {
            "voice": parsed.get("description", {}).get("voice") or "casual",
            "ethnicity": parsed.get("description", {}).get("ethnicity") or "unknown",
            "hair style": parsed.get("description", {}).get("hair style") or "long",
            "hair color": parsed.get("description", {}).get("hair color") or "silver",
            "eyes": parsed.get("description", {}).get("eyes") or "purple",
            "skin": parsed.get("description", {}).get("skin") or "fair",
            "breasts": parsed.get("description", {}).get("breasts") or "medium",
            "butt": parsed.get("description", {}).get("butt") or "medium",
            "body": parsed.get("description", {}).get("body") or "slim"
        },
        "image details": {
            "image details": parsed.get("image details", {}).get("image details") or "realistic, photorealistic, 8k",
            "negative details": parsed.get("image details", {}).get("negative details") or "blurry, low quality"
        },
        "colors": parsed.get("colors") or {
            "main_color": "#38bdf8",
            "accent_color_a": "#cbd5e1",
            "accent_color_b": "#94a3b8"
        },
        "inversion": parsed.get("inversion") or {
            "intimate": f"{name} is now a deeply affectionate, tender, and protective companion.",
            "excited": f"{name} is now highly playful, lighthearted, and energetic.",
            "intense": f"{name} is now highly focused, direct, and philosophically sharp.",
            "sad": f"{name} is now a highly empathetic, introspective, and gentle companion."
        }
    }
    return final_card

@app.route('/api/programs/import/tavern', methods=['POST'])
@requires_auth
def import_tavern_program():
    try:
        if 'card' not in request.files:
            return jsonify({'error': 'No card file provided'}), 400
            
        file = request.files['card']
        if not file.filename:
            return jsonify({'error': 'No file selected'}), 400
            
        import re
        from PIL import Image
        import base64
        import json
        import time
        
        temp_dir = os.path.join(base_dir, 'backups')
        os.makedirs(temp_dir, exist_ok=True)
        temp_path = os.path.join(temp_dir, 'temp_tavern_card.png')
        file.save(temp_path)
        
        try:
            with Image.open(temp_path) as img:
                chara_data = None
                if "chara" in img.info:
                    chara_data = img.info["chara"]
                elif "Character" in img.info:
                    chara_data = img.info["Character"]
                elif "ccv3" in img.info:
                    chara_data = img.info["ccv3"]
                else:
                    for key, val in img.info.items():
                        if isinstance(val, str) and len(val) > 20:
                            try:
                                test_json = json.loads(val)
                                if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json):
                                    chara_data = val
                                    break
                            except Exception:
                                try:
                                    decoded_bytes = base64.b64decode(val)
                                    decoded_str = decoded_bytes.decode('utf-8')
                                    test_json = json.loads(decoded_str)
                                    if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json):
                                        chara_data = val
                                        break
                                except Exception:
                                    pass
                                    
                if not chara_data:
                    raise ValueError("No character metadata chunk found in PNG card.")
                    
                try:
                    decoded_bytes = base64.b64decode(chara_data)
                    decoded_str = decoded_bytes.decode('utf-8')
                    chara = json.loads(decoded_str)
                except Exception:
                    try:
                        chara = json.loads(chara_data)
                    except Exception:
                        raise ValueError("Metadata chunk is not valid JSON or Base64 encoded JSON.")
                        
                if "data" in chara:
                    data = chara["data"]
                else:
                    data = chara
        except Exception as e:
            if os.path.exists(temp_path):
                try:
                    os.remove(temp_path)
                except Exception:
                    pass
            return jsonify({'error': f"Failed to parse Tavern card: {str(e)}"}), 400
            
        name = data.get('name', 'Unnamed Companion').strip()
        description = data.get('description', '')
        personality = data.get('personality', '')
        scenario = data.get('scenario', '')
        first_mes = data.get('first_mes', f"Hello, I am {name}.")
        model = request.form.get('model', '').strip()
        
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower()
        if not program_id:
            program_id = "companion_" + str(int(time.time()))
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            if os.path.exists(temp_path):
                os.remove(temp_path)
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400
            
        os.makedirs(program_path, exist_ok=True)
        os.remove(temp_path)
        
        # Call consolidated JSON generator
        card_json = generate_character_json(name, description, personality, scenario, first_mes, model)
        
        # Write inversion directives
        with open(os.path.join(program_path, 'inversion.json'), "w", encoding="utf-8") as f:
            json.dump(card_json.pop("inversion"), f, indent=2, ensure_ascii=False)
            
        # Write theme variables
        colors = card_json.pop("colors")
        main_color = colors.get("main_color", "#38bdf8")
        accent_a = colors.get("accent_color_a", "#cbd5e1")
        accent_b = colors.get("accent_color_b", "#94a3b8")
        

            
        theme_data = generate_character_theme(main_color, accent_a, accent_b)
        with open(os.path.join(program_path, 'theme.json'), "w", encoding="utf-8") as tf:
            json.dump(theme_data, tf, indent=2, ensure_ascii=False)
            
        # Setup portraits folder
        portraits_dir = os.path.join(program_path, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        
        # Write the JSON character card profile
        card_json["program_id"] = program_id
        with open(os.path.join(program_path, f"{program_id}.json"), "w", encoding="utf-8") as f:
            json.dump(card_json, f, indent=2, ensure_ascii=False)
            
        return jsonify({'status': 'success', 'program_id': program_id, 'name': name})
    except Exception as e:
        import traceback
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
            
        import re
        import json
        import time
        
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower()
        if not program_id:
            program_id = "companion_" + str(int(time.time()))
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400
            
        os.makedirs(program_path, exist_ok=True)
        
        # Call consolidated JSON generator
        card_json = generate_character_json(name, description, "", "", "", model)
        
        # Write inversion directives
        with open(os.path.join(program_path, 'inversion.json'), "w", encoding="utf-8") as f:
            json.dump(card_json.pop("inversion"), f, indent=2, ensure_ascii=False)
            
        # Write theme variables
        colors = card_json.pop("colors")
        main_color = colors.get("main_color", "#38bdf8")
        accent_a = colors.get("accent_color_a", "#cbd5e1")
        accent_b = colors.get("accent_color_b", "#94a3b8")
        

            
        theme_data = generate_character_theme(main_color, accent_a, accent_b)
        with open(os.path.join(program_path, 'theme.json'), "w", encoding="utf-8") as tf:
            json.dump(theme_data, tf, indent=2, ensure_ascii=False)
            
        # Setup portraits folder
        portraits_dir = os.path.join(program_path, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        
        # Write the JSON character card profile
        card_json["program_id"] = program_id
        with open(os.path.join(program_path, f"{program_id}.json"), "w", encoding="utf-8") as f:
            json.dump(card_json, f, indent=2, ensure_ascii=False)
            
        return jsonify({'status': 'success', 'program_id': program_id, 'name': name})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


# --- Headless LM Studio & Hugging Face Integration API ---
from utils import lms_manager

@app.route('/api/lms/status', methods=['GET'])
@requires_auth
def lms_status():
    installed = lms_manager.check_lms_cli()
    online = lms_manager.check_daemon_status()
    loaded_models = []
    downloaded_models = []
    if online:
        from utils.models import fetch_local_models
        loaded_models = [m["value"] for m in fetch_local_models()]
        downloaded_models = lms_manager.list_local_models()
        # Update download job statuses dynamically
        lms_manager.update_download_statuses()
    return jsonify({
        "installed": installed,
        "online": online,
        "loaded_models": loaded_models,
        "downloaded_models": downloaded_models,
        "download_status": lms_manager.download_status
    })

@app.route('/api/lms/install', methods=['POST'])
@requires_auth
def lms_install():
    success, message = lms_manager.install_lms_cli()
    return jsonify({"success": success, "message": message})

@app.route('/api/lms/search', methods=['GET'])
@requires_auth
def lms_search():
    query = request.args.get('query', '').strip()
    if not query:
        return jsonify({"results": []})
    results = lms_manager.search_huggingface_repos(query)
    return jsonify({"results": results})

@app.route('/api/lms/huggingface/files', methods=['GET'])
@requires_auth
def lms_hf_files():
    repo_id = request.args.get('repo_id', '').strip()
    if not repo_id:
        return jsonify({"error": "Missing repo_id"}), 400
    files = lms_manager.get_huggingface_repo_files(repo_id)
    return jsonify({"files": files})

@app.route('/api/lms/download', methods=['POST'])
@requires_auth
def lms_download():
    model_name = request.json.get('model_name')
    quantization = request.json.get('quantization')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = lms_manager.trigger_download(model_name, quantization)
    return jsonify({"success": success, "message": message})

@app.route('/api/lms/load', methods=['POST'])
@requires_auth
def lms_load():
    model_name = request.json.get('model_name')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = lms_manager.load_local_model(model_name)
    return jsonify({"success": success, "message": message})

@app.route('/api/lms/unload', methods=['POST'])
@requires_auth
def lms_unload():
    model_name = request.json.get('model_name')
    success, message = lms_manager.unload_local_model(model_name)
    return jsonify({"success": success, "message": message})

@app.route('/api/lms/delete', methods=['POST'])
@requires_auth
def lms_delete():
    model_name = request.json.get('model_name')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = lms_manager.delete_local_model(model_name)
    return jsonify({"success": success, "message": message})

@app.route('/api/lms/start', methods=['POST'])
@requires_auth
def lms_start():
    success, message = lms_manager.start_lms_daemon()
    return jsonify({"success": success, "message": message})

@app.route('/api/lms/stop', methods=['POST'])
@requires_auth
def lms_stop():
    success, message = lms_manager.stop_lms_daemon()
    return jsonify({"success": success, "message": message})


# --- Headless ComfyUI & Dependency Resolver API ---
from utils import comfy_manager

@app.route('/api/comfy/status', methods=['GET'])
@requires_auth
def comfy_status():
    installed = comfy_manager.check_comfy_installed()
    running = comfy_manager.check_comfy_running()
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
    success, message = comfy_manager.start_comfy_daemon()
    return jsonify({"success": success, "message": message})

@app.route('/api/comfy/stop', methods=['POST'])
@requires_auth
def comfy_stop():
    success, message = comfy_manager.stop_comfy_daemon()
    return jsonify({"success": success, "message": message})

@app.route('/api/comfy/resolve_workflow', methods=['POST'])
@requires_auth
def comfy_resolve_workflow():
    import json
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
                base_dir = os.path.dirname(os.path.abspath(__file__))
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
                base_dir = os.path.dirname(os.path.abspath(__file__))
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
            return jsonify({"error": f"Failed to read companion workflows: {e}"}), 500
            
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
        base_dir = os.path.dirname(os.path.abspath(__file__))
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


# Start prewarming in a background daemon thread now that everything is fully defined
import threading
threading.Thread(target=prewarm_caches, daemon=True).start()

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