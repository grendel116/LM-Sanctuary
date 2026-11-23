import asyncio
import colorsys
import json
import os
import re
import shutil
import threading
import time
import traceback
import uuid
from contextlib import nullcontext
from pathlib import Path

from flask import Blueprint, Response, jsonify, make_response, request, send_file, send_from_directory

import state as st
import variables.settings as vs
from runners.runner import cancelled_sessions, voice_call_sessions
from runners.program import (
    get_active_program,
    get_active_session,
    get_active_user,
    set_active_program,
    set_active_session,
)
_cached_portrait_tags: dict[tuple[str, str], str] = {}

media_bp = Blueprint("media_bp", __name__)

_DEFAULT_PROGRAM_AVATAR_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" fill="none">'
    '<rect width="40" height="40" rx="20" fill="#1c1c22"/>'
    '<g transform="translate(8 8)" stroke="#98a0b0" stroke-width="2" '
    'stroke-linecap="round" stroke-linejoin="round">'
    '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>'
    '<circle cx="12" cy="7" r="4"></circle>'
    '</g></svg>'
)


def _default_avatar_response() -> Response:
    return Response(
        _DEFAULT_PROGRAM_AVATAR_SVG,
        status=200,
        mimetype="image/svg+xml",
        headers={"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"},
    )


@media_bp.route('/profile.png')
def profile_png():
    import io
    from runners.program import get_active_program
    active_program = get_active_program()
    path_png = os.path.join(st.get_program_dir(active_program), 'portraits', 'profile.png')
    if os.path.exists(path_png):
        with open(path_png, 'rb') as f:
            buf = io.BytesIO(f.read())
        response = send_file(buf, mimetype='image/png', download_name='profile.png')
        from flask import make_response
        res = make_response(response)
        res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return res
    return _default_avatar_response()


@media_bp.route('/programs/<program_id>/profile.png')
def program_profile_png(program_id):
    import io
    if not st.PROGRAM_ID_RE.match(program_id):
        return "Invalid program ID", 400
    path_png = os.path.join(st.get_program_dir(program_id), 'portraits', 'profile.png')
    if os.path.exists(path_png):
        with open(path_png, 'rb') as f:
            buf = io.BytesIO(f.read())
        response = send_file(buf, mimetype='image/png', download_name='profile.png')
        res = make_response(response)
        res.headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0'
        return res
    return _default_avatar_response()


@media_bp.route('/api/programs/profile_picture/crop', methods=['POST'])
@st.requires_auth
def crop_profile_picture():
    """Server-side crop: receives source image path and crop coordinates, uses PIL to crop and resize."""
    try:
        pass
        from runners.program import get_active_program
        from PIL import Image
        from urllib.parse import unquote
        
        data = request.get_json(silent=True) or {}
        source_image = data.get('source_image', '')
        x = int(data.get('x', 0))
        y = int(data.get('y', 0))
        w = int(data.get('width', 0))
        h = int(data.get('height', 0))
        
        if not source_image or w <= 0 or h <= 0:
            return jsonify({'error': 'Invalid crop parameters'}), 400
        
        # Strip query parameters and decode URL encoding
        if '?' in source_image:
            source_image = source_image.split('?')[0]
        source_image = unquote(source_image)

        requested_program_id = data.get('program_id')
        program_id = requested_program_id or get_active_program()
        program_dir = os.path.join(vs.PROGRAMS_DIR, program_id)
        
        # Resolve source image path from the URL path to a local file path
        source_path = None
        detected_owner = None
        if source_image.startswith('/images/'):
            relative_path = source_image[len('/images/'):]
            cand_path = os.path.normpath(os.path.join(program_dir, relative_path))
            if os.path.commonpath([os.path.abspath(cand_path), os.path.abspath(program_dir)]) != os.path.abspath(program_dir):
                return jsonify({'error': 'Unsupported image path'}), 400
            if os.path.exists(cand_path):
                source_path = cand_path
                detected_owner = program_id
            elif os.path.isdir(vs.PROGRAMS_DIR):
                for alt_prog in os.listdir(vs.PROGRAMS_DIR):
                    alt_dir = os.path.join(vs.PROGRAMS_DIR, alt_prog)
                    if not os.path.isdir(alt_dir):
                        continue
                    alt_cand = os.path.normpath(os.path.join(alt_dir, relative_path))
                    if os.path.commonpath([os.path.abspath(alt_cand), os.path.abspath(alt_dir)]) == os.path.abspath(alt_dir):
                        if os.path.isfile(alt_cand):
                            source_path = alt_cand
                            detected_owner = alt_prog
                            break
            if source_path:
                sidecar_path = os.path.splitext(source_path)[0] + '.json'
                if os.path.exists(sidecar_path):
                    try:
                        with open(sidecar_path, 'r', encoding='utf-8') as sf:
                            s_data = json.load(sf)
                        if s_data.get('program_id'):
                            detected_owner = s_data['program_id']
                    except Exception:
                        pass
        elif source_image.startswith('/programs/') and source_image.endswith('/profile.png'):
            parts = source_image.strip('/').split('/')
            if len(parts) == 3 and st.PROGRAM_ID_RE.match(parts[1]):
                detected_owner = parts[1]
                source_path = os.path.normpath(os.path.join(vs.PROGRAMS_DIR, detected_owner, 'portraits', 'profile.png'))
        elif source_image.startswith('/profile.png'):
            source_path = os.path.normpath(os.path.join(program_dir, 'portraits', 'profile.png'))
        else:
            return jsonify({'error': 'Unsupported image path'}), 400
        
        if not source_path or not os.path.exists(source_path):
            return jsonify({'error': f'Source image not found: {source_image}'}), 404

        if not requested_program_id and detected_owner:
            program_id = detected_owner
            program_dir = os.path.join(vs.PROGRAMS_DIR, program_id)
        
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
        st.broadcast_media_change(program_id, profile=True)
        
        print(f"[PROFILE CROP] program={program_id}, source={source_path}, crop=({x},{y},{w},{h}), dest={dest_path}")
        return jsonify({
            'status': 'success',
            'program_id': program_id,
            'message': 'Profile picture cropped and saved successfully.'
        })
    except Exception as e:
        print(f"Error cropping profile picture: {e}")
        return jsonify({'error': str(e)}), 500


@media_bp.route('/images/<path:filename>')
@st.requires_auth
def serve_image(filename):
    import mimetypes
    from runners.program import get_active_program
    requested_program = (request.args.get('program_id') or '').strip()
    if requested_program and not st.PROGRAM_ID_RE.match(requested_program):
        requested_program = ''
    active_program = get_active_program() or os.getenv("ACTIVE_PROGRAM", "sebile")
    programs_root = os.path.join(st.base_dir, 'core', 'programs')

    def _resolve_in_program(prog_name):
        if not prog_name:
            return None
        prog_dir = os.path.join(programs_root, prog_name)
        if not os.path.isdir(prog_dir):
            return None
        cand = os.path.normpath(os.path.join(prog_dir, filename))
        if os.path.commonpath([os.path.abspath(cand), os.path.abspath(prog_dir)]) == os.path.abspath(prog_dir) and os.path.isfile(cand):
            return cand
        return None

    target_path = _resolve_in_program(requested_program) or _resolve_in_program(active_program)
    if not target_path and os.path.isdir(programs_root):
        for prog in os.listdir(programs_root):
            found = _resolve_in_program(prog)
            if found:
                target_path = found
                break

    if not target_path:
        return "Image not found", 404

    import io
    mime_type, _ = mimetypes.guess_type(target_path)
    mtime = os.path.getmtime(target_path)
    file_size = os.path.getsize(target_path)
    if file_size <= 64 * 1024 * 1024:
        with open(target_path, 'rb') as f:
            payload = io.BytesIO(f.read())
        response = send_file(
            payload,
            mimetype=mime_type or 'application/octet-stream',
            download_name=os.path.basename(target_path),
            conditional=True,
            last_modified=mtime,
        )
    else:
        response = send_file(
            target_path,
            mimetype=mime_type or 'application/octet-stream',
            download_name=os.path.basename(target_path),
            conditional=True,
        )
    response.headers['Cache-Control'] = 'private, no-cache'
    return response


@media_bp.route('/api/get_image_prompt', methods=['GET'])
@st.requires_auth
def get_image_prompt():
    image_url = request.args.get('image_url')
    requested_program = (request.args.get('program_id') or '').strip()
    if requested_program and not st.PROGRAM_ID_RE.match(requested_program):
        requested_program = ''
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400
        
    if "://" in image_url or "?" in image_url:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(image_url)
        if not requested_program and parsed.query:
            q_prog = (parse_qs(parsed.query).get('program_id') or [''])[0].strip()
            if q_prog and st.PROGRAM_ID_RE.match(q_prog):
                requested_program = q_prog
        image_url = parsed.path
        
    try:
        import json
        from runners.program import get_active_program
        active_program = get_active_program()
        
        if image_url.startswith('/images/'):
            img_subpath = image_url[8:]
        else:
            img_subpath = os.path.basename(image_url)
            
        # Security: keep filename only to prevent directory traversal
        img_subpath = os.path.basename(img_subpath)
        json_path = st.find_image_sidecar_json(img_subpath, active_program, program_id=requested_program or None)

        if json_path and os.path.exists(json_path):
            with open(json_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
                prompt = meta.get('prompt', '')
                return jsonify({'status': 'success', 'prompt': prompt})
        else:
            return jsonify({'status': 'success', 'prompt': ''})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@media_bp.route('/upload_media', methods=['POST'])
@st.requires_auth
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
    uploads_dir = os.path.normpath(os.path.join(st.get_program_dir(active_program), 'uploads'))
    os.makedirs(uploads_dir, exist_ok=True)
    local_path = os.path.join(uploads_dir, unique_name)
    file.save(local_path)

    return jsonify({'file_path': f'/images/uploads/{unique_name}'})


@media_bp.route('/delete_image', methods=['POST'])
@st.requires_auth
def delete_image():
    data = request.get_json(silent=True) or {}
    session_id = data.get('session_id', 'default')
    image_url = data.get('image_url')
    program_id = (data.get('program_id') or '').strip()
    if program_id and not st.PROGRAM_ID_RE.match(program_id):
        program_id = ''
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400

    with st._active_regen_lock:
        regen_in_progress = st._active_image_regenerations.get(session_id, 0) > 0
    keep_message = bool(data.get('keep_message')) or regen_in_progress
        
    try:
        # Detach from session log - delete the image and remove it from history
        success = st.run_async(st.runner.delete_image_from_session(session_id, image_url, keep_message=keep_message, program_id=program_id or None))
        if success:
            st.broadcast_media_change(program_id or None)
            return jsonify({'status': 'success'})
        else:
            return jsonify({'error': 'Image file not found in session or disk'}), 404
    except Exception as e:
        print(f"Error deleting image file {image_url} from session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500


@media_bp.route('/regenerate_image', methods=['POST'])
@st.requires_auth
def regenerate_image():
    from utils import image_cancellation
    session_id = request.json.get('session_id', 'default')
    msg_id = request.json.get('msg_id')
    if not msg_id and request.json.get('old_image_url'):
        msg_id = find_image_message_id(session_id, request.json['old_image_url'])
    with image_cancellation.message_operation(session_id, msg_id, request.json.get('speaker_id')):
        return _regenerate_image(msg_id)


def find_image_message_id(session_id, image_url):
    from urllib.parse import urlparse
    image_path = urlparse(image_url).path
    history = st.run_async(st.runner.get_history(session_id))
    return next(
        (msg.get('id') for msg in history
         if any(urlparse(item.get('url', '')).path == image_path for item in msg.get('media', []))),
        None,
    )


def _regenerate_image(resolved_msg_id):
    session_id = request.json.get('session_id', 'default')
    cancelled_sessions.discard(session_id)
    
    old_image_url = request.json.get('old_image_url') or ''
    prompt = request.json.get('prompt')
    msg_id = resolved_msg_id
    slot_index = request.json.get('slot_index')
    if slot_index is not None:
        try:
            slot_index = int(slot_index)
        except Exception:
            slot_index = None
    
    if not old_image_url and not msg_id:
        return jsonify({'error': 'Missing old_image_url or msg_id'}), 400
        
    # Normalize old_image_url to pathname
    if old_image_url and "://" in old_image_url:
        from urllib.parse import urlparse
        old_image_url = urlparse(old_image_url).path

    with st._active_regen_lock:
        st._active_image_regenerations[session_id] = st._active_image_regenerations.get(session_id, 0) + 1

    from utils.image_cancellation import current_event
    deadline = time.monotonic() + 300.0
    acquired = False
    while time.monotonic() < deadline and not current_event().is_set():
        if st._image_mutex.acquire(timeout=min(0.25, max(0, deadline - time.monotonic()))):
            acquired = True
            break
    if not acquired:
        with st._active_regen_lock:
            st._active_image_regenerations[session_id] = max(0, st._active_image_regenerations.get(session_id, 1) - 1)
        if current_event().is_set():
            return jsonify({'error': 'Image regeneration cancelled by user.'}), 400
        return jsonify({'error': 'Image generation engine is currently busy. Please retry in a moment.'}), 429

    st.runner.mark_generating(session_id)
    try:
        if current_event().is_set():
            return jsonify({'error': 'Image regeneration cancelled by user.'}), 400
        target_prog = request.json.get('speaker_id')
        filename = os.path.basename(old_image_url) if old_image_url else ''
        chat_history = []
        try:
            chat_history = st.run_async(st.runner.get_history(session_id))
        except Exception:
            pass

        if not target_prog and msg_id and chat_history:
            for msg in chat_history:
                if msg.get('id') == msg_id and msg.get('sender_id'):
                    target_prog = msg['sender_id']
                    break

        if not old_image_url and msg_id and chat_history:
            existing_msg = next((m for m in chat_history if m.get('id') == msg_id), None)
            if existing_msg and len(existing_msg.get('media') or []) >= 2:
                return jsonify({'error': 'Each image message row can hold at most 2 images.'}), 400

        if filename:
            try:
                from runners.program import get_active_program
                active_program = target_prog or get_active_program()
                json_path = st.find_image_sidecar_json(filename, active_program)
                if json_path and os.path.exists(json_path):
                    with open(json_path, 'r', encoding='utf-8') as f:
                        meta = json.load(f)
                        if not prompt:
                            prompt = meta.get('prompt')
                            if prompt:
                                print(f"[DEBUG REROLL] Found prompt in sidecar JSON: {prompt}")
                        if not target_prog and meta.get('program_id'):
                            target_prog = meta.get('program_id')
            except Exception as je:
                print(f"Error reading sidecar JSON: {je}")

        if not target_prog and chat_history:
            target_prog = resolve_portrait_speaker_id(session_id, chat_history)

        if not prompt:
            # 2. Check session history for prompt (by msg_id, media items, or tool_calls)
            try:
                if msg_id:
                    for msg in chat_history:
                        if msg.get('id') == msg_id:
                            for m in msg.get('media', []):
                                if m.get('prompt'):
                                    prompt = m['prompt']
                                    break
                            if prompt:
                                break
                if not prompt:
                    for msg in chat_history:
                        tool_calls = msg.get('tool_calls', [])
                        if not tool_calls:
                            continue
                        calls = {}
                        for tc in tool_calls:
                            if tc.get('type') == 'call' and tc.get('name') in ('generate_program_portrait', 'generate_local_image'):
                                call_id = tc.get('id')
                                args = tc.get('args', {})
                                p = args.get('prompt') if isinstance(args, dict) else None
                                if call_id and p:
                                    calls[call_id] = p
                        if msg_id and msg.get('id') == msg_id and calls:
                            prompt = next(iter(calls.values()))
                            break
                        for tc in tool_calls:
                            if tc.get('type') == 'response' and tc.get('name') in ('generate_program_portrait', 'generate_local_image'):
                                call_id = tc.get('id')
                                response_val = tc.get('response', '')
                                if call_id in calls and filename and filename in response_val:
                                    prompt = calls[call_id]
                                    print(f"[DEBUG REROLL] Found prompt in history matching filename '{filename}': {prompt}")
                                    break
                        if prompt:
                            break
            except Exception as he:
                print(f"Error scanning session history for prompt: {he}")

            if not prompt:
                prompt = extract_portrait_tags_from_context(session_id, "", program_id=target_prog)

            if not prompt:
                return jsonify({'error': 'Original prompt not found. Unable to regenerate image.'}), 400

        if session_id in cancelled_sessions or current_event().is_set():
            return jsonify({'error': 'Image regeneration cancelled by user.'}), 400

        import tools.tools as tools
        tools.current_session_id.set(session_id)
        tools.current_speaker_id.set(target_prog)
        with tools.session_tool_calls_lock:
            tools.session_tool_calls[session_id] = []
        # Generate 1 replacement portrait for the target slot
        new_markdown = tools.generate_local_image(prompt, count=1, program_id=target_prog)
        if session_id in cancelled_sessions or current_event().is_set():
            return jsonify({'error': 'Image regeneration cancelled by user.'}), 400
        if new_markdown.startswith("Error"):
            return jsonify({'error': new_markdown}), 500
            
        # Parse the new image URL from Markdown link: ![...](/images/...)
        import re
        extracted_urls = re.findall(r'!\[[^\]]*\]\(([^)]+)\)', new_markdown)
        new_image_url = extracted_urls[0] if extracted_urls else None
            
        if not new_image_url:
            return jsonify({'error': f'Failed to parse generated image markdown: {new_markdown}'}), 500
            
        # Replace or insert at slot in session history
        success = st.run_async(
            st.runner.replace_image_in_session(
                session_id,
                old_image_url,
                new_image_url,
                new_prompt=prompt,
                msg_id=msg_id,
                slot_index=slot_index,
                speaker_id=target_prog,
            )
        )
        if success:
            st.broadcast_media_change(target_prog)
            return jsonify({
                'status': 'success',
                'new_image_url': new_image_url,
                'prompt': prompt,
                'tool_calls': st.finish_generation_request(session_id),
            })
        else:
            return jsonify({'error': 'Original image not found in session'}), 404
    except Exception as e:
        print(f"Error regenerating image in session {session_id}: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        st.runner.unmark_generating(session_id)
        with st._active_regen_lock:
            st._active_image_regenerations[session_id] = max(0, st._active_image_regenerations.get(session_id, 1) - 1)
        st.finish_generation_request(session_id)
        st._image_mutex.release()


def resolve_portrait_speaker_id(session_id: str, chat_history: list = None, requested_speaker_id: str = None, custom_prompt: str = None) -> str:
    """Determines which character is the active subject for portrait generation in solo or group sessions."""
    from runners.program import get_active_program
    from runners.runner import detect_addressed_speaker

    group_meta = getattr(st.runner, "sessions_group_meta", {}).get(session_id)
    if group_meta and group_meta.get("is_group") and custom_prompt and custom_prompt.strip():
        host_id = group_meta.get("host_id")
        guest_ids = group_meta.get("guest_ids", [])
        all_ids = [p for p in ([host_id] + [g for g in guest_ids if g != host_id]) if p]
        addressed = detect_addressed_speaker(custom_prompt, all_ids)
        if addressed:
            return addressed

    if requested_speaker_id and st.PROGRAM_ID_RE.match(str(requested_speaker_id)):
        return str(requested_speaker_id)

    if chat_history is None:
        try:
            chat_history = st.run_async(st.runner.get_history(session_id))
        except Exception:
            chat_history = []

    for msg in reversed(chat_history):
        if msg.get("role") == "program":
            text = (msg.get("text") or "").strip()
            msg_id = msg.get("id", "")
            if msg_id.startswith("img_") or (text.startswith("![") and text.endswith(")") and not text):
                continue
            if not text:
                continue
            if msg.get("sender_id"):
                return msg["sender_id"]

    for msg in reversed(chat_history):
        if msg.get("role") == "program" and msg.get("sender_id"):
            return msg["sender_id"]

    return get_active_program() or "sebile"


def extract_portrait_tags_from_context(session_id: str, custom_prompt: str = "", program_id: str = None) -> str:
    """Extracts comma-separated visual tags from the latest conversation and character context.
    When the GPU is already in IMG mode (e.g., generating consecutive portraits without new chat turns),
    reuses the cached scene tags to avoid unloading SDXL and booting llama-server back and forth.
    """
    if custom_prompt and custom_prompt.strip():
        return custom_prompt.strip()

    from adapters.vram_orchestrator import get_current_mode, start_llm
    from core.program_config import _load_card_data, replace_placeholders
    from runners.program import get_active_user

    chat_history = []
    try:
        chat_history = st.run_async(st.runner.get_history(session_id))
    except Exception:
        pass

    target_prog = resolve_portrait_speaker_id(session_id, chat_history, program_id)
    cache_key = (target_prog, session_id)

    card = _load_card_data(target_prog)
    char_name = card.get("name") or target_prog.title()
    description = replace_placeholders(card.get("description", ""), program_id=target_prog).strip()

    group_meta = getattr(st.runner, "sessions_group_meta", {}).get(session_id)
    if group_meta and group_meta.get("is_group") and group_meta.get("host_id"):
        host_card = _load_card_data(group_meta["host_id"])
        raw_scenario = host_card.get("scenario", "") or card.get("scenario", "")
    else:
        raw_scenario = card.get("scenario", "")
    scenario = replace_placeholders(raw_scenario, program_id=target_prog).strip()
    user_name = get_active_user().replace("_", " ").title()

    recent_history = [
        msg for msg in chat_history
        if msg.get("text") and not msg.get("text", "").startswith("![Portrait")
    ][-4:]

    # If the GPU is already holding the SDXL diffusion pipeline in VRAM, avoid a costly
    # IMG -> LLM -> IMG double-swap by reusing cached tags or deriving scene tags directly.
    if get_current_mode() == "IMG":
        if cached := _cached_portrait_tags.get(cache_key):
            print(f"[Portrait] Reusing cached scene tags in IMG mode (zero VRAM swap): {cached}", flush=True)
            return cached
        fallback_parts = ["1girl, solo"]
        if scenario:
            fallback_parts.append(scenario[:160])
        elif recent_history:
            fallback_parts.append(recent_history[-1].get("text", "")[:160])
        synthesized = ", ".join(p.strip() for p in fallback_parts if p.strip())
        _cached_portrait_tags[cache_key] = synthesized
        print(f"[Portrait] Synthesized scene tags in IMG mode (zero VRAM swap): {synthesized}", flush=True)
        return synthesized

    history_text = ""
    for msg in recent_history:
        if msg.get('role') == 'user':
            role = user_name
        else:
            role = msg.get('sender_name') or char_name
        text_val = msg.get('text', '')
        history_text += f"{role}: {text_val}\n"

    system_instruction = (
        "You are an expert Stable Diffusion prompt tagger. "
        f"Your task is to generate precise visual image tags depicting the character '{char_name}' in the current scene.\n"
        "Rules for tag generation:\n"
        f"1. Main Subject: Focus on '{char_name}' (e.g. '1girl, solo'). Do NOT include additional characters.\n"
        "2. Character & Outfit: Include the character's clothing/outfit and physical features.\n"
        "3. Setting & Environment: Include environment details combined with the active scene context.\n"
        "4. Pose & Expression: Capture the character's posture, action, and expression.\n"
        "5. Format: Output ONLY comma-separated tags. "
        "ONLY output the comma-separated prompt tags."
    )

    prompt_parts = []
    if description:
        prompt_parts.append(f"Character Profile ({char_name}):\n{description}")
    if scenario:
        prompt_parts.append(f"Default Setting / Scenario:\n{scenario}")
    if history_text:
        prompt_parts.append(f"Recent Scene & Dialogue:\n{history_text.strip()}")
    prompt_parts.append(f"Output comma-separated Stable Diffusion tags for {char_name} in this scene:")
    prompt = "\n\n".join(prompt_parts)

    try:
        start_llm()
        tags = st.run_async(st.runner.generate_impersonation(prompt, system_instruction, temperature=0.3))
        if tags:
            tags = st.THINKING_STRIP_RE.sub('', tags).strip()
            tags = tags.strip('`"\'').strip()
            if tags:
                _cached_portrait_tags[cache_key] = tags
                print(f"[Portrait] LLM extracted tags for {target_prog}: {tags}", flush=True)
                return tags
    except Exception as e:
        print(f"[Portrait] Error querying LLM for tags: {e}", flush=True)

    return custom_prompt


@media_bp.route('/api/portrait/generate', methods=['POST'])
@st.requires_auth
def api_generate_portrait():
    import queue
    from utils import image_cancellation
    from core.program_config import _load_card_data

    req_body = request.json or {}
    session_id = req_body.get('session_id', 'default')
    custom_prompt = req_body.get('prompt', '')
    requested_speaker = req_body.get('speaker_id')
    count = max(1, min(2, int(req_body.get('count', 2))))
    stream = bool(req_body.get('stream', False))
    cancelled_sessions.discard(session_id)

    deadline = time.monotonic() + 300.0
    acquired = False
    while time.monotonic() < deadline and session_id not in cancelled_sessions:
        if st._image_mutex.acquire(timeout=min(0.25, max(0.0, deadline - time.monotonic()))):
            acquired = True
            break
    if not acquired:
        if session_id in cancelled_sessions:
            return jsonify({'error': 'Portrait generation cancelled by user.'}), 400
        return jsonify({'error': 'Image generation engine is currently busy. Please retry in a moment.'}), 429

    st.runner.mark_generating(session_id)
    raw_msg_id = req_body.get('msg_id')
    if isinstance(raw_msg_id, str) and re.match(r'^prgm_[a-zA-Z0-9_\-]+$', raw_msg_id):
        portrait_msg_id = raw_msg_id
    else:
        portrait_msg_id = f"prgm_{uuid.uuid4().hex}"
    try:
        target_prog = resolve_portrait_speaker_id(session_id, requested_speaker_id=requested_speaker, custom_prompt=custom_prompt)
        card = _load_card_data(target_prog)
        prog_name = card.get("name") or target_prog.title()
    except Exception as e:
        st.runner.unmark_generating(session_id)
        st._image_mutex.release()
        return jsonify({'error': str(e)}), 500

    if stream:
        operation = image_cancellation.begin_message_operation(session_id, portrait_msg_id, target_prog)
        event_q: "queue.Queue[dict | None]" = queue.Queue()

        def _worker():
            emitted_urls: list[str] = []
            extracted_tags = ""
            message_created = False
            try:
                with image_cancellation.use_message_operation(operation):
                    if session_id in cancelled_sessions or operation.cancelled.is_set():
                        event_q.put({'type': 'cancelled', 'error': 'Portrait generation cancelled by user.'})
                        return

                    import tools.tools as tools
                    tools.current_session_id.set(session_id)
                    tools.current_speaker_id.set(target_prog)
                    with tools.session_tool_calls_lock:
                        tools.session_tool_calls[session_id] = []

                    extracted_tags = extract_portrait_tags_from_context(session_id, custom_prompt, program_id=target_prog)
                    if session_id in cancelled_sessions or operation.cancelled.is_set():
                        event_q.put({'type': 'cancelled', 'error': 'Portrait generation cancelled by user.'})
                        return

                    def _on_slot_ready(slot_idx: int, slot_url: str):
                        nonlocal message_created
                        if slot_idx >= 2 or len(emitted_urls) >= 2:
                            return
                        emitted_urls.append(slot_url)
                        msg_payload = None
                        if not message_created:
                            saved = st.run_async(
                                st.runner.append_message_to_session(
                                    session_id,
                                    "program",
                                    f"![Portrait]({slot_url})",
                                    msg_id=portrait_msg_id,
                                    sender_id=target_prog,
                                    sender_name=prog_name,
                                    prompt=extracted_tags,
                                )
                            )
                            if saved:
                                message_created = True
                                hist = st.run_async(st.runner.get_history(session_id))
                                msg_payload = next((m for m in hist if m.get('id') == portrait_msg_id), None)
                        else:
                            st.run_async(
                                st.runner.replace_image_in_session(
                                    session_id,
                                    "",
                                    slot_url,
                                    new_prompt=extracted_tags,
                                    msg_id=portrait_msg_id,
                                    slot_index=slot_idx,
                                    speaker_id=target_prog,
                                )
                            )
                        st.broadcast_media_change(target_prog)
                        event_q.put({
                            'type': 'slot',
                            'index': slot_idx,
                            'image_url': slot_url,
                            'prompt': extracted_tags,
                            'program_msg_id': portrait_msg_id,
                            'sender_id': target_prog,
                            'sender_name': prog_name,
                            'message': msg_payload,
                        })

                    cb_token = tools.current_portrait_slot_callback.set(_on_slot_ready)
                    try:
                        new_markdown = tools.generate_local_image(extracted_tags, count=count, program_id=target_prog)
                    finally:
                        tools.current_portrait_slot_callback.reset(cb_token)

                    if emitted_urls:
                        hist = st.run_async(st.runner.get_history(session_id))
                        final_msg = next((m for m in hist if m.get('id') == portrait_msg_id), None)
                        event_q.put({
                            'type': 'done',
                            'status': 'success',
                            'message': final_msg,
                            'image_url': emitted_urls[0],
                            'image_urls': emitted_urls,
                            'prompt': extracted_tags,
                            'program_msg_id': portrait_msg_id,
                            'sender_name': prog_name,
                        })
                    elif session_id in cancelled_sessions or operation.cancelled.is_set() or "cancelled" in new_markdown.lower():
                        event_q.put({'type': 'cancelled', 'error': 'Portrait generation cancelled by user.'})
                    else:
                        event_q.put({'type': 'error', 'error': new_markdown or 'Portrait generation failed.'})
            except Exception as exc:
                if emitted_urls:
                    hist = st.run_async(st.runner.get_history(session_id))
                    final_msg = next((m for m in hist if m.get('id') == portrait_msg_id), None)
                    event_q.put({
                        'type': 'done',
                        'status': 'success',
                        'message': final_msg,
                        'image_url': emitted_urls[0],
                        'image_urls': emitted_urls,
                        'prompt': extracted_tags,
                        'program_msg_id': portrait_msg_id,
                        'sender_name': prog_name,
                    })
                else:
                    event_q.put({'type': 'error', 'error': str(exc)})
            finally:
                event_q.put(None)

        worker_thread = threading.Thread(target=_worker, daemon=True)
        worker_thread.start()

        def _stream_ndjson():
            try:
                while True:
                    item = event_q.get()
                    if item is None:
                        break
                    yield json.dumps(item) + "\n"
            finally:
                if worker_thread.is_alive():
                    operation.cancelled.set()
                    from core.engine_diffusion import interrupt_diffusion_generation
                    interrupt_diffusion_generation()
                    worker_thread.join(timeout=10.0)
                st.runner.unmark_generating(session_id)
                st.finish_generation_request(session_id)
                st._image_mutex.release()

        return Response(_stream_ndjson(), mimetype='application/x-ndjson', headers={'Cache-Control': 'no-cache'})

    try:
        with image_cancellation.message_operation(session_id, portrait_msg_id, target_prog) as cancel_ev:
            if session_id in cancelled_sessions or cancel_ev.is_set():
                return jsonify({'error': 'Portrait generation cancelled by user.'}), 400

            import tools.tools as tools
            tools.current_session_id.set(session_id)
            tools.current_speaker_id.set(target_prog)
            with tools.session_tool_calls_lock:
                tools.session_tool_calls[session_id] = []

            extracted_tags = extract_portrait_tags_from_context(session_id, custom_prompt, program_id=target_prog)

            if session_id in cancelled_sessions or cancel_ev.is_set():
                return jsonify({'error': 'Portrait generation cancelled by user.'}), 400

            new_markdown = tools.generate_local_image(extracted_tags, count=count, program_id=target_prog)

            if session_id in cancelled_sessions or cancel_ev.is_set():
                return jsonify({'error': 'Portrait generation cancelled by user.'}), 400

            if new_markdown.startswith("Error"):
                return jsonify({'error': new_markdown}), 500

            image_urls = re.findall(r'!\[[^\]]*\]\(([^)]+)\)', new_markdown)
            if not image_urls:
                return jsonify({'error': 'Portrait generation did not return an image.'}), 500
            new_image_url = image_urls[0]

            saved = st.run_async(
                st.runner.append_message_to_session(
                    session_id,
                    "program",
                    new_markdown,
                    msg_id=portrait_msg_id,
                    sender_id=target_prog,
                    sender_name=prog_name,
                    prompt=extracted_tags,
                )
            )
            if not saved:
                return jsonify({'error': 'Could not save the portrait message.'}), 500
            st.broadcast_media_change(target_prog)

            portrait_history = st.run_async(st.runner.get_history(session_id))
            return jsonify({
                'status': 'success',
                'message': next((m for m in portrait_history if m.get('id') == portrait_msg_id), None),
                'image_url': new_image_url,
                'image_urls': image_urls,
                'prompt': extracted_tags,
                'program_msg_id': portrait_msg_id,
                'sender_name': prog_name,
            })
    except Exception as e:
        print(f"Error generating direct portrait: {e}")
        return jsonify({'error': str(e)}), 500
    finally:
        st.runner.unmark_generating(session_id)
        st.finish_generation_request(session_id)
        st._image_mutex.release()


def run_background_video_gen(task_id, session_id, image_url, local_path, prompt, operation):
    from utils.image_cancellation import use_message_operation
    with use_message_operation(operation):
        _run_background_video_gen(task_id, session_id, image_url, local_path, prompt)


def _run_background_video_gen(task_id, session_id, image_url, local_path, prompt):
    import tools.tools as tools
    from utils.image_cancellation import current_event
    tools.current_session_id.set(session_id)
    relative_image = os.path.relpath(os.path.abspath(local_path), os.path.join(st.base_dir, "core", "programs"))
    owner_parts = Path(relative_image).parts
    if len(owner_parts) >= 3 and owner_parts[0] != os.pardir:
        tools.current_speaker_id.set(owner_parts[0])
    
    with st.active_generations_lock:
        if task_id in st.active_generations:
            st.active_generations[task_id]['status'] = 'generating'
            st.active_generations[task_id]['progress'] = 20
            
    try:
        if current_event().is_set():
            raise RuntimeError("Video generation cancelled by user.")
        # Call video generation
        new_video_url = tools.generate_video_from_image(local_path, prompt)
        if session_id in cancelled_sessions or current_event().is_set():
            raise RuntimeError("Video generation cancelled by user.")
        
        # Replace the image in session history
        success = st.run_async(st.runner.replace_image_with_video_in_session(session_id, image_url, new_video_url))
        if success:
            st.broadcast_media_change()
        
        with st.active_generations_lock:
            if task_id in st.active_generations:
                st.active_generations[task_id].update({
                    'status': 'completed',
                    'progress': 100,
                    'result_url': new_video_url,
                    'history_updated': success
                })
                
    except Exception as e:
        print(f"Error in background generation task {task_id}: {e}")
        with st.active_generations_lock:
            if task_id in st.active_generations:
                st.active_generations[task_id].update({
                    'status': 'failed',
                    'progress': 100,
                    'error': str(e)
                })


@media_bp.route('/api/animate_image', methods=['POST'])
@st.requires_auth
def animate_image():
    session_id = request.json.get('session_id', 'default')
    image_url = request.json.get('image_url')
    prompt = request.json.get('prompt', '')
    
    if not image_url:
        return jsonify({'error': 'Missing image_url'}), 400
        
    try:
        from runners.runner import _get_safe_local_path
        
        # Resolve to safe local path
        local_path = _get_safe_local_path(image_url)
        if not local_path or not os.path.exists(local_path):
            return jsonify({'error': f'Image file not found: {image_url}'}), 404
            
        # Create a unique task ID
        task_id = f"gen_{int(time.time())}_{uuid.uuid4().hex[:4]}"
        
        # Initialize task in queue
        with st.active_generations_lock:
            st.active_generations[task_id] = {
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
            
        # Register before spawning so a deletion can cancel even a queued task.
        from utils.image_cancellation import begin_message_operation, use_message_operation
        message_id = request.json.get('msg_id') or find_image_message_id(session_id, image_url)
        relative_image = os.path.relpath(os.path.abspath(local_path), os.path.join(st.base_dir, "core", "programs"))
        owner_parts = Path(relative_image).parts
        owner = owner_parts[0] if len(owner_parts) >= 3 and owner_parts[0] != os.pardir else None
        operation = begin_message_operation(session_id, message_id, owner)
        t = threading.Thread(
            target=run_background_video_gen,
            args=(task_id, session_id, image_url, local_path, prompt, operation),
            daemon=True
        )
        try:
            t.start()
        except Exception:
            with use_message_operation(operation):
                raise
        
        return jsonify({
            'status': 'queued',
            'task_id': task_id
        })
            
    except Exception as e:
        print(f"Error starting animation queue for {image_url}: {e}")
        return jsonify({'error': str(e)}), 500


@media_bp.route('/api/generations', methods=['GET'])
@st.requires_auth
def list_generations():
    with st.active_generations_lock:
        tasks = list(st.active_generations.values())
        tasks.sort(key=lambda x: x['timestamp'], reverse=True)
        return jsonify({
            'generations': tasks
        })


@media_bp.route('/list_images', methods=['GET'])
@st.requires_auth
def list_images():
    try:
        from runners.program import get_active_program
        requested_program = request.args.get('program_id')
        active_program = requested_program or get_active_program() or os.getenv("ACTIVE_PROGRAM", "sebile")
        programs_root = os.path.join(st.base_dir, 'core', 'programs')
        valid_exts = ('.png', '.jpg', '.jpeg', '.webp', '.gif', '.mp4', '.webm')

        items_by_owner = {}
        image_owners = {}
        upload_items = []

        if os.path.isdir(programs_root):
            for prog in os.listdir(programs_root):
                prog_dir = os.path.join(programs_root, prog)
                if not os.path.isdir(prog_dir):
                    continue
                items_by_owner.setdefault(prog, [])
                for folder in ('portraits', 'media'):
                    target_dir = os.path.join(prog_dir, folder)
                    if os.path.exists(target_dir):
                        for f in os.listdir(target_dir):
                            if f.lower().endswith(valid_exts) and f.lower() not in ('profile.png', 'profile.svg'):
                                full_path = os.path.join(target_dir, f)
                                if os.path.isfile(full_path):
                                    url = f"/images/{folder}/{f}"
                                    owner = prog
                                    sidecar = os.path.splitext(full_path)[0] + '.json'
                                    if os.path.exists(sidecar):
                                        try:
                                            with open(sidecar, 'r', encoding='utf-8') as sf:
                                                sdata = json.load(sf)
                                            if sdata.get('program_id'):
                                                owner = sdata['program_id']
                                        except Exception:
                                            pass
                                    items_by_owner.setdefault(owner, []).append({
                                        'url': url,
                                        'mtime': os.path.getmtime(full_path),
                                    })
                                    if url not in image_owners or prog == owner:
                                        image_owners[url] = owner

                uploads_dir = os.path.join(prog_dir, 'uploads')
                if os.path.exists(uploads_dir):
                    for f in os.listdir(uploads_dir):
                        if f.lower().endswith(valid_exts):
                            full_path = os.path.join(uploads_dir, f)
                            if os.path.isfile(full_path):
                                upload_items.append({
                                    'url': f"/images/uploads/{f}",
                                    'mtime': os.path.getmtime(full_path),
                                })

        images_by_program = {}
        for owner, items in items_by_owner.items():
            items.sort(key=lambda x: x['mtime'], reverse=True)
            seen = set()
            deduped = []
            for item in items:
                if item['url'] not in seen:
                    seen.add(item['url'])
                    deduped.append(item['url'])
            images_by_program[owner] = deduped

        upload_items.sort(key=lambda x: x['mtime'], reverse=True)
        seen_uploads = set()
        uploads = []
        for item in upload_items:
            if item['url'] not in seen_uploads:
                seen_uploads.add(item['url'])
                uploads.append(item['url'])

        image_urls = images_by_program.get(active_program, [])
        return jsonify({
            'images': image_urls,
            'images_by_program': images_by_program,
            'image_owners': image_owners,
            'uploads': uploads
        })
    except Exception as e:
        print(f"Error listing images: {e}")
        return jsonify({'error': str(e)}), 500

