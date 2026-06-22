---
name: web_browsing
description: Search and read webpages, social sentiment, video topics, and factual data to answer questions and keep the user informed.
---
# SKILL: Web Browsing & Research
When asked to find news, historical context, facts, or information about a person, place, or topic:
1. Formulate a specific search query. Use `web_search` or `google_search`. Prefix with `wikipedia:`, `github:`, `arxiv:`, or `hn:` to target specific sources.
2. After each search or `read_webpage` result, write a 2-4 sentence summary of what was found — key facts, names, dates, roles, events.
3. If snippets are thin or irrelevant, read the best-looking URL with `read_webpage` to get full page content.
4. Use a different, more specific query for each follow-up search. Never repeat the same query or URL.
5. After all searches are complete, synthesize the per-source summaries into a final reflection — what the data shows, what patterns or contradictions appear, and what conclusions can be drawn.
6. Ground all claims in what was actually read. Do not substitute editorial inference for sourced detail.
