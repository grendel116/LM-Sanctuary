"""Verification suite for in-process coding tools, automatic transmission gear-shifting, and 2-strike recovery."""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"
os.environ["OPENHANDS_SUPPRESS_BANNER"] = "1"
os.environ["OH_TELEMETRY_CONSENT"] = "false"
os.environ.pop("AUTH_USER", None)
os.environ.pop("AUTH_PASS", None)

import dotenv

dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from adapters.history_adapters import OsHistoryAdapter
from core import greenpt_client
from core.transmission import StrikeTracker, TransmissionController
from runners.runner import BaseProgramRunner, _has_prior_turn_tool_error
from tools import coding_tools, tools as tools_mod
from utils import utils as utils_mod


class TestInProcessCodingTools(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="sanctuary_code_"))
        (self.tmp / "app.js").write_bytes(b"const onPaste = (e) => {\r\n  return e;\r\n};\r\n")
        (self.tmp / "dup.py").write_text("x = 1\nx = 1\n", encoding="utf-8")
        (self.tmp / "sub").mkdir()
        (self.tmp / "sub" / "hello.txt").write_text("alpha\nbeta\ngamma\n", encoding="utf-8")

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_list_read_grep_edit_write_run_and_band_locks(self) -> None:
        with (
            mock.patch.object(tools_mod, "resolve_coding_workspace", return_value=(str(self.tmp), "", "")),
            mock.patch.object(tools_mod, "get_project_folders", return_value=[str(self.tmp)]),
            mock.patch.object(tools_mod, "confirm_tool_execution", return_value=True),
        ):
            listing = coding_tools.list_dir("")
            self.assertIn("sub/", listing)
            self.assertIn("app.js", listing)

            read_out = coding_tools.read_file("sub/hello.txt", start_line=2, end_line=3)
            self.assertIn("2: beta", read_out)
            self.assertIn("3: gamma", read_out)

            # Literal non-regex search with JS arrow syntax
            grep_out = coding_tools.grep_search("(e) => {")
            self.assertIn("app.js:1:", grep_out)

            # Ambiguous target returns helpful line numbers
            ambig = coding_tools.edit_file("dup.py", "x = 1", "x = 2")
            self.assertTrue(ambig.startswith("Error: Target block matched 2 locations"))
            self.assertIn("L1", ambig)
            self.assertIn("L2", ambig)

            # CRLF-preserving edit
            edited = coding_tools.edit_file("app.js", "  return e;", "  return e.clipboardData;")
            self.assertIn("Edited app.js", edited)
            raw_after = (self.tmp / "app.js").read_bytes()
            self.assertIn(b"\r\n", raw_after)
            self.assertIn(b"return e.clipboardData;", raw_after)

            # Write new file
            wrote = coding_tools.write_file("sub/created.py", "VAL = 42\n", overwrite=False)
            self.assertIn("Wrote sub/created.py", wrote)
            self.assertEqual((self.tmp / "sub" / "created.py").read_text(encoding="utf-8"), "VAL = 42\n")

            # Run command exit 0 and non-zero
            ok_cmd = coding_tools.run_command("python -c \"print('ok-42')\"")
            self.assertIn("[Command succeeded (exit 0)]", ok_cmd)
            self.assertIn("ok-42", ok_cmd)

            bad_cmd = coding_tools.run_command("exit 3")
            self.assertIn("Error: Command exited with code 3", bad_cmd)

            # Read-only band blocks edit_file without returning Error:
            tok = tools_mod.current_write_disengaged.set(True)
            try:
                blocked = coding_tools.edit_file("app.js", "return e.clipboardData;", "return null;")
                self.assertTrue(blocked.startswith("[Read-Only Band Active]"))
            finally:
                tools_mod.current_write_disengaged.reset(tok)

            # Path escape rejected
            esc = coding_tools.read_file("../outside.txt")
            self.assertIn("escapes workspace root", esc)

            # Missing replacement returns actionable Error instead of TypeError
            missing_repl = coding_tools.edit_file("app.js", "return e.clipboardData;")
            self.assertIn("Error: 'replacement' argument is required", missing_repl)

            # grep_search skips comfy_engine / vocab.json noise
            noise_dir = self.tmp / "comfy_engine"
            noise_dir.mkdir()
            (noise_dir / "vocab.json").write_text('{"paste": 1}', encoding="utf-8")
            (self.tmp / "sub" / "real.js").write_text("const paste = true;\n", encoding="utf-8")
            noise_grep = coding_tools.grep_search("paste")
            self.assertIn("sub/real.js", noise_grep)
            self.assertNotIn("vocab.json", noise_grep)


class TestTransmissionAndTwoStrikeRule(unittest.TestCase):
    def test_deep_plan_invariant_under_eco_flash(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="trans_cfg_"))
        try:
            ps = tmp / "project_settings.json"
            ps.write_text(
                json.dumps({
                    "greenpt_api_key": "sk-test",
                    "greenpt_base_url": "https://api.greenpt.ai/v1",
                    "routing_policy": "eco_flash",
                    "openhands_model": "glm-5.3",
                }),
                encoding="utf-8",
            )
            with mock.patch.object(greenpt_client, "_SETTINGS_PATH", str(ps)):
                self.assertEqual(greenpt_client.resolve_cloud_tier_model("fast"), "glm-5.3-flash")
                self.assertEqual(greenpt_client.resolve_cloud_tier_model("plan"), "glm-5.3")
                self.assertEqual(greenpt_client.resolve_cloud_tier_model("deep_plan"), "glm-5.3")
                self.assertEqual(greenpt_client.resolve_cloud_tier_model("deep_recovery"), "glm-5.3")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_gear_shifts_and_two_strike_lifecycle(self) -> None:
        # 1. Casual turn -> Park
        with mock.patch("core.transmission.score_utterance_pedals", return_value={"casual": 0.8, "coding_intent": 0.1}):
            casual_ctrl = TransmissionController(utterance="hey, how are you tonight?", routing_policy="eco_flash")
            d_park = casual_ctrl.shift(
                iteration=1, estimated_tokens=400, local_budget=4096, has_vision_attachment=False, cloud_available=True
            )
            self.assertEqual(d_park.gear, "park")

            # High token load upshifts out of Park
            d_load = casual_ctrl.shift(
                iteration=1, estimated_tokens=3200, local_budget=4096, has_vision_attachment=False, cloud_available=True
            )
            self.assertEqual(d_load.gear, "second")

        # 2. Coding turn under eco_flash: Planning is ALWAYS 2nd (deep_plan), cruising shifts to 1st (fast)
        with mock.patch("core.transmission.score_utterance_pedals", return_value={"coding_intent": 0.85, "casual": 0.1}):
            ctrl = TransmissionController(utterance="Fix the bug in app.js", routing_policy="eco_flash")
            d1 = ctrl.shift(iteration=1, estimated_tokens=1000, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertEqual(d1.gear, "second")
            self.assertEqual(d1.cloud_tier, "deep_plan")
            self.assertEqual(d1.phase, "planning")

            # Clean read -> workspace explored -> cruising shifts to 1st gear (fast)
            ctrl.record_tool_results([("read_file", {"path": "app.js"}, "[File: app.js]\n1: code")])
            d2 = ctrl.shift(iteration=2, estimated_tokens=1500, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertEqual(d2.gear, "first")
            self.assertEqual(d2.cloud_tier, "fast")

            # Strike 1 -> downshifts to 2nd (deep_recovery)
            ctrl.record_tool_results([("edit_file", {"path": "app.js"}, "Error: Target block not found in app.js.")])
            d3 = ctrl.shift(iteration=3, estimated_tokens=1700, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertEqual(d3.gear, "second")
            self.assertEqual(d3.cloud_tier, "deep_recovery")
            self.assertFalse(d3.write_disengaged)

            # Strike 2 -> engages write_disengaged=True + deep_plan replanning
            ctrl.record_tool_results([("edit_file", {"path": "app.js"}, "Error: Target block not found in app.js.")])
            d4 = ctrl.shift(iteration=4, estimated_tokens=1900, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertEqual(d4.gear, "second")
            self.assertEqual(d4.cloud_tier, "deep_plan")
            self.assertEqual(d4.phase, "replanning")
            self.assertTrue(d4.write_disengaged)
            self.assertFalse(d4.halt_tools)

            # Clean read clears replan_required and re-engages write band
            ctrl.record_tool_results([("read_file", {"path": "app.js"}, "[File: app.js]\n1: exact line")])
            d5 = ctrl.shift(iteration=5, estimated_tokens=2000, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertFalse(d5.write_disengaged)
            self.assertEqual(ctrl.strike_tracker.active_strikes, 0)

            # 2 more strikes -> halt_tools=True
            ctrl.record_tool_results([("run_command", {"command": "npm test"}, "Error: Command exited with code 1")])
            ctrl.record_tool_results([("run_command", {"command": "npm test"}, "Error: Command exited with code 1")])
            d6 = ctrl.shift(iteration=6, estimated_tokens=2100, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertTrue(d6.halt_tools)
            self.assertIsNone(d6.native_tools)

    def test_cloud_gear_history_budget_preserves_large_file_reads(self) -> None:
        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner.sessions_history = {
            "s1": [
                {"id": "usr_1", "role": "user", "text": "Inspect big file"},
                {"id": "itm_1", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "read_file", "args": {"path": "big.py"}}]},
                {"id": "tool_1", "role": "user", "text": "[Tool Response from read_file]:\n" + ("line\n" * 1200)},
                {"id": "itm_2", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "list_dir", "args": {"path": ""}}]},
                {"id": "tool_2", "role": "user", "text": "[Tool Response from list_dir]:\napp.py"},
            ]
        }
        runner._get_memory_meta = lambda sid: {"last_summarized_turn": 0}
        adapter = OsHistoryAdapter(runner, "s1", None, None, None)

        local_msgs = adapter.get_openai_messages("sys", "", cloud_gear=False)
        cloud_msgs = adapter.get_openai_messages("sys", "", cloud_gear=True)
        local_tool1 = next(m["content"] for m in local_msgs if "read_file]:" in str(m.get("content")))
        cloud_tool1 = next(m["content"] for m in cloud_msgs if "read_file]:" in str(m.get("content")))
        self.assertIn("Earlier tool output compacted", local_tool1)
        self.assertNotIn("Earlier tool output compacted", cloud_tool1)

        # cloud_gear=True emits non-tag `Called ...` summaries on itm_ turns so Cloud stays on native JSON tool_calls
        itm_summary = next(m["content"] for m in cloud_msgs if "Called read_file" in str(m.get("content")))
        self.assertNotIn("[read_file(", itm_summary)

    def test_xml_tool_call_extraction_truncation_and_prior_turn_recovery(self) -> None:
        # Complete GLM XML tool_call block is extracted cleanly
        raw_ok = (
            "I will update the CSS now."
            "<tool_call>edit_file<arg_key>path</arg_key><arg_value>web/assets/css/shell.css</arg_value>"
            "<arg_key>target</arg_key><arg_value>a</arg_value>"
            "<arg_key>replacement</arg_key><arg_value>b</arg_value></tool_call>"
        )
        clean_ok, tcs_ok, trunc_ok = greenpt_client._extract_xml_tool_calls(raw_ok)
        self.assertEqual(clean_ok, "I will update the CSS now.")
        self.assertFalse(trunc_ok)
        self.assertEqual(len(tcs_ok), 1)
        self.assertEqual(tcs_ok[0]["name"], "edit_file")
        self.assertEqual(tcs_ok[0]["args"]["replacement"], "b")

        # Unclosed truncated XML tool_call is stripped completely so tags never leak to chat
        raw_trunc = (
            "Let me give it a proper constrained style."
            "<tool_call>edit_file<arg_key>path</arg_key><arg_value>web/assets/css/shell.css</arg_value>"
            "<arg_key>target</arg_key><arg_value>#preview-area:not([hidden]) { align"
        )
        clean_tr, tcs_tr, trunc_tr = greenpt_client._extract_xml_tool_calls(raw_trunc)
        self.assertEqual(clean_tr, "Let me give it a proper constrained style.")
        self.assertEqual(tcs_tr, [])
        self.assertTrue(trunc_tr)

        # Prior turn that recovered from an intermediate error and gave a clean final reply is NOT sticky
        recovered_hist = [
            {"id": "usr_1", "role": "user", "text": "Fix paste"},
            {"id": "itm_1", "role": "program", "text": ""},
            {"id": "tool_1", "role": "user", "text": "[Tool Response from run_command]:\nError: Command exited with code 1"},
            {"id": "prgm_1", "role": "program", "text": "Fixed and verified."},
            {"id": "usr_2", "role": "user", "text": "Can you constrain the preview size?"},
        ]
        self.assertFalse(_has_prior_turn_tool_error(recovered_hist))

        # _extract_tool_calls recovers bracketed tag even when closing ')' before ']' is omitted
        malformed = '[edit_file(path="a.js", target="x", replacement="y"]'
        extracted = utils_mod._extract_tool_calls(malformed)
        self.assertEqual(len(extracted), 1)
        self.assertEqual(extracted[0].group(1), "edit_file")


class TestRunnerEndToEndNativeToolLoop(unittest.TestCase):
    def test_in_process_coding_loop_via_mock_cloud_v1(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="runner_e2e_"))
        target = tmp / "hello.py"
        target.write_text("GREETING = 'old'\n", encoding="utf-8")
        seen_payloads: list[dict] = []

        class MockCloudHandler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                return

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0") or "0")
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                seen_payloads.append(body)
                step = len(seen_payloads)
                if step == 1:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_1",
                            "type": "function",
                            "function": {"name": "read_file", "arguments": json.dumps({"path": "hello.py"})},
                        }],
                    }
                elif step == 2:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_2",
                            "type": "function",
                            "function": {
                                "name": "edit_file",
                                "arguments": json.dumps({
                                    "path": "hello.py",
                                    "target": "GREETING = 'old'",
                                    "replacement": "GREETING = 'new'",
                                }),
                            },
                        }],
                    }
                elif step == 3:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_3",
                            "type": "function",
                            "function": {
                                "name": "run_command",
                                "arguments": json.dumps({"command": "python -c \"import hello; assert hello.GREETING == 'new'\""}),
                            },
                        }],
                    }
                else:
                    msg = {"role": "assistant", "content": "Updated hello.py and verified GREETING == 'new'."}

                raw = json.dumps({
                    "id": f"cmpl-{step}",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body.get("model"),
                    "choices": [{"index": 0, "finish_reason": "stop", "message": msg}],
                }).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), MockCloudHandler)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        ps = tmp / "project_settings.json"
        ps.write_text(
            json.dumps({
                "greenpt_api_key": "sk-e2e",
                "greenpt_base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1",
                "routing_policy": "eco_flash",
                "openhands_model": "glm-5.3",
                "cloud_fast_model": "glm-5.3-flash",
            }),
            encoding="utf-8",
        )

        class StubAdapter:
            def __init__(self, runner_obj, sid):
                self.runner_obj = runner_obj
                self.session_id = sid
                self.matched_skill_records = []
                self.has_sensitive_context = False

            def _get_chat_budget(self):
                return 4096

            def get_latest_image_data_url(self):
                return ""

            def get_openai_messages(self, sys_inst, rag_context, memory_context="", turn_directive="", cloud_gear=False):
                msgs = [{"role": "system", "content": sys_inst}]
                for m in self.runner_obj.sessions_history[self.session_id]:
                    msgs.append({"role": "assistant" if m["role"] == "program" else "user", "content": m.get("text", "")})
                return msgs

            def append_assistant_message(self, text, tool_calls, invocation_id, intermediate=False, speaker_id=None):
                msg = {"id": f"{'itm' if intermediate else 'prgm'}_{len(self.runner_obj.sessions_history[self.session_id])}", "role": "program", "text": text, "tool_calls": tool_calls}
                self.runner_obj.sessions_history[self.session_id].append(msg)
                return msg

            def append_tool_events(self, results, invocation_id):
                for name, _, out in results:
                    self.runner_obj.sessions_history[self.session_id].append({
                        "id": f"tool_{len(self.runner_obj.sessions_history[self.session_id])}",
                        "role": "user",
                        "text": f"[Tool Response from {name}]:\n{out}",
                    })

        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner._lock = threading.RLock()
        runner.program_id = "sebile"
        runner.sessions_history = {"e2e": [{"id": "usr_1", "role": "user", "text": "Fix GREETING in hello.py"}]}
        runner.sessions_group_meta = {}
        runner._memory_pipeline_sessions = set()
        runner.trigger_memory_pipeline = lambda **kw: None
        runner._get_system_instructions = lambda sid, speaker_id=None: "You are Sebile."
        runner._get_memory_block = lambda sid: ""
        runner._get_turn_inversion_directive = lambda sid, inv: ""
        runner._load_temperature_setting = lambda: 0.2
        runner._sanitize_thinking_tags = lambda t: t or ""
        runner._filter_story_mode_matches = lambda m, t, sp: (m, t)
        runner._ensure_images_are_embedded = lambda t: t

        try:
            with (
                mock.patch.object(greenpt_client, "_SETTINGS_PATH", str(ps)),
                mock.patch.object(tools_mod, "resolve_coding_workspace", return_value=(str(tmp), "", "")),
                mock.patch.object(tools_mod, "get_project_folders", return_value=[str(tmp)]),
                mock.patch.object(tools_mod, "confirm_tool_execution", return_value=True),
                mock.patch("core.program_config.is_story_mode", return_value=False),
                mock.patch("core.transmission.score_utterance_pedals", return_value={"coding_intent": 0.9, "casual": 0.1}),
                mock.patch("core.banned_words.replace_banned_words_async", new=mock.AsyncMock(side_effect=lambda text, **kw: text)),
            ):
                adapter = StubAdapter(runner, "e2e")
                final_text, all_tcs, _ = asyncio.run(
                    runner._execute_local_llm_loop("e2e", adapter, "local-llm", "", "", "Fix GREETING in hello.py", "inv_1")
                )
                self.assertIn("Updated hello.py", final_text)
                self.assertEqual(target.read_text(encoding="utf-8"), "GREETING = 'new'\n")
                # Step 1 (Planning) used deep model glm-5.3 even under eco_flash; Step 2 (Cruising) shifted to glm-5.3-flash!
                self.assertEqual(seen_payloads[0]["model"], "glm-5.3")
                self.assertEqual(seen_payloads[1]["model"], "glm-5.3-flash")
                tool_names = [tc["name"] for tc in all_tcs if tc.get("type") == "call"]
                self.assertEqual(tool_names, ["read_file", "edit_file", "run_command"])
        finally:
            srv.shutdown()
            srv.server_close()
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
