import json
import os
import queue as _queue

from flask import Blueprint, Response, jsonify

import state as st
import variables.settings as vs
from runners.program import get_active_program, get_active_session, get_active_user

health_bp = Blueprint("health_bp", __name__)


@health_bp.route("/api/health")
def health_check():
    """Lightweight endpoint for desktop launcher readiness detection."""
    return jsonify({"status": "ok"})


@health_bp.route("/api/config", methods=["GET"])
@st.requires_auth
def get_runtime_config():
    """Runtime bootstrap configuration for the pure-static client."""
    active_program = get_active_program()
    active_session = get_active_session()
    active_user = get_active_user()
    if os.getenv("AUTH_USER") and request_user_fallback():
        active_user = request_user_fallback()

    from core.mood_inversion import get_program_mood_metadata
    from runners.program import _load_settings

    settings = _load_settings()
    return jsonify({
        "local_ip": st.get_local_ip(),
        "tts_auto_speak": os.getenv("TTS_AUTO_SPEAK", "false").lower() == "true",
        "tts_provider": os.getenv("TTS_PROVIDER", "local").lower(),
        "active_program": active_program,
        "active_session": active_session,
        "active_user": active_user,
        "theme": st.load_theme(active_program),
        "program_moods": get_program_mood_metadata(active_program),
        "security_preset": settings.get("security_preset", "ask_always"),
        "review_policy": settings.get("review_policy", "ask_always"),
        "temperature": st.load_temperature(),
    })


def request_user_fallback():
    from flask import request
    from runners.program import get_active_user
    if request.authorization and get_active_user() == "builder":
        return request.authorization.username
    return None


@health_bp.route("/api/mobile/health", methods=["GET"])
@st.requires_auth
def mobile_health():
    """Fast (<50ms) Sanctuary companion health, VRAM mode, and Program status snapshot."""
    from adapters import vram_orchestrator
    from runners import local_server

    mode_raw = getattr(vram_orchestrator, "_current_mode", None)
    gpu_mode = "llm" if mode_raw == "LLM" else ("diffusion" if mode_raw == "IMG" else "idle")
    active_model = local_server.get_loaded_model_name() or os.getenv("LOCAL_MODEL_NAME", "")

    active_program = get_active_program()
    gen_sessions: list[str] = []
    prog_history_cache: dict[str, tuple[float | None, str | None]] = {}
    active_sess = get_active_session()

    if st.runner is not None:
        with st.runner._lock:
            gen_sessions = sorted(getattr(st.runner, "generating_sessions", set()))
            for sid, msgs in getattr(st.runner, "sessions_history", {}).items():
                if not msgs:
                    continue
                owner = getattr(st.runner, "sessions_program", {}).get(sid) or st.runner.program_id
                last_msg = msgs[-1]
                ts = last_msg.get("timestamp")
                txt = (last_msg.get("text") or "").strip()
                snippet = txt[:140] if txt else None
                prev = prog_history_cache.get(owner)
                if prev is None or (ts or 0) > (prev[0] or 0):
                    prog_history_cache[owner] = (ts, snippet)

    programs = []
    progs_dir = vs.PROGRAMS_DIR
    if os.path.exists(progs_dir):
        for folder in sorted(os.listdir(progs_dir)):
            folder_path = os.path.join(progs_dir, folder)
            if not os.path.isdir(folder_path):
                continue
            if folder != "sebile":
                has_json = os.path.isfile(os.path.join(folder_path, f"{folder}.json"))
                has_md = any(f.lower().endswith(".md") for f in os.listdir(folder_path))
                if not has_json and not has_md:
                    continue

            card = st.read_program_card(folder)
            prog_name = (card.get("name") or "").strip() or folder.title()
            tdata = st.load_theme(folder)
            accent_color = "#9370db"
            if tdata:
                accent_color = tdata.get("primary_accent") or tdata.get("main_color") or accent_color

            has_profile = os.path.exists(os.path.join(folder_path, "portraits", "profile.png"))
            thought_entry = st._program_idle_thoughts.get(folder)
            idle_thought = thought_entry.get("text") if isinstance(thought_entry, dict) else None

            last_active, last_snippet = prog_history_cache.get(folder, (None, None))
            if last_active is None:
                default_sess = os.path.join(folder_path, "sessions", f"{active_sess}.json")
                if not os.path.exists(default_sess):
                    default_sess = os.path.join(folder_path, "sessions", "default.json")
                if os.path.exists(default_sess):
                    try:
                        last_active = os.path.getmtime(default_sess)
                    except OSError:
                        pass

            is_generating = False
            if st.runner is not None and gen_sessions:
                for sid in gen_sessions:
                    if st.runner.sessions_program.get(sid) == folder or (folder == active_program and sid == active_sess):
                        is_generating = True
                        break

            programs.append({
                "id": folder,
                "name": prog_name,
                "personality": str(card.get("personality") or "").strip(),
                "avatar": f"/programs/{folder}/profile.png" if has_profile else None,
                "has_profile": has_profile,
                "accent_color": accent_color,
                "theme": tdata,
                "active": folder == active_program,
                "generating": is_generating,
                "idle_thought": idle_thought,
                "last_active": last_active,
                "last_snippet": last_snippet,
            })

    return jsonify({
        "status": "online",
        "gpu_mode": gpu_mode,
        "active_model": active_model,
        "active_program": active_program,
        "generating_sessions": gen_sessions,
        "programs": programs,
    })


@health_bp.route('/api/events/status')
@st.requires_auth
def sse_status_stream():
    """SSE endpoint for live connection status updates."""
    q = _queue.Queue(maxsize=50)
    with st._sse_clients_lock:
        st._sse_clients.append(q)

    def stream():
        try:
            # Send initial status immediately
            status = st._get_current_status()
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
            with st._sse_clients_lock:
                if q in st._sse_clients:
                    st._sse_clients.remove(q)

    return Response(stream(), mimetype='text/event-stream', headers={
        'Cache-Control': 'no-cache',
        'X-Accel-Buffering': 'no',
        'Connection': 'keep-alive',
    })

