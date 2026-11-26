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
from core.plan_state import (  # noqa: E402
    activate_plan,
    build_checkpoint_messages,
    extract_plan_steps,
    format_coding_state_block,
    has_active_plan,
    record_checkpoint,
    record_tool_ledger,
    select_checkpoint_span,
    stage_plan,
)
from core.transmission import TransmissionController  # noqa: E402
import runners.runner as runner_mod  # noqa: E402
from runners.runner import OpenSourceRunner  # noqa: E402
from tools import coding_tools  # noqa: E402
import tools.tools as tools_mod  # noqa: E402


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
        self._loaded_sessions = set()

    def _get_session_path(self, session_id: str, program_id: str = None) -> str:
        prog_dir = os.path.join(self.tmp_dir, "core", "programs", program_id or self.program_id)
        os.makedirs(os.path.join(prog_dir, "sessions"), exist_ok=True)
        card = os.path.join(prog_dir, f"{os.path.basename(prog_dir)}.json")
        if not os.path.exists(card):
            with open(card, "w", encoding="utf-8") as f:
                json.dump({"name": "Sebile"}, f)
        return os.path.join(prog_dir, "sessions", f"{session_id}.json")


class PlanPersistenceTests(unittest.TestCase):
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

    def test_extract_plan_steps_skips_generic_headings_and_supports_numbered_fallback(self):
        md = (
            "# Implementation Plan\n"
            "## Goal\nFix DMs.\n"
            "## Task 4: Fix Suggestion Search Bug\nDetails...\n"
            "## Task 1 & 2: Badges and Conversation Opening\nDetails...\n"
            "## Verification\nRun tests.\n"
        )
        steps = extract_plan_steps(md)
        self.assertEqual(
            [s["title"] for s in steps],
            ["Task 4: Fix Suggestion Search Bug", "Task 1 & 2: Badges and Conversation Opening"],
        )

        numbered = extract_plan_steps("## Goal\nClean up.\n1. First step\n2. Second step\n")
        self.assertEqual([s["title"] for s in numbered], ["First step", "Second step"])

    def test_active_plan_survives_history_trimming(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s1"
            runner._loaded_sessions.add(sid)
            runner.sessions_program[sid] = "sebile"
            plan_md = (
                "## Task 4: Fix Suggestion Search Bug\nFix handle fields.\n"
                "## Task 1 & 2: Badges and Conversation Opening\nAdd unread badge.\n"
            )
            meta = runner._get_memory_meta(sid)
            stage_plan(meta, plan_md)
            activate_plan(meta, meta["coding_state"]["staged_plan_markdown"])

            filler = []
            for i in range(80):
                filler.append({"id": f"u_{i}", "role": "user", "text": f"Turn {i} " + ("x" * 900)})
                filler.append({"id": f"p_{i}", "role": "program", "text": f"Reply {i} " + ("y" * 900)})
            filler.append({"id": "u_last", "role": "user", "text": "continue"})
            runner.sessions_history[sid] = filler

            msgs = OsHistoryAdapter(runner, sid, None, None, None).get_openai_messages("System", "", cloud_gear=True)
            joined = "\n".join(str(m.get("content") or "") for m in msgs)
            self.assertIn("# ACTIVE IMPLEMENTATION PLAN", joined)
            self.assertIn("Task 4: Fix Suggestion Search Bug", joined)
            self.assertIn("Task 1 & 2: Badges and Conversation Opening", joined)

    def test_update_plan_step_persists_to_disk_and_clears_on_completion(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s2"
            runner._loaded_sessions.add(sid)
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = [
                {"id": "first_mes_1", "role": "program", "text": "Ready."},
                {"id": "u_1", "role": "user", "text": "Proceed with the implementation plan above."},
            ]
            meta = runner._get_memory_meta(sid)
            activate_plan(meta, "## Step One\nDo A.\n## Step Two\nDo B.\n")

            r_tok = tools_mod.current_runner.set(runner)
            s_tok = tools_mod.current_session_id.set(sid)
            try:
                out1 = coding_tools.update_plan_step(1, "in_progress")
                self.assertIn("[~] Step One", out1)
                out2 = coding_tools.update_plan_step(1, "done", "Fixed handle lookup")
                self.assertIn("[x] Step One", out2)
                self.assertTrue(has_active_plan(meta))

                saved = json.loads(Path(runner._get_session_path(sid)).read_text(encoding="utf-8"))
                self.assertEqual(saved["memory_state"]["coding_state"]["steps"][0]["status"], "done")

                coding_tools.update_plan_step(2, "done", "Verified")
                self.assertFalse(has_active_plan(meta))
            finally:
                tools_mod.current_session_id.reset(s_tok)
                tools_mod.current_runner.reset(r_tok)

            msgs = OsHistoryAdapter(runner, sid, None, None, None).get_openai_messages("System", "", cloud_gear=True)
            joined = "\n".join(str(m.get("content") or "") for m in msgs)
            self.assertNotIn("# ACTIVE IMPLEMENTATION PLAN (Persisted Across Turns)", joined)

    def test_transmission_engages_write_tools_immediately_for_active_plan_continue(self):
        ctrl = TransmissionController(utterance="continue", has_active_plan=True)
        self.assertTrue(ctrl.coding_engaged)
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        names = {t["function"]["name"] for t in (decision.native_tools or [])}
        self.assertTrue({"edit_file", "run_command", "update_plan_step"}.issubset(names))

    def test_record_tool_ledger_deduplicates_and_caps_entries(self):
        meta = {}
        record_tool_ledger(meta, [("edit_file", {"path": "a.js"}, "Edited a.js (+1 -1 lines at L10).\n10: x")])
        record_tool_ledger(meta, [("edit_file", {"path": "a.js"}, "Edited a.js (+1 -1 lines at L10).\n10: x")])
        self.assertEqual(len(meta["coding_state"]["ledger"]), 1)

        for i in range(15):
            record_tool_ledger(
                meta,
                [("run_command", {"command": f"echo {i}"}, f"[Command succeeded (exit 0)]\n{i}")],
            )
        self.assertEqual(len(meta["coding_state"]["ledger"]), 12)
        block = format_coding_state_block(meta, include_ledger_only=True)
        self.assertIn("# RECENT WORK LEDGER", block)
        self.assertIn("echo 14", block)

    def test_select_checkpoint_span_and_prompt_builder(self):
        history = [
            {"id": "u_1", "role": "user", "text": "Fix X"},
            {"id": "itm_1", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "read_file", "args": {"path": "a.js"}}]},
            {"id": "tool_1", "role": "user", "text": "[Tool Response from read_file]:\n" + ("x" * 30000)},
            {"id": "itm_2", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "read_file", "args": {"path": "b.js"}}]},
            {"id": "tool_2", "role": "user", "text": "[Tool Response from read_file]:\n" + ("y" * 30000)},
            {"id": "itm_3", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "grep_search", "args": {"query": "foo"}}]},
            {"id": "tool_3", "role": "user", "text": "[Tool Response from grep_search]:\nok"},
        ]
        self.assertEqual(select_checkpoint_span(history, 100000), [1, 2, 3, 4])
        self.assertEqual(select_checkpoint_span(history, 200000), [])
        msgs = build_checkpoint_messages("Fix X", [history[i] for i in (1, 2, 3, 4)])
        self.assertIn("read_file(", msgs[1]["content"])
        self.assertIn("Task:\nFix X", msgs[1]["content"])

    def test_format_coding_state_block_includes_checkpoint_when_coding(self):
        meta = {}
        record_checkpoint(meta, "Goal: fix X")
        block = format_coding_state_block(meta, include_ledger_only=True)
        self.assertIn("# CODING PROGRESS CHECKPOINT", block)
        self.assertIn("Goal: fix X", block)
        self.assertEqual(format_coding_state_block(meta, include_ledger_only=False), "")

    def test_checkpoint_coding_progress_compacts_history_and_persists_meta(self):
        import asyncio
        from unittest import mock

        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s"
            runner._loaded_sessions.add(sid)
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = [
                {"id": "u_1", "role": "user", "text": "Fix X"},
                {"id": "itm_1", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "read_file", "args": {"path": "a.js"}}]},
                {"id": "tool_1", "role": "user", "text": "[Tool Response from read_file]:\n" + ("x" * 30000)},
                {"id": "itm_2", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "read_file", "args": {"path": "b.js"}}]},
                {"id": "tool_2", "role": "user", "text": "[Tool Response from read_file]:\n" + ("y" * 30000)},
                {"id": "itm_3", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "grep_search", "args": {"query": "foo"}}]},
                {"id": "tool_3", "role": "user", "text": "[Tool Response from grep_search]:\nok"},
            ]

            class _StubAdapter:
                CHARS_PER_TOKEN = 3.5

                def _get_max_input_tokens(self, in_tool_loop=False, cloud_gear=False):
                    return 20000

            with mock.patch("core.greenpt_client.chat_completion_step", return_value={"content": "Goal: fix X\nFindings: a.js:12", "tool_calls": []}):
                ok = asyncio.run(
                    runner._checkpoint_coding_progress(sid, _StubAdapter(), "Fix X", use_cloud=True, sensitive=False)
                )

            self.assertTrue(ok)
            hist = runner.sessions_history[sid]
            self.assertTrue(hist[1]["id"].startswith("tool_ckpt_"))
            self.assertIn("Findings: a.js:12", hist[1]["text"])
            for idx in (2, 3, 4, 5):
                self.assertTrue(hist[idx].get("compacted"))
            for idx in (6, 7):
                self.assertFalse(hist[idx].get("compacted"))
            self.assertTrue(runner._get_memory_meta(sid)["coding_state"]["checkpoint"].startswith("Goal"))


if __name__ == "__main__":
    unittest.main()
