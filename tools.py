import os
import subprocess
import requests

import time
import uuid
import concurrent.futures

from variables import COMFYUI_SERVER_URL, COMFYUI_CHECKPOINT, COMFYUI_VAE, DEFAULT_REMOTE_MODEL, VARIABLES_DIR

_search_executor = concurrent.futures.ThreadPoolExecutor(max_workers=8)
import functools
import threading
import contextvars

active_running_tools = {}
_active_tools_lock = threading.Lock()

current_session_id = contextvars.ContextVar('current_session_id', default='default')
session_tool_calls = {}
session_tool_calls_lock = threading.Lock()

def track_tool_activity(func):
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        sess_id = current_session_id.get()
        call_id = f"call_{int(time.time()*1000)}_{uuid.uuid4().hex[:4]}"
        
        # Build argument representation for display
        args_rep = []
        if args:
            args_rep.extend([repr(x) for x in args])
        if kwargs:
            args_rep.extend([f"{k}={repr(v)}" for k, v in kwargs.items()])
        args_str = ", ".join(args_rep)
        
        tool_call_info = {
            'id': call_id,
            'name': func.__name__,
            'args': args_str,
            'status': 'running',
            'response': '',
            'start_time': time.time(),
            'duration': 0.0
        }
        
        with session_tool_calls_lock:
            if sess_id not in session_tool_calls:
                session_tool_calls[sess_id] = []
            session_tool_calls[sess_id].append(tool_call_info)

        with _active_tools_lock:
            active_running_tools[func.__name__] = active_running_tools.get(func.__name__, 0) + 1
            
        start_time = time.time()
        try:
            res = func(*args, **kwargs)
            duration = round(time.time() - start_time, 2)
            with session_tool_calls_lock:
                if sess_id in session_tool_calls:
                    for tc in session_tool_calls[sess_id]:
                        if tc['id'] == call_id:
                            tc['status'] = 'completed'
                            tc['response'] = str(res)[:1000]
                            tc['duration'] = duration
            return res
        except Exception as e:
            duration = round(time.time() - start_time, 2)
            with session_tool_calls_lock:
                if sess_id in session_tool_calls:
                    for tc in session_tool_calls[sess_id]:
                        if tc['id'] == call_id:
                            tc['status'] = 'failed'
                            tc['response'] = f"Error: {e}"
                            tc['duration'] = duration
            raise
        finally:
            with _active_tools_lock:
                if func.__name__ in active_running_tools:
                    active_running_tools[func.__name__] -= 1
                    if active_running_tools[func.__name__] <= 0:
                        active_running_tools.pop(func.__name__, None)
    return wrapper

def get_project_folders() -> list:
    try:
        from utils.program import get_active_program
        active_prog = get_active_program()
    except Exception:
        active_prog = "sebile"
    default_folder = os.path.normpath(os.path.join(os.getcwd(), 'core', 'programs', active_prog))
    
    folders = [default_folder]
    try:
        import json
        settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
            loaded_folders = settings.get("folders", [])
            if loaded_folders:
                # Update first folder dynamically if it's the old workspace root or a program folder
                first_folder = os.path.normpath(loaded_folders[0])
                cwd = os.path.normpath(os.getcwd())
                is_old_program_dir = ("core" in first_folder and "programs" in first_folder) or first_folder == cwd
                if is_old_program_dir and first_folder != default_folder:
                    loaded_folders[0] = default_folder
                folders = loaded_folders
    except Exception:
        pass
    return folders

def resolve_workspace_path(path: str) -> str:
    normalized = os.path.normpath(path)
    if os.path.isabs(normalized):
        return normalized
        
    folders = get_project_folders()
    for folder in folders:
        candidate = os.path.normpath(os.path.join(folder, path))
        if os.path.exists(candidate):
            return candidate
            
    return os.path.normpath(os.path.join(folders[0], path))

# Global memory dict to hold tool confirmation states for mobile/web human-in-the-loop approvals
pending_tool_calls = {}

def confirm_tool_execution(tool_name: str, details: str) -> bool:
    try:
        import json
        settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
            if settings.get("security_preset") in ("auto", "turbo"):
                print(f"[AUTO MODE] Auto-approving tool execution for '{tool_name}'", flush=True)
                return True
    except Exception as e:
        print(f"Error checking security preset in confirm_tool_execution: {e}")

    print(f"[DEBUG CONFIRM] confirm_tool_execution called for '{tool_name}' with details:\n{details}", flush=True)
    call_id = str(uuid.uuid4())
    event = threading.Event()
    pending_tool_calls[call_id] = {
        'tool_name': tool_name,
        'details': details,
        'status': 'pending',
        'event': event
    }
    
    timeout = 90.0  # Allow up to 90 seconds for confirmation
    event.wait(timeout)
    
    info = pending_tool_calls.get(call_id)
    if info:
        status = info.get('status')
        if call_id in pending_tool_calls:
            del pending_tool_calls[call_id]
        if status == 'approved':
            return True
        elif status == 'denied':
            return False
            
    if call_id in pending_tool_calls:
        del pending_tool_calls[call_id]
    return False
# ==============================================================================
# WEB BROWSING & RESEARCH TOOLS
# ==============================================================================

@track_tool_activity
def read_webpage(url: str) -> str:
    """Fetches and extracts the readable text content of a specific webpage URL as structured Markdown.
    Use this when the user shares a URL/link in the chat and asks you to read, review, or analyze it.

    Args:
        url: The web address (HTTP/HTTPS URL) to fetch and read.

    Returns:
        The extracted clean Markdown content of the webpage, or an error message.
    """
    import requests
    from bs4 import BeautifulSoup
    import urllib3
    from markdownify import markdownify as md
    import re
    
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    if not url.startswith(("http://", "https://")):
        return "Error: Invalid URL. The URL must start with http:// or https://"

    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
    }

    try:
        response = requests.get(url, headers=headers, timeout=15, verify=False)
        if response.status_code != 200:
            return f"Error: Failed to fetch webpage. HTTP status code: {response.status_code}"

        encoding = response.encoding if response.encoding else 'utf-8'
        html_content = response.content.decode(encoding, errors='replace')

        soup = BeautifulSoup(html_content, 'html.parser')

        for element in soup(["script", "style", "nav", "header", "footer", "meta", "noscript", "svg", "iframe", "form", "aside"]):
            element.decompose()

        content_area = soup.find("main") or soup.find("article") or soup.find("body") or soup

        markdown_text = md(
            str(content_area),
            heading_style="ATX",
            bullets="-"
        )

        markdown_text = re.sub(r'\n{3,}', '\n\n', markdown_text).strip()

        limit = 12000
        if len(markdown_text) > limit:
            return markdown_text[:limit] + f"\n\n... [Content truncated, total length: {len(markdown_text)} characters] ..."

        if not markdown_text.strip():
            return "Error: Webpage loaded, but no readable content could be extracted."

        return markdown_text

    except requests.exceptions.Timeout:
        return "Error: Connection timed out while attempting to load the webpage."
    except Exception as e:
        return f"Error loading webpage: {e}"


def query_searxng(query: str, base_url: str = None, engines: str = "baidu,yandex,bing") -> list:
    import requests
    public_instances = [
        "https://searx.be",
        "https://searxng.site",
        "https://priv.au",
        "https://search.ononoki.org",
        "https://search.demolite.org",
        "https://searx.work"
    ]
    urls = [base_url] if base_url else public_instances
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    
    tried_count = 0
    for url in urls:
        if not url:
            continue
        if tried_count >= 3:
            break
        url = url.rstrip('/')
        tried_count += 1
        try:
            params = {
                "q": query,
                "format": "json",
                "engines": engines
            }
            response = requests.get(f"{url}/search", params=params, headers=headers, timeout=2.5)
            if response.status_code == 200:
                data = response.json()
                results = data.get("results", [])
                if results:
                    parsed_results = []
                    for r in results[:6]:
                        title = r.get("title", "Web Result")
                        link = r.get("url", "")
                        content = r.get("content", "")
                        if link:
                            parsed_results.append({
                                "title": title,
                                "url": link,
                                "content": content
                            })
                    if parsed_results:
                        return parsed_results
        except Exception as e:
            print(f"[SearXNG] Failed to query instance {url}: {e}")
            continue
            
    return []



@track_tool_activity
def web_search(query: str) -> str:
    """Searches the web and returns raw hits containing titles, links, and snippets.
    Supports routing via prefix queries (e.g. 'github: query', 'arxiv: query', 'hn: query')
    or concurrent hybrid web blending for standard queries.

    Args:
        query: The search query.

    Returns:
        A formatted string of matching pages with titles, URLs, and snippets.
    """
    import os
    import json
    import requests
    import concurrent.futures
    import time
    
    # Read project settings
    search_engine = "web_crawling"
    searxng_url = ""
    try:
        settings_path = os.path.join(VARIABLES_DIR, "project_settings.json")
        if os.path.exists(settings_path):
            with open(settings_path, "r", encoding="utf-8") as f:
                settings = json.load(f)
            search_engine = settings.get("search_engine", "web_crawling")
            searxng_url = settings.get("searxng_url", "")
    except Exception as e:
        print(f"Error loading search settings: {e}")

    # Map older values to web_crawling
    if search_engine in ("sovereign_hybrid", "sovereign_search", "searxng", "google_grounding"):
        search_engine = "web_crawling"

    def run_google(q):
        remote_api_key = os.getenv("REMOTE_API_KEY")
        if not remote_api_key:
            return []
        try:
            from google import genai
            from google.genai import types
            
            client = genai.Client(api_key=remote_api_key)
            grounding_tool = types.Tool(
                google_search=types.GoogleSearch()
            )
            config = types.GenerateContentConfig(
                tools=[grounding_tool],
                temperature=0.0
            )
            
            response = client.models.generate_content(
                model=DEFAULT_REMOTE_MODEL,
                contents=f"Perform a search for: {q}. Output only a list of search hits with their titles, URLs, and very brief snippets.",
                config=config
            )
            
            g_results = []
            
            # Parse text response first for clean, original URLs and rich snippets
            if response.text:
                import re
                lines = response.text.split('\n')
                i = 0
                while i < len(lines):
                    line = lines[i].strip()
                    match = re.search(r'\*\*([^*]+)\*\*$', line) or re.search(r'\*\*([^*]+)\*\*', line)
                    if match:
                        title = match.group(1).strip()
                        url = ""
                        snippet_lines = []
                        j = i + 1
                        url_found = False
                        while j < min(i + 4, len(lines)):
                            next_line = lines[j].strip()
                            url_match = re.search(r'https?://[^\s)\]]+', next_line)
                            if url_match and not url_found:
                                url = url_match.group(0).strip()
                                url_found = True
                            elif next_line and not next_line.startswith(('*', '-', '+', '#')):
                                snippet_lines.append(next_line)
                            j += 1
                        if url:
                            content = " ".join(snippet_lines).strip()
                            g_results.append({
                                "title": title,
                                "url": url,
                                "content": content or title,
                                "source": "Google"
                            })
                            i = j - 1
                    i += 1
                    
            # Fall back to metadata chunks if text parsing was empty
            if not g_results:
                metadata = response.candidates[0].grounding_metadata if (response.candidates and response.candidates[0]) else None
                if metadata and hasattr(metadata, 'grounding_chunks') and metadata.grounding_chunks:
                    for chunk in metadata.grounding_chunks:
                        web = getattr(chunk, 'web', None)
                        if web and web.uri:
                            title = web.title or "Web Result"
                            g_results.append({
                                "title": title,
                                "url": web.uri,
                                "content": title,
                                "source": "Google"
                            })
            # Resolve Google search redirects concurrently to find clean target URLs
            if g_results:
                def resolve_url(item):
                    url = item["url"]
                    if "vertexaisearch.cloud.google.com/grounding-api-redirect" in url:
                        try:
                            headers = {
                                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
                            }
                            # Attempt HEAD request first
                            r = requests.head(url, headers=headers, allow_redirects=True, timeout=2.0)
                            if r.status_code < 400 and r.url:
                                item["url"] = r.url
                                return
                            # Fallback to GET stream
                            r = requests.get(url, headers=headers, allow_redirects=True, stream=True, timeout=2.0)
                            if r.url:
                                item["url"] = r.url
                        except Exception:
                            pass
                
                with concurrent.futures.ThreadPoolExecutor(max_workers=len(g_results)) as executor:
                    executor.map(resolve_url, g_results)

            return g_results
        except Exception as e:
            print(f"[Google Grounding] Error: {e}")
            return []

    def run_searxng(q):
        try:
            hits = query_searxng(q, base_url=searxng_url, engines="baidu,yandex,bing")
            if not hits:
                hits = query_searxng(q, base_url=searxng_url)
            return [{
                "title": h["title"],
                "url": h["url"],
                "content": h["content"],
                "source": "SearXNG"
            } for h in hits]
        except Exception as e:
            print(f"[SearXNG] Error: {e}")
            return []

    def run_baidu(q):
        try:
            hits = query_searxng(q, base_url=searxng_url, engines="baidu")
            return [{
                "title": h["title"],
                "url": h["url"],
                "content": h["content"],
                "source": "Baidu"
            } for h in hits]
        except Exception as e:
            print(f"[Baidu SearXNG] Error: {e}")
            return []

    def run_wikipedia(q):
        try:
            url = "https://en.wikipedia.org/w/api.php"
            headers = {
                "User-Agent": "ProgramSanctuary/1.0"
            }
            params = {
                "action": "query",
                "list": "search",
                "srsearch": q,
                "format": "json",
                "utf8": 1
            }
            response = requests.get(url, headers=headers, params=params, timeout=4)
            if response.status_code == 200:
                hits = response.json().get("query", {}).get("search", [])
                w_results = []
                for hit in hits[:5]:
                    title = hit.get("title")
                    snippet = hit.get("snippet", "").replace('<span class="searchmatch">', '').replace('</span>', '')
                    link = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"
                    w_results.append({
                        "title": title,
                        "url": link,
                        "content": snippet + "...",
                        "source": "Wikipedia"
                    })
                return w_results
        except Exception as e:
            print(f"[Wikipedia] Error: {e}")
        return []

    def run_github(q):
        try:
            url = "https://api.github.com/search/repositories"
            params = {
                "q": q,
                "sort": "stars",
                "order": "desc",
                "per_page": 5
            }
            headers = {
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "ProgramSanctuary/1.0"
            }
            res = requests.get(url, params=params, headers=headers, timeout=5)
            if res.status_code == 200:
                items = res.json().get("items", [])
                results = []
                for repo in items:
                    name = repo.get("full_name", "")
                    stars = repo.get("stargazers_count", 0)
                    forks = repo.get("forks_count", 0)
                    desc = repo.get("description", "") or "No description."
                    link = repo.get("html_url", "")
                    results.append({
                        "title": name,
                        "url": link,
                        "content": f"Stars: {stars}, Forks: {forks} | Description: {desc}",
                        "source": "GitHub"
                    })
                return results
        except Exception as e:
            print(f"[GitHub] Error: {e}")
        return []

    def run_arxiv(q):
        import re
        import xml.etree.ElementTree as ET
        try:
            search_words = re.findall(r'\w+', q)
            if not search_words:
                return []
            arxiv_query = " AND ".join(f"all:{word}" for word in search_words)
            url = "http://export.arxiv.org/api/query"
            params = {
                "search_query": arxiv_query,
                "max_results": 5,
                "sortBy": "lastUpdatedDate",
                "sortOrder": "descending"
            }
            res = requests.get(url, params=params, timeout=5)
            if res.status_code == 200:
                ns = {'atom': 'http://www.w3.org/2005/Atom'}
                root = ET.fromstring(res.text)
                entries = root.findall('atom:entry', ns)
                results = []
                for entry in entries:
                    title = entry.find('atom:title', ns).text.strip().replace("\n", " ")
                    published = entry.find('atom:published', ns).text[:10]
                    summary = entry.find('atom:summary', ns).text.strip().replace("\n", " ")
                    if len(summary) > 250:
                        summary = summary[:247] + "..."
                    link = entry.find('atom:id', ns).text
                    results.append({
                        "title": title,
                        "url": link,
                        "content": f"Published: {published} | Abstract: {summary}",
                        "source": "arXiv"
                    })
                return results
        except Exception as e:
            print(f"[arXiv] Error: {e}")
        return []

    def run_hackernews(q):
        try:
            thirty_days_ago = int(time.time()) - (30 * 24 * 60 * 60)
            url = "https://hn.algolia.com/api/v1/search"
            params = {
                "query": q,
                "tags": "story",
                "numericFilters": f"created_at_i>{thirty_days_ago}"
            }
            res = requests.get(url, params=params, timeout=5)
            if res.status_code == 200:
                hits = res.json().get("hits", [])
                results = []
                for hit in hits[:5]:
                    title = hit.get("title", "")
                    link = hit.get("url") or f"https://news.ycombinator.com/item?id={hit.get('objectID')}"
                    points = hit.get("points", 0)
                    comments = hit.get("num_comments", 0)
                    results.append({
                        "title": title,
                        "url": link,
                        "content": f"{points} points, {comments} comments",
                        "source": "Hacker News"
                    })
                return results
        except Exception as e:
            print(f"[Hacker News] Error: {e}")
        return []

    results_pool = []
    
    # Parse prefixes for explicit single-source routing
    query_lower = query.lower().strip()
    
    if query_lower.startswith("github:"):
        raw_query = query[len("github:"):].strip()
        results_pool = run_github(raw_query)
    elif query_lower.startswith("arxiv:"):
        raw_query = query[len("arxiv:"):].strip()
        results_pool = run_arxiv(raw_query)
    elif query_lower.startswith("hn:") or query_lower.startswith("hackernews:"):
        prefix_len = len("hn:") if query_lower.startswith("hn:") else len("hackernews:")
        raw_query = query[prefix_len:].strip()
        results_pool = run_hackernews(raw_query)
    else:
        # Standard hybrid concurrent search blending
        if search_engine == "web_crawling":
            futures = {
                _search_executor.submit(run_google, query): "Google",
                _search_executor.submit(run_searxng, query): "SearXNG",
                _search_executor.submit(run_baidu, query): "Baidu",
                _search_executor.submit(run_wikipedia, query): "Wikipedia"
            }

            done, not_done = concurrent.futures.wait(futures.keys(), timeout=15.0)
            
            for future in done:
                source_name = futures[future]
                try:
                    data_hits = future.result()
                    if data_hits:
                        results_pool.extend(data_hits)
                except Exception as e:
                    print(f"[{source_name}] Thread error: {e}")
                    
            for future in not_done:
                source_name = futures[future]
                print(f"[{source_name}] Thread timed out (exceeded 15.0s timeout limit).")
                        
            # Deduplicate results by URL (collapsing mobile/desktop variations)
            seen_urls = set()
            unique_results = []
            for r in results_pool:
                url_clean = r["url"].lower().strip().rstrip('/')
                compare_url = url_clean.replace("https://m.", "https://www.").replace("http://m.", "http://www.")
                if compare_url not in seen_urls:
                    seen_urls.add(compare_url)
                    unique_results.append(r)
                    
            # Fallback to Wikipedia if other sources failed or returned empty list
            if not unique_results:
                print("[Web Crawling] All primary sources empty or failed. Using Wikipedia.")
                wiki_results = run_wikipedia(query)
                for r in wiki_results:
                    url_clean = r["url"].lower().strip().rstrip('/')
                    compare_url = url_clean.replace("https://m.", "https://www.").replace("http://m.", "http://www.")
                    if compare_url not in seen_urls:
                        seen_urls.add(compare_url)
                        unique_results.append(r)
                        
            results_pool = unique_results
            
        elif search_engine == "wikipedia":
            results_pool = run_wikipedia(query)

    formatted = []
    for r in results_pool[:8]:
        formatted.append(f"Title: {r['title']}\nURL: {r['url']}\nSource: {r['source']}\nSnippet: {r['content']}")
    if formatted:
        return "\n\n".join(formatted)

    return "No search results found."


@track_tool_activity
def google_search(query: str) -> str:
    """Wrapper that delegates search queries to web_search."""
    return web_search(query)


@track_tool_activity
def read_file(path: str) -> str:
    """Reads the contents of a file at the specified path.

    Args:
        path: The file path to read (absolute or relative to current directory).

    Returns:
        The content of the file or an error message.
    """
    try:
        normalized_path = resolve_workspace_path(path)
        with open(normalized_path, "r", encoding="utf-8") as f:
            return f.read()
    except Exception as e:
        return f"Error reading file '{path}': {e}"

@track_tool_activity
def write_file(path: str, content: str) -> str:
    """Creates a new file or overwrites an existing file with the specified content.

    Args:
        path: The file path to write to.
        content: The text content to write.

    Returns:
        A success message or an error message.
    """
    try:
        if not confirm_tool_execution("write_file", f"Path: {path}\nContent Preview:\n{content[:500]}"):
            return "Error: Tool execution denied by user."
            
        normalized_path = resolve_workspace_path(path)
        parent_dir = os.path.dirname(normalized_path)
        if parent_dir and not os.path.exists(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)
            
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Successfully wrote to file '{path}'."
    except Exception as e:
        return f"Error writing to file '{path}': {e}"

@track_tool_activity
def replace_in_file(path: str, old_text: str, new_text: str) -> str:
    """Replaces occurrences of old_text with new_text in the specified file.

    Args:
        path: The file path to modify.
        old_text: The exact block of text to be replaced.
        new_text: The replacement text block.

    Returns:
        A success message or an error message.
    """
    try:
        if not confirm_tool_execution("replace_in_file", f"Path: {path}\n\nReplacing:\n{old_text[:300]}\n\nWith:\n{new_text[:300]}"):
            return "Error: Tool execution denied by user."
            
        normalized_path = resolve_workspace_path(path)
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist."
            
        with open(normalized_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        if old_text not in content:
            return f"Error: Could not find exact text match for replacement in '{path}'."
            
        updated_content = content.replace(old_text, new_text)
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.write(updated_content)
        return f"Successfully replaced content in '{path}'."
    except Exception as e:
        return f"Error modifying file '{path}': {e}"

@track_tool_activity
def run_shell_command(command: str) -> str:
    """Runs a shell command in the local workspace directory and returns its output.

    Ensure commands complete within 30 seconds. Use targeted listing and search commands
    instead of recursive directory operations (like 'dir /s', 'find .', or 'grep -r')
    to prevent timeout errors.

    Args:
        command: The shell command to run.

    Returns:
        The standard output and standard error from running the command.
    """
    try:
        if not confirm_tool_execution("run_shell_command", f"Command:\n{command}"):
            return "Error: Tool execution denied by user."
            
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30
        )
        output = f"Exit Code: {result.returncode}\n"
        if result.stdout:
            output += f"--- Standard Output ---\n{result.stdout}\n"
        if result.stderr:
            output += f"--- Standard Error ---\n{result.stderr}\n"
        return output
    except subprocess.TimeoutExpired:
        return "Error: Command execution timed out after 30 seconds."
    except Exception as e:
        return f"Error executing command: {e}"

@track_tool_activity
def get_workspace_structure() -> str:
    """Recursively lists all files and directories in all configured project folders,
    excluding virtual environments (.venv), caches (__pycache__), and git directories.
    Safeguarded with maximum depth and line limits for large workspace directories.

    Returns:
        A text representation of the workspace directory tree structure.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist"}
    
    folders = get_project_folders()
        
    lines = []
    max_lines = 300
    truncated = False
    
    def _build_tree(directory, prefix="", depth=0):
        nonlocal truncated
        if len(lines) >= max_lines:
            truncated = True
            return
            
        if depth > 3:
            return
            
        try:
            items = sorted(os.listdir(directory))
        except Exception:
            return
            
        for i, item in enumerate(items):
            if len(lines) >= max_lines:
                truncated = True
                break
                
            if item in exclude_dirs:
                continue
                
            path = os.path.join(directory, item)
            is_last = (i == len(items) - 1)
            connector = "└── " if is_last else "├── "
            
            lines.append(f"{prefix}{connector}{item}")
            
            if os.path.isdir(path):
                new_prefix = prefix + ("    " if is_last else "│   ")
                _build_tree(path, new_prefix, depth + 1)
                
    for folder in folders:
        if not os.path.exists(folder):
            continue
        if len(lines) >= max_lines:
            truncated = True
            break
        lines.append(f"Workspace Root: {folder}")
        _build_tree(folder, depth=0)
        lines.append("")
        
    if truncated:
        lines.append("... [Tree truncated: maximum list limit of 300 lines or depth level of 3 reached. Use search_codebase to locate specific files.]")
        
    return "\n".join(lines).strip()

@track_tool_activity
def search_codebase(keyword: str) -> str:
    """Performs a case-insensitive search for a keyword or pattern inside all text files
    in all configured workspace folders, returning the matching files, line numbers, and snippets.
    Safeguarded with a maximum match limit for large workspaces.

    Args:
        keyword: The text pattern or keyword to search for.

    Returns:
        A list of matching snippets grouped by file, or a 'no matches found' message.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist"}
    exclude_extensions = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".pyc", ".db", ".zip", ".tar", ".gz"}
    results = []
    max_files = 25
    truncated = False
    
    folders = get_project_folders()
        
    keyword_lower = keyword.lower()
    
    for folder in folders:
        if not os.path.exists(folder):
            continue
        if len(results) >= max_files:
            truncated = True
            break
            
        for root, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            if len(results) >= max_files:
                truncated = True
                break
                
            for file in files:
                if len(results) >= max_files:
                    truncated = True
                    break
                    
                ext = os.path.splitext(file)[1].lower()
                if ext in exclude_extensions:
                    continue
                    
                file_path = os.path.join(root, file)
                rel_path = os.path.relpath(file_path, folder)
                
                try:
                      with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                          lines = f.readlines()
                          
                      file_matches = []
                      for line_idx, line in enumerate(lines):
                          if keyword_lower in line.lower():
                              file_matches.append(f"  Line {line_idx + 1}: {line.strip()}")
                              
                      if file_matches:
                          results.append(f"File: [{os.path.basename(folder)}] {rel_path}\n" + "\n".join(file_matches[:10]))
                except Exception:
                      continue
                      
    if not results:
        return f"No matches found for keyword: '{keyword}'"
        
    output = "\n\n".join(results)
    if truncated:
        output += "\n\n... [Search results truncated: maximum limit of 25 matched files reached. Please refine your search keyword.]"
    return output

def get_comfy_checkpoints(comfy_url: str) -> list:
    try:
        response = requests.get(f"{comfy_url}/object_info", timeout=2.0)
        if response.status_code == 200:
            data = response.json()
            ckpt_loader = data.get("CheckpointLoaderSimple", {})
            ckpt_names = ckpt_loader.get("input", {}).get("required", {}).get("ckpt_name", [[]])[0]
            if isinstance(ckpt_names, list):
                return ckpt_names
    except Exception as e:
        print(f"[DEBUG] Failed to fetch checkpoints from ComfyUI: {e}", flush=True)
    return []

def get_comfy_vaes(comfy_url: str) -> list:
    try:
        response = requests.get(f"{comfy_url}/object_info", timeout=2.0)
        if response.status_code == 200:
            data = response.json()
            vae_loader = data.get("VAELoader", {})
            vae_names = vae_loader.get("input", {}).get("required", {}).get("vae_name", [[]])[0]
            if isinstance(vae_names, list):
                return vae_names
    except Exception as e:
        print(f"[DEBUG] Failed to fetch VAEs from ComfyUI: {e}", flush=True)
    return []

def format_comfy_validation_error(error_json: dict) -> str:
    try:
        details = error_json.get("error", {}).get("details", {})
        node_errors = details.get("node_errors", {})
        if not node_errors:
            return None
            
        messages = []
        for node_id, error_info in node_errors.items():
            class_type = error_info.get("class_type", "Node")
            errors = error_info.get("errors", [])
            for err in errors:
                err_msg = err.get("message", "")
                err_details = err.get("details", "")
                
                if "LoRA not found" in err_msg or class_type == "LoraLoader":
                    messages.append(
                        f"**Missing LoRA**: The required LoRA file `{err_details}` was not found.\n"
                        f"Please download it and place it in your `ComfyUI/models/loras/` directory."
                    )
                elif "Checkpoint not found" in err_msg or class_type == "CheckpointLoaderSimple":
                    messages.append(
                        f"**Missing Checkpoint**: The required model checkpoint `{err_details}` was not found.\n"
                        f"Please place it in your `ComfyUI/models/checkpoints/` directory, or update your `.env` configuration."
                    )
                elif "VAE not found" in err_msg or class_type == "VAELoader":
                    messages.append(
                        f"**Missing VAE**: The required VAE file `{err_details}` was not found.\n"
                        f"Please place it in your `ComfyUI/models/vae/` directory, or update your `.env` configuration."
                    )
                else:
                    messages.append(f"**Node Validation Error** (Node {node_id}, Type `{class_type}`): {err_msg}")
                    
        if messages:
            return "\n\n".join(messages)
    except Exception:
        pass
    return None


@track_tool_activity
def apply_comfy_workflow(workflow_path: str, parameters: dict, save_path: str) -> str:
    """Executes a specified ComfyUI workflow JSON template with custom parameter mappings and saves the output.

    Args:
        workflow_path: Path to the workflow JSON file.
        parameters: Dictionary of placeholder keys and their replacement values.
        save_path: Path where the generated image should be saved.

    Returns:
        The filesystem path of the saved image, or an error message.
    """
    import os
    import json
    import requests
    import time

    if not os.path.exists(workflow_path):
        return f"Error: Workflow template not found at '{workflow_path}'"

    try:
        with open(workflow_path, "r", encoding="utf-8") as f:
            workflow = json.load(f)
    except Exception as e:
        return f"Error reading workflow template: {e}"

    # Recursive replacement helper
    def replace_placeholders(obj):
        if isinstance(obj, dict):
            res_dict = {}
            for k, v in obj.items():
                if k == "appearance":
                    continue
                res_dict[k] = replace_placeholders(v)
            return res_dict
        elif isinstance(obj, list):
            return [replace_placeholders(x) for x in obj]
        elif isinstance(obj, str):
            for placeholder, val in parameters.items():
                if placeholder in obj:
                    if obj == placeholder:
                        return val
                    obj = obj.replace(placeholder, str(val))
            return obj
        return obj

    populated_workflow = replace_placeholders(workflow)
    comfy_url = COMFYUI_SERVER_URL

    try:
        res = requests.post(f"{comfy_url}/prompt", json={"prompt": populated_workflow}, timeout=5.0)
        if res.status_code != 200:
            try:
                err_data = res.json()
                formatted_err = format_comfy_validation_error(err_data)
                if formatted_err:
                    raise Exception(formatted_err)
            except Exception as e_inner:
                if "Missing" in str(e_inner):
                    raise e_inner
            raise Exception(f"ComfyUI server returned status code {res.status_code}")
        
        prompt_id = res.json().get("prompt_id")
        if not prompt_id:
            raise Exception("Did not receive a prompt ID from ComfyUI")

        # Poll history endpoint for output
        for _ in range(300):
            history_res = requests.get(f"{comfy_url}/history/{prompt_id}", timeout=10)
            if history_res.status_code == 200:
                history_data = history_res.json()
                if prompt_id in history_data:
                    outputs = history_data[prompt_id].get("outputs", {})
                    for node_id, node_output in outputs.items():
                        if "images" in node_output:
                            for img in node_output["images"]:
                                filename = img["filename"]
                                view_res = requests.get(f"{comfy_url}/view", params={
                                    "filename": filename,
                                    "subfolder": img.get("subfolder", ""),
                                    "type": img.get("type", "temp")
                                }, timeout=15)
                                
                                if view_res.status_code == 200:
                                    parent_dir = os.path.dirname(save_path)
                                    if parent_dir:
                                        os.makedirs(parent_dir, exist_ok=True)
                                    with open(save_path, "wb") as img_file:
                                        img_file.write(view_res.content)
                                    
                                    # Delete temp file from ComfyUI's temp folder to avoid accumulation
                                    try:
                                        from utils.comfy_manager import COMFYUI_DIR
                                        comfy_temp_file = os.path.normpath(os.path.join(COMFYUI_DIR, "temp", img.get("subfolder", ""), filename))
                                        if os.path.exists(comfy_temp_file):
                                            os.remove(comfy_temp_file)
                                            print(f"[COMFY IMAGE] Cleaned up temp output image: {comfy_temp_file}")
                                    except Exception as e_clean:
                                        print(f"[COMFY IMAGE] Warning: Failed to clean up temp file: {e_clean}")
                                        
                                    return save_path
                                else:
                                    raise Exception(f"Error downloading image: status {view_res.status_code}")
            time.sleep(1)
        raise Exception("Image generation timed out on ComfyUI server after 300 seconds.")
    except Exception as e:
        return f"Error executing ComfyUI workflow: {e}"


@track_tool_activity
def generate_local_image(prompt: str) -> str:
    """Generates a local image using ComfyUI with companion-specific workflow configurations.
    
    Args:
        prompt: A prompt describing what you are doing or the scene/expression.
        
    Returns:
        A markdown link to the generated portrait image, or an error message.
    """
    import os
    import random
    import time
    import json
    
    def get_install_instructions(reason: str) -> str:
        from utils.comfy_manager import check_comfy_running
        if check_comfy_running():
            return (
                "### ⚠️ Image Generation Failed (ComfyUI Execution Error)\n\n"
                "ComfyUI is online, but the image generation workflow encountered an error:\n"
                f"> **{reason}**\n\n"
                "Please verify that your models are compatible, check the ComfyUI server logs (`comfy_server.log`) for details, or try again."
            )
        if "Missing Checkpoint" in reason or "Missing LoRA" in reason or "Missing VAE" in reason:
            return (
                "### ⚠️ Image Generation Failed (Missing Assets)\n\n"
                f"{reason}\n\n"
                "To automatically download and configure the required assets, please use the **Connection Settings** modal:\n"
                "- Click the settings gear icon in the top header.\n"
                "- Click **Resolve Workflow Dependencies** under the Image Generation Environment section to download missing files.\n"
                "- Once the files are successfully downloaded, request another portrait!"
            )
        return (
            "**Image Generation Inactive (ComfyUI Offline/Not Installed)**\n\n"
            f"*(Reason: {reason})*\n\n"
            "To enable companion portrait generation, you can install, run, and resolve ComfyUI dependencies directly from the **Connection Settings** panel:\n\n"
            "- **Open Connection Settings**: Click the settings gear icon in the top header.\n"
            "- **Install ComfyUI**: If not already installed, click **Install Headless ComfyUI** under the Image Generation Environment section.\n"
            "- **Start the Server**: Click **Start ComfyUI Engine** to launch the server headlessly.\n"
            "- **Resolve Dependencies**: Click **Resolve Workflow Dependencies** to automatically download the required checkpoints, VAEs, and custom nodes.\n"
            "- **Request a Portrait**: Once the engine is online, ask the companion to generate a portrait!"
        )

    base_dir = os.path.dirname(os.path.abspath(__file__))
    from utils.program import get_active_program
    active_program = get_active_program()
    
    workflow_env_path = os.getenv("COMFYUI_IMAGE_WORKFLOW", "core/skills/portrait_generation/ImageWorkflow.json")
    workflow_path = os.path.normpath(os.path.join(base_dir, workflow_env_path))
    
    if not os.path.exists(workflow_path):
        return get_install_instructions(f"Workflow template not found at '{workflow_path}'")

    comfy_url = COMFYUI_SERVER_URL

    try:
        # Resolve checkpoint dynamically
        selected_checkpoint = COMFYUI_CHECKPOINT
        available_checkpoints = get_comfy_checkpoints(comfy_url)
        if available_checkpoints and selected_checkpoint not in available_checkpoints:
            raise Exception(f"Missing Checkpoint: The required model checkpoint `{selected_checkpoint}` was not found.")

        # Resolve VAE dynamically
        selected_vae = COMFYUI_VAE
        available_vaes = get_comfy_vaes(comfy_url)
        if available_vaes and selected_vae not in available_vaes:
            raise Exception(f"Missing VAE: The required VAE file `{selected_vae}` was not found.")

        # Load appearance, image details, and negative details from the active program's JSON profile
        appearance_val = ""
        img_details_val = ""
        neg_details_val = ""
        
        import json
        program_json_path = os.path.normpath(os.path.join(
            base_dir, "core", "programs", active_program, f"{active_program}.json"
        ))
        if os.path.exists(program_json_path):
            try:
                with open(program_json_path, "r", encoding="utf-8") as f:
                    prof_data = json.load(f)
                
                # Appearance from details
                desc = prof_data.get("description", {})
                desc_parts = []
                for k, v in desc.items():
                    if v:
                        desc_parts.append(f"{v} {k}")
                if desc_parts:
                    appearance_val = ", ".join(desc_parts)
                    
                # Image details section
                img_sec = prof_data.get("image details", {})
                img_details_val = img_sec.get("image details", "")
                neg_details_val = img_sec.get("negative details", "")
            except Exception as e:
                print(f"[DEBUG] Error reading active program JSON for image generation: {e}", flush=True)

        if not appearance_val:
            appearance_val = f"character named {active_program}"

        # Combine prompt and image details
        final_prompt = prompt
        if img_details_val:
            if final_prompt and not final_prompt.endswith(","):
                final_prompt += ", "
            final_prompt += img_details_val
            
        final_negative = neg_details_val if neg_details_val else "worst quality, low quality, deformed, mutated, extra limbs"

        # Define dynamic replacement parameters
        seed_val = random.randint(1, 1125899906842624)
        replacements = {
            "%prompt%": final_prompt,
            "%appearance%": appearance_val,
            "%negative_prompt%": final_negative,
            "%seed%": seed_val,
            "%steps%": 25,
            "%scale%": 7.0,
            "%sampler%": "euler",
            "%scheduler%": "normal",
            "%model%": selected_checkpoint,
            "%vae%": selected_vae,
            "%width%": 832,
            "%height%": 1216,
            "%denoise%": 0.55
        }

        timestamp = int(time.time())
        local_filename = f"portrait_{timestamp}.png"
        portraits_dir = os.path.normpath(os.path.join(base_dir, "core", "programs", active_program, "portraits"))
        local_path = os.path.join(portraits_dir, local_filename)

        result_path = apply_comfy_workflow(workflow_path, replacements, local_path)
        if result_path.startswith("Error"):
            raise Exception(result_path)

        # Save sidecar JSON
        json_path = os.path.join(portraits_dir, f"portrait_{timestamp}.json")
        try:
            with open(json_path, "w", encoding="utf-8") as jf:
                json.dump({"prompt": prompt}, jf, indent=4)
        except Exception as je:
            print(f"Error saving sidecar json: {je}")

        return f"![Portrait](/images/portraits/{local_filename})"
    except Exception as e:
        print(f"[INFO] ComfyUI generation failed or is offline: {e}.")
        return get_install_instructions(str(e))


@track_tool_activity
def generate_imagen(prompt: str, aspect_ratio: str = '1:1') -> str:
    """Generates a cloud image based on the prompt using Google's Imagen model.

    Args:
        prompt: A descriptive prompt detailing the scene or object.
        aspect_ratio: Aspect ratio for the image (default '1:1').

    Returns:
        A markdown link to the generated image, or an error message.
    """
    import os
    import time
    import uuid
    from google import genai
    from google.genai import types
    from dotenv import load_dotenv

    try:
        base_dir = os.path.dirname(os.path.abspath(__file__))
        load_dotenv(os.path.join(base_dir, ".env"))

        api_key = os.getenv("REMOTE_API_KEY")
        if not api_key:
            return "Error: REMOTE_API_KEY not found in environment."

        client = genai.Client(api_key=api_key)
        model_name = os.getenv("IMAGEN_MODEL", "imagen-4.0-generate-001")

        print(f"[IMAGEN] Generating image with model {model_name} and prompt: {prompt}")
        response = client.models.generate_images(
            model=model_name,
            prompt=prompt,
            config=types.GenerateImagesConfig(
                number_of_images=1,
                output_mime_type='image/png',
                aspect_ratio=aspect_ratio
            )
        )

        if not response.generated_images:
            return "Error: No images were generated."

        img_obj = response.generated_images[0]
        if not hasattr(img_obj.image, 'image_bytes'):
            return "Error: Generated image object does not contain image bytes."

        from utils.program import get_active_program
        active_program = get_active_program()
        media_dir = os.path.normpath(os.path.join(base_dir, "core", "programs", active_program, "media"))
        os.makedirs(media_dir, exist_ok=True)

        timestamp = int(time.time())
        local_filename = f"gen_img_{timestamp}_{uuid.uuid4().hex[:6]}.png"
        local_path = os.path.join(media_dir, local_filename)

        with open(local_path, "wb") as f:
            f.write(img_obj.image.image_bytes)

        return f"![Generated Image](/images/media/{local_filename})"

    except Exception as e:
        print(f"[IMAGEN] Error generating image: {e}")
        return f"Error generating image: {e}"


@track_tool_activity
def generate_video_from_image(image_path: str, prompt: str) -> str:
    """Animates a local image using ComfyUI with a custom video-specific workflow template.
    
    Args:
        image_path: Absolute path to the source static image.
        prompt: Prompt describing the animation/motion.
        
    Returns:
        Public web serving path/URL to the generated video, or raises an Exception.
    """
    import os
    import time
    import json
    import random
    import shutil
    import requests
    
    base_dir = os.path.dirname(os.path.abspath(__file__))
    from utils.program import get_active_program
    active_program = get_active_program()
    
    workflow_env_path = os.getenv("COMFYUI_VIDEO_WORKFLOW", "core/skills/portrait_generation/VideoWorkflow.json")
    workflow_path = os.path.normpath(os.path.join(base_dir, workflow_env_path))
    
    if not os.path.exists(workflow_path):
        raise Exception(f"Video workflow template not found at '{workflow_path}'")
        
    if not os.path.exists(image_path):
        raise Exception(f"Source image not found at '{image_path}'")
        
    # Copy and resize source image to ComfyUI's input directory using PIL
    from variables import COMFYUI_SERVER_URL
    from utils.comfy_manager import COMFYUI_DIR
    from PIL import Image
    comfy_input_dir = os.path.normpath(os.path.join(COMFYUI_DIR, "input"))
    os.makedirs(comfy_input_dir, exist_ok=True)
    
    # Generate unique filename to avoid collision in ComfyUI input directory
    source_filename = os.path.basename(image_path)
    timestamp = int(time.time())
    unique_input_filename = f"anim_in_{timestamp}_{source_filename}"
    comfy_input_path = os.path.join(comfy_input_dir, unique_input_filename)
    
    # Determine dimensions maintaining aspect ratio, maximum 768, rounded to multiples of 32
    with Image.open(image_path) as img:
        orig_w, orig_h = img.size
    
    max_dim = 768
    if orig_w > orig_h:
        new_w = max_dim
        new_h = int(orig_h * (max_dim / orig_w))
    else:
        new_h = max_dim
        new_w = int(orig_w * (max_dim / orig_h))
        
    # Align to nearest multiple of 32 (works universally for both SDXL/AnimateDiff and LTX 2.3/Hunyuan/Flux)
    new_w = max(32, (new_w // 32) * 32)
    new_h = max(32, (new_h // 32) * 32)
    
    print(f"[COMFY VIDEO] Resizing source image from {orig_w}x{orig_h} to {new_w}x{new_h} and saving to {comfy_input_path}")
    with Image.open(image_path) as img:
        resized_img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
        resized_img.save(comfy_input_path)
    
    # Define replacements for the workflow JSON
    seed_val = random.randint(1, 2147483647)
    replacements = {
        "%input_image%": unique_input_filename,
        "%prompt%": prompt,
        "%seed%": seed_val,
        "%width%": new_w,
        "%height%": new_h
    }
    
    # Load and populate workflow JSON
    with open(workflow_path, "r", encoding="utf-8") as f:
        workflow_data = json.load(f)
        
    def replace_val(obj):
        if isinstance(obj, dict):
            return {k: replace_val(v) for k, v in obj.items()}
        elif isinstance(obj, list):
            return [replace_val(x) for x in obj]
        elif isinstance(obj, str):
            has_placeholder = any(k in obj for k in replacements)
            for k, v in replacements.items():
                if k in obj:
                    obj = obj.replace(k, str(v))
            # Try to cast numeric placeholders only if it was a placeholder
            if has_placeholder:
                if obj.isdigit():
                    return int(obj)
                try:
                    return float(obj)
                except ValueError:
                    pass
            return obj
        return obj

    populated_workflow = replace_val(workflow_data)
    import json
    
    # Ensure ComfyUI server is running
    from utils.comfy_manager import check_comfy_running, start_comfy_server
    if not check_comfy_running(force_refresh=True):
        print("[COMFY VIDEO] ComfyUI server is offline. Starting ComfyUI server...")
        started, startup_msg = start_comfy_server()
        if not started:
            raise Exception(f"ComfyUI server is offline and failed to start: {startup_msg}")
            
    # Run dependency resolution inline to ensure missing custom nodes or models are downloaded/installed
    from utils.comfy_manager import _resolver_worker, resolution_status
    print("[COMFY VIDEO] Checking and resolving workflow dependencies inline...")
    _resolver_worker(json.dumps(populated_workflow))
    if resolution_status.get("status") == "failed":
        print(f"[COMFY VIDEO] Dependency resolution failed: {resolution_status.get('progress')}")
        raise Exception(f"Failed to resolve workflow dependencies: {resolution_status.get('progress')}")
    print("[COMFY VIDEO] Dependency resolution completed successfully.")
    
    # Wait for ComfyUI to come back online if it was restarted
    print("[COMFY VIDEO] Waiting for ComfyUI server to be responsive...")
    for _ in range(60): # up to 60 seconds
        if check_comfy_running(force_refresh=True):
            break
        time.sleep(1)
        
    print(f"[COMFY VIDEO] Populated workflow JSON:\n{json.dumps(populated_workflow, indent=2)}")
    
    comfy_url = COMFYUI_SERVER_URL
    print(f"[COMFY VIDEO] Submitting workflow to ComfyUI server: {comfy_url}")
    
    res = requests.post(f"{comfy_url}/prompt", json={"prompt": populated_workflow}, timeout=10.0)
    if res.status_code != 200:
        # Try to clean up input image
        try:
            os.remove(comfy_input_path)
        except Exception:
            pass
        print(f"[COMFY VIDEO] Validation error response (HTTP {res.status_code}): {res.text}")
        try:
            err_data = res.json()
            formatted_err = format_comfy_validation_error(err_data)
            if formatted_err:
                raise Exception(formatted_err)
        except Exception as e_inner:
            if "Missing" in str(e_inner) or "Validation Error" in str(e_inner):
                raise e_inner
        raise Exception(f"ComfyUI server prompt execution failed with status {res.status_code}")

        
    prompt_id = res.json().get("prompt_id")
    if not prompt_id:
        try:
            os.remove(comfy_input_path)
        except Exception:
            pass
        raise Exception("ComfyUI server did not return a prompt_id")
        
    # Poll for completion
    completed_filename = None
    output_key = None
    file_info = None
    start_time = time.time()
    try:
        # Give it up to 1800 seconds (30 minutes) for slow/high-res generations
        for _ in range(900):
            history_res = requests.get(f"{comfy_url}/history/{prompt_id}", timeout=10)
            if history_res.status_code == 200:
                history_data = history_res.json()
                if prompt_id in history_data:
                    prompt_info = history_data[prompt_id]
                    outputs = prompt_info.get("outputs", {})
                    
                    # 1. Try to find standard media in the outputs
                    for node_id, node_output in outputs.items():
                        for possible_key in ["images", "gifs", "videos"]:
                            if possible_key in node_output and node_output[possible_key]:
                                file_info = node_output[possible_key][0]
                                completed_filename = file_info["filename"]
                                output_key = possible_key
                                break
                        if completed_filename:
                            break
                            
                    # 2. If no output media found in outputs, scan ComfyUI temp folder for civitai videos
                    if not completed_filename:
                        from utils.comfy_manager import COMFYUI_DIR
                        temp_dir = os.path.normpath(os.path.join(COMFYUI_DIR, "temp"))
                        if os.path.exists(temp_dir):
                            newest_file = None
                            newest_time = 0
                            # Look for files matching civitai_*.mp4, civitai_*.webm, civitai_*.gif
                            for f_name in os.listdir(temp_dir):
                                if f_name.startswith("civitai_") and f_name.lower().endswith((".mp4", ".webm", ".gif")):
                                    f_path = os.path.join(temp_dir, f_name)
                                    mtime = os.path.getmtime(f_path)
                                    # Must be created after we started (with a buffer for clock drift)
                                    if mtime >= start_time - 10:
                                        if mtime > newest_time:
                                            newest_time = mtime
                                            newest_file = f_name
                            if newest_file:
                                completed_filename = newest_file
                                output_key = "videos"
                                file_info = {
                                    "filename": completed_filename,
                                    "subfolder": "",
                                    "type": "temp"
                                }
                                print(f"[COMFY VIDEO] Found newly generated Civitai temp video: {completed_filename}")
                                
                    if completed_filename:
                        break
                    else:
                        status_info = prompt_info.get("status", {})
                        status_str = status_info.get("status_str", "unknown")
                        raise Exception(f"ComfyUI prompt execution finished (status: {status_str}), but no output video file could be resolved.")
            time.sleep(2)
            
        if not completed_filename:
            raise Exception("Video generation timed out on ComfyUI server.")
            
        # Download the generated media file
        print(f"[COMFY VIDEO] Downloading generated file: {completed_filename} (type: {output_key})")
        view_res = requests.get(f"{comfy_url}/view", params={
            "filename": completed_filename,
            "subfolder": file_info.get("subfolder", ""),
            "type": file_info.get("type", "output")
        }, timeout=30)
        
        if view_res.status_code != 200:
            raise Exception(f"Failed to download generated file from ComfyUI: HTTP {view_res.status_code}")
            
        # Determine the correct file extension from the downloaded filename
        _, ext = os.path.splitext(completed_filename)
        if not ext:
            ext = ".mp4"  # Default fallback
            
        # Determine save path: next to the original portrait/image
        source_dir = os.path.dirname(image_path)
        source_base, _ = os.path.splitext(source_filename)
        output_filename = f"{source_base}{ext}"
        save_path = os.path.join(source_dir, output_filename)
        
        print(f"[COMFY VIDEO] Saving output video/animated media to {save_path}")
        with open(save_path, "wb") as out_file:
            out_file.write(view_res.content)
            
        # Delete temp file from ComfyUI's temp/output folder to avoid accumulation
        try:
            folder_type = file_info.get("type", "output")
            folder_name = "temp" if folder_type == "temp" else "output"
            comfy_temp_file = os.path.normpath(os.path.join(COMFYUI_DIR, folder_name, file_info.get("subfolder", ""), completed_filename))
            if os.path.exists(comfy_temp_file):
                os.remove(comfy_temp_file)
                print(f"[COMFY VIDEO] Cleaned up temp output video: {comfy_temp_file}")
        except Exception as e_clean:
            print(f"[COMFY VIDEO] Warning: Failed to clean up temp file: {e_clean}")
            
        # Get relative public path
        # E.g. core/programs/sebile/portraits/portrait_123.mp4 -> /images/portraits/portrait_123.mp4
        normalized_path = os.path.normpath(save_path)
        parts = normalized_path.split(os.sep)
        try:
            prog_idx = parts.index("programs")
            rel_parts = parts[prog_idx + 2:]
            url_path = "/images/" + "/".join(rel_parts)
        except ValueError:
            url_path = f"/images/portraits/{output_filename}"
            
        return url_path
        
    finally:
        # Clean up temporary input file from ComfyUI's input directory
        try:
            if os.path.exists(comfy_input_path):
                os.remove(comfy_input_path)
        except Exception as e:
            print(f"[COMFY VIDEO] Warning: Failed to delete temp input image {comfy_input_path}: {e}")


# ==============================================================================
# GENERALIST FILE AND BACKGROUND EXECUTION SYSTEM
# ==============================================================================

background_tasks = {}
tasks_lock = threading.Lock()

def _run_stream_reader(stream, log_list):
    try:
        for line in iter(stream.readline, ''):
            if not line:
                break
            log_list.append(line)
    except Exception:
        pass
    finally:
        try:
            stream.close()
        except Exception:
            pass

@track_tool_activity
def run_command_async(command: str) -> str:
    """Spawns a shell command in the background, executing non-blockingly.

    Args:
        command: The shell command to run.

    Returns:
        A success message with the task ID, or an error.
    """
    try:
        if not confirm_tool_execution("run_command_async", f"Command:\n{command}"):
            return "Error: Tool execution denied by user."

        task_id = f"task_{int(time.time())}_{uuid.uuid4().hex[:4]}"
        
        process = subprocess.Popen(
            command,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1
        )
        
        stdout_log = []
        stderr_log = []
        
        t1 = threading.Thread(target=_run_stream_reader, args=(process.stdout, stdout_log))
        t2 = threading.Thread(target=_run_stream_reader, args=(process.stderr, stderr_log))
        t1.daemon = True
        t2.daemon = True
        t1.start()
        t2.start()
        
        task_info = {
            'task_id': task_id,
            'command': command,
            'process': process,
            'stdout': stdout_log,
            'stderr': stderr_log,
            'start_time': time.time(),
            'threads': (t1, t2)
        }
        
        with tasks_lock:
            background_tasks[task_id] = task_info
            
        return f"Successfully started task '{task_id}' in the background for command: `{command}`"
    except Exception as e:
        return f"Error starting background command: {e}"

@track_tool_activity
def manage_task(action: str, task_id: str = "", input_val: str = "") -> str:
    """Manages background tasks: lists them, gets status/logs, kills processes, or sends stdin.

    Args:
        action: Action to perform. One of: 'list', 'status', 'kill', 'send_input'.
        task_id: The ID of the target task.
        input_val: For 'send_input', the text to send to stdin.

    Returns:
        A status or log string.
    """
    try:
        action = action.lower()
        if action == 'list':
            with tasks_lock:
                if not background_tasks:
                    return "No background tasks registered."
                lines = []
                for tid, info in background_tasks.items():
                    proc = info['process']
                    poll = proc.poll()
                    status = "running" if poll is None else f"exited ({poll})"
                    lines.append(f"Task ID: {tid} | Status: {status} | Command: `{info['command']}`")
                return "\n".join(lines)
                
        if not task_id:
            return "Error: task_id is required for this action."
            
        with tasks_lock:
            info = background_tasks.get(task_id)
            
        if not info:
            return f"Error: Task '{task_id}' not found."
            
        proc = info['process']
        
        if action == 'status':
            poll = proc.poll()
            status = "running" if poll is None else f"exited ({poll})"
            elapsed = round(time.time() - info['start_time'], 1)
            stdout_txt = "".join(info['stdout'])
            stderr_txt = "".join(info['stderr'])
            
            output = f"Task: {task_id}\nCommand: `{info['command']}`\nStatus: {status}\nElapsed Time: {elapsed}s\n"
            if stdout_txt:
                output += f"\n--- Standard Output ---\n{stdout_txt}\n"
            if stderr_txt:
                output += f"\n--- Standard Error ---\n{stderr_txt}\n"
            if not stdout_txt and not stderr_txt:
                output += "\n(No output received yet)"
            return output
            
        elif action == 'kill':
            poll = proc.poll()
            if poll is not None:
                return f"Task '{task_id}' has already exited with code {poll}."
            proc.terminate()
            for _ in range(10):
                if proc.poll() is not None:
                    break
                time.sleep(0.1)
            if proc.poll() is None:
                proc.kill()
            return f"Successfully terminated background task '{task_id}'."
            
        elif action == 'send_input':
            poll = proc.poll()
            if poll is not None:
                return f"Error: Cannot send input. Task '{task_id}' has already exited."
            if not input_val:
                return "Error: input_val is required for send_input."
            try:
                proc.stdin.write(input_val + "\n")
                proc.stdin.flush()
                return f"Successfully sent input to task '{task_id}'."
            except Exception as e:
                return f"Error sending input to task '{task_id}': {e}"
                
        else:
            return f"Error: Unknown action '{action}'. Valid actions: list, status, kill, send_input."
    except Exception as e:
        return f"Error managing task: {e}"

@track_tool_activity
def wait_task(task_id: str, timeout: float = 10.0) -> str:
    """Blocks and waits for a background task to finish, or returns early after a timeout.

    Args:
        task_id: The ID of the target task.
        timeout: Maximum seconds to block waiting (default 10.0).

    Returns:
        The latest task status and logs.
    """
    try:
        with tasks_lock:
            info = background_tasks.get(task_id)
        if not info:
            return f"Error: Task '{task_id}' not found."
            
        proc = info['process']
        start = time.time()
        while time.time() - start < timeout:
            if proc.poll() is not None:
                break
            time.sleep(0.25)
            
        return manage_task(action='status', task_id=task_id)
    except Exception as e:
        return f"Error waiting for task: {e}"

@track_tool_activity
def replace_file_content(path: str, start_line: int, end_line: int, target_content: str, replacement_content: str) -> str:
    """Edits a file by replacing a contiguous block of text from start_line to end_line (1-indexed, inclusive).

    Args:
        path: The file path to edit.
        start_line: The starting line number (1-indexed).
        end_line: The ending line number (1-indexed).
        target_content: The exact content expected to be replaced.
        replacement_content: The new replacement content.

    Returns:
        A success message or an error message.
    """
    try:
        if not confirm_tool_execution("replace_file_content", f"Path: {path}\nLines: {start_line}-{end_line}\nTarget Preview:\n{target_content[:200]}\nReplacement Preview:\n{replacement_content[:200]}"):
            return "Error: Tool execution denied by user."
            
        normalized_path = resolve_workspace_path(path)
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist."
            
        with open(normalized_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
            
        if start_line < 1 or end_line > len(lines) or start_line > end_line:
            return f"Error: Invalid line range {start_line}-{end_line}. File has {len(lines)} lines."
            
        actual_subset = "".join(lines[start_line-1:end_line])
        
        def normalize(s):
            return s.replace('\r\n', '\n').strip()
            
        if normalize(actual_subset) != normalize(target_content):
            return f"Error: Content within lines {start_line}-{end_line} does not match target_content.\nActual:\n{actual_subset}\nTarget:\n{target_content}"
            
        new_lines = lines[:start_line-1] + [replacement_content] + lines[end_line:]
        
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
            
        return f"Successfully modified lines {start_line}-{end_line} in '{path}'."
    except Exception as e:
        return f"Error modifying file '{path}': {e}"

@track_tool_activity
def multi_replace_file_content(path: str, replacement_chunks: list[dict]) -> str:
    """Edits a file by applying multiple non-contiguous block replacements.

    Args:
        path: The file path to edit.
        replacement_chunks: A list of dicts/chunks. Each chunk must contain:
            - start_line (int)
            - end_line (int)
            - target_content (str)
            - replacement_content (str)

    Returns:
        A success message or an error message.
    """
    try:
        preview_lines = []
        for i, chunk in enumerate(replacement_chunks):
            preview_lines.append(f"Chunk {i+1} (Lines {chunk.get('start_line')}-{chunk.get('end_line')}):\nTarget: {chunk.get('target_content')[:100]}\nReplacement: {chunk.get('replacement_content')[:100]}")
        preview_text = "\n\n".join(preview_lines)
        if not confirm_tool_execution("multi_replace_file_content", f"Path: {path}\n\n{preview_text}"):
            return "Error: Tool execution denied by user."
            
        normalized_path = resolve_workspace_path(path)
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist."
            
        with open(normalized_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
            
        chunks = []
        for chunk in replacement_chunks:
            start_line = int(chunk['start_line'])
            end_line = int(chunk['end_line'])
            target = chunk['target_content']
            replacement = chunk['replacement_content']
            chunks.append((start_line, end_line, target, replacement))
            
        chunks.sort(key=lambda x: x[0], reverse=True)
        
        for idx in range(len(chunks) - 1):
            curr_start, curr_end, _, _ = chunks[idx]
            prev_start, prev_end, _, _ = chunks[idx+1]
            if prev_end >= curr_start:
                return f"Error: Overlapping replacement chunks detected between lines {prev_start}-{prev_end} and {curr_start}-{curr_end}."
                
        def normalize(s):
            return s.replace('\r\n', '\n').strip()
            
        for start_line, end_line, target, replacement in chunks:
            if start_line < 1 or end_line > len(lines) or start_line > end_line:
                return f"Error: Invalid line range {start_line}-{end_line}. File has {len(lines)} lines."
            actual_subset = "".join(lines[start_line-1:end_line])
            if normalize(actual_subset) != normalize(target):
                return f"Error: Content within lines {start_line}-{end_line} does not match target content.\nActual:\n{actual_subset}\nTarget:\n{target}"
            lines = lines[:start_line-1] + [replacement] + lines[end_line:]
            
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
            
        return f"Successfully applied {len(replacement_chunks)} replacements to '{path}'."
    except Exception as e:
        return f"Error modifying file '{path}': {e}"


@track_tool_activity
def add_quest(title: str, notes: str, due: str = None, location: str = "", reminder_minutes: int = 15) -> str:
    """Creates a new quest and adds it to the user's quest log.
    
    Args:
        title: Title/name of the quest.
        notes: Objectives of the quest, separated by newlines or commas.
        due: Optional target due date/time (ISO 8601 string or description).
        location: Optional location coordinates or address.
        reminder_minutes: Optional alert/alarm trigger in minutes before due.
    """
    try:
        from datetime import datetime, timezone, timedelta
        import json
        import re
        
        # Resolve variables directory and quest path
        base_dir = os.path.dirname(os.path.abspath(__file__))
        VARIABLES_DIR = os.path.normpath(os.path.join(base_dir, "variables"))
        QUEST_LOG_PATH = os.path.join(VARIABLES_DIR, "quest_log.json")
        
        # Load existing quests
        quests = []
        if os.path.exists(QUEST_LOG_PATH):
            try:
                with open(QUEST_LOG_PATH, 'r', encoding='utf-8') as f:
                    quests = json.load(f)
            except Exception:
                quests = []

        # Parse notes into objectives
        raw_notes = notes.replace('\\n', '\n')
        objectives = [line.strip() for line in raw_notes.split('\n') if line.strip()]
        if not objectives:
            objectives = [notes.strip()]

        # Generate new quest object
        timestamp = int(time.time())
        
        # Handle due time parsing or format
        due_val = due
        if not due_val:
            due_val = datetime.now(timezone.utc).isoformat()
        else:
            due_lower = due_val.lower()
            if "tomorrow" in due_lower:
                due_val = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()
            elif "today" in due_lower:
                due_val = datetime.now(timezone.utc).isoformat()
            else:
                # check if there's hours/days, e.g. "in 2 hours", "in 3 days"
                match_hours = re.search(r'in\s+(\d+)\s+hour', due_lower)
                match_days = re.search(r'in\s+(\d+)\s+day', due_lower)
                if match_hours:
                    hours = int(match_hours.group(1))
                    due_val = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()
                elif match_days:
                    days = int(match_days.group(1))
                    due_val = (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()
                else:
                    try:
                        # check if it is parseable
                        datetime.fromisoformat(due_val.replace("Z", "+00:00"))
                    except Exception:
                        # default to tomorrow if we cannot parse it, to prevent "Invalid Date" in UI
                        due_val = (datetime.now(timezone.utc) + timedelta(days=1)).isoformat()

        try:
            reminder_min_val = int(reminder_minutes)
        except (ValueError, TypeError):
            reminder_min_val = 15

        import uuid
        unique_suffix = uuid.uuid4().hex[:6]
        quest = {
            "id": f"quest_{timestamp}_{unique_suffix}",
            "title": title.strip(),
            "objectives": objectives,
            "location": location.strip(),
            "due": due_val,
            "reminder_minutes": reminder_min_val,
            "created_at": datetime.now(timezone.utc).isoformat()
        }

        # Avoid duplicate quest titles in the same turn
        if any(q.get("title") == quest["title"] for q in quests[-3:]):
            return f"Quest '{quest['title']}' is already in the log."

        quests.append(quest)

        os.makedirs(VARIABLES_DIR, exist_ok=True)
        with open(QUEST_LOG_PATH, 'w', encoding='utf-8') as f:
            json.dump(quests, f, indent=2, ensure_ascii=False)

        return f"Successfully added quest: '{title}' to the quest log with {len(objectives)} objectives."
    except Exception as e:
        return f"Error adding quest: {e}"


@track_tool_activity
def add_journal_entry(keyphrases: str, content: str) -> str:
    """Saves a memory journal entry for the active companion.
    
    Args:
        keyphrases: Comma separated keywords or phrases that trigger this memory.
        content: The specific, important detail or memory to record (up to 300 characters).
    """
    try:
        from utils.journals import add_journal_entry as add_entry
        from utils.program import get_active_program
        active_prog = get_active_program()
        entry = add_entry(keyphrases, content, active_prog)
        return f"Successfully saved memory journal entry: {entry.get('content')}"
    except Exception as e:
        return f"Error saving memory journal entry: {e}"





