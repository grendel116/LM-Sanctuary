---
name: web_browsing
title: Web Research & Direct Sanctuary Browser Control
description: Search and read the web via your Cloud /v1 endpoint or local fallback, or inspect and interact directly with live tabs in Sanctuary Browser.
summary: "Search the web via [web_search(query=\"...\")], read URLs via [read_webpage(url=\"...\")], or inspect and control the live Sanctuary Browser via [browser_action(action=\"snapshot|read|open|click|type|press|scroll|back|forward|list_tabs\", ...)]"
retrieval: vector
triggers: search, look up, browse, browser, tab, tabs, open link, click, type, scroll, snapshot, screen, current page, open page, ecosia, news, find information, google, website, webpage, web page, page, site, docs, documentation, read page, check page, article, wikipedia, github, arxiv, http, https, url, link, urls, links, www.
---
# SKILL: Web Research & Sanctuary Browser Control
1. **Sanctuary Browser (`browser_action`)** — use for open tabs, JS-rendered/authenticated pages, or interactive UI:
   - Inspect: `[browser_action(action="list_tabs")]`, `[browser_action(action="snapshot")]` (returns `[eN]` refs), `[browser_action(action="read")]`.
   - Navigate: `[browser_action(action="open", url="https://...", split=False, new_tab=False)]`, `action="back|forward|scroll"`.
   - Interact (run `snapshot` first): `[browser_action(action="click|type|select|press", ref="eN", text="...", key="Enter", clear=True)]`. Never bypass CAPTCHAs—ask the user to complete them in the pane.
2. **Background Web Research (`web_search` & `read_webpage`)**:
   - `[web_search(query="...")]` (supports `wikipedia:`, `github:`, `arxiv:`, `hn:`, `music:` prefixes) and `[read_webpage(url="...")]` for clean Markdown. Ground all claims strictly in retrieved text.
