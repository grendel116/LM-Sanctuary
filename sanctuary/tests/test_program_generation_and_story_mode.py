import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import httpx

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from adapters.history_adapters import OsHistoryAdapter  # noqa: E402
import core.program_config as program_config  # noqa: E402
import routes.programs as programs_routes  # noqa: E402
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


class ProgramGenerationAndStoryModeTests(unittest.TestCase):
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

    def test_generate_character_json_returns_rich_card_and_uses_3072_max_tokens(self):
        captured = {}
        generated_payload = {
            "description": "Nova grew up charting freight lanes on the outer rim. She trusts her ship more than any syndicate.",
            "personality": "Sharp, Pragmatic, Loyal, Guarded, Dry-witted. Uses clipped spacer slang and dry understatement.",
            "scenario": "Nova and {{user}} are stranded at an orbital fuel depot waiting out a solar storm.",
            "first_mes": "*I tap the pressure gauge and glance toward the airlock.* Looks like we're stuck here for an hour. Want coffee?",
            "mes_example": "<START>\n{{user}}: hi\n{{char}}: *waves* hey",
            "system_prompt": "Keep replies concise and grounded. Never break character.",
            "image_positive": "short dark hair, amber eyes, flight jacket",
            "image_negative": "extra limbs, deformed",
            "main_color": "#336699",
            "inversion": {
                "intimate": "Softens her voice.",
                "excited": "Grins and talks faster.",
                "intense": "Locks into checklist mode.",
                "sad": "Goes quiet.",
            },
        }

        def fake_post(url, json=None, headers=None, timeout=None):
            captured["json"] = json
            return SimpleNamespace(
                status_code=200,
                json=lambda: {"choices": [{"message": {"content": __import__("json").dumps(generated_payload)}}]},
            )

        with (
            patch("adapters.vram_orchestrator.start_llm"),
            patch.object(programs_routes.httpx, "post", side_effect=fake_post),
        ):
            card = programs_routes.generate_character_json("Nova", "A pilot", "", "", "", "")

        data = card["data"]
        self.assertEqual(data["description"], generated_payload["description"])
        self.assertTrue(data["mes_example"].startswith("<START>"))
        self.assertEqual(captured["json"]["max_tokens"], 3072)

    def test_generate_character_json_raises_when_local_and_cloud_fail(self):
        with (
            patch("adapters.vram_orchestrator.start_llm"),
            patch.object(programs_routes.httpx, "post", side_effect=httpx.ConnectError("down")),
            patch("core.v1_client.v1_unavailable_reason", return_value="disabled"),
        ):
            with self.assertRaises(RuntimeError):
                programs_routes.generate_character_json("Nova", "A pilot", "", "", "", "")

    def test_story_mode_formatting_requests_lengthy_storytelling(self):
        story_fmt = program_config.get_message_formatting(True)
        normal_fmt = program_config.get_message_formatting(False)
        self.assertIn("STORY MODE", story_fmt)
        self.assertIn("3–6 full paragraphs", story_fmt)
        self.assertNotIn("third person", story_fmt)
        self.assertNotIn("STORY MODE", normal_fmt)

    def test_story_mode_skips_brevity_style_block(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            runner._sys_prompt_cache = {}
            with (
                patch("core.program_config.get_compiled_instructions", return_value="BASE"),
                patch("core.program_config.is_story_mode", return_value=True),
            ):
                story_prompt = runner._get_system_instructions("s1")
            self.assertNotIn("Be brief and natural", story_prompt)

            with (
                patch("core.program_config.get_compiled_instructions", return_value="BASE"),
                patch("core.program_config.is_story_mode", return_value=False),
            ):
                normal_prompt = runner._get_system_instructions("s1")
            self.assertIn("Be brief and natural", normal_prompt)

    def test_compiled_instructions_replaces_placeholders_in_story_mode(self):
        with (
            patch("core.program_config.is_story_mode", return_value=True),
            patch("core.program_config.load_user_instructions", return_value=""),
        ):
            inst = program_config.get_compiled_instructions()
        self.assertIn("STORY MODE", inst)
        self.assertNotIn("{{char}}", inst)
        self.assertNotIn("{{user}}", inst)

    def test_post_injection_includes_story_mode_reminder_only_when_active(self):
        with tempfile.TemporaryDirectory() as tmp:
            runner = _TestRunner(tmp)
            sid = "s1"
            runner.sessions_program[sid] = "sebile"
            runner.sessions_history[sid] = [
                {"id": "first_mes_1", "role": "program", "text": "Hello."},
                {"id": "usr_1", "role": "user", "text": "What happens next?"},
            ]

            with patch("core.program_config.is_story_mode", return_value=True):
                msgs_story = OsHistoryAdapter(runner, sid, None, None, None).get_openai_messages("System prompt", "")
            last_user_story = [m for m in msgs_story if m.get("role") == "user"][-1]["content"]
            self.assertIn("STORY MODE REMINDER", last_user_story)

            msgs_normal = OsHistoryAdapter(runner, sid, None, None, None).get_openai_messages("System prompt", "")
            last_user_normal = [m for m in msgs_normal if m.get("role") == "user"][-1]["content"]
            self.assertNotIn("STORY MODE REMINDER", last_user_normal)


if __name__ == "__main__":
    unittest.main()
