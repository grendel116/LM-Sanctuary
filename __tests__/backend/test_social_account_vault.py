"""Verify unconditionally available, encrypted storage for shared Sanctuary social accounts."""

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

from routes.social_accounts import social_accounts_bp
from utils import social_vault


def run_tests():
    original_data_dir = social_vault.DATA_DIR
    old_user = os.environ.get("AUTH_USER")
    old_pass = os.environ.get("AUTH_PASS")
    temp_dir = Path(tempfile.mkdtemp(prefix="social_vault_test_"))
    try:
        social_vault.DATA_DIR = temp_dir
        os.environ["AUTH_USER"] = "vault-user"
        os.environ["AUTH_PASS"] = "vault-password"
        app = Flask(__name__)
        app.register_blueprint(social_accounts_bp)
        client = app.test_client()

        assert client.get("/api/social/accounts").status_code == 200

        account_id = "bluesky:did:plc:alice"
        secret_token = "refresh_token_not_plaintext"
        record = {
            "meta": {"id": account_id, "platform": "bluesky", "handle": "alice.test"},
            "secrets": {"refreshJwt": secret_token},
        }
        saved = client.put(
            f"/api/social/accounts/{account_id}",
            json=record,
        )
        assert saved.status_code == 200, saved.get_data(as_text=True)
        assert saved.get_json()["meta"]["id"] == account_id

        raw_db = (temp_dir / "accounts.sqlite3").read_bytes()
        assert secret_token.encode("utf-8") not in raw_db
        assert b"alice.test" not in raw_db
        key_file = (temp_dir / "social_vault.key").read_bytes()
        assert key_file.startswith(b"DPAPI1:" if os.name == "nt" else b"RAW1:")
        loaded = client.get("/api/social/accounts")
        assert loaded.status_code == 200
        assert loaded.get_json()["accounts"][0]["secrets"]["refreshJwt"] == secret_token

        os.environ.pop("AUTH_USER", None)
        os.environ.pop("AUTH_PASS", None)
        assert client.get("/api/social/accounts").status_code == 200
        assert client.delete(f"/api/social/accounts/{account_id}").status_code == 204
        assert client.get("/api/social/accounts").get_json()["accounts"] == []
        print("SERVER_SOCIAL_ACCOUNT_VAULT_VERIFIED")
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
