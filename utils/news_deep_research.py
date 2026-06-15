import os
import sys
import re
import json
import datetime
import argparse
from google import genai
from google.genai import types

# Add project root to sys.path so we can import project files
project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if project_root not in sys.path:
    sys.path.insert(0, project_root)

from variables import DEFAULT_GEMINI_MODEL
import tools

def parse_args():
    parser = argparse.ArgumentParser(description="Faithful replication of the Gemini Deep Research Agent for Working-Class & Labor News.")
    parser.add_argument(
        "prompt",
        nargs="?",
        default="Research the most prominent labor union strikes, indigenous land defense actions, and working-class resistance movements globally in the past month.",
        help="The research query or topic."
    )
    parser.add_argument(
        "--model",
        default=os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL),
        help="Gemini model to use."
    )
    parser.add_argument(
        "--max-depth",
        type=int,
        default=3,
        help="Maximum depth levels for search refinement."
    )
    parser.add_argument(
        "--target-sources",
        type=int,
        default=6,
        help="Target number of distinct sources to crawl and cite (normally 5 to 7)."
    )
    return parser.parse_args()

def main():
    args = parse_args()
    
    # Load .env if it exists in project root
    env_path = os.path.join(project_root, ".env")
    if os.path.exists(env_path):
        with open(env_path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, val = line.split("=", 1)
                    os.environ[key.strip()] = val.strip().strip('"').strip("'")
                    
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        print("ERROR: GEMINI_API_KEY environment variable is not set. Please set it in your environment or .env file.")
        sys.exit(1)
        
    client = genai.Client(api_key=api_key)
    
    print("="*60)
    print(f"STARTING NEWS DEEP RESEARCH AGENT")
    print(f"Topic: {args.prompt}")
    print(f"Model: {args.model}")
    print(f"Max Depth: {args.max_depth} | Target Sources: {args.target_sources}")
    print("="*60)
    
    # -------------------------------------------------------------
    # PHASE 1: PLANNING PHASE
    # -------------------------------------------------------------
    print("\n[PHASE 1] Generating research plan...")
    planning_prompt = (
        "You are an expert working-class news researcher. Your goal is to construct a research plan to investigate: "
        f"\"{args.prompt}\".\n\n"
        "Generate a list of 3 to 5 highly targeted web search queries that will help gather information. "
        "Prioritize finding concrete material facts about labor struggles, strikes, indigenous land defense, and anti-capitalist actions. "
        "Focus on class-conscious and independent outlets (e.g. Labor Notes, Peoples Dispatch, Red Media).\n\n"
        "Return the output as a valid JSON list of search query strings. Do not include any markdown formatting, just the raw JSON array."
    )
    
    try:
        response = client.models.generate_content(
            model=args.model,
            contents=planning_prompt,
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
            )
        )
        initial_queries = json.loads(response.text.strip())
        if not isinstance(initial_queries, list):
            raise ValueError("Response is not a list")
    except Exception as e:
        print(f"Failed to generate structured planning queries: {e}. Using fallback queries.")
        initial_queries = [
            "latest labor union strikes 2026",
            "indigenous land defense resistance 2026",
            "working class anti-capitalist protests recent"
        ]
        
    print("\nInitial Research Queries:")
    for idx, q in enumerate(initial_queries):
        print(f"  {idx+1}. {q}")
        
    # -------------------------------------------------------------
    # PHASE 2: ITERATIVE SEARCH & REFINEMENT LOOP
    # -------------------------------------------------------------
    sources_discovered = set()
    sources_crawled = {}  # URL -> cleaned text
    current_queries = initial_queries
    
    for depth in range(1, args.max_depth + 1):
        print(f"\n[PHASE 2] Starting Search Depth {depth} of {args.max_depth}...")
        
        # 1. Run Search Queries
        depth_discovered_urls = []
        for query in current_queries:
            print(f"  Searching: \"{query}\"...")
            try:
                results_str = tools.web_search(query)
                urls = re.findall(r'URL:\s*(https?://[^\s>)]+)', results_str)
                for u in urls:
                    clean_u = u.strip().rstrip('/')
                    if clean_u not in sources_discovered and clean_u not in sources_crawled:
                        sources_discovered.add(clean_u)
                        depth_discovered_urls.append(clean_u)
            except Exception as e:
                print(f"    Search error: {e}")
                
        print(f"  Discovered {len(depth_discovered_urls)} new candidate URLs at this depth.")
        
        # 2. Select the best unvisited URLs to crawl
        # We target independent labor/left/indigenous outlets or wikipedia where appropriate
        target_outlets = ["labor", "strike", "union", "peoplesdispatch", "indigenous", "ienearth", "redmedia", "wikipedia", "pbs", "notes"]
        
        def rank_url(url):
            url_lower = url.lower()
            score = 0
            for keyword in target_outlets:
                if keyword in url_lower:
                    score += 10
            # Prioritize clean article-like URLs
            if "index" in url_lower or "search" in url_lower or "tag" in url_lower:
                score -= 5
            return score
            
        unvisited = [u for u in depth_discovered_urls if u not in sources_crawled]
        unvisited.sort(key=rank_url, reverse=True)
        
        # Determine how many to crawl at this depth (crawl up to 3-4 new sources to gather data)
        to_crawl = unvisited[:4]
        
        if not to_crawl:
            print("  No new candidate URLs found to crawl. Ending search early.")
            break
            
        print(f"  Selected URLs to crawl at Depth {depth}:")
        for u in to_crawl:
            print(f"    - {u}")
            
        # 3. Crawl pages and extract markdown text
        for url in to_crawl:
            print(f"  Crawling: {url}...")
            try:
                content = tools.read_webpage(url)
                if content and len(content.strip()) > 200:
                    sources_crawled[url] = content.strip()
                else:
                    print(f"    Warning: Retrieved content from {url} was empty or too short.")
            except Exception as e:
                print(f"    Crawl error for {url}: {e}")
                
        print(f"  Total unique sources successfully crawled: {len(sources_crawled)}")
        
        # Check if we have gathered enough sources and can break early
        if len(sources_crawled) >= args.target_sources and depth >= args.max_depth:
            print(f"  Target source count ({args.target_sources}) reached. Proceeding to report synthesis.")
            break
            
        # 4. Let the LLM "think" and refine search queries for the next depth level
        print("\n  Analyzing gathered facts and refining search...")
        sources_summary = ""
        for idx, (url, txt) in enumerate(sources_crawled.items()):
            # Truncate text preview for reasoning prompt
            preview = txt[:800] + "..." if len(txt) > 800 else txt
            sources_summary += f"[{idx+1}] URL: {url}\nContent Excerpt:\n{preview}\n\n"
            
        refinement_prompt = (
            f"You are the reasoning core of a Deep Research Agent. We are researching: \"{args.prompt}\".\n\n"
            f"Current unique sources crawled: {len(sources_crawled)} (target is {args.target_sources} distinct sources).\n"
            f"Here is what we have gathered so far:\n{sources_summary}\n\n"
            "Analyze the findings. Outline your thoughts on what key facts, entities, strikes, indigenous struggles, or regions are still missing or require further verification.\n"
            "Generate 2 to 3 follow-up search queries to resolve these gaps. Target finding new, unvisited sources to reach the 5-7 source requirement.\n\n"
            "Return a JSON object with two fields:\n"
            "- \"thoughts\": Your text analysis of findings and gaps.\n"
            "- \"queries\": A list of 2-3 follow-up search queries.\n\n"
            "If you have enough information and at least 5-7 unique sources to cite, output an empty query list to finish early."
        )
        
        try:
            response = client.models.generate_content(
                model=args.model,
                contents=refinement_prompt,
                config=types.GenerateContentConfig(
                    temperature=0.3,
                    response_mime_type="application/json",
                )
            )
            refinement_data = json.loads(response.text.strip())
            
            thoughts = refinement_data.get("thoughts", "")
            current_queries = refinement_data.get("queries", [])
            
            print(f"\n  Agent's Thoughts at Depth {depth}:\n{thoughts}\n")
            
            if not current_queries:
                print("  Agent decided research is complete. Proceeding to synthesis.")
                break
                
            print("  Follow-up queries generated for next depth level:")
            for idx, q in enumerate(current_queries):
                print(f"    {idx+1}. {q}")
                
        except Exception as e:
            print(f"  Failed to parse refinement reasoning: {e}. Proceeding with default next steps.")
            # If refinement fails, create queries based on prompt
            current_queries = [f"{args.prompt} news sources"]
            
    # -------------------------------------------------------------
    # PHASE 3: REPORT SYNTHESIS PHASE
    # -------------------------------------------------------------
    print("\n" + "="*60)
    print("[PHASE 3] Synthesizing final news report...")
    print("="*60)
    
    full_sources_text = ""
    for idx, (url, txt) in enumerate(sources_crawled.items()):
        # Pass a larger chunk of each source to synthesis (limit to ~4k chars per source to fit context safely)
        trimmed = txt[:4000] + "\n[TRUNCATED...]" if len(txt) > 4000 else txt
        full_sources_text += f"=== SOURCE [{idx+1}]: {url} ===\n{trimmed}\n\n"
        
    synthesis_prompt = (
        "You are an expert working-class news compiler and investigative journalist. "
        f"Synthesize the following gathered articles, facts, and documents into a comprehensive, detailed news report on: \"{args.prompt}\".\n\n"
        "Requirements:\n"
        "1. Prioritize material conditions: specific union locals, strike counts, employee numbers, indigenous organizations, locations, corporate/state targets, and explicit demands.\n"
        "2. Frame the synthesis in terms of working-class solidarity, indigenous sovereignty, and class struggle. Avoid corporate euphemisms or market-centric framing.\n"
        "3. Cite at least 5 to 7 distinct sources clearly with their URLs at the end of the report under a '# References' section.\n"
        "4. Structure the report cleanly with Markdown headers (e.g. # Overview, # Labor News & Strikes, # Indigenous struggles, # References).\n\n"
        f"GATHERED SOURCES DATA:\n{full_sources_text}\n\n"
        "REPORT:"
    )
    
    try:
        response = client.models.generate_content(
            model=args.model,
            contents=synthesis_prompt,
            config=types.GenerateContentConfig(
                temperature=0.3
            )
        )
        report_markdown = response.text.strip()
    except Exception as e:
        print(f"Error synthesizing report: {e}")
        sys.exit(1)
        
    # Save the report to reports/news_report_YYYY-MM-DD.md
    reports_dir = os.path.join(project_root, "reports")
    os.makedirs(reports_dir, exist_ok=True)
    
    today_str = datetime.date.today().strftime("%Y-%m-%d")
    report_filename = f"news_report_{today_str}.md"
    report_path = os.path.join(reports_dir, report_filename)
    
    with open(report_path, "w", encoding="utf-8") as f:
        f.write(report_markdown)
        
    print(f"\n[SUCCESS] Deep Research Report saved to: {report_path}\n")
    print("="*60)
    print("FINAL REPORT:")
    print("="*60)
    print(report_markdown)
    print("="*60)

if __name__ == "__main__":
    main()
