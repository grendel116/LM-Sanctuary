---
name: web_browsing
description: Search and read webpages, URLs, links, articles, online documentation, social sentiment, video topics, and factual data to answer questions and keep the user informed.
summary: "Search the internet using [web_search(query=\"...\")] and read pages using [read_webpage(url=\"...\")]"
retrieval: vector
triggers: search, look up, browse, news, find information, google, website, article, wikipedia, github, arxiv, http, https, url, link, urls, links, www.
---
# SKILL: Web Browsing & Research
When given a URL or link, or when asked to find news, historical context, facts, technical repos, papers, or information:
1. When the user shares a URL or link, call `[read_webpage(url="...")]` to fetch and read the webpage content directly. Ground your response in the actual text of the page.
2. If searching for information, formulate a specific search query using `web_search` or `google_search`. Prefix with `wikipedia:`, `github:`, `arxiv:`, or `hn:` to target specific sources.
3. After receiving search results, summarize what each result reveals. Use `read_webpage` on the 1-2 most relevant URLs to get full page content for deeper analysis.
4. Use a different, more specific query for any follow-up search. Ground all claims in what was actually retrieved. Do not invent or assume contents of pages without reading them.
