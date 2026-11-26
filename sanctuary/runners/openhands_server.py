"""Managed OpenHands Agent Server lifecycle and OpenAI-compatible HTTP gateway."""

from __future__ import annotations

import json
import os
import secrets
import signal
import subprocess
import sys
import threading
import time
from typing import Any

import requests

from variables.settings import BASE_DIR as SANCTUARY_DIR
from runners.local_server import _win_no_window_kwargs
from utils.lifecycle import kill_process_tree

DATA_DIR = os.path.join(SANCTUARY_DIR, "data", "openhands", "server")
_CREDENTIALS_PATH = os.path.join(DATA_DIR, "credentials.json")
_CONFIG_PATH = os.path.join(DATA_DIR, "config.json")
_LOG_PATH = os.path.join(DATA_DIR, "agent_server.log")

_SERVER_LOCK = threading.Lock()
_SERVER_PROC: subprocess.Popen | None = None
_SERVER_LOG_HANDLE: Any = None
_ACTIVE_STATE: dict[str, Any] = {
    "port": None,
    "workspace_path": None,
}


def _default_workspace_path() -> str:
    from tools.openhands_job import resolve_greenpt_config

    cfg = resolve_greenpt_config()
    folders = cfg.get("folders") or []
    for folder in folders:
        if isinstance(folder, str) and os.path.isdir(folder):
            return os.path.abspath(folder)
    return os.path.abspath(os.path.dirname(SANCTUARY_DIR))


def _resolve_port(port: int | None = None) -> int:
    if isinstance(port, int) and 1024 <= port <= 65535:
        return port
    from tools.openhands_job import resolve_greenpt_config

    return int(resolve_greenpt_config().get("server_port") or 8091)


def get_or_create_server_credentials() -> dict[str, str]:
    """Load or create persistent session_api_key and secret_key for the local server."""
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.isfile(_CREDENTIALS_PATH):
        try:
            with open(_CREDENTIALS_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            if isinstance(data, dict) and data.get("session_api_key") and data.get("secret_key"):
                return {
                    "session_api_key": str(data["session_api_key"]),
                    "secret_key": str(data["secret_key"]),
                }
        except (OSError, json.JSONDecodeError):
            pass

    creds = {
        "session_api_key": secrets.token_urlsafe(32),
        "secret_key": secrets.token_urlsafe(32),
    }
    tmp_path = _CREDENTIALS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(creds, f, indent=2)
    os.replace(tmp_path, _CREDENTIALS_PATH)
    return creds


def write_agent_server_config(workspace_path: str, port: int) -> str:
    """Write openhands.agent_server Config JSON and return its path."""
    del port  # port is passed via CLI flags; workspace/auth live in config.json
    os.makedirs(DATA_DIR, exist_ok=True)
    conversations_dir = os.path.join(DATA_DIR, "conversations")
    bash_events_dir = os.path.join(DATA_DIR, "bash_events")
    os.makedirs(conversations_dir, exist_ok=True)
    os.makedirs(bash_events_dir, exist_ok=True)

    creds = get_or_create_server_credentials()
    cfg_payload = {
        "session_api_keys": [creds["session_api_key"]],
        "secret_key": creds["secret_key"],
        "workspace_path": os.path.abspath(workspace_path),
        "conversations_path": os.path.abspath(conversations_dir),
        "bash_events_dir": os.path.abspath(bash_events_dir),
        "enable_browser": False,
        "enable_vscode": False,
        "preload_tools": True,
        "telemetry": {"enabled": False},
    }
    tmp_path = _CONFIG_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(cfg_payload, f, indent=2)
    os.replace(tmp_path, _CONFIG_PATH)
    return _CONFIG_PATH


def check_openhands_server_status(port: int | None = None) -> bool:
    """Return True if the OpenHands Agent Server responds 200 on /ready."""
    resolved_port = _resolve_port(port)
    try:
        resp = requests.get(f"http://127.0.0.1:{resolved_port}/ready", timeout=1.5)
        return resp.status_code == 200
    except Exception:
        return False


def _kill_process_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    if os.name == "nt":
        try:
            proc.terminate()
            proc.wait(timeout=2.0)
            return
        except subprocess.TimeoutExpired:
            pass
        except Exception:
            pass
    kill_process_tree(proc, grace=2.0)


def _close_log_handle() -> None:
    global _SERVER_LOG_HANDLE
    if _SERVER_LOG_HANDLE is not None:
        try:
            _SERVER_LOG_HANDLE.close()
        except OSError:
            pass
        _SERVER_LOG_HANDLE = None


def stop_openhands_server() -> dict[str, Any]:
    """Terminate the managed OpenHands Agent Server subprocess if running."""
    with _SERVER_LOCK:
        global _SERVER_PROC
        proc = _SERVER_PROC
        port = _ACTIVE_STATE.get("port")
        _SERVER_PROC = None
        _ACTIVE_STATE["workspace_path"] = None
        if proc is not None:
            _kill_process_tree(proc)
        _close_log_handle()
    return get_openhands_server_info(port=port)


def sync_greenpt_profiles(
    port: int | None = None,
    api_key: str | None = None,
    base_url: str | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    """Configure the 'greenpt' LLM profile and 'sanctuary_greenpt' agent profile."""
    from openhands.sdk import Tool
    from openhands.sdk.profiles import OpenHandsAgentProfile
    from tools.openhands_job import resolve_greenpt_config

    resolved_port = _resolve_port(port)
    if not check_openhands_server_status(resolved_port):
        return {"synced": False, "reason": "server_offline", "port": resolved_port}

    cfg = resolve_greenpt_config(model=model)
    eff_key = (api_key if api_key is not None else cfg["api_key"]).strip()
    eff_base = (base_url if base_url is not None else cfg["base_url"]).strip()
    litellm_model = cfg["litellm_model"]

    if not eff_key and not any(h in eff_base.lower() for h in ("127.0.0.1", "localhost")):
        return {"synced": False, "reason": "missing_api_key", "port": resolved_port}

    creds = get_or_create_server_credentials()
    headers = {"X-Session-API-Key": creds["session_api_key"]}
    server_url = f"http://127.0.0.1:{resolved_port}"

    llm_body = {
        "llm": {
            "model": litellm_model,
            "api_key": eff_key or "local-no-key",
            "base_url": eff_base,
            "native_tool_calling": True,
        },
        "include_secrets": True,
    }
    resp = requests.post(
        f"{server_url}/api/profiles/greenpt",
        headers=headers,
        json=llm_body,
        timeout=10.0,
    )
    resp.raise_for_status()

    resp = requests.post(
        f"{server_url}/api/profiles/greenpt/activate",
        headers=headers,
        timeout=10.0,
    )
    resp.raise_for_status()

    agent_profile = OpenHandsAgentProfile(
        name="sanctuary_greenpt",
        llm_profile_ref="greenpt",
        tools=[
            Tool(name="terminal"),
            Tool(name="file_editor"),
            Tool(name="task_tool_set"),
        ],
    )
    resp = requests.post(
        f"{server_url}/api/agent-profiles/sanctuary_greenpt",
        headers=headers,
        json=agent_profile.model_dump(mode="json"),
        timeout=10.0,
    )
    resp.raise_for_status()

    list_resp = requests.get(
        f"{server_url}/api/agent-profiles",
        headers=headers,
        timeout=10.0,
    )
    list_resp.raise_for_status()
    profiles = list_resp.json().get("profiles") or []
    profile_id = next(
        (str(p["id"]) for p in profiles if p.get("name") == "sanctuary_greenpt" and p.get("id")),
        None,
    )
    if profile_id:
        act_resp = requests.post(
            f"{server_url}/api/agent-profiles/{profile_id}/activate",
            headers=headers,
            timeout=10.0,
        )
        act_resp.raise_for_status()

    return {
        "synced": True,
        "profile": "greenpt",
        "model_id": "openhands_greenpt",
        "litellm_model": litellm_model,
        "agent_profile_id": profile_id,
        "port": resolved_port,
    }


def start_openhands_server(
    port: int | None = None,
    workspace_path: str | None = None,
    sync_profiles: bool = True,
) -> dict[str, Any]:
    """Start (or reuse/retarget) the local OpenHands Agent Server process."""
    global _SERVER_PROC, _SERVER_LOG_HANDLE
    resolved_port = _resolve_port(port)
    target_ws = os.path.abspath(workspace_path) if workspace_path else _default_workspace_path()

    with _SERVER_LOCK:
        proc = _SERVER_PROC
        managed_alive = proc is not None and proc.poll() is None

        if managed_alive and check_openhands_server_status(resolved_port):
            same_ws = _ACTIVE_STATE.get("workspace_path") == target_ws
            same_port = _ACTIVE_STATE.get("port") == resolved_port
            if same_ws and same_port:
                info = get_openhands_server_info(port=resolved_port)
            else:
                _SERVER_PROC = None
                _kill_process_tree(proc)
                _close_log_handle()
                managed_alive = False
                info = None
        elif not managed_alive and check_openhands_server_status(resolved_port):
            # External OpenHands Agent Server already listening on this port.
            _ACTIVE_STATE["port"] = resolved_port
            _ACTIVE_STATE["workspace_path"] = target_ws
            info = get_openhands_server_info(port=resolved_port)
        else:
            info = None

        if info is None:
            if proc is not None:
                _SERVER_PROC = None
                _kill_process_tree(proc)
                _close_log_handle()

            creds = get_or_create_server_credentials()
            cfg_path = write_agent_server_config(target_ws, resolved_port)
            env = os.environ.copy()
            env["OPENHANDS_AGENT_SERVER_CONFIG_PATH"] = cfg_path
            env["OH_SESSION_API_KEYS_0"] = creds["session_api_key"]
            env["OH_SECRET_KEY"] = creds["secret_key"]
            env["OH_TELEMETRY_CONSENT"] = "false"
            env["OPENHANDS_SUPPRESS_BANNER"] = "1"

            os.makedirs(DATA_DIR, exist_ok=True)
            _SERVER_LOG_HANDLE = open(_LOG_PATH, "ab")
            popen_kwargs: dict[str, Any] = {
                "cwd": SANCTUARY_DIR,
                "env": env,
                "stdout": _SERVER_LOG_HANDLE,
                "stderr": subprocess.STDOUT,
            }
            if os.name == "nt":
                popen_kwargs.update(_win_no_window_kwargs())
            else:
                popen_kwargs["start_new_session"] = True

            _SERVER_PROC = subprocess.Popen(
                [
                    sys.executable,
                    "-c",
                    (
                        "from utils import lifecycle; "
                        "lifecycle._suppress_headless_windows_consoles(force=True); "
                        "import runpy, sys; "
                        "sys.argv = ['openhands.agent_server', *sys.argv[1:]]; "
                        "runpy.run_module('openhands.agent_server', run_name='__main__')"
                    ),
                    "--host",
                    "127.0.0.1",
                    "--port",
                    str(resolved_port),
                ],
                **popen_kwargs,
            )
            _ACTIVE_STATE["port"] = resolved_port
            _ACTIVE_STATE["workspace_path"] = target_ws

            deadline = time.monotonic() + 25.0
            while time.monotonic() < deadline:
                if _SERVER_PROC.poll() is not None:
                    rc = _SERVER_PROC.returncode
                    _SERVER_PROC = None
                    _close_log_handle()
                    raise RuntimeError(
                        f"OpenHands Agent Server exited early (code {rc}). Check {_LOG_PATH}."
                    )
                if check_openhands_server_status(resolved_port):
                    break
                time.sleep(0.25)
            else:
                raise RuntimeError(
                    f"OpenHands Agent Server failed to become ready on 127.0.0.1:{resolved_port}."
                )

    sync_result: dict[str, Any] | None = None
    if sync_profiles:
        try:
            sync_result = sync_greenpt_profiles(port=resolved_port)
        except Exception as exc:
            sync_result = {"synced": False, "error": str(exc)}

    result = get_openhands_server_info(port=resolved_port)
    if sync_result is not None:
        result["profile_sync"] = sync_result
    return result


def get_openhands_server_info(port: int | None = None) -> dict[str, Any]:
    """Return runtime status and OpenAI-compatible connection details for the server."""
    from tools.openhands_job import resolve_greenpt_config

    resolved_port = _resolve_port(port if port is not None else _ACTIVE_STATE.get("port"))
    cfg = resolve_greenpt_config()
    proc = _SERVER_PROC
    managed_alive = proc is not None and proc.poll() is None
    running = check_openhands_server_status(resolved_port)
    creds_present = os.path.isfile(_CREDENTIALS_PATH)

    return {
        "running": running,
        "managed": managed_alive,
        "pid": proc.pid if managed_alive else None,
        "port": resolved_port,
        "base_url": f"http://127.0.0.1:{resolved_port}",
        "openai_base_url": f"http://127.0.0.1:{resolved_port}/v1",
        "model_id": "openhands_greenpt",
        "workspace_path": _ACTIVE_STATE.get("workspace_path") or _default_workspace_path(),
        "has_greenpt_key": bool(cfg.get("api_key")),
        "session_api_key_configured": creds_present or managed_alive,
    }
