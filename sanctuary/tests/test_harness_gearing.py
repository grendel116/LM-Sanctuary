import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from adapters.history_adapters import OsHistoryAdapter  # noqa: E402
from core import openhands_harness, plan_state, program_config, transmission, v1_client  # noqa: E402
from core.transmission import TransmissionController  # noqa: E402
from runners.runner import BaseProgramRunner  # noqa: E402
from tools import coding_tools  # noqa: E402


class HarnessGearingTests(unittest.TestCase):
    def test_core_coding_modules_have_zero_regex(self):
        for mod in (openhands_harness, v1_client, transmission, coding_tools, plan_state):
            self.assertNotIn("re", mod.__dict__, f"{mod.__name__} must stay zero-regex")

    def test_planning_shift_selects_openhands_readonly(self):
        ctrl = TransmissionController(utterance="code an improvement", is_plan_turn=True)
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertEqual(decision.gear, "openhands")
        self.assertEqual(decision.phase, "planning")
        self.assertTrue(decision.write_disengaged)

    def test_v1_client_streaming_sse_and_loud_errors(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "project_settings.json")
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump({"v1_api_key": "sk-test", "v1_base_url": "https://api.example.com/v1"}, f)

            with patch.object(v1_client, "_SETTINGS_PATH", settings_path):
                v1_client.clear_quota_cooldown()
                models_resp = MagicMock(status_code=200, content=b'{"data":[]}')
                models_resp.json.return_value = {
                    "data": [{"id": "glm-5.3", "context_length": 1000000, "max_output_tokens": 65536}]
                }
                sse_lines = [
                    'data: {"choices":[{"delta":{"content":"Hello "}}]}',
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"read_file","arguments":"{\\"path\\":"}}]}}]}',
                    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"a.js\\"}"}}]},"finish_reason":"tool_calls"}]}',
                    "data: [DONE]",
                ]
                sse_resp = MagicMock(status_code=200, headers={"Content-Type": "text/event-stream; charset=utf-8"})
                sse_resp.iter_lines.return_value = iter(sse_lines)

                with (
                    patch("requests.get", return_value=models_resp),
                    patch("requests.post", return_value=sse_resp),
                ):
                    info = v1_client.get_v1_model_info("glm-5.3")
                    self.assertEqual(info["context_tokens"], 1000000)
                    res = v1_client.chat_completion_step([{"role": "user", "content": "Hi"}], tier="deep")
                    self.assertEqual(res["content"], "Hello")
                    self.assertEqual(res["tool_calls"][0]["name"], "read_file")
                    self.assertEqual(res["tool_calls"][0]["args"], {"path": "a.js"})

                empty_len_resp = MagicMock(status_code=200, headers={"Content-Type": "application/json"}, content=b"{}")
                empty_len_resp.json.return_value = {
                    "choices": [{"finish_reason": "length", "message": {"content": ""}}]
                }
                with (
                    patch("requests.get", return_value=models_resp),
                    patch("requests.post", return_value=empty_len_resp),
                ):
                    with self.assertRaises(RuntimeError):
                        v1_client.chat_completion_step([{"role": "user", "content": "Hi"}], tier="deep")

    def test_runner_single_gear_never_falls_back_to_local_on_cloud_error(self):
        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner.program_id = "sebile"
        runner.sessions_history = {"s_nofallback": [{"id": "usr_1", "role": "user", "text": "Fix bug"}]}
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
        runner._post_llm_request = AsyncMock(side_effect=AssertionError("Local LLM must not be called"))

        class _StubAdapter:
            matched_skill_records = []
            has_sensitive_context = False

            def _get_chat_budget(self):
                return 4096

            def estimate_turn_tokens(self):
                return 200

            def get_openai_messages(self, *a, **kw):
                return [{"role": "system", "content": "sys"}, {"role": "user", "content": "Fix bug"}]

            def append_assistant_message(self, text, tool_calls, inv, intermediate=False, speaker_id=None):
                return {"id": "prgm_1", "text": text}

        with (
            patch("core.v1_client.v1_unavailable_reason", return_value=""),
            patch("core.v1_client.get_v1_settings", return_value={"base_url": "https://api.example.com/v1", "routing_policy": "auto"}),
            patch("core.v1_client.chat_completion_step", side_effect=RuntimeError("HTTP 502 Bad Gateway")),
            patch("core.program_config.is_story_mode", return_value=False),
            patch("core.transmission.score_utterance_pedals", return_value={"complex_topic": 0.9, "coding_intent": 0.1, "casual": 0.1}),
            patch("core.banned_words.replace_banned_words_async", new=AsyncMock(side_effect=lambda text, **kw: text)),
        ):
            final_text, _, _ = asyncio.run(
                runner._execute_local_llm_loop("s_nofallback", _StubAdapter(), "local-llm", "", "", "Compare distributed architectures", "inv_1")
            )
            self.assertIn("[Gear second", final_text)
            self.assertIn("HTTP 502 Bad Gateway", final_text)
            runner._post_llm_request.assert_not_called()

    def test_single_agents_md_loader_and_in_app_injection(self):
        loaded = program_config.load_agents_md()
        self.assertIn("No pathetic building", loaded)
        self.assertNotIn("<!-- Tip:", loaded)
        self.assertNotIn("argument-hint:", loaded)

        disabled = openhands_harness.compute_disabled_project_skills(str(SANCTUARY_DIR.parent), "fix bug")
        self.assertIn("agents", disabled)

        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner.program_id = "sebile"
        runner.sessions_history = {
            "s_agents": [{"id": "usr_1", "role": "user", "text": "/plan fix image resize"}]
        }
        runner.sessions_group_meta = {}
        runner.sessions_memory_state = {}

        with patch("core.program_config.is_story_mode", return_value=False):
            msgs = OsHistoryAdapter(runner, "s_agents", None, None, None).get_openai_messages("sys", "", cloud_gear=True)
            joined = "\n".join(str(m.get("content") or "") for m in msgs)
            self.assertNotIn("# WORKSPACE AGENTS.MD", joined)

        runner.sessions_history["s_casual"] = [{"id": "usr_1", "role": "user", "text": "Good morning!"}]
        with patch("core.program_config.is_story_mode", return_value=False):
            casual_msgs = OsHistoryAdapter(runner, "s_casual", None, None, None).get_openai_messages("sys", "", cloud_gear=False)
            casual_joined = "\n".join(str(m.get("content") or "") for m in casual_msgs)
            self.assertNotIn("# WORKSPACE AGENTS.MD", casual_joined)

    def test_greenpt_pricing_catalog_limits_us_region_scope_and_reasoning_recovery(self):
        self.assertNotIn("_known_model_limits", v1_client.__dict__)
        self.assertTrue(v1_client.supports_coop_extensions("https://api.greenpt.ai/v1"))
        self.assertTrue(v1_client.supports_coop_extensions("https://api.eu.greenpt.ai/v1"))
        self.assertFalse(v1_client.supports_coop_extensions("https://api.us.greenpt.ai/v1"))
        self.assertEqual(v1_client.detect_v1_provider("https://api.us.greenpt.ai/v1"), "greenpt")
        self.assertTrue(v1_client.supports_systemone("https://api.us.greenpt.ai/v1"))

        with tempfile.TemporaryDirectory() as tmpdir:
            settings_path = os.path.join(tmpdir, "project_settings.json")
            with open(settings_path, "w", encoding="utf-8") as f:
                json.dump({"v1_api_key": "sk-test", "v1_base_url": "https://api.us.greenpt.ai/v1"}, f)

            with patch.object(v1_client, "_SETTINGS_PATH", settings_path):
                v1_client.clear_quota_cooldown()
                models_resp = MagicMock(status_code=200, content=b'{"data":[]}')
                models_resp.json.return_value = {
                    "data": [
                        {"id": "glm-5.3", "object": "model"},
                        {"id": "kimi-k3.1-pro", "object": "model"},
                    ]
                }
                pricing_resp = MagicMock(status_code=200, content=b'{"data":[]}')
                pricing_resp.json.return_value = {
                    "data": [
                        {"id": "glm-5.3", "contextWindowTokens": 1000000, "maxOutputTokens": None},
                        {"id": "kimi-k3.1-pro", "contextWindowTokens": 1000000, "maxOutputTokens": 64000},
                        {"id": "gemma4", "contextWindowTokens": 256000, "maxOutputTokens": 32000},
                    ]
                }

                def _fake_get(url, **kwargs):
                    return pricing_resp if str(url).endswith("/pricing") else models_resp

                with patch("requests.get", side_effect=_fake_get):
                    glm_info = v1_client.get_v1_model_info("glm-5.3")
                    self.assertEqual(glm_info["context_tokens"], 1_000_000)
                    self.assertTrue(glm_info["output_uncapped"])

                    kimi_info = v1_client.get_v1_model_info("kimi-k3.1-pro")
                    self.assertEqual(kimi_info["context_tokens"], 1_000_000)
                    self.assertEqual(kimi_info["max_output_tokens"], 64_000)
                    self.assertFalse(kimi_info["output_uncapped"])

                    # gemma4 is not in US /v1/models, so it must be filtered out
                    gemma_info = v1_client.get_v1_model_info("gemma4")
                    self.assertEqual(gemma_info["context_tokens"], 262_144)

                seen_posts = []

                def _fake_post(url, **kwargs):
                    seen_posts.append(kwargs.get("json") or {})
                    resp = MagicMock(
                        status_code=200,
                        headers={"Content-Type": "text/event-stream"},
                    )
                    resp.iter_lines.return_value = iter([
                        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}',
                        "data: [DONE]",
                    ])
                    return resp

                with (
                    patch("requests.get", side_effect=_fake_get),
                    patch("requests.post", side_effect=_fake_post),
                ):
                    v1_client.chat_completion_step(
                        [{"role": "user", "content": "Hi"}],
                        model="glm-5.3",
                        tier="deep",
                    )
                    v1_client.chat_completion_step(
                        [{"role": "user", "content": "Hi"}],
                        model="kimi-k3.1-pro",
                        tier="deep",
                    )
                self.assertNotIn("max_tokens", seen_posts[0])
                self.assertEqual(seen_posts[1]["max_tokens"], 64000)

                sse_reasoning_len = MagicMock(
                    status_code=200,
                    headers={"Content-Type": "text/event-stream"},
                )
                sse_reasoning_len.iter_lines.return_value = iter([
                    'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}',
                    'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
                    "data: [DONE]",
                ])
                with (
                    patch("requests.get", side_effect=_fake_get),
                    patch("requests.post", return_value=sse_reasoning_len),
                ):
                    res = v1_client.chat_completion_step(
                        [{"role": "user", "content": "Hi"}],
                        tier="deep",
                        tools=[{"type": "function", "function": {"name": "list_dir", "parameters": {"type": "object"}}}],
                    )
                    self.assertTrue(res["truncated_tool_call"])
                    self.assertEqual(res["content"], "")

        # Verify runner retries with reasoning_effort="low" after truncated_tool_call
        seen_efforts = []
        runner = BaseProgramRunner.__new__(BaseProgramRunner)
        runner._lock = __import__("threading").RLock()
        runner.program_id = "sebile"
        runner.sessions_history = {"s_rec": [{"id": "usr_1", "role": "user", "text": "Fix bug"}]}
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

        class _RecAdapter:
            matched_skill_records = []
            has_sensitive_context = False

            def _get_chat_budget(self):
                return 4096

            def estimate_turn_tokens(self):
                return 200

            def get_openai_messages(self, *a, **kw):
                return [{"role": "system", "content": "sys"}, {"role": "user", "content": "Fix bug"}]

            def append_assistant_message(self, text, tool_calls, inv, intermediate=False, speaker_id=None):
                return {"id": "prgm_1", "text": text}

            def append_tool_events(self, results, inv):
                pass

        def _fake_step(*args, **kwargs):
            seen_efforts.append(kwargs.get("reasoning_effort"))
            if len(seen_efforts) == 1:
                return {"content": "", "tool_calls": [], "model": "glm-5.3", "truncated_tool_call": True, "finish_reason": "length"}
            return {"content": "Fixed cleanly.", "tool_calls": [], "model": "glm-5.3", "truncated_tool_call": False, "finish_reason": "stop"}

        with (
            patch("core.v1_client.v1_unavailable_reason", return_value=""),
            patch("core.v1_client.get_v1_settings", return_value={"base_url": "https://api.greenpt.ai/v1", "routing_policy": "auto"}),
            patch("core.v1_client.chat_completion_step", side_effect=_fake_step),
            patch("core.program_config.is_story_mode", return_value=False),
            patch("core.transmission.score_utterance_pedals", return_value={"complex_topic": 0.9, "coding_intent": 0.1, "casual": 0.1}),
            patch("core.banned_words.replace_banned_words_async", new=AsyncMock(side_effect=lambda text, **kw: text)),
        ):
            final_text, _, _ = asyncio.run(
                runner._execute_local_llm_loop("s_rec", _RecAdapter(), "local-llm", "", "", "Analyze system architecture", "inv_1")
            )
            self.assertEqual(final_text, "Fixed cleanly.")
            self.assertEqual(len(seen_efforts), 2)

    def test_system_settings_does_not_stamp_cloud_token_overrides(self):
        from app import app
        from routes import system as system_mod
        import variables.settings as vs

        with tempfile.TemporaryDirectory() as tmpdir:
            vars_dir = Path(tmpdir)
            settings_file = vars_dir / "project_settings.json"
            settings_file.write_text(json.dumps({"cloud_context_tokens": 262144, "cloud_max_output_tokens": 32768}), encoding="utf-8")
            with (
                patch.object(vs, "VARIABLES_DIR", str(vars_dir)),
                patch("runners.program.get_active_program", return_value="sebile"),
                patch.object(system_mod, "_read_vault_greenpt_key", return_value=("", False, False)),
            ):
                os.environ.pop("CLOUD_CONTEXT_TOKENS", None)
                os.environ.pop("CLOUD_MAX_OUTPUT_TOKENS", None)
                client = app.test_client()
                resp = client.get("/api/project_settings")
                self.assertEqual(resp.status_code, 200)
                saved = json.loads(settings_file.read_text(encoding="utf-8"))
                self.assertNotIn("cloud_context_tokens", saved)
                self.assertNotIn("cloud_max_output_tokens", saved)
                self.assertNotIn("CLOUD_CONTEXT_TOKENS", os.environ)
                self.assertNotIn("CLOUD_MAX_OUTPUT_TOKENS", os.environ)


if __name__ == "__main__":
    unittest.main()
