"""Verification suite for the unified in-process OpenHands + Git Bash coding harness."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"
os.environ["OPENHANDS_SUPPRESS_BANNER"] = "1"
os.environ["OH_TELEMETRY_CONSENT"] = "false"
os.environ.pop("AUTH_USER", None)
os.environ.pop("AUTH_PASS", None)

import dotenv

dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

import app as app_mod
from core import openhands_harness, v1_client
from tools import tools as tools_mod
from utils import utils as utils_mod


def verify_in_process_architecture_and_cleanup() -> None:
    assert not (SANCTUARY_DIR / "runners" / "openhands_server.py").exists()
    assert not (SANCTUARY_DIR / "tools" / "openhands_worker.py").exists()
    assert not (SANCTUARY_DIR / "tools" / "openhands_job.py").exists()
    assert "re" not in openhands_harness.__dict__

    lc_src = (SANCTUARY_DIR / "utils" / "lifecycle.py").read_text(encoding="utf-8")
    assert "cancel_all_coding_sessions" in lc_src

    for alias in (
        "delegate_coding",
        "openhands_code",
        "code_with_openhands",
        "delegate_subagent",
        "antigravity_code",
        "code_with_antigravity",
        "run_coding_task",
    ):
        assert utils_mod._normalize_tool_name(alias) == "delegate_coding", alias

    assert openhands_harness.GitBashTerminalTool.name == "terminal"
    assert openhands_harness.resolve_openhands_model("auto") == ("glm-5.3", "openai/glm-5.3")
    assert openhands_harness.resolve_openhands_model("flash") == ("glm-5.3-flash", "openai/glm-5.3-flash")
    assert openhands_harness.resolve_openhands_model("kimi") == ("kimi-k3.1-pro", "openai/kimi-k3.1-pro")
    assert openhands_harness.resolve_openhands_model("ollama/qwen3-coder") == (
        "qwen3-coder",
        "ollama/qwen3-coder",
    )


def verify_readonly_action_and_skills_filtering() -> None:
    assert openhands_harness.is_readonly_action(SimpleNamespace(tool_name="grep", action=None)) is True
    assert openhands_harness.is_readonly_action(SimpleNamespace(tool_name="glob", action=None)) is True
    assert openhands_harness.is_readonly_action(
        SimpleNamespace(tool_name="file_editor", action=SimpleNamespace(command="view"))
    ) is True
    assert openhands_harness.is_readonly_action(
        SimpleNamespace(tool_name="file_editor", action=SimpleNamespace(command="str_replace"))
    ) is False
    assert openhands_harness.is_readonly_action(
        SimpleNamespace(tool_name="terminal", action=SimpleNamespace(command="git status"))
    ) is True
    assert openhands_harness.is_readonly_action(
        SimpleNamespace(tool_name="terminal", action=SimpleNamespace(command="echo hi > out.txt"))
    ) is False

    disabled = openhands_harness.compute_disabled_project_skills(
        str(REPO_ROOT), "Fix Python backend bug in runner.py", focus_path="sanctuary/runners/runner.py"
    )
    assert "sanctuary-architecture" not in disabled

    from openhands.sdk.skills import load_project_skills

    loaded_names = {s.name for s in load_project_skills(str(REPO_ROOT))}
    for expected in (
        "browser-extensions",
        "git-and-forge",
        "modern-web-guidance",
        "multi-agent-workflow",
        "sanctuary-architecture",
    ):
        assert expected in loaded_names, f"Missing project skill {expected} in {sorted(loaded_names)}"
    assert "gemini:sanctuary/core/programs/sebile" not in loaded_names

    with tempfile.TemporaryDirectory() as tmpdir:
        ps = Path(tmpdir) / "project_settings.json"
        ps.write_text(json.dumps({"routing_policy": "auto", "openhands_model": "glm-5.3"}), encoding="utf-8")
        try:
            openhands_harness.resolve_v1_config(model="llm/foo.gguf", settings_path=str(ps))
            raise AssertionError("Expected ValueError for .gguf model under non-local_only routing_policy")
        except ValueError:
            pass


def verify_plan_readonly_ask_always_and_isolate_worktree() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="oh_inproc_"))
    repo = tmp / "repo"
    repo.mkdir(parents=True)
    subprocess.run(["git", "init"], cwd=str(repo), capture_output=True, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=str(repo), capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "Test"], cwd=str(repo), capture_output=True, check=True)
    app_py = repo / "app.py"
    app_py.write_text("VAL = 1\n", encoding="utf-8")
    subprocess.run(["git", "add", "app.py"], cwd=str(repo), capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "init"], cwd=str(repo), capture_output=True, check=True)

    scenario = {"mode": "plan"}

    class MockV1Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            return

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            msgs = body.get("messages") or []
            tool_count = sum(1 for m in msgs if m.get("role") == "tool")

            if scenario["mode"] == "plan":
                if tool_count == 0:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "p1",
                            "type": "function",
                            "function": {
                                "name": "file_editor",
                                "arguments": json.dumps({
                                    "command": "str_replace",
                                    "path": str(app_py),
                                    "old_str": "VAL = 1",
                                    "new_str": "VAL = 2",
                                }),
                            },
                        }],
                    }
                else:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "p2",
                            "type": "function",
                            "function": {
                                "name": "finish",
                                "arguments": json.dumps({"message": "```sanctuary-plan\n## Step 1\nUpdate VAL\n```"}),
                            },
                        }],
                    }
            elif scenario["mode"] == "deny":
                if tool_count == 0:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "d1",
                            "type": "function",
                            "function": {
                                "name": "file_editor",
                                "arguments": json.dumps({
                                    "command": "str_replace",
                                    "path": str(app_py),
                                    "old_str": "VAL = 1",
                                    "new_str": "VAL = 99",
                                }),
                            },
                        }],
                    }
                else:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "d2",
                            "type": "function",
                            "function": {
                                "name": "finish",
                                "arguments": json.dumps({"message": "Edit was denied by user."}),
                            },
                        }],
                    }
            else:
                msg = {
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "i1",
                        "type": "function",
                        "function": {
                            "name": "finish",
                            "arguments": json.dumps({"message": "Isolated check complete."}),
                        },
                    }],
                }

            raw = json.dumps({
                "id": "cmpl-1",
                "object": "chat.completion",
                "created": 1,
                "model": body.get("model"),
                "choices": [{"index": 0, "finish_reason": "tool_calls", "message": msg}],
            }).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), MockV1Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    ps = tmp / "project_settings.json"
    ps.write_text(
        json.dumps({
            "greenpt_api_key": "sk-bridge",
            "greenpt_base_url": f"http://127.0.0.1:{srv.server_address[1]}/v1",
            "routing_policy": "auto",
            "openhands_model": "glm-5.3",
            "security_preset": "ask_always",
        }),
        encoding="utf-8",
    )

    try:
        with (
            mock.patch.object(v1_client, "_SETTINGS_PATH", str(ps)),
            mock.patch.object(openhands_harness, "_PROJECT_SETTINGS_PATH", str(ps)),
            mock.patch.object(tools_mod, "resolve_coding_workspace", return_value=(str(repo), "", "")),
            mock.patch.object(tools_mod, "get_project_folders", return_value=[str(repo)]),
        ):
            # 1. /plan mode blocks mutation without prompting user
            plan_text, plan_tcs = openhands_harness.run_coding_turn(
                "Plan updating VAL",
                session_id="oh_plan_sess",
                is_plan_turn=True,
                settings_path=str(ps),
            )
            assert "sanctuary-plan" in plan_text
            assert app_py.read_text(encoding="utf-8") == "VAL = 1\n"
            assert any("Plan mode is strictly read-only" in str(tc.get("response") or "") for tc in plan_tcs)

            # 2. ask_always rejects mutation when user denies confirm_tool_execution
            scenario["mode"] = "deny"
            with mock.patch.object(tools_mod, "confirm_tool_execution", return_value=False) as m_conf:
                deny_text, _ = openhands_harness.run_coding_turn(
                    "Update VAL",
                    session_id="oh_deny_sess",
                    settings_path=str(ps),
                )
            assert m_conf.called
            assert "denied" in deny_text.lower()
            assert app_py.read_text(encoding="utf-8") == "VAL = 1\n"

            # 3. delegate_coding(isolate=True) creates and cleans up isolated worktree
            scenario["mode"] = "isolate"
            tok = tools_mod.current_session_id.set("oh_iso_sess")
            try:
                iso_out = openhands_harness.delegate_coding(task="Check repo", path=str(repo), isolate=True)
            finally:
                tools_mod.current_session_id.reset(tok)
            assert "Isolated check complete." in iso_out
            wt_list = subprocess.run(["git", "-C", str(repo), "worktree", "list"], capture_output=True, text=True)
            assert wt_list.stdout.strip().count("\n") == 0

            # 4. System settings route no longer exposes openhands_mode / openhands_server_port
            client = app_mod.app.test_client()
            resp = client.get("/api/openhands/server")
            assert resp.status_code == 404
    finally:
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    verify_in_process_architecture_and_cleanup()
    verify_readonly_action_and_skills_filtering()
    verify_plan_readonly_ask_always_and_isolate_worktree()
    print("ALL test_openhands_bridge CHECKS PASSED")
