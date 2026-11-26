import sys
import unittest
from pathlib import Path

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from utils.utils import (  # noqa: E402
    _drop_dangling_called_line,
    _extract_tool_calls,
    _has_dangling_called_line,
    _strip_tool_calls,
)


class ToolCallExtractionTests(unittest.TestCase):
    def test_extracts_whole_line_called_echoes_and_strips_them(self):
        text = (
            '*I nod.*\n\n'
            'Let me find those buttons first.\n\n'
            'Called grep_search(query="palette")\n'
            'Called grep_search(query="edit", path="web/app/messages.js")'
        )
        matches = _extract_tool_calls(text)
        self.assertEqual(len(matches), 2)
        self.assertEqual([m.group(1) for m in matches], ["grep_search", "grep_search"])
        self.assertEqual(matches[0].group(2), 'query="palette"')
        stripped = _strip_tool_calls(text, matches)
        self.assertIn("Let me find those buttons first.", stripped)
        self.assertNotIn("Called", stripped)

    def test_bracket_form_unchanged(self):
        matches = _extract_tool_calls('[read_file(path="a.py", start_line=1)]')
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].group(1), "read_file")

    def test_rejects_mid_line_called_prose(self):
        self.assertEqual(_extract_tool_calls('I Called grep_search(query="x") earlier.'), [])

    def test_rejects_called_with_trailing_text_on_line(self):
        self.assertEqual(_extract_tool_calls('Called grep_search(query="x") and more'), [])

    def test_handles_parens_inside_quoted_args(self):
        text = 'Called edit_file(path="a.js", target="f(x)", replacement="g(y)")'
        matches = _extract_tool_calls(text)
        self.assertEqual(len(matches), 1)
        self.assertEqual(matches[0].group(1), "edit_file")
        self.assertTrue(matches[0].group(2).endswith('replacement="g(y)"'))

    def test_plain_prose_returns_empty(self):
        self.assertEqual(_extract_tool_calls("I called her yesterday (it was fun)."), [])

    def test_dangling_called_line_detected_and_dropped(self):
        text = 'Text.\nCalled read_file(path="web/queries/blues'
        self.assertTrue(_has_dangling_called_line(text))
        self.assertEqual(_drop_dangling_called_line(text), "Text.")

    def test_complete_called_line_not_dangling(self):
        self.assertFalse(_has_dangling_called_line('Called read_file(path="a.py")'))

    def test_called_prose_not_dangling(self):
        self.assertFalse(_has_dangling_called_line("Called it a night."))


if __name__ == "__main__":
    unittest.main()
