"""Single in-process OpenHands + Git Bash coding harness for LM-Sanctuary (zero regex)."""

from __future__ import annotations

import os

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")
os.environ.setdefault("OH_TELEMETRY_CONSENT", "false")

import json
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from collections.abc import Callable, Sequence
from typing import Any

from pydantic import Field

from openhands.sdk import LLM, Agent, AgentContext, Conversation, Tool, register_tool
from openhands.sdk.context.condenser import LLMSummarizingCondenser
from openhands.sdk.conversation.response_utils import get_agent_final_response
from openhands.sdk.conversation.state import ConversationExecutionStatus, ConversationState
from openhands.sdk.event import ActionEvent, ObservationEvent, UserRejectObservation
from openhands.sdk.event.ask_user import answer_message_text, find_pending_ask_back
from openhands.sdk.security.confirmation_policy import AlwaysConfirm, NeverConfirm
from openhands.sdk.subagent import (
    agent_definition_to_factory,
    get_registered_agent_definitions,
    load_project_agents,
    load_user_agents,
    register_agent_if_absent,
)
from openhands.sdk.subagent.schema import AgentDefinition
from openhands.sdk.tool import (
    Action,
    Observation,
    ToolAnnotations,
    ToolDefinition,
    ToolExecutor,
)
from openhands.tools.ask_user import AskUserTool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.glob import GlobTool
from openhands.tools.grep import GrepTool
from openhands.tools.preset.default import register_builtins_agents
from openhands.tools.task import TaskToolSet
from openhands.tools.terminal.definition import (
    TerminalAction,
    TerminalObservation,
    TerminalTool,
)
from openhands.tools.terminal.metadata import CmdOutputMetadata

try:
    from openhands.sdk.event import AgentErrorEvent

    _RESULT_EVENT_TYPES: tuple[type[Any], ...] = (
        ObservationEvent,
        UserRejectObservation,
        AgentErrorEvent,
    )
except ImportError:
    AgentErrorEvent = None  # type: ignore[assignment,misc]
    _RESULT_EVENT_TYPES = (ObservationEvent, UserRejectObservation)

from core import program_config, v1_client
from utils import lifecycle
from variables.settings import (
    BASE_DIR as SANCTUARY_DIR,
    LOCAL_SERVER_URL,
)

DEFAULT_OPENHANDS_MODEL = "glm-5.3"
_MAX_CMD_OUTPUT_CHARS = 12000
_PROJECT_SETTINGS_PATH = os.path.join(SANCTUARY_DIR, "variables", "project_settings.json")
_PERSISTENCE_ROOT = os.path.join(SANCTUARY_DIR, "data", "openhands", "conversations")

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
    "gemini-2.5-pro": "glm-5.3",
    "gemini-pro": "glm-5.3",
    "gemini-2.5-flash": "glm-5.3-flash",
    "gemini-2.5-flash-lite": "glm-5.3-flash",
    "gemini-flash": "glm-5.3-flash",
}

_ACTIVE_LOCK = threading.Lock()
_ACTIVE_RUNS: dict[str, list[dict[str, Any]]] = {}

_SANCTUARY_BUILTIN_SUBAGENTS: tuple[dict[str, Any], ...] = (
    {
        "name": "researcher",
        "tier": "fast",
        "description": (
            "Read-only codebase investigator. Searches symbols, inspects files, and gathers "
            "concrete evidence without modifying files."
        ),
        "tools": ["file_editor", "grep", "glob", "terminal"],
        "system_prompt": (
            "You are the `researcher` subagent. Inspect files via `file_editor` (`view`), `grep`, `glob`, "
            "and strictly read-only `terminal` commands (`git grep -n`, `git status`, `git diff`, `git log`). "
            "Never modify files."
        ),
    },
    {
        "name": "implementer",
        "tier": "deep",
        "description": (
            "Focused software implementer. Applies minimal, verified edits using root-code "
            "design and consolidates shared helpers rather than duplicating logic."
        ),
        "tools": ["file_editor", "grep", "glob", "terminal"],
        "system_prompt": (
            "You are the `implementer` subagent. Read exact target definitions first, make minimal "
            "consolidated edits with `file_editor`, and verify syntax/tests on the touched paths via `terminal`."
        ),
    },
    {
        "name": "verifier",
        "tier": "fast",
        "description": (
            "Independent verification subagent. Runs targeted tests, builds, linters, and git "
            "diff checks after edits and reports exact observed outputs without editing product code."
        ),
        "tools": ["file_editor", "grep", "glob", "terminal"],
        "system_prompt": (
            "You are the `verifier` subagent. Independently inspect the modified diff (`file_editor` "
            "`view`, `git diff`) and execute exact tests/linters/builds via `terminal`. "
            "Never edit source files unless explicitly asked to fix a test; report only observed outputs."
        ),
    },
)


def resolve_shell() -> tuple[str, list[str], str]:
    """(kind, argv_prefix, label): bash/sh everywhere, Git Bash on Windows, PowerShell only as last resort."""
    override = os.environ.get("SANCTUARY_SHELL", "").strip()
    if override and os.path.isfile(override):
        name = os.path.basename(override).lower()
        if "pwsh" in name or "powershell" in name:
            return "powershell", [override, "-NoProfile", "-NonInteractive", "-Command"], f"PowerShell ({override})"
        kind = "sh" if name in ("sh", "sh.exe", "dash", "dash.exe") else "bash"
        return kind, [override, "-c"], f"{kind} ({override})"
    if os.name != "nt":
        for cand in (shutil.which("bash"), "/bin/bash", "/usr/bin/bash"):
            if cand and os.path.isfile(cand):
                return "bash", [cand, "-c"], "bash"
        return "sh", ["/bin/sh", "-c"], "sh"
    candidates: list[str] = []
    git_exe = shutil.which("git")
    if git_exe:
        git_root = os.path.dirname(os.path.dirname(os.path.realpath(git_exe)))
        candidates.append(os.path.join(git_root, "bin", "bash.exe"))
    for env_key in ("ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"):
        base = os.environ.get(env_key)
        if base:
            candidates.append(os.path.join(base, "Git", "bin", "bash.exe"))
    for cand in candidates:
        if os.path.isfile(cand):
            return "bash", [cand, "-c"], "bash (Git Bash)"
    return "powershell", ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"], "Windows PowerShell 5.1 (Git Bash not found)"


_SHELL_KIND, _SHELL_ARGV, _SHELL_LABEL = resolve_shell()


def workspace_python(root: str) -> str:
    """Forward-slash, workspace-relative venv interpreter (portable across Windows/Linux shells)."""
    if root and os.path.isfile(os.path.join(root, ".venv", "Scripts", "python.exe")):
        return ".venv/Scripts/python.exe"
    if root and os.path.isfile(os.path.join(root, ".venv", "bin", "python")):
        return ".venv/bin/python"
    return "python3" if shutil.which("python3") else "python"


def _truncate_cmd_output(text: str) -> str:
    if len(text) <= _MAX_CMD_OUTPUT_CHARS:
        return text
    omitted = len(text) - 11500
    return f"{text[:7500]}\n\n... [{omitted} chars omitted] ...\n\n{text[-4000:]}"


def _path_within_roots(candidate: str, roots: Sequence[str]) -> bool:
    real_cand = os.path.realpath(candidate)
    for r in roots:
        real_r = os.path.realpath(r)
        if real_cand == real_r or real_cand.startswith(real_r + os.sep):
            return True
    return False


class GitBashTerminalExecutor(ToolExecutor[TerminalAction, TerminalObservation]):
    """In-process headless terminal executor using Git Bash (or POSIX bash) with persistent cwd."""

    def __init__(
        self,
        working_dir: str,
        *,
        allowed_roots: Sequence[str] | None = None,
        session_id: str | None = None,
        cancelled_event: threading.Event | None = None,
    ) -> None:
        self._initial_cwd = os.path.abspath(working_dir)
        self._cwd = self._initial_cwd
        self._allowed_roots = [os.path.abspath(r) for r in (allowed_roots or [self._initial_cwd])]
        self._session_id = session_id
        self._cancelled = cancelled_event or threading.Event()
        self._proc_lock = threading.Lock()
        self._active_proc: subprocess.Popen | None = None

    def interrupt(self) -> None:
        with self._proc_lock:
            proc = self._active_proc
        if proc is not None and proc.poll() is None:
            lifecycle.kill_process_tree(proc)

    def close(self) -> None:
        self.interrupt()

    def __call__(
        self, action: TerminalAction, conversation: Any = None
    ) -> TerminalObservation:
        if action.reset:
            self._cwd = self._initial_cwd
            return TerminalObservation.from_text(
                f"Terminal reset to {self._cwd}",
                command="",
                exit_code=0,
                metadata=CmdOutputMetadata(exit_code=0, working_dir=self._cwd),
            )
        if action.is_input:
            return TerminalObservation.from_text(
                "Error: Interactive stdin is not supported; pass non-interactive CLI flags.",
                is_error=True,
                command=action.command,
                exit_code=1,
            )

        clean_cmd = str(action.command or "").strip()
        if not clean_cmd:
            return TerminalObservation.from_text(
                "Error: command is required.",
                is_error=True,
                command="",
                exit_code=1,
            )

        eff_timeout = max(5.0, min(300.0, float(action.timeout or 60.0)))
        shell_kind, shell_argv, _ = resolve_shell()
        if shell_kind in ("bash", "sh"):
            wrapped = (
                f"{clean_cmd}\n"
                "__sanctuary_ec=$?\n"
                "printf '\\n__SANCTUARY_PWD__:%s\\n' \"$(pwd -W 2>/dev/null || pwd)\"\n"
                "exit $__sanctuary_ec"
            )
        else:
            wrapped = clean_cmd

        proc = subprocess.Popen(
            shell_argv + [wrapped],
            cwd=self._cwd,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            **lifecycle.group_popen_kwargs(),
        )
        with self._proc_lock:
            self._active_proc = proc

        try:
            from runners.runner import cancelled_sessions
        except Exception:
            cancelled_sessions = set()

        deadline = time.monotonic() + eff_timeout
        cancelled = False
        timed_out = False
        try:
            while proc.poll() is None:
                if self._cancelled.is_set() or (
                    self._session_id and self._session_id in cancelled_sessions
                ):
                    cancelled = True
                    lifecycle.kill_process_tree(proc)
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    lifecycle.kill_process_tree(proc)
                    break
                time.sleep(0.15)
            try:
                raw_out, _ = proc.communicate(timeout=3)
            except Exception:
                raw_out = b""
        finally:
            with self._proc_lock:
                if self._active_proc is proc:
                    self._active_proc = None

        text = (raw_out or b"").decode("utf-8", errors="replace")
        marker = "\n__SANCTUARY_PWD__:"
        if shell_kind in ("bash", "sh") and marker in text:
            head, _, tail = text.rpartition(marker)
            new_pwd = tail.splitlines()[0].strip() if tail else ""
            text = head
            if new_pwd and os.path.isdir(new_pwd) and _path_within_roots(new_pwd, self._allowed_roots):
                self._cwd = os.path.abspath(new_pwd)

        out_text = _truncate_cmd_output(text.strip())
        exit_code = -1 if (cancelled or timed_out) else int(proc.returncode or 0)
        if cancelled:
            out_text = "Cancelled by user."
        elif timed_out:
            out_text = f"Error: Command timed out after {int(eff_timeout)}s.\n{out_text}".strip()

        return TerminalObservation.from_text(
            out_text or f"[Command exited with code {exit_code}]",
            is_error=(exit_code != 0 or timed_out or cancelled),
            command=clean_cmd,
            exit_code=exit_code,
            timeout=timed_out,
            metadata=CmdOutputMetadata(
                exit_code=exit_code,
                working_dir=self._cwd,
                py_interpreter_path=workspace_python(self._initial_cwd),
            ),
        )


def _build_bash_tool_description(working_dir: str) -> str:
    py_path = workspace_python(working_dir)
    return (
        f"Execute a headless {_SHELL_LABEL} command in the workspace.\n"
        "- Pipes (`|`), `&&`, and `cd` (persisted across calls) work normally; pass `reset=true` to reset cwd.\n"
        "- Prefer `file_editor`, `grep`, and `glob` for reading, searching, and editing files.\n"
        f"- Python venv: `{py_path}`; JS tests: `node --test __tests__/<file>.test.js`."
    )


class GitBashTerminalTool(TerminalTool):
    """OpenHands TerminalTool backed by GitBashTerminalExecutor."""

    name = "terminal"

    @classmethod
    def create(
        cls,
        conv_state: ConversationState,
        username: str | None = None,
        no_change_timeout_seconds: int | None = None,
        terminal_type: Any = None,
        shell_path: str | None = None,
        executor: ToolExecutor | None = None,
        *,
        env: Any = None,
        max_observation_wait_seconds: float | None = None,
    ) -> Sequence["GitBashTerminalTool"]:
        working_dir = conv_state.workspace.working_dir
        if not os.path.isdir(working_dir):
            raise ValueError(f"working_dir '{working_dir}' is not a valid directory")
        exec_inst = executor or GitBashTerminalExecutor(working_dir=working_dir)
        return [
            cls(
                action_type=TerminalAction,
                observation_type=TerminalObservation,
                description=_build_bash_tool_description(working_dir),
                annotations=ToolAnnotations(
                    title="terminal",
                    readOnlyHint=False,
                    destructiveHint=True,
                    idempotentHint=False,
                    openWorldHint=True,
                ),
                executor=exec_inst,
            )
        ]


# --- Sanctuary in-process research & plan tools registered with OpenHands ---


class WebSearchAction(Action):
    query: str = Field(description="Search query for web documentation or facts.")


class WebSearchObservation(Observation):
    pass


class _WebSearchExecutor(ToolExecutor[WebSearchAction, WebSearchObservation]):
    def __call__(self, action: WebSearchAction, conversation: Any = None) -> WebSearchObservation:
        from tools import tools as tools_mod

        out = str(tools_mod.web_search(action.query) or "")
        return WebSearchObservation.from_text(out, is_error=out.startswith("Error:"))


class WebSearchTool(ToolDefinition[WebSearchAction, WebSearchObservation]):
    name = "web_search"

    @classmethod
    def create(cls, conv_state: ConversationState, **params: Any) -> Sequence["WebSearchTool"]:
        return [
            cls(
                action_type=WebSearchAction,
                observation_type=WebSearchObservation,
                description="Search the web for documentation, API limits, or current information.",
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True),
                executor=_WebSearchExecutor(),
            )
        ]


class ReadWebpageAction(Action):
    url: str = Field(description="HTTP or HTTPS URL to fetch and extract readable Markdown from.")


class ReadWebpageObservation(Observation):
    pass


class _ReadWebpageExecutor(ToolExecutor[ReadWebpageAction, ReadWebpageObservation]):
    def __call__(self, action: ReadWebpageAction, conversation: Any = None) -> ReadWebpageObservation:
        from tools import tools as tools_mod

        out = str(tools_mod.read_webpage(action.url) or "")
        return ReadWebpageObservation.from_text(out, is_error=out.startswith("Error:"))


class ReadWebpageTool(ToolDefinition[ReadWebpageAction, ReadWebpageObservation]):
    name = "read_webpage"

    @classmethod
    def create(cls, conv_state: ConversationState, **params: Any) -> Sequence["ReadWebpageTool"]:
        return [
            cls(
                action_type=ReadWebpageAction,
                observation_type=ReadWebpageObservation,
                description="Fetch and extract readable Markdown from a URL.",
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True),
                executor=_ReadWebpageExecutor(),
            )
        ]


class HttpProbeAction(Action):
    url: str = Field(description="HTTP or HTTPS URL to probe.")
    method: str = Field(default="GET", description="GET (default), HEAD, or OPTIONS.")
    headers: dict[str, str] | None = Field(default=None, description="Optional non-credential headers.")


class HttpProbeObservation(Observation):
    pass


class _HttpProbeExecutor(ToolExecutor[HttpProbeAction, HttpProbeObservation]):
    def __call__(self, action: HttpProbeAction, conversation: Any = None) -> HttpProbeObservation:
        from tools.coding_tools import http_probe

        out = str(http_probe(action.url, method=action.method, headers=action.headers) or "")
        return HttpProbeObservation.from_text(out, is_error=out.startswith("Error:"))


class HttpProbeTool(ToolDefinition[HttpProbeAction, HttpProbeObservation]):
    name = "http_probe"

    @classmethod
    def create(cls, conv_state: ConversationState, **params: Any) -> Sequence["HttpProbeTool"]:
        return [
            cls(
                action_type=HttpProbeAction,
                observation_type=HttpProbeObservation,
                description="Send one unauthenticated GET/HEAD/OPTIONS request and return HTTP status, headers, and body.",
                annotations=ToolAnnotations(readOnlyHint=True, openWorldHint=True),
                executor=_HttpProbeExecutor(),
            )
        ]


class UpdatePlanStepAction(Action):
    step: int = Field(description="1-based step number from # ACTIVE IMPLEMENTATION PLAN (or 0 for all).")
    status: str = Field(description="One of: in_progress, done, skipped, pending, clear.")
    note: str = Field(default="", description="Optional brief summary of what changed or passed.")


class UpdatePlanStepObservation(Observation):
    pass


class _UpdatePlanStepExecutor(ToolExecutor[UpdatePlanStepAction, UpdatePlanStepObservation]):
    def __call__(self, action: UpdatePlanStepAction, conversation: Any = None) -> UpdatePlanStepObservation:
        from tools.coding_tools import update_plan_step

        out = str(update_plan_step(action.step, action.status, action.note) or "")
        return UpdatePlanStepObservation.from_text(out, is_error=out.startswith("Error:"))


class UpdatePlanStepTool(ToolDefinition[UpdatePlanStepAction, UpdatePlanStepObservation]):
    name = "update_plan_step"

    @classmethod
    def create(cls, conv_state: ConversationState, **params: Any) -> Sequence["UpdatePlanStepTool"]:
        return [
            cls(
                action_type=UpdatePlanStepAction,
                observation_type=UpdatePlanStepObservation,
                description="Update the status of a numbered step in the active persisted implementation plan.",
                annotations=ToolAnnotations(readOnlyHint=True),
                executor=_UpdatePlanStepExecutor(),
            )
        ]


_TOOLS_REGISTERED = False
_REG_LOCK = threading.Lock()


def register_sanctuary_openhands_tools() -> None:
    """Register GitBashTerminalTool (`terminal`) and Sanctuary web/plan tools with OpenHands SDK."""
    global _TOOLS_REGISTERED
    with _REG_LOCK:
        if _TOOLS_REGISTERED:
            return
        # Ensure built-in OpenHands tool modules are imported before overriding `terminal`
        _ = (FileEditorTool.name, GrepTool.name, GlobTool.name, AskUserTool.name, TaskToolSet.name)
        register_tool(TerminalTool.name, GitBashTerminalTool)
        register_tool(WebSearchTool.name, WebSearchTool)
        register_tool(ReadWebpageTool.name, ReadWebpageTool)
        register_tool(HttpProbeTool.name, HttpProbeTool)
        register_tool(UpdatePlanStepTool.name, UpdatePlanStepTool)
        _TOOLS_REGISTERED = True


# --- Model & Config Resolution ---


def _read_project_settings(settings_path: str | None = None) -> dict[str, Any]:
    path = settings_path or _PROJECT_SETTINGS_PATH
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def resolve_openhands_model(model: str | None = None, settings_path: str | None = None) -> tuple[str, str]:
    """Resolve model alias/name into `(raw_model_id, litellm_model_id)`."""
    candidate = (model or "").strip()
    if not candidate or candidate.lower() in ("auto", "default"):
        settings = _read_project_settings(settings_path)
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


def _local_openai_base_url() -> str:
    raw = (LOCAL_SERVER_URL or "http://127.0.0.1:8080/v1/chat/completions").strip()
    if raw.endswith("/chat/completions"):
        raw = raw[: -len("/chat/completions")]
    if not raw.rstrip("/").endswith("/v1"):
        raw = raw.rstrip("/") + "/v1"
    return raw.rstrip("/")


def resolve_v1_config(
    model: str | None = None,
    subagent: str = "",
    settings_path: str | None = None,
) -> dict[str, Any]:
    """Resolve OpenHands + `/v1` settings from `v1_client.get_v1_settings()`."""
    path = settings_path or _PROJECT_SETTINGS_PATH
    settings = _read_project_settings(path)
    v1_cfg = v1_client.get_v1_settings(settings_path=path)
    routing_policy = v1_cfg["routing_policy"]
    api_key = v1_cfg["api_key"]
    base_url = v1_cfg["base_url"]

    clean_model = (model or "").strip()
    if routing_policy != "local_only" and clean_model.lower().endswith(".gguf"):
        raise ValueError(f"Refusing to send local GGUF model '{clean_model}' to Cloud /v1 endpoint {base_url}")
    is_auto_model = not clean_model or clean_model.lower() in ("auto", "default")
    clean_sub = (subagent or "").strip().lower()

    if routing_policy == "local_only":
        base_url = _local_openai_base_url()
        local_name = os.getenv("LOCAL_MODEL_NAME", "").strip() or "local-llm"
        raw_model, litellm_model = local_name, f"openai/{local_name}"
        fast_litellm_model = ""
    else:
        provider = v1_cfg["provider"]
        preset = v1_client.PROVIDER_ROLE_DEFAULTS.get(provider, {})
        cfg_fast = v1_cfg["fast_model"]
        cfg_priv = v1_cfg["private_model"]
        cfg_deep = str(settings.get("openhands_model") or "").strip() or os.getenv("OPENHANDS_MODEL", "").strip()
        if provider == "inference_coop" and (not cfg_deep or cfg_deep == DEFAULT_OPENHANDS_MODEL):
            cfg_deep = preset.get("private" if routing_policy == "private_tee" else "deep", DEFAULT_OPENHANDS_MODEL)

        is_known_multi_tier = (
            v1_client.supports_coop_extensions(base_url)
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
            raw_model, litellm_model = resolve_openhands_model(target, settings_path=path)
        else:
            raw_model, litellm_model = resolve_openhands_model(model, settings_path=path)

        if is_known_multi_tier and fast_target and fast_target != raw_model:
            _, fast_litellm_model = resolve_openhands_model(fast_target, settings_path=path)
        else:
            fast_litellm_model = ""

    sec_preset = str(settings.get("security_preset") or "ask_always").strip()
    if sec_preset not in ("ask_always", "auto"):
        sec_preset = "ask_always"

    return {
        "api_key": api_key,
        "key_unavailable_reason": v1_cfg.get("key_unavailable_reason", ""),
        "base_url": base_url,
        "provider": v1_cfg.get("provider", "custom"),
        "raw_model": raw_model,
        "litellm_model": litellm_model,
        "fast_litellm_model": fast_litellm_model,
        "routing_policy": routing_policy,
        "security_preset": sec_preset,
        "folders": settings.get("folders") if isinstance(settings.get("folders"), list) else [],
    }


def _supports_reasoning(model_id: str, model_info: dict[str, Any]) -> bool:
    sr = model_info.get("supports_reasoning_effort")
    if sr is True:
        return True
    if sr is False:
        return False
    low = (model_id or "").lower()
    return any(k in low for k in ("glm", "deepseek", "kimi"))


def build_openhands_llms(
    cfg: dict[str, Any],
    *,
    tier: str = "deep",
    temperature: float | None = None,
) -> tuple[LLM, LLM]:
    """Build `(active_llm, fast_llm)` configured with `/v1` limits and chat_completions mode."""
    is_local = cfg.get("routing_policy") == "local_only"
    api_key = (cfg.get("api_key") or ("local" if is_local else "")) or None
    base_url = cfg.get("base_url") or None

    if is_local:
        ctx_raw = os.getenv("LOCAL_CONTEXT", "8192")
        local_ctx = int(ctx_raw) if (ctx_raw and ctx_raw.isdigit()) else 8192
        llm = LLM(
            model=cfg["litellm_model"],
            api_key=api_key,
            base_url=base_url,
            native_tool_calling=True,
            stream=False,
            max_input_tokens=local_ctx,
            max_output_tokens=min(4096, max(1536, local_ctx // 4)),
            temperature=temperature,
            reasoning_effort=None,
            capability_overrides={"supports_reasoning_effort": False, "supports_responses_api": False},
            log_completions_to_file=False,
        )
        return llm, llm

    raw_deep = cfg["raw_model"]
    deep_info = v1_client.get_v1_model_info(raw_deep)
    deep_re = "medium" if _supports_reasoning(raw_deep, deep_info) else None
    deep_caps: dict[str, Any] = {
        "supports_responses_api": False,
        "supports_reasoning_effort": deep_re is not None,
    }

    deep_llm = LLM(
        model=cfg["litellm_model"],
        api_key=api_key,
        base_url=base_url,
        native_tool_calling=True,
        stream=False,
        max_input_tokens=deep_info["context_tokens"],
        max_output_tokens=None if deep_info.get("output_uncapped") else deep_info["max_output_tokens"],
        temperature=temperature,
        reasoning_effort=deep_re,
        capability_overrides=deep_caps,
        log_completions_to_file=False,
    )

    fast_litellm = (cfg.get("fast_litellm_model") or "").strip()
    if fast_litellm and fast_litellm != cfg["litellm_model"]:
        raw_fast = fast_litellm.split("/", 1)[-1]
        fast_info = v1_client.get_v1_model_info(raw_fast)
        fast_re = "low" if _supports_reasoning(raw_fast, fast_info) else None
        fast_caps: dict[str, Any] = {
            "supports_responses_api": False,
            "supports_reasoning_effort": fast_re is not None,
        }
        fast_llm = LLM(
            model=fast_litellm,
            api_key=api_key,
            base_url=base_url,
            native_tool_calling=True,
            stream=False,
            max_input_tokens=fast_info["context_tokens"],
            max_output_tokens=None if fast_info.get("output_uncapped") else fast_info["max_output_tokens"],
            temperature=temperature,
            reasoning_effort=fast_re,
            capability_overrides=fast_caps,
            log_completions_to_file=False,
        )
    else:
        fast_llm = deep_llm

    active_llm = fast_llm if tier == "fast" else deep_llm
    return active_llm, fast_llm


# --- Subagents, Skills, & Read-Only Action Policy ---


_ACTIVE_FAST_MODEL: str = ""


def register_sanctuary_subagents(cwd: str, fast_model: str = "") -> list[str]:
    """Register project, Sanctuary built-in, user, and SDK default subagents."""
    global _ACTIVE_FAST_MODEL
    register_sanctuary_openhands_tools()
    registered: list[str] = []
    work_dir = cwd if (cwd and os.path.isdir(cwd)) else None

    if work_dir:
        for agent_def in load_project_agents(work_dir):
            if register_agent_if_absent(
                name=agent_def.name,
                factory_func=agent_definition_to_factory(agent_def, work_dir=work_dir),
                description=agent_def,
            ):
                registered.append(agent_def.name)

    _ACTIVE_FAST_MODEL = (fast_model or "").strip()
    for spec in _SANCTUARY_BUILTIN_SUBAGENTS:
        agent_def = AgentDefinition(
            name=spec["name"],
            description=spec["description"],
            tools=list(spec["tools"]),
            system_prompt=spec["system_prompt"],
        )
        base_factory = agent_definition_to_factory(agent_def, work_dir=work_dir)
        is_fast_tier = spec.get("tier") == "fast"

        def _make_tiered_factory(_base=base_factory, _is_fast=is_fast_tier):
            if not _is_fast:
                return _base

            def _factory(parent_llm: Any) -> Any:
                override = _ACTIVE_FAST_MODEL
                tiered_llm = (
                    parent_llm.model_copy(update={"model": override})
                    if override and getattr(parent_llm, "model", "") != override
                    else parent_llm
                )
                return _base(tiered_llm)

            return _factory

        if register_agent_if_absent(
            name=agent_def.name,
            factory_func=_make_tiered_factory(),
            description=agent_def,
        ):
            registered.append(agent_def.name)

    for agent_def in load_user_agents():
        if register_agent_if_absent(
            name=agent_def.name,
            factory_func=agent_definition_to_factory(agent_def, work_dir=work_dir),
            description=agent_def,
        ):
            registered.append(agent_def.name)

    registered.extend(register_builtins_agents(enable_browser=False))
    return registered


def compute_disabled_project_skills(
    cwd: str,
    task_text: str,
    focus_path: str = "",
    subagent_name: str | None = None,
) -> list[str]:
    """Return specialized `.agents/skills` names irrelevant to the current coding task."""
    if not cwd or not os.path.isdir(cwd):
        return []
    skills_dir = os.path.join(cwd, ".agents", "skills")
    if not os.path.isdir(skills_dir):
        return []

    haystack = f"{task_text or ''}\n{focus_path or ''}".lower()
    leaf_subagent = (subagent_name or "").strip().lower() in ("researcher", "implementer", "verifier")
    disabled: list[str] = []

    try:
        entries = sorted(os.listdir(skills_dir))
    except OSError:
        return []

    for entry in entries:
        skill_md = os.path.join(skills_dir, entry, "SKILL.md")
        if not os.path.isfile(skill_md):
            continue
        try:
            with open(skill_md, "r", encoding="utf-8", errors="ignore") as f:
                head = f.read(1600)
        except OSError:
            continue
        if not head.startswith("---"):
            continue
        end_idx = head.find("\n---", 3)
        if end_idx == -1:
            continue
        frontmatter = head[3:end_idx]
        skill_name = entry
        triggers: list[str] = []
        for raw_line in frontmatter.splitlines():
            line = raw_line.strip()
            if line.lower().startswith("name:"):
                skill_name = line.split(":", 1)[1].strip().strip("'\"") or entry
            elif line.lower().startswith("triggers:"):
                raw_trigs = line.split(":", 1)[1].strip().strip("[]")
                triggers = [t.strip().strip("'\"").lower() for t in raw_trigs.split(",") if t.strip().strip("'\"")]

        if skill_name == "sanctuary-architecture" or not triggers:
            continue
        if leaf_subagent and skill_name == "multi-agent-workflow":
            disabled.append(skill_name)
            continue
        if not any(trig in haystack for trig in triggers):
            disabled.append(skill_name)

    return disabled


_READONLY_TOOL_NAMES = frozenset({
    "grep",
    "glob",
    "web_search",
    "read_webpage",
    "http_probe",
    "update_plan_step",
    "ask_user",
    "finish",
})
_READONLY_GIT_SUBCMDS = frozenset({"status", "diff", "log", "show", "branch", "rev-parse", "grep", "ls-files"})
_READONLY_BIN_NAMES = frozenset({
    "cd", "rg", "grep", "dir", "ls", "pwd", "cat", "head", "tail", "wc", "which", "findstr",
})


def _is_readonly_shell_cmd(cmd: str) -> bool:
    clean = (cmd or "").strip()
    if not clean:
        return False
    for bad in (">", "`", "$(", "&&", "||"):
        if bad in clean:
            return False
    segments = [seg.strip() for seg in clean.replace("|", ";").split(";") if seg.strip()]
    if not segments:
        return False
    for seg in segments:
        parts = seg.split()
        head = parts[0].lower()
        if head in _READONLY_BIN_NAMES:
            continue
        if head == "git" and len(parts) >= 2 and parts[1].lower() in _READONLY_GIT_SUBCMDS:
            continue
        if head in ("python", "python3") and len(parts) >= 3 and parts[1] == "-m" and parts[2] == "py_compile":
            continue
        return False
    return True


def is_readonly_action(action_event: Any) -> bool:
    tool_name = getattr(action_event, "tool_name", "") or ""
    action = getattr(action_event, "action", None)
    if tool_name in _READONLY_TOOL_NAMES:
        return True
    if tool_name == "task":
        sub_type = str(getattr(action, "subagent_type", "") or "").strip().lower()
        return sub_type in ("researcher", "code-explorer")
    if tool_name == "file_editor":
        return (getattr(action, "command", None) or "") == "view"
    if tool_name == "terminal":
        return _is_readonly_shell_cmd(str(getattr(action, "command", None) or ""))
    return False


def _summarize_action_args(tool_name: str, action: Any) -> dict[str, Any]:
    if action is None:
        return {}
    if hasattr(action, "model_dump"):
        raw = action.model_dump(exclude_none=True)
    elif isinstance(action, dict):
        raw = dict(action)
    else:
        raw = {"value": str(action)}

    summary: dict[str, Any] = {}
    for key in ("command", "path", "pattern", "query", "url", "subagent_type", "description", "question", "view_range", "insert_line", "step", "status"):
        if key in raw and raw[key] is not None:
            val = raw[key]
            summary[key] = val[:400] if isinstance(val, str) and len(val) > 400 else val
    if tool_name == "file_editor":
        for text_key in ("old_str", "new_str", "file_text"):
            if text_key in raw and isinstance(raw[text_key], str):
                summary[f"{text_key}_len"] = len(raw[text_key])
    elif tool_name == "task" and isinstance(raw.get("prompt"), str):
        summary["prompt"] = raw["prompt"][:300]
    elif not summary:
        for k, v in raw.items():
            summary[k] = v[:300] if isinstance(v, str) and len(v) > 300 else v
    return summary


def _extract_observation_text(event: Any) -> str:
    if hasattr(event, "rejection_reason"):
        return f"Rejected: {event.rejection_reason}"
    obs = getattr(event, "observation", None)
    if obs is not None:
        text = getattr(obs, "text", None)
        if isinstance(text, str) and text.strip():
            return text.strip()[:2000]
        content = getattr(obs, "content", None)
        if content:
            return str(content)[:2000]
    return ""


# --- Session Tracking & Cancellation ---


def _register_run(session_id: str | None, entry: dict[str, Any]) -> None:
    key = session_id or "__default__"
    with _ACTIVE_LOCK:
        _ACTIVE_RUNS.setdefault(key, []).append(entry)


def _unregister_run(session_id: str | None, entry: dict[str, Any]) -> None:
    key = session_id or "__default__"
    with _ACTIVE_LOCK:
        lst = _ACTIVE_RUNS.get(key)
        if not lst:
            return
        if entry in lst:
            lst.remove(entry)
        if not lst:
            _ACTIVE_RUNS.pop(key, None)


def cancel_coding_session(session_id: str | None) -> bool:
    key = session_id or "__default__"
    with _ACTIVE_LOCK:
        entries = list(_ACTIVE_RUNS.get(key) or [])
    if not entries:
        return False
    for entry in entries:
        ev = entry.get("cancel_event")
        if ev is not None:
            ev.set()
        conv = entry.get("conv")
        if conv is not None:
            try:
                conv.pause()
            except Exception:
                pass
    return True


def cancel_all_coding_sessions() -> int:
    with _ACTIVE_LOCK:
        keys = list(_ACTIVE_RUNS.keys())
    return sum(1 for k in keys if cancel_coding_session(k))


# --- In-Process OpenHands Execution ---


def run_coding_turn(
    instruction: str,
    *,
    session_id: str | None = None,
    persona: str = "",
    path: str = "",
    model: str | None = None,
    tier: str = "deep",
    subagent: str = "",
    is_plan_turn: bool = False,
    has_active_plan: bool = False,
    temperature: float | None = None,
    max_iterations: int = 35,
    on_progress: Callable[[list[dict[str, Any]]], None] | None = None,
    settings_path: str | None = None,
    persistence_dir: str | None = None,
) -> tuple[str, list[dict[str, Any]]]:
    """Run an in-process OpenHands Conversation as the active Program and return `(final_text, tool_pairs)`."""
    from tools import tools as tools_mod
    from utils.utils import _build_tool_calls_pair

    clean_task = str(instruction or "").strip()
    if not clean_task:
        return "Error: Empty coding instruction.", []

    cwd, focus_rel, path_warning = tools_mod.resolve_coding_workspace(path)
    if not os.path.isdir(cwd):
        return f"Error: Coding workspace does not exist: {cwd}", []

    cfg = resolve_v1_config(model=model, subagent=subagent, settings_path=settings_path)
    if cfg["routing_policy"] != "local_only" and not cfg.get("api_key"):
        host = cfg.get("base_url") or "configured /v1 endpoint"
        reason = cfg.get("key_unavailable_reason") or "no Cloud API key configured"
        return f"Error: [OpenHands · {host}] {reason}", []

    register_sanctuary_openhands_tools()
    register_sanctuary_subagents(cwd, fast_model=cfg.get("fast_litellm_model") or "")

    active_llm, fast_llm = build_openhands_llms(cfg, tier=tier, temperature=temperature)

    agent_tools: list[Tool] = [
        Tool(name=FileEditorTool.name),
        Tool(name=GrepTool.name),
        Tool(name=GlobTool.name),
        Tool(name=TerminalTool.name),
        Tool(name=WebSearchTool.name),
        Tool(name=ReadWebpageTool.name),
        Tool(name=HttpProbeTool.name),
        Tool(name=AskUserTool.name),
        Tool(name=TaskToolSet.name),
    ]
    if has_active_plan:
        agent_tools.append(Tool(name=UpdatePlanStepTool.name))

    if subagent:
        matched_def = next(
            (d for d in get_registered_agent_definitions() if d.name == subagent),
            None,
        )
        if matched_def is not None and matched_def.tools:
            agent_tools = [Tool(name=t) for t in matched_def.tools]
            if all(t.name != AskUserTool.name for t in agent_tools):
                agent_tools.append(Tool(name=AskUserTool.name))

    suffix_parts: list[str] = [f"Repository root: `{cwd}`."]
    if focus_rel:
        suffix_parts.append(f"Primary focus path: `{focus_rel}`.")
    if path_warning:
        suffix_parts.append(f"Note: {path_warning}")
    if is_plan_turn:
        suffix_parts.append(
            "PLAN MODE IS ACTIVE: Inspect the codebase read-only using `file_editor` (`view`), `grep`, `glob`, "
            "`web_search`, and `read_webpage`. Do NOT modify files or run mutating commands. "
            "Present your final plan wrapped inside a fenced ```sanctuary-plan block so the user can review and click Proceed."
        )
    else:
        suffix_parts.append(
            "Follow workspace AGENTS.md rules: trace call sites before editing, keep edits consolidated, "
            "verify touched code via `terminal` (`" + workspace_python(cwd) + "` / `node --test`), "
            "and call `finish` with your concise user-facing response in character."
        )

    disabled_skills = compute_disabled_project_skills(
        cwd, clean_task, focus_path=focus_rel, subagent_name=subagent or None
    )
    agent_context = AgentContext(
        system_message_suffix="\n".join(suffix_parts),
        load_project_skills=True,
        load_user_skills=False,
        disabled_skills=disabled_skills,
    )

    agent = Agent(
        llm=active_llm,
        persona=persona.strip() or None,
        tools=agent_tools,
        agent_context=agent_context,
        condenser=LLMSummarizingCondenser(llm=fast_llm, max_size=60, keep_first=4),
    )

    cancel_event = threading.Event()
    seen_calls: set[str] = set()
    seen_results: set[str] = set()
    pending_args: dict[str, dict[str, Any]] = {}
    recorded_pairs: list[dict[str, Any]] = []
    last_error = ""

    def on_event(event: Any) -> None:
        nonlocal last_error
        if isinstance(event, ActionEvent) and event.action is not None:
            call_id = str(event.tool_call_id or event.id)
            if call_id in seen_calls:
                return
            seen_calls.add(call_id)
            t_name = f"openhands:{event.tool_name}"
            args = _summarize_action_args(event.tool_name, event.action)
            pending_args[call_id] = args
            if session_id:
                with tools_mod.session_tool_calls_lock:
                    lst = tools_mod.session_tool_calls.setdefault(session_id, [])
                    if not any(item.get("id") == call_id for item in lst):
                        lst.append(
                            {
                                "id": call_id,
                                "name": t_name,
                                "args": args,
                                "status": "running",
                                "response": "",
                                "start_time": time.time(),
                            }
                        )
        elif isinstance(event, _RESULT_EVENT_TYPES):
            call_id = str(getattr(event, "tool_call_id", "") or getattr(event, "action_id", "") or event.id)
            if call_id in seen_results:
                return
            seen_results.add(call_id)
            obs = getattr(event, "observation", None)
            is_agent_err = bool(AgentErrorEvent is not None and isinstance(event, AgentErrorEvent))
            out_text = _extract_observation_text(event)
            if is_agent_err and not out_text:
                out_text = str(getattr(event, "error", "") or "Agent error")[:2000]
            is_err = bool(isinstance(event, UserRejectObservation) or is_agent_err or getattr(obs, "is_error", False))
            if is_err and out_text:
                last_error = out_text
            t_name = f"openhands:{getattr(event, 'tool_name', 'error')}"
            args = pending_args.pop(call_id, {})

            if session_id:
                with tools_mod.session_tool_calls_lock:
                    lst = tools_mod.session_tool_calls.setdefault(session_id, [])
                    matched = next((item for item in reversed(lst) if item.get("id") == call_id), None)
                    status_label = "error" if is_err else "done"
                    if matched is not None:
                        matched["status"] = status_label
                        matched["response"] = out_text[:1500]
                        matched["duration"] = round(
                            time.time() - float(matched.get("start_time") or time.time()), 2
                        )
                    else:
                        lst.append(
                            {
                                "id": call_id,
                                "name": t_name,
                                "args": args,
                                "status": status_label,
                                "response": out_text[:1500],
                                "duration": 0.0,
                            }
                        )

            recorded_pairs.extend(_build_tool_calls_pair(t_name, args, out_text[:1500], idx=len(recorded_pairs)))
            if on_progress is not None:
                try:
                    on_progress(list(recorded_pairs))
                except Exception:
                    pass

    conv_kwargs: dict[str, Any] = {
        "agent": agent,
        "workspace": cwd,
        "callbacks": [on_event],
        "visualizer": None,
        "stuck_detection": True,
        "max_iteration_per_run": max(5, int(max_iterations)),
        "delete_on_close": not bool(persistence_dir),
    }
    if persistence_dir:
        os.makedirs(persistence_dir, exist_ok=True)
        conv_kwargs["persistence_dir"] = persistence_dir

    conversation = Conversation(**conv_kwargs)
    use_always_confirm = is_plan_turn or cfg["security_preset"] == "ask_always"
    conversation.set_confirmation_policy(AlwaysConfirm() if use_always_confirm else NeverConfirm())

    run_entry = {"conv": conversation, "cancel_event": cancel_event}
    _register_run(session_id, run_entry)
    try:
        from runners.runner import cancelled_sessions
    except Exception:
        cancelled_sessions = set()

    final_text = ""
    exec_status = ConversationExecutionStatus.FINISHED
    try:
        conversation.send_message(clean_task)
        while not cancel_event.is_set() and not (session_id and session_id in cancelled_sessions):
            conversation.run()
            if cancel_event.is_set() or (session_id and session_id in cancelled_sessions):
                raise InterruptedError("Coding session cancelled by user request.")

            exec_status = conversation.state.execution_status
            if exec_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
                pending = ConversationState.get_unmatched_actions(conversation.state.events)
                mutating = [act for act in pending if not is_readonly_action(act)]
                if not mutating:
                    continue
                if is_plan_turn:
                    bad = "; ".join(
                        f"{act.tool_name}({str(getattr(act.action, 'command', '') or getattr(act.action, 'path', '') or '')[:80]})"
                        for act in mutating[:3]
                    )
                    conversation.reject_pending_actions(
                        f"Plan mode is strictly read-only (blocked: {bad}). "
                        "Use `file_editor` (`view`), `grep`, `glob`, or `web_search` only."
                    )
                    continue

                approved_all = True
                for act in mutating:
                    details = json.dumps(_summarize_action_args(act.tool_name, act.action), ensure_ascii=False)
                    if not tools_mod.confirm_tool_execution(f"openhands:{act.tool_name}", details):
                        approved_all = False
                        break
                if cancel_event.is_set() or (session_id and session_id in cancelled_sessions):
                    raise InterruptedError("Coding session cancelled by user request.")
                if not approved_all:
                    conversation.reject_pending_actions("User denied execution in LM-Sanctuary")
                continue

            pending_ask = find_pending_ask_back(conversation.state.walk_back())
            if pending_ask is not None:
                choice = tools_mod.request_user_choice(
                    question=pending_ask.question,
                    options=list(pending_ask.option_labels),
                    tool_name="openhands:ask_user",
                )
                u_idx = choice.get("option_index")
                u_txt = str(choice.get("answer_text") or "").strip() or None
                conversation.send_message(
                    answer_message_text(
                        pending_ask,
                        u_idx if isinstance(u_idx, int) else None,
                        u_txt,
                    )
                )
                continue

            final_text = get_agent_final_response(conversation.state.events).strip()
            break
    except InterruptedError:
        raise
    except Exception as exc:
        if cancel_event.is_set() or (session_id and session_id in cancelled_sessions):
            raise InterruptedError("Coding session cancelled by user request.") from exc
        return f"Error: [OpenHands] {type(exc).__name__}: {exc}", recorded_pairs
    finally:
        _unregister_run(session_id, run_entry)
        try:
            conversation.close()
        except Exception:
            pass

    if cancel_event.is_set() or (session_id and session_id in cancelled_sessions):
        raise InterruptedError("Coding session cancelled by user request.")

    if exec_status in (ConversationExecutionStatus.ERROR, ConversationExecutionStatus.STUCK):
        return (
            f"Error: [OpenHands {exec_status.value}] {final_text or last_error or 'Agent stopped before finishing.'}",
            recorded_pairs,
        )
    if not final_text:
        return (
            f"Error: [OpenHands {exec_status.value}] {last_error or 'No final response produced before iteration limit.'}",
            recorded_pairs,
        )
    return final_text, recorded_pairs


def _create_isolated_worktree(repo_root: str) -> tuple[str, str]:
    """Create a temporary detached git worktree for `isolate=True`."""
    wt_root = tempfile.mkdtemp(prefix="sanctuary_oh_wt_")
    os.rmdir(wt_root)
    proc = subprocess.run(
        ["git", "-C", repo_root, "worktree", "add", "--detach", wt_root, "HEAD"],
        capture_output=True,
        text=True,
        timeout=20,
    )
    if proc.returncode != 0:
        return "", f"git worktree add failed: {(proc.stderr or proc.stdout).strip()}"
    return wt_root, ""


def _cleanup_isolated_worktree(repo_root: str, wt_root: str) -> str:
    if not wt_root or not os.path.isdir(wt_root):
        return ""
    status = subprocess.run(
        ["git", "-C", wt_root, "status", "--porcelain"],
        capture_output=True,
        text=True,
        timeout=10,
    )
    if status.returncode == 0 and (status.stdout or "").strip():
        return wt_root
    subprocess.run(
        ["git", "-C", repo_root, "worktree", "remove", "--force", wt_root],
        capture_output=True,
        text=True,
        timeout=15,
    )
    return ""


def delegate_coding(
    task: str = "",
    instruction: str = "",
    path: str = "",
    model: str = "auto",
    subagent: str = "",
    resume: bool = True,
    isolate: bool = False,
    **kwargs: Any,
) -> str:
    """Delegate a coding task to the in-process OpenHands harness (with optional isolated git worktree)."""
    from tools import tools as tools_mod

    clean_task = str(task or instruction or kwargs.get("prompt") or "").strip()
    if not clean_task:
        return "Error: `task` / `instruction` must not be empty when calling delegate_coding."

    session_id = tools_mod.current_session_id.get()
    repo_root, _, _ = tools_mod.resolve_coding_workspace(path)
    target_path = path
    wt_root = ""
    if isolate:
        wt_root, wt_err = _create_isolated_worktree(repo_root)
        if wt_err:
            return f"Error: {wt_err}"
        target_path = wt_root

    try:
        final_text, _ = run_coding_turn(
            clean_task,
            session_id=session_id,
            path=target_path,
            model=model,
            subagent=subagent,
        )
        return final_text
    except InterruptedError:
        return "Coding job cancelled by user request."
    finally:
        if wt_root:
            kept = _cleanup_isolated_worktree(repo_root, wt_root)
            if kept:
                print(f"[OpenHands] Preserved dirty isolated worktree: {kept}", flush=True)
