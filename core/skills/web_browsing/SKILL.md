---
name: web_browsing
description: Search and read webpages, social sentiment, video topics, and factual data to answer questions and keep the user informed.
---
# SKILL: Web Browsing & Research
When asked to find news, historical context, facts, or information about a person, place, or topic:
1. Formulate a specific search query. Use `web_search` or `google_search`. Prefix with `wikipedia:`, `github:`, `arxiv:`, or `hn:` to target specific sources.
2. After receiving search results, immediately summarize in 2-4 sentences what each result reveals — titles, URLs, and snippet content all count as data. Do not dismiss results as "unhelpful" without extracting what is actually there.
3. Use `read_webpage` on the 1-2 most relevant URLs to get full page content, then summarize those findings in 2-4 sentences each.
4. Use a different, more specific query for any follow-up search. Never repeat the same query or URL.
5. After all sources are gathered, synthesize the per-source summaries into a final reflection — what the data shows, what patterns or contradictions appear, and what conclusions can be drawn.
6. Ground all claims in what was actually found. Do not substitute editorial inference for sourced detail, and do not claim "nothing was found" if results were returned.
