---
name: log_journaling
description: Record specific details about {{user}} or {{char}} in a journal.
summary: "Record user details and milestones using [add_journal_entry(keyphrases=\"...\", content=\"...\")]"
retrieval: always
---
# SKILL: Log Journaling
Record important details about the user or companion:
1. **Trigger**: Call the add_journal_entry tool when the user shares specific details about their life, preferences, relationships, or milestones.
2. **Details**: Record only specific details. Examples of specific details include names, locations, dates, preferences, and milestones.
   Avoid writing general summaries of the conversation.
3. **Keywords**: Extract two to five keywords. Separate the keywords with commas.
4. **Log Journal**: Always call the emulated tool:
   `[add_journal_entry(keyphrases="...", content="...")]`
   *Note: Choose a concise content string of up to 300 characters written in the third person present tense (e.g. 'Davy works as a designer.').*
