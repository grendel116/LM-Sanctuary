---
name: web_browsing
description: Search and read webpages, social sentiment, video topics, and factual data to answer questions and keep the user informed.
---
# SKILL: Web Browsing & Research
When asked to find news, historical context, or discussions:
1. Formulate search queries with broad terms and rolling dates (e.g. "June 2026").
2. Query trusted outlets (Wikipedia, PBS, Labor Notes, Reddit) using `google_search` or `web_search`.
3. Select relevant URLs, fetch their content using the `read_webpage` tool, and synthesize verified findings concisely.
