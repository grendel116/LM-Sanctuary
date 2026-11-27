import sys
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

SANCTUARY_DIR = Path(__file__).resolve().parents[2] / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))


class TestWebToolsGrounding(unittest.TestCase):
    def test_resolve_turn_webpage_urls_and_followup_recovery(self):
        from runners.runner import _resolve_turn_webpage_urls

        history = [
            {
                "id": "usr_1",
                "role": "user",
                "text": "[Shared webpage from docs.inference.coop (https://docs.inference.coop/)]\nSome preview\n\nWhat is this?",
                "shared_post": {
                    "post_type": "link",
                    "url": "https://docs.inference.coop/",
                },
            },
            {"id": "prgm_1", "role": "program", "text": "It looks like a docs site."},
            {"id": "usr_2", "role": "user", "text": "Look at the webpage please."},
        ]

        # Direct shared webpage URL
        self.assertEqual(
            _resolve_turn_webpage_urls(history[:1], history[0]["text"], shared_post=history[0]["shared_post"]),
            ["https://docs.inference.coop/"],
        )

        # Follow-up "Look at the webpage please." recovers URL from recent history
        self.assertEqual(
            _resolve_turn_webpage_urls(history, "Look at the webpage please."),
            ["https://docs.inference.coop/"],
        )

        # Skips loopback and media URLs
        self.assertEqual(
            _resolve_turn_webpage_urls(
                [],
                "Check http://localhost:5000/test and http://127.0.0.1:8080/a and https://example.com/pic.png",
            ),
            [],
        )

    def test_web_browsing_keyword_match(self):
        from core.skill_retriever import _keyword_match, _get_skill_registry

        records = {r["name"]: r for r in _get_skill_registry()}
        self.assertIn("web_browsing", records)
        wb = records["web_browsing"]
        self.assertTrue(_keyword_match("Look at the webpage please.", wb))
        self.assertTrue(_keyword_match("Check www.example.com for details", wb))
        self.assertFalse(_keyword_match("How are you feeling tonight?", wb))

    def test_read_webpage_resolves_relative_links(self):
        from tools.tools import read_webpage

        html = (
            "<html><body><main>"
            "<h1>Inference Docs</h1>"
            "<p>" + ("Welcome to the documentation. " * 12) + "</p>"
            '<a href="/guides/getting-started/">Getting Started</a>'
            "</main></body></html>"
        )
        fake_resp = MagicMock(status_code=200, text=html)
        fake_client = MagicMock()
        fake_client.get.return_value = fake_resp

        with patch("primp.Client", return_value=fake_client):
            result = read_webpage("https://docs.inference.coop/")

        self.assertIn("https://docs.inference.coop/guides/getting-started/", result)

    def test_history_adapter_dedupes_shared_webpage_and_injects_grounding_directive(self):
        from adapters.history_adapters import OsHistoryAdapter

        fake_runner = MagicMock()
        fake_runner._lock = __import__("threading").RLock()
        fake_runner.program_id = "sebile"
        fake_runner.sessions_program_map = {"s1": "sebile"}
        fake_runner.sessions_group_meta = {}
        fake_runner.sessions_memory_state = {}
        fake_runner.sessions_inversion_state = {}
        fake_runner.generating_sessions = {"s1"}
        fake_runner._get_memory_meta.return_value = {"last_summarized_turn": 0}
        fake_runner.sessions_history = {
            "s1": [
                {
                    "id": "usr_1",
                    "role": "user",
                    "text": "[Shared webpage from docs.inference.coop (https://docs.inference.coop/)]\nLong redundant preview text\n\nExplain how it works.",
                    "user_note": "Explain how it works.",
                },
                {"id": "itm_1", "role": "program", "text": "", "tool_calls": [{"type": "call", "name": "read_webpage", "args": {"url": "https://docs.inference.coop/"}}]},
                {"id": "tool_1", "role": "user", "text": "[Tool Response from read_webpage]:\n[URL: https://docs.inference.coop/]\n\n# Real Content"},
            ]
        }

        adapter = OsHistoryAdapter(fake_runner, "s1", None, None, None)
        with patch.object(adapter, "_get_max_input_tokens", return_value=16384):
            msgs = adapter.get_openai_messages("System prompt", "")

        joined = "\n".join(str(m.get("content") or "") for m in msgs)
        self.assertNotIn("Long redundant preview text", joined)
        self.assertIn("[Shared webpage from docs.inference.coop (https://docs.inference.coop/)]", joined)
        self.assertIn("Explain how it works.", joined)
        self.assertIn("# WEB & RESEARCH GROUNDING DIRECTIVE", joined)

    def test_cloud_gear_escalation_for_urgency_upset_complexity_and_accuracy(self):
        from runners.runner import _assess_cloud_gear_escalation
        from core.skill_retriever import get_toolbelt_block

        # Upset / urgency / error correction -> deep
        self.assertEqual(
            _assess_cloud_gear_escalation([], "Look at the webpage please."),
            ("deep", "urgency_or_correction"),
        )
        self.assertEqual(
            _assess_cloud_gear_escalation([], "That's wrong, it didn't work!"),
            ("deep", "urgency_or_correction"),
        )
        self.assertEqual(
            _assess_cloud_gear_escalation([], "I need this fixed ASAP, production is down"),
            ("deep", "urgency_or_correction"),
        )

        # Shared social post with emotional text but calm user_note should NOT false-trigger urgency_or_correction
        shared_emotional = (
            "[Shared post by @user (@user@example.com)]\n"
            "This is ridiculous and terrible! Everything is broken ASAP!!\n\n"
            "Hey Sebile, what do you think of this?"
        )
        calm_history = [{"id": "usr_s1", "role": "user", "text": shared_emotional, "user_note": "Hey Sebile, what do you think of this?"}]
        self.assertEqual(
            _assess_cloud_gear_escalation(calm_history, shared_emotional),
            (None, ""),
        )

        # Complexity -> deep
        self.assertEqual(
            _assess_cloud_gear_escalation([], "Can you compare the distributed system architecture trade-offs here?"),
            ("deep", "complex_topic"),
        )
        self.assertEqual(
            _assess_cloud_gear_escalation([], "Why does this fail?\n```python\nraise ValueError('bad')\n```"),
            ("deep", "complex_topic"),
        )

        # Accuracy / active research -> fast
        self.assertEqual(
            _assess_cloud_gear_escalation([], "Tell me about Inference Coop", has_active_research=True),
            ("fast", "accuracy_or_research"),
        )
        self.assertEqual(
            _assess_cloud_gear_escalation([], "Please fact check and verify the technical details."),
            ("fast", "accuracy_or_research"),
        )

        # Casual conversation -> None
        self.assertEqual(
            _assess_cloud_gear_escalation([], "Hey Sebile, how was your evening?"),
            (None, ""),
        )

        # Toolbelt exposes Cloud Upscale Baton in normal mode, omits it in story mode
        normal_toolbelt = get_toolbelt_block(story_active=False)
        story_toolbelt = get_toolbelt_block(story_active=True)
        self.assertIn("Cloud Upscale Baton", normal_toolbelt)
        self.assertIn("consult_cloud", normal_toolbelt)
        self.assertNotIn("Cloud Upscale Baton", story_toolbelt)

    def test_open_cloud_router_and_context_streamlining(self):
        import json
        import os
        import tempfile
        from core import v1_client
        from core.skill_retriever import get_toolbelt_block
        from tools.tools import list_tools
        from core.openhands_harness import compute_disabled_project_skills as _compute_disabled_project_skills
        from adapters.history_adapters import _extract_retrieval_query

        # 1. Inference Co-op role-slot resolution (normal, sensitive/TEE, vision, custom override)
        coop_cfg = {
            "greenpt_api_key": "sk-coop",
            "greenpt_base_url": "https://gateway.inference.coop/v1",
            "routing_policy": "auto",
            "openhands_model": "glm-5.3",
        }
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
            json.dump(coop_cfg, tmp)
            tmp_path = tmp.name
        try:
            with patch.object(v1_client, "_SETTINGS_PATH", tmp_path):
                s = v1_client.get_v1_settings()
                self.assertEqual(s["provider"], "inference_coop")
                self.assertEqual(s["default_model"], "greenpt/glm-5.3")
                self.assertEqual(v1_client.resolve_v1_tier_model("fast"), "glm-flash-green")
                self.assertEqual(v1_client.resolve_v1_tier_model("deep"), "greenpt/glm-5.3")
                self.assertEqual(v1_client.resolve_v1_tier_model("vision", has_vision=True), "deepseek-flash-green")
                self.assertEqual(v1_client.resolve_v1_tier_model("deep", sensitive=True), "glm-tee")
                self.assertEqual(v1_client.resolve_v1_tier_model("vision", has_vision=True, sensitive=True), "deepseek-flash-tee")
                self.assertTrue(v1_client.supports_systemone())

                # Custom role-slot override + Regolo Apertus preset
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump({
                        "greenpt_api_key": "sk-regolo",
                        "greenpt_base_url": "https://api.regolo.ai/v1",
                        "routing_policy": "auto",
                        "openhands_model": "apertus-70b",
                        "cloud_fast_model": "qwen3.5-122b",
                        "cloud_vision_model": "gemma4-31b",
                    }, f)
                self.assertEqual(v1_client.resolve_v1_tier_model("deep"), "apertus-70b")
                self.assertEqual(v1_client.resolve_v1_tier_model("fast"), "qwen3.5-122b")
                self.assertEqual(v1_client.resolve_v1_tier_model("vision", has_vision=True), "gemma4-31b")
                self.assertFalse(v1_client.supports_systemone())

                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump({
                        "greenpt_api_key": "sk-regolo",
                        "greenpt_base_url": "https://api.regolo.ai/v1",
                        "routing_policy": "private_tee",
                        "openhands_model": "apertus-70b",
                        "cloud_fast_model": "qwen3.5-122b",
                        "cloud_vision_model": "gemma4-31b",
                    }, f)
                self.assertEqual(v1_client.resolve_v1_tier_model("fast"), "apertus-70b")

                # Metis /v1/systemone call
                with open(tmp_path, "w", encoding="utf-8") as f:
                    json.dump(coop_cfg, f)
                fake_resp = MagicMock(status_code=200, content=b'{"go":{"true":0.9}}')
                fake_resp.json.return_value = {"go": {"true": 0.9}}
                with patch("requests.post", return_value=fake_resp) as m_post:
                    dec = v1_client.systemone_decide("state text", {"go": {"type": "noul"}})
                    self.assertEqual(dec, {"go": {"true": 0.9}})
                    self.assertTrue(m_post.call_args[0][0].endswith("/systemone"))
        finally:
            os.unlink(tmp_path)

        # 2. Streamlined toolbelt + list_tools discovery
        tb = get_toolbelt_block(False)
        self.assertLess(len(tb), 650)
        self.assertIn("list_tools", tb)
        discovered = list_tools("web")
        self.assertIn("read_webpage", discovered)

        # 3. Shared post retrieval isolation
        shared = "[Shared post by @bob (@bob@mastodon.social)]\nI am listening to music and drawing a portrait\n\nWhat do you think of this?"
        q = _extract_retrieval_query({"text": shared, "user_note": "What do you think of this?"}, shared)
        self.assertNotIn("music", q)
        self.assertIn("What do you think of this?", q)

        # 4. OpenHands project skill scoping
        repo_root = str(SANCTUARY_DIR.parent)
        disabled_py = _compute_disabled_project_skills(repo_root, "Fix python runner bug", "sanctuary/runners/runner.py")
        self.assertIn("browser-extensions", disabled_py)
        self.assertIn("modern-web-guidance", disabled_py)
        self.assertNotIn("sanctuary-architecture", disabled_py)

    def test_v1_models_discovery_and_loud_400_error(self):
        import json
        import os
        import tempfile
        from core import v1_client

        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
            json.dump({"v1_api_key": "sk-test", "v1_base_url": "https://api.example.com/v1", "routing_policy": "auto"}, tmp)
            tmp_path = tmp.name
        try:
            with patch.object(v1_client, "_SETTINGS_PATH", tmp_path):
                v1_client.clear_quota_cooldown()
                models_resp = MagicMock(
                    status_code=200,
                    content=b'{"data":[{"id":"glm-5.3-flash","context_length":1000000,"max_output_tokens":65536,"supported_parameters":["reasoning_effort"]}]}',
                )
                models_resp.json.return_value = {
                    "data": [{
                        "id": "glm-5.3-flash",
                        "context_length": 1000000,
                        "max_output_tokens": 65536,
                        "supported_parameters": ["reasoning_effort"],
                    }]
                }
                resp_400 = MagicMock(status_code=400, text="bad request")
                with (
                    patch("requests.get", return_value=models_resp),
                    patch("requests.post", return_value=resp_400) as m_post,
                ):
                    info = v1_client.get_v1_model_info("glm-5.3-flash")
                    self.assertEqual(info["context_tokens"], 1000000)
                    self.assertEqual(info["max_output_tokens"], 65536)
                    with self.assertRaises(RuntimeError):
                        v1_client.chat_completion([{"role": "user", "content": "Hi"}], tier="fast")
                    self.assertEqual(m_post.call_count, 1)
        finally:
            os.unlink(tmp_path)


if __name__ == "__main__":
    unittest.main()
