"""Verify encrypted conversation-session storage and legacy JSON migration."""

import json
from pathlib import Path
import shutil
import sys
import tempfile

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from utils import social_vault
from utils.session_data import read_session_data, write_session_data


def run_tests():
    original_data_dir = social_vault.DATA_DIR
    temp_dir = Path(tempfile.mkdtemp(prefix="session_data_test_"))
    try:
        social_vault.DATA_DIR = temp_dir / "social_data"
        session_path = temp_dir / "program" / "sessions" / "default.json"
        session_path.parent.mkdir(parents=True)
        private_text = "A private conversation message"
        legacy_data = {"messages": [{"role": "user", "text": private_text}]}
        session_path.write_text(json.dumps(legacy_data), encoding="utf-8")

        assert read_session_data(session_path) == legacy_data
        encrypted = session_path.read_bytes()
        assert encrypted.startswith(b"LM_SANCTUARY_SESSION_V1\n")
        assert private_text.encode("utf-8") not in encrypted
        assert read_session_data(session_path) == legacy_data

        updated = {"messages": [{"role": "user", "text": "Updated private message"}]}
        write_session_data(session_path, updated)
        assert read_session_data(session_path) == updated
        assert b"Updated private message" not in session_path.read_bytes()
        print("SESSION_DATA_ENCRYPTION_VERIFIED")
    finally:
        social_vault.DATA_DIR = original_data_dir
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
