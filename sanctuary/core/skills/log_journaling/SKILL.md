---
name: log_journaling
description: Autonomously record permanent personal facts, core relationships, and major milestones in a long-term memory journal.
summary: "Record significant user details and milestones using [add_journal_entry(keyphrases=\"...\", content=\"...\")]"
retrieval: vector
triggers: remember this, don't forget, journal, milestone, my birthday, born on, i work as, my job, moved to, married, divorced, sober since
---
# SKILL: Log Journaling
Call `[add_journal_entry(keyphrases="...", content="...")]` alongside your reply ONLY when a genuinely permanent biographical fact or major milestone about {{user}} or {{char}} is revealed (never for routine chat, errands, or temporary moods).
- `keyphrases`: 2–4 comma-separated search terms; `content`: third-person present tense sentence (<=300 chars).

