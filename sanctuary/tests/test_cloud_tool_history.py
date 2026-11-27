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


def _sample_history() -> list[dict]:
    return [
        {"id": "first_mes_1", "role": "program", "text": "Hello."},
        {"id": "usr_1", "role": "user", "text": "Swap the buttons."},
        {
            "id": "itm_1",
            "role": "program",
            "text": "",
            "tool_calls": [
                {"id": "c1", "type": "call", "name": "read_file", "args": {"path": "web/app/messages.js", "start_line": 1600}},
                {"id": "c1", "type": "response", "name": "read_file", "response": "ok"},
            ],
        },
        {"id": "tool_1", "role": "user", "text": "[Tool Response from read_file]:\n1600: const actions"},
        {"id": "prgm_1", "role": "program", "text": "Found it."},
        {"id": "usr_2", "role": "user", "text": "Great, go on."},
    ]


class CloudToolHistoryTests(unittest.TestCase):
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

    def test_cloud_history_has_no_call_syntax_in_assistant_content(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s1"
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = _sample_history()
            adapter = OsHistoryAdapter(runner, sid, None, None, None)
            msgs = adapter.get_openai_messages("System prompt", "", cloud_gear=True)

            assistant_contents = [str(m.get("content") or "") for m in msgs if m.get("role") == "assistant"]
            for content in assistant_contents:
                self.assertNotIn("Called ", content)
                self.assertNotIn("[read_file(", content)

            asst_tcs = [m for m in msgs if m.get("role") == "assistant" and m.get("tool_calls")]
            tool_msgs = [m for m in msgs if m.get("role") == "tool"]
            self.assertEqual(len(asst_tcs), 1)
            self.assertEqual(asst_tcs[0]["tool_calls"][0]["id"], "c1")
            self.assertEqual(len(tool_msgs), 1)
            self.assertEqual(tool_msgs[0]["tool_call_id"], "c1")
            self.assertEqual(tool_msgs[0]["content"], "1600: const actions")

    def test_local_history_keeps_bracket_tags(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s1"
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = _sample_history()
            adapter = OsHistoryAdapter(runner, sid, None, None, None)
            msgs = adapter.get_openai_messages("System prompt", "", cloud_gear=False)

            assistant_contents = [str(m.get("content") or "") for m in msgs if m.get("role") == "assistant"]
            self.assertTrue(
                any('[read_file(path="web/app/messages.js", start_line=1600)]' in c for c in assistant_contents)
            )


if __name__ == "__main__":
    unittest.main()
