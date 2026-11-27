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

from core import openhands_harness as oh  # noqa: E402
from openhands.tools.terminal.definition import TerminalAction  # noqa: E402


class RunCommandShellTests(unittest.TestCase):
    @unittest.skipUnless(
        os.name != "nt" or os.path.isfile(r"C:\Program Files\Git\bin\bash.exe"),
        "Git Bash not installed on Windows",
    )
    def test_resolves_bash_and_git_bash_on_windows(self):
        self.assertEqual(oh._SHELL_KIND, "bash")
        if os.name == "nt":
            self.assertIn("Git", oh._SHELL_ARGV[0])

    def test_sanctuary_shell_override_and_missing_fallback(self):
        with patch.dict(os.environ, {"SANCTUARY_SHELL": oh._SHELL_ARGV[0]}):
            self.assertEqual(oh.resolve_shell()[1][0], oh._SHELL_ARGV[0])
        with patch.dict(os.environ, {"SANCTUARY_SHELL": "/nonexistent/path/to/shell"}):
            kind, argv, _ = oh.resolve_shell()
            self.assertIn(kind, ("bash", "sh", "powershell"))
            self.assertTrue(argv)

    def test_git_bash_executor_supports_and_grep_and_persistent_cwd(self):
        with tempfile.TemporaryDirectory() as tmp:
            sub = os.path.join(tmp, "sub")
            os.makedirs(sub, exist_ok=True)
            executor = oh.GitBashTerminalExecutor(working_dir=tmp)
            try:
                obs1 = executor(TerminalAction(command="echo a && printf 'x\\ny\\n' | grep -n y", timeout=30))
                self.assertFalse(obs1.is_error)
                self.assertEqual(obs1.exit_code, 0)
                self.assertIn("2:y", obs1.text)

                obs2 = executor(TerminalAction(command="cd sub && pwd"))
                self.assertFalse(obs2.is_error)
                self.assertIn("sub", obs2.metadata.working_dir)

                obs3 = executor(TerminalAction(command="pwd"))
                self.assertIn("sub", obs3.text)

                obs_reset = executor(TerminalAction(command="", reset=True))
                self.assertEqual(os.path.realpath(obs_reset.metadata.working_dir), os.path.realpath(tmp))
            finally:
                executor.close()

    def test_timeout_kills_sleeping_command_promptly(self):
        with tempfile.TemporaryDirectory() as tmp:
            executor = oh.GitBashTerminalExecutor(working_dir=tmp)
            try:
                t0 = time.monotonic()
                obs = executor(TerminalAction(command="sleep 30", timeout=5))
                elapsed = time.monotonic() - t0
                self.assertTrue(obs.is_error)
                self.assertTrue(obs.timeout)
                self.assertIn("timed out", obs.text)
                self.assertLess(elapsed, 12.0)
            finally:
                executor.close()

    @unittest.skipUnless(
        os.name == "nt" and os.path.isfile(os.path.join(str(REPO_ROOT), ".venv", "Scripts", "python.exe")),
        "Windows .venv python not present",
    )
    def test_workspace_python_uses_forward_slashes(self):
        self.assertEqual(oh.workspace_python(str(REPO_ROOT)), ".venv/Scripts/python.exe")


if __name__ == "__main__":
    unittest.main()
