#!/usr/bin/env python3
import os
import sys
import json
import argparse
from datetime import datetime, timezone

# Ensure variables directory exists
VARIABLES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "variables")
QUEST_LOG_PATH = os.path.join(VARIABLES_DIR, "quest_log.json")

def main():
    parser = argparse.ArgumentParser(description="Sanctuary Local Quest Manager")
    parser.add_argument("--action", required=True, choices=["add_quest"])
    parser.add_argument("--title", required=True, help="Title of the quest")
    parser.add_argument("--notes", required=True, help="Newline-separated list of objectives")
    parser.add_argument("--due", help="Due time (ISO timestamp)")
    parser.add_argument("--location", default="", help="Location coordinates / address")
    parser.add_argument("--reminder-minutes", type=int, default=15, help="Reminder alert offset in minutes before due")
    args = parser.parse_args()

    # Load existing quests
    quests = []
    if os.path.exists(QUEST_LOG_PATH):
        try:
            with open(QUEST_LOG_PATH, 'r', encoding='utf-8') as f:
                quests = json.load(f)
        except Exception:
            quests = []

    # Parse notes into structured objectives
    raw_notes = args.notes.replace('\\n', '\n')
    objectives = [line.strip() for line in raw_notes.split('\n') if line.strip()]
    if not objectives:
        objectives = [args.notes.strip()]

    # Generate new quest object
    import uuid
    timestamp = int(datetime.now(timezone.utc).timestamp())
    unique_suffix = uuid.uuid4().hex[:6]
    quest = {
        "id": f"quest_{timestamp}_{unique_suffix}",
        "title": args.title.strip(),
        "objectives": objectives,
        "location": args.location.strip(),
        "due": args.due or datetime.now(timezone.utc).isoformat(),
        "reminder_minutes": args.reminder_minutes,
        "created_at": datetime.now(timezone.utc).isoformat()
    }

    quests.append(quest)

    # Save back to quest_log.json
    os.makedirs(VARIABLES_DIR, exist_ok=True)
    with open(QUEST_LOG_PATH, 'w', encoding='utf-8') as f:
        json.dump(quests, f, indent=2, ensure_ascii=False)

    print(json.dumps(quest, indent=2))

if __name__ == "__main__":
    main()
