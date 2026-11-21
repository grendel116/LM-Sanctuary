"""Verify encrypted cross-post mappings persist and propagate deletions."""

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

from routes.social_linked_posts import social_linked_posts_bp
from utils import social_vault


def run_tests():
    original_data_dir = social_vault.DATA_DIR
    old_user = os.environ.get("AUTH_USER")
    old_pass = os.environ.get("AUTH_PASS")
    temp_dir = Path(tempfile.mkdtemp(prefix="social_linked_post_vault_test_"))
    try:
        social_vault.DATA_DIR = temp_dir
        os.environ["AUTH_USER"] = "vault-user"
        os.environ["AUTH_PASS"] = "vault-password"
        app = Flask(__name__)
        app.register_blueprint(social_linked_posts_bp)
        client = app.test_client()

        assert client.get("/api/social/linked-posts").status_code == 200
        record = {
            "canonicalId": "mastodon:12345",
            "mastodonStatusId": "12345",
            "mastodonInstance": "https://mastodon.social",
            "blueskyUri": "at://did:plc:user/app.bsky.feed.post/abc",
            "blueskyCid": "bafy-cid",
            "threadsPostId": "threads-post-id",
            "parentCanonicalId": "",
        }
        saved = client.put(
            "/api/social/linked-posts/mastodon%3A12345",
            json={"record": record},
        )
        assert saved.status_code == 200, saved.get_data(as_text=True)
        assert saved.get_json()["record"]["blueskyUri"] == record["blueskyUri"]

        raw_db = (temp_dir / "accounts.sqlite3").read_bytes()
        assert record["blueskyUri"].encode("utf-8") not in raw_db
        assert record["threadsPostId"].encode("utf-8") not in raw_db
        listing = client.get("/api/social/linked-posts").get_json()
        assert listing["records"][0]["canonicalId"] == record["canonicalId"]

        assert client.put(
            "/api/social/linked-posts/mastodon%3Amismatch",
            json={"record": record},
        ).status_code == 400
        assert client.delete("/api/social/linked-posts/mastodon%3A12345").status_code == 204
        listing = client.get("/api/social/linked-posts").get_json()
        assert listing["records"] == []
        assert listing["deletedIds"] == [record["canonicalId"]]
        assert client.put(
            "/api/social/linked-posts/mastodon%3A12345",
            json={"record": record},
        ).status_code == 409
        print("SERVER_SOCIAL_LINKED_POST_VAULT_VERIFIED")
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
