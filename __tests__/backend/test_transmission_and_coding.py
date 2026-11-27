"""Verification suite for TransmissionController gear-shifting, cloud tool history, and in-process OpenHands coding."""

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
from core import openhands_harness, v1_client
from core.transmission import TransmissionController
from runners.runner import BaseProgramRunner, _has_prior_turn_tool_error
from tools import tools as tools_mod
from utils import utils as utils_mod


class TestTransmissionAndCloudHistory(unittest.TestCase):
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
            with mock.patch.object(v1_client, "_SETTINGS_PATH", str(ps)):
                self.assertEqual(v1_client.resolve_v1_tier_model("fast"), "glm-5.3-flash")
                self.assertEqual(v1_client.resolve_v1_tier_model("plan"), "glm-5.3")
                self.assertEqual(v1_client.resolve_v1_tier_model("deep_plan"), "glm-5.3")
                self.assertEqual(v1_client.resolve_v1_tier_model("deep_recovery"), "glm-5.3")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_gear_shifts_route_coding_to_openhands_and_casual_to_park(self) -> None:
        with mock.patch("core.transmission.score_utterance_pedals", return_value={"casual": 0.8, "coding_intent": 0.1}):
            casual_ctrl = TransmissionController(utterance="hey, how are you tonight?", routing_policy="eco_flash")
            d_park = casual_ctrl.shift(
                iteration=1, estimated_tokens=400, local_budget=4096, has_vision_attachment=False, cloud_available=True
            )
            self.assertEqual(d_park.gear, "park")

            d_load = casual_ctrl.shift(
                iteration=1, estimated_tokens=3200, local_budget=4096, has_vision_attachment=False, cloud_available=True
            )
            self.assertEqual(d_load.gear, "second")
            self.assertTrue(any(t["function"]["name"] == "web_search" for t in (d_load.native_tools or [])))

        with mock.patch("core.transmission.score_utterance_pedals", return_value={"coding_intent": 0.85, "casual": 0.1}):
            ctrl = TransmissionController(utterance="Fix the bug in app.js", routing_policy="eco_flash")
            d_code = ctrl.shift(iteration=1, estimated_tokens=1000, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertEqual(d_code.gear, "openhands")
            self.assertEqual(d_code.phase, "coding")
            self.assertEqual(d_code.cloud_tier, "fast")
            self.assertFalse(d_code.write_disengaged)

            plan_ctrl = TransmissionController(utterance="/plan Fix the bug in app.js", is_plan_turn=True)
            d_plan = plan_ctrl.shift(iteration=1, estimated_tokens=1000, local_budget=4096, has_vision_attachment=False, cloud_available=True)
            self.assertEqual(d_plan.gear, "openhands")
            self.assertEqual(d_plan.phase, "planning")
            self.assertEqual(d_plan.cloud_tier, "deep_plan")
            self.assertTrue(d_plan.write_disengaged)

    def test_cloud_gear_history_budget_preserves_large_file_reads(self) -> None:
        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner.generating_sessions = {"s1"}
        runner.sessions_history = {
            "s1": [
                {"id": "usr_1", "role": "user", "text": "Inspect big file"},
                {"id": "itm_1", "role": "program", "text": "", "tool_calls": [{"id": "call_1", "type": "call", "name": "read_file", "args": {"path": "big.py"}}]},
                {"id": "tool_1", "role": "user", "text": "[Tool Response from read_file]:\n" + ("line\n" * 1200)},
                {"id": "itm_2", "role": "program", "text": "", "tool_calls": [{"id": "call_2", "type": "call", "name": "list_dir", "args": {"path": ""}}]},
                {"id": "tool_2", "role": "user", "text": "[Tool Response from list_dir]:\napp.py"},
            ]
        }
        runner._get_memory_meta = lambda sid: {"last_summarized_turn": 0}
        adapter = OsHistoryAdapter(runner, "s1", None, None, None)

        local_msgs = adapter.get_openai_messages("sys", "", cloud_gear=False)
        cloud_msgs = adapter.get_openai_messages("sys", "", cloud_gear=True)
        local_tool1 = next(m["content"] for m in local_msgs if "read_file]:" in str(m.get("content")))
        self.assertIn("Earlier tool output compacted", local_tool1)

        asst_tcs = [m for m in cloud_msgs if m.get("role") == "assistant" and m.get("tool_calls")]
        tool_msgs = [m for m in cloud_msgs if m.get("role") == "tool"]
        self.assertEqual(len(asst_tcs), 2)
        self.assertEqual(len(tool_msgs), 2)
        self.assertEqual(asst_tcs[0]["tool_calls"][0]["id"], "call_1")
        self.assertEqual(tool_msgs[0]["tool_call_id"], "call_1")
        self.assertNotIn("Earlier tool output compacted", tool_msgs[0]["content"])
        self.assertEqual(tool_msgs[1]["tool_call_id"], "call_2")
        self.assertEqual(tool_msgs[1]["content"], "app.py")

    def test_turn_directive_updates_across_iterations_without_stale_cache(self) -> None:
        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner.sessions_history = {"s_dir": [{"id": "usr_1", "role": "user", "text": "Fix the bug"}]}
        runner._get_memory_meta = lambda sid: {"last_summarized_turn": 0}
        adapter = OsHistoryAdapter(runner, "s_dir", None, None, None)

        msgs_a = adapter.get_openai_messages("sys", "", turn_directive="DIRECTIVE-A", cloud_gear=True)
        msgs_b = adapter.get_openai_messages("sys", "", turn_directive="DIRECTIVE-B", cloud_gear=True)
        last_user_b = next(m["content"] for m in reversed(msgs_b) if m.get("role") == "user")
        self.assertIn("DIRECTIVE-B", str(last_user_b))
        self.assertNotIn("DIRECTIVE-A", str(last_user_b))
        self.assertIn("DIRECTIVE-A", str(msgs_a[-1]["content"]))

    def test_xml_tool_call_extraction_truncation_and_prior_turn_recovery(self) -> None:
        raw_ok = (
            "I will update the CSS now."
            "<tool_call>edit_file<arg_key>path</arg_key><arg_value>web/assets/css/shell.css</arg_value>"
            "<arg_key>target</arg_key><arg_value>a</arg_value>"
            "<arg_key>replacement</arg_key><arg_value>b</arg_value></tool_call>"
        )
        clean_ok, tcs_ok, trunc_ok = v1_client._extract_xml_tool_calls(raw_ok)
        self.assertEqual(clean_ok, "I will update the CSS now.")
        self.assertFalse(trunc_ok)
        self.assertEqual(len(tcs_ok), 1)

        recovered_hist = [
            {"id": "usr_1", "role": "user", "text": "Fix paste"},
            {"id": "itm_1", "role": "program", "text": ""},
            {"id": "tool_1", "role": "user", "text": "[Tool Response from run_command]:\nError: Command exited with code 1"},
            {"id": "prgm_1", "role": "program", "text": "Fixed and verified."},
            {"id": "usr_2", "role": "user", "text": "Can you constrain the preview size?"},
        ]
        self.assertFalse(_has_prior_turn_tool_error(recovered_hist))

        malformed = '[edit_file(path="a.js", target="x", replacement="y"]'
        extracted = utils_mod._extract_tool_calls(malformed)
        self.assertEqual(len(extracted), 1)
        self.assertEqual(extracted[0].group(1), "edit_file")


class TestRunnerEndToEndInProcessOpenHands(unittest.TestCase):
    def test_in_process_openhands_coding_loop_via_mock_v1(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="runner_oh_e2e_"))
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
                            "function": {
                                "name": "file_editor",
                                "arguments": json.dumps({"command": "view", "path": str(target)}),
                            },
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
                                "name": "file_editor",
                                "arguments": json.dumps({
                                    "command": "str_replace",
                                    "path": str(target),
                                    "old_str": "GREETING = 'old'",
                                    "new_str": "GREETING = 'new'",
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
                                "name": "terminal",
                                "arguments": json.dumps({"command": "python -c \"import hello; assert hello.GREETING == 'new'\""}),
                            },
                        }],
                    }
                else:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_4",
                            "type": "function",
                            "function": {
                                "name": "finish",
                                "arguments": json.dumps({"message": "Updated hello.py and verified GREETING == 'new'."}),
                            },
                        }],
                    }

                raw = json.dumps({
                    "id": f"cmpl-{step}",
                    "object": "chat.completion",
                    "created": 1,
                    "model": body.get("model"),
                    "choices": [{"index": 0, "finish_reason": "tool_calls", "message": msg}],
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
                "routing_policy": "auto",
                "openhands_model": "glm-5.3",
                "security_preset": "auto",
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

            def estimate_turn_tokens(self):
                return 200

            def get_latest_image_data_url(self):
                return ""

            def get_openai_messages(self, sys_inst, rag_context, memory_context="", turn_directive="", cloud_gear=False):
                return [{"role": "system", "content": sys_inst}, {"role": "user", "content": "Fix GREETING in hello.py"}]

            def append_assistant_message(self, text, tool_calls, invocation_id, intermediate=False, speaker_id=None):
                msg = {"id": f"{'itm' if intermediate else 'prgm'}_{len(self.runner_obj.sessions_history[self.session_id])}", "role": "program", "text": text, "tool_calls": tool_calls}
                self.runner_obj.sessions_history[self.session_id].append(msg)
                return msg

        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner._lock = threading.RLock()
        runner.program_id = "sebile"
        runner.sessions_history = {"e2e": [{"id": "usr_1", "role": "user", "text": "Fix GREETING in hello.py"}]}
        runner.sessions_group_meta = {}
        runner.sessions_memory_state = {}
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
                mock.patch.object(v1_client, "_SETTINGS_PATH", str(ps)),
                mock.patch.object(openhands_harness, "_PROJECT_SETTINGS_PATH", str(ps)),
                mock.patch.object(tools_mod, "resolve_coding_workspace", return_value=(str(tmp), "", "")),
                mock.patch.object(tools_mod, "get_project_folders", return_value=[str(tmp)]),
                mock.patch("core.program_config.is_story_mode", return_value=False),
                mock.patch("core.transmission.score_utterance_pedals", return_value={"coding_intent": 0.9, "casual": 0.1}),
                mock.patch("core.banned_words.replace_banned_words_async", new=mock.AsyncMock(side_effect=lambda text, **kw: text)),
            ):
                adapter = StubAdapter(runner, "e2e")
                final_text, all_tcs, _ = asyncio.run(
                    runner._execute_local_llm_loop(
                        "e2e",
                        adapter,
                        "llm/Gemma-4-31B-Abliterated-Uncensored.i1-Q4_K_M.gguf",
                        "",
                        "",
                        "Fix GREETING in hello.py",
                        "inv_1",
                    )
                )
                self.assertIn("Updated hello.py", final_text)
                self.assertEqual(target.read_text(encoding="utf-8"), "GREETING = 'new'\n")
                self.assertEqual(openhands_harness.GitBashTerminalTool.name, "terminal")
                self.assertEqual(seen_payloads[0]["model"], "glm-5.3")
                self.assertEqual(seen_payloads[0].get("reasoning_effort"), "medium")
                tool_names = [tc["name"] for tc in all_tcs if tc.get("type") == "call"]
                self.assertEqual(tool_names, ["file_editor", "file_editor", "terminal", "finish"])
                term_resp = next(tc["response"] for tc in all_tcs if tc.get("type") == "response" and tc.get("name") == "terminal")
                self.assertNotIn("not found", term_resp.lower())
                user_msgs = [str(m.get("content") or "") for m in seen_payloads[0]["messages"] if m.get("role") == "user"]
                self.assertFalse(any("# WORKSPACE AGENTS.MD" in u for u in user_msgs))
                sys_msgs = "\n".join(str(m.get("content") or "") for m in seen_payloads[0]["messages"] if m.get("role") == "system")
                self.assertIn("# WORKSPACE AGENTS.MD", sys_msgs)
                self.assertIn("No pathetic building", sys_msgs)
                self.assertNotIn("<REPO_CONTEXT>", sys_msgs)
                disabled_for_upload = openhands_harness.compute_disabled_project_skills(
                    str(REPO_ROOT),
                    "Hi Sebile. Can you code an improvement on uploading images to posts for cross-posting?",
                )
                for unrelated in ("browser-extensions", "modern-web-guidance", "multi-agent-workflow"):
                    self.assertIn(unrelated, disabled_for_upload)
        finally:
            srv.shutdown()
            srv.server_close()
            shutil.rmtree(tmp, ignore_errors=True)

    def test_prior_coding_turn_keeps_followup_in_openhands_until_casual_pivot(self):
        from runners.runner import _collect_prior_coding_files, _has_prior_coding_turn

        history = [
            {"id": "first_mes_1", "role": "program", "text": "Hello!"},
            {"id": "usr_1", "role": "user", "text": "Can you improve image resizing?"},
            {
                "id": "prgm_1",
                "role": "program",
                "text": "Should I go ahead with that?",
                "tool_calls": [
                    {
                        "type": "call",
                        "id": "c1",
                        "name": "openhands:file_editor",
                        "args": {"command": "view", "path": "web/app/composeModal.js"},
                    }
                ],
            },
            {"id": "usr_2", "role": "user", "text": "Yes, let's resize for Bluesky and use that for everything."},
        ]
        self.assertTrue(_has_prior_coding_turn(history))
        self.assertEqual(_collect_prior_coding_files(history), ["web/app/composeModal.js"])

        # Even if a failed plain-text turn landed after the coding turn, the 2nd-most-recent program turn is detected.
        recovered_history = [
            *history,
            {"id": "prgm_2", "role": "program", "text": "Sorry, I had a hiccup.", "tool_calls": []},
            {"id": "usr_3", "role": "user", "text": "Try again please"},
        ]
        self.assertTrue(_has_prior_coding_turn(recovered_history))

        with mock.patch(
            "core.transmission.score_utterance_pedals",
            return_value={"coding_intent": 0.083, "urgency_or_correction": 0.131, "casual": 0.049},
        ):
            ctrl = TransmissionController(
                utterance="Yes, let's resize for Bluesky and use that for everything.",
                prior_coding_turn=True,
            )
            decision = ctrl.shift(
                iteration=1,
                estimated_tokens=600,
                local_budget=4096,
                has_vision_attachment=False,
                cloud_available=True,
            )
            self.assertEqual(decision.gear, "openhands")
            self.assertEqual(decision.phase, "coding")
            self.assertFalse(decision.write_disengaged)

        with mock.patch(
            "core.transmission.score_utterance_pedals",
            return_value={"coding_intent": 0.25, "urgency_or_correction": 0.72, "casual": 0.05},
        ):
            fix_ctrl = TransmissionController(
                utterance="That broke the test, fix it",
                prior_coding_turn=True,
            )
            fix_decision = fix_ctrl.shift(
                iteration=1,
                estimated_tokens=600,
                local_budget=4096,
                has_vision_attachment=False,
                cloud_available=True,
            )
            self.assertEqual(fix_decision.gear, "openhands")

        with mock.patch(
            "core.transmission.score_utterance_pedals",
            return_value={"coding_intent": -0.02, "casual": 0.90},
        ):
            casual_ctrl = TransmissionController(
                utterance="Hey, how was your evening? How are you feeling tonight?",
                prior_coding_turn=True,
            )
            casual_decision = casual_ctrl.shift(
                iteration=1,
                estimated_tokens=300,
                local_budget=4096,
                has_vision_attachment=False,
                cloud_available=True,
            )
            self.assertEqual(casual_decision.gear, "park")


if __name__ == "__main__":
    unittest.main(verbosity=2)
