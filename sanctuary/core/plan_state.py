"""Encrypted session-persisted implementation plan & work ledger helpers (zero regex)."""

from __future__ import annotations

from typing import Any

_GENERIC_HEADINGS = frozenset({
    "goal",
    "goals",
    "planned changes",
    "changes",
    "verification",
    "plan",
    "implementation plan",
    "risks",
    "summary",
    "overview",
    "not changed",
    "out of scope",
    "context",
    "background",
    "notes",
})

_VALID_STATUSES = frozenset({"pending", "in_progress", "done", "skipped", "clear"})
_STATUS_MARKERS = {
    "done": "[x]",
    "in_progress": "[~]",
    "skipped": "[-]",
    "pending": "[ ]",
}


def _strip_md_inline(text: str) -> str:
    return text.replace("**", "").replace("__", "").replace("`", "").strip()


def _append_ledger(cs: dict[str, Any], entry: str) -> None:
    clean = " ".join(str(entry or "").split()).strip()
    if not clean:
        return
    ledger = cs.setdefault("ledger", [])
    if ledger and ledger[-1] == clean:
        return
    ledger.append(clean)
    if len(ledger) > 12:
        del ledger[:-12]


def extract_plan_steps(plan_md: str) -> list[dict[str, Any]]:
    """Extract up to 12 ordered steps from markdown headings or top-level numbered/task items."""
    lines = (plan_md or "").splitlines()
    titles: list[str] = []
    in_fence = False

    # Pass 1: #, ##, ### headings excluding generic boilerplate headings
    for raw in lines:
        s = raw.strip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        if s.startswith("#"):
            hashes = len(s) - len(s.lstrip("#"))
            if 1 <= hashes <= 3 and len(s) > hashes and s[hashes] == " ":
                title = _strip_md_inline(s[hashes + 1 :].strip())
                if title and title.lower().rstrip(":") not in _GENERIC_HEADINGS:
                    titles.append(title[:120])

    # Pass 2: numbered items (1. ... / 1) ...) or task/bold bullets if no step headings
    if not titles:
        in_fence = False
        for raw in lines:
            if raw.startswith("  ") or raw.startswith("\t"):
                continue
            s = raw.strip()
            if s.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence or not s:
                continue
            title = ""
            for num in range(1, 13):
                for sep in (f"{num}. ", f"{num}) "):
                    if s.startswith(sep):
                        title = _strip_md_inline(s[len(sep) :])
                        break
                if title:
                    break
            if not title and (s.startswith("- [ ] ") or s.startswith("- [x] ") or s.startswith("- [X] ")):
                title = _strip_md_inline(s[6:])
            elif not title and s.startswith("- **"):
                end_bold = s.find("**", 4)
                if end_bold != -1:
                    title = _strip_md_inline(s[4:end_bold])
                else:
                    title = _strip_md_inline(s[2:])
            if title:
                titles.append(title[:120])

    if not titles:
        return [{"index": 1, "title": "Carry out approved implementation plan", "status": "pending"}]

    return [
        {"index": idx, "title": title, "status": "pending"}
        for idx, title in enumerate(titles[:12], start=1)
    ]


def stage_plan(meta: dict[str, Any], plan_md: str) -> None:
    """Persist the latest proposed ```sanctuary-plan block so Proceed survives history trimming."""
    cs = meta.setdefault("coding_state", {})
    cs["staged_plan_markdown"] = (plan_md or "").strip()[:4000]


def activate_plan(meta: dict[str, Any], plan_md: str) -> dict[str, Any]:
    """Activate an approved plan, preserving done/skipped status for matching step titles."""
    clean = (plan_md or "").strip()[:4000]
    cs = meta.setdefault("coding_state", {})
    prior_status = {
        str(s.get("title") or "").strip().lower(): s.get("status")
        for s in (cs.get("steps") or [])
        if s.get("status") in ("done", "skipped")
    }
    new_steps = extract_plan_steps(clean)
    for st in new_steps:
        prev = prior_status.get(st["title"].lower())
        if prev:
            st["status"] = prev
    cs["plan_markdown"] = clean
    cs["steps"] = new_steps
    cs["active"] = any(s.get("status") not in ("done", "skipped") for s in new_steps)
    cs.setdefault("ledger", [])
    return cs


def has_active_plan(meta: dict[str, Any] | None) -> bool:
    if not isinstance(meta, dict):
        return False
    cs = meta.get("coding_state")
    if not isinstance(cs, dict) or not cs.get("active"):
        return False
    return any(s.get("status") not in ("done", "skipped") for s in (cs.get("steps") or []))


def format_plan_checklist(cs: dict[str, Any]) -> str:
    steps = cs.get("steps") or []
    done_count = sum(1 for s in steps if s.get("status") in ("done", "skipped"))
    lines = [f"[Plan Progress: {done_count}/{len(steps)} done]"]
    for s in steps:
        marker = _STATUS_MARKERS.get(s.get("status", "pending"), "[ ]")
        lines.append(f"{s.get('index')}. {marker} {s.get('title', '')}")
    return "\n".join(lines)


def update_step_status(meta: dict[str, Any], step: int, status: str, note: str = "") -> str:
    norm = str(status or "").strip().lower()
    if norm in ("completed", "complete"):
        norm = "done"
    if norm not in _VALID_STATUSES:
        return "Error: status must be pending, in_progress, done, skipped, or clear."

    cs = meta.setdefault("coding_state", {})
    steps = cs.get("steps") or []
    try:
        step_num = int(step)
    except (TypeError, ValueError):
        return "Error: step must be an integer."

    if step_num == 0 and norm in ("done", "clear", "skipped"):
        if norm == "clear":
            cs["steps"] = []
            cs["plan_markdown"] = ""
        else:
            for s in steps:
                s["status"] = "done"
        cs["active"] = False
        if note and note.strip():
            _append_ledger(cs, note.strip()[:140])
        return "[Plan completed and cleared]"

    if not steps:
        return "Error: No active implementation plan in this session."

    target = next((s for s in steps if s.get("index") == step_num), None)
    if target is None:
        return f"Error: Step {step_num} out of range (1..{len(steps)})."

    target["status"] = "pending" if norm == "clear" else norm
    if note and note.strip():
        _append_ledger(cs, f"Step {step_num} ({target['status']}): {note.strip()[:140]}")

    if all(s.get("status") in ("done", "skipped") for s in steps):
        cs["active"] = False

    return format_plan_checklist(cs)


def record_tool_ledger(meta: dict[str, Any], results: list[tuple[str, dict[str, Any], str]]) -> None:
    cs = meta.setdefault("coding_state", {})
    for t_name, t_args, raw_out in results:
        out = str(raw_out or "").strip()
        first_line = out.splitlines()[0] if out else ""
        if t_name == "edit_file" and first_line.startswith("Edited "):
            _append_ledger(cs, first_line[:160])
        elif t_name == "write_file" and first_line.startswith("Wrote "):
            _append_ledger(cs, first_line[:160])
        elif t_name == "run_command":
            cmd = " ".join(str((t_args or {}).get("command") or "").split())[:80]
            if first_line.startswith("[Command succeeded"):
                _append_ledger(cs, f"Command ok: `{cmd}`")
            elif first_line.startswith("Error: Command"):
                lines = out.splitlines()
                detail = lines[1].strip()[:80] if len(lines) > 1 else first_line[:80]
                _append_ledger(cs, f"Command failed: `{cmd}` ({detail})")


def format_coding_state_block(meta: dict[str, Any] | None, include_ledger_only: bool = False) -> str:
    cs = (meta or {}).get("coding_state") or {}
    if not isinstance(cs, dict):
        return ""
    blocks: list[str] = []
    active = has_active_plan(meta)
    if active:
        blocks.append(
            "# ACTIVE IMPLEMENTATION PLAN (Persisted Across Turns)\n"
            + format_plan_checklist(cs)
            + '\nCall `update_plan_step(step=N, status="in_progress"|"done", note="...")` as you start and finish each step. '
            "Resume from the first unfinished step.\n\n"
            + str(cs.get("plan_markdown") or "")
        )
    ledger = cs.get("ledger") or []
    if ledger and (active or include_ledger_only):
        blocks.append("# RECENT WORK LEDGER\n" + "\n".join(f"- {item}" for item in ledger[-10:]))
    return "\n\n".join(blocks)
