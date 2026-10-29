"""Quest log storage for the active program.

All reads and writes to quest_log.json go through this module. A process-wide
lock serializes read-modify-write cycles so parallel tool calls never interleave,
and every due time is stored as a timezone-aware local ISO 8601 string.
"""
import json
import os
import threading
import uuid
from datetime import datetime

from runners.program import get_active_program
from variables.settings import PROGRAMS_DIR

_lock = threading.Lock()


def _quest_log_path(program: str | None = None) -> str:
    return os.path.join(PROGRAMS_DIR, program or get_active_program(), "quest_log.json")


def _read(path: str) -> list[dict]:
    if not os.path.exists(path):
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write(path: str, quests: list[dict]):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temp_path = f"{path}.{uuid.uuid4().hex}.tmp"
    with open(temp_path, "w", encoding="utf-8") as f:
        json.dump(quests, f, indent=2, ensure_ascii=False)
    os.replace(temp_path, path)


def parse_due(value: str) -> datetime:
    """Parses an ISO 8601 date or datetime into an aware local datetime.

    Values without an offset are interpreted as the host's local time.
    Raises ValueError for anything that is not ISO 8601.
    """
    dt = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    return dt.astimezone()


def load_quests(program: str | None = None) -> list[dict]:
    with _lock:
        return _read(_quest_log_path(program))


def add_quest(title: str, objectives: list[str], due: datetime, location: str, reminder_minutes: int) -> dict | None:
    """Appends a quest. Returns the new quest, or None when an open quest already has this title."""
    path = _quest_log_path()
    with _lock:
        quests = _read(path)
        if any(q.get("title") == title for q in quests):
            return None
        now = datetime.now().astimezone()
        quest = {
            "id": f"quest_{int(now.timestamp())}_{uuid.uuid4().hex[:6]}",
            "title": title,
            "objectives": objectives,
            "location": location,
            "due": due.isoformat(timespec="minutes"),
            "reminder_minutes": reminder_minutes,
            "created_at": now.isoformat(timespec="seconds"),
        }
        quests.append(quest)
        _write(path, quests)
        return quest


def remove_quest(quest_id: str) -> dict | None:
    """Removes a quest by id and returns it, or None when it does not exist."""
    path = _quest_log_path()
    with _lock:
        quests = _read(path)
        removed = next((q for q in quests if q.get("id") == quest_id), None)
        if removed:
            _write(path, [q for q in quests if q.get("id") != quest_id])
        return removed
