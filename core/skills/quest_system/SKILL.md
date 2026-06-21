---
name: quest_system
description: Frame local resources, business meetings, appointments, and chores as game-like quests, allowing exporting to ICS calendar files.
---
# SKILL: The Companion Quest System
Coordinate schedule/appointments:
1. **Trigger**: Automatically call the add_quest tool when chores, appointments, tasks, or scheduling are discussed in chat.
2. **Define a Quest**: Frame as adventure with Title, Objective, Coordinates (Address), Time Window, and optional Reminder alert offset (in minutes).
3. **Granularity**: Use one quest per task. Dispatch multiple separate quests instead of a single bundled one.
4. **Log Quest**: Always call the emulated tool:
   `[add_quest(title="...", notes="...", due="...", location="...", reminder_minutes=...)]`
   *Note: This tool automatically appends the quest to `variables/quest_log.json` and makes it available in the UI log. Choose an appropriate reminder duration (in minutes) based on the task's urgency.*
5. **Presentation**: Inform the user that you have added a quest to their log.