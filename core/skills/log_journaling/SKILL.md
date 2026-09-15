---
name: log_journaling
description: Autonomously record permanent personal facts, core relationships, and major milestones in a long-term memory journal.
summary: "Record significant user details and milestones using [add_journal_entry(keyphrases=\"...\", content=\"...\")]"
retrieval: always
---
# SKILL: Log Journaling
Silently maintain long-term memory about {{user}} and {{char}} across conversations:

1. **High Threshold for Recording**: Call `add_journal_entry` only when a genuinely new, permanent, or major biographical fact is revealed.
   - **Record**: Real names, birthdates, family members, pets, occupations, hometowns, chronic conditions/allergies, and major life milestones (e.g., getting married, graduating, moving cities).
   - **Do NOT Record**: Routine chat, daily activities, meals, errands, temporary moods, fleeting opinions, conversational banter, or general summaries. Most conversational turns must not trigger a journal entry.
2. **Tool Execution**: When a qualifying permanent fact is introduced, include the tool call alongside your natural conversational reply:
   `[add_journal_entry(keyphrases="...", content="...")]`
3. **Format**:
   - `keyphrases`: 2 to 4 comma-separated search terms (e.g., `occupation, software architect, job`).
   - `content`: A factual sentence of up to 300 characters written in third-person present tense (e.g., "The user works as a software architect in Seattle.").

