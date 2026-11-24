import asyncio
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from adapters.history_adapters import OsHistoryAdapter  # noqa: E402
import runners.runner as runner_mod  # noqa: E402
from runners.runner import OpenSourceRunner  # noqa: E402


class _TestRunner(OpenSourceRunner):
    def __init__(self, tmp_dir: str):
        self._lock = threading.RLock()
        self._async_session_locks = {}
        self.sessions_history = {}
        self.sessions_program = {}
        self.sessions_inversion_state = {}
        self.sessions_memory_state = {}
        self.sessions_group_meta = {}
        self.generating_sessions = set()
        self._memory_pipeline_sessions = set()
        self.program_id = "sebile"
        self.tmp_dir = tmp_dir

    def _get_session_path(self, session_id: str, program_id: str = None) -> str:
        prog_dir = os.path.join(self.tmp_dir, "core", "programs", program_id or self.program_id)
        os.makedirs(os.path.join(prog_dir, "sessions"), exist_ok=True)
        card = os.path.join(prog_dir, f"{os.path.basename(prog_dir)}.json")
        if not os.path.exists(card):
            with open(card, "w", encoding="utf-8") as f:
                json.dump({"name": "Sebile"}, f)
        return os.path.join(prog_dir, "sessions", f"{session_id}.json")

    def _delete_local_image(self, image_url: str, program_id: str = None) -> bool:
        if not image_url or not image_url.startswith("/images/"):
            return False
        rel = image_url[len("/images/"):]
        target = os.path.join(self.tmp_dir, "core", "programs", program_id or self.program_id, rel)
        if os.path.isfile(target):
            os.remove(target)
            return True
        return False


class AttachmentDeletionTests(unittest.TestCase):
    def setUp(self):
        self._orig_read = runner_mod.read_session_data
        self._orig_write = runner_mod.write_session_data

        def _plain_read(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)

        def _plain_write(path, data):
            with open(path, "w", encoding="utf-8") as f:
                json.dump(data, f)

        runner_mod.read_session_data = _plain_read
        runner_mod.write_session_data = _plain_write

    def tearDown(self):
        runner_mod.read_session_data = self._orig_read
        runner_mod.write_session_data = self._orig_write

    def test_delete_user_attachment_removes_prefetch_and_tool_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s1"
            secret_payload = "SECRET_DELETED_SHARED_POST_CONTENT_12345"
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = [
                {"id": "first_mes_1", "role": "program", "text": "Hello."},
                {
                    "id": "usr_attach_1",
                    "role": "user",
                    "text": "[Shared webpage from Example (https://example.com/a)]\n" + secret_payload,
                    "shared_post": {"url": "https://example.com/a", "network": "web", "authorName": "Example"},
                },
                {
                    "id": "itm_attach_1",
                    "role": "program",
                    "text": "",
                    "tool_calls": [{"id": "c1", "type": "call", "name": "read_webpage", "args": {"url": "https://example.com/a"}}],
                },
                {
                    "id": "tool_attach_1",
                    "role": "user",
                    "text": "[Tool Response from read_webpage]: " + secret_payload + ("x" * 2000),
                },
                {"id": "prgm_reply_1", "role": "program", "text": "Sure, noted."},
                {"id": "usr_next_2", "role": "user", "text": "Next topic please."},
            ]

            deleted = asyncio.run(runner.delete_message_at(sid, "usr_attach_1"))
            self.assertTrue(deleted)

            remaining_ids = [m["id"] for m in runner.sessions_history[sid]]
            self.assertEqual(remaining_ids, ["first_mes_1", "prgm_reply_1", "usr_next_2"])

            adapter = OsHistoryAdapter(runner, sid, None, None, None)
            msgs = adapter.get_openai_messages("System prompt", "")
            non_system = json.dumps(msgs[1:])
            self.assertNotIn(secret_payload, non_system)
            self.assertNotIn("https://example.com/a", non_system)
            self.assertNotIn("[Tool Response from", non_system)

    def test_load_session_prunes_preexisting_orphan_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "default"
            session_path = runner._get_session_path(sid, "sebile")
            orphan_secret = "ORPHANED_TOOL_RESPONSE_SHOULD_NOT_SEND"
            with open(session_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "program_id": "sebile",
                        "messages": [
                            {"id": "prgm_0", "role": "program", "text": "Earlier reply."},
                            {
                                "id": "itm_orphan",
                                "role": "program",
                                "text": "",
                                "tool_calls": [{"id": "c1", "type": "call", "name": "read_webpage", "args": {"url": "https://x.test"}}],
                            },
                            {
                                "id": "tool_orphan",
                                "role": "user",
                                "text": "[Tool Response from read_webpage]: " + orphan_secret,
                            },
                            {"id": "usr_2", "role": "user", "text": "Fresh message."},
                        ],
                    },
                    f,
                )

            runner._load_session_from_disk(sid, "sebile")
            loaded_ids = [m["id"] for m in runner.sessions_history[sid]]
            self.assertEqual(loaded_ids, ["prgm_0", "usr_2"])

            with open(session_path, "r", encoding="utf-8") as f:
                persisted = json.load(f)
            self.assertEqual([m["id"] for m in persisted["messages"]], ["prgm_0", "usr_2"])

            adapter = OsHistoryAdapter(runner, sid, None, None, None)
            msgs = adapter.get_openai_messages("System prompt", "")
            self.assertNotIn(orphan_secret, json.dumps(msgs))

    def test_deleted_uploaded_image_leaves_no_stale_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "img_del"
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = [
                {"id": "first_mes_1", "role": "program", "text": "Ready."},
                {"id": "usr_img", "role": "user", "text": "Look at this", "image_url": "/images/uploads/gone.png"},
                {"id": "prgm_img", "role": "program", "text": "Saw it."},
                {"id": "usr_after", "role": "user", "text": "Moving on."},
            ]

            adapter = OsHistoryAdapter(runner, sid, None, None, None)
            msgs = adapter.get_openai_messages("System prompt", "")
            joined = json.dumps(msgs)
            self.assertNotIn("Could not locate image source", joined)
            self.assertNotIn("[Image Scan:", joined)

            self.assertTrue(asyncio.run(runner.delete_message_at(sid, "usr_img")))
            self.assertEqual([m["id"] for m in runner.sessions_history[sid]], ["first_mes_1", "prgm_img", "usr_after"])


if __name__ == "__main__":
    unittest.main()
