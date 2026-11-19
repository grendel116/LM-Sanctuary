"""
desktop.py — Standalone Desktop Native Window Launcher for LM-Sanctuary.

The window and the Flask server live in separate processes. The server process loads the heavy
stack (torch, embeddings, runners); the window process stays light so the UI never freezes.
"""

import os
import sys
import time
import socket
import subprocess
import urllib.request
import webbrowser
from urllib.parse import urlparse

os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")

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
    log_file = open(os.path.join(LOGS_DIR, "flask_server.log"), "w", encoding="utf-8")
    args = [sys.executable, os.path.abspath(__file__), "--server", str(port)]
    if use_ssl:
        args.append("--ssl")
    proc = subprocess.Popen(
        args,
        cwd=BASE_DIR,
        stdout=log_file,
        stderr=subprocess.STDOUT,
        env={**os.environ, "PYTHONUNBUFFERED": "1", "KMP_DUPLICATE_LIB_OK": "TRUE"},
        creationflags=subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0,
    )
    return lifecycle.track(proc)


def _open_safe_external_url(raw_url: str) -> bool:
    url = str(raw_url or "").strip()
    if not url:
        return False
    try:
        scheme = urlparse(url).scheme.lower()
    except Exception:
        return False
    if scheme not in ("https", "http", "mailto"):
        return False
    try:
        return bool(webbrowser.open(url, new=2))
    except Exception:
        return False


class DesktopBridge:
    """JavaScript API exposed to pywebview for opening external URLs in the system browser."""

    def open_external(self, url: str) -> bool:
        return _open_safe_external_url(url)


def run_window():
    """Window process entry: shows the splash instantly, then loads the app once the server is ready."""
    import webview

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
        js_api=DesktopBridge(),
    )

    def load_app_when_ready():
        if wait_for_server(f"{server_url}/api/health", server_proc):
            window.load_url(server_url)
        else:
            window.load_html(ERROR_HTML)

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
                        uri = str(getattr(req_args, "Uri", "") or "")
                        if _open_safe_external_url(uri):
                            req_args.Handled = True

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
    webview.start(load_app_when_ready, gui=gui, debug=False, icon=APP_ICON_PATH)

    lifecycle.shutdown()
    # Children are stopped; exit immediately rather than waiting on lingering threads.
    os._exit(0)


if __name__ == "__main__":
    if "--server" in sys.argv:
        run_server(int(sys.argv[sys.argv.index("--server") + 1]), "--ssl" in sys.argv)
    else:
        run_window()
