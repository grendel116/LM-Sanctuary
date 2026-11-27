"""Verify encrypted browser bookmarks vault, Reader SSRF guard, open_in_browser tool, and license compliance."""

import os
from pathlib import Path
import shutil
import sys
import tempfile

from flask import Flask

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from routes.browser_vault import browser_vault_bp, fetch_reader_page, inspect_frame_headers
from routes.system import system_bp
import state as st
import tools.tools as tools
from utils import social_vault
from utils.url_privacy import strip_tracking_params
import variables.settings as vs


def run_tests():
    # 1. URL tracking-parameter stripping
    cleaned = strip_tracking_params("https://example.org/watch?v=123&utm_source=mastodon&fbclid=xyz#sec")
    assert cleaned == "https://example.org/watch?v=123#sec", cleaned

    # 2. Encrypted browser_bookmarks vault CRUD & deletion tombstones
    original_data_dir = social_vault.DATA_DIR
    old_user = os.environ.get("AUTH_USER")
    old_pass = os.environ.get("AUTH_PASS")
    temp_dir = Path(tempfile.mkdtemp(prefix="browser_vault_test_"))
    try:
        social_vault.DATA_DIR = temp_dir
        os.environ["AUTH_USER"] = "vault-user"
        os.environ["AUTH_PASS"] = "vault-password"
        app = Flask(__name__)
        app.register_blueprint(browser_vault_bp)
        client = app.test_client()

        assert client.get("/api/browser/bookmarks").status_code == 200
        bm = {
            "id": "bm_secret_1",
            "url": "https://private.example.org/docs?id=7",
            "title": "Confidential Docs",
            "folder": "Research",
            "createdAt": 100,
            "updatedAt": 101,
        }
        saved = client.put(f"/api/browser/bookmarks/{bm['id']}", json={"bookmark": bm})
        assert saved.status_code == 200, saved.get_data(as_text=True)
        assert saved.get_json()["bookmark"]["title"] == "Confidential Docs"

        raw_db = (temp_dir / "accounts.sqlite3").read_bytes()
        assert b"private.example.org" not in raw_db
        assert b"Confidential Docs" not in raw_db
        assert client.get("/api/browser/bookmarks").get_json()["bookmarks"] == [bm]

        assert client.delete(f"/api/browser/bookmarks/{bm['id']}").status_code == 204
        listing = client.get("/api/browser/bookmarks").get_json()
        assert listing["bookmarks"] == []
        assert listing["deletedIds"] == [bm["id"]]
        assert client.put(f"/api/browser/bookmarks/{bm['id']}", json={"bookmark": bm}).status_code == 409
        assert client.put("/api/browser/bookmarks/invalid", json={"bookmark": {"id": "invalid", "url": "javascript:alert(1)"}}).status_code == 400

        # 3. Framing header inspection & Reader Mode extraction + SSRF rejection on loopback/private hosts
        assert inspect_frame_headers({"X-Frame-Options": "DENY"}) == (False, "X-Frame-Options: DENY")
        assert inspect_frame_headers({"Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'"}) == (
            False,
            "Content-Security-Policy: frame-ancestors",
        )
        assert inspect_frame_headers({"Content-Type": "text/html"}) == (True, "")

        ssrf_res = client.post("/api/browser/reader", json={"url": "https://localhost/secret"})
        assert ssrf_res.status_code == 400
        ssrf_ip_res = client.post("/api/browser/reader", json={"url": "https://127.0.0.1/secret"})
        assert ssrf_ip_res.status_code == 400

        sample_html = """
        <html>
          <head><title>Open Source Commons</title><script>track();</script></head>
          <body>
            <nav>Menu</nav>
            <article>
              <h1>Open Source Commons</h1>
              <p>Read <a href="/guide?utm_source=feed&page=1">the guide</a> safely.</p>
            </article>
            <iframe src="https://tracker.invalid/ad"></iframe>
          </body>
        </html>
        """
        page = fetch_reader_page(
            "https://commons.example.org/article?fbclid=dropme",
            fetcher=lambda u: (sample_html, u),
        )
        assert page["url"] == "https://commons.example.org/article"
        assert page["title"] == "Open Source Commons"
        assert page["blockedCount"] == 2
        assert "https://commons.example.org/guide?page=1" in page["markdown"]
        assert "utm_source" not in page["markdown"]

        # 4. Shared project_settings partial POST preserves security_preset while saving browser_search_engine
        import base64
        import json
        original_vars_dir = vs.VARIABLES_DIR
        try:
            vs.VARIABLES_DIR = str(temp_dir)
            (temp_dir / "project_settings.json").write_text(
                json.dumps({"security_preset": "auto", "search_engine": "web_crawling"}),
                encoding="utf-8",
            )
            sys_app = Flask(__name__)
            sys_app.register_blueprint(system_bp)
            sys_client = sys_app.test_client()
            auth_hdr = {"Authorization": "Basic " + base64.b64encode(b"vault-user:vault-password").decode("ascii")}
            res_post = sys_client.post(
                "/api/project_settings",
                json={"browser_search_engine": "ecosia"},
                headers=auth_hdr,
            )
            assert res_post.status_code == 200, res_post.get_data(as_text=True)
            saved_cfg = res_post.get_json()["settings"]
            assert saved_cfg["security_preset"] == "auto"
            assert saved_cfg["browser_search_engine"] == "ecosia"
        finally:
            vs.VARIABLES_DIR = original_vars_dir

        # 5. open_in_browser tool emits client_action into session_tool_calls
        sess_id = "test_browser_tool_sess"
        tok = tools.current_session_id.set(sess_id)
        try:
            with tools.session_tool_calls_lock:
                tools.session_tool_calls[sess_id] = []
            msg = tools.open_in_browser("https://example.org/paper?utm_medium=ai", split=True)
            assert "https://example.org/paper" in msg
            with tools.session_tool_calls_lock:
                calls = list(tools.session_tool_calls.get(sess_id, []))
            assert len(calls) == 1
            assert calls[0]["client_action"] == {
                "type": "open_browser_tab",
                "url": "https://example.org/paper",
                "split": True,
            }
        finally:
            tools.current_session_id.reset(tok)

        # 5. License & trademark compliance checks
        assert (REPO_ROOT / "LICENSING.md").is_file()
        assert (REPO_ROOT / "LICENSES" / "GPL-3.0.txt").is_file()
        assert (REPO_ROOT / "LICENSES" / "MPL-2.0.txt").is_file()
        readme_text = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        assert "AGPL-3.0" in readme_text

        print("SERVER_BROWSER_VAULT_VERIFIED")
    finally:
        social_vault.DATA_DIR = original_data_dir
        if old_user is None:
            os.environ.pop("AUTH_USER", None)
        else:
            os.environ["AUTH_USER"] = old_user
        if old_pass is None:
            os.environ.pop("AUTH_PASS", None)
        else:
            os.environ["AUTH_PASS"] = old_pass
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
