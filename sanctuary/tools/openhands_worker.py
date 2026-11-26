"""Headless OpenHands CLI subprocess worker for LM-Sanctuary.

Runs an OpenHands SDK `Conversation` against GreenPT or any OpenAI-compatible
`/v1` endpoint, registers coding subagents (`researcher`, `implementer`,
`verifier`, built-ins, and `.agents/agents/*.md` / `.openhands/agents/*.md`),
and speaks structured JSONL on stdout for HITL confirmation, `ask_user` /
Program decision brokering, tool event telemetry, and cooperative cancellation.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import re
import sys
import threading
import uuid
from typing import Any

os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", "1")
os.environ.setdefault("OH_TELEMETRY_CONSENT", "false")

_STDOUT_LOCK = threading.Lock()
_REAL_STDOUT = sys.stdout

_SANCTUARY_BUILTIN_SUBAGENTS: tuple[dict[str, Any], ...] = (
    {
        "name": "researcher",
        "tier": "fast",
        "description": (
            "Read-only codebase investigator. Searches symbols, inspects files, and gathers "
            "concrete evidence without modifying files."
        ),
        "tools": ["file_editor", "terminal"],
        "system_prompt": (
            "You are the `researcher` subagent. Inspect files via `file_editor` (`view`) and "
            "run strictly read-only search/status commands via `terminal` (e.g., `rg`, `git grep -n`, "
            "`git status`, `git diff`, `git log`). Never modify files."
        ),
    },
    {
        "name": "implementer",
        "tier": "deep",
        "description": (
            "Focused software implementer. Applies minimal, verified edits using root-code "
            "design and consolidates shared helpers rather than duplicating logic."
        ),
        "tools": ["file_editor", "terminal"],
        "system_prompt": (
            "You are the `implementer` subagent. Read exact target definitions first, output a "
            "structured pre-edit block (`intent`, `files_to_touch`, `exact_diff`, `how_I_will_verify`) "
            "before mutating any file, make minimal consolidated edits with `file_editor`, and verify "
            "syntax/tests on the touched paths via `terminal`. "
            "NO ERROR BUDGET: after 2 failed fixes or 2 failed tool calls on the same error, stop immediately, "
            "write a 2-sentence hypothesis of why it failed, and call `ask_user` or return `HAND_BACK_NEEDED:`."
        ),
    },
    {
        "name": "verifier",
        "tier": "fast",
        "description": (
            "Independent verification subagent. Runs targeted tests, builds, linters, and git "
            "diff checks after edits and reports exact observed outputs without editing product code."
        ),
        "tools": ["file_editor", "terminal"],
        "system_prompt": (
            "You are the `verifier` subagent. Independently inspect the modified diff (`file_editor` "
            "`view`, `git diff`) and execute exact tests/linters/builds via `terminal`. "
            "Never edit source files unless explicitly asked to fix a test; report only observed outputs."
        ),
    },
)

_READONLY_GIT_RE = re.compile(
    r"^\s*git\s+(status|diff|log|show|branch|rev-parse|grep|ls-files)\b", re.IGNORECASE
)
_READONLY_CMD_RE = re.compile(
    r"^\s*(cd|Set-Location|Push-Location|Pop-Location|rg|grep|findstr|dir|ls|pwd|Get-ChildItem|Get-Content|Select-String|type|cat|head|tail|wc|which|where\.exe|python\s+-m\s+py_compile|pytest\s+--collect-only|node\s+--version|python\s+--version)\b",
    re.IGNORECASE,
)
_READONLY_PIPE_STAGE_RE = re.compile(
    r"^\s*(Select-Object|Where-Object|ForEach-Object|Sort-Object|Measure-Object|Test-Path|Out-String|Write-Output|echo)\b",
    re.IGNORECASE,
)


def _compute_disabled_project_skills(
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
                raw_trigs = line.split(":", 1)[1].strip()
                triggers = [t.strip().lower() for t in raw_trigs.split(",") if t.strip()]

        if skill_name in ("sanctuary-architecture", "sanctuary_architecture") or not triggers:
            continue
        if leaf_subagent and skill_name in ("multi-agent-workflow", "multi_agent_workflow"):
            disabled.append(skill_name)
            continue
        if not any(trig in haystack for trig in triggers):
            disabled.append(skill_name)

    return disabled


def emit_json(payload: dict[str, Any], out: Any = None) -> None:
    """Write a single JSONL record to the preserved protocol stdout stream."""
    stream = out or _REAL_STDOUT
    line = json.dumps(payload, ensure_ascii=False)
    with _STDOUT_LOCK:
        stream.write(line + "\n")
        stream.flush()


def register_sanctuary_subagents(cwd: str, fast_model: str = "") -> list[str]:
    """Register project, Sanctuary built-in, user, and SDK default subagents.

    Precedence: project `.agents/agents` & `.openhands/agents` > Sanctuary
    `researcher`/`implementer`/`verifier` > user `~/.agents/agents` &
    `~/.openhands/agents` > OpenHands SDK built-in subagents.
    """
    from openhands.sdk import (
        agent_definition_to_factory,
        load_project_agents,
        load_user_agents,
    )
    from openhands.sdk.subagent import register_agent_if_absent
    from openhands.sdk.subagent.schema import AgentDefinition
    from openhands.tools.preset.default import register_builtins_agents

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

    clean_fast = (fast_model or "").strip()
    for spec in _SANCTUARY_BUILTIN_SUBAGENTS:
        agent_def = AgentDefinition(
            name=spec["name"],
            description=spec["description"],
            tools=list(spec["tools"]),
            system_prompt=spec["system_prompt"],
        )
        base_factory = agent_definition_to_factory(agent_def, work_dir=work_dir)
        model_override = clean_fast if (spec.get("tier") == "fast" and clean_fast) else ""

        def _make_tiered_factory(_base=base_factory, _override=model_override):
            if not _override:
                return _base

            def _factory(parent_llm: Any) -> Any:
                tiered_llm = (
                    parent_llm.model_copy(update={"model": _override})
                    if getattr(parent_llm, "model", "") != _override
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


def looks_like_blocking_question(text: str) -> bool:
    """Return True if an assistant final turn appears to stop just to ask a clarification."""
    clean = (text or "").strip()
    if not clean or len(clean) > 1200:
        return False
    tail = clean.splitlines()[-1].strip()
    if not tail.endswith("?"):
        return False
    cues = (
        "would you like",
        "do you want",
        "should i",
        "which ",
        "please confirm",
        "let me know",
        "before i proceed",
        "could you clarify",
    )
    lower = clean.lower()
    return any(cue in lower for cue in cues)


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
    for key in (
        "command",
        "path",
        "subagent_type",
        "description",
        "question",
        "view_range",
        "insert_line",
    ):
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


def _is_readonly_action(action_event: Any) -> bool:
    tool_name = getattr(action_event, "tool_name", "") or ""
    action = getattr(action_event, "action", None)
    if tool_name in ("ask_user", "finish"):
        return True
    if tool_name == "task":
        sub_type = str(getattr(action, "subagent_type", "") or "").strip().lower()
        return sub_type in ("researcher", "code-explorer")
    if tool_name == "file_editor":
        return (getattr(action, "command", None) or "") == "view"
    if tool_name == "terminal":
        cmd = (getattr(action, "command", None) or "").strip()
        if not cmd or any(tok in cmd for tok in (">", "`", "$(", "&&", "||")):
            return False
        segments = [seg.strip() for seg in re.split(r"[;|]+", cmd) if seg.strip()]
        if not segments:
            return False
        return all(
            bool(_READONLY_GIT_RE.match(seg) or _READONLY_CMD_RE.match(seg) or _READONLY_PIPE_STAGE_RE.match(seg))
            for seg in segments
        )
    return False


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


def discover_workspace_skills_index(cwd: str) -> str:
    """Return a compact index of `.agents/skills/*/SKILL.md` and `.openhands/skills/*/SKILL.md`."""
    if not cwd or not os.path.isdir(cwd):
        return ""
    entries: list[str] = []
    seen: set[str] = set()
    for rel_root in (os.path.join(".agents", "skills"), os.path.join(".openhands", "skills")):
        skills_dir = os.path.join(cwd, rel_root)
        if not os.path.isdir(skills_dir):
            continue
        try:
            subdirs = sorted(os.listdir(skills_dir))
        except OSError:
            continue
        for sub in subdirs:
            sp = os.path.join(skills_dir, sub, "SKILL.md")
            if not os.path.isfile(sp):
                continue
            name = sub
            desc = ""
            try:
                with open(sp, "r", encoding="utf-8", errors="replace") as f:
                    head = f.read(1600)
                if head.startswith("---"):
                    fm = head.split("---", 2)[1] if len(head.split("---", 2)) >= 3 else ""
                    for line in fm.splitlines():
                        if line.startswith("name:"):
                            name = line.partition(":")[2].strip().strip("\"'") or name
                        elif line.startswith("description:"):
                            desc = line.partition(":")[2].strip().strip("\"'")[:160]
            except OSError:
                pass
            if name in seen:
                continue
            seen.add(name)
            rel_sp = os.path.relpath(sp, cwd).replace("\\", "/")
            entries.append(f"- `{name}` (`{rel_sp}`): {desc}" if desc else f"- `{name}` (`{rel_sp}`)")
    return "\n".join(entries)


def build_workspace_grounding_block(
    cwd: str, focus_path: str = "", path_warning: str = ""
) -> str:
    """Build deterministic OS, shell, search, top-level tree, test, and skill grounding."""
    if not cwd or not os.path.isdir(cwd):
        return ""
    from tools.coding_tools import workspace_python

    is_win = os.name == "nt"
    shell_name = "Windows PowerShell (OpenHands terminal backend on Windows)" if is_win else "POSIX shell"
    sep_rule = (
        "Separate commands with `;` (never `&&`). Forward-slash paths work (e.g. `.venv/Scripts/python.exe`)."
        if is_win
        else "Standard `&&` / `;` supported."
    )
    py_cmd = workspace_python(cwd)

    skip = {"__pycache__", "node_modules", ".git", ".venv", ".ruff_cache", ".pytest_cache"}
    try:
        top_entries = sorted(
            f"{d}/" if os.path.isdir(os.path.join(cwd, d)) else d
            for d in os.listdir(cwd)
            if not d.startswith(".") and not d.startswith("_tmp_") and d not in skip
        )[:30]
    except OSError:
        top_entries = []

    test_hints: list[str] = []
    if os.path.isfile(os.path.join(cwd, "package.json")) and os.path.isdir(os.path.join(cwd, "__tests__")):
        test_hints.append("JS tests: `node --test __tests__/<file>.test.js`")
    if os.path.isdir(os.path.join(cwd, "__tests__", "backend")):
        test_hints.append(f"Backend tests: `{py_cmd} __tests__/backend/<file>.py`")
    if os.path.isdir(os.path.join(cwd, "sanctuary", "tests")):
        test_hints.append(f"Sanctuary tests: `{py_cmd} -m unittest discover -s sanctuary/tests`")

    lines = [
        "## Workspace & Environment Grounding",
        f"- **Workspace Root**: `{cwd}` (your terminal working directory is ALREADY `{cwd}` — do NOT prefix terminal commands with `cd`).",
        f"- **OS / Shell**: `{sys.platform}` ({shell_name}). {sep_rule}",
        f"- **Fast Search**: Use `git grep -n \"<pattern>\"` (instant in git repos; do not assume `rg` is installed).",
        "- **Bounded Reads**: When calling `file_editor` (`command=\"view\"`), pass `view_range` (<= 150 lines) around the located target rather than dumping whole large files.",
    ]
    if top_entries:
        lines.append(f"- **Top-Level Layout**: {', '.join(top_entries)}")
    if focus_path:
        lines.append(f"- **Focus Target**: `{focus_path}`")
    if path_warning:
        lines.append(f"- **Path Notice**: {path_warning}")
    if test_hints:
        lines.append("- **Targeted Verification**: " + " | ".join(test_hints))

    skills_idx = discover_workspace_skills_index(cwd)
    if skills_idx:
        lines.append("- **Workspace Skills (read relevant `SKILL.md` if applicable)**:\n" + skills_idx)
    return "\n".join(lines)


def _build_system_suffix(
    cwd: str,
    agents_md_path: str | None,
    subagent_name: str | None,
    focus_path: str = "",
    path_warning: str = "",
) -> str | None:
    sections: list[str] = []
    grounding = build_workspace_grounding_block(cwd, focus_path=focus_path, path_warning=path_warning)
    if grounding:
        sections.append(grounding)
    if agents_md_path and os.path.isfile(agents_md_path):
        try:
            with open(agents_md_path, "r", encoding="utf-8") as f:
                content = f.read().strip()
            if content:
                sections.append(content)
        except OSError:
            pass
    else:
        workspace_agents = os.path.join(cwd, "AGENTS.md")
        if os.path.isfile(workspace_agents):
            try:
                with open(workspace_agents, "r", encoding="utf-8") as f:
                    content = f.read().strip()
                if content:
                    sections.append(content)
            except OSError:
                pass

    if subagent_name:
        from openhands.sdk.subagent import get_registered_agent_definitions

        matched = next(
            (d for d in get_registered_agent_definitions() if d.name == subagent_name),
            None,
        )
        if matched is not None and matched.system_prompt:
            sections.append(
                f"## Active Subagent Role: {matched.name}\n{matched.system_prompt}"
            )
    else:
        sections.append(
            "## Subagent Delegation (`task` tool)\n"
            "Specialized subagents registered in this workspace include `researcher`, "
            "`implementer`, `verifier`, `code-explorer`, `bash-runner`, `general-purpose`, "
            "plus any project `.agents/agents/*.md` or `.openhands/agents/*.md` agents. "
            "Delegate independent codebase exploration, multi-module edits, or post-edit verification "
            "via the `task` tool when helpful."
        )
    return "\n\n".join(sections) if sections else None


def _read_instruction(args: argparse.Namespace) -> str:
    if args.instruction_file and os.path.isfile(args.instruction_file):
        with open(args.instruction_file, "r", encoding="utf-8") as f:
            return f.read().strip()
    if args.instruction:
        return args.instruction.strip()
    return ""


def _parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Headless OpenHands CLI worker for LM-Sanctuary")
    parser.add_argument("--headless", action="store_true", help="Run without interactive terminal UI")
    parser.add_argument("--json", action="store_true", help="Emit JSONL events on stdout")
    parser.add_argument("--cwd", required=True, help="Workspace directory path")
    parser.add_argument("--instruction", default="", help="Coding task instruction")
    parser.add_argument("--instruction-file", default="", help="File containing coding instruction")
    parser.add_argument("--model", default="openai/glm-5.3", help="LiteLLM model string")
    parser.add_argument("--fast-model", default="", help="Optional fast LiteLLM model for researcher/verifier subagents")
    parser.add_argument("--base-url", default="https://api.greenpt.ai/v1", help="OpenAI-compatible /v1 base URL")
    parser.add_argument("--api-key-env", default="GREENPT_API_KEY", help="Env var holding the API key")
    parser.add_argument("--subagent", default="", help="Optional subagent profile name")
    parser.add_argument("--security-preset", default="ask_always", choices=["ask_always", "auto"])
    parser.add_argument("--persistence-dir", default="", help="Optional Conversation persistence directory")
    parser.add_argument("--conversation-id", default="", help="Optional conversation UUID")
    parser.add_argument("--agents-md", default="", help="Optional compiled Program AGENTS.md path")
    parser.add_argument("--workflow", default="single", choices=["auto", "staged", "plan", "execute", "single"])
    parser.add_argument("--focus-path", default="", help="Optional validated relative focus path")
    parser.add_argument("--path-warning", default="", help="Optional warning for non-existent path hints")
    parser.add_argument("--approved-plan-file", default="", help="Optional file containing approved plan markdown")
    parser.add_argument("--max-iterations", type=int, default=80)
    parser.add_argument("--max-decision-rounds", type=int, default=4)
    return parser.parse_args(argv)


def validate_structured_mutation_plan(plan_text: str) -> tuple[bool, list[str]]:
    """Verify a plan specifies all 4 pre-mutation fields before allowing edits."""
    text = (plan_text or "").strip()
    if not text:
        return False, ["intent", "files_to_touch", "exact_diff", "how_I_will_verify"]

    checks = (
        ("intent", r"(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?intent(?:\*\*)?\s*:|^##+\s*(?:Steps|Intent)\b"),
        ("files_to_touch", r"(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?files_to_touch(?:\*\*)?\s*:|^##+\s*(?:Code Map|Files to Touch)\b"),
        ("exact_diff", r"(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?exact_diff(?:\*\*)?\s*:|^##+\s*(?:Exact Changes|Exact Diff)\b"),
        ("how_I_will_verify", r"(?:^|\n)\s*(?:[-*]\s*)?(?:\*\*)?how_I_will_verify(?:\*\*)?\s*:|^##+\s*(?:Verification Command|How I Will Verify)\b"),
    )
    missing = [
        field for field, pat in checks
        if not re.search(pat, text, re.MULTILINE | re.IGNORECASE)
    ]
    return (len(missing) == 0), missing


def _normalize_error_signature(tool_name: str, output_text: str) -> str:
    clean_tool = (tool_name or "tool").removeprefix("openhands:")
    snippet = re.sub(r"\s+", " ", (output_text or "").strip())[:140].lower()
    return f"{clean_tool}:{snippet}"


def _sweep_untracked_tmp_files(cwd: str, pre_existing: set[str]) -> list[str]:
    """Remove any top-level `_tmp_*` scratch files created during a worker run."""
    removed: list[str] = []
    if not cwd or not os.path.isdir(cwd):
        return removed
    try:
        for name in os.listdir(cwd):
            if name.startswith("_tmp_") and name not in pre_existing:
                target = os.path.join(cwd, name)
                if os.path.isfile(target):
                    os.remove(target)
                    removed.append(name)
    except OSError:
        pass
    return removed


def _create_conversation_with_fallback(conv_cls: Any, **kwargs: Any) -> Any:
    """Create an OpenHands `Conversation`, falling back to a fresh session on resume mismatch."""
    try:
        return conv_cls(**kwargs)
    except ValueError as exc:
        if kwargs.get("persistence_dir") or kwargs.get("conversation_id"):
            print(f"[openhands_worker] Resume mismatch ({exc}); starting fresh conversation.", file=sys.stderr)
            fresh_kwargs = dict(kwargs)
            fresh_kwargs["persistence_dir"] = None
            fresh_kwargs["conversation_id"] = None
            fresh_kwargs["delete_on_close"] = True
            return conv_cls(**fresh_kwargs)
        raise


def _isolate_worker_stdio() -> Any:
    """Detach protocol stdin/stdout onto private non-inheritable fds.

    Replaces fd 0 / STD_INPUT_HANDLE with os.devnull so child processes
    (e.g. git.exe in OpenHands skill discovery) never inherit a synchronous
    Windows pipe with an active ReadFile call, and redirects fd 1 /
    STD_OUTPUT_HANDLE to stderr so stray C/child output never corrupts JSONL.
    """
    global _REAL_STDOUT
    ctrl_in: Any = sys.stdin
    try:
        in_fd = sys.stdin.fileno()
        ctrl_fd = os.dup(in_fd)
        os.set_inheritable(ctrl_fd, False)
        nul_fd = os.open(os.devnull, os.O_RDONLY)
        try:
            os.dup2(nul_fd, in_fd)
        finally:
            os.close(nul_fd)
        if os.name == "nt":
            import ctypes
            import msvcrt

            ctypes.windll.kernel32.SetStdHandle(-10, msvcrt.get_osfhandle(in_fd))
        sys.stdin = open(os.devnull, "r", encoding="utf-8")
        ctrl_in = os.fdopen(ctrl_fd, "r", encoding="utf-8", errors="replace")
    except Exception:
        ctrl_in = sys.stdin

    try:
        out_fd = sys.stdout.fileno()
        err_fd = sys.stderr.fileno()
        proto_fd = os.dup(out_fd)
        os.set_inheritable(proto_fd, False)
        os.dup2(err_fd, out_fd)
        if os.name == "nt":
            import ctypes
            import msvcrt

            ctypes.windll.kernel32.SetStdHandle(-11, msvcrt.get_osfhandle(err_fd))
        _REAL_STDOUT = os.fdopen(proto_fd, "w", encoding="utf-8", buffering=1)
    except Exception:
        _REAL_STDOUT = sys.stdout
    sys.stdout = sys.stderr
    return ctrl_in


def main(argv: list[str] | None = None) -> int:
    sanctuary_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if sanctuary_root not in sys.path:
        sys.path.insert(0, sanctuary_root)
    try:
        from utils import lifecycle
        lifecycle._suppress_headless_windows_consoles(force=True)
    except Exception:
        pass
    ctrl_stdin = _isolate_worker_stdio()

    args = _parse_args(argv)
    instruction = _read_instruction(args)
    if not instruction:
        emit_json({"type": "result", "status": "error", "error": "Empty coding instruction."})
        return 1

    cwd = os.path.abspath(args.cwd)
    if not os.path.isdir(cwd):
        emit_json({"type": "result", "status": "error", "error": f"Workspace not found: {cwd}"})
        return 1

    from openhands.sdk import LLM, Agent, AgentContext, Conversation, Tool
    from openhands.sdk.conversation.response_utils import get_agent_final_response
    from openhands.sdk.conversation.state import ConversationExecutionStatus, ConversationState
    from openhands.sdk.event import ActionEvent, ObservationEvent, UserRejectObservation
    try:
        from openhands.sdk.event import AgentErrorEvent
        _RESULT_EVENT_TYPES = (ObservationEvent, UserRejectObservation, AgentErrorEvent)
    except ImportError:
        AgentErrorEvent = None  # type: ignore[assignment]
        _RESULT_EVENT_TYPES = (ObservationEvent, UserRejectObservation)
    from openhands.sdk.event.ask_user import answer_message_text, find_pending_ask_back
    from openhands.sdk.security.confirmation_policy import AlwaysConfirm, NeverConfirm
    from openhands.sdk.subagent import get_registered_agent_definitions
    from openhands.tools.ask_user import AskUserTool
    from openhands.tools.preset.default import get_default_condenser, get_default_tools

    register_sanctuary_subagents(cwd, fast_model=args.fast_model)

    api_key = os.environ.get(args.api_key_env, "").strip() or None
    deep_llm = LLM(
        model=args.model,
        api_key=api_key,
        base_url=args.base_url or None,
        native_tool_calling=True,
        stream=False,
        reasoning_effort=None,
        log_completions=False,
    )
    fast_model = (args.fast_model or "").strip()
    fast_reasoning = "low" if any(k in fast_model.lower() for k in ("glm", "deepseek")) else None
    fast_llm = (
        LLM(
            model=fast_model,
            api_key=api_key,
            base_url=args.base_url or None,
            native_tool_calling=True,
            stream=False,
            reasoning_effort=fast_reasoning,
            log_completions=False,
        )
        if fast_model and fast_model != args.model
        else deep_llm
    )

    subagent_name = args.subagent.strip() or None
    tools = [
        t for t in get_default_tools(enable_browser=False, enable_sub_agents=True)
        if t.name != "task_tracker"
    ]
    if subagent_name:
        matched_def = next(
            (d for d in get_registered_agent_definitions() if d.name == subagent_name),
            None,
        )
        if matched_def is not None and matched_def.tools:
            tools = [Tool(name=t) for t in matched_def.tools]
    if all(t.name != AskUserTool.name for t in tools):
        tools.append(Tool(name=AskUserTool.name))

    system_suffix = _build_system_suffix(
        cwd,
        args.agents_md or None,
        subagent_name,
        focus_path=args.focus_path,
        path_warning=args.path_warning,
    )
    disabled_project_skills = _compute_disabled_project_skills(
        cwd,
        instruction,
        focus_path=args.focus_path,
        subagent_name=subagent_name,
    )
    agent_context = AgentContext(
        system_message_suffix=system_suffix,
        load_project_skills=True,
        load_user_skills=False,
        disabled_skills=disabled_project_skills,
    )

    seen_calls: set[str] = set()
    seen_results: set[str] = set()
    active_error_tracker: dict[str, Any] = {"counts": {}, "tripped": ""}

    def on_event(event: Any) -> None:
        if isinstance(event, ActionEvent) and event.action is not None:
            call_id = str(event.tool_call_id or event.id)
            if call_id in seen_calls:
                return
            seen_calls.add(call_id)
            emit_json(
                {
                    "type": "tool_event",
                    "phase": "call",
                    "id": call_id,
                    "name": f"openhands:{event.tool_name}",
                    "args": _summarize_action_args(event.tool_name, event.action),
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
            is_plan_ro_reject = (
                isinstance(event, UserRejectObservation)
                and "Plan phase is strictly read-only" in out_text
            )
            is_err = bool(
                (isinstance(event, UserRejectObservation) and not is_plan_ro_reject)
                or is_agent_err
                or getattr(obs, "is_error", False)
            )
            if is_err:
                sig = _normalize_error_signature(str(getattr(event, "tool_name", "error") or "error"), out_text)
                counts = active_error_tracker["counts"]
                counts[sig] = counts.get(sig, 0) + 1
                if counts[sig] >= 2 and not active_error_tracker["tripped"]:
                    active_error_tracker["tripped"] = sig
                    with active_conv_lock:
                        c = active_conv_ref.get("conv")
                    if c is not None:
                        try:
                            c.pause()
                        except Exception:
                            pass
            emit_json(
                {
                    "type": "tool_event",
                    "phase": "result",
                    "id": call_id,
                    "name": f"openhands:{getattr(event, 'tool_name', 'error')}",
                    "is_error": is_err,
                    "output": out_text,
                }
            )

    conv_uuid = None
    if args.conversation_id:
        try:
            conv_uuid = uuid.UUID(args.conversation_id)
        except ValueError:
            conv_uuid = uuid.uuid5(uuid.NAMESPACE_URL, args.conversation_id)

    persistence_dir = os.path.abspath(args.persistence_dir) if args.persistence_dir else None
    if persistence_dir:
        os.makedirs(persistence_dir, exist_ok=True)

    cancelled_event = threading.Event()
    inbox: queue.Queue[dict[str, Any]] = queue.Queue()
    active_conv_lock = threading.Lock()
    active_conv_ref: dict[str, Any] = {"conv": None}

    def _stdin_loop() -> None:
        try:
            while True:
                raw_line = ctrl_stdin.readline()
                if not raw_line:
                    break
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == "cancel":
                    cancelled_event.set()
                    with active_conv_lock:
                        c = active_conv_ref.get("conv")
                    if c is not None:
                        try:
                            c.pause()
                        except Exception:
                            pass
                    inbox.put({"type": "cancel"})
                    return
                inbox.put(msg)
        except Exception:
            pass
        finally:
            inbox.put({"type": "eof"})

    threading.Thread(target=_stdin_loop, name="openhands-worker-stdin", daemon=True).start()

    def _wait_for_reply(expected_type: str, req_id: str) -> dict[str, Any] | None:
        while not cancelled_event.is_set():
            try:
                msg = inbox.get(timeout=0.25)
            except queue.Empty:
                continue
            mtype = msg.get("type")
            if mtype in ("cancel", "eof"):
                return None
            if mtype == expected_type and msg.get("id") == req_id:
                return msg
        return None

    def _run_stage_loop(
        *,
        stage_llm: Any,
        stage_instruction: str,
        max_iters: int,
        readonly_enforced: bool = False,
        stage_persistence_dir: str | None = None,
        stage_conv_uuid: Any = None,
        decision_budget: int = 4,
    ) -> dict[str, Any]:
        stage_agent = Agent(
            llm=stage_llm,
            tools=tools,
            agent_context=agent_context,
            condenser=get_default_condenser(stage_llm),
        )
        conversation = _create_conversation_with_fallback(
            Conversation,
            agent=stage_agent,
            workspace=cwd,
            persistence_dir=stage_persistence_dir,
            conversation_id=stage_conv_uuid,
            callbacks=[on_event],
            visualizer=None,
            delete_on_close=not bool(stage_persistence_dir),
            max_iteration_per_run=max(5, int(max_iters)),
        )
        with active_conv_lock:
            active_conv_ref["conv"] = conversation

        use_always_confirm = readonly_enforced or args.security_preset == "ask_always"
        conversation.set_confirmation_policy(AlwaysConfirm() if use_always_confirm else NeverConfirm())

        stage_status = "completed"
        stage_text = ""
        stage_err = ""
        stage_decisions = 0
        conv_id_out = str(conversation.id)
        active_error_tracker["counts"] = {}
        active_error_tracker["tripped"] = ""

        try:
            conversation.send_message(stage_instruction)
            while not cancelled_event.is_set():
                conversation.run()
                if cancelled_event.is_set():
                    stage_status = "cancelled"
                    break

                if active_error_tracker["tripped"]:
                    tripped_sig = active_error_tracker["tripped"]
                    active_error_tracker["tripped"] = ""
                    active_error_tracker["counts"].clear()
                    if stage_decisions < decision_budget:
                        req_id = uuid.uuid4().hex
                        emit_json(
                            {
                                "type": "decision_request",
                                "id": req_id,
                                "kind": "error_budget_exceeded",
                                "question": (
                                    f"2-strike error budget reached on `{tripped_sig}`. "
                                    "Write a 2-sentence hypothesis of why it failed and specify how to pivot or rewrite the plan."
                                ),
                                "options": [],
                            }
                        )
                        reply = _wait_for_reply("decision_response", req_id)
                        if reply is None:
                            stage_status = "cancelled"
                            break
                        stage_decisions += 1
                        pivot_text = str(reply.get("text") or "").strip()
                        if pivot_text and reply.get("action") != "done":
                            conversation.send_message(
                                "HARD RULE — ZERO ERROR BUDGET TRIGGERED:\n"
                                f"You hit 2 consecutive failures on `{tripped_sig}`. Do NOT retry the same command or patch.\n"
                                f"Supervisor Guidance: {pivot_text}\n"
                                "Write a 2-sentence hypothesis of why the previous 2 attempts failed, then either follow the guidance or stop with `HAND_BACK_NEEDED:`."
                            )
                            continue
                    stage_status = "error"
                    stage_err = f"2-strike error budget reached ({tripped_sig})."
                    stage_text = (
                        f"HAND_BACK_NEEDED: Stopped after 2 failed attempts on `{tripped_sig}`."
                    )
                    break

                exec_status = conversation.state.execution_status
                if exec_status == ConversationExecutionStatus.WAITING_FOR_CONFIRMATION:
                    pending_actions = ConversationState.get_unmatched_actions(
                        conversation.state.events
                    )
                    mutating = [act for act in pending_actions if not _is_readonly_action(act)]
                    if not mutating:
                        continue

                    if readonly_enforced:
                        bad_desc = "; ".join(
                            f"{act.tool_name}({str(getattr(act.action, 'command', '') or getattr(act.action, 'path', '') or '')[:80]})"
                            for act in mutating[:3]
                        )
                        conversation.reject_pending_actions(
                            f"Plan phase is strictly read-only (blocked: {bad_desc}). "
                            "Inspect files with file_editor view, git grep, or researcher subagent only, then write your structured plan."
                        )
                        continue

                    approved_all = True
                    for act in mutating:
                        req_id = str(act.tool_call_id or act.id or uuid.uuid4().hex)
                        emit_json(
                            {
                                "type": "confirm_request",
                                "id": req_id,
                                "tool_name": f"openhands:{act.tool_name}",
                                "args": _summarize_action_args(act.tool_name, act.action),
                            }
                        )
                        reply = _wait_for_reply("confirm_response", req_id)
                        if reply is None or not bool(reply.get("approved")):
                            approved_all = False
                            break

                    if cancelled_event.is_set():
                        stage_status = "cancelled"
                        break
                    if not approved_all:
                        conversation.reject_pending_actions("User denied execution in LM-Sanctuary")
                    continue

                if exec_status == ConversationExecutionStatus.PAUSED:
                    stage_status = "cancelled" if cancelled_event.is_set() else "paused"
                    if cancelled_event.is_set():
                        break

                pending_ask = find_pending_ask_back(conversation.state.walk_back())
                if pending_ask is not None and stage_decisions < decision_budget:
                    req_id = str(pending_ask.ask_id or uuid.uuid4().hex)
                    emit_json(
                        {
                            "type": "decision_request",
                            "id": req_id,
                            "kind": "ask_user",
                            "question": pending_ask.question,
                            "options": list(pending_ask.option_labels),
                            "recommended": pending_ask.recommended,
                        }
                    )
                    reply = _wait_for_reply("decision_response", req_id)
                    if reply is None:
                        stage_status = "cancelled"
                        break
                    stage_decisions += 1
                    opt_idx = reply.get("option_index")
                    opt_idx = int(opt_idx) if isinstance(opt_idx, int) else None
                    answer_text = str(reply.get("text") or "").strip() or None
                    msg_text = answer_message_text(pending_ask, opt_idx, answer_text)
                    conversation.send_message(msg_text)
                    continue

                stage_text = get_agent_final_response(conversation.state.events).strip()
                if (
                    exec_status == ConversationExecutionStatus.FINISHED
                    and stage_decisions < decision_budget
                    and looks_like_blocking_question(stage_text)
                ):
                    req_id = uuid.uuid4().hex
                    emit_json(
                        {
                            "type": "decision_request",
                            "id": req_id,
                            "kind": "stop_question",
                            "question": stage_text,
                            "options": [],
                        }
                    )
                    reply = _wait_for_reply("decision_response", req_id)
                    if reply is None:
                        stage_status = "cancelled"
                        break
                    if reply.get("action") == "done" or not str(reply.get("text") or "").strip():
                        break
                    stage_decisions += 1
                    conversation.send_message(str(reply["text"]).strip())
                    continue

                if exec_status in (ConversationExecutionStatus.ERROR, ConversationExecutionStatus.STUCK):
                    stage_status = exec_status.value
                break
        except Exception as exc:
            stage_status = "cancelled" if cancelled_event.is_set() else "error"
            stage_err = f"{type(exc).__name__}: {exc}"
        finally:
            if not stage_text:
                try:
                    stage_text = get_agent_final_response(conversation.state.events).strip()
                except Exception:
                    pass
            conv_id_out = str(conversation.id)
            with active_conv_lock:
                if active_conv_ref.get("conv") is conversation:
                    active_conv_ref["conv"] = None
            try:
                conversation.close()
            except Exception:
                pass

        return {
            "status": stage_status,
            "final_response": stage_text,
            "error": stage_err,
            "decision_rounds": stage_decisions,
            "conversation_id": conv_id_out,
        }

    status_str = "completed"
    final_text = ""
    err_str = ""
    decision_rounds = 0
    out_conv_id = str(conv_uuid or "")
    pre_tmp = {
        name for name in (os.listdir(cwd) if os.path.isdir(cwd) else [])
        if name.startswith("_tmp_")
    }

    try:
        if args.workflow in ("staged", "plan", "execute"):
            approved_plan = ""
            if args.approved_plan_file and os.path.isfile(args.approved_plan_file):
                try:
                    with open(args.approved_plan_file, "r", encoding="utf-8") as f:
                        approved_plan = f.read().strip()
                except OSError:
                    approved_plan = ""

            if args.workflow in ("staged", "plan"):
                emit_json({"type": "phase_event", "phase": "Planning"})
                plan_prompt = (
                    "## Stage 1: Read-Only Investigation & Planning\n"
                    f"Task:\n{instruction}\n\n"
                    "Rules:\n"
                    "- Inspect the repository read-only using `git grep -n`, bounded `file_editor` (`view` with `view_range`), or `researcher` subagents.\n"
                    "- Do NOT edit or create any files.\n"
                    "- NO ERROR BUDGET: After 2 failed tool calls on the same error, stop immediately, write a 2-sentence hypothesis of why it failed, and call `ask_user`.\n"
                    "- Output a concise markdown plan containing ALL 4 structured pre-mutation fields and headings:\n"
                    "  - `intent`: 1-sentence statement of what behavior is changing and why\n"
                    "  - `files_to_touch`: exact relative file paths and line ranges (under `## Code Map`)\n"
                    "  - `exact_diff`: exact target symbols/lines and replacement logic (under `## Exact Changes`)\n"
                    "  - `how_I_will_verify`: exact targeted test/verification command and expected output (under `## Verification Command`)\n"
                    "  - `## Steps` (numbered 1..N imperative steps, max 6)\n"
                    "  - `## Re-plan if` (conditions that require escalation)"
                )
                s1 = _run_stage_loop(
                    stage_llm=deep_llm,
                    stage_instruction=plan_prompt,
                    max_iters=min(18, args.max_iterations),
                    readonly_enforced=True,
                    stage_persistence_dir=None,
                    stage_conv_uuid=None,
                    decision_budget=min(2, args.max_decision_rounds),
                )
                decision_rounds += s1["decision_rounds"]
                out_conv_id = s1["conversation_id"]
                if args.workflow == "plan" or s1["status"] in ("cancelled", "error") or cancelled_event.is_set():
                    status_str = s1["status"]
                    final_text = s1["final_response"]
                    err_str = s1["error"]
                    raise StopIteration()
                active_plan = s1["final_response"] or ""
                plan_ok, missing_fields = validate_structured_mutation_plan(active_plan)
                if not plan_ok:
                    status_str = "error"
                    err_str = (
                        "Stage 1 plan rejected before mutation: missing required structured fields "
                        f"({', '.join(missing_fields)})."
                    )
                    final_text = active_plan or err_str
                    raise StopIteration()
            else:
                active_plan = approved_plan or instruction

            emit_json({"type": "phase_event", "phase": "Implementing"})
            exec_prompt = (
                "## Stage 2: Execute Approved Plan\n"
                f"Original Task:\n{instruction}\n\n"
                f"Approved Plan & Code Map:\n{active_plan}\n\n"
                "Rules:\n"
                "- Before mutating any file, confirm `intent`, `files_to_touch`, `exact_diff`, and `how_I_will_verify` from the approved plan. If any are missing or wrong, stop with `HAND_BACK_NEEDED:`.\n"
                "- Implement the exact changes in `## Exact Changes` using `file_editor` without re-exploring the whole repo.\n"
                "- Do not leave `_tmp_*` scratch files in the workspace.\n"
                "- NO ERROR BUDGET: After 2 failed fixes or 2 failed tool calls on the same error, stop immediately, write a 2-sentence hypothesis of why it failed, and start your response with `HAND_BACK_NEEDED:`."
            )
            s2 = _run_stage_loop(
                stage_llm=fast_llm,
                stage_instruction=exec_prompt,
                max_iters=min(30, args.max_iterations),
                readonly_enforced=False,
                stage_persistence_dir=persistence_dir,
                stage_conv_uuid=conv_uuid,
                decision_budget=max(1, args.max_decision_rounds - decision_rounds),
            )
            decision_rounds += s2["decision_rounds"]
            out_conv_id = s2["conversation_id"]
            if s2["status"] == "cancelled" or cancelled_event.is_set():
                status_str = "cancelled"
                final_text = s2["final_response"]
                err_str = s2["error"]
                raise StopIteration()

            needs_repair = (
                "HAND_BACK_NEEDED:" in (s2["final_response"] or "")
                or s2["status"] != "completed"
                or not (s2["final_response"] or "").strip()
            )
            s3_text = ""
            verify_failed = False

            if not needs_repair:
                emit_json({"type": "phase_event", "phase": "Verifying"})
                _sweep_untracked_tmp_files(cwd, pre_tmp)
                verify_prompt = (
                    "## Stage 3: Independent Verification\n"
                    f"Original Task:\n{instruction}\n\n"
                    f"Plan & Verification Command:\n{active_plan}\n\n"
                    f"Implementer Report:\n{s2['final_response']}\n\n"
                    "Rules:\n"
                    "- Run the targeted verification command and `git status --porcelain` via `terminal`.\n"
                    "- Never claim tests pass unless you ran them after the final edit and observed 0 failures.\n"
                    "- Begin or end your response with `VERIFY_STATUS: PASS` or `VERIFY_STATUS: FAIL` and include exact observed outputs."
                )
                s3 = _run_stage_loop(
                    stage_llm=fast_llm,
                    stage_instruction=verify_prompt,
                    max_iters=10,
                    readonly_enforced=False,
                    stage_persistence_dir=None,
                    stage_conv_uuid=None,
                    decision_budget=1,
                )
                decision_rounds += s3["decision_rounds"]
                s3_text = s3["final_response"] or ""
                if s3["status"] == "cancelled" or cancelled_event.is_set():
                    status_str = "cancelled"
                    final_text = s3_text
                    err_str = s3["error"]
                    raise StopIteration()
                verify_failed = (
                    "VERIFY_STATUS: FAIL" in s3_text.upper()
                    or (s3["status"] != "completed" and "VERIFY_STATUS: PASS" not in s3_text.upper())
                )

            if (needs_repair or verify_failed) and not cancelled_event.is_set():
                emit_json({"type": "phase_event", "phase": "Reviewing"})
                repair_prompt = (
                    "## Stage 4: Deep Repair & Final Verification\n"
                    f"Original Task:\n{instruction}\n\n"
                    f"Plan:\n{active_plan}\n\n"
                    f"Stage 2 Output:\n{s2['final_response']}\n\n"
                    f"Stage 3 Verification Output:\n{s3_text}\n\n"
                    "Rules:\n"
                    "- Diagnose the root cause, apply the minimal fix, and re-run the targeted verification command.\n"
                    "- Conclude with `VERIFY_STATUS: PASS` and exact observed test results, or a `## Checkpoint Summary` of completed vs. remaining steps."
                )
                s4 = _run_stage_loop(
                    stage_llm=deep_llm,
                    stage_instruction=repair_prompt,
                    max_iters=min(20, args.max_iterations),
                    readonly_enforced=False,
                    stage_persistence_dir=None,
                    stage_conv_uuid=None,
                    decision_budget=max(1, args.max_decision_rounds - decision_rounds),
                )
                decision_rounds += s4["decision_rounds"]
                status_str = s4["status"]
                final_text = s4["final_response"] or s3_text or s2["final_response"]
                err_str = s4["error"]
            else:
                status_str = "completed"
                final_text = s3_text or s2["final_response"]
                err_str = s2["error"]
        else:
            single_prompt = (
                f"{instruction}\n\n"
                "Mandatory Execution Rules:\n"
                "- Before any file edit or mutating command, output a structured pre-edit block with `intent`, `files_to_touch`, `exact_diff`, and `how_I_will_verify`. If you cannot fill all 4 from concrete source evidence, do not edit any files.\n"
                "- NO ERROR BUDGET: After 2 failed fixes or 2 failed tool calls on the same error, stop immediately, write a 2-sentence hypothesis of why it failed, and call `ask_user` or stop."
            )
            single = _run_stage_loop(
                stage_llm=deep_llm,
                stage_instruction=single_prompt,
                max_iters=args.max_iterations,
                readonly_enforced=False,
                stage_persistence_dir=persistence_dir,
                stage_conv_uuid=conv_uuid,
                decision_budget=args.max_decision_rounds,
            )
            status_str = single["status"]
            final_text = single["final_response"]
            err_str = single["error"]
            decision_rounds = single["decision_rounds"]
            out_conv_id = single["conversation_id"]
    except StopIteration:
        pass
    finally:
        _sweep_untracked_tmp_files(cwd, pre_tmp)

    emit_json(
        {
            "type": "result",
            "status": status_str,
            "conversation_id": out_conv_id,
            "final_response": final_text,
            "decision_rounds": decision_rounds,
            "error": err_str,
        }
    )
    return 0 if status_str in ("completed", "paused") else 1


if __name__ == "__main__":
    raise SystemExit(main())
