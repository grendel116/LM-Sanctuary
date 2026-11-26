import sys
import unittest
from pathlib import Path

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from core.transmission import TransmissionController  # noqa: E402


def _tool_names(decision) -> set[str]:
    return {t["function"]["name"] for t in (decision.native_tools or [])}


class TransmissionReadBandTests(unittest.TestCase):
    def test_high_load_exposes_read_band_without_write_band(self):
        ctrl = TransmissionController(utterance="")
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=3500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertEqual(decision.reason, "high_load_or_complex")
        names = _tool_names(decision)
        self.assertTrue({"list_dir", "read_file", "grep_search"}.issubset(names))
        self.assertEqual(names & {"edit_file", "write_file", "run_command"}, set())

    def test_successful_read_unlocks_write_band_on_next_shift(self):
        ctrl = TransmissionController(utterance="")
        ctrl.shift(
            iteration=1,
            estimated_tokens=3500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        ctrl.record_tool_results([
            ("read_file", {"path": "web/app/messages.js"}, "[File: web/app/messages.js (lines 1-5 of 10)]\n1: x")
        ])
        decision = ctrl.shift(
            iteration=2,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertEqual(decision.reason, "coding_cruise")
        names = _tool_names(decision)
        self.assertTrue({"edit_file", "write_file", "run_command"}.issubset(names))

    def test_web_research_combines_read_and_web_bands(self):
        ctrl = TransmissionController(utterance="", has_active_research=True)
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        names = _tool_names(decision)
        self.assertIn("read_file", names)
        self.assertIn("web_search", names)

    def test_story_mode_stays_parked_with_no_tools(self):
        ctrl = TransmissionController(utterance="", active_story_mode=True)
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=3500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertEqual(decision.gear, "park")
        self.assertIsNone(decision.native_tools)

    def test_casual_park_has_no_tools(self):
        ctrl = TransmissionController(utterance="")
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertEqual(decision.reason, "casual_park")
        self.assertIsNone(decision.native_tools)

    def test_two_strike_halt_disengages_tools(self):
        ctrl = TransmissionController(utterance="")
        for _ in range(4):
            ctrl.record_tool_results([
                ("read_file", {"path": "a.py"}, "Error: Path does not exist: 'a.py'.")
            ])
        ctrl.strike_tracker.halt_tools = True
        decision = ctrl.shift(
            iteration=1,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertTrue(decision.halt_tools)
        self.assertIsNone(decision.native_tools)

    def test_single_batch_of_identical_errors_trips_replan_not_halt(self):
        ctrl = TransmissionController(utterance="")
        err_result = ("read_file", {"path": "a.py"}, "Error: Path does not exist: 'a.py'.")
        ctrl.record_tool_results([err_result, err_result, err_result])
        self.assertEqual(ctrl.strike_tracker.trip_count, 1)
        self.assertTrue(ctrl.strike_tracker.replan_required)
        self.assertFalse(ctrl.strike_tracker.halt_tools)
        decision = ctrl.shift(
            iteration=2,
            estimated_tokens=500,
            local_budget=4096,
            has_vision_attachment=False,
            cloud_available=True,
        )
        self.assertEqual(decision.reason, "two_strike_replan")

    def test_second_failing_batch_halts(self):
        ctrl = TransmissionController(utterance="")
        err_result = ("read_file", {"path": "a.py"}, "Error: Path does not exist: 'a.py'.")
        ctrl.record_tool_results([err_result, err_result, err_result])
        ctrl.record_tool_results([err_result])
        self.assertTrue(ctrl.strike_tracker.halt_tools)


if __name__ == "__main__":
    unittest.main()
