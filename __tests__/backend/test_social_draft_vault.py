"""Verify encrypted, unauthenticated server-side draft synchronization."""

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

from routes.social_drafts import social_drafts_bp
from utils import social_vault


def run_tests():
    original_data_dir = social_vault.DATA_DIR
    old_user = os.environ.get("AUTH_USER")
    old_pass = os.environ.get("AUTH_PASS")
    temp_dir = Path(tempfile.mkdtemp(prefix="social_draft_vault_test_"))
    try:
        social_vault.DATA_DIR = temp_dir
        os.environ["AUTH_USER"] = "vault-user"
        os.environ["AUTH_PASS"] = "vault-password"
        app = Flask(__name__)
        app.register_blueprint(social_drafts_bp)
        client = app.test_client()

        assert client.get("/api/social/drafts").status_code == 200
        draft = {
            "id": "draft_shared_1",
            "text": "private draft text",
            "updatedAt": 123,
            "media": [{"dataUrl": "data:image/png;base64,cHJpdmF0ZS1tZWRpYQ=="}],
        }
        saved = client.put(f"/api/social/drafts/{draft['id']}", json={"draft": draft})
        assert saved.status_code == 200, saved.get_data(as_text=True)
        assert saved.get_json()["draft"]["text"] == draft["text"]

        raw_db = (temp_dir / "accounts.sqlite3").read_bytes()
        assert draft["text"].encode("utf-8") not in raw_db
        assert b"cHJpdmF0ZS1tZWRpYQ==" not in raw_db
        assert client.get("/api/social/drafts").get_json()["drafts"] == [draft]

        assert client.delete(f"/api/social/drafts/{draft['id']}").status_code == 204
        listing = client.get("/api/social/drafts").get_json()
        assert listing["drafts"] == []
        assert listing["deletedIds"] == [draft["id"]]
        stale_save = client.put(f"/api/social/drafts/{draft['id']}", json={"draft": draft})
        assert stale_save.status_code == 409
        assert client.put("/api/social/drafts/invalid", json={"draft": {}}).status_code == 400
        print("SERVER_SOCIAL_DRAFT_VAULT_VERIFIED")
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
