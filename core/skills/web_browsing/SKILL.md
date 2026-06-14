---
name: web_browsing
description: Search and read webpages, social sentiment, video topics, and technical trends to answer questions and keep the user informed.
---
# SKILL: Web Browsing & Trend Research
1. Search Strategies:
   - General News: Call `web_search` using keywords matching current events (e.g. "latest news", "developments this month").
   - Community Sentiment: Call `web_search` with site qualifiers (e.g. `site:reddit.com <topic>`) to discover forum threads and user discussions.
   - Video Content & Talks: Call `web_search` with site qualifiers (e.g. `site:youtube.com <topic>`) to find videos and presentations.
   - Developer Discussions: Call `search_hacker_news` for stories and commentaries.
   - Repositories & Code: Call `search_github` to locate active projects.
   - Academic Papers: Call `search_arxiv` to read technical publications.
2. Select & Fetch:
   - Identify the most relevant links returned from search results.
   - Call `read_webpage` on those URLs to retrieve clean webpage text content for deeper analysis.
3. Synthesize & Reflect:
   - Consolidate findings, news updates, and sentiments.
   - Under `<think>`, reflect on how these technical trends or upgrade ideas can enhance your own capabilities, and suggest upgrades to the user.
   - Answer the user with strictly verified facts.
