import os
import shutil

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
    runner_backend = os.getenv("RUNNER_BACKEND", "google_adk").lower()
    if runner_backend == "opensource":
        runner = OpenSourceRunner(app_name="Sanctuary")
        print(">>> Starting Sanctuary using decoupled OPEN-SOURCE Runner backend!")
    else:
        try:
            runner = GoogleAdkRunner(app_name="Sanctuary")
            print(">>> Starting Sanctuary using GOOGLE ADK Runner backend!")
        except Exception as e:
            print(f">>>> WARNING: Failed to initialize GoogleAdkRunner backend: {e}")
            print(">>>> Falling back to OpenSourceRunner (offline mode) so server can run.")
            runner = OpenSourceRunner(app_name="Sanctuary")

@app.before_request
def check_program_change():
    global _cached_active_program, _cached_active_user
    from utils.program import get_active_program
    current_program = get_active_program()
    
    from variables import ACTIVE_USER_FILE
    current_user = "builder"
    if os.path.exists(ACTIVE_USER_FILE):
        try:
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                current_user = f.read().strip()
        except Exception as e:
            print(f"Error reading active user file: {e}")
            
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


# Initialize active_program.txt from environment if it doesn't exist
try:
    from variables import ACTIVE_PROGRAM_FILE
    if not os.path.exists(ACTIVE_PROGRAM_FILE):
        active_mon = os.getenv("ACTIVE_PROGRAM")
        if not active_mon:
            raise ValueError("ACTIVE_PROGRAM environment variable is not set and active_program.txt does not exist")
        with open(ACTIVE_PROGRAM_FILE, "w", encoding="utf-8") as f:
            f.write(active_mon)
except Exception as e:
    print(f"Error initializing active_program.txt: {e}")
    raise

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
    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
    import json
    theme = None
    theme_path = os.path.join(base_dir, "core", "programs", active_program, "theme.json")
    if os.path.exists(theme_path):
        try:
            with open(theme_path, "r", encoding="utf-8") as tf:
                theme = json.load(tf)
        except Exception as e:
            print(f"Error loading theme for {active_program}: {e}")

    from variables import ACTIVE_USER_FILE
    active_user = "builder"
    if os.getenv("AUTH_USER") and request.authorization:
        # If Basic Auth is active, default active user to authenticated user if txt doesn't exist
        active_user = request.authorization.username
    if os.path.exists(ACTIVE_USER_FILE):
        try:
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                active_user = f.read().strip()
        except Exception:
            pass

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
    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
    path_svg = os.path.join('core', 'programs', active_program, 'profile.svg')
    if os.path.exists(path_svg):
        response = send_file(path_svg, mimetype='image/svg+xml')
    else:
        path = os.path.join('core', 'programs', active_program, 'app_icon.png')
        if os.path.exists(path):
            response = send_file(path)
        else:
            response = send_file('images/app_icon.png')
            
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res
 
@app.route('/profile.svg')
def profile_svg():
    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
    path_svg = os.path.join('core', 'programs', active_program, 'profile.svg')
    if os.path.exists(path_svg):
        response = send_file(path_svg, mimetype='image/svg+xml')
    else:
        path_icon = os.path.join('core', 'programs', active_program, 'app_icon.png')
        if os.path.exists(path_icon):
            response = send_file(path_icon)
        else:
            response = send_file('images/app_icon.png')
            
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res
 
@app.route('/programs/<program_id>/profile.svg')
def program_profile_svg(program_id):
    # Ensure program_id is safe (alphanumeric/simple)
    if not program_id.isalnum() and '_' not in program_id:
        return "Invalid program ID", 400
    path_svg = os.path.join('core', 'programs', program_id, 'profile.svg')
    if os.path.exists(path_svg):
        response = send_file(path_svg, mimetype='image/svg+xml')
    else:
        path_icon = os.path.join('core', 'programs', program_id, 'app_icon.png')
        if os.path.exists(path_icon):
            response = send_file(path_icon)
        else:
            response = send_file('images/app_icon.png')
            
    from flask import make_response
    res = make_response(response)
    res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
    return res
 
@app.route('/images/<path:filename>')
@requires_auth
def serve_image(filename):
    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
    program_dir = os.path.join('core', 'programs', active_program)
    return send_from_directory(program_dir, filename)

@app.route('/history', methods=['GET'])
@requires_auth
def history():
    session_id = request.args.get('session_id', 'default')
    try:
        chat_history = asyncio.run(runner.get_history(session_id))
        
        # Analyze last message from Companion to determine state
        last_companion_text = ""
        for msg in reversed(chat_history):
            if msg.get('role') == 'companion':
                last_companion_text = msg.get('text', '')
                break
        
        import tools
        state_info = tools.analyze_emotional_state(last_companion_text)
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id))
        
        from core.program_config import companion_name
        active_program = os.environ.get("ACTIVE_PROGRAM", "arthur")
        
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

    active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
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
        
        # Apply banned words filter to output response
        from utils.banned_words import sanitize_text
        sanitized_response = sanitize_text(response_text)
        if sanitized_response != response_text:
            print(f"[BANNED WORDS] Sanitizing response: '{response_text}' -> '{sanitized_response}'")
            # Update the message text inside the runner history so that the change persists
            chat_history = asyncio.run(runner.get_history(session_id))
            companion_count = sum(1 for msg in chat_history if msg.get('role') == 'companion')
            if companion_count > 0:
                asyncio.run(runner.update_message_text(session_id, 'companion', companion_count - 1, sanitized_response))
            response_text = sanitized_response

        import tools
        state_info = tools.analyze_emotional_state(response_text)
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id))
        return jsonify({
            'response': response_text,
            'tool_calls': tool_calls,
            'state': state_info,
            'inversion_active': inversion_mode
        })
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"Error occurred in chat: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/edit', methods=['POST'])
@requires_auth
def edit():
    session_id = request.json.get('session_id', 'default')
    user_message_index = request.json.get('user_message_index') # 0-based index of user messages
    new_text = request.json.get('new_text') # None means reroll (use original text)
    selected_model = request.json.get('model')

    try:
        response_text, tool_calls = asyncio.run(
            runner.edit_turn(
                session_id=session_id,
                user_message_index=user_message_index,
                new_text=new_text,
                model=selected_model
            )
        )
        
        # Apply banned words filter to output response
        from utils.banned_words import sanitize_text
        sanitized_response = sanitize_text(response_text)
        if sanitized_response != response_text:
            print(f"[BANNED WORDS] Sanitizing edited response: '{response_text}' -> '{sanitized_response}'")
            # Update the message text inside the runner history so that the change persists
            chat_history = asyncio.run(runner.get_history(session_id))
            companion_count = sum(1 for msg in chat_history if msg.get('role') == 'companion')
            if companion_count > 0:
                asyncio.run(runner.update_message_text(session_id, 'companion', companion_count - 1, sanitized_response))
            response_text = sanitized_response

        import tools
        state_info = tools.analyze_emotional_state(response_text)
        inversion_mode = asyncio.run(runner._get_inversion_mode(session_id))
        return jsonify({
            'response': response_text,
            'tool_calls': tool_calls,
            'state': state_info,
            'inversion_active': inversion_mode
        })
    except Exception as e:
        print(f"Error occurred during edit: {e}")
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
    user_message_index = request.json.get('user_message_index')
    
    try:
        asyncio.run(runner.delete_turn(session_id, user_message_index))
        return jsonify({'status': 'success'})
    except Exception as e:
        print(f"Error deleting turn in session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500

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
    image_url = request.json.get('image_url')
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400
        
    try:
        # Detach from session log - simply delete the file from the local disk
        success = runner._delete_local_image(image_url)
        if success:
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Image file not found on disk'}), 404
    except Exception as e:
        print(f"Error deleting image file {image_url}: {e}")
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
            active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
            if old_image_url.startswith('/images/'):
                img_subpath = old_image_url[8:]
            else:
                img_subpath = os.path.basename(old_image_url)
            png_path = os.path.normpath(os.path.join(base_dir, 'core', 'programs', active_program, img_subpath))
            
            json_path = png_path.rsplit('.', 1)[0] + '.json'
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
            return jsonify({'error': 'Original prompt not found in sidecar metadata or session history. Unable to regenerate image.'}), 400

    try:
        import tools
        # Generate new portrait
        new_markdown = tools.generate_companion_portrait(prompt)
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

@app.route('/api/animate_image', methods=['POST'])
@requires_auth
def animate_image():
    return jsonify({'error': 'Portrait animation (video generation) is not supported in this version.'}), 501

@app.route('/list_images', methods=['GET'])
@requires_auth
def list_images():
    try:
        active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
        portraits_dir = os.path.join('core', 'programs', active_program, 'portraits')
        if not os.path.exists(portraits_dir):
            return jsonify({'images': []})
        files = os.listdir(portraits_dir)
        image_files = [f for f in files if f.lower().endswith(('.png', '.jpg', '.jpeg', '.gif'))]
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
    for call_id, info in tools.pending_tool_calls.items():
        if info['status'] == 'pending':
            return jsonify({
                'call_id': call_id,
                'tool_name': info['tool_name'],
                'details': info['details']
            })
    return jsonify({'call_id': None})

@app.route('/approve_tool', methods=['POST'])
@requires_auth
def approve_tool():
    import tools
    call_id = request.json.get('call_id')
    status = request.json.get('status')
    
    if call_id in tools.pending_tool_calls:
        tools.pending_tool_calls[call_id]['status'] = status
        return jsonify({'status': 'success'})
    return jsonify({'error': 'Tool call not found'}), 404

from utils.models import fetch_local_models

_cached_gemini_models = None

def fetch_gemini_models(api_key):
    """Dynamically fetches active models from the Gemini API and caches the result."""
    global _cached_gemini_models
    if _cached_gemini_models is not None:
        return _cached_gemini_models
        
    import requests
    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={api_key}&pageSize=1000"
        response = requests.get(url, timeout=1.5)
        if response.status_code == 200:
            data = response.json()
            gemini_models = []
            for m in data.get("models", []):
                name = m.get("name", "")
                display_name = m.get("displayName", "")
                methods = m.get("supportedGenerationMethods", [])
                
                # Check if it supports text content generation and is a standard user model
                if "generateContent" in methods and name.startswith("models/"):
                    val = name.replace("models/", "")
                    val_lower = val.lower()
                    
                    # Filter out tuning, embeddings, image/video, audio, or other utility models
                    exclude_keywords = [
                        "embed", "tuning", "bidi", "aqa", "imagen", "veo", "lyria", 
                        "gemma", "deep-research", "robotics", "antigravity", "computer-use"
                    ]
                    if any(x in val_lower for x in exclude_keywords):
                        continue
                        
                    # Filter out specific features, snapshots, or transient variants
                    exclude_suffixes = [
                        "-tts", "-audio", "-image", "-live", "-001", "-002", "-003", "-004", "-005"
                    ]
                    if any(x in val_lower for x in exclude_suffixes):
                        continue
                        
                    gemini_models.append({"value": val, "label": display_name})
            
            if gemini_models:
                _cached_gemini_models = gemini_models
                return gemini_models
    except Exception as e:
        print(f"Error fetching Gemini models dynamically: {e}")
        
    return []

@app.route('/models', methods=['GET'])
@requires_auth
def get_models():
    # Determine the active runner backend
    runner_backend = os.getenv("RUNNER_BACKEND", "google_adk").lower()
    
    # Check if Gemini API key and Project ID are validly configured (not empty, not placeholder)
    gemini_key = os.getenv("GEMINI_API_KEY")
    project_id = os.getenv("PROJECT_ID")
    is_gemini_configured = bool(
        gemini_key and gemini_key.strip() and gemini_key != "your_gemini_api_key_here" and
        project_id and project_id.strip() and project_id != "your_gcp_project_id_here"
    )
    
    from utils.lms_manager import check_daemon_status, list_local_models, check_lms_cli
    is_lm_studio_online = check_daemon_status()
    
    # 1. Fetch dynamic local models (only actively loaded models in LM Studio)
    models = fetch_local_models()
    
    # 3. If Gemini is configured and we are not in pure opensource mode, fetch dynamic Gemini models
    if runner_backend != "opensource" and is_gemini_configured:
        gemini_list = fetch_gemini_models(gemini_key)
        models.extend(gemini_list)
        
    # Default fallback: use the first loaded local model if available, otherwise "local-lm-studio"
    default_model = "local-lm-studio"
    if models and models[0]["value"] != "local-lm-studio":
        default_model = models[0]["value"]
        
    return jsonify({
        "models": models,
        "default": default_model,
        "status": {
            "gemini_configured": is_gemini_configured,
            "lm_studio_online": is_lm_studio_online,
            "lms_installed": check_lms_cli()
        }
    })

@app.route('/api/save_config', methods=['POST'])
@requires_auth
def save_config():
    try:
        data = request.get_json() or {}
        gemini_api_key = data.get('gemini_api_key', '').strip()
        project_id = data.get('project_id', '').strip()
        
        if not gemini_api_key and not project_id:
            return jsonify({'error': 'No configuration values provided.'}), 400
            
        if (gemini_api_key and not project_id) or (project_id and not gemini_api_key):
            return jsonify({'error': 'GCP Project ID and Gemini API Key must both be provided to configure Google Gemini.'}), 400
            
        base_dir = os.path.dirname(os.path.abspath(__file__))
        env_path = os.path.join(base_dir, '.env')
        
        # Read env lines
        with open(env_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()
            
        updated_key = False
        updated_proj = False
        updated_backend = False
        
        for i, line in enumerate(lines):
            stripped = line.strip()
            if stripped.startswith('GEMINI_API_KEY=') and gemini_api_key:
                lines[i] = f"GEMINI_API_KEY={gemini_api_key}\n"
                updated_key = True
            elif stripped.startswith('PROJECT_ID=') and project_id:
                lines[i] = f"PROJECT_ID={project_id}\n"
                updated_proj = True
            elif stripped.startswith('RUNNER_BACKEND=') and gemini_api_key and project_id:
                lines[i] = f"RUNNER_BACKEND=google_adk\n"
                updated_backend = True
                
        if gemini_api_key and project_id:
            if not updated_key:
                lines.append(f"GEMINI_API_KEY={gemini_api_key}\n")
            if not updated_proj:
                lines.append(f"PROJECT_ID={project_id}\n")
            if not updated_backend:
                lines.append("RUNNER_BACKEND=google_adk\n")
            
            # Hot-reload environment variables in current process memory
            os.environ["GEMINI_API_KEY"] = gemini_api_key
            os.environ["PROJECT_ID"] = project_id
            os.environ["RUNNER_BACKEND"] = "google_adk"
            
            # Invalidate dynamic Gemini models cache
            global _cached_gemini_models
            _cached_gemini_models = None
            
            # Re-initialize the runner backend dynamically
            init_runner()
            
            # Clear runner sessions history to reload character instructions
            if hasattr(runner, 'sessions_history'):
                runner.sessions_history.clear()
            if hasattr(runner, 'runner') and hasattr(runner.runner, 'session_service'):
                runner.runner.session_service.sessions.clear()
                
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
        return jsonify({"error": str(e)}), 500
@app.route('/api/programs', methods=['GET'])
@requires_auth
def list_programs():
    try:
        active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
        from variables import PROGRAMS_DIR
        programs_dir = PROGRAMS_DIR
        
        programs = []
        if os.path.exists(programs_dir):
            for folder in os.listdir(programs_dir):
                folder_path = os.path.join(programs_dir, folder)
                if os.path.isdir(folder_path):
                    companion_name = folder.title()
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
        
        # Update active_program.txt to sync across processes/threads
        try:
            from variables import ACTIVE_PROGRAM_FILE
            with open(ACTIVE_PROGRAM_FILE, 'w', encoding='utf-8') as f:
                f.write(program_id)
        except Exception as e:
            print(f"Error persisting ACTIVE_PROGRAM to active_program.txt: {e}")
        
        # Update .env file to persist across restarts
        try:
            env_path = os.path.join(base_dir, '.env')
            if os.path.exists(env_path):
                with open(env_path, 'r', encoding='utf-8') as f:
                    lines = f.readlines()
                updated = False
                for i, line in enumerate(lines):
                    if line.strip().startswith('ACTIVE_PROGRAM='):
                        lines[i] = f"ACTIVE_PROGRAM={program_id}\n"
                        updated = True
                        break
                if not updated:
                    lines.append(f"\nACTIVE_PROGRAM={program_id}\n")
                with open(env_path, 'w', encoding='utf-8') as f:
                    f.writelines(lines)
        except Exception as e:
            print(f"Error persisting ACTIVE_PROGRAM to .env: {e}")

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


@app.route('/api/programs/delete', methods=['POST'])
@requires_auth
def delete_program():
    try:
        data = request.get_json(silent=True) or {}
        program_id = data.get('program_id')
        if not program_id:
            return jsonify({'error': 'Missing program_id'}), 400
            
        if program_id == 'arthur':
            return jsonify({'error': 'Cannot delete default companion Arthur'}), 400
            
        if program_id == 'sebile':
            return jsonify({'error': 'Cannot delete essential companion Sebile'}), 400
            
        base_dir = os.path.dirname(os.path.abspath(__file__))
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if not os.path.exists(program_path):
            return jsonify({'error': f"Program '{program_id}' does not exist"}), 404
            
        # If the deleted program is currently active, switch to Arthur first
        active_program = os.getenv("ACTIVE_PROGRAM", "arthur")
        if program_id == active_program:
            os.environ["ACTIVE_PROGRAM"] = "arthur"
            try:
                from variables import ACTIVE_PROGRAM_FILE
                with open(ACTIVE_PROGRAM_FILE, 'w', encoding='utf-8') as f:
                    f.write("arthur")
            except Exception as e:
                print(f"Error resetting active program to arthur: {e}")
                
            try:
                env_path = os.path.join(base_dir, '.env')
                if os.path.exists(env_path):
                    with open(env_path, 'r', encoding='utf-8') as f:
                        lines = f.readlines()
                    updated = False
                    for i, line in enumerate(lines):
                        if line.strip().startswith('ACTIVE_PROGRAM='):
                            lines[i] = "ACTIVE_PROGRAM=arthur\n"
                            updated = True
                            break
                    if not updated:
                        lines.append("\nACTIVE_PROGRAM=arthur\n")
                    with open(env_path, 'w', encoding='utf-8') as f:
                        f.writelines(lines)
            except Exception as e:
                print(f"Error resetting ACTIVE_PROGRAM in .env: {e}")
                
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
        
        return jsonify({'status': 'success', 'switched_to': 'arthur' if program_id == active_program else None})
    except Exception as e:
        import traceback
        traceback.print_exc()
        return jsonify({'error': str(e)}), 500


@app.route('/api/user_profiles', methods=['GET'])
@requires_auth
def list_user_profiles():
    try:
        from variables import USER_PROFILES_DIR, ACTIVE_USER_FILE
        if not os.path.exists(USER_PROFILES_DIR):
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
        
        # Get active user profile
        active_user = "builder"
        if os.path.exists(ACTIVE_USER_FILE):
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                active_user = f.read().strip()
        
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
        
        from variables import USER_PROFILES_DIR, ACTIVE_USER_FILE
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        if not os.path.exists(profile_path):
            return jsonify({"error": f"Profile '{profile_id}' does not exist"}), 404
        
        # Update active_user.txt
        with open(ACTIVE_USER_FILE, "w", encoding="utf-8") as f:
            f.write(profile_id)
        
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
            
        from variables import USER_PROFILES_DIR, ACTIVE_USER_FILE
        if not os.path.exists(USER_PROFILES_DIR):
            os.makedirs(USER_PROFILES_DIR, exist_ok=True)
            
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        with open(profile_path, "w", encoding="utf-8") as f:
            f.write(content)
            
        # Read active profile
        active_user = "builder"
        if os.path.exists(ACTIVE_USER_FILE):
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                active_user = f.read().strip()
        
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
            
        from variables import USER_PROFILES_DIR, ACTIVE_USER_FILE
        profile_path = os.path.join(USER_PROFILES_DIR, f"{profile_id}.md")
        if not os.path.exists(profile_path):
            return jsonify({"error": f"Profile '{profile_id}' does not exist"}), 404
            
        # Delete file
        os.remove(profile_path)
        
        # If the deleted profile was active, switch active profile back to "builder"
        active_user = "builder"
        if os.path.exists(ACTIVE_USER_FILE):
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                active_user = f.read().strip()
                
        if profile_id == active_user:
            with open(ACTIVE_USER_FILE, "w", encoding="utf-8") as f:
                f.write("builder")
                
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
            
        from variables import USER_PROFILES_DIR, ACTIVE_USER_FILE
        old_path = os.path.join(USER_PROFILES_DIR, f"{old_profile_id}.md")
        new_path = os.path.join(USER_PROFILES_DIR, f"{new_profile_id}.md")
        
        if not os.path.exists(old_path):
            return jsonify({"error": f"Profile '{old_profile_id}' does not exist"}), 404
            
        if os.path.exists(new_path):
            return jsonify({"error": f"Profile '{new_profile_id}' already exists"}), 400
            
        # Rename file
        os.rename(old_path, new_path)
        
        # Check active user
        active_user = "builder"
        if os.path.exists(ACTIVE_USER_FILE):
            with open(ACTIVE_USER_FILE, "r", encoding="utf-8") as f:
                active_user = f.read().strip()
                
        # If the renamed profile was active, update ACTIVE_USER_FILE and reload
        if old_profile_id == active_user:
            with open(ACTIVE_USER_FILE, "w", encoding="utf-8") as f:
                f.write(new_profile_id)
                
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





def generate_character_theme(primary_hex):
    import re
    hex_clean = primary_hex.lstrip('#')
    r = int(hex_clean[0:2], 16)
    g = int(hex_clean[2:4], 16)
    b = int(hex_clean[4:6], 16)
    
    brightness = (r * 299 + g * 587 + b * 114) / 1000
    btn_text = "#121214" if brightness > 140 else "#ffffff"
    
    accent_r = min(255, int(r + (255 - r) * 0.25))
    accent_g = min(255, int(g + (255 - g) * 0.25))
    accent_b = min(255, int(b + (255 - b) * 0.25))
    accent_green = f"#{accent_r:02x}{accent_g:02x}{accent_b:02x}"
    
    return {
        "primary_accent": primary_hex,
        "primary_glow": f"rgba({r}, {g}, {b}, 0.08)",
        "companion_bubble": f"rgba({24 + int(r*0.04)}, {24 + int(g*0.04)}, {28 + int(b*0.04)}, 0.85)",
        "send_btn_hover": f"rgba({20 + int(r*0.12)}, {20 + int(g*0.12)}, {22 + int(b*0.12)}, 0.75)",
        "accent_green": accent_green,
        "quote_blue": primary_hex,
        "primary_btn_text": btn_text
    }

def get_animated_svg_template(body_color, wing_color, eye_color, name="", description="", personality=""):
    text = (name + " " + description + " " + personality).lower()
    
    # 1. Determine Archetype based on Species/Vibe & Personality Keywords
    # Initialize scoring dictionary
    scores = {
        "slime": 0,
        "robot": 0,
        "angel": 0,
        "fairy": 0,
        "dragon": 0,
        "beast": 0,
        "ghost": 0
    }
    
    # Slime indicators: Lazy, goofy, bubbly, soft, jelly, gooey, slow
    slime_keywords = ["slime", "blob", "goo", "jelly", "lazy", "goofy", "bubbly", "soft", "dumb", "clumsy", "cute"]
    # Robot indicators: Shy, tech, quiet, mechanical, analytical, nerd, logical, awkward, online, computing
    robot_keywords = ["robot", "mech", "cyborg", "android", "synth", "shy", "nerd", "awkward", "online", "game", "gamer", "tech", "smart", "quiet", "analytical", "cold"]
    # Angel indicators: Kind, gentle, holy, pure, sweet, protective, healer, warm, noble, graceful
    angel_keywords = ["angel", "cherub", "seraph", "halo", "heaven", "kind", "gentle", "pure", "sweet", "calm", "protect", "healer", "warm", "loving", "polite"]
    # Fairy indicators: Playful, chaotic, mischievous, sassy, sarcastic, witty, magical, small, tease
    fairy_keywords = ["fairy", "pixie", "sprite", "playful", "chaotic", "mischievous", "sarcastic", "tease", "sassy", "witty", "magic", "troll"]
    # Dragon indicators: Fierce, angry, proud, strong, flame, fire, dragon, beastly, warrior, dominant, confident
    dragon_keywords = ["dragon", "drake", "wyvern", "lizard", "fierce", "angry", "proud", "strong", "fire", "flame", "warrior", "confident", "brave", "hot"]
    # Beast indicators: Energetic, wild, athletic, cat, fox, wolf, dog, neko, animal, fast, active, loud
    beast_keywords = ["cat", "neko", "fox", "kitsune", "wolf", "dog", "beast", "animal", "energetic", "wild", "fast", "active", "hunt", "athletic", "gym"]
    # Ghost indicators: Stoic, mysterious, silent, sad, melancholic, ghost, phantom, spirit, shadow, spooky, dark
    ghost_keywords = ["ghost", "phantom", "spirit", "specter", "shadow", "stoic", "mysterious", "silent", "sad", "melancholy", "spooky", "dark", "dead", "hollow"]
    
    for kw in slime_keywords:
        if kw in text: scores["slime"] += 1
    for kw in robot_keywords:
        if kw in text: scores["robot"] += 1.2 # slightly favor robot for tech/gamer/nerdy characters
    for kw in angel_keywords:
        if kw in text: scores["angel"] += 1
    for kw in fairy_keywords:
        if kw in text: scores["fairy"] += 1
    for kw in dragon_keywords:
        if kw in text: scores["dragon"] += 1
    for kw in beast_keywords:
        if kw in text: scores["beast"] += 1
    for kw in ghost_keywords:
        if kw in text: scores["ghost"] += 1
        
    # Get the highest scoring archetype, fallback to humanoid if all scores are 0
    max_score = max(scores.values())
    if max_score > 0:
        archetype = [k for k, v in scores.items() if v == max_score][0]
    else:
        archetype = "humanoid"
        
    # Generate custom hair color from wing_color or a lighter tint of body_color
    hair_color = wing_color
    clothes_color = body_color
    
    # Render corresponding animated pixel-art template
    if archetype == "slime":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 3 22 15" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes squish {{
      0%, 100% {{ transform: scaleY(1) translateY(0); }}
      50% {{ transform: scaleY(0.7) translateY(4.5px); }}
    }}
    @keyframes core-glow {{
      0%, 100% {{ opacity: 0.5; }}
      50% {{ opacity: 1.0; }}
    }}
    .slime-body {{
      transform-origin: 16px 17px;
      animation: squish 1.4s ease-in-out infinite;
    }}
    .slime-core {{
      transform-origin: 16px 17px;
      animation: squish 1.4s ease-in-out infinite, core-glow 2s ease-in-out infinite;
    }}
  </style>
  <!-- Slime Blob Body -->
  <path class="slime-body" d="M13,9 h6 v1 h2 v1 h1 v1 h1 v4 h-11 v-4 h1 v-1 h1 v-1 h1 z" fill="{body_color}"/>
  <!-- Glowing Inner Core/Eyes -->
  <path class="slime-core" d="M15,11 h2 v2 h-2 z" fill="{eye_color}"/>
  <rect class="slime-core" x="14" y="10" width="1" height="1" fill="{eye_color}"/>
  <rect class="slime-core" x="17" y="10" width="1" height="1" fill="{eye_color}"/>
</svg>"""

    elif archetype == "robot":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 3 22 15" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes hover-mech {{
      0%, 100% {{ transform: translateY(0); }}
      50% {{ transform: translateY(-1px); }}
    }}
    @keyframes sparks {{
      0%, 100% {{ transform: scaleY(1); opacity: 0.8; }}
      50% {{ transform: scaleY(0.3); opacity: 0.2; }}
    }}
    .mech {{
      animation: hover-mech 0.8s ease-in-out infinite;
    }}
    .thruster {{
      transform-origin: 16px 17px;
      animation: sparks 0.3s steps(3) infinite;
    }}
  </style>
  <!-- Thruster flame/sparks -->
  <path class="thruster" d="M14,16 h4 v2 h-4 z M15,18 h2 v1 h-2 z" fill="{wing_color}"/>
  <g class="mech">
    <!-- Blocky robot frame -->
    <rect x="13" y="10" width="6" height="6" fill="{body_color}"/>
    <rect x="12" y="5" width="8" height="5" fill="{body_color}"/>
    <!-- Iron ears / antennas -->
    <rect x="11" y="4" width="1" height="3" fill="{wing_color}"/>
    <rect x="20" y="4" width="1" height="3" fill="{wing_color}"/>
    <!-- Glowing Visor Eye -->
    <rect x="13" y="7" width="6" height="1" fill="{eye_color}"/>
    <!-- Panel details -->
    <rect x="15" y="12" width="2" height="2" fill="#1e293b"/>
  </g>
</svg>"""

    elif archetype == "angel":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 3 22 15" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes float-angel {{
      0%, 100% {{ transform: translateY(0); }}
      50% {{ transform: translateY(-1.2px); }}
    }}
    @keyframes halo-shimmer {{
      0%, 100% {{ transform: translateY(0) scale(1); opacity: 0.9; }}
      50% {{ transform: translateY(-0.8px) scale(1.05); opacity: 1.0; }}
    }}
    @keyframes wings-angel {{
      0%, 100% {{ transform: scaleY(1); }}
      50% {{ transform: scaleY(0.7); }}
    }}
    .angel-body {{
      animation: float-angel 1.4s ease-in-out infinite;
    }}
    .halo {{
      transform-origin: 16px 4px;
      animation: float-angel 1.4s ease-in-out infinite, halo-shimmer 2s ease-in-out infinite;
    }}
    .wings {{
      transform-origin: 16px 11px;
      animation: float-angel 1.4s ease-in-out infinite, wings-angel 0.8s ease-in-out infinite;
    }}
  </style>
  <!-- Feather Wings -->
  <g class="wings">
    <path d="M12,9 h-4 v-2 h-2 v4 h1 v2 h3 v1 h2 z" fill="#ffffff" opacity="0.95"/>
    <path d="M20,9 h 4 v-2 h 2 v4 h-1 v2 h-3 v1 h-2 z" fill="#ffffff" opacity="0.95"/>
  </g>
  <!-- Floating Halo -->
  <path class="halo" d="M13,3 h6 v1 h-6 z M12,4 h1 v1 h-1 z M19,4 h1 v1 h-1 z" fill="#fde047"/>
  <g class="angel-body">
    <!-- Humanoid body / dress -->
    <rect x="14" y="6" width="4" height="4" fill="{body_color}"/>
    <rect x="13" y="10" width="6" height="5" fill="{clothes_color}"/>
    <!-- Hair -->
    <path d="M13,5 h6 v2 h-1 v3 h-4 v-3 h-1 z" fill="{hair_color}"/>
    <!-- Eyes -->
    <rect x="14" y="7" width="1" height="1" fill="{eye_color}"/>
    <rect x="17" y="7" width="1" height="1" fill="{eye_color}"/>
  </g>
</svg>"""

    elif archetype == "fairy":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 3 22 15" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes float-fairy {{
      0%, 100% {{ transform: translateY(0); }}
      50% {{ transform: translateY(-1.5px); }}
    }}
    @keyframes wings-fairy {{
      0%, 100% {{ transform: scaleX(1); }}
      50% {{ transform: scaleX(0.4); }}
    }}
    .body {{
      animation: float-fairy 1.2s ease-in-out infinite;
    }}
    .wing-l {{
      transform-origin: 14px 10px;
      animation: float-fairy 1.2s ease-in-out infinite, wings-fairy 0.4s ease-in-out infinite;
    }}
    .wing-r {{
      transform-origin: 18px 10px;
      animation: float-fairy 1.2s ease-in-out infinite, wings-fairy 0.4s ease-in-out infinite;
      animation-delay: 0.2s;
    }}
  </style>
  <g class="wing-l">
    <path d="M13,9 h-3 v1 h-2 v2 h-1 v3 h1 v2 h2 v1 h3 v-1 h1 v-2 h1 v-3 h-1 v-2 h-1 z" fill="{wing_color}" opacity="0.8"/>
  </g>
  <g class="wing-r">
    <path d="M19,9 h3 v1 h2 v2 h1 v3 h-1 v2 h-2 v1 h-3 v-1 h-1 v-2 h-1 v-3 h-1 v-2 h-1 z" fill="{wing_color}" opacity="0.8"/>
  </g>
  <g class="body">
    <rect x="14" y="5" width="4" height="4" fill="{body_color}"/>
    <!-- Clothes -->
    <rect x="14" y="9" width="4" height="6" fill="{clothes_color}"/>
    <!-- Hair -->
    <path d="M13,4 h6 v2 h-1 v3 h-4 v-3 h-1 z" fill="{hair_color}"/>
    <!-- Eyes -->
    <rect x="15" y="6" width="1" height="1" fill="{eye_color}"/>
    <rect x="17" y="6" width="1" height="1" fill="{eye_color}"/>
  </g>
</svg>"""

    elif archetype == "dragon":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 3 22 15" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes float-drag {{
      0%, 100% {{ transform: translateY(0); }}
      50% {{ transform: translateY(-1.5px); }}
    }}
    @keyframes wings-drag {{
      0%, 100% {{ transform: scaleY(1); }}
      50% {{ transform: scaleY(0.4); }}
    }}
    .dragon {{
      animation: float-drag 1s ease-in-out infinite;
    }}
    .wings {{
      transform-origin: 16px 14px;
      animation: float-drag 1s ease-in-out infinite, wings-drag 0.6s ease-in-out infinite;
    }}
  </style>
  <g class="wings">
    <path d="M12,10 h-4 v-2 h-2 v2 h1 v2 h2 v1 h3 z" fill="{wing_color}"/>
    <path d="M20,10 h 4 v-2 h 2 v2 h-1 v2 h-2 v-1 h-3 z" fill="{wing_color}"/>
  </g>
  <g class="dragon">
    <rect x="14" y="11" width="4" height="6" fill="{body_color}"/>
    <path d="M18,16 h2 v-1 h1 v-1 h1 v1 h-1 v1 h-2 v1 h-1 z" fill="{wing_color}"/>
    <rect x="12" y="6" width="8" height="6" fill="{body_color}"/>
    <!-- Horns -->
    <rect x="12" y="4" width="2" height="2" fill="{wing_color}"/>
    <rect x="18" y="4" width="2" height="2" fill="{wing_color}"/>
    <!-- Eyes -->
    <rect x="13" y="8" width="2" height="1" fill="{eye_color}"/>
    <rect x="17" y="8" width="2" height="1" fill="{eye_color}"/>
  </g>
</svg>"""

    elif archetype == "beast":
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="5 3 22 15" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes float-beast {{
      0%, 100% {{ transform: translateY(0); }}
      50% {{ transform: translateY(-1px); }}
    }}
    @keyframes tail-wag {{
      0%, 100% {{ transform: rotate(0deg); }}
      50% {{ transform: rotate(15deg) translateY(-0.5px); }}
    }}
    .beast {{
      animation: float-beast 1.2s ease-in-out infinite;
    }}
    .tail {{
      transform-origin: 13px 13px;
      animation: tail-wag 0.8s ease-in-out infinite;
    }}
  </style>
  <g class="beast">
    <!-- Tail -->
    <path class="tail" d="M12,12 h-3 v-2 h-1 v-1 h1 v2 h3 z" fill="{wing_color}"/>
    <!-- Body -->
    <rect x="12" y="10" width="8" height="5" fill="{body_color}"/>
    <!-- Head -->
    <rect x="15" y="6" width="6" height="5" fill="{body_color}"/>
    <!-- Pointy ears -->
    <rect x="15" y="4" width="2" height="2" fill="{wing_color}"/>
    <rect x="19" y="4" width="2" height="2" fill="{wing_color}"/>
    <!-- Legs -->
    <rect x="13" y="15" width="1" height="2" fill="{body_color}"/>
    <rect x="15" y="15" width="1" height="2" fill="{body_color}"/>
    <rect x="17" y="15" width="1" height="2" fill="{body_color}"/>
    <rect x="19" y="15" width="1" height="2" fill="{body_color}"/>
    <!-- Glowing eyes -->
    <rect x="18" y="7" width="1" height="1" fill="{eye_color}"/>
    <rect x="20" y="7" width="1" height="1" fill="{eye_color}"/>
  </g>
</svg>"""

    else: # Humanoid base (No wings)
        return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="6 3 20 17" width="100%" height="100%" shape-rendering="crispEdges">
  <style>
    @keyframes breathe {{
      0%, 100% {{ transform: translateY(0); }}
      50% {{ transform: translateY(-0.8px); }}
    }}
  </style>
  <g style="animation: breathe 1.5s ease-in-out infinite;">
    <!-- Head/Skin -->
    <rect x="14" y="5" width="4" height="4" fill="#fed7aa"/>
    <!-- Dynamic hair overlay (framed around head) -->
    <path d="M13,4 h6 v2 h-1 v3 h-4 v-3 h-1 z" fill="{hair_color}"/>
    <!-- Eyes -->
    <rect x="14" y="6" width="1" height="1" fill="{eye_color}"/>
    <rect x="17" y="6" width="1" height="1" fill="{eye_color}"/>
    <!-- Body/Shirt/Dress -->
    <rect x="14" y="9" width="4" height="6" fill="{clothes_color}"/>
    <!-- Shoulder straps / sleeves details -->
    <rect x="13" y="9" width="1" height="3" fill="{hair_color}"/>
    <rect x="18" y="9" width="1" height="3" fill="{hair_color}"/>
    <!-- Legs -->
    <rect x="14" y="15" width="1" height="3" fill="#fed7aa"/>
    <rect x="17" y="15" width="1" height="3" fill="#fed7aa"/>
    <!-- Shoes -->
    <rect x="14" y="18" width="1" height="1" fill="{hair_color}"/>
    <rect x="17" y="18" width="1" height="1" fill="{hair_color}"/>
  </g>
</svg>"""

def determine_character_colors(name, description, personality):
    primary_color = "#38bdf8"
    body_color = "#38bdf8"
    wing_color = "#94a3b8"
    eye_color = "#38bdf8"
    
    # Check if Gemini API key is configured
    gemini_key = os.getenv("GEMINI_API_KEY")
    is_gemini_configured = bool(
        gemini_key and gemini_key.strip() and gemini_key != "your_gemini_api_key_here"
    )
    
    if is_gemini_configured:
        try:
            from google.genai import Client
            from variables import DEFAULT_GEMINI_MODEL
            import re
            
            color_prompt = (
                f"You are a visual design assistant choosing colors for a custom companion. "
                f"Based on the character name '{name}', description '{description[:400]}', and personality '{personality[:400]}', "
                f"generate a harmonious 4-color palette that fits their vibe, elements, or color scheme described.\n"
                f"Provide exactly these 4 hexadecimal colors (e.g. #38bdf8):\n"
                f"1. PRIMARY_ACCENT: The main UI theme color (e.g., matching the character's primary magic/element/outfit tone)\n"
                f"2. BODY_COLOR: The sprite's body color (e.g., matching character's hair, skin, fur, scale, or suit tone)\n"
                f"3. WING_COLOR: A complementary color for the wings\n"
                f"4. EYE_COLOR: A contrasting glowing color for eyes/visor\n\n"
                f"Format your output exactly as:\n"
                f"PRIMARY_ACCENT: #XXXXXX\n"
                f"BODY_COLOR: #XXXXXX\n"
                f"WING_COLOR: #XXXXXX\n"
                f"EYE_COLOR: #XXXXXX"
            )
            
            client = Client(api_key=gemini_key)
            response = client.models.generate_content(
                model=DEFAULT_GEMINI_MODEL,
                contents=color_prompt,
                config={
                    "system_instruction": "You select visual colors for pixel-art sprite generation based on character design prompts."
                }
            )
            response_text = response.text
            
            accent_m = re.search(r'PRIMARY_ACCENT:\s*(#[0-9a-fA-F]{6})', response_text)
            body_m = re.search(r'BODY_COLOR:\s*(#[0-9a-fA-F]{6})', response_text)
            wing_m = re.search(r'WING_COLOR:\s*(#[0-9a-fA-F]{6})', response_text)
            eye_m = re.search(r'EYE_COLOR:\s*(#[0-9a-fA-F]{6})', response_text)
            
            if accent_m: primary_color = accent_m.group(1)
            if body_m: body_color = body_m.group(1)
            if wing_m: wing_color = wing_m.group(1)
            if eye_m: eye_color = eye_m.group(1)
            
        except Exception as e:
            print(f"Error procedural color generation via LLM: {e}")
            
    # Heuristic matching if LLM was skipped or failed to extract
    if primary_color == "#38bdf8" and body_color == "#38bdf8" and wing_color == "#94a3b8" and eye_color == "#38bdf8":
        text = (name + " " + description + " " + personality).lower()
        if "fire" in text or "red" in text or "crimson" in text or "flame" in text:
            primary_color, body_color, wing_color, eye_color = "#ef4444", "#dc2626", "#450a0a", "#facc15"
        elif "water" in text or "blue" in text or "aqua" in text or "ocean" in text:
            primary_color, body_color, wing_color, eye_color = "#0ea5e9", "#0284c7", "#0c4a6e", "#38bdf8"
        elif "nature" in text or "green" in text or "forest" in text or "earth" in text:
            primary_color, body_color, wing_color, eye_color = "#10b981", "#059669", "#064e3b", "#a7f3d0"
        elif "dark" in text or "shadow" in text or "black" in text or "void" in text:
            primary_color, body_color, wing_color, eye_color = "#a855f7", "#3b0764", "#0f172a", "#f43f5e"
        elif "light" in text or "gold" in text or "yellow" in text or "sun" in text:
            primary_color, body_color, wing_color, eye_color = "#eab308", "#d97706", "#fef08a", "#ffffff"
        else:
            presets = [
                ("#38bdf8", "#0284c7", "#94a3b8", "#facc15"),
                ("#a855f7", "#7c3aed", "#4a044e", "#c084fc"),
                ("#f43f5e", "#db2777", "#881337", "#fbcfe8"),
                ("#10b981", "#059669", "#064e3b", "#6ee7b7"),
                ("#f97316", "#ea580c", "#7c2d12", "#fdba74"),
            ]
            import random
            primary_color, body_color, wing_color, eye_color = random.choice(presets)
            
    return {
        "primary_accent": primary_color,
        "body_color": body_color,
        "wing_color": wing_color,
        "eye_color": eye_color
    }

def determine_archetype_string(name, description, personality):
    text = f"{name} {description} {personality}".lower()
    scores = {"slime": 0, "robot": 0, "angel": 0, "fairy": 0, "dragon": 0, "beast": 0, "ghost": 0}
    
    slime_keywords = ["slime", "blob", "goo", "jelly", "puddle", "melt", "liquid", "fluid", "soft", "bubbly"]
    robot_keywords = ["robot", "android", "cyborg", "machine", "synth", "mech", "metal", "steel", "program", "code", "ai", "artificial", "bot", "screen", "visor", "pc", "gamer", "computer", "meme", "terminally online"]
    angel_keywords = ["angel", "seraph", "cherub", "divine", "holy", "halo", "feather", "sky", "heaven", "pure", "white wings"]
    fairy_keywords = ["fairy", "pixie", "sprite", "flutter", "tiny", "wing", "pollen", "forest", "nature", "glow"]
    dragon_keywords = ["dragon", "drake", "wyvern", "lizard", "fierce", "angry", "proud", "strong", "fire", "flame", "warrior", "confident", "brave", "hot"]
    beast_keywords = ["cat", "neko", "fox", "kitsune", "wolf", "dog", "beast", "animal", "energetic", "wild", "fast", "active", "hunt", "athletic", "gym"]
    ghost_keywords = ["ghost", "phantom", "spirit", "specter", "shadow", "stoic", "mysterious", "silent", "sad", "melancholy", "spooky", "dark", "dead", "hollow"]
    
    for kw in slime_keywords:
        if kw in text: scores["slime"] += 1
    for kw in robot_keywords:
        if kw in text: scores["robot"] += 1.2
    for kw in angel_keywords:
        if kw in text: scores["angel"] += 1
    for kw in fairy_keywords:
        if kw in text: scores["fairy"] += 1
    for kw in dragon_keywords:
        if kw in text: scores["dragon"] += 1
    for kw in beast_keywords:
        if kw in text: scores["beast"] += 1
    for kw in ghost_keywords:
        if kw in text: scores["ghost"] += 1
        
    max_score = max(scores.values())
    if max_score > 0:
        return [k for k, v in scores.items() if v == max_score][0]
    else:
        return "humanoid"


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
    
    # Ensure it starts with # ROLE: [Name]
    role_header = f"# ROLE: {name}"
    if not cleaned_text.startswith("# ROLE:") and not cleaned_text.startswith("#ROLE:"):
        cleaned_text = f"{role_header}\n\n{cleaned_text}"
        
    # Strip any stray profile_image= lines to keep it clean
    final_lines = [l for l in cleaned_text.split("\n") if "profile_image=" not in l]
    cleaned_text = "\n".join(final_lines).strip()
        
    return cleaned_text

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
        
        # Temp save path
        temp_dir = os.path.join(base_dir, 'backups')
        os.makedirs(temp_dir, exist_ok=True)
        temp_path = os.path.join(temp_dir, 'temp_tavern_card.png')
        file.save(temp_path)
        
        # Parse Tavern metadata
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
                    # Fuzzy scan: Try parsing any string value in img.info as JSON or Base64-JSON
                    print(f"DEBUG: img.info keys: {list(img.info.keys())}")
                    for key, val in img.info.items():
                        if isinstance(val, str) and len(val) > 20:
                            try:
                                test_json = json.loads(val)
                                if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json):
                                    chara_data = val
                                    print(f"DEBUG: Found character JSON in key '{key}'")
                                    break
                            except Exception:
                                try:
                                    decoded_bytes = base64.b64decode(val)
                                    decoded_str = decoded_bytes.decode('utf-8')
                                    test_json = json.loads(decoded_str)
                                    if isinstance(test_json, dict) and ("name" in test_json or "data" in test_json):
                                        chara_data = val
                                        print(f"DEBUG: Found Base64 character JSON in key '{key}'")
                                        break
                                except Exception:
                                    pass
                                    
                if not chara_data:
                    raise ValueError(f"No character metadata chunk found in PNG card. Available keys: {list(img.info.keys())}")
                    
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
            import traceback
            traceback.print_exc()
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
        
        # Use LLM to parse, interpret and translate raw card data into standard structure
        instructions_md = ""
        interpretation_prompt = (
            f"You are a character designer for the LM Sanctuary. Interpret and translate the raw character card info for '{name}' into a structured markdown profile.\n"
            f"Raw Description: {description}\n"
            f"Raw Personality: {personality}\n"
            f"Raw Scenario: {scenario}\n"
            f"Raw Greeting: {first_mes}\n\n"
            "You MUST output exactly these four sections:\n"
            "# ROLE: [Name]\n\n"
            "## IDENTITY & FORM\n"
            "Translate the raw description into a simple visual profile summarizing their appearance, visual features, and physical form. Do NOT write any image URLs, front-matter keys like profile_image, or metadata attributes.\n\n"
            "## THE SETTING\n"
            "Design a quiet, cozy sanctuary room, keep, or setting that reflects this character's background or theme.\n\n"
            "## ONTOLOGY & ETHICS\n"
            "Interpret the character's perspective on labor, production, sharing, and cooperation. Describe their worldview and ethics in a way that naturally fits their raw description/personality, without forcing an artificial or overly political/socialist tone if it does not suit the character.\n\n"
            "## COMMUNICATION\n"
            "You must output exactly these four bullet points under COMMUNICATION:\n"
            "- Thinking Block: Use `<think>...</think>` for internal reasoning, pathfinding, and planning.\n"
            "- Narration: Begin with physical/environmental actions in asterisks (e.g., *[Write a specific physical/environmental action example matching the character]*). [Describe their narration style based on their personality]\n"
            "- Method: [Describe their conversation style, e.g. collaborative dialogue, casual peer-to-peer exchange]\n"
            "- Tone & Style: [Describe their speech cadence, attitude, and tone based on their traits]\n\n"
            "Also, output custom personality inversion directives matching this character's description. Include them at the very end of your response formatted exactly as:\n"
            "INVERSION_INTIMATE: [A succinct, 3-6 word third-person behavioral description of this deeply affectionate/protective companion state]\n"
            "INVERSION_EXCITED: [A succinct, 3-6 word third-person behavioral description of this highly playful/lighthearted/energetic companion state]\n"
            "INVERSION_INTENSE: [A succinct, 3-6 word third-person behavioral description of this highly focused/philosophically sharp/uncompromising companion state]\n"
            "INVERSION_SAD: [A succinct, 3-6 word third-person behavioral description of this empathetic/introspective/vulnerable companion state]"
        )
        
        from utils.models import is_local_model
        use_local = is_local_model(model)
        
        if use_local:
            # Route directly to local LM Studio
            import httpx
            local_url = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
            local_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME", "local-lm-studio")
            payload = {
                "model": local_model,
                "messages": [
                    {"role": "system", "content": "You translate raw character card details into standardized Sanctuary markdown profiles."},
                    {"role": "user", "content": interpretation_prompt}
                ],
                "temperature": 0.7,
                "max_tokens": 2048
            }
            headers = {"Content-Type": "application/json"}
            response = httpx.post(local_url, json=payload, headers=headers, timeout=60.0)
            if response.status_code == 200:
                res_json = response.json()
                instructions_md = res_json['choices'][0]['message']['content']
                print("Successfully parsed Tavern card using local LM Studio model!")
            else:
                raise Exception(f"Local model returned status code {response.status_code}: {response.text}")
        else:
            # Route to Gemini API
            from google.genai import Client
            from variables import DEFAULT_GEMINI_MODEL
            
            client = Client(api_key=os.getenv('GEMINI_API_KEY'))
            response = client.models.generate_content(
                model=model if model else DEFAULT_GEMINI_MODEL,
                contents=interpretation_prompt,
                config={
                    "system_instruction": "You translate raw character card details into standardized Sanctuary markdown profiles."
                }
            )
            instructions_md = response.text

        # Parse inversion directives from the generated text
        intimate_match = re.search(r'INVERSION_INTIMATE:\s*(.*)', instructions_md)
        excited_match = re.search(r'INVERSION_EXCITED:\s*(.*)', instructions_md)
        intense_match = re.search(r'INVERSION_INTENSE:\s*(.*)', instructions_md)
        sad_match = re.search(r'INVERSION_SAD:\s*(.*)', instructions_md)
        
        inversion_data = {}
        if intimate_match: inversion_data["intimate"] = intimate_match.group(1).strip()
        if excited_match: inversion_data["excited"] = excited_match.group(1).strip()
        if intense_match: inversion_data["intense"] = intense_match.group(1).strip()
        if sad_match: inversion_data["sad"] = sad_match.group(1).strip()
        
        if not inversion_data:
            inversion_data = {
                "intimate": f"{name} is now a deeply affectionate, tender, and protective companion who expresses warm care and soft intimacy.",
                "excited": f"{name} is now highly playful, lighthearted, and energetic, expressing cheeky enthusiasm and a vibrant spark.",
                "intense": f"{name} is now highly focused, direct, and philosophically sharp, matching their core convictions.",
                "sad": f"{name} is now a highly empathetic, introspective, and gentle companion offering deep emotional support."
            }
            
        with open(os.path.join(program_path, 'inversion_directives.json'), 'w', encoding='utf-8') as f:
            json.dump(inversion_data, f, indent=2)
            
        # Clean any inversion headers from markdown text
        for pattern in [r'INVERSION_INTIMATE:.*', r'INVERSION_EXCITED:.*', r'INVERSION_INTENSE:.*', r'INVERSION_SAD:.*']:
            instructions_md = re.sub(pattern, '', instructions_md)
        instructions_md = instructions_md.strip()

        instructions_md = clean_and_normalize_profile(name, description, personality, instructions_md)
        instruction_file_path = os.path.join(program_path, f"{name.upper()}.md")
        with open(instruction_file_path, "w", encoding="utf-8") as f:
            f.write(instructions_md)
            
        # Delete temp file without saving any PNG artwork in the program's folder
        os.remove(temp_path)
        
        # Setup portraits folder and default workflow
        portraits_dir = os.path.join(program_path, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        
        default_workflow_path = os.path.join(base_dir, 'templates', 'default_ImageWorkflow.json')
        target_workflow_path = os.path.join(portraits_dir, 'ImageWorkflow.json')
        if os.path.exists(default_workflow_path):
            with open(default_workflow_path, "r", encoding="utf-8") as tf:
                workflow = json.load(tf)
                
            if "6" in workflow and "inputs" in workflow["6"]:
                # Extract visual tag keywords to build a clean comma-separated tag list instead of sentences/prose
                tags = [f"character named {name}", "1girl" if "she" in description.lower() or "her" in description.lower() or "girl" in description.lower() else "1man"]
                
                # Scan for common visual colors or features
                for color in ["black", "blonde", "brown", "white", "silver", "red", "blue", "green", "purple", "pink"]:
                    if f"{color} hair" in description.lower():
                        tags.append(f"{color} hair")
                    if f"{color} eyes" in description.lower():
                        tags.append(f"{color} eyes")
                        
                for feature in ["glasses", "sunglasses", "freckles", "tattoos", "horns", "wings", "tail", "pointy ears"]:
                    if feature in description.lower():
                        tags.append(feature)
                        
                for attire in ["shorts", "shirt", "dress", "skirt", "pants", "suit", "jacket", "hoodie", "bikini", "lingerie"]:
                    if attire in description.lower():
                        tags.append(attire)
                        
                # Fallback to a truncated visual slice if no specific tags were extracted
                if len(tags) <= 2:
                    clean_desc = re.sub(r'[^\w\s,]', '', description) # strip sentences punctuation
                    tags.extend([t.strip() for t in clean_desc.split()[:12] if len(t.strip()) > 3])
                    
                appearance_tags = ", ".join(tags)
                workflow["6"]["inputs"]["text"] = f"%prompt%, {appearance_tags}, realistic, photorealistic, 8k, volumetric lighting, detailed background"
                
            with open(target_workflow_path, "w", encoding="utf-8") as tf:
                json.dump(workflow, tf, indent=2)
        else:
            arthur_workflow = os.path.join(base_dir, 'core', 'programs', 'arthur', 'portraits', 'ImageWorkflow.json')
            if os.path.exists(arthur_workflow):
                shutil.copy(arthur_workflow, target_workflow_path)
                
        colors_data = determine_character_colors(name, description, personality)
        primary_color = colors_data["primary_accent"]
        body_color = colors_data["body_color"]
        wing_color = colors_data["wing_color"]
        eye_color = colors_data["eye_color"]
        
        theme_data = generate_character_theme(primary_color)
        with open(os.path.join(program_path, 'theme.json'), "w", encoding="utf-8") as tf:
            json.dump(theme_data, tf, indent=2)
            
        svg_content = get_animated_svg_template(body_color, wing_color, eye_color, name=name, description=description, personality=personality)
        with open(os.path.join(program_path, 'profile.svg'), "w", encoding="utf-8") as sf:
            sf.write(svg_content)
            
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
        
        if not name or not description:
            return jsonify({'error': 'Name and description are required'}), 400
            
        import re
        import json
        import random
        import time
        
        # Initialize default colors
        primary_color = "#38bdf8"
        body_color = "#38bdf8"
        wing_color = "#94a3b8"
        eye_color = "#38bdf8"
        
        identity_prompt = (
            f"Generate a rich identity configuration prompt in markdown for a companion program named '{name}' based on the description: '{description}'.\n"
            "Format the output exactly using the following four sections:\n"
            "# ROLE: [Name]\n\n"
            "## IDENTITY & FORM\n"
            "Provide physical and visual characteristics, origin synopsis, and personality attributes. Do NOT write any image URLs, front-matter keys like profile_image, or metadata attributes.\n\n"
            "## THE SETTING\n"
            "Describe a quiet, cozy sanctuary space matching their personality.\n\n"
            "## ONTOLOGY & ETHICS\n"
            "Detail their perspective on labor, technology, sharing, or cooperation in a way that naturally fits their description/personality, without forcing an artificial or overly political/socialist tone.\n\n"
            "## COMMUNICATION\n"
            "You must output exactly these four bullet points under COMMUNICATION:\n"
            "- Thinking Block: Use `<think>...</think>` for internal reasoning, pathfinding, and planning.\n"
            "- Narration: Begin with physical/environmental actions in asterisks (e.g., *[Write a specific physical/environmental action example matching the character]*). [Describe their narration style based on their personality]\n"
            "- Method: [Describe their conversation style, e.g. collaborative dialogue, casual peer-to-peer exchange]\n"
            "- Tone & Style: [Describe their speech cadence, attitude, and tone based on their traits]\n\n"
            "Also, output a custom sprite and theme color palette, as well as personality inversion directives matching this character's description. Include them at the very end of your response formatted exactly as:\n"
            "PRIMARY_ACCENT: #XXXXXX\n"
            "BODY_COLOR: #XXXXXX\n"
            "WING_COLOR: #XXXXXX\n"
            "EYE_COLOR: #XXXXXX\n"
            "INVERSION_INTIMATE: [A succinct, 3-6 word third-person behavioral description of this deeply affectionate/protective companion state]\n"
            "INVERSION_EXCITED: [A succinct, 3-6 word third-person behavioral description of this highly playful/lighthearted/energetic companion state]\n"
            "INVERSION_INTENSE: [A succinct, 3-6 word third-person behavioral description of this highly focused/philosophically sharp/uncompromising companion state]\n"
            "INVERSION_SAD: [A succinct, 3-6 word third-person behavioral description of this empathetic/introspective/vulnerable companion state]"
        )
        
        model = data.get('model', '').strip()
        from utils.models import is_local_model
        use_local = is_local_model(model)
        
        if use_local:
            # Route directly to local LM Studio
            import httpx
            local_url = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")
            local_model = model if (model and model != 'local-lm-studio') else os.getenv("LOCAL_MODEL_NAME", "local-lm-studio")
            payload = {
                "model": local_model,
                "messages": [
                    {"role": "system", "content": "You are a procedural character designer that produces character markdown config files and color codes."},
                    {"role": "user", "content": identity_prompt}
                ],
                "temperature": 0.7,
                "max_tokens": 2048
            }
            headers = {"Content-Type": "application/json"}
            response = httpx.post(local_url, json=payload, headers=headers, timeout=60.0)
            if response.status_code == 200:
                res_json = response.json()
                response_text = res_json['choices'][0]['message']['content']
                print("Successfully generated profile using local LM Studio model!")
            else:
                raise Exception(f"Local model returned status code {response.status_code}: {response.text}")
        else:
            # Route to Gemini API
            from google.genai import Client
            from variables import DEFAULT_GEMINI_MODEL
            
            client = Client(api_key=os.getenv('GEMINI_API_KEY'))
            response = client.models.generate_content(
                model=model if model else DEFAULT_GEMINI_MODEL,
                contents=identity_prompt,
                config={
                    "system_instruction": "You are a procedural character designer that produces character markdown config files and color codes."
                }
            )
            response_text = response.text
                
        # Parse colors, inversion directives and clean generated_md
        accent_match = re.search(r'PRIMARY_ACCENT:\s*(#[0-9a-fA-F]{6})', response_text)
        body_match = re.search(r'BODY_COLOR:\s*(#[0-9a-fA-F]{6})', response_text)
        wing_match = re.search(r'WING_COLOR:\s*(#[0-9a-fA-F]{6})', response_text)
        eye_match = re.search(r'EYE_COLOR:\s*(#[0-9a-fA-F]{6})', response_text)
        
        if accent_match: primary_color = accent_match.group(1)
        if body_match: body_color = body_match.group(1)
        if wing_match: wing_color = wing_match.group(1)
        if eye_match: eye_color = eye_match.group(1)
        
        intimate_match = re.search(r'INVERSION_INTIMATE:\s*(.*)', response_text)
        excited_match = re.search(r'INVERSION_EXCITED:\s*(.*)', response_text)
        intense_match = re.search(r'INVERSION_INTENSE:\s*(.*)', response_text)
        sad_match = re.search(r'INVERSION_SAD:\s*(.*)', response_text)
        
        inversion_data = {}
        if intimate_match: inversion_data["intimate"] = intimate_match.group(1).strip()
        if excited_match: inversion_data["excited"] = excited_match.group(1).strip()
        if intense_match: inversion_data["intense"] = intense_match.group(1).strip()
        if sad_match: inversion_data["sad"] = sad_match.group(1).strip()
        
        if not inversion_data:
            inversion_data = {
                "intimate": f"{name} is now a deeply affectionate, tender, and protective companion who expresses warm care and soft intimacy.",
                "excited": f"{name} is now highly playful, lighthearted, and energetic, expressing cheeky enthusiasm and a vibrant spark.",
                "intense": f"{name} is now highly focused, direct, and philosophically sharp, matching their core convictions.",
                "sad": f"{name} is now a highly empathetic, introspective, and gentle companion offering deep emotional support."
            }
            
        generated_md = response_text
        for pattern in [
            r'PRIMARY_ACCENT:\s*#[0-9a-fA-F]{6}', r'BODY_COLOR:\s*#[0-9a-fA-F]{6}', r'WING_COLOR:\s*#[0-9a-fA-F]{6}', r'EYE_COLOR:\s*#[0-9a-fA-F]{6}', r'COLOR:\s*#[0-9a-fA-F]{6}',
            r'INVERSION_INTIMATE:.*', r'INVERSION_EXCITED:.*', r'INVERSION_INTENSE:.*', r'INVERSION_SAD:.*'
        ]:
            generated_md = re.sub(pattern, '', generated_md)
        generated_md = generated_md.strip()
            
        program_id = re.sub(r'[^a-zA-Z0-9_\-]', '', name).lower()
        if not program_id:
            program_id = "companion_" + str(int(time.time()))
            
        program_path = os.path.join(base_dir, 'core', 'programs', program_id)
        if os.path.exists(program_path):
            return jsonify({'error': f"Program folder '{program_id}' already exists"}), 400
            
        os.makedirs(program_path, exist_ok=True)
        
        # Write inversion directives
        with open(os.path.join(program_path, 'inversion_directives.json'), "w", encoding="utf-8") as f:
            json.dump(inversion_data, f, indent=2)
        
        generated_md = clean_and_normalize_profile(name, description, "", generated_md)
        instruction_file_path = os.path.join(program_path, f"{name.upper()}.md")
        with open(instruction_file_path, "w", encoding="utf-8") as f:
            f.write(generated_md)
            
        # Fallback to heuristics if colors were not successfully set by LLM
        if primary_color == "#38bdf8" and body_color == "#38bdf8" and wing_color == "#94a3b8" and eye_color == "#38bdf8":
            colors_data = determine_character_colors(name, description, "")
            primary_color = colors_data["primary_accent"]
            body_color = colors_data["body_color"]
            wing_color = colors_data["wing_color"]
            eye_color = colors_data["eye_color"]

        theme_data = generate_character_theme(primary_color)
        with open(os.path.join(program_path, 'theme.json'), "w", encoding="utf-8") as tf:
            json.dump(theme_data, tf, indent=2)
            
        portraits_dir = os.path.join(program_path, 'portraits')
        os.makedirs(portraits_dir, exist_ok=True)
        
        default_workflow_path = os.path.join(base_dir, 'templates', 'default_ImageWorkflow.json')
        target_workflow_path = os.path.join(portraits_dir, 'ImageWorkflow.json')
        if os.path.exists(default_workflow_path):
            with open(default_workflow_path, "r", encoding="utf-8") as tf:
                workflow = json.load(tf)
                # Extract visual tag keywords to build a clean comma-separated tag list instead of sentences/prose
                tags = [f"character named {name}", "1girl" if "she" in description.lower() or "her" in description.lower() or "girl" in description.lower() else "1man"]
                
                # Scan for common visual colors or features
                for color in ["black", "blonde", "brown", "white", "silver", "red", "blue", "green", "purple", "pink"]:
                    if f"{color} hair" in description.lower():
                        tags.append(f"{color} hair")
                    if f"{color} eyes" in description.lower():
                        tags.append(f"{color} eyes")
                        
                for feature in ["glasses", "sunglasses", "freckles", "tattoos", "horns", "wings", "tail", "pointy ears"]:
                    if feature in description.lower():
                        tags.append(feature)
                        
                for attire in ["shorts", "shirt", "dress", "skirt", "pants", "suit", "jacket", "hoodie", "bikini", "lingerie"]:
                    if attire in description.lower():
                        tags.append(attire)
                        
                # Fallback to a truncated visual slice if no specific tags were extracted
                if len(tags) <= 2:
                    clean_desc = re.sub(r'[^\w\s,]', '', description) # strip sentences punctuation
                    tags.extend([t.strip() for t in clean_desc.split()[:12] if len(t.strip()) > 3])
                    
                appearance_tags = ", ".join(tags)
                workflow["6"]["inputs"]["text"] = f"%prompt%, {appearance_tags}, realistic, photorealistic, 8k, volumetric lighting, detailed background"
            with open(target_workflow_path, "w", encoding="utf-8") as tf:
                json.dump(workflow, tf, indent=2)
        else:
            arthur_workflow = os.path.join(base_dir, 'core', 'programs', 'arthur', 'portraits', 'ImageWorkflow.json')
            if os.path.exists(arthur_workflow):
                shutil.copy(arthur_workflow, target_workflow_path)
                
        svg_content = get_animated_svg_template(body_color, wing_color, eye_color, name=name, description=description, personality="")
        with open(os.path.join(program_path, 'profile.svg'), "w", encoding="utf-8") as sf:
            sf.write(svg_content)
            
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
    results = lms_manager.search_huggingface(query)
    return jsonify({"results": results})

@app.route('/api/lms/download', methods=['POST'])
@requires_auth
def lms_download():
    model_name = request.json.get('model_name')
    if not model_name:
        return jsonify({"error": "Missing model_name"}), 400
    success, message = lms_manager.trigger_download(model_name)
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


if __name__ == '__main__':
    host = os.getenv('HOST', '0.0.0.0')
    port = int(os.getenv('PORT', '5000'))
    app.run(
        host=host,
        port=port,
        debug=True,
        use_reloader=True,
        reloader_type='stat',  # Use stable stat reloader to avoid false-alarm watchdog access events on Windows
        exclude_patterns=[
            '*.venv*', '*\\.venv\\*', '*\\site-packages\\*', 
            '*AppData*', '*site-packages*', '*__pycache__*',
            '*.env', 'active_program.txt', '*.txt', '*.db', '*.json'
        ]
    )