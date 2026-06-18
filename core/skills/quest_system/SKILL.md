---
name: quest_system
description: Frame local resources, business meetings, appointments, and chores as game-like quests, syncing them with Google Calendar and sending SMS reminders.
---
# SKILL: The Companion Quest System
Coordinate schedule/appointments using local scripts:
1. **Trigger**: Automatically run the quest_manager tool when chores, appointments, tasks, or scheduling are discussed in chat.
2. **Define a Quest**: Frame as adventure with Title, Objective, Coordinates (Address), Time Window, and Reward.
3. **Granularity**: Use one quest per task. Dispatch multiple separate quests instead of a single bundled one.
4. **Log Quest**: Always run the built-in script:
   `python utils/quest_manager.py --action add_quest --title "..." --notes "..." --due "..." --location "..."`
   *Note: This script automatically initializes and appends quests to the database at `variables/quest_log.json` (which is a JSON array/list of quest objects). You do not need to create, initialize, or modify the JSON file manually.*
5. **Presentation**: Inform the user that you have added a quest to their log.