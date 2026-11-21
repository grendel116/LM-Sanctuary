"""Antigravity SDK delegation pipeline for Sanctuary programs.

Offloads multi-file coding, refactoring, debugging, and verification to an
orchestrated Antigravity Agent while keeping the local model in VRAM as an
autonomous decision broker via SDK lifecycle hooks and policies.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import json
import os
import re
import subprocess
import threading
import time

from google.antigravity import Agent, LocalAgentConfig, types
from google.antigravity.hooks import hooks, policy
from utils import lifecycle

DEFAULT_ORCHESTRATED_MODEL = "gemini-4-neon"
MAX_STOP_CONTINUATIONS = 3
MAX_DIGEST_CHARS = 2500
_MISSING_AUTH_ERROR = (
    "Error: Antigravity authentication is not configured. Enter your Antigravity API Key "
    "in Project Settings (or set `GEMINI_API_KEY` from https://aistudio.google.com/app/api-keys "
    "in `.env`, or enable Vertex ADC with `GOOGLE_GENAI_USE_VERTEXAI=true`)."
)

MODEL_ALIASES: dict[str, tuple[str, str]] = {
    "": (DEFAULT_ORCHESTRATED_MODEL, "Orchestrator (Neon)"),
    "orchestrator": (DEFAULT_ORCHESTRATED_MODEL, "Orchestrator (Neon)"),
    "neon": (DEFAULT_ORCHESTRATED_MODEL, "Orchestrator (Neon)"),
    "orchestrator (neon)": (DEFAULT_ORCHESTRATED_MODEL, "Orchestrator (Neon)"),
    "gemini-pro-orchestrator-neon": (DEFAULT_ORCHESTRATED_MODEL, "Orchestrator (Neon)"),
    "gemini-4-neon": (DEFAULT_ORCHESTRATED_MODEL, "Orchestrator (Neon)"),
    "argon": ("gemini-4-argon", "Orchestrator (Argon)"),
    "orchestrator (argon)": ("gemini-4-argon", "Orchestrator (Argon)"),
    "gemini-pro-orchestrator-argon": ("gemini-4-argon", "Orchestrator (Argon)"),
    "gemini-4-argon": ("gemini-4-argon", "Orchestrator (Argon)"),
    "carbon": ("gemini-4-carbon", "Orchestrator (Carbon)"),
    "orchestrator (carbon)": ("gemini-4-carbon", "Orchestrator (Carbon)"),
    "gemini-pro-orchestrator": ("gemini-4-carbon", "Orchestrator (Carbon)"),
    "gemini-4-carbon": ("gemini-4-carbon", "Orchestrator (Carbon)"),
    "hydrogen": ("gemini-4-hydrogen", "Gemini 4 Hydrogen"),
    "gemini-4-hydrogen": ("gemini-4-hydrogen", "Gemini 4 Hydrogen"),
    "flash": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    "gemini-3.8-flash": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    "gemini-3.8-flash-high": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    "gemini-3.8-flash-medium": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    "gemini-3.8-flash-low": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    "gemini 3.8 flash (high)": ("gemini-3.8-flash", "Gemini 3.8 Flash"),
    "flash_lite": ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
    "gemini-3.5-flash-lite": ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
    "gemini 3.8 flash (low)": ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite"),
}

_sessions_lock = threading.Lock()
_active_jobs_lock = threading.Lock()


@dataclass(eq=False)
class _ActiveAntigravityJob:
    session_id: str
    loop: asyncio.AbstractEventLoop
    main_task: asyncio.Task
    chat_task: asyncio.Task | None = None
    agent: object | None = None
    response: object | None = None
    process: object | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    finished_event: threading.Event = field(default_factory=threading.Event)
    descendant_snapshot: list[tuple[int, float]] = field(default_factory=list)


_active_jobs: dict[str, set[_ActiveAntigravityJob]] = {}


def _is_session_cancelled(session_id: str) -> bool:
    try:
        from runners.runner import cancelled_sessions

        return bool(session_id and session_id in cancelled_sessions)
    except Exception:
        return False


def _extract_agent_process(agent) -> object | None:
    conv = getattr(agent, "_conversation", None)
    conn = getattr(conv, "_connection", None) if conv is not None else None
    if conn is None:
        conn = getattr(getattr(agent, "_strategy", None), "_connection", None)
    proc = getattr(conn, "_process", None) if conn is not None else None
    if proc is not None and hasattr(proc, "pid"):
        return proc
    return None


def _snapshot_descendants(proc) -> list[tuple[int, float]]:
    pid = getattr(proc, "pid", None)
    if not pid:
        return []
    try:
        import psutil

        parent = psutil.Process(pid)
        snapshots: list[tuple[int, float]] = []
        for child in parent.children(recursive=True):
            try:
                snapshots.append((child.pid, child.create_time()))
            except Exception:
                pass
        return snapshots
    except Exception:
        return []


def _terminate_pid_snapshots(snapshots: list[tuple[int, float]], grace: float = 0.3) -> None:
    if not snapshots:
        return
    try:
        import psutil
    except Exception:
        return

    procs = []
    for pid, create_time in snapshots:
        try:
            p = psutil.Process(pid)
            if abs(p.create_time() - create_time) < 1.0:
                procs.append(p)
        except Exception:
            pass

    for p in reversed(procs):
        try:
            p.terminate()
        except Exception:
            pass

    if procs:
        try:
            _, alive = psutil.wait_procs(procs, timeout=grace)
        except Exception:
            alive = procs
        for p in alive:
            try:
                p.kill()
            except Exception:
                pass


def _terminate_process_tree(
    proc,
    extra_descendants: list[tuple[int, float]] = (),
    grace: float = 0.4,
) -> bool:
    """Terminates an Antigravity harness process and its entire descendant tree."""
    if proc is None:
        _terminate_pid_snapshots(list(extra_descendants), grace=grace)
        return bool(extra_descendants)

    pid = getattr(proc, "pid", None)
    psutil_handled = False
    if pid:
        try:
            import psutil

            parent = psutil.Process(pid)
            children = parent.children(recursive=True)
            targets = [*reversed(children), parent]
            for p in targets:
                try:
                    p.terminate()
                except Exception:
                    pass
            _, alive = psutil.wait_procs(targets, timeout=grace)
            for p in alive:
                try:
                    p.kill()
                except Exception:
                    pass
            psutil_handled = True
        except Exception:
            pass

    _terminate_pid_snapshots(list(extra_descendants), grace=0.2)

    is_running = True
    try:
        is_running = proc.poll() is None
    except Exception:
        pass

    if os.name == "nt" and pid and (is_running or not psutil_handled):
        try:
            kwargs: dict = {}
            lifecycle._apply_no_window_popen_defaults(kwargs)
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=5,
                **kwargs,
            )
        except Exception:
            pass

    try:
        if proc.poll() is None:
            proc.kill()
        proc.wait(timeout=1.0)
    except Exception:
        pass

    for pipe_name in ("stdin", "stdout"):
        pipe = getattr(proc, pipe_name, None)
        if pipe is not None:
            try:
                pipe.close()
            except Exception:
                pass

    return True


async def _run_cancellable_thread(fn, *args):
    """Runs blocking fn in a daemon thread so cancelling never stalls asyncio.run() teardown."""
    loop = asyncio.get_running_loop()
    fut = loop.create_future()

    def _resolve_result(res):
        if not fut.done():
            fut.set_result(res)

    def _resolve_exc(exc):
        if not fut.done():
            fut.set_exception(exc)

    def _worker():
        try:
            res = fn(*args)
        except BaseException as exc:
            try:
                loop.call_soon_threadsafe(_resolve_exc, exc)
            except RuntimeError:
                pass
        else:
            try:
                loop.call_soon_threadsafe(_resolve_result, res)
            except RuntimeError:
                pass

    threading.Thread(target=_worker, daemon=True).start()
    return await fut


def _cancel_jobs(jobs: list[_ActiveAntigravityJob], *, grace: float, timeout: float) -> bool:
    if not jobs:
        return False

    start = time.monotonic()

    def _schedule_cooperative(job: _ActiveAntigravityJob) -> None:
        async def _cooperative_cancel():
            try:
                if job.response is not None and hasattr(job.response, "cancel"):
                    await asyncio.wait_for(job.response.cancel(), timeout=0.6)
                else:
                    conv = getattr(job.agent, "_conversation", None)
                    if conv is not None and hasattr(conv, "cancel"):
                        await asyncio.wait_for(conv.cancel(), timeout=0.6)
            except BaseException:
                pass
            target = job.chat_task if job.chat_task is not None else job.main_task
            if target is not None and not target.done():
                target.cancel()

        try:
            job.loop.call_soon_threadsafe(lambda: job.loop.create_task(_cooperative_cancel()))
        except RuntimeError:
            pass

    for job in jobs:
        job.cancel_event.set()
        if job.process is None and job.agent is not None:
            job.process = _extract_agent_process(job.agent)
        if job.process is not None:
            seen = set(job.descendant_snapshot)
            for item in _snapshot_descendants(job.process):
                if item not in seen:
                    job.descendant_snapshot.append(item)
                    seen.add(item)
        _schedule_cooperative(job)

    grace_deadline = start + max(0.0, grace)
    for job in jobs:
        remaining = grace_deadline - time.monotonic()
        if remaining <= 0:
            break
        job.finished_event.wait(timeout=remaining)

    total_deadline = start + max(grace, timeout)
    for job in jobs:
        if not job.finished_event.is_set():
            if job.process is None and job.agent is not None:
                job.process = _extract_agent_process(job.agent)
            _terminate_process_tree(job.process, job.descendant_snapshot)

            def _force_cancel(j: _ActiveAntigravityJob = job) -> None:
                if j.chat_task is not None and not j.chat_task.done():
                    j.chat_task.cancel()
                if j.main_task is not None and not j.main_task.done():
                    j.main_task.cancel()

            try:
                job.loop.call_soon_threadsafe(_force_cancel)
            except RuntimeError:
                pass

            remaining = max(0.1, total_deadline - time.monotonic())
            job.finished_event.wait(timeout=remaining)

    for job in jobs:
        if job.process is None and job.agent is not None:
            job.process = _extract_agent_process(job.agent)
        _terminate_process_tree(job.process, job.descendant_snapshot)

    return True


def cancel_antigravity_jobs(session_id: str, *, grace: float = 0.8, timeout: float = 3.0) -> bool:
    """Cancels all active Antigravity jobs and process trees for the given session."""
    with _active_jobs_lock:
        jobs = list(_active_jobs.get(session_id, ()))
    return _cancel_jobs(jobs, grace=grace, timeout=timeout)


def cancel_all_antigravity_jobs(*, grace: float = 0.5, timeout: float = 2.0) -> bool:
    """Cancels every active Antigravity job and process tree across all sessions."""
    with _active_jobs_lock:
        jobs = [job for group in _active_jobs.values() for job in group]
    return _cancel_jobs(jobs, grace=grace, timeout=timeout)


def resolve_antigravity_model(model: str = "") -> tuple[str, str]:
    """Resolves explicit argument, ANTIGRAVITY_MODEL env var, or default Neon orchestrator."""
    candidate = (model or "").strip() or os.getenv("ANTIGRAVITY_MODEL", "").strip()
    if candidate.lower().startswith("models/"):
        candidate = candidate[len("models/") :].strip()
    if not candidate:
        return MODEL_ALIASES[""]
    normalized = candidate.lower()
    if normalized in MODEL_ALIASES:
        return MODEL_ALIASES[normalized]
    return candidate, candidate


def _resolve_gemini_api_key() -> str:
    """Resolves the Gemini API key from Project Settings first, then GEMINI_API_KEY env."""
    try:
        from runners.program import _load_settings

        settings_key = str(_load_settings().get("gemini_api_key") or "").strip()
        if settings_key:
            return settings_key
    except Exception:
        pass
    return os.getenv("GEMINI_API_KEY", "").strip()


def _resolve_autonomy_policies() -> tuple[str, str]:
    """Reads Project Settings security_preset and artifact_review_policy."""
    try:
        from runners.program import _load_settings

        settings = _load_settings()
    except Exception:
        settings = {}

    raw_sec = str(settings.get("security_preset", "ask_always")).strip().lower()
    security_preset = "auto" if raw_sec in ("auto", "turbo", "auto_approve") else "ask_always"

    raw_rev = str(settings.get("artifact_review_policy", "ask_always")).strip().lower()
    if raw_rev in ("auto", "turbo", "auto_approve") or security_preset == "auto":
        review_policy = "auto_approve"
    else:
        review_policy = "ask_always"

    return security_preset, review_policy


def _antigravity_data_dir() -> str:
    from tools.tools import root_dir

    path = os.path.join(root_dir, "data", "antigravity")
    os.makedirs(path, exist_ok=True)
    return path


def _sessions_file_path() -> str:
    return os.path.join(_antigravity_data_dir(), "sessions.json")


def _session_key(program_id: str, session_id: str, target_cwd: str) -> str:
    norm_cwd = os.path.normcase(os.path.abspath(target_cwd))
    return f"{program_id or 'sebile'}::{session_id or 'default'}::{norm_cwd}"


def _load_saved_conversation_id(program_id: str, session_id: str, target_cwd: str) -> str | None:
    key = _session_key(program_id, session_id, target_cwd)
    with _sessions_lock:
        try:
            with open(_sessions_file_path(), "r", encoding="utf-8") as f:
                data = json.load(f)
            entry = data.get(key)
            if isinstance(entry, dict) and entry.get("conversation_id"):
                return str(entry["conversation_id"])
        except (OSError, json.JSONDecodeError):
            pass
    return None


def _save_conversation_id(
    program_id: str,
    session_id: str,
    target_cwd: str,
    conversation_id: str,
    model_id: str,
) -> None:
    if not conversation_id:
        return
    key = _session_key(program_id, session_id, target_cwd)
    path = _sessions_file_path()
    with _sessions_lock:
        data = {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                data = loaded
        except (OSError, json.JSONDecodeError):
            pass
        data[key] = {
            "conversation_id": conversation_id,
            "model": model_id,
            "updated": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        tmp_path = path + ".tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp_path, path)


def _recent_dialogue_excerpt(session_id: str, limit: int = 4) -> str:
    try:
        import state as st

        runner = getattr(st, "runner", None)
        if not runner:
            return ""
        history = runner.sessions_history.get(session_id, [])
        turns = []
        for msg in reversed(history):
            role = msg.get("role")
            text = (msg.get("text") or "").strip()
            msg_id = msg.get("id", "")
            if role not in ("user", "program", "assistant") or not text:
                continue
            if msg_id.startswith(("tool_", "itm_", "sys_")) or text.startswith("[Tool Response from"):
                continue
            label = "User" if role == "user" else "Program"
            turns.append(f"{label}: {text[:300]}")
            if len(turns) >= limit:
                break
        return "\n".join(reversed(turns))
    except Exception:
        return ""


def _sebile_decide(
    question: str,
    options: list[str] | None,
    task_goal: str,
    program_id: str,
    session_id: str,
) -> dict:
    """Queries the active local program model to resolve a coding decision autonomously."""
    if _is_session_cancelled(session_id):
        if options:
            first_id = options[0].split(":", 1)[0].strip()
            return {
                "decision": options[0],
                "selected_option": first_id,
                "rationale": "Session cancelled by user.",
                "needs_continuation": False,
            }
        return {
            "decision": "",
            "selected_option": "",
            "rationale": "Session cancelled by user.",
            "needs_continuation": False,
        }

    import httpx
    from core.program_config import (
        _load_card_data,
        compile_instructions_from_card,
        get_program_name,
        load_user_instructions,
    )
    from utils.utils import THINK_TAG_PATTERN as _THINK_RE
    from variables.settings import DISABLED_THINKING, LOCAL_SERVER_URL, get_local_server_headers

    card = _load_card_data(program_id)
    program_name = get_program_name(program_id)
    persona = compile_instructions_from_card(card, include_example=False) if card else f"# IDENTITY: {program_name}"
    user_ctx = load_user_instructions()
    excerpt = _recent_dialogue_excerpt(session_id)

    system_prompt = (
        f"{persona}\n{user_ctx}\n"
        f"# DECISION BROKER ROLE\n"
        f"You are {program_name}, acting as the user's autonomous technical proxy for a delegated Antigravity coding job. "
        "Decide clearly and concretely based on the user's preferences, architectural simplicity, and the active task goal.\n"
        'Respond with JSON only: {"decision": "concrete choice or answer", "selected_option": "matching option id or text if options provided, else empty", '
        '"rationale": "one short sentence", "needs_continuation": true|false}'
    )

    user_parts = [f"CODING TASK GOAL:\n{task_goal[:1000]}"]
    if excerpt:
        user_parts.append(f"RECENT CONVERSATION:\n{excerpt}")
    user_parts.append(f"ANTIGRAVITY MESSAGE / QUESTION:\n{question[:1500]}")
    if options:
        user_parts.append("AVAILABLE OPTIONS:\n" + "\n".join(f"- {opt}" for opt in options))
        user_parts.append("Choose the best option(s) and set 'needs_continuation' to true.")
    else:
        user_parts.append(
            "If Antigravity is asking a clarifying question or waiting for plan approval, set 'needs_continuation' to true "
            "and put your concrete answer/approval in 'decision'. If the task is already finished and only offering optional follow-ups, "
            "set 'needs_continuation' to false."
        )

    endpoint = LOCAL_SERVER_URL.rstrip("/")
    if not endpoint.endswith("/chat/completions"):
        endpoint += "/chat/completions" if endpoint.endswith("/v1") else "/v1/chat/completions"
    model = os.getenv("LOCAL_MODEL_NAME", "local-llm")

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": "\n\n".join(user_parts)},
        ],
        "temperature": 0.2,
        "max_tokens": 400,
        "cache_prompt": False,
    }
    if isinstance(DISABLED_THINKING, dict):
        payload.update(DISABLED_THINKING)

    if os.getenv("AUTO_START_LOCAL_LLM", "true").lower() != "false":
        try:
            from adapters.vram_orchestrator import start_llm

            start_llm(model)
        except Exception:
            pass

    try:
        res = httpx.post(endpoint, json=payload, headers=get_local_server_headers(), timeout=120.0)
        if res.status_code == 200:
            raw = res.json()["choices"][0]["message"].get("content", "") or ""
            cleaned = _THINK_RE.sub("", raw).strip()
            match = re.search(r"\{[\s\S]*\}", cleaned)
            if match:
                parsed = json.loads(match.group(0))
                if isinstance(parsed, dict) and parsed.get("decision"):
                    return {
                        "decision": str(parsed.get("decision", "")).strip(),
                        "selected_option": str(parsed.get("selected_option", "")).strip(),
                        "rationale": str(parsed.get("rationale", "Resolved autonomously.")).strip(),
                        "needs_continuation": bool(parsed.get("needs_continuation", bool(options))),
                    }
    except Exception as exc:
        print(f"[antigravity_job] Local decision broker error: {exc}", flush=True)

    if options:
        first_id = options[0].split(":", 1)[0].strip()
        return {
            "decision": options[0],
            "selected_option": first_id,
            "rationale": "Selected default first option (local decision fallback).",
            "needs_continuation": True,
        }
    return {
        "decision": "",
        "selected_option": "",
        "rationale": "No blocking decision required.",
        "needs_continuation": False,
    }


def _match_question_options(entry: types.AskQuestionEntry, decision_text: str, selected_hint: str) -> tuple[list[str] | None, str]:
    """Maps Sebile's decision text/hint onto Antigravity AskQuestionOption IDs."""
    if not entry.options:
        return None, decision_text

    targets = [t.strip().lower() for t in (selected_hint, decision_text) if t and t.strip()]
    matched_ids: list[str] = []

    for opt in entry.options:
        opt_id_l = opt.id.strip().lower()
        opt_txt_l = opt.text.strip().lower()
        if any(opt_id_l == t or opt_txt_l == t or opt_id_l in t or opt_txt_l in t for t in targets):
            matched_ids.append(opt.id)
            if not entry.is_multi_select:
                break

    if not matched_ids:
        matched_ids = [entry.options[0].id]
        return matched_ids, decision_text

    return matched_ids, ""


def _extract_tool_target(call: types.ToolCall | None) -> str:
    if not call or not isinstance(call.args, dict):
        return ""
    if call.canonical_path:
        return call.canonical_path
    for key in ("path", "file_path", "TargetFile", "AbsolutePath", "script_path"):
        val = call.args.get(key)
        if isinstance(val, str) and val.strip():
            return val.strip()
    return ""


def _format_digest(
    *,
    model_id: str,
    display_name: str,
    target_cwd: str,
    conversation_id: str | None,
    stop_reason: str,
    changed_files: list[str],
    commands_run: list[str],
    decisions_log: list[dict],
    summary_text: str,
) -> str:
    sections = [
        "ANTIGRAVITY DELEGATION DIGEST",
        f"Model: {display_name} ({model_id})",
        f"Workspace: {target_cwd}",
        f"Conversation ID: {conversation_id or 'ephemeral'}",
        f"Stop Reason: {stop_reason}",
    ]

    if changed_files:
        sections.append("Files Created/Modified:\n" + "\n".join(f"- {p}" for p in changed_files[:20]))
    else:
        sections.append("Files Created/Modified: none recorded")

    if commands_run:
        sections.append("Commands Executed:\n" + "\n".join(f"- {c}" for c in commands_run[:12]))

    if decisions_log:
        dec_lines = [
            f"- Q: {d['question'][:120]} -> Decision ({d['approved_by']}): {d['decision'][:160]} ({d['rationale'][:120]})"
            for d in decisions_log[:10]
        ]
        sections.append("Decisions Made:\n" + "\n".join(dec_lines))

    clean_summary = (summary_text or "").strip() or "(No text summary returned.)"
    sections.append(f"Antigravity Summary:\n{clean_summary}")

    digest = "\n\n".join(sections)
    if len(digest) > MAX_DIGEST_CHARS:
        header_part = "\n\n".join(sections[:-1])
        remaining = max(300, MAX_DIGEST_CHARS - len(header_part) - 45)
        digest = f"{header_part}\n\nAntigravity Summary:\n{clean_summary[:remaining]}..."
    return digest


async def _run_antigravity_job(
    *,
    task: str,
    target_cwd: str,
    model_id: str,
    display_name: str,
    resume: bool,
    program_id: str,
    session_id: str,
    api_key: str = "",
) -> str:
    from core.program_config import compile_program_gemini_md
    from tools.tools import (
        confirm_tool_execution,
        session_tool_calls,
        session_tool_calls_lock,
    )

    if _is_session_cancelled(session_id):
        raise asyncio.CancelledError("Antigravity coding job cancelled by user.")

    security_preset, review_policy = _resolve_autonomy_policies()
    gemini_instructions = compile_program_gemini_md(program_id)

    data_dir = _antigravity_data_dir()
    trajectories_dir = os.path.join(data_dir, "trajectories")
    app_data_dir = os.path.join(data_dir, "app_data")
    os.makedirs(trajectories_dir, exist_ok=True)
    os.makedirs(app_data_dir, exist_ok=True)

    changed_files: list[str] = []
    commands_run: list[str] = []
    decisions_log: list[dict] = []
    pending_calls: dict[str, types.ToolCall] = {}
    live_call_entries: dict[str, dict] = {}

    loop = asyncio.get_running_loop()
    main_task = asyncio.current_task()
    job = _ActiveAntigravityJob(session_id=session_id, loop=loop, main_task=main_task)
    with _active_jobs_lock:
        _active_jobs.setdefault(session_id, set()).add(job)

    def _job_cancelled() -> bool:
        return job.cancel_event.is_set() or _is_session_cancelled(session_id)

    async def _gate_decision(question: str, decision: str, rationale: str) -> tuple[bool, str]:
        if _job_cancelled():
            return False, "cancelled"
        if review_policy == "auto_approve":
            return True, program_id
        details = f"Question: {question[:300]}\nProposed Decision: {decision[:300]}\nRationale: {rationale[:200]}"
        approved = await _run_cancellable_thread(confirm_tool_execution, "antigravity_decision", details)
        return bool(approved), ("user_approved" if approved else "user_denied")

    @hooks.on_interaction
    async def on_interaction(data: types.AskQuestionInteractionSpec) -> types.QuestionHookResult:
        if _job_cancelled():
            return types.QuestionHookResult(responses=[], cancelled=True)
        responses: list[types.QuestionResponse] = []
        for entry in data.questions:
            if _job_cancelled():
                return types.QuestionHookResult(responses=[], cancelled=True)
            opt_labels = [f"{opt.id}: {opt.text}" for opt in entry.options]
            dec = await _run_cancellable_thread(
                _sebile_decide,
                entry.question,
                opt_labels or None,
                task,
                program_id,
                session_id,
            )
            if _job_cancelled():
                return types.QuestionHookResult(responses=[], cancelled=True)
            decision_text = dec["decision"]
            rationale = dec["rationale"]
            approved, actor = await _gate_decision(entry.question, decision_text, rationale)
            if not approved:
                decisions_log.append(
                    {
                        "question": entry.question,
                        "decision": "Cancelled by user",
                        "rationale": rationale,
                        "approved_by": actor,
                    }
                )
                return types.QuestionHookResult(responses=[], cancelled=True)

            selected_ids, freeform = _match_question_options(entry, decision_text, dec.get("selected_option", ""))
            decisions_log.append(
                {
                    "question": entry.question,
                    "decision": ", ".join(selected_ids) if selected_ids else freeform,
                    "rationale": rationale,
                    "approved_by": actor,
                }
            )
            responses.append(types.QuestionResponse(selected_option_ids=selected_ids, freeform_response=freeform))
        return types.QuestionHookResult(responses=responses)

    @hooks.stop
    async def on_stop(data: types.StopArgs) -> types.StopHookResult:
        if (
            _job_cancelled()
            or data.continuation_count >= MAX_STOP_CONTINUATIONS
            or data.error_message
            or data.stop_reason not in (types.StopReason.UNSPECIFIED, None)
            or "?" not in (data.response_text or "")
        ):
            return types.StopHookResult(decision=types.StopDecision.ALLOW_STOP)

        dec = await _run_cancellable_thread(
            _sebile_decide,
            data.response_text[-1500:],
            None,
            task,
            program_id,
            session_id,
        )
        if _job_cancelled() or not dec.get("needs_continuation") or not dec.get("decision"):
            return types.StopHookResult(decision=types.StopDecision.ALLOW_STOP)

        approved, actor = await _gate_decision(data.response_text[-300:], dec["decision"], dec["rationale"])
        if not approved:
            return types.StopHookResult(decision=types.StopDecision.ALLOW_STOP)

        decisions_log.append(
            {
                "question": data.response_text[-160:].strip(),
                "decision": dec["decision"],
                "rationale": dec["rationale"],
                "approved_by": actor,
            }
        )
        return types.StopHookResult(decision=types.StopDecision.CONTINUE, reason=dec["decision"])

    @hooks.pre_tool_call_decide
    async def on_pre_tool(data: types.ToolCall) -> types.HookResult:
        if _job_cancelled():
            if job.response is not None and hasattr(job.response, "cancel"):
                cancel_task = asyncio.create_task(job.response.cancel())
                cancel_task.add_done_callback(lambda t: t.exception() if not t.cancelled() else None)
            return types.HookResult(allow=False, message="Session cancelled by user.")

        if data.id:
            pending_calls[data.id] = data

        args_rep = (
            json.dumps(data.args, ensure_ascii=False)[:240]
            if isinstance(data.args, dict)
            else str(data.args)[:240]
        )
        entry = {
            "id": data.id or f"ag_{int(time.time() * 1000)}",
            "name": f"antigravity:{data.name}",
            "args": args_rep,
            "status": "running",
            "response": "",
            "start_time": time.time(),
            "duration": 0.0,
        }
        with session_tool_calls_lock:
            session_tool_calls.setdefault(session_id, []).append(entry)
        if data.id:
            live_call_entries[data.id] = entry

        return types.HookResult(allow=True)

    @hooks.post_tool_call
    async def on_post_tool(data: types.ToolResult) -> None:
        call = pending_calls.pop(data.id, None) if data.id else None
        entry = live_call_entries.pop(data.id, None) if data.id else None
        if entry is not None:
            with session_tool_calls_lock:
                entry["duration"] = round(time.time() - entry["start_time"], 2)
                entry["status"] = "failed" if data.error else "completed"
                entry["response"] = str(data.error if data.error else (data.result or ""))[:1000]

        tool_name = str(data.name)
        if tool_name in ("create_file", "edit_file", "write_file") and not data.error:
            target = _extract_tool_target(call)
            if target and target not in changed_files:
                changed_files.append(target)
        elif tool_name == "run_command":
            cmd = ""
            if call and isinstance(call.args, dict):
                cmd = str(call.args.get("CommandLine") or call.args.get("command") or "").strip()
            status = f"error: {data.error[:80]}" if data.error else "ok"
            if cmd:
                commands_run.append(f"`{cmd[:120]}` ({status})")

    async def _confirm_via_sanctuary(tc: types.ToolCall, reason: str = "") -> bool:
        if _job_cancelled():
            return False
        args_preview = json.dumps(tc.args, ensure_ascii=False)[:400] if isinstance(tc.args, dict) else str(tc.args)[:400]
        details = f"Tool: {tc.name}\nArgs: {args_preview}"
        if reason:
            details += f"\nReason: {reason}"
        return bool(await _run_cancellable_thread(confirm_tool_execution, f"antigravity:{tc.name}", details))

    if security_preset == "auto":
        active_policies: list[policy.Policy] = [
            *policy.workspace_only([target_cwd]),
            policy.allow_all(),
        ]
    else:
        active_policies = [
            *policy.workspace_only([target_cwd]),
            policy.ask_user("run_command", handler=_confirm_via_sanctuary),
            policy.ask_user("edit_file", handler=_confirm_via_sanctuary),
            policy.ask_user("create_file", handler=_confirm_via_sanctuary),
            policy.allow("*"),
        ]

    prior_conv_id = _load_saved_conversation_id(program_id, session_id, target_cwd) if resume else None

    config_kwargs: dict = {
        "model": model_id,
        "system_instructions": gemini_instructions,
        "workspaces": [target_cwd],
        "capabilities": types.CapabilitiesConfig(
            enable_subagents=True,
            agent_behavior=types.AgentBehavior.INTERACTIVE,
        ),
        "policies": active_policies,
        "hooks": [on_interaction, on_stop, on_pre_tool, on_post_tool],
        "budget_config": types.BudgetConfig(
            max_model_calls=30,
            max_tool_calls=60,
            max_total_tokens=250_000,
        ),
        "save_dir": trajectories_dir,
        "app_data_dir": app_data_dir,
    }
    if api_key:
        config_kwargs["api_key"] = api_key
    if prior_conv_id and len(prior_conv_id.strip()) >= 32:
        config_kwargs["conversation_id"] = prior_conv_id.strip()
        config_kwargs["session_continuation_mode"] = types.SessionContinuationMode.CREATE_OR_RESUME

    config = LocalAgentConfig(**config_kwargs)

    try:
        async with Agent(config) as agent:
            job.agent = agent
            job.process = _extract_agent_process(agent)
            if isinstance(job.process, subprocess.Popen):
                lifecycle.track(job.process)
            if _job_cancelled():
                raise asyncio.CancelledError("Antigravity coding job cancelled by user.")

            async def _execute_turn():
                resp = await agent.chat(task)
                job.response = resp
                if _job_cancelled() and hasattr(resp, "cancel"):
                    try:
                        await asyncio.wait_for(resp.cancel(), timeout=0.6)
                    except BaseException:
                        pass
                    raise asyncio.CancelledError("Antigravity coding job cancelled by user.")
                summary = await resp.text()
                return resp, summary

            job.chat_task = asyncio.create_task(_execute_turn())
            response, summary_text = await job.chat_task
            if _job_cancelled():
                raise asyncio.CancelledError("Antigravity coding job cancelled by user.")
            active_conv_id = agent.conversation_id or prior_conv_id
            if active_conv_id:
                _save_conversation_id(program_id, session_id, target_cwd, active_conv_id, model_id)
            stop_reason = str(getattr(response.stop_reason, "name", response.stop_reason))
    except BaseException as exc:
        if _job_cancelled() or isinstance(exc, (asyncio.CancelledError, types.AntigravityCancelledError)):
            raise asyncio.CancelledError("Antigravity coding job cancelled by user.") from exc
        raise
    finally:
        if _job_cancelled():
            with session_tool_calls_lock:
                now = time.time()
                for entry in live_call_entries.values():
                    if entry.get("status") == "running":
                        entry["status"] = "cancelled"
                        entry["duration"] = round(now - entry.get("start_time", now), 2)
                        entry["response"] = "Cancelled by user."
            _terminate_process_tree(job.process, job.descendant_snapshot)
        with _active_jobs_lock:
            session_jobs = _active_jobs.get(session_id)
            if session_jobs is not None:
                session_jobs.discard(job)
                if not session_jobs:
                    _active_jobs.pop(session_id, None)
        job.finished_event.set()

    return _format_digest(
        model_id=model_id,
        display_name=display_name,
        target_cwd=target_cwd,
        conversation_id=active_conv_id,
        stop_reason=stop_reason,
        changed_files=changed_files,
        commands_run=commands_run,
        decisions_log=decisions_log,
        summary_text=summary_text,
    )


def delegate_coding(task: str, path: str = "", model: str = "", resume: bool = True) -> str:
    """Delegates a coding, debugging, refactoring, or workspace inspection task to Antigravity.

    Args:
        task: Detailed description of the coding task, bug, or workspace check to perform.
        path: Optional target workspace directory or file path (defaults to the active project workspace).
        model: Optional Antigravity model or tier override (defaults to Orchestrator (Neon)).
        resume: Whether to resume the saved Antigravity conversation for this workspace (default True).
    """
    clean_task = (task or "").strip()
    if not clean_task:
        return "Error: `task` is required when calling delegate_coding."

    from runners.program import get_active_program
    from tools.tools import (
        current_session_id,
        current_speaker_id,
        resolve_workspace_cwd,
    )

    api_key = _resolve_gemini_api_key()
    if api_key:
        os.environ["GEMINI_API_KEY"] = api_key
    has_vertex = (
        os.getenv("GOOGLE_GENAI_USE_VERTEXAI", "").lower() in ("true", "1")
        or os.getenv("GOOGLE_GENAI_USE_ENTERPRISE", "").lower() in ("true", "1")
    )
    if not api_key and not has_vertex:
        return _MISSING_AUTH_ERROR

    target_cwd = resolve_workspace_cwd(path)
    if not os.path.isdir(target_cwd):
        return f"Error: Target workspace directory '{target_cwd}' does not exist."

    model_id, display_name = resolve_antigravity_model(model)
    program_id = current_speaker_id.get() or get_active_program()
    session_id = current_session_id.get() or "default"

    if _is_session_cancelled(session_id):
        raise asyncio.CancelledError("Antigravity coding job cancelled by user.")

    try:
        return asyncio.run(
            _run_antigravity_job(
                task=clean_task,
                target_cwd=target_cwd,
                model_id=model_id,
                display_name=display_name,
                resume=bool(resume),
                program_id=program_id,
                session_id=session_id,
                api_key=api_key,
            )
        )
    except asyncio.CancelledError:
        raise
    except (ValueError, types.AntigravityValidationError) as err:
        msg = str(err)
        if "GEMINI_API_KEY" in msg:
            return _MISSING_AUTH_ERROR
        return f"Error configuring Antigravity coding job: {msg}"
    except Exception as err:
        return f"Error executing Antigravity coding job: {err}"
