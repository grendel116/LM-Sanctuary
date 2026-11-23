---
name: quest_system
title: Program Quest & Scheduled Automation System
description: Schedule appointments, reminders, chores, recurring cron automations, and trackable quests with calendar export.
summary: "Log appointments, tasks, or recurring automations using [add_quest(title=\"...\", notes=\"...\", due=\"...\", location=\"...\", reminder_minutes=15, recurrence=\"...\", auto_prompt=\"...\")]"
retrieval: vector
triggers: appointment, meeting, schedule, reminder, chore, task, quest, calendar, deadline, every morning, every day, every week, hourly, daily, weekly, cron, automate, automation, recurring
---
# SKILL: Program Quest & Automation System
Create one focused quest per task/schedule via `[add_quest(...)]`:
- One-shot: `[add_quest(title="...", notes="...", due="YYYY-MM-DDTHH:MM", location="...", reminder_minutes=15)]`
- Recurring automation: add `recurrence="hourly|daily|weekly|<cron>"` and `auto_prompt="..."` (self-contained prompt to run at `due`). Confirm local time and cadence concisely.
