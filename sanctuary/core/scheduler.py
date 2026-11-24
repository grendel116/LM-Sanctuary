"""Lightweight native Quest & Automation scheduler for LM-Sanctuary.

Replaces Antigravity's proprietary `sidecar.json` automation daemon by evaluating
recurring (`hourly`, `daily`, `weekly`, or 5-field cron) and scheduled `auto_prompt`
quests directly from `quest_log.json`.
"""

from __future__ import annotations

import threading
from datetime import datetime, timedelta

from core import quest_manager

_STOP_EVENT = threading.Event()
_THREAD: threading.Thread | None = None
_LOCK = threading.Lock()


def _match_cron_field(field: str, value: int, min_val: int, max_val: int) -> bool:
    for part in field.split(","):
        part = part.strip()
        if not part:
            continue
        step = 1
        if "/" in part:
            part, step_str = part.split("/", 1)
            step = max(1, int(step_str))
        if part == "*":
            if (value - min_val) % step == 0:
                return True
        elif "-" in part:
            lo_s, hi_s = part.split("-", 1)
            lo, hi = int(lo_s), int(hi_s)
            if lo <= value <= hi and (value - lo) % step == 0:
                return True
        else:
            target = int(part)
            if max_val == 6 and target == 7:
                target = 0
            if value == target:
                return True
    return False


def compute_next_due(recurrence: str, after: datetime) -> datetime | None:
    """Compute the next aware `datetime` strictly after `after` for `recurrence`."""
    spec = (recurrence or "").strip().lower()
    if not spec:
        return None
    base = after.replace(second=0, microsecond=0)
    if spec == "hourly":
        return base + timedelta(hours=1)
    if spec == "daily":
        return base + timedelta(days=1)
    if spec == "weekly":
        return base + timedelta(days=7)

    parts = spec.split()
    if len(parts) != 5:
        return None

    minute_f, hour_f, dom_f, month_f, dow_f = parts
    candidate = base + timedelta(minutes=1)
    # Scan up to 366 days ahead in 1-minute increments (fast integer checks)
    for _ in range(366 * 24 * 60):
        cron_dow = (candidate.weekday() + 1) % 7  # 0 = Sunday .. 6 = Saturday
        if (
            _match_cron_field(month_f, candidate.month, 1, 12)
            and _match_cron_field(dom_f, candidate.day, 1, 31)
            and _match_cron_field(dow_f, cron_dow, 0, 6)
            and _match_cron_field(hour_f, candidate.hour, 0, 23)
            and _match_cron_field(minute_f, candidate.minute, 0, 59)
        ):
            return candidate
        candidate += timedelta(minutes=1)
    return None


def evaluate_due_automations(now: datetime | None = None, execute_callback=None) -> list[str]:
    """Check active program quests and run any due `auto_prompt` automations."""
    from runners.program import get_active_program, get_active_session
    from utils.social_vault import VaultLockedError

    current_time = now or datetime.now().astimezone()
    program_id = get_active_program()
    try:
        quests = quest_manager.load_quests(program_id)
    except VaultLockedError:
        return []
    triggered: list[str] = []

    for quest in quests:
        auto_prompt = str(quest.get("auto_prompt") or "").strip()
        recurrence = str(quest.get("recurrence") or "").strip()
        if not auto_prompt and not recurrence:
            continue
        if quest.get("auto_completed") and not recurrence:
            continue

        raw_due = str(quest.get("due") or "").strip()
        if not raw_due:
            continue
        try:
            due_dt = quest_manager.parse_due(raw_due)
        except ValueError:
            continue

        if due_dt > current_time:
            continue

        next_due = compute_next_due(recurrence, current_time) if recurrence else None
        quest_manager.advance_quest_schedule(
            quest["id"], next_due=next_due, last_run=current_time, program=program_id
        )
        if not auto_prompt:
            continue

        triggered.append(quest["id"])
        prompt_msg = f"[Scheduled Quest: {quest.get('title', 'Automation')}]\n{auto_prompt}"
        if callable(execute_callback):
            execute_callback(program_id, get_active_session(), prompt_msg)
        else:
            try:
                import state as st

                if getattr(st, "runner", None) is not None:
                    st.run_async(
                        st.runner.run_async(
                            session_id=get_active_session(),
                            new_message_text=prompt_msg,
                        )
                    )
            except Exception as exc:
                print(f"[scheduler] Automation '{quest.get('title')}' failed: {exc}", flush=True)

    return triggered


def _loop(poll_seconds: float = 30.0) -> None:
    while not _STOP_EVENT.wait(poll_seconds):
        try:
            evaluate_due_automations()
        except Exception as exc:
            print(f"[scheduler] Loop error: {exc}", flush=True)


def start_scheduler(poll_seconds: float = 30.0) -> None:
    global _THREAD
    with _LOCK:
        if _THREAD is not None and _THREAD.is_alive():
            return
        _STOP_EVENT.clear()
        _THREAD = threading.Thread(
            target=_loop, kwargs={"poll_seconds": poll_seconds}, name="sanctuary-quest-scheduler", daemon=True
        )
        _THREAD.start()


def stop_scheduler() -> None:
    _STOP_EVENT.set()
