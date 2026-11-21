"""Thin Flask entrypoint for the Sanctuary companion node serving web/ and /routes/* Blueprints."""

import ipaddress
import json
import os
import sys
import threading
from contextlib import nullcontext
from pathlib import Path
from urllib.parse import urlparse

SANCTUARY_DIR = str(Path(__file__).resolve().parent)
REPO_ROOT = str(Path(__file__).resolve().parent.parent)
if SANCTUARY_DIR not in sys.path:
    sys.path.insert(0, SANCTUARY_DIR)
if REPO_ROOT not in sys.path:
    sys.path.append(REPO_ROOT)

from flask import Flask, jsonify, make_response, request, send_file, send_from_directory

import state as st
from core.program_config import get_program_name
from routes.chat import chat_bp
from routes.health import health_bp
from routes.knowledge import knowledge_bp
from routes.media import media_bp
from routes.programs import programs_bp
from routes.system import system_bp
from routes.voice import voice_bp
from runners.program import get_active_program, get_active_user
from routes.social_bridge import social_bridge_bp

_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")


def is_allowed_cors_origin(origin: str) -> bool:
    """Allow Capacitor origins, loopback, .local/.ts.net, RFC1918, Tailscale CGNAT, and explicit env allowlist."""
    if not origin:
        return False
    origin = origin.strip()
    if origin in ("capacitor://localhost", "ionic://localhost"):
        return True

    extra = [item.strip() for item in os.getenv("SANCTUARY_ALLOWED_ORIGINS", "").split(",") if item.strip()]
    if origin in extra:
        return True

    try:
        parsed = urlparse(origin)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return False

    host = parsed.hostname.lower().rstrip(".")
    if host == "localhost" or host.endswith(".local") or host.endswith(".ts.net"):
        return True

    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False

    return bool(ip.is_loopback or ip.is_private or (ip.version == 4 and ip in _TAILSCALE_CGNAT))


app = Flask(__name__, static_folder=None)

app.register_blueprint(health_bp)
app.register_blueprint(chat_bp)
app.register_blueprint(media_bp)
app.register_blueprint(voice_bp)
app.register_blueprint(knowledge_bp)
app.register_blueprint(programs_bp)
app.register_blueprint(system_bp)
app.register_blueprint(social_bridge_bp)

st.start_background_services()


@app.before_request
def before_request_guard():
    if request.method == "OPTIONS":
        if is_allowed_cors_origin(request.headers.get("Origin", "")):
            return make_response("", 204)
        return None
    return check_program_change()

def check_program_change():
    skip_prefixes = (
        "/api/health",
        "/api/mobile/health",
        "/api/session_tool_calls",
        "/pending_tool_call",
        "/api/generation_status",
        "/api/events/",
        "/api/social/",
        "/assets/",
        "/app/",
        "/core/",
        "/adapters/",
        "/components/",
        "/queries/",
        "/state/",
        "/storage/",
        "/constants/",
        "/static/",
    )
    if request.path in ("/favicon.ico", "/app_icon.png", "/manifest.json", "/sw.js") or request.path.startswith(skip_prefixes):
        return None
    with (st.runner._lock if st.runner is not None else nullcontext()):
        current_program = get_active_program()
        current_user = get_active_user()

        program_changed = current_program != st._cached_active_program
        user_changed = current_user != st._cached_active_user

        if program_changed or user_changed:
            if program_changed:
                st._cached_active_program = current_program
                os.environ["ACTIVE_PROGRAM"] = current_program
                try:
                    program_path = st.get_program_dir(current_program)
                    if os.path.isdir(program_path):
                        os.makedirs(os.path.join(program_path, "portraits"), exist_ok=True)
                except Exception as ex:
                    print(f"Error preparing portraits directory for active program: {ex}")
            if user_changed:
                st._cached_active_user = current_user

            try:
                st.reload_program_state(current_program)
                print(f">>> Dynamic check loaded new program consciousness (Program: '{current_program}', User Profile: '{current_user}')")
            except Exception as e:
                print(f"Error dynamically reloading program/user: {e}")
    return None


@app.after_request
def apply_response_headers(response):
    no_cache_prefixes = (
        "/static/",
        "/assets/",
        "/app/",
        "/components/",
        "/queries/",
        "/state/",
        "/core/",
        "/adapters/",
        "/constants/",
        "/storage/",
    )
    if request.path.startswith(no_cache_prefixes) or request.path in ("/", "/index.html", "/sw.js", "/manifest.json"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    origin = request.headers.get("Origin", "")
    if origin and is_allowed_cors_origin(origin):
        response.headers["Access-Control-Allow-Origin"] = origin
        response.headers["Access-Control-Allow-Credentials"] = "true"
        response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS"
        response.headers["Access-Control-Allow-Headers"] = (
            "Authorization, Content-Type, Accept, Cache-Control, X-Requested-With"
        )
        vary = response.headers.get("Vary")
        response.headers["Vary"] = "Origin" if not vary else (vary if "Origin" in vary else f"{vary}, Origin")
    return response


@app.route("/")
@app.route("/index.html")
@st.requires_auth
def index():
    res = make_response(send_from_directory(st.web_dir, "index.html"))
    res.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return res


@app.route("/manifest.json")
def serve_manifest():
    program_name = get_program_name()
    manifest_file = st.web_dir / "manifest.json"
    try:
        with open(manifest_file, "r", encoding="utf-8") as f:
            manifest_data = json.load(f)
        manifest_data["name"] = f"{program_name} Sanctuary"
        manifest_data["short_name"] = program_name
        manifest_data["description"] = f"Enter the Sanctuary and converse with {program_name}"
        return jsonify(manifest_data)
    except Exception:
        return send_file(manifest_file, mimetype="application/json")


@app.route("/sw.js")
def serve_service_worker():
    sw_path = st.web_dir / "sw.js"
    if sw_path.is_file():
        res = make_response(send_file(sw_path, mimetype="application/javascript"))
        res.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        return res
    return "Service worker not built yet", 404


@app.route("/favicon.ico")
def favicon():
    res = make_response(send_file(st.web_dir / "assets" / "img" / "app_icon.ico", mimetype="image/x-icon"))
    res.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return res


@app.route("/app_icon.png")
def app_icon():
    res = make_response(send_file(st.web_dir / "assets" / "img" / "app_icon.png"))
    res.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    return res


def _serve_web_subdir(subdir: str, filename: str):
    return send_from_directory(st.web_dir / subdir, filename)


@app.route("/assets/<path:filename>")
def serve_web_assets(filename):
    return _serve_web_subdir("assets", filename)


@app.route("/app/<path:filename>")
def serve_web_app(filename):
    return _serve_web_subdir("app", filename)


@app.route("/components/<path:filename>")
def serve_web_components(filename):
    return _serve_web_subdir("components", filename)


@app.route("/queries/<path:filename>")
def serve_web_queries(filename):
    return _serve_web_subdir("queries", filename)


@app.route("/state/<path:filename>")
def serve_web_state(filename):
    return _serve_web_subdir("state", filename)


@app.route("/storage/<path:filename>")
def serve_web_storage(filename):
    return _serve_web_subdir("storage", filename)


@app.route("/constants/<path:filename>")
def serve_web_constants(filename):
    return _serve_web_subdir("constants", filename)


@app.route("/core/<path:filename>")
def serve_web_core(filename):
    return _serve_web_subdir("core", filename)


@app.route("/adapters/<path:filename>")
def serve_web_adapters(filename):
    return _serve_web_subdir("adapters", filename)


@app.route("/static/<path:filename>")
def serve_legacy_static(filename):
    norm = filename.replace("\\", "/").lstrip("/")
    if norm.startswith("js/"):
        return send_from_directory(st.web_dir / "assets" / "vendor", norm[3:])
    if norm.startswith(("css/", "img/", "vendor/")):
        return send_from_directory(st.web_dir / "assets", norm)
    return send_from_directory(st.web_dir / "assets", norm)


def __getattr__(name: str):
    return getattr(st, name)


if __name__ == "__main__":
    from utils import lifecycle
    lifecycle.install()

    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "5000"))

    ssl_context = None
    use_https = os.getenv("USE_HTTPS", "false").lower() == "true"
    ssl_cert = os.getenv("SSL_CERT")
    ssl_key = os.getenv("SSL_KEY")

    if ssl_cert and ssl_key and os.path.exists(ssl_cert) and os.path.exists(ssl_key):
        ssl_context = (ssl_cert, ssl_key)
        print(f"[*] Starting server with SSL certificate: {ssl_cert}")
    elif use_https:
        try:
            import OpenSSL  # noqa: F401
            ssl_context = "adhoc"
            print("[*] Starting server with ad-hoc SSL certificate")
        except ImportError:
            print("[!] pyOpenSSL is not installed. To run with ad-hoc SSL, please run: pip install pyopenssl")
            print("[!] Falling back to HTTP...")

    if os.environ.get("OPEN_BROWSER", "").lower() == "true" and os.environ.get("WERKZEUG_RUN_MAIN") != "true":
        browser_host = host if host != "0.0.0.0" else "127.0.0.1"
        protocol = "https" if ssl_context else "http"
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
        reloader_type="stat",
        exclude_patterns=[
            "*.venv*",
            "*\\.venv\\*",
            "*\\site-packages\\*",
            "*AppData*",
            "*site-packages*",
            "*__pycache__*",
            "*.env",
            "active_program.txt",
            "*.txt",
            "*.db",
            "*.db-wal",
            "*.db-shm",
            "*.enc",
            "*.json",
        ],
    )
