import subprocess
import sys
import time
import unittest
from pathlib import Path

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from utils import lifecycle  # noqa: E402


class LifecycleKillTreeTests(unittest.TestCase):
    def test_kill_process_tree_terminates_sleeping_child(self):
        proc = subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(30)"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            **lifecycle.group_popen_kwargs(),
        )
        try:
            self.assertIsNone(proc.poll())
            lifecycle.kill_process_tree(proc, grace=1.0)
            deadline = time.monotonic() + 5.0
            while proc.poll() is None and time.monotonic() < deadline:
                time.sleep(0.05)
            self.assertIsNotNone(proc.poll())
        finally:
            if proc.poll() is None:
                proc.kill()


if __name__ == "__main__":
    unittest.main()
