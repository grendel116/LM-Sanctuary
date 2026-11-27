import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from tools.coding_tools import http_probe  # noqa: E402


class HttpProbeTests(unittest.TestCase):
    def test_rejects_non_http_url(self):
        out = http_probe("file:///etc/passwd")
        self.assertTrue(out.startswith("Error:"))

    def test_rejects_post_method(self):
        out = http_probe("https://example.com", method="POST")
        self.assertTrue(out.startswith("Error:"))

    def test_blocks_credential_headers_without_calling_requests(self):
        with patch("requests.request") as mock_req:
            out = http_probe("https://example.com", headers={"Authorization": "x"})
            self.assertTrue(out.startswith("Error:"))
            self.assertIn("credentials", out)
            mock_req.assert_not_called()

    def test_returns_http_501_status_headers_and_body_without_error_prefix(self):
        fake_resp = SimpleNamespace(
            status_code=501,
            reason="Not Implemented",
            headers={"content-type": "application/json"},
            content=b'{"error":"MethodNotImplemented"}',
            text='{"error":"MethodNotImplemented"}',
        )
        with patch("requests.request", return_value=fake_resp):
            out = http_probe("https://public.api.bsky.app/xrpc/chat.bsky.convo.getConvoForMembers")
        self.assertTrue(out.startswith("[HTTP 501 Not Implemented] GET https://"))
        self.assertIn("content-type: application/json", out)
        self.assertIn("MethodNotImplemented", out)
        self.assertFalse(out.startswith("Error:"))

    def test_registered_in_web_band_and_tools_module(self):
        from core import openhands_harness
        import tools.tools as tools_mod

        openhands_harness.register_sanctuary_openhands_tools()
        self.assertEqual(openhands_harness.HttpProbeTool.name, "http_probe")
        self.assertTrue(callable(getattr(tools_mod, "http_probe", None)))


if __name__ == "__main__":
    unittest.main()
