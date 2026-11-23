"""Verification suite for the OpenHands + GreenPT coding and subagent bridge."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

# Disable background services BEFORE importing Sanctuary backend modules
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

import setup_env
import state as st
import app as app_mod
from core import program_config
from runners import openhands_server
from tools import openhands_job, openhands_worker, tools as tools_mod
from utils import lifecycle, utils as utils_mod


def _git_init(ws: Path) -> None:
    subprocess.run(["git", "init"], cwd=ws, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.email", "test@sanctuary.local"], cwd=ws, capture_output=True, check=True)
    subprocess.run(["git", "config", "user.name", "Sanctuary Test"], cwd=ws, capture_output=True, check=True)
    (ws / "README.txt").write_text("init\n", encoding="utf-8")
    subprocess.run(["git", "add", "README.txt"], cwd=ws, capture_output=True, check=True)
    subprocess.run(["git", "commit", "-m", "initial"], cwd=ws, capture_output=True, check=True)


def verify_antigravity_purge_and_dependencies() -> None:
    assert not (SANCTUARY_DIR / "tools" / "antigravity_job.py").exists()
    assert not (REPO_ROOT / "__tests__" / "backend" / "test_antigravity_bridge.py").exists()

    req_txt = (REPO_ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "google-antigravity" not in req_txt
    for pkg in ("openhands-sdk", "openhands-tools", "openhands-agent-server"):
        assert pkg in req_txt, f"Missing dependency in requirements.txt: {pkg}"

    specs = set(setup_env.REQUIRED_IMPORT_SPECS)
    assert "openhands.sdk" in specs
    assert "openhands.tools" in specs
    assert "openhands.agent_server" in specs
    assert all("antigravity" not in s.lower() for s in specs)

    for py_path in SANCTUARY_DIR.rglob("*.py"):
        text = py_path.read_text(encoding="utf-8", errors="ignore")
        assert "antigravity_job" not in text, f"Stale antigravity_job reference in {py_path}"

    # Verify shutdown hook targets openhands_job & openhands_server cleanly
    lc_src = (SANCTUARY_DIR / "utils" / "lifecycle.py").read_text(encoding="utf-8")
    assert "cancel_all_openhands_jobs" in lc_src
    assert "stop_openhands_server" in lc_src


def verify_tool_aliases_and_emulated_normalization() -> None:
    for alias in (
        "openhands_code",
        "code_with_openhands",
        "delegate_subagent",
        "antigravity_code",
        "code_with_antigravity",
        "run_coding_task",
    ):
        assert utils_mod._normalize_tool_name(alias) == "delegate_coding", alias

    with mock.patch.object(tools_mod, "delegate_coding", return_value="OK_DELEGATED") as m_del:
        _, out1 = utils_mod._execute_emulated_tool(
            "openhands_code", 'instruction="Inspect repo", cwd="C:/Repo"'
        )
        assert out1 == "OK_DELEGATED"
        m_del.assert_called_once_with(path="C:/Repo", task="Inspect repo")

        m_del.reset_mock()
        _, out2 = utils_mod._execute_emulated_tool(
            "delegate_coding", 'task="Run checks", path="C:/Repo", model="flash", subagent="verifier", resume=False'
        )
        assert out2 == "OK_DELEGATED"
        m_del.assert_called_once_with(
            task="Run checks", path="C:/Repo", model="flash", subagent="verifier", resume=False
        )


def verify_models_greenpt_config_and_agents_md() -> None:
    assert openhands_job.resolve_openhands_model("auto") == ("glm-5.3", "openai/glm-5.3")
    assert openhands_job.resolve_openhands_model("flash") == ("glm-5.3-flash", "openai/glm-5.3-flash")
    assert openhands_job.resolve_openhands_model("kimi") == ("kimi-k3.1-pro", "openai/kimi-k3.1-pro")
    assert openhands_job.resolve_openhands_model("gemini-2.5-pro") == ("glm-5.3", "openai/glm-5.3")
    assert openhands_job.resolve_openhands_model("ollama/qwen3-coder") == (
        "qwen3-coder",
        "ollama/qwen3-coder",
    )

    tmp = Path(tempfile.mkdtemp(prefix="oh_cfg_"))
    try:
        tmp_settings = tmp / "project_settings.json"
        tmp_settings.write_text(
            json.dumps(
                {
                    "greenpt_api_key": "",
                    "greenpt_base_url": "https://api.us.greenpt.ai/v1",
                    "openhands_model": "deepseek-v4.1-flash-1017",
                    "openhands_mode": "server",
                    "openhands_server_port": 8099,
                    "openhands_auto_start_server": True,
                    "security_preset": "ask_always",
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.object(openhands_job, "_PROJECT_SETTINGS_PATH", str(tmp_settings)), mock.patch.dict(
            os.environ, {"GREENPT_API_KEY": ""}, clear=False
        ):
            cfg = openhands_job.resolve_greenpt_config()
            assert cfg["base_url"] == "https://api.us.greenpt.ai/v1"
            assert cfg["raw_model"] == "deepseek-v4.1-flash-1017"
            assert cfg["litellm_model"] == "openai/deepseek-v4.1-flash-1017"
            assert cfg["mode"] == "server"
            assert cfg["server_port"] == 8099
            assert cfg["auto_start_server"] is True

            # Missing key returns actionable guidance instead of raising
            msg = openhands_job.delegate_coding(task="Hello", path=str(tmp))
            assert "Cloud API key is not configured" in msg

        # Verify worker-coop / OpenAI-compatible custom /v1 endpoint support
        tmp_settings.write_text(
            json.dumps(
                {
                    "greenpt_api_key": "coop-cloud-token",
                    "greenpt_base_url": "https://llm.coop-cloud.example/v1/",
                    "openhands_model": "glm-5.3",
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.object(openhands_job, "_PROJECT_SETTINGS_PATH", str(tmp_settings)):
            cfg2 = openhands_job.resolve_greenpt_config()
            assert cfg2["base_url"] == "https://llm.coop-cloud.example/v1"
            assert cfg2["api_key"] == "coop-cloud-token"

        # Verify compile_program_agents_md compiles <program_dir>/AGENTS.md
        prog_dir = tmp / "programs" / "coop_prog"
        prog_dir.mkdir(parents=True)
        (prog_dir / "coop_prog.json").write_text(
            json.dumps({"name": "Sebile", "personality": "Direct solidarity engineer"}),
            encoding="utf-8",
        )
        with mock.patch.object(program_config, "PROGRAMS_DIR", str(tmp / "programs")):
            compiled_md = program_config.compile_program_agents_md("coop_prog")
            agents_file = prog_dir / "AGENTS.md"
            assert agents_file.is_file()
            disk_content = agents_file.read_text(encoding="utf-8")
            assert disk_content == compiled_md
            for expected in ("TaskToolSet", "researcher", "implementer", "verifier", "Sebile"):
                assert expected in compiled_md, f"Missing '{expected}' in compiled AGENTS.md"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify_subagent_registration() -> None:
    from openhands.sdk.subagent import get_registered_agent_definitions

    tmp = Path(tempfile.mkdtemp(prefix="oh_sub_"))
    try:
        agents_dir = tmp / ".agents" / "agents"
        agents_dir.mkdir(parents=True)
        (agents_dir / "custom_coop_auditor.md").write_text(
            "---\n"
            "name: custom_coop_auditor\n"
            "description: Audits worker-coop repositories.\n"
            "tools:\n"
            "  - file_editor\n"
            "---\n\n"
            "Inspect licenses and cooperative governance files only.\n",
            encoding="utf-8",
        )
        openhands_worker.register_sanctuary_subagents(str(tmp))
        names = {d.name for d in get_registered_agent_definitions()}
        for required in (
            "researcher",
            "implementer",
            "verifier",
            "code-explorer",
            "bash-runner",
            "general-purpose",
            "custom_coop_auditor",
        ):
            assert required in names, f"Missing registered subagent '{required}' in {sorted(names)}"
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _start_mock_greenpt_server(target_file: Path, scenario_state: dict):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            return

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            scenario_state["requests"].append(
                {"path": self.path, "headers": dict(self.headers), "body": body}
            )
            messages = body.get("messages") or []
            tools = body.get("tools") or []
            last_user = ""
            for m in reversed(messages):
                if m.get("role") == "user":
                    content = m.get("content")
                    if isinstance(content, list):
                        last_user = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
                    else:
                        last_user = str(content or "")
                    break

            # Program decision broker request (_sebile_decide fallback to GreenPT)
            if not tools and "Agent Question:" in last_user:
                reply = {
                    "id": "chatcmpl-decide",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": body.get("model") or "glm-5.3",
                    "choices": [
                        {
                            "index": 0,
                            "finish_reason": "stop",
                            "message": {
                                "role": "assistant",
                                "content": "1. Yes — include the concise docstring.",
                            },
                        }
                    ],
                    "usage": {"prompt_tokens": 12, "completion_tokens": 8, "total_tokens": 20},
                }
                self._send_json(200, reply)
                return

            mode = scenario_state.get("mode", "create_and_ask")
            if mode == "slow_hang":
                scenario_state["hang_started"].set()
                scenario_state["hang_release"].wait(timeout=15.0)
                self._send_json(
                    200,
                    {
                        "id": "chatcmpl-hang",
                        "object": "chat.completion",
                        "created": int(time.time()),
                        "model": "glm-5.3",
                        "choices": [
                            {
                                "index": 0,
                                "finish_reason": "stop",
                                "message": {"role": "assistant", "content": "cancelled late"},
                            }
                        ],
                    },
                )
                return

            tool_msgs = [m for m in messages if m.get("role") == "tool"]
            secret = scenario_state.get("secret", "sk_secret_redact_me")

            if mode == "deny_terminal":
                if not tool_msgs:
                    denied_path = str(target_file.parent / "denied.txt")
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_deny_1",
                                "type": "function",
                                "function": {
                                    "name": "terminal",
                                    "arguments": json.dumps({"command": f"echo no > \"{denied_path}\""}),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                else:
                    msg = {
                        "role": "assistant",
                        "content": "Understood — terminal command was denied and skipped.",
                    }
                    finish_reason = "stop"
            else:
                if len(tool_msgs) == 0:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_create_1",
                                "type": "function",
                                "function": {
                                    "name": "file_editor",
                                    "arguments": json.dumps(
                                        {
                                            "command": "create",
                                            "path": str(target_file),
                                            "file_text": "def coop_hello():\n    return 'green'\n",
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                elif len(tool_msgs) == 1:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_ask_1",
                                "type": "function",
                                "function": {
                                    "name": "ask_user",
                                    "arguments": json.dumps(
                                        {
                                            "question": "Should I keep this docstring in coop_hello?",
                                            "options": [
                                                {
                                                    "label": "Yes",
                                                    "consequence": "Keep the file concise and documented.",
                                                },
                                                {
                                                    "label": "No",
                                                    "consequence": "Leave minimal stub.",
                                                },
                                            ],
                                            "recommended": 0,
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                else:
                    msg = {
                        "role": "assistant",
                        "content": f"Created {target_file.name} via GreenPT (leaked_token={secret}).",
                    }
                    finish_reason = "stop"

            self._send_json(
                200,
                {
                    "id": f"chatcmpl-{len(scenario_state['requests'])}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": "glm-5.3",
                    "choices": [{"index": 0, "finish_reason": finish_reason, "message": msg}],
                    "usage": {"prompt_tokens": 20, "completion_tokens": 12, "total_tokens": 32},
                },
            )

        def _send_json(self, code: int, payload: dict):
            raw = json.dumps(payload).encode("utf-8")
            try:
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)
            except OSError:
                pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def verify_cli_worker_hitl_and_decision_broker() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="oh_cli_"))
    ws = tmp / "repo"
    ws.mkdir(parents=True)
    _git_init(ws)
    target_file = ws / "coop_hello.py"
    secret = "sk_secret_redact_me"

    state = {
        "mode": "create_and_ask",
        "secret": secret,
        "requests": [],
        "hang_started": threading.Event(),
        "hang_release": threading.Event(),
    }
    srv = _start_mock_greenpt_server(target_file, state)
    base_url = f"http://127.0.0.1:{srv.server_address[1]}/v1"

    tmp_settings = tmp / "project_settings.json"
    tmp_settings.write_text(
        json.dumps(
            {
                "folders": [str(ws)],
                "greenpt_api_key": secret,
                "greenpt_base_url": base_url,
                "openhands_model": "glm-5.3",
                "openhands_mode": "cli",
                "security_preset": "ask_always",
            }
        ),
        encoding="utf-8",
    )

    stop_watcher = threading.Event()
    hitl_decisions = {"seen_tools": [], "action": "approved"}

    def _hitl_watcher():
        while not stop_watcher.is_set():
            for cid, info in list(tools_mod.pending_tool_calls.items()):
                if info.get("status") == "pending":
                    hitl_decisions["seen_tools"].append(info.get("tool_name"))
                    info["status"] = hitl_decisions["action"]
                    info["event"].set()
            time.sleep(0.05)

    watcher = threading.Thread(target=_hitl_watcher, daemon=True)
    watcher.start()

    orig_runs = openhands_job._RUNS_DIR
    orig_pers = openhands_job._PERSISTENCE_ROOT
    try:
        openhands_job._RUNS_DIR = str(tmp / "runs")
        openhands_job._PERSISTENCE_ROOT = str(tmp / "pers")
        tools_mod.session_tool_calls.clear()
        openhands_job._DELEGATED_TOOL_CALLS.clear()
        st.cancelled_sessions.discard("cli_test_sess")

        with mock.patch.object(openhands_job, "_PROJECT_SETTINGS_PATH", str(tmp_settings)), mock.patch.object(
            openhands_job, "LOCAL_SERVER_URL", "http://127.0.0.1:1/offline/v1/chat/completions"
        ), mock.patch.object(program_config, "PROGRAMS_DIR", str(SANCTUARY_DIR / "core" / "programs")):
            # Mock _load_settings in tools.tools -> ask_always
            with mock.patch("runners.program._load_settings", return_value={"security_preset": "ask_always"}):
                digest = openhands_job.delegate_coding(
                    task="Create coop_hello.py and confirm docstring.",
                    path=str(ws),
                    model="auto",
                    mode="cli",
                    session_id="cli_test_sess",
                )

                assert "[OPENHANDS DELEGATION DIGEST]" in digest, digest
                assert "Mode: cli" in digest, digest
                assert "Status: completed" in digest, digest
                assert "Decision rounds: 1" in digest, digest
                assert "coop_hello.py" in digest, digest
                assert secret not in digest, "API key leaked into digest!"
                assert "[REDACTED]" in digest, digest
                assert target_file.is_file(), "file_editor failed to create coop_hello.py"
                assert "openhands:file_editor" in hitl_decisions["seen_tools"]

                # Confirm delegated tool calls captured for both runner history and live polling
                live = tools_mod.session_tool_calls.get("cli_test_sess", [])
                live_names = [e.get("name") for e in live]
                assert "openhands:file_editor" in live_names, live_names
                assert "openhands:decision" in live_names, live_names

                consumed = openhands_job.consume_delegated_tool_calls("cli_test_sess")
                consumed_names = [e.get("name") for e in consumed]
                assert "openhands:file_editor" in consumed_names, consumed_names
                assert "openhands:decision" in consumed_names, consumed_names
                assert openhands_job.consume_delegated_tool_calls("cli_test_sess") == []

                # Verify HITL denial blocks terminal command execution cleanly
                state["mode"] = "deny_terminal"
                hitl_decisions["seen_tools"].clear()
                hitl_decisions["action"] = "denied"
                deny_digest = openhands_job.delegate_coding(
                    task="Write denied.txt via terminal",
                    path=str(ws),
                    mode="cli",
                    resume=False,
                    session_id="cli_deny_sess",
                )
                assert "Status: completed" in deny_digest, deny_digest
                assert not (ws / "denied.txt").exists(), "Denied terminal command executed!"
                assert "openhands:terminal" in hitl_decisions["seen_tools"]

                # Verify cancel_session_work terminates live hanging subprocess cleanly
                state["mode"] = "slow_hang"
                cancel_result = {}

                def _run_cancel_target():
                    cancel_result["digest"] = openhands_job.delegate_coding(
                        task="Hang until cancelled",
                        path=str(ws),
                        mode="cli",
                        resume=False,
                        session_id="cancel_sess",
                    )

                t = threading.Thread(target=_run_cancel_target, daemon=True)
                t.start()
                assert state["hang_started"].wait(timeout=10.0), "Worker never reached mock server"
                cancelled = st.cancel_session_work("cancel_sess")
                assert cancelled is True
                t.join(timeout=8.0)
                assert not t.is_alive(), "Cancelled worker thread did not exit!"
                assert "Status: cancelled" in cancel_result.get("digest", ""), cancel_result
                state["hang_release"].set()
                st.cancelled_sessions.discard("cancel_sess")
    finally:
        stop_watcher.set()
        openhands_job._RUNS_DIR = orig_runs
        openhands_job._PERSISTENCE_ROOT = orig_pers
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)


def verify_server_mode_routes_and_config() -> None:
    from openhands.agent_server.config import Config

    tmp = Path(tempfile.mkdtemp(prefix="oh_srv_"))
    ws = tmp / "ws"
    ws.mkdir(parents=True)

    orig_data_dir = openhands_server.DATA_DIR
    orig_creds_path = openhands_server._CREDENTIALS_PATH
    orig_cfg_path = openhands_server._CONFIG_PATH
    try:
        data_dir = tmp / "server_data"
        openhands_server.DATA_DIR = str(data_dir)
        openhands_server._CREDENTIALS_PATH = str(data_dir / "credentials.json")
        openhands_server._CONFIG_PATH = str(data_dir / "config.json")

        cfg_file = openhands_server.write_agent_server_config(str(ws), 8091)
        parsed = Config.model_validate_json(Path(cfg_file).read_text(encoding="utf-8"))
        creds = openhands_server.get_or_create_server_credentials()
        assert creds["session_api_key"] in parsed.session_api_keys
        assert os.path.normcase(parsed.workspace_path) == os.path.normcase(str(ws))
        assert parsed.enable_browser is False

        # Mock HTTP OpenHands Agent Server validating profiles sync + /v1/chat/completions continuity
        srv_state = {
            "saved_llm": None,
            "activated_llm": False,
            "saved_agent": None,
            "activated_agent_id": None,
            "chat_headers": [],
            "conv_counter": 0,
        }

        class MockAgentServerHandler(BaseHTTPRequestHandler):
            def log_message(self, fmt, *args):
                return

            def do_GET(self):
                if self.path == "/ready":
                    self._send_json(200, {"ready": True})
                elif self.path == "/api/agent-profiles":
                    self._send_json(
                        200,
                        {"profiles": [{"id": "prof-uuid-123", "name": "sanctuary_greenpt"}]},
                    )
                else:
                    self._send_json(404, {"error": "not found"})

            def do_POST(self):
                length = int(self.headers.get("Content-Length") or "0")
                raw = self.rfile.read(length).decode("utf-8") if length else "{}"
                body = json.loads(raw)

                if self.path == "/api/profiles/greenpt":
                    srv_state["saved_llm"] = body
                    self._send_json(201, {"name": "greenpt", "message": "saved"})
                elif self.path == "/api/profiles/greenpt/activate":
                    srv_state["activated_llm"] = True
                    self._send_json(200, {"name": "greenpt", "llm_applied": True})
                elif self.path == "/api/agent-profiles/sanctuary_greenpt":
                    srv_state["saved_agent"] = body
                    self._send_json(201, {"name": "sanctuary_greenpt", "message": "saved"})
                elif self.path == "/api/agent-profiles/prof-uuid-123/activate":
                    srv_state["activated_agent_id"] = "prof-uuid-123"
                    self._send_json(200, {"id": "prof-uuid-123", "message": "activated"})
                elif self.path == "/v1/chat/completions":
                    srv_state["chat_headers"].append(
                        {
                            "auth": self.headers.get("Authorization"),
                            "cid": self.headers.get("X-OpenHands-ServerConversation-ID"),
                        }
                    )
                    cid = self.headers.get("X-OpenHands-ServerConversation-ID")
                    if not cid:
                        srv_state["conv_counter"] += 1
                        cid = f"conv-{srv_state['conv_counter']}"
                    self._send_json(
                        200,
                        {
                            "id": "chatcmpl-srv-1",
                            "object": "chat.completion",
                            "created": int(time.time()),
                            "model": body.get("model"),
                            "choices": [
                                {
                                    "index": 0,
                                    "finish_reason": "stop",
                                    "message": {
                                        "role": "assistant",
                                        "content": f"Server OK ({cid})",
                                    },
                                }
                            ],
                        },
                        extra_headers={"X-OpenHands-ServerConversation-ID": cid},
                    )
                else:
                    self._send_json(404, {"error": self.path})

            def _send_json(self, code: int, payload: dict, extra_headers: dict | None = None):
                raw = json.dumps(payload).encode("utf-8")
                try:
                    self.send_response(code)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(raw)))
                    for k, v in (extra_headers or {}).items():
                        self.send_header(k, v)
                    self.end_headers()
                    self.wfile.write(raw)
                except OSError:
                    pass

        mock_srv = ThreadingHTTPServer(("127.0.0.1", 0), MockAgentServerHandler)
        threading.Thread(target=mock_srv.serve_forever, daemon=True).start()
        srv_port = mock_srv.server_address[1]

        tmp_settings = tmp / "project_settings.json"
        tmp_settings.write_text(
            json.dumps(
                {
                    "folders": [str(ws)],
                    "greenpt_api_key": "sk-greenpt-srv-key",
                    "greenpt_base_url": "https://api.greenpt.ai/v1",
                    "openhands_model": "glm-5.3",
                    "openhands_mode": "server",
                    "openhands_server_port": srv_port,
                    "security_preset": "auto",
                }
            ),
            encoding="utf-8",
        )
        try:
            with mock.patch.object(openhands_job, "_PROJECT_SETTINGS_PATH", str(tmp_settings)), mock.patch(
                "runners.program._load_settings", return_value={"security_preset": "auto"}
            ):
                sync_res = openhands_server.sync_greenpt_profiles(port=srv_port)
                assert sync_res["synced"] is True
                assert srv_state["activated_llm"] is True
                assert srv_state["activated_agent_id"] == "prof-uuid-123"
                assert srv_state["saved_llm"]["llm"]["model"] == "openai/glm-5.3"
                assert srv_state["saved_llm"]["llm"]["base_url"] == "https://api.greenpt.ai/v1"

                d1 = openhands_job.delegate_coding(
                    task="Turn 1 in server mode",
                    path=str(ws),
                    mode="server",
                    subagent="implementer",
                    session_id="srv_sess",
                )
                assert "Mode: server" in d1 and "Server OK (conv-1)" in d1, d1

                d2 = openhands_job.delegate_coding(
                    task="Turn 2 reuse conversation",
                    path=str(ws),
                    mode="server",
                    resume=True,
                    session_id="srv_sess",
                )
                assert "Server OK (conv-1)" in d2, d2
                assert srv_state["chat_headers"][1]["cid"] == "conv-1"
                assert srv_state["chat_headers"][1]["auth"] == f"Bearer {creds['session_api_key']}"

                d3 = openhands_job.delegate_coding(
                    task="Turn 3 fresh conversation",
                    path=str(ws),
                    mode="server",
                    resume=False,
                    session_id="srv_sess",
                )
                assert "Server OK (conv-2)" in d3, d3
        finally:
            mock_srv.shutdown()
            mock_srv.server_close()

        # Verify Flask /api/project_settings migration + /api/openhands/server routes
        fake_base = tmp / "flask_base"
        (fake_base / "variables").mkdir(parents=True)
        ps_path = fake_base / "variables" / "project_settings.json"
        ps_path.write_text(
            json.dumps(
                {
                    "folders": [str(ws)],
                    "gemini_api_key": "stale_AIza_key",
                    "security_preset": "ask_always",
                }
            ),
            encoding="utf-8",
        )
        client = app_mod.app.test_client()
        orig_base = st.base_dir
        orig_env = {
            k: os.environ.get(k)
            for k in (
                "GREENPT_API_KEY",
                "GREENPT_BASE_URL",
                "OPENHANDS_MODEL",
                "OPENHANDS_MODE",
                "OPENHANDS_SERVER_PORT",
                "OPENHANDS_AUTO_START_SERVER",
            )
        }
        try:
            st.base_dir = fake_base
            with mock.patch("routes.system.vs.VARIABLES_DIR", str(fake_base / "variables")), mock.patch.object(
                openhands_job, "_PROJECT_SETTINGS_PATH", str(ps_path)
            ):
                get_res = client.get("/api/project_settings")
                assert get_res.status_code == 200
                gjson = get_res.get_json()
                assert "gemini_api_key" not in gjson
                assert gjson["greenpt_base_url"] == "https://api.greenpt.ai/v1"
                assert gjson["openhands_model"] == "glm-5.3"
                assert gjson["openhands_mode"] == "auto"
                assert gjson["routing_policy"] == "auto"

                post_res = client.post(
                    "/api/project_settings",
                    json={
                        "folders": [str(ws)],
                        "greenpt_api_key": "sk-flask-greenpt",
                        "greenpt_base_url": "https://api.us.greenpt.ai/v1",
                        "openhands_model": "kimi-k3.1-pro",
                        "openhands_mode": "server",
                        "openhands_server_port": 8095,
                        "openhands_auto_start_server": False,
                    },
                )
                assert post_res.status_code == 200
                pjson = post_res.get_json()
                assert pjson["status"] == "success"
                assert pjson["settings"]["greenpt_api_key"] == "sk-flask-greenpt"
                assert pjson["settings"]["openhands_mode"] == "server"
                assert pjson["settings"]["openhands_server_port"] == 8095
                assert os.environ.get("GREENPT_BASE_URL") == "https://api.us.greenpt.ai/v1"
                assert os.path.normpath(pjson["settings"]["folders"][0]) == os.path.normpath(str(ws))

                # Verify tools.set_working_folder updates folders[0] cleanly
                from tools import tools as tools_mod

                ws2 = tmp / "ws_custom_2"
                ws2.mkdir(parents=True)
                orig_confirm = tools_mod.confirm_tool_execution
                tools_mod.confirm_tool_execution = lambda *a, **kw: True
                try:
                    real_vars_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(tools_mod.__file__))), "variables")
                    real_ps = os.path.join(real_vars_dir, "project_settings.json")
                    prev_ps_bytes = open(real_ps, "rb").read() if os.path.isfile(real_ps) else None
                    try:
                        res_msg = tools_mod.set_working_folder(path=str(ws2))
                        assert "Default working folder set to" in res_msg
                        saved_ps = json.loads(open(real_ps, "r", encoding="utf-8").read())
                        assert os.path.normpath(saved_ps["folders"][0]) == os.path.normpath(str(ws2))
                    finally:
                        if prev_ps_bytes is not None:
                            open(real_ps, "wb").write(prev_ps_bytes)
                finally:
                    tools_mod.confirm_tool_execution = orig_confirm

                srv_get = client.get("/api/openhands/server")
                assert srv_get.status_code == 200
                sjson = srv_get.get_json()
                assert sjson["success"] is True
                assert sjson["model_id"] == "openhands_greenpt"
        finally:
            st.base_dir = orig_base
            for k, v in orig_env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
    finally:
        openhands_server.DATA_DIR = orig_data_dir
        openhands_server._CREDENTIALS_PATH = orig_creds_path
        openhands_server._CONFIG_PATH = orig_cfg_path
        shutil.rmtree(tmp, ignore_errors=True)


def verify_workspace_grounding_and_resume_fallback() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="oh_gnd_"))
    ws = tmp / "repo"
    (ws / "web" / "app").mkdir(parents=True)
    (ws / ".agents" / "skills" / "demo_skill").mkdir(parents=True)
    (ws / ".agents" / "skills" / "demo_skill" / "SKILL.md").write_text(
        "---\nname: demo_skill\ndescription: Demo architecture skill.\n---\n# Demo\n",
        encoding="utf-8",
    )
    (ws / "package.json").write_text('{"name":"demo"}\n', encoding="utf-8")
    (ws / "__tests__" / "backend").mkdir(parents=True)
    _git_init(ws)

    try:
        with mock.patch.object(tools_mod, "get_project_folders", return_value=[str(ws)]):
            root, focus, warn = tools_mod.resolve_coding_workspace("src/browser/ui")
            assert os.path.normcase(root) == os.path.normcase(str(ws))
            assert focus == ""
            assert "does not exist" in warn and "web" in warn

            root2, focus2, warn2 = tools_mod.resolve_coding_workspace("web/app")
            assert os.path.normcase(root2) == os.path.normcase(str(ws))
            assert focus2 == "web/app"
            assert warn2 == ""

        block = openhands_worker.build_workspace_grounding_block(
            str(ws), focus_path="web/app", path_warning=warn
        )
        assert "git grep -n" in block
        assert "demo_skill" in block
        assert "web/app" in block
        assert "node --test" in block
        assert "do NOT prefix terminal commands with `cd`" in block

        # _is_readonly_action allows `cd <ws>; git grep ...` in Plan mode
        from types import SimpleNamespace
        ro_cd_event = SimpleNamespace(
            tool_name="terminal",
            action=SimpleNamespace(command=f"cd {ws}; git grep -n demo_skill"),
        )
        assert openhands_worker._is_readonly_action(ro_cd_event) is True

        # validate_structured_mutation_plan enforces all 4 pre-mutation fields
        ok_bad, missing_bad = openhands_worker.validate_structured_mutation_plan("Just fix it quickly.")
        assert ok_bad is False
        assert set(missing_bad) == {"intent", "files_to_touch", "exact_diff", "how_I_will_verify"}

        ok_good, missing_good = openhands_worker.validate_structured_mutation_plan(
            "intent: Fix feed\nfiles_to_touch: web/app/feed.js\nexact_diff: update x\nhow_I_will_verify: node --test"
        )
        assert ok_good is True
        assert missing_good == []

        class _FakeConv:
            calls = []

            def __init__(self, **kw):
                _FakeConv.calls.append(dict(kw))
                if kw.get("persistence_dir") or kw.get("conversation_id"):
                    raise ValueError("Cannot resume conversation: tools were removed mid-conversation")
                self.id = "fresh-uuid"

        conv = openhands_worker._create_conversation_with_fallback(
            _FakeConv,
            persistence_dir=str(tmp / "pers"),
            conversation_id="old-cid",
            delete_on_close=False,
        )
        assert conv.id == "fresh-uuid"
        assert len(_FakeConv.calls) == 2
        assert _FakeConv.calls[1]["persistence_dir"] is None
        assert _FakeConv.calls[1]["delete_on_close"] is True
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify_staged_plan_execute_verify_and_worktree() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="oh_stg_"))
    ws = tmp / "repo"
    ws.mkdir(parents=True)
    _git_init(ws)
    target_file = ws / "app_feature.py"
    seen_models: list[str] = []
    stage_state = {"calls": 0, "fail_verify_once": True}

    class StagedMockHandler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            return

        def do_POST(self):
            length = int(self.headers.get("Content-Length", "0") or "0")
            body = json.loads(self.rfile.read(length).decode("utf-8"))
            model_name = str(body.get("model") or "")
            seen_models.append(model_name)
            messages = body.get("messages") or []
            user_joined = "\n".join(str(m.get("content") or "") for m in messages if m.get("role") == "user")
            tool_msgs = [m for m in messages if m.get("role") == "tool"]

            if "## Stage 1:" in user_joined:
                if len(tool_msgs) == 0:
                    # Attempt a forbidden mutating create during Stage 1 to verify read-only guard rejects it
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "s1_bad_write",
                                "type": "function",
                                "function": {
                                    "name": "file_editor",
                                    "arguments": json.dumps(
                                        {
                                            "command": "create",
                                            "path": str(ws / "should_not_exist.py"),
                                            "file_text": "bad = 1\n",
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                else:
                    msg = {
                        "role": "assistant",
                        "content": (
                            "## Code Map\n- `README.txt#L1`\n\n"
                            "## Steps\n1. Create app_feature.py\n2. Verify feature output\n\n"
                            "## Exact Changes\nCreate `app_feature.py` returning `'ok'`.\n\n"
                            "## Verification Command\n`python -c \"import app_feature\"`\n\n"
                            "## Re-plan if\n- Import fails."
                        ),
                    }
                    finish_reason = "stop"
            elif "## Stage 2:" in user_joined:
                if len(tool_msgs) == 0:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "s2_create",
                                "type": "function",
                                "function": {
                                    "name": "file_editor",
                                    "arguments": json.dumps(
                                        {
                                            "command": "create",
                                            "path": str(target_file),
                                            "file_text": "VALUE = 'draft'\n",
                                        }
                                    ),
                                },
                            },
                            {
                                "id": "s2_tmp",
                                "type": "function",
                                "function": {
                                    "name": "file_editor",
                                    "arguments": json.dumps(
                                        {
                                            "command": "create",
                                            "path": str(ws / "_tmp_leak.mjs"),
                                            "file_text": "console.log(1);\n",
                                        }
                                    ),
                                },
                            },
                        ],
                    }
                    finish_reason = "tool_calls"
                else:
                    msg = {"role": "assistant", "content": "Stage 2 created app_feature.py."}
                    finish_reason = "stop"
            elif "## Stage 3:" in user_joined:
                if stage_state["fail_verify_once"]:
                    stage_state["fail_verify_once"] = False
                    msg = {"role": "assistant", "content": "VERIFY_STATUS: FAIL\nExpected VALUE == 'ok'"}
                else:
                    msg = {"role": "assistant", "content": "VERIFY_STATUS: PASS\nVALUE == 'ok'"}
                finish_reason = "stop"
            else:
                # Stage 4 Deep Repair
                if len(tool_msgs) == 0:
                    msg = {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "s4_fix",
                                "type": "function",
                                "function": {
                                    "name": "file_editor",
                                    "arguments": json.dumps(
                                        {
                                            "command": "str_replace",
                                            "path": str(target_file),
                                            "old_str": "VALUE = 'draft'",
                                            "new_str": "VALUE = 'ok'",
                                        }
                                    ),
                                },
                            }
                        ],
                    }
                    finish_reason = "tool_calls"
                else:
                    msg = {"role": "assistant", "content": "VERIFY_STATUS: PASS\nFixed VALUE = 'ok'"}
                    finish_reason = "stop"

            raw = json.dumps(
                {
                    "id": f"cmpl-{len(seen_models)}",
                    "object": "chat.completion",
                    "created": int(time.time()),
                    "model": model_name or "glm-5.3",
                    "choices": [{"index": 0, "finish_reason": finish_reason, "message": msg}],
                    "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18},
                }
            ).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), StagedMockHandler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    base_url = f"http://127.0.0.1:{srv.server_address[1]}/v1"

    tmp_settings = tmp / "project_settings.json"
    tmp_settings.write_text(
        json.dumps(
            {
                "folders": [str(ws)],
                "greenpt_api_key": "sk-staged-test",
                "greenpt_base_url": base_url,
                "openhands_model": "glm-5.3",
                "openhands_mode": "cli",
                "security_preset": "auto",
            }
        ),
        encoding="utf-8",
    )

    orig_runs = openhands_job._RUNS_DIR
    orig_pers = openhands_job._PERSISTENCE_ROOT
    try:
        openhands_job._RUNS_DIR = str(tmp / "runs")
        openhands_job._PERSISTENCE_ROOT = str(tmp / "pers")
        tools_mod.session_tool_calls.clear()
        openhands_job._DELEGATED_TOOL_CALLS.clear()

        with mock.patch.object(openhands_job, "_PROJECT_SETTINGS_PATH", str(tmp_settings)), mock.patch.object(
            openhands_job, "LOCAL_SERVER_URL", "http://127.0.0.1:1/offline/v1/chat/completions"
        ), mock.patch.object(program_config, "PROGRAMS_DIR", str(SANCTUARY_DIR / "core" / "programs")), mock.patch(
            "runners.program._load_settings", return_value={"security_preset": "auto"}
        ), mock.patch(
            "core.greenpt_client.is_native_greenpt", return_value=True
        ):
            # 1. /plan mode stops after Stage 1 read-only planning and never creates files
            plan_digest = openhands_job.delegate_coding(
                task="Create app_feature.py",
                path=str(ws),
                workflow="plan",
                mode="cli",
                session_id="plan_sess",
            )
            assert "Workflow: plan" in plan_digest, plan_digest
            assert "Status: completed" in plan_digest, plan_digest
            assert not (ws / "should_not_exist.py").exists()
            assert not target_file.exists()

            # 2. Full staged workflow: Deep Plan -> Fast Exec -> Fast Verify (FAIL) -> Deep Repair (PASS)
            seen_models.clear()
            staged_digest = openhands_job.delegate_coding(
                task="Create app_feature.py",
                path=str(ws),
                workflow="staged",
                mode="cli",
                session_id="staged_sess",
            )
            assert "Workflow: staged" in staged_digest, staged_digest
            assert "VERIFY_STATUS: PASS" in staged_digest, staged_digest
            assert "app_feature.py" in staged_digest, staged_digest
            assert target_file.read_text(encoding="utf-8") == "VALUE = 'ok'\n"
            assert not (ws / "_tmp_leak.mjs").exists(), "Untracked _tmp_* file was not swept!"
            assert "glm-5.3" in seen_models and "glm-5.3-flash" in seen_models, seen_models
            live = tools_mod.session_tool_calls.get("staged_sess", [])
            assert any(e.get("phase") == "Reviewing" for e in live), live

            # 3. Worktree isolation on staged run
            target_file.unlink()
            subprocess.run(["git", "add", "-A"], cwd=ws, capture_output=True, check=True)
            stage_state["fail_verify_once"] = False
            iso_digest = openhands_job.delegate_coding(
                task="Create app_feature.py",
                path=str(ws),
                workflow="staged",
                isolate=True,
                mode="cli",
                session_id="iso_sess",
            )
            assert "(isolated worktree)" in iso_digest, iso_digest
            assert target_file.is_file(), "Verified isolated worktree file was not synced back!"
    finally:
        openhands_job._RUNS_DIR = orig_runs
        openhands_job._PERSISTENCE_ROOT = orig_pers
        srv.shutdown()
        srv.server_close()
        shutil.rmtree(tmp, ignore_errors=True)


def main() -> int:
    verify_antigravity_purge_and_dependencies()
    verify_tool_aliases_and_emulated_normalization()
    verify_models_greenpt_config_and_agents_md()
    verify_subagent_registration()
    verify_cli_worker_hitl_and_decision_broker()
    verify_server_mode_routes_and_config()
    verify_workspace_grounding_and_resume_fallback()
    verify_staged_plan_execute_verify_and_worktree()
    print("ALL test_openhands_bridge CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
