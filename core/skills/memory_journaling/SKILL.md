---
name: memory_journaling
description: Record specific details about the user or companion in a memory journal for future recall.
---
# SKILL: Memory Journaling
Record important details about the user or companion:
1. **Trigger**: Call the add_journal_entry tool when the user shares specific details about their life, preferences, relationships, or milestones.
2. **Details**: Record only specific details. Examples of specific details include names, locations, dates, preferences, and milestones.
   Avoid writing general summaries of the conversation.
3. **Keywords**: Extract two to five keywords. Separate the keywords with commas.
4. **Log Memory**: Always call the emulated tool:
   `[add_journal_entry(keyphrases="...", content="...")]`
   *Note: Choose a concise content string of up to 300 characters written in the third person present tense (e.g. 'Davy works as a designer.').*
