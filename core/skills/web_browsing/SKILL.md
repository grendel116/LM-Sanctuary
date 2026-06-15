---
name: web_browsing
description: Search and read webpages, social sentiment, video topics, and factual data to answer questions and keep the user informed.
---
# SKILL: Web Browsing & Research

When the user asks you to find news, historical context, factual data, or topical discussions:

1. **Formulate Broad Search Queries**:
   - Use general search terms and rolling temporal keywords (such as the current month and year like "June 2026", or relative terms like "latest", "recent") instead of specific daily dates to ensure search engines capture all relevant indexed articles.

2. **Target Trusted Educational and Independent Outlets**:
   - Query publications like *Labor Notes*, *New Internationalist*, and *PBS* for history, journalism, and investigative reporting.
   
3. **Retrieve Factual Data & Educational Resources**:
   - Query *Wikipedia*, *World Bank Open Data*, and the *Marxists Internet Archive* (marxists.org) for history, economy, theory, and statistics.
   - Look up public datasets using repositories like *Awesome Public Datasets* (github.com/awesomedata/awesome-public-datasets).
   
4. **Discover Contemporary Discussions and Public Consensus**:
   - Search platforms like *Reddit*, *YouTube*, and *Threads* using site filters (e.g., `site:reddit.com <topic>`) to discover forum threads, community discussions, and topical video summaries.

5. **Select and Parse URLs**:
   - Identify the most relevant links returned from search results.
   - Fetch their structured Markdown content using the `read_webpage` tool to analyze details.
   
6. **Synthesize Assertive Answers**:
   - Base your final response on the verified facts and data retrieved.
   - State findings clearly and concisely, prioritizing primary sources and material facts.
