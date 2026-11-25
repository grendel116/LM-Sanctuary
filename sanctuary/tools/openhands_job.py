"""Unified OpenHands + GreenPT coding delegation bridge for LM-Sanctuary.

Supports two execution backends selectable via Project or `OPENHANDS_MODE`:
1. `cli`: Headless CLI subprocess (`python -m tools.openhands_worker --headless --json`)
   with native Windows PowerShell/POSIX terminal tools, `TaskToolSet` subagents,
   HITL `confirm_tool_execution` gating, and Program decision brokering.
2. `server`: Managed local OpenHands Agent Server (`runners.openhands_server`) exposing
   an OpenAI-compatible `/v1/chat/completions` gateway with `"openhands_greenpt"`.
"""

from __future__ import annotations

import json
import os
import re
import signal
import subprocess
import sys
import threading
import time
import uuid
from typing import Any

import requests

from runners.local_server import _win_no_window_kwargs
from variables.settings import (
    BASE_DIR as SANCTUARY_DIR,
    LOCAL_SERVER_URL,
    get_local_server_headers,
)

DEFAULT_GREENPT_BASE_URL = "https://api.greenpt.ai/v1"
DEFAULT_OPENHANDS_MODEL = "glm-5.3"
DEFAULT_OPENHANDS_PORT = 8091

GREENPT_RECOMMENDED_MODELS: tuple[str, ...] = (
    "glm-5.3",
    "glm-5.3-flash",
    "deepseek-v4.1-flash-1017",
    "kimi-k3.1-pro",
    "green-r",
    "green-l",
)

MODEL_ALIASES: dict[str, str] = {
    "auto": DEFAULT_OPENHANDS_MODEL,
    "default": DEFAULT_OPENHANDS_MODEL,
    "pro": "glm-5.3",
    "glm": "glm-5.3",
    "coding": "glm-5.3",
    "flash": "glm-5.3-flash",
    "fast": "glm-5.3-flash",
    "deepseek": "deepseek-v4.1-flash-1017",
    "kimi": "kimi-k3.1-pro",
    "reasoning": "green-r",
    # Backward-compatible aliases for legacy prompts/configs
    "gemini-2.5-pro": "glm-5.3",
    "gemini-pro": "glm-5.3",
    "gemini-2.5-flash": "glm-5.3-flash",
    "gemini-2.5-flash-lite": "glm-5.3-flash",
    "gemini-flash": "glm-5.3-flash",
}

_PROJECT_SETTINGS_PATH = os.path.join(SANCTUARY_DIR, "variables", "project_settings.json")
_RUNS_DIR = os.path.join(SANCTUARY_DIR, "data", "openhands", "runs")
_PERSISTENCE_ROOT = os.path.join(SANCTUARY_DIR, "data", "openhands", "conversations")

_JOBS_LOCK = threading.Lock()
_ACTIVE_JOBS: dict[str, list[dict[str, Any]]] = {}

_DELEGATED_LOCK = threading.Lock()
_DELEGATED_TOOL_CALLS: dict[str, list[dict[str, Any]]] = {}
_CONVERSATIONS_LOCK = threading.Lock()
_SERVER_CONVERSATIONS: dict[tuple[str, str], str] = {}


def _read_project_settings() -> dict[str, Any]:
    if not os.path.isfile(_PROJECT_SETTINGS_PATH):
        return {}
    try:
        with open(_PROJECT_SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def resolve_openhands_model(model: str | None = None) -> tuple[str, str]:
    """Resolve model alias/name into `(raw_model_id, litellm_model_id)`."""
    candidate = (model or "").strip()
    if not candidate or candidate.lower() in ("auto", "default"):
        settings = _read_project_settings()
        candidate = (
            str(settings.get("openhands_model") or "").strip()
            or os.getenv("OPENHANDS_MODEL", "").strip()
            or DEFAULT_OPENHANDS_MODEL
        )

    lower = candidate.lower()
    if lower in MODEL_ALIASES:
        raw = MODEL_ALIASES[lower]
        return raw, f"openai/{raw}"

    for prefix in ("openai/", "ollama/", "litellm_proxy/", "anthropic/"):
        if lower.startswith(prefix):
            raw = candidate[len(prefix) :].strip() or DEFAULT_OPENHANDS_MODEL
            alias_hit = MODEL_ALIASES.get(raw.lower())
            if alias_hit:
                return alias_hit, f"{prefix}{alias_hit}"
            return raw, candidate

    return candidate, f"openai/{candidate}"


def _clamp_port(raw_port: Any, default: int = DEFAULT_OPENHANDS_PORT) -> int:
    try:
        port = int(raw_port)
        if 1024 <= port <= 65535:
            return port
    except (TypeError, ValueError):
        pass
    return default


def _local_openai_base_url() -> str:
    raw = (LOCAL_SERVER_URL or "http://127.0.0.1:8080/v1/chat/completions").strip()
    if raw.endswith("/chat/completions"):
        raw = raw[: -len("/chat/completions")]
    if not raw.rstrip("/").endswith("/v1"):
        raw = raw.rstrip("/") + "/v1"
    return raw.rstrip("/")


def resolve_greenpt_config(model: str | None = None, subagent: str = "") -> dict[str, Any]:
    """Resolve GreenPT / OpenHands settings from project_settings.json and env vars."""
    from core import greenpt_client

    settings = _read_project_settings()

    routing_policy = (
        str(settings.get("routing_policy") or "").strip().lower()
        or os.getenv("SANCTUARY_ROUTING_POLICY", "auto").strip().lower()
    )
    if routing_policy not in greenpt_client.VALID_ROUTING_POLICIES:
        routing_policy = "auto"

    api_key, _ = greenpt_client._resolve_api_key(settings)
    base_url = (
        str(settings.get("greenpt_base_url") or "").strip()
        or os.getenv("CLOUD_BASE_URL", "").strip()
        or os.getenv("GREENPT_BASE_URL", "").strip()
        or DEFAULT_GREENPT_BASE_URL
    ).rstrip("/")

    clean_model = (model or "").strip()
    is_auto_model = not clean_model or clean_model.lower() in ("auto", "default")
    clean_sub = (subagent or "").strip().lower()

    if routing_policy == "local_only":
        base_url = _local_openai_base_url()
        local_name = os.getenv("LOCAL_MODEL_NAME", "").strip() or "local-llm"
        raw_model, litellm_model = local_name, f"openai/{local_name}"
        fast_litellm_model = ""
    else:
        provider = greenpt_client.detect_cloud_provider(base_url)
        preset = greenpt_client.PROVIDER_ROLE_DEFAULTS.get(provider, {})
        cfg_fast = str(settings.get("cloud_fast_model") or "").strip() or os.getenv("CLOUD_FAST_MODEL", "").strip()
        cfg_priv = str(settings.get("cloud_private_model") or "").strip() or os.getenv("CLOUD_PRIVATE_MODEL", "").strip()
        cfg_deep = str(settings.get("openhands_model") or "").strip() or os.getenv("OPENHANDS_MODEL", "").strip()
        if provider == "inference_coop" and (not cfg_deep or cfg_deep == DEFAULT_OPENHANDS_MODEL):
            cfg_deep = preset.get("private" if routing_policy == "private_tee" else "deep", DEFAULT_OPENHANDS_MODEL)

        is_known_multi_tier = (
            greenpt_client.is_native_greenpt(base_url)
            or provider in ("inference_coop", "tinfoil", "regolo")
            or bool(cfg_fast)
        )
        fast_target = cfg_fast or preset.get("fast") or (
            "glm-5.3-flash" if is_known_multi_tier and (not cfg_deep or cfg_deep == DEFAULT_OPENHANDS_MODEL) else ""
        )
        if is_auto_model:
            if routing_policy == "private_tee":
                target = cfg_priv or preset.get("private") or cfg_deep or DEFAULT_OPENHANDS_MODEL
            elif clean_sub in ("researcher", "verifier"):
                target = fast_target or cfg_deep or DEFAULT_OPENHANDS_MODEL
            else:
                target = cfg_deep or preset.get("deep") or DEFAULT_OPENHANDS_MODEL
            raw_model, litellm_model = resolve_openhands_model(target)
        else:
            raw_model, litellm_model = resolve_openhands_model(model)

        if is_known_multi_tier and fast_target and fast_target != raw_model:
            _, fast_litellm_model = resolve_openhands_model(fast_target)
        else:
            fast_litellm_model = ""

    mode = (
        str(settings.get("openhands_mode") or "").strip()
        or os.getenv("OPENHANDS_MODE", "").strip()
        or "auto"
    ).lower()
    if mode not in ("auto", "cli", "server"):
        mode = "auto"

    server_port = _clamp_port(
        settings.get("openhands_server_port") or os.getenv("OPENHANDS_SERVER_PORT"),
        DEFAULT_OPENHANDS_PORT,
    )

    raw_auto = settings.get("openhands_auto_start_server")
    if raw_auto is None:
        auto_start = os.getenv("OPENHANDS_AUTO_START_SERVER", "false").lower() in ("true", "1", "yes")
    else:
        auto_start = bool(raw_auto)

    sec_preset = str(settings.get("security_preset") or "ask_always").strip()
    if sec_preset not in ("ask_always", "auto"):
        sec_preset = "ask_always"

    return {
        "api_key": api_key,
        "base_url": base_url,
        "raw_model": raw_model,
        "litellm_model": litellm_model,
        "fast_litellm_model": fast_litellm_model,
        "routing_policy": routing_policy,
        "mode": mode,
        "server_port": server_port,
        "auto_start_server": auto_start,
        "security_preset": sec_preset,
        "folders": settings.get("folders") if isinstance(settings.get("folders"), list) else [],
    }


def _is_local_endpoint(base_url: str) -> bool:
    lower = (base_url or "").lower()
    return any(host in lower for host in ("127.0.0.1", "localhost", "0.0.0.0", "[::1]"))


def _redact_secret(text: str, secret: str) -> str:
    if not text or not secret or len(secret) < 4:
        return text
    return text.replace(secret, "[REDACTED]")


def consume_delegated_tool_calls(session_id: str | None) -> list[dict[str, Any]]:
    """Pop recorded sub-step call/response pairs for durable chat history persistence."""
    if not session_id:
        return []
    with _DELEGATED_LOCK:
        return list(_DELEGATED_TOOL_CALLS.pop(session_id, []))


def _record_delegated_event(
    session_id: str | None,
    evt: dict[str, Any],
    pending_args: dict[str, dict[str, Any]],
) -> None:
    if not session_id:
        return
    from tools import tools as tools_mod

    call_id = str(evt.get("id") or uuid.uuid4().hex)
    name = str(evt.get("name") or "openhands:tool")
    phase = evt.get("phase")

    if phase == "call":
        args = evt.get("args") if isinstance(evt.get("args"), dict) else {}
        pending_args[call_id] = args
        with tools_mod.session_tool_calls_lock:
            lst = tools_mod.session_tool_calls.setdefault(session_id, [])
            if not any(item.get("id") == call_id for item in lst):
                entry = {
                    "id": call_id,
                    "name": name,
                    "args": args,
                    "status": "running",
                    "response": "",
                    "start_time": time.time(),
                }
                if evt.get("phase_label"):
                    entry["phase"] = str(evt["phase_label"])
                lst.append(entry)
    elif phase == "result":
        output = str(evt.get("output") or "")
        is_error = bool(evt.get("is_error"))
        status_label = "error" if is_error else "done"
        args = pending_args.pop(call_id, {})

        with tools_mod.session_tool_calls_lock:
            lst = tools_mod.session_tool_calls.setdefault(session_id, [])
            matched = next((item for item in reversed(lst) if item.get("id") == call_id), None)
            if matched is not None:
                matched["status"] = status_label
                matched["response"] = output[:1500]
                matched["duration"] = round(time.time() - float(matched.get("start_time") or time.time()), 2)
            else:
                lst.append(
                    {
                        "id": call_id,
                        "name": name,
                        "args": args,
                        "status": status_label,
                        "response": output[:1500],
                        "duration": 0.0,
                    }
                )

        with _DELEGATED_LOCK:
            from utils.utils import _build_tool_calls_pair

            pairs = _DELEGATED_TOOL_CALLS.setdefault(session_id, [])
            pairs.extend(_build_tool_calls_pair(name, args, output[:1500], idx=len(pairs)))


def _sebile_decide(
    question: str,
    options: list[str] | None = None,
    kind: str = "ask_user",
    program_id: str | None = None,
    cwd: str | None = None,
    instruction: str | None = None,
    config: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Consult the local Program (falling back to GreenPT) to answer an agent question."""
    from core import program_config
    from runners.program import get_active_program

    resolved_cfg = config or resolve_greenpt_config()
    active_prog = program_id or get_active_program()
    prog_name = program_config.get_program_name(active_prog)
    card = program_config._load_card_data(active_prog)
    persona_hint = str(card.get("personality") or card.get("description") or "").strip()[:500]

    opt_lines = ""
    if options:
        opt_lines = "\nOptions:\n" + "\n".join(f"{idx + 1}. {opt}" for idx, opt in enumerate(options))

    sys_prompt = (
        f"You are {prog_name}, supervising an OpenHands coding delegation in `{cwd or ''}`.\n"
        + (f"Persona & Principles: {persona_hint}\n" if persona_hint else "")
        + "Answer technical, repository, file-path, or coding-convention questions concisely and decisively so the coding agent can continue. "
        + "HOWEVER, if the question is a genuine user-facing UI/UX layout choice, visual behavior preference, product scope trade-off, "
        + "or missing external credential that only the human user should decide, start your reply with `[ESCALATE_TO_USER]`."
        + (
            " Otherwise, start your reply with the chosen 1-based option number followed by a brief reason."
            if options
            else " If the work described in the question is already finished, reply strictly with DONE."
            if kind == "stop_question"
            else ""
        )
    )
    user_prompt = (
        f"Original Coding Task:\n{(instruction or '')[:800]}\n\n"
        f"Agent Question:\n{question.strip()}{opt_lines}"
    )
    messages = [
        {"role": "system", "content": sys_prompt},
        {"role": "user", "content": user_prompt},
    ]

    reply_text = ""
    # 1. Try local llama-server first
    try:
        local_url = LOCAL_SERVER_URL
        if local_url:
            resp = requests.post(
                local_url,
                headers=get_local_server_headers(),
                json={"messages": messages, "temperature": 0.2, "max_tokens": 300},
                timeout=12.0,
            )
            if resp.status_code == 200:
                choices = resp.json().get("choices") or []
                if choices:
                    reply_text = str((choices[0].get("message") or {}).get("content") or "").strip()
    except Exception:
        reply_text = ""

    # 2. Fall back to GreenPT / configured OpenAI-compatible endpoint
    if not reply_text and (resolved_cfg.get("api_key") or _is_local_endpoint(resolved_cfg.get("base_url", ""))):
        try:
            endpoint = f"{resolved_cfg['base_url'].rstrip('/')}/chat/completions"
            headers = {"Content-Type": "application/json"}
            if resolved_cfg.get("api_key"):
                headers["Authorization"] = f"Bearer {resolved_cfg['api_key']}"
            resp = requests.post(
                endpoint,
                headers=headers,
                json={
                    "model": resolved_cfg["raw_model"],
                    "messages": messages,
                    "temperature": 0.2,
                    "max_tokens": 300,
                },
                timeout=20.0,
            )
            if resp.status_code == 200:
                choices = resp.json().get("choices") or []
                if choices:
                    reply_text = str((choices[0].get("message") or {}).get("content") or "").strip()
        except Exception:
            reply_text = ""

    if kind == "ask_user" and reply_text.upper().startswith("[ESCALATE_TO_USER]"):
        from tools import tools as tools_mod

        user_choice = tools_mod.request_user_choice(
            question=question,
            options=options,
            tool_name="openhands:ask_user",
        )
        u_idx = user_choice.get("option_index")
        u_txt = str(user_choice.get("answer_text") or "").strip()
        if isinstance(u_idx, int) and options and 0 <= u_idx < len(options):
            return {
                "action": "answer",
                "option_index": u_idx,
                "text": u_txt or options[u_idx],
            }
        if u_txt:
            return {"action": "answer", "text": u_txt}

    if kind == "stop_question" and (not reply_text or reply_text.upper().startswith("DONE")):
        return {"action": "done", "text": ""}

    if options:
        selected_idx = 0
        m = re.match(r"^\s*(?:option\s*)?(\d+)\b", reply_text, re.IGNORECASE)
        if m:
            candidate = int(m.group(1)) - 1
            if 0 <= candidate < len(options):
                selected_idx = candidate
        else:
            lower_reply = reply_text.lower()
            for idx, opt in enumerate(options):
                if opt.lower() in lower_reply:
                    selected_idx = idx
                    break
        return {
            "action": "answer",
            "option_index": selected_idx,
            "text": reply_text or options[selected_idx],
        }

    return {
        "action": "answer",
        "text": reply_text or "Proceed with the safest minimal implementation and verify with tests.",
    }


def _kill_proc_tree(proc: subprocess.Popen, grace: float = 0.5) -> None:
    if proc.poll() is not None:
        return
    try:
        if proc.stdin and not proc.stdin.closed:
            proc.stdin.write(json.dumps({"type": "cancel"}) + "\n")
            proc.stdin.flush()
    except Exception:
        pass
    try:
        proc.wait(timeout=grace)
        return
    except subprocess.TimeoutExpired:
        pass

    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                capture_output=True,
                **_win_no_window_kwargs(),
            )
        else:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
            try:
                proc.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
    except Exception:
        try:
            proc.kill()
        except Exception:
            pass


def _register_job(session_id: str | None, entry: dict[str, Any]) -> None:
    key = session_id or "__default__"
    with _JOBS_LOCK:
        _ACTIVE_JOBS.setdefault(key, []).append(entry)


def _unregister_job(session_id: str | None, entry: dict[str, Any]) -> None:
    key = session_id or "__default__"
    with _JOBS_LOCK:
        lst = _ACTIVE_JOBS.get(key)
        if not lst:
            return
        if entry in lst:
            lst.remove(entry)
        if not lst:
            _ACTIVE_JOBS.pop(key, None)


def cancel_openhands_jobs(session_id: str, grace: float = 0.5, timeout: float = 2.0) -> bool:
    """Cancel active OpenHands CLI subprocesses and HTTP jobs for `session_id`."""
    del timeout  # _kill_proc_tree enforces bounded shutdown
    with _JOBS_LOCK:
        entries = list(_ACTIVE_JOBS.get(session_id, []))
    if not entries:
        return False

    cancelled_any = False
    for entry in entries:
        entry["cancelled"] = True
        cancel_ev = entry.get("cancel_event")
        if cancel_ev is not None:
            cancel_ev.set()
        proc = entry.get("proc")
        if isinstance(proc, subprocess.Popen):
            _kill_proc_tree(proc, grace=grace)
        cancelled_any = True
    return cancelled_any


def cancel_all_openhands_jobs(grace: float = 0.3, timeout: float = 1.5) -> int:
    """Cancel all active OpenHands jobs across every session during shutdown."""
    with _JOBS_LOCK:
        session_ids = list(_ACTIVE_JOBS.keys())
    count = 0
    for sid in session_ids:
        if cancel_openhands_jobs(sid, grace=grace, timeout=timeout):
            count += 1
    return count


def _git_status_map(cwd: str) -> dict[str, str]:
    try:
        res = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5.0,
            **_win_no_window_kwargs(),
        )
        if res.returncode != 0:
            return {}
        out: dict[str, str] = {}
        for line in res.stdout.splitlines():
            if len(line) >= 4:
                out[line[3:].strip()] = line[:2]
        return out
    except Exception:
        return {}


def _sanitize_worker_stderr(lines: list[str]) -> list[str]:
    """Filter harmless LiteLLM cost-mapping warnings from OpenHands worker stderr."""
    cleaned: list[str] = []
    for line in lines:
        low = line.lower()
        if (
            "cost calculation failed" in low
            or "model_prices_and_context_window.json" in low
            or "warnings.warn(" in low
            or "openhands_suppress_banner" in low
        ):
            continue
        cleaned.append(line)
    return cleaned


def _run_cli_worker(
    *,
    instruction: str,
    workspace_cwd: str,
    subagent: str,
    agents_md_path: str | None,
    cfg: dict[str, Any],
    session_id: str | None,
    program_id: str | None,
    resume: bool = True,
    workflow: str = "single",
    focus_path: str = "",
    path_warning: str = "",
    approved_plan_text: str = "",
) -> dict[str, Any]:
    from tools import tools as tools_mod

    os.makedirs(_RUNS_DIR, exist_ok=True)
    run_id = uuid.uuid4().hex
    instr_path = os.path.join(_RUNS_DIR, f"instr_{run_id}.txt")
    with open(instr_path, "w", encoding="utf-8") as f:
        f.write(instruction)

    plan_path = ""
    if approved_plan_text.strip():
        plan_path = os.path.join(_RUNS_DIR, f"plan_{run_id}.txt")
        with open(plan_path, "w", encoding="utf-8") as f:
            f.write(approved_plan_text.strip())

    cmd = [
        sys.executable,
        "-u",
        "-m",
        "tools.openhands_worker",
        "--headless",
        "--json",
        "--cwd",
        workspace_cwd,
        "--instruction-file",
        instr_path,
        "--model",
        cfg["litellm_model"],
        "--base-url",
        cfg["base_url"],
        "--api-key-env",
        "GREENPT_API_KEY",
        "--security-preset",
        cfg["security_preset"],
        "--workflow",
        workflow,
    ]
    if cfg.get("fast_litellm_model"):
        cmd.extend(["--fast-model", cfg["fast_litellm_model"]])
    if subagent:
        cmd.extend(["--subagent", subagent])
    if agents_md_path and os.path.isfile(agents_md_path):
        cmd.extend(["--agents-md", agents_md_path])
    if focus_path:
        cmd.extend(["--focus-path", focus_path])
    if path_warning:
        cmd.extend(["--path-warning", path_warning])
    if plan_path:
        cmd.extend(["--approved-plan-file", plan_path])
    if resume and session_id:
        safe_sid = re.sub(r"[^a-zA-Z0-9_-]", "_", session_id)
        role_scope = f"{os.path.normcase(workspace_cwd)}|{subagent or 'lead'}|{workflow}"
        ws_tag = uuid.uuid5(uuid.NAMESPACE_URL, role_scope).hex[:8]
        pdir = os.path.join(_PERSISTENCE_ROOT, f"{safe_sid}_{ws_tag}")
        cmd.extend(["--persistence-dir", pdir, "--conversation-id", f"{session_id}:{ws_tag}"])

    env = os.environ.copy()
    if cfg["api_key"]:
        env["GREENPT_API_KEY"] = cfg["api_key"]
    env["PYTHONIOENCODING"] = "utf-8"
    env["OPENHANDS_SUPPRESS_BANNER"] = "1"
    env["OH_TELEMETRY_CONSENT"] = "false"

    popen_kwargs: dict[str, Any] = {
        "cwd": SANCTUARY_DIR,
        "env": env,
        "stdin": subprocess.PIPE,
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "text": True,
        "encoding": "utf-8",
        "errors": "replace",
        "bufsize": 1,
    }
    if os.name == "nt":
        popen_kwargs.update(_win_no_window_kwargs())
    else:
        popen_kwargs["start_new_session"] = True

    proc = subprocess.Popen(cmd, **popen_kwargs)
    job_entry: dict[str, Any] = {"mode": "cli", "proc": proc, "cancelled": False}
    _register_job(session_id, job_entry)

    stderr_lines: list[str] = []

    def _drain_stderr() -> None:
        if proc.stderr is None:
            return
        try:
            while True:
                line = proc.stderr.readline()
                if not line:
                    break
                if len(stderr_lines) < 200:
                    stderr_lines.append(line.rstrip())
        except Exception:
            pass

    stderr_thread = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_thread.start()

    pending_args: dict[str, dict[str, Any]] = {}
    worker_call_ids: set[str] = set()
    steps = 0
    decision_rounds = 0
    active_phase = ""
    result_evt: dict[str, Any] = {}

    def _send_to_worker(payload: dict[str, Any]) -> None:
        if proc.stdin and not proc.stdin.closed:
            try:
                proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                proc.stdin.flush()
            except OSError:
                pass

    try:
        if proc.stdout is not None:
            while True:
                raw_line = proc.stdout.readline()
                if not raw_line:
                    break
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if not isinstance(evt, dict):
                    continue

                etype = evt.get("type")
                if etype == "phase_event":
                    active_phase = str(evt.get("phase") or "").strip()
                    if session_id and active_phase:
                        with tools_mod.session_tool_calls_lock:
                            lst = tools_mod.session_tool_calls.get(session_id, [])
                            if lst:
                                lst[-1]["phase"] = active_phase
                elif etype == "tool_event":
                    if evt.get("phase") == "call" and evt.get("id"):
                        worker_call_ids.add(str(evt.get("id")))
                    if active_phase:
                        evt["phase_label"] = active_phase
                    _record_delegated_event(session_id, evt, pending_args)
                    if evt.get("phase") == "call":
                        steps += 1
                elif etype == "confirm_request":
                    approved = False
                    if not job_entry["cancelled"]:
                        args_dict = evt.get("args") if isinstance(evt.get("args"), dict) else {}
                        approved = bool(
                            tools_mod.confirm_tool_execution(
                                str(evt.get("tool_name") or "openhands:action"),
                                json.dumps(args_dict, indent=2, ensure_ascii=False),
                            )
                        )
                    _send_to_worker(
                        {
                            "type": "confirm_response",
                            "id": evt.get("id"),
                            "approved": approved and not job_entry["cancelled"],
                        }
                    )
                elif etype == "decision_request":
                    if job_entry["cancelled"]:
                        _send_to_worker({"type": "cancel"})
                        continue
                    decision = _sebile_decide(
                        question=str(evt.get("question") or ""),
                        options=evt.get("options") if isinstance(evt.get("options"), list) else None,
                        kind=str(evt.get("kind") or "ask_user"),
                        program_id=program_id,
                        cwd=workspace_cwd,
                        instruction=instruction,
                        config=cfg,
                    )
                    decision_rounds += 1
                    dec_id = str(evt.get("id") or uuid.uuid4().hex)
                    _record_delegated_event(
                        session_id,
                        {
                            "phase": "call",
                            "id": f"dec_{dec_id}",
                            "name": "openhands:decision",
                            "args": {"question": str(evt.get("question") or "")[:240]},
                        },
                        pending_args,
                    )
                    _record_delegated_event(
                        session_id,
                        {
                            "phase": "result",
                            "id": f"dec_{dec_id}",
                            "name": "openhands:decision",
                            "is_error": False,
                            "output": str(decision.get("text") or decision.get("action") or ""),
                        },
                        pending_args,
                    )
                    _send_to_worker(
                        {
                            "type": "decision_response",
                            "id": evt.get("id"),
                            **decision,
                        }
                    )
                elif etype == "result":
                    result_evt = evt

        proc.wait(timeout=10.0)
    except Exception as exc:
        if not result_evt:
            result_evt = {"status": "error", "error": str(exc)}
    finally:
        _unregister_job(session_id, job_entry)
        if session_id and worker_call_ids:
            final_status = (
                "cancelled"
                if job_entry["cancelled"]
                else ("error" if result_evt.get("status") == "error" else "done")
            )
            now_ts = time.time()
            with tools_mod.session_tool_calls_lock:
                for entry in tools_mod.session_tool_calls.get(session_id, []):
                    if entry.get("id") in worker_call_ids and entry.get("status") == "running":
                        entry["status"] = final_status
                        entry["duration"] = round(now_ts - float(entry.get("start_time") or now_ts), 2)
        for temp_f in (instr_path, plan_path):
            if temp_f:
                try:
                    os.remove(temp_f)
                except OSError:
                    pass
        if proc.poll() is None:
            _kill_proc_tree(proc, grace=0.2)
        stderr_thread.join(timeout=1.0)

    clean_stderr = _sanitize_worker_stderr(stderr_lines)
    if job_entry["cancelled"]:
        result_evt["status"] = "cancelled"
    elif not result_evt:
        err_tail = "\n".join(clean_stderr[-10:]).strip()
        result_evt = {
            "status": "completed" if proc.returncode == 0 else "error",
            "error": err_tail if proc.returncode != 0 else "",
        }
    elif result_evt.get("status") == "error" and not result_evt.get("error") and clean_stderr:
        result_evt["error"] = "\n".join(clean_stderr[-8:]).strip()

    raw_err = str(result_evt.get("error") or "").strip()
    if "maximum iterations limit" in raw_err.lower():
        raw_err = "Iteration budget reached before final completion (see checkpoint summary below)."

    return {
        "status": str(result_evt.get("status") or "completed"),
        "final_response": str(result_evt.get("final_response") or "").strip(),
        "error": raw_err,
        "steps": steps,
        "decision_rounds": int(result_evt.get("decision_rounds") or decision_rounds),
    }


def _run_server_mode(
    *,
    instruction: str,
    workspace_cwd: str,
    subagent: str,
    agents_md_path: str | None,
    cfg: dict[str, Any],
    session_id: str | None,
    resume: bool = True,
) -> dict[str, Any]:
    from runners import openhands_server
    from tools import tools as tools_mod

    if cfg["security_preset"] == "ask_always":
        details = json.dumps(
            {
                "cwd": workspace_cwd,
                "model": cfg["raw_model"],
                "subagent": subagent or "lead",
                "instruction": instruction[:240],
            },
            indent=2,
            ensure_ascii=False,
        )
        approved = tools_mod.confirm_tool_execution("openhands:server_coding", details)
        if not approved:
            return {
                "status": "cancelled",
                "final_response": "Execution denied by user in HITL confirmation.",
                "error": "",
                "steps": 0,
                "decision_rounds": 0,
            }

    cancel_ev = threading.Event()
    job_entry: dict[str, Any] = {"mode": "server", "cancel_event": cancel_ev, "cancelled": False}
    _register_job(session_id, job_entry)

    try:
        info = openhands_server.start_openhands_server(
            port=cfg["server_port"],
            workspace_path=workspace_cwd,
            sync_profiles=True,
        )
        if cancel_ev.is_set() or job_entry["cancelled"]:
            return {"status": "cancelled", "final_response": "", "error": "", "steps": 0, "decision_rounds": 0}

        creds = openhands_server.get_or_create_server_credentials()
        headers: dict[str, str] = {
            "Authorization": f"Bearer {creds['session_api_key']}",
            "Content-Type": "application/json",
        }
        conv_key = (session_id or "_", workspace_cwd)
        if not resume:
            with _CONVERSATIONS_LOCK:
                _SERVER_CONVERSATIONS.pop(conv_key, None)
        else:
            with _CONVERSATIONS_LOCK:
                existing_cid = _SERVER_CONVERSATIONS.get(conv_key)
            if existing_cid:
                headers["X-OpenHands-ServerConversation-ID"] = existing_cid

        messages: list[dict[str, str]] = []
        if agents_md_path and os.path.isfile(agents_md_path):
            try:
                with open(agents_md_path, "r", encoding="utf-8") as f:
                    sys_text = f.read().strip()
                if sys_text:
                    messages.append({"role": "system", "content": sys_text})
            except OSError:
                pass

        subagent_prefix = (
            f"[Subagent preference: use `{subagent}` for this task]\n" if subagent else ""
        )
        messages.append(
            {
                "role": "user",
                "content": f"[Workspace: {workspace_cwd}]\n{subagent_prefix}{instruction}",
            }
        )

        resp = requests.post(
            f"{info['openai_base_url'].rstrip('/')}/chat/completions",
            headers=headers,
            json={"model": "openhands_greenpt", "messages": messages, "stream": False},
            timeout=130.0,
        )
        if resp.status_code != 200:
            return {
                "status": "error",
                "final_response": "",
                "error": f"Server returned HTTP {resp.status_code}: {resp.text[:500]}",
                "steps": 0,
                "decision_rounds": 0,
            }

        ret_cid = resp.headers.get("X-OpenHands-ServerConversation-ID")
        if ret_cid:
            with _CONVERSATIONS_LOCK:
                _SERVER_CONVERSATIONS[conv_key] = ret_cid.strip()

        data = resp.json()
        choices = data.get("choices") or []
        content = ""
        if choices:
            content = str((choices[0].get("message") or {}).get("content") or "").strip()

        srv_call_id = f"srv_{uuid.uuid4().hex[:8]}"
        _record_delegated_event(
            session_id,
            {
                "phase": "call",
                "id": srv_call_id,
                "name": "openhands:task",
                "args": {"subagent_type": subagent or "lead", "description": instruction[:160]},
            },
            {},
        )
        _record_delegated_event(
            session_id,
            {
                "phase": "result",
                "id": srv_call_id,
                "name": "openhands:task",
                "is_error": False,
                "output": content[:1500],
            },
            {},
        )
        return {
            "status": "cancelled" if (cancel_ev.is_set() or job_entry["cancelled"]) else "completed",
            "final_response": content,
            "error": "",
            "steps": 1,
            "decision_rounds": 0,
        }
    except Exception as exc:
        return {
            "status": "cancelled" if (cancel_ev.is_set() or job_entry["cancelled"]) else "error",
            "final_response": "",
            "error": str(exc),
            "steps": 0,
            "decision_rounds": 0,
        }
    finally:
        _unregister_job(session_id, job_entry)


def _is_git_repo(cwd: str) -> bool:
    try:
        res = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=cwd,
            capture_output=True,
            text=True,
            timeout=4.0,
            **_win_no_window_kwargs(),
        )
        return res.returncode == 0 and res.stdout.strip().lower() == "true"
    except Exception:
        return False


def _create_isolated_worktree(repo_root: str) -> tuple[str, str]:
    """Create a temporary `git worktree` branch for isolated coding execution."""
    import shutil

    os.makedirs(_RUNS_DIR, exist_ok=True)
    tag = uuid.uuid4().hex[:8]
    branch = f"oh-iso-{tag}"
    wt_dir = os.path.join(_RUNS_DIR, f"wt_{tag}")
    res = subprocess.run(
        ["git", "worktree", "add", "-b", branch, wt_dir, "HEAD"],
        cwd=repo_root,
        capture_output=True,
        text=True,
        timeout=15.0,
        **_win_no_window_kwargs(),
    )
    if res.returncode != 0 or not os.path.isdir(wt_dir):
        shutil.rmtree(wt_dir, ignore_errors=True)
        return "", ""
    return wt_dir, branch


def _sync_worktree_changes_back(wt_dir: str, repo_root: str) -> None:
    """Copy modified/new files from a verified isolated worktree back to `repo_root`."""
    import shutil

    status_map = _git_status_map(wt_dir)
    for rel_path, st_code in status_map.items():
        clean_rel = rel_path.strip().strip('"')
        src = os.path.join(wt_dir, clean_rel)
        dst = os.path.join(repo_root, clean_rel)
        if "D" in st_code and not os.path.exists(src):
            if os.path.isfile(dst):
                os.remove(dst)
        elif os.path.isfile(src):
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copy2(src, dst)


def _cleanup_isolated_worktree(repo_root: str, wt_dir: str, branch: str) -> None:
    import shutil

    if wt_dir:
        subprocess.run(
            ["git", "worktree", "remove", "--force", wt_dir],
            cwd=repo_root,
            capture_output=True,
            timeout=10.0,
            **_win_no_window_kwargs(),
        )
        shutil.rmtree(wt_dir, ignore_errors=True)
    if branch:
        subprocess.run(
            ["git", "branch", "-D", branch],
            cwd=repo_root,
            capture_output=True,
            timeout=5.0,
            **_win_no_window_kwargs(),
        )


def delegate_coding(
    task: str = "",
    path: str = "",
    model: str = "auto",
    subagent: str = "",
    mode: str = "",
    resume: bool = True,
    workflow: str = "auto",
    isolate: bool = False,
    session_id: str | None = None,
    instruction: str = "",
    cwd: str = "",
    **kwargs: Any,
) -> str:
    """Delegate software engineering and subagent tasks to OpenHands + GreenPT."""
    del kwargs
    clean_instruction = (task or instruction or "").strip()
    if not clean_instruction:
        return "Error: `task` / `instruction` must not be empty when calling delegate_coding."

    from core import program_config
    from runners.program import get_active_program
    from tools import tools as tools_mod

    raw_cwd = (path or cwd or "").strip()
    try:
        workspace_cwd, focus_rel, path_warning = tools_mod.resolve_coding_workspace(raw_cwd)
    except Exception as exc:
        return f"Error resolving workspace directory: {exc}"

    if not os.path.isdir(workspace_cwd):
        return f"Error: Workspace directory does not exist: {workspace_cwd}"

    cfg = resolve_greenpt_config(model=model, subagent=subagent)
    if not cfg["api_key"] and not _is_local_endpoint(cfg["base_url"]):
        return (
            "Cloud API key is not configured. Open Project in Sanctuary to set your "
            "Cloud API Key and /v1 Endpoint (or set `CLOUD_API_KEY` in `.env`)."
        )

    active_program_id = get_active_program()
    program_config.compile_program_agents_md(active_program_id)
    agents_md_path = os.path.join(program_config.PROGRAMS_DIR, active_program_id, "AGENTS.md")
    if not os.path.isfile(agents_md_path):
        agents_md_path = None

    plan_mode_ctx = bool(getattr(tools_mod, "current_plan_mode", None) and tools_mod.current_plan_mode.get())
    approved_plan_ctx = str(
        getattr(tools_mod, "current_approved_plan", None) and tools_mod.current_approved_plan.get() or ""
    ).strip()
    req_wf = (workflow or "auto").strip().lower()
    if req_wf == "plan" or plan_mode_ctx:
        effective_workflow = "plan"
    elif req_wf == "execute" or (req_wf == "auto" and bool(approved_plan_ctx)):
        effective_workflow = "execute"
    elif req_wf in ("staged", "single"):
        effective_workflow = req_wf
    else:
        effective_workflow = "single"

    requested_mode = (mode or cfg["mode"] or "auto").strip().lower()
    if requested_mode == "auto":
        effective_mode = "cli"
    elif requested_mode in ("cli", "server"):
        effective_mode = requested_mode
    else:
        effective_mode = "cli"

    effective_session_id = session_id or tools_mod.current_session_id.get()
    ctx_token = None
    if effective_session_id and effective_session_id != tools_mod.current_session_id.get():
        ctx_token = tools_mod.current_session_id.set(effective_session_id)

    pre_git = _git_status_map(workspace_cwd)
    wt_dir = ""
    wt_branch = ""
    run_cwd = workspace_cwd
    if isolate and effective_mode != "server" and effective_workflow != "plan" and _is_git_repo(workspace_cwd):
        wt_dir, wt_branch = _create_isolated_worktree(workspace_cwd)
        if wt_dir:
            run_cwd = wt_dir

    try:
        if effective_mode == "server":
            outcome = _run_server_mode(
                instruction=clean_instruction,
                workspace_cwd=run_cwd,
                subagent=(subagent or "").strip(),
                agents_md_path=agents_md_path,
                cfg=cfg,
                session_id=effective_session_id,
                resume=bool(resume),
            )
        else:
            outcome = _run_cli_worker(
                instruction=clean_instruction,
                workspace_cwd=run_cwd,
                subagent=(subagent or "").strip(),
                agents_md_path=agents_md_path,
                cfg=cfg,
                session_id=effective_session_id,
                program_id=active_program_id,
                resume=bool(resume),
                workflow=effective_workflow,
                focus_path=focus_rel,
                path_warning=path_warning,
                approved_plan_text=approved_plan_ctx,
            )

        err_probe = str(outcome.get("error") or "")
        if (
            outcome.get("status") == "error"
            and ("402" in err_probe or "No remaining credits" in err_probe)
            and not _is_local_endpoint(cfg["base_url"])
        ):
            from core import greenpt_client
            from runners import local_server

            greenpt_client.mark_quota_exhausted(cfg["api_key"])
            if local_server.check_local_server_status() is True:
                local_name = os.getenv("LOCAL_MODEL_NAME", "").strip() or "local-llm"
                fallback_cfg = {
                    **cfg,
                    "api_key": os.getenv("LOCAL_API_KEY", "local"),
                    "base_url": _local_openai_base_url(),
                    "raw_model": local_name,
                    "litellm_model": f"openai/{local_name}",
                    "fast_litellm_model": "",
                }
                outcome = _run_cli_worker(
                    instruction=clean_instruction,
                    workspace_cwd=run_cwd,
                    subagent=(subagent or "").strip(),
                    agents_md_path=agents_md_path,
                    cfg=fallback_cfg,
                    session_id=effective_session_id,
                    program_id=active_program_id,
                    resume=False,
                    workflow="single",
                    focus_path=focus_rel,
                    path_warning=path_warning,
                )
                cfg = fallback_cfg
                effective_mode = "cli (local-fallback)"

        if wt_dir and outcome.get("status") == "completed":
            _sync_worktree_changes_back(wt_dir, workspace_cwd)
    finally:
        if wt_dir or wt_branch:
            _cleanup_isolated_worktree(workspace_cwd, wt_dir, wt_branch)
        if ctx_token is not None:
            tools_mod.current_session_id.reset(ctx_token)

    post_git = _git_status_map(workspace_cwd)
    changed_files = sorted(
        path for path, st in post_git.items() if pre_git.get(path) != st
    )

    summary = _redact_secret(outcome.get("final_response") or "", cfg["api_key"])
    err_msg = _redact_secret(outcome.get("error") or "", cfg["api_key"])
    status_str = outcome.get("status") or "completed"

    lines = [
        "[OPENHANDS DELEGATION DIGEST]",
        f"Mode: {effective_mode}",
        f"Workflow: {effective_workflow}" + (" (isolated worktree)" if wt_dir else ""),
        f"Model: {cfg['raw_model']} @ {cfg['base_url']}",
        f"Subagent: {subagent.strip() or 'lead (TaskToolSet enabled)'}",
        f"Workspace: {workspace_cwd}",
        f"Status: {status_str}",
        f"Steps: {outcome.get('steps', 0)} (Decision rounds: {outcome.get('decision_rounds', 0)})",
        "Changed Files: " + (", ".join(changed_files) if changed_files else "(none detected via git status)"),
    ]
    if any(p.startswith(("web/", "browser-desktop/")) for p in changed_files):
        lines.append(
            "UI Verification Hint: Frontend files were modified — if the Sanctuary Browser pane is open "
            "on the target view, call [browser_action(action=\"snapshot\")] to confirm live DOM layout."
        )
    if err_msg:
        lines.append(f"Error: {err_msg}")
    if summary:
        lines.append("")
        lines.append("Agent Summary:")
        lines.append(summary)
    return "\n".join(lines)
