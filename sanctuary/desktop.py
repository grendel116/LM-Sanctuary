"""
desktop.py — Standalone Desktop Native Window Launcher for LM-Sanctuary.

The window and the Flask server live in separate processes. The server process loads the heavy
stack (torch, embeddings, runners); the window process stays light so the UI never freezes.
"""

import importlib.util
import json
import os
import shutil
import sys
import threading
import time
import socket
import subprocess
import urllib.request
from urllib.parse import urlparse

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "8")
os.environ.setdefault("OMP_NUM_THREADS", "4")
os.environ.setdefault("MKL_NUM_THREADS", "4")
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.insert(0, BASE_DIR)
REPO_ROOT = os.path.dirname(BASE_DIR)

from utils import lifecycle

LOGS_DIR = os.path.join(BASE_DIR, "logs")
APP_ICON_PATH = os.path.join(REPO_ROOT, "web", "assets", "img", "app_icon.ico")
SPLASH_COLOR = "#121214"

# Configure WebView2 arguments for audio/mic capabilities
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
    "--use-fake-ui-for-media-stream "
    "--autoplay-policy=no-user-gesture-required "
    "--enable-features=MediaStream "
    "--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:5000,http://localhost:5000"
)

def read_splash_html() -> str:
    """Wraps the shared splash (templates/splash.html) as the window's first page."""
    with open(os.path.join(BASE_DIR, "templates", "splash.html"), encoding="utf-8") as f:
        splash = f.read()
    return (
        '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>LM-Sanctuary</title></head>'
        f'<body style="margin:0;background:{SPLASH_COLOR}">{splash}</body></html>'
    )


ERROR_HTML = """<html><body style="background:#121214;color:#f87171;font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;">
<p>The local server failed to start. Details are in logs/flask_server.log.</p></body></html>"""


def find_available_port(default_port: int = 5000) -> int:
    """Finds an available TCP port on localhost."""
    for port in range(default_port, default_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
    return default_port


def wait_for_server(url: str, server_proc: subprocess.Popen, timeout: float = 120.0) -> bool:
    """Waits until the server returns 200 OK. Returns False if the server process exits first."""
    import ssl
    ctx = ssl._create_unverified_context()
    deadline = time.time() + timeout
    while time.time() < deadline:
        if server_proc.poll() is not None:
            return False
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SanctuaryDesktop/1.0"})
            with urllib.request.urlopen(req, timeout=1.5, context=ctx) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def run_server(port: int, use_ssl: bool):
    """Server process entry: runs the Flask app across all network interfaces (LAN, Wi-Fi, Tailscale)."""
    lifecycle.install()
    import logging
    logging.getLogger('werkzeug').setLevel(logging.ERROR)
    from app import app
    # The index page imports these on first request; loading them up front means the server
    # reports healthy only once it can render the page, so the splash stays up until then.
    import core.program_config  # noqa: F401
    import core.mood_inversion  # noqa: F401
    default_cert = os.path.join(BASE_DIR, 'certs', 'cert.pem')
    default_key = os.path.join(BASE_DIR, 'certs', 'key.pem')
    ssl_context = (os.getenv('SSL_CERT', default_cert), os.getenv('SSL_KEY', default_key)) if use_ssl else None
    app.run(host='0.0.0.0', port=port, ssl_context=ssl_context, debug=False, use_reloader=False, threaded=True)


def start_server_process(port: int, use_ssl: bool) -> subprocess.Popen:
    """Launches the server in its own process, with its output captured in logs/flask_server.log."""
    os.makedirs(LOGS_DIR, exist_ok=True)
    log_path = os.path.join(LOGS_DIR, "flask_server.log")
    log_file = open(log_path, "a", encoding="utf-8")
    log_file.write(f"\n=== Sanctuary Server starting on port {port} at {time.strftime('%Y-%m-%d %H:%M:%S')} ===\n")
    log_file.flush()
    args = [sys.executable, os.path.abspath(__file__), "--server", str(port)]
    if use_ssl:
        args.append("--ssl")
    try:
        proc = subprocess.Popen(
            args,
            cwd=BASE_DIR,
            stdout=log_file,
            stderr=subprocess.STDOUT,
            env={
                **os.environ,
                "PYTHONUNBUFFERED": "1",
                "KMP_DUPLICATE_LIB_OK": "TRUE",
                "OPENBLAS_NUM_THREADS": "8",
                "OMP_NUM_THREADS": "4",
                "MKL_NUM_THREADS": "4",
                "TOKENIZERS_PARALLELISM": "false",
            },
            creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
        )
    finally:
        log_file.close()
    return lifecycle.track(proc)


def find_gecko_binary(repo_root: str = REPO_ROOT) -> str | None:
    """Locate a compiled or packaged Sanctuary Browser Gecko binary when available."""
    override = str(os.getenv("SANCTUARY_GECKO_BIN") or "").strip()
    if override and os.path.isfile(override):
        return os.path.normpath(override)

    primary_exe = "sanctuary-browser.exe" if sys.platform == "win32" else "sanctuary-browser"
    exe_name = "lm-sanctuary.exe" if sys.platform == "win32" else "lm-sanctuary"
    fallback_exe = "firefox.exe" if sys.platform == "win32" else "firefox"
    candidates = [
        os.path.join(repo_root, "gecko", primary_exe),
        os.path.join(repo_root, "browser-desktop", "dist", "lm-sanctuary", primary_exe),
        os.path.join(repo_root, "gecko", exe_name),
        os.path.join(repo_root, "browser-desktop", "dist", "lm-sanctuary", exe_name),
        os.path.join(repo_root, "browser-desktop", "build", "firefox", "objdir-sanctuary-gecko", "dist", "bin", exe_name),
        os.path.join(repo_root, "browser-desktop", "build", "firefox", "objdir-sanctuary-artifact", "dist", "bin", exe_name),
        os.path.join(repo_root, "browser-desktop", "dist", "lm-sanctuary", fallback_exe),
        os.path.join(repo_root, "browser-desktop", "build", "firefox", "objdir-sanctuary-artifact", "dist", "bin", fallback_exe),
    ]
    for path in candidates:
        if os.path.isfile(path):
            return os.path.normpath(path)
    return None


def prepare_gecko_profile(profile_dir: str, server_url: str) -> str:
    """Create the Gecko profile directory and write user.js binding shellUrl & offline privacy defaults."""
    os.makedirs(profile_dir, exist_ok=True)
    # Artifact builds reuse AppBuildID, so purge Gecko's compiled bytecode cache before launch.
    shutil.rmtree(os.path.join(profile_dir, "startupCache"), ignore_errors=True)
    user_js_path = os.path.join(profile_dir, "user.js")
    lines = [
        "// Generated by sanctuary/desktop.py",
        f'user_pref("browser.sanctuary.shellUrl", {json.dumps(str(server_url))});',
        f'user_pref("browser.startup.homepage", {json.dumps(str(server_url))});',
        'user_pref("browser.startup.page", 1);',
        'user_pref("browser.sessionstore.resume_from_crash", false);',
        'user_pref("browser.tabs.inTitlebar", 0);',
        'user_pref("signon.rememberSignons", false);',
        'user_pref("signon.autofillForms", false);',
        'user_pref("signon.generation.enabled", false);',
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.healthreport.uploadEnabled", false);',
        'user_pref("toolkit.legacyUserProfileCustomizations.windowIcon", true);',
        'user_pref("media.videocontrols.picture-in-picture.video-toggle.enabled", false);',
        'user_pref("print.prefer_system_dialog", true);',
        'user_pref("browser.ml.enable", false);',
        'user_pref("browser.ml.chat.enabled", false);',
        'user_pref("browser.ml.chat.menu", false);',
        'user_pref("browser.ml.chat.page", false);',
        'user_pref("identity.fxaccounts.enabled", false);',
        'user_pref("extensions.pocket.enabled", false);',
        'user_pref("browser.tabs.firefox-view", false);',
        'user_pref("browser.formfill.enable", false);',
    ]
    with open(user_js_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    if os.path.isfile(APP_ICON_PATH):
        icon_dir = os.path.join(profile_dir, "chrome", "icons", "default")
        os.makedirs(icon_dir, exist_ok=True)
        for ico_name in ("main-window.ico", "default.ico"):
            shutil.copy2(APP_ICON_PATH, os.path.join(icon_dir, ico_name))
    return user_js_path


def run_gecko_window(
    gecko_bin: str,
    server_url: str,
    server_proc: subprocess.Popen,
    port: int | None = None,
    use_ssl: bool | None = None,
) -> int:
    """Launch compiled LM-Sanctuary Gecko host alongside the Flask AI node."""
    parsed = urlparse(server_url)
    resolved_port = port if port is not None else (parsed.port or 5000)
    resolved_ssl = use_ssl if use_ssl is not None else (parsed.scheme == "https")
    profile_dir = os.path.join(REPO_ROOT, "gecko_profile")
    prepare_gecko_profile(profile_dir, server_url)

    if not wait_for_server(f"{server_url}/api/health", server_proc):
        lifecycle.shutdown()
        return 1

    kwargs: dict = {"cwd": REPO_ROOT, "creationflags": 0}
    if sys.platform == "win32":
        # Explicitly set SW_SHOWNORMAL so lifecycle's pythonw Popen wrapper never injects SW_HIDE.
        si = subprocess.STARTUPINFO()
        si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        si.wShowWindow = 1
        kwargs["startupinfo"] = si

    cmd = [gecko_bin, "--profile", profile_dir, "--no-remote", "--purgecaches"]
    if sys.platform == "win32":
        cmd.append("--wait-for-browser")
    cmd.append(server_url)
    proc = subprocess.Popen(cmd, **kwargs)
    lifecycle.track(proc)
    while proc.poll() is None:
        if server_proc.poll() is not None:
            server_proc = start_server_process(resolved_port, resolved_ssl)
            wait_for_server(f"{server_url}/api/health", server_proc, timeout=30.0)
        time.sleep(1.0)
    ret = proc.returncode
    lifecycle.shutdown()
    return int(ret or 0)


def run_window():
    """Window process entry: launches native Gecko host when built, or falls back to pywebview."""
    lifecycle.install()

    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("grendel.lm_sanctuary.desktop.1.0")
        except Exception:
            pass

    ssl_cert = os.getenv('SSL_CERT', os.path.join(BASE_DIR, 'certs', 'cert.pem'))
    ssl_key = os.getenv('SSL_KEY', os.path.join(BASE_DIR, 'certs', 'key.pem'))
    use_ssl = os.getenv('USE_HTTPS', 'false').lower() == 'true' and os.path.exists(ssl_cert) and os.path.exists(ssl_key)
    protocol = 'https' if use_ssl else 'http'

    port = find_available_port(5000)
    server_url = f"{protocol}://127.0.0.1:{port}"
    server_proc = start_server_process(port, use_ssl)

    if "--webview" not in sys.argv:
        gecko_bin = find_gecko_binary()
        if gecko_bin:
            code = run_gecko_window(gecko_bin, server_url, server_proc, port=port, use_ssl=use_ssl)
            os._exit(code)

    import webview

    try:
        webview.settings['ALLOW_DOWNLOADS'] = True
    except Exception:
        pass

    window = webview.create_window(
        title="LM-Sanctuary",
        html=read_splash_html(),
        width=1320,
        height=880,
        min_size=(960, 640),
        background_color=SPLASH_COLOR,
        text_select=True,
    )

    stop_watchdog = threading.Event()
    server_booted = threading.Event()

    def load_app_when_ready():
        if wait_for_server(f"{server_url}/api/health", server_proc):
            server_booted.set()
            window.load_url(server_url)
        else:
            window.load_html(ERROR_HTML)

    def _watch_server_for_webview():
        nonlocal server_proc
        server_booted.wait()
        while not stop_watchdog.is_set():
            if server_proc.poll() is not None:
                server_proc = start_server_process(port, use_ssl)
                wait_for_server(f"{server_url}/api/health", server_proc, timeout=30.0)
            stop_watchdog.wait(1.5)

    threading.Thread(target=_watch_server_for_webview, daemon=True, name="sanctuary-server-watchdog").start()

    def on_before_show():
        # Runs on the GUI thread before the first paint. The WebView2 control paints the default
        # WinForms gray until the Edge runtime starts, so give it the splash color from frame one.
        if sys.platform == "win32":
            from System.Drawing import ColorTranslator
            window.native.webview.BackColor = ColorTranslator.FromHtml(SPLASH_COLOR)

    window.events.before_show += on_before_show

    def on_shown():
        if sys.platform == "win32" and getattr(window, "native", None) and getattr(window.native, "webview", None):
            webview_ctrl = window.native.webview

            def on_key_down(sender, args):
                if args.Control and args.Shift and not args.Alt and int(args.KeyCode) == 82:  # Keys.R
                    args.Handled = True
                    if sender.CoreWebView2:
                        sender.CoreWebView2.CallDevToolsProtocolMethodAsync("Page.reload", '{"ignoreCache": true}')
                    else:
                        sender.Reload()

            webview_ctrl.KeyDown += on_key_down

            def _attach_new_window(core):
                if not core:
                    return
                try:
                    def on_new_window(_sender, req_args):
                        uri = str(getattr(req_args, "Uri", "") or "").strip()
                        try:
                            scheme = urlparse(uri).scheme.lower()
                        except Exception:
                            scheme = ""
                        if scheme in ("http", "https"):
                            req_args.Handled = True
                            try:
                                window.evaluate_js(
                                    f"window.__sanctuaryOpenInBrowser && window.__sanctuaryOpenInBrowser({json.dumps(uri)})"
                                )
                            except Exception:
                                pass

                    core.NewWindowRequested += on_new_window
                except Exception:
                    pass

            try:
                if getattr(webview_ctrl, "CoreWebView2", None):
                    _attach_new_window(webview_ctrl.CoreWebView2)
                else:
                    def on_core_init(sender, _ev):
                        _attach_new_window(getattr(sender, "CoreWebView2", None))

                    webview_ctrl.CoreWebView2InitializationCompleted += on_core_init
            except Exception:
                pass

    window.events.shown += on_shown

    # The icon sets both the title bar and the taskbar button. Blocks until the window closes.
    gui = 'edgechromium' if sys.platform == "win32" else None
    webview.start(
        load_app_when_ready,
        gui=gui,
        debug=False,
        icon=APP_ICON_PATH,
        private_mode=False,
        storage_path=os.path.join(REPO_ROOT, "webview_data"),
    )

    stop_watchdog.set()
    lifecycle.shutdown()
    # Children are stopped; exit immediately rather than waiting on lingering threads.
    os._exit(0)


if __name__ == "__main__":
    if "--server" in sys.argv:
        run_server(int(sys.argv[sys.argv.index("--server") + 1]), "--ssl" in sys.argv)
    else:
        run_window()
