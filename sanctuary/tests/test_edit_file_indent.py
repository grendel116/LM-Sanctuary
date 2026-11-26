import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from tools import coding_tools as ct  # noqa: E402
import tools.tools as tools_mod  # noqa: E402


SAMPLE_JS = "\n".join([
    "function f() {",
    "  if (x) {",
    "        for (const c of [...fediConvos, ...bskyConvos]) {",
    "          const acct = String(c?.peerAcct || '').replace(/^@/, '');",
    "          const name = String(c?.peerName || '');",
    "        }",
    "  }",
    "}",
    "",
])


class EditFileIndentTests(unittest.TestCase):
    def setUp(self):
        self._tmp_dir = tempfile.TemporaryDirectory()
        self.tmp = self._tmp_dir.name
        self.file_path = os.path.join(self.tmp, "a.js")
        with open(self.file_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(SAMPLE_JS)

        self._patches = [
            patch.object(ct, "_allowed_roots", return_value=(self.tmp, [self.tmp])),
            patch.object(ct, "_read_only_band_notice", return_value=None),
            patch.object(tools_mod, "confirm_tool_execution", return_value=True),
        ]
        for p in self._patches:
            p.start()

    def tearDown(self):
        for p in reversed(self._patches):
            p.stop()
        self._tmp_dir.cleanup()

    def test_over_indented_target_applies_with_uniform_shift(self):
        target = "\n".join([
            "            for (const c of [...fediConvos, ...bskyConvos]) {",
            "              const acct = String(c?.peerAcct || '').replace(/^@/, '');",
            "              const name = String(c?.peerName || '');",
        ])
        replacement = "\n".join([
            "            for (const c of [...fediConvos, ...bskyConvos]) {",
            "              const acct = String(c?.handle || '').replace(/^@/, '');",
            "              const name = String(c?.displayName || '');",
        ])
        res = ct.edit_file("a.js", target, replacement)
        self.assertTrue(res.startswith("Edited"))
        self.assertIn("ignoring indentation", res)
        self.assertIn("-4 spaces", res)
        updated = Path(self.file_path).read_text(encoding="utf-8")
        self.assertIn("          const acct = String(c?.handle || '')", updated)
        self.assertNotIn("peerAcct", updated)

    def test_ambiguous_indent_shift_reports_locations(self):
        dup_path = os.path.join(self.tmp, "dup.js")
        with open(dup_path, "w", encoding="utf-8", newline="\n") as f:
            f.write("  foo();\n  bar();\n    foo();\n    bar();\n")
        res = ct.edit_file("dup.js", "      foo();\n      bar();", "      baz();")
        self.assertTrue(res.startswith("Error:"))
        self.assertIn("matched 2 locations", res)

    def test_near_miss_hint_shows_first_matching_line(self):
        target = "            for (const c of [...fediConvos, ...bskyConvos]) {\n              const wrong = 1;"
        res = ct.edit_file("a.js", target, "x")
        self.assertTrue(res.startswith("Error:"))
        self.assertIn("first line exists", res)
        self.assertIn("3: ", res)

    def test_exact_match_works_without_indent_fallback(self):
        target = "  if (x) {\n        for (const c of [...fediConvos, ...bskyConvos]) {"
        replacement = "  if (y) {\n        for (const c of [...fediConvos, ...bskyConvos]) {"
        res = ct.edit_file("a.js", target, replacement)
        self.assertTrue(res.startswith("Edited"))
        self.assertNotIn("ignoring indentation", res)

    def test_grep_search_preserves_indentation(self):
        res = ct.grep_search("peerAcct")
        self.assertIn(": " + " " * 10 + "const acct", res)


if __name__ == "__main__":
    unittest.main()
