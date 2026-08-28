"""
desktop.py — Standalone Desktop Native Window Launcher for LM-Sanctuary.
"""

import os
import sys
import time
import socket
import threading
import urllib.request
import webview

# Configure WebView2 arguments for audio/mic capabilities
os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = (
    "--use-fake-ui-for-media-stream "
    "--autoplay-policy=no-user-gesture-required "
    "--enable-features=SpeechRecognition,MediaStream "
    "--unsafely-treat-insecure-origin-as-secure=http://127.0.0.1:5000,http://localhost:5000"
)


def find_available_port(default_port: int = 5000) -> int:
    """Finds an available TCP port on localhost."""
    for port in range(default_port, default_port + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('127.0.0.1', port)) != 0:
                return port
    return default_port


def wait_for_server(url: str, timeout: float = 30.0) -> bool:
    """Waits until the server HTTP endpoint returns 200 OK."""
    import ssl
    ctx = ssl._create_unverified_context()
    start = time.time()
    while time.time() - start < timeout:
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "SanctuaryDesktop/1.0"})
            with urllib.request.urlopen(req, timeout=1.5, context=ctx) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.2)
    return False


def start_flask_server(port: int, ssl_context=None):
    """Imports and runs the Flask app across all network interfaces (LAN, Wi-Fi, Tailscale)."""
    import logging
    log = logging.getLogger('werkzeug')
    log.setLevel(logging.ERROR)
    from app import app
    app.run(host='0.0.0.0', port=port, ssl_context=ssl_context, debug=False, use_reloader=False, threaded=True)


def on_closed():
    """Immediately stops local server and exits process on window close."""
    try:
        from runners import local_server
        local_server.stop_local_server()
    except Exception:
        pass
    os._exit(0)


def main():
    if sys.platform == "win32":
        try:
            import ctypes
            ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("grendel.lm_sanctuary.desktop.1.0")
        except Exception:
            pass

    use_https = os.getenv('USE_HTTPS', 'false').lower() == 'true'
    ssl_cert = os.getenv('SSL_CERT', 'certs/cert.pem')
    ssl_key = os.getenv('SSL_KEY', 'certs/key.pem')
    ssl_context = None
    protocol = 'http'
    if use_https and os.path.exists(ssl_cert) and os.path.exists(ssl_key):
        ssl_context = (ssl_cert, ssl_key)
        protocol = 'https'

    port = find_available_port(5000)
    server_url = f"{protocol}://127.0.0.1:{port}"

    # Start Flask server thread
    server_thread = threading.Thread(target=start_flask_server, args=(port, ssl_context), daemon=True)
    server_thread.start()

    # Wait for server readiness
    if not wait_for_server(f"{server_url}/api/health", timeout=30.0):
        sys.exit(1)

    # Launch native desktop window
    window = webview.create_window(
        title="LM-Sanctuary",
        url=server_url,
        width=1320,
        height=880,
        min_size=(960, 640),
        background_color="#121214",
        text_select=True
    )

    window.events.closed += on_closed
    if sys.platform == "win32":
        webview.start(gui='edgechromium', debug=False)
    else:
        webview.start(debug=False)
    on_closed()


if __name__ == "__main__":
    main()
