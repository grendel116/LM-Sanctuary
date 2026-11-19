"""Shared mutable state, runner lifecycle, auth decorator, and SSE helpers for the Sanctuary node."""

import asyncio
import concurrent.futures
import json
import os
import queue as _queue
import re
import shutil
import socket
import sys
import threading
import time
from pathlib import Path
from functools import wraps

SANCTUARY_DIR = str(Path(__file__).resolve().parent)
if SANCTUARY_DIR not in sys.path:
    sys.path.insert(0, SANCTUARY_DIR)

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

from dotenv import load_dotenv
from flask import Response, jsonify, make_response, request

base_dir = Path(SANCTUARY_DIR)
project_root = base_dir.parent
web_dir = project_root / "web"

env_path = project_root / ".env"
if not env_path.exists():
    for candidate in (project_root / ".env.example", base_dir / ".env.example"):
        if candidate.exists():
            try:
                shutil.copy(candidate, env_path)
                print(f">>> Automatically copied {candidate} to {env_path}")
            except Exception as e:
                print(f"Error copying default .env configuration: {e}")
            break

for _cand in (project_root / ".env", base_dir / ".env"):
    if _cand.exists():
        load_dotenv(dotenv_path=_cand, override=True)

import variables.settings as vs
from runners.runner import OpenSourceRunner, cancelled_sessions, voice_call_sessions
from runners.program import get_active_program, get_active_user
from utils.utils import THINK_TAG_PATTERN as THINKING_STRIP_RE

os.environ["ACTIVE_PROGRAM"] = get_active_program()

_async_loop = None
_async_loop_thread = None
_async_loop_lock = threading.Lock()
_async_loop_ready = threading.Event()

PROGRAM_ID_RE = re.compile(r"^[a-zA-Z0-9_\-]+$")
SAFE_NAME_RE = re.compile(r"[^a-zA-Z0-9_]")
USER_PROFILE_NAME_RE = re.compile(r"[^a-zA-Z0-9_\-]")

_cached_active_program = None
_cached_active_user = None
_cached_local_ip = None
_theme_cache = {}
_program_idle_thoughts: dict[str, dict] = {}

runner = None

_image_mutex = threading.Lock()
_active_regen_lock = threading.Lock()
_active_image_regenerations: dict[str, int] = {}

active_generations = {}
active_generations_lock = threading.Lock()

_sse_clients = []
_sse_clients_lock = threading.Lock()
_last_broadcast_state = {}
_services_started = False


def requires_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if request.method == "OPTIONS":
            return make_response("", 204)
        auth_user = os.getenv("AUTH_USER")
        auth_pass = os.getenv("AUTH_PASS")
        if auth_user and auth_pass:
            auth = request.authorization
            if not auth or not check_auth(auth.username, auth.password):
                return authenticate()
        return f(*args, **kwargs)
    return decorated


def _run_async_loop(loop):
    asyncio.set_event_loop(loop)
    loop.call_soon(_async_loop_ready.set)
    loop.run_forever()


def run_async(coroutine):
    global _async_loop, _async_loop_thread

    with _async_loop_lock:
        if _async_loop is None:
            loop = asyncio.new_event_loop()
            thread = threading.Thread(
                target=_run_async_loop,
                args=(loop,),
                name="sanctuary-async-loop",
                daemon=True,
            )
            try:
                thread.start()
            except Exception:
                loop.close()
                raise
            _async_loop = loop
            _async_loop_thread = thread

    if not _async_loop_ready.wait(timeout=10):
        raise RuntimeError("Timed out while starting the application event loop.")
    if _async_loop is None or not _async_loop.is_running():
        raise RuntimeError("The application event loop is not running.")
    if threading.current_thread() is _async_loop_thread:
        raise RuntimeError("run_async cannot block the application event-loop thread.")

    future = asyncio.run_coroutine_threadsafe(coroutine, _async_loop)
    try:
        return future.result()
    except concurrent.futures.CancelledError as exc:
        raise asyncio.CancelledError() from exc


def get_local_ip() -> str:
    global _cached_local_ip
    if _cached_local_ip:
        return _cached_local_ip
    local_ip = "127.0.0.1"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(0.3)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    _cached_local_ip = local_ip
    return _cached_local_ip


def get_program_dir(program_id: str) -> str:
    programs_root = os.path.realpath(vs.PROGRAMS_DIR)
    resolved_path = os.path.realpath(os.path.join(programs_root, program_id))
    if resolved_path == programs_root or os.path.commonpath([programs_root, resolved_path]) != programs_root:
        raise ValueError("Invalid program identifier: path traversal attempt detected.")
    return resolved_path


def read_program_card(program_id: str) -> dict:
    program_dir = get_program_dir(program_id)
    json_path = os.path.join(program_dir, f"{program_id}.json")
    if os.path.exists(json_path):
        try:
            with open(json_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return raw.get("data", raw)
        except Exception as e:
            print(f"Error reading character card for {program_id}: {e}")
    return {}


def init_runner():
    global runner
    active_prog = get_active_program()
    runner = OpenSourceRunner(app_name="Sanctuary", program_id=active_prog)
    print(">>> Starting Sanctuary using decoupled OPEN-SOURCE Runner backend!")


def prewarm_caches():
    print(">>> Pre-warming backend caches in background...")

    # Auto-start high-speed standalone llama-server if configured
    auto_start = os.getenv("AUTO_START_LOCAL_LLM", "true").lower() in ("true", "1", "yes")
    if auto_start:
        try:
            from runners import local_server
            print(">>> Auto-starting high-speed local LLM server...")
            local_server.start_local_server()
        except Exception as e:
            print(f"Error auto-starting local LLM server: {e}")

    # Pre-warm local STT whisper model
    try:
        from core import stt
        stt.get_whisper_model()
    except Exception as e:
        print(f"Error prewarming STT model: {e}")

    print(">>> Backend caches pre-warmed successfully!")


def reload_program_state(program_id: str = None):
    """Switch the active runner to the target program without discarding cached session state."""
    target = program_id or get_active_program()
    if runner is None:
        init_runner()
    if hasattr(runner, 'switch_program'):
        runner.switch_program(target)
    else:
        runner.program_id = target


def load_theme(program_id):
    """Load theme.json for a program, returning the parsed dict or None."""
    if program_id in _theme_cache:
        return _theme_cache[program_id]
    theme_path = os.path.join(get_program_dir(program_id), "theme.json")
    if os.path.exists(theme_path):
        try:
            with open(theme_path, "r", encoding="utf-8") as tf:
                theme_data = json.load(tf)
                _theme_cache[program_id] = theme_data
                return theme_data
        except Exception as e:
            print(f"Error loading theme for {program_id}: {e}")
    return None


def load_temperature():
    """Read temperature from project settings, defaulting to 0.95."""
    settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
    if os.path.exists(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                return json.load(f).get("temperature", 0.95)
        except Exception:
            pass
    return 0.95


def remote_configuration():
    """Return the configured remote endpoint only when both values are usable."""
    api_key = os.getenv("REMOTE_API_KEY", "").strip()
    cloud_url = os.getenv("REMOTE_CLOUD_URL", "").strip()
    configured = bool(
        api_key and api_key != "your_remote_api_key_here" and
        cloud_url and cloud_url != "your_remote_cloud_url_here"
    )
    return configured, api_key, cloud_url


def find_image_sidecar_json(image_filename, active_program, program_id=None):
    """Locate the sidecar .json for an image, scanning preferred/active then all programs."""
    preferred_progs = []
    for p in (program_id, active_program):
        if p and p not in preferred_progs:
            preferred_progs.append(p)

    for prog in preferred_progs:
        for folder in ('portraits', 'media'):
            png_path = os.path.normpath(
                os.path.join(vs.vs.PROGRAMS_DIR, prog, folder, image_filename)
            )
            json_path = os.path.splitext(png_path)[0] + '.json'
            if os.path.exists(json_path):
                return json_path
    # dynamic vs.PROGRAMS_DIR
    if os.path.exists(vs.PROGRAMS_DIR):
        for prog in os.listdir(vs.PROGRAMS_DIR):
            for folder in ('portraits', 'media'):
                candidate = os.path.normpath(
                    os.path.join(vs.PROGRAMS_DIR, prog, folder, image_filename)
                )
                candidate_json = os.path.splitext(candidate)[0] + '.json'
                if os.path.exists(candidate_json):
                    return candidate_json
    return None


def extract_mood(chat_history):
    """Extract mood from the latest text program message, skipping image generations."""
    for msg in reversed(chat_history):
        if msg.get('role') == 'program':
            msg_id = msg.get('id', '')
            text = (msg.get('text') or '').strip()
            if msg_id.startswith('img_') or (text.startswith('![') and text.endswith(')')):
                continue
            mood = msg.get('mood')
            if mood:
                return mood
            break
    from core.mood_inversion import analyze_emotional_state
    from runners.program import get_active_program
    return analyze_emotional_state("", program_id=get_active_program())


def prepare_generation_request(session_id, is_voice_call=False):
    """Reset per-session tool state before a generation request."""
    import tools.tools as tools
    tools.current_session_id.set(session_id)
    with tools.session_tool_calls_lock:
        tools.session_tool_calls[session_id] = []

    cancelled_sessions.discard(session_id)
    if is_voice_call:
        voice_call_sessions.add(session_id)


def finish_generation_request(session_id) -> list:
    """Close out the live tool activity for a finished request and return what ran.

    The live activity list holds only the request in flight, so the next turn's
    first poll starts from an empty list.
    """
    import tools.tools as tools
    with tools.session_tool_calls_lock:
        return tools.session_tool_calls.pop(session_id, [])


def sanitize_response(response_text: str, session_id: str, program_msg_id: str) -> str:
    """Cleans or processes the generated response text before sending it to the client."""
    if not response_text:
        return ""
    from core.mood_inversion import extract_and_strip_mood
    clean_text, _ = extract_and_strip_mood(response_text)
    return clean_text


def enrich_group_meta(group_meta):
    if not group_meta or not group_meta.get("is_group"):
        return group_meta
    from core.program_config import _load_card_data
    all_ids = [group_meta.get("host_id")] + [g for g in group_meta.get("guest_ids", []) if g != group_meta.get("host_id")]
    members = []
    for pid in all_ids:
        if pid:
            c = _load_card_data(pid)
            th = load_theme(pid)
            members.append({
                "id": pid,
                "name": (c.get("name") if c else pid.title()).strip(),
                "theme": th
            })
    enriched = dict(group_meta)
    enriched["members"] = members
    return enriched


def build_generation_response(response_text, tool_calls, session_id, user_msg_id, program_msg_id, started_at):
    """Build the common response payload returned by chat and edit routes."""
    response_text = sanitize_response(response_text, session_id, program_msg_id)
    chat_history = run_async(runner.get_history(session_id))
    inversion_mode = run_async(runner._get_inversion_mode(session_id, history=chat_history))

    program_timestamp = None
    program_sender_id = None
    program_sender_name = None
    if program_msg_id:
        for message in reversed(chat_history):
            if message.get('id') == program_msg_id:
                program_timestamp = message.get('timestamp')
                program_sender_id = message.get('sender_id')
                program_sender_name = message.get('sender_name')
                break

    chain_continue = False
    next_speaker_id = None

    group_meta = getattr(runner, "sessions_group_meta", {}).get(session_id)
    if group_meta and group_meta.get("is_group"):
        host_id = group_meta.get("host_id")
        guest_ids = group_meta.get("guest_ids", [])
        all_ids = [host_id] + [g for g in guest_ids if g != host_id]

        if len(all_ids) > 1:
            from runners.runner import is_real_user_msg, detect_addressed_speaker

            consecutive_assistant_count = 0
            last_real_user_msg = None
            for m in reversed(chat_history):
                if is_real_user_msg(m):
                    last_real_user_msg = m
                    break
                if m.get("role") == "program":
                    consecutive_assistant_count += 1

            MAX_CHAIN_TURNS = 10
            if consecutive_assistant_count < MAX_CHAIN_TURNS:
                current_speaker = program_sender_id or (chat_history[-1].get("sender_id") if chat_history else None)

                # 1. Check if the current speaker's text explicitly addressed another program in the room
                addressed_by_speaker = detect_addressed_speaker(response_text, all_ids, exclude_id=current_speaker)
                if addressed_by_speaker:
                    chain_continue = True
                    next_speaker_id = addressed_by_speaker
                else:
                    # 2. Check if user addressed a specific program in their last message
                    user_addressed = None
                    if last_real_user_msg:
                        user_text = last_real_user_msg.get("text") or ""
                        if not user_text.startswith("[System:"):
                            user_addressed = detect_addressed_speaker(user_text, all_ids)

                    # Round Robin if user did not address anyone specific
                    if not user_addressed:
                        speakers_in_round = set()
                        for m in reversed(chat_history):
                            if is_real_user_msg(m):
                                break
                            if m.get("role") == "program" and m.get("sender_id"):
                                speakers_in_round.add(m.get("sender_id"))

                        unspoken = [pid for pid in all_ids if pid not in speakers_in_round]
                        if unspoken:
                            chain_continue = True
                            next_speaker_id = unspoken[0]
                        else:
                            chain_continue = False
                            next_speaker_id = None
                    else:
                        chain_continue = False
                        next_speaker_id = None

    duration = round(time.time() - started_at, 1)
    run_async(runner.set_message_duration(session_id, program_msg_id, duration))
    program_message = next((m for m in chat_history if program_msg_id and m.get('id') == program_msg_id), None)
    if program_message:
        program_message = dict(program_message, duration=duration)

    return jsonify({
        'response': response_text,
        # The stored program turn in the exact wire form /history serves it.
        'message': program_message,
        'tool_calls': tool_calls,
        'state': extract_mood(chat_history),
        'inversion_active': inversion_mode,
        'inversion_state': runner.get_inversion_state(session_id),
        'timestamp': program_timestamp or time.time(),
        'duration': duration,
        'user_msg_id': user_msg_id,
        'program_msg_id': program_msg_id,
        'sender_id': program_sender_id,
        'sender_name': program_sender_name,
        'chain_continue': chain_continue,
        'next_speaker': next_speaker_id,
    })


def check_auth(username, password):
    return username == os.getenv("AUTH_USER") and password == os.getenv("AUTH_PASS")


def authenticate():
    return Response(
        'Could not verify your access level for that URL.\n'
        'You have to login with proper credentials', 401,
        {'WWW-Authenticate': 'Basic realm="Login Required"'}
    )


def cancel_session_image_work(session_id):
    from utils import image_cancellation
    cancelled_sessions.add(session_id)
    return image_cancellation.cancel(session_ids={session_id})


def cancel_message_image_work(session_id, message_id):
    from utils import image_cancellation
    return image_cancellation.cancel_message(session_id, message_id)


def _update_program_references(old_id: str, new_id: str, new_name: str = None):
    """Synchronize theme cache, session group_meta, message sender metadata, and image sidecars."""
    if old_id and new_id and old_id != new_id and old_id in _theme_cache:
        _theme_cache[new_id] = _theme_cache.pop(old_id)
    if runner is not None:
        runner.update_program_references(old_id, new_id, new_name)


def _get_current_status():
    """Build the combined connection status payload."""
    from runners import local_server
    is_remote_configured, _, remote_cloud_url = remote_configuration()
    
    # Load temperature dynamically
    temperature = 0.95
    try:
        # dynamic vs.VARIABLES_DIR
        settings_path = os.path.join(vs.VARIABLES_DIR, "project_settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
                temperature = settings.get("temperature", 0.95)
    except Exception:
        pass

    valid_programs = []
    if os.path.exists(vs.PROGRAMS_DIR):
        for folder in sorted(os.listdir(vs.PROGRAMS_DIR)):
            folder_path = os.path.join(vs.PROGRAMS_DIR, folder)
            if os.path.isdir(folder_path):
                if folder == "sebile" or os.path.isfile(os.path.join(folder_path, f"{folder}.json")) or any(f.lower().endswith(".md") for f in os.listdir(folder_path)):
                    valid_programs.append(folder)
        
    return {
        "remote_configured": is_remote_configured,
        "remote_model": os.getenv("REMOTE_MODEL", ""),
        "remote_url": remote_cloud_url,
        "local_online": local_server.check_local_server_status(),
        "temperature": temperature,
        "active_program": get_active_program(),
        "programs": valid_programs,
        "env_path": os.path.abspath(str(env_path)),
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


def broadcast_media_change(program_id=None, profile=False):
    """Notify connected clients that a gallery or profile picture changed."""
    data = json.dumps({"program_id": program_id, "profile": profile})
    msg = f"event: media_changed\ndata: {data}\n\n"
    with _sse_clients_lock:
        for q in list(_sse_clients):
            try:
                q.put_nowait(msg)
            except _queue.Full:
                _sse_clients.remove(q)


def _status_monitor():
    """Background thread that detects external state changes (crashes, manual stops)."""
    while True:
        time.sleep(5)
        try:
            broadcast_status()
        except Exception:
            pass



def start_background_services():
    """Initialize runner, active caches, media/status listeners, and background prewarm threads once."""
    global _cached_active_program, _cached_active_user, _services_started
    if _services_started:
        return
    _services_started = True

    _cached_active_program = get_active_program()
    _cached_active_user = get_active_user()

    init_runner()

    from runners import local_server
    from utils import media_events
    local_server._on_status_change = broadcast_status
    media_events.set_listener(broadcast_media_change)

    threading.Thread(target=_status_monitor, daemon=True).start()
    if os.getenv("SANCTUARY_SKIP_PREWARM", "false").lower() not in ("true", "1", "yes"):
        threading.Thread(target=prewarm_caches, daemon=True).start()
