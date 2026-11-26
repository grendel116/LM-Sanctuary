import os
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
REPO_ROOT = SANCTUARY_DIR.parent
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from tools import coding_tools as ct  # noqa: E402
import tools.tools as tools_mod  # noqa: E402


class RunCommandShellTests(unittest.TestCase):
    @unittest.skipUnless(
        os.name != "nt" or os.path.isfile(r"C:\Program Files\Git\bin\bash.exe"),
        "Git Bash not installed on Windows",
    )
    def test_resolves_bash_and_git_bash_on_windows(self):
        self.assertEqual(ct._SHELL_KIND, "bash")
        if os.name == "nt":
            self.assertIn("Git", ct._SHELL_ARGV[0])

    def test_sanctuary_shell_override_and_missing_fallback(self):
        with patch.dict(os.environ, {"SANCTUARY_SHELL": ct._SHELL_ARGV[0]}):
            self.assertEqual(ct._resolve_shell()[1][0], ct._SHELL_ARGV[0])
        with patch.dict(os.environ, {"SANCTUARY_SHELL": "/nonexistent/path/to/shell"}):
            kind, argv, _ = ct._resolve_shell()
            self.assertIn(kind, ("bash", "sh", "powershell"))
            self.assertTrue(argv)

    def test_run_command_supports_and_and_grep_pipeline(self):
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(ct, "_allowed_roots", return_value=(tmp, [tmp])),
                patch.object(ct, "_read_only_band_notice", return_value=None),
                patch.object(tools_mod, "confirm_tool_execution", return_value=True),
            ):
                out = ct.run_command("echo a && printf 'x\\ny\\n' | grep -n y", timeout=30)
        self.assertTrue(out.startswith("[Command succeeded"))
        self.assertIn("2:y", out)

    def test_schema_mentions_bash_and_workspace_python(self):
        run_schema = next(
            s["function"] for s in ct.WRITE_BAND_SCHEMAS if s["function"]["name"] == "run_command"
        )
        self.assertIn("bash", run_schema["description"])
        self.assertIn(".venv/", run_schema["description"])

    def test_shell_hint_only_fires_on_powershell_fallback(self):
        self.assertEqual(
            ct._shell_hint(
                'grep -n "x" a.js',
                "grep : The term 'grep' is not recognized as the name of a cmdlet",
            ),
            "",
        )
        with patch.object(ct, "_SHELL_KIND", "powershell"):
            hint = ct._shell_hint(
                'grep -n "x" a.js',
                "grep : The term 'grep' is not recognized as the name of a cmdlet",
            )
            self.assertIn("grep_search", hint)

    def test_timeout_kills_sleeping_command_promptly(self):
        with tempfile.TemporaryDirectory() as tmp:
            with (
                patch.object(ct, "_allowed_roots", return_value=(tmp, [tmp])),
                patch.object(ct, "_read_only_band_notice", return_value=None),
                patch.object(tools_mod, "confirm_tool_execution", return_value=True),
            ):
                t0 = time.monotonic()
                out = ct.run_command("sleep 30", timeout=5)
                elapsed = time.monotonic() - t0
        self.assertTrue(out.startswith("Error: Command timed out"))
        self.assertLess(elapsed, 12.0)

    @unittest.skipUnless(
        os.name == "nt" and os.path.isfile(os.path.join(str(REPO_ROOT), ".venv", "Scripts", "python.exe")),
        "Windows .venv python not present",
    )
    def test_workspace_python_uses_forward_slashes(self):
        self.assertEqual(ct.workspace_python(str(REPO_ROOT)), ".venv/Scripts/python.exe")


if __name__ == "__main__":
    unittest.main()
