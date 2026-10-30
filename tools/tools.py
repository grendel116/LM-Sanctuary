import os
import time
import uuid
import fnmatch
import subprocess
import functools
import threading
import contextvars
import concurrent.futures

import requests

from variables.settings import COMFYUI_SERVER_URL
from utils import lifecycle

_search_executor = concurrent.futures.ThreadPoolExecutor(max_workers=10)

active_running_tools = {}
_active_tools_lock = threading.Lock()

current_session_id = contextvars.ContextVar('current_session_id', default='default')
current_use_imagen = contextvars.ContextVar('current_use_imagen', default=False)
session_tool_calls = {}
background_tasks = {}
session_tool_calls_lock = threading.Lock()
tasks_lock = threading.Lock()

tools_dir = os.path.dirname(os.path.abspath(__file__))
root_dir = os.path.dirname(tools_dir)  # This correctly sets the root directory

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
                tool_call_info['status'] = 'completed'
                tool_call_info['response'] = str(res)[:1000]
                tool_call_info['duration'] = duration
            return res
        except Exception as e:
            duration = round(time.time() - start_time, 2)
            with session_tool_calls_lock:
                tool_call_info['status'] = 'failed'
                tool_call_info['response'] = f"Error: {e}"
                tool_call_info['duration'] = duration
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
        from runners.program import get_active_program, _load_settings
        active_prog = get_active_program()
        settings = _load_settings()
    except Exception:
        active_prog = "sebile"
        settings = {}

    default_folder = os.path.normpath(os.path.join(os.getcwd(), 'core', 'programs', active_prog))
    folders = [default_folder]
    try:
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

def _get_prioritized_folders() -> list:
    folders = get_project_folders()
    if len(folders) > 1:
        return folders[1:] + [folders[0]]
    return folders

def resolve_workspace_path(path: str) -> str:
    cleaned = (path or "").strip()
    if cleaned.startswith("[") and "]" in cleaned:
        bracket_end = cleaned.find("]")
        prefix_tag = cleaned[1:bracket_end].strip()
        rest = cleaned[bracket_end + 1:].strip().lstrip("/\\")
        cleaned = os.path.join(prefix_tag, rest) if rest else prefix_tag

    normalized = os.path.normpath(cleaned)
    if os.path.isabs(normalized):
        return normalized

    prioritized = _get_prioritized_folders()

    for folder in prioritized:
        if os.path.basename(folder).lower() == normalized.lower():
            return os.path.normpath(folder)
        candidate = os.path.normpath(os.path.join(folder, normalized))
        if os.path.exists(candidate):
            return candidate
        folder_base = os.path.basename(folder).lower()
        norm_parts = normalized.split(os.sep)
        if norm_parts and norm_parts[0].lower() == folder_base and len(norm_parts) > 1:
            stripped_candidate = os.path.normpath(os.path.join(folder, *norm_parts[1:]))
            if os.path.exists(stripped_candidate):
                return stripped_candidate

    root_candidate = os.path.normpath(os.path.join(root_dir, normalized))
    if os.path.exists(root_candidate):
        return root_candidate

    norm_parts = normalized.split(os.sep)
    if norm_parts:
        first_part = norm_parts[0].lower()
        if first_part == "scratch":
            folders = get_project_folders()
            return os.path.normpath(os.path.join(folders[0], normalized))
        for folder in prioritized:
            if os.path.basename(folder).lower() == first_part:
                if len(norm_parts) > 1:
                    return os.path.normpath(os.path.join(folder, *norm_parts[1:]))
                return os.path.normpath(folder)

    return os.path.normpath(os.path.join(prioritized[0], normalized))

def resolve_workspace_cwd(cwd: str = "") -> str:
    if cwd and cwd.strip():
        resolved = resolve_workspace_path(cwd.strip())
        if os.path.isdir(resolved):
            return resolved
        parent = os.path.dirname(resolved)
        if parent and os.path.isdir(parent):
            return parent
    folders = get_project_folders()
    if len(folders) > 1 and os.path.isdir(folders[1]):
        return os.path.normpath(folders[1])
    return root_dir

# Global memory dict to hold tool confirmation states for mobile/web human-in-the-loop approvals
pending_tool_calls = {}

def confirm_tool_execution(tool_name: str, details: str) -> bool:
    try:
        from runners.program import _load_settings
        settings = _load_settings()
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
    import re
    from bs4 import BeautifulSoup
    from markdownify import markdownify as md
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    if not url.startswith(("http://", "https://")):
        return "Error: Invalid URL. The URL must start with http:// or https://"

    try:
        import primp
        client = primp.Client(timeout=15, verify=False, follow_redirects=True)
        response = client.get(url)
        if response.status_code != 200:
            return f"Error: Failed to fetch webpage. HTTP status code: {response.status_code}"
        html_content = response.text
    except Exception as e:
        return f"Error loading webpage: {e}"

    try:
        soup = BeautifulSoup(html_content, 'html.parser')

        for element in soup(["script", "style", "nav", "header", "footer", "meta", "noscript", "svg", "iframe", "form", "aside", "img", "figure"]):
            element.decompose()

        content_area = soup.find("main") or soup.find("article") or soup.find("body") or soup

        markdown_text = md(
            str(content_area),
            heading_style="ATX",
            bullets="-"
        )

        markdown_text = re.sub(r'!\[.*?\]\(.*?\)', '', markdown_text)
        markdown_text = re.sub(r'\n{3,}', '\n\n', markdown_text).strip()

        limit = 4000
        if len(markdown_text) > limit:
            return markdown_text[:limit] + f"\n\n... [Content truncated, total length: {len(markdown_text)} characters] ..."

        if not markdown_text.strip():
            return "Error: Webpage loaded, but no readable content could be extracted."

        return markdown_text
    except Exception as e:
        return f"Error parsing webpage content: {e}"


def query_searxng(query: str, base_url: str = None, engines: str = "baidu,yandex,bing") -> list:
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
    Supports routing via prefix queries (e.g. 'github: query', 'arxiv: query', 'hn: query', 'wikipedia: query')
    or concurrent web blending for standard queries.

    Args:
        query: The search query.

    Returns:
        A formatted string of matching pages with titles, URLs, and snippets.
    """
    import os
    import concurrent.futures
    import time

    # Read project settings
    search_engine = "web_crawling"
    searxng_url = ""
    try:
        from runners.program import _load_settings
        settings = _load_settings()
        search_engine = settings.get("search_engine", "web_crawling")
        searxng_url = settings.get("searxng_url", "")
    except Exception as e:
        print(f"Error loading search settings: {e}")

    # Map invalid or older values to web_crawling
    if search_engine not in ("web_crawling", "wikipedia"):
        search_engine = "web_crawling"

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

    def run_duckduckgo(q):
        try:
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS
            ddgs = DDGS()
            hits = ddgs.text(q, max_results=6)
            results = []
            for h in (hits or []):
                title = h.get("title", "")
                url = h.get("href", "")
                snippet = h.get("body", "")
                if url:
                    results.append({
                        "title": title,
                        "url": url,
                        "content": snippet,
                        "source": "DuckDuckGo"
                    })
            return results
        except Exception as e:
            print(f"[DuckDuckGo] Error: {e}")
            return []

    def run_brave(q):
        api_key = os.getenv("BRAVE_SEARCH_API_KEY", "").strip()
        if not api_key:
            return []
        try:
            url = "https://api.search.brave.com/res/v1/web/search"
            headers = {
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "X-Subscription-Token": api_key
            }
            params = {"q": q, "count": 8, "search_lang": "en"}
            res = requests.get(url, headers=headers, params=params, timeout=6)
            if res.status_code == 200:
                web_results = res.json().get("web", {}).get("results", [])
                results = []
                for r in web_results:
                    title = r.get("title", "")
                    link = r.get("url", "")
                    snippet = r.get("description", "")
                    if link:
                        results.append({
                            "title": title,
                            "url": link,
                            "content": snippet,
                            "source": "Brave"
                        })
                return results
            else:
                print(f"[Brave Search] HTTP {res.status_code}")
                return []
        except Exception as e:
            print(f"[Brave Search] Error: {e}")
            return []

    def run_tavily(q):
        api_key = os.getenv("TAVILY_API_KEY", "").strip()
        if not api_key:
            return []
        try:
            url = "https://api.tavily.com/search"
            payload = {
                "api_key": api_key,
                "query": q,
                "max_results": 8,
                "include_answer": False
            }
            res = requests.post(url, json=payload, timeout=8)
            if res.status_code == 200:
                hits = res.json().get("results", [])
                results = []
                for r in hits:
                    title = r.get("title", "")
                    link = r.get("url", "")
                    content = r.get("content", "")
                    if link:
                        results.append({
                            "title": title,
                            "url": link,
                            "content": content,
                            "source": "Tavily"
                        })
                return results
            else:
                print(f"[Tavily] HTTP {res.status_code}")
                return []
        except Exception as e:
            print(f"[Tavily] Error: {e}")
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

    def enrich_thin_results(result_list, thin_threshold=150, max_enrich=3, per_page_limit=2000):
        """Concurrently fetch page bodies for results with thin snippets."""
        from bs4 import BeautifulSoup
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

        thin = [r for r in result_list if len(r.get("content", "")) < thin_threshold][:max_enrich]
        if not thin:
            return

        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36"
        }

        def fetch_one(item):
            try:
                res = requests.get(item["url"], headers=headers, timeout=5, verify=False)
                if res.status_code != 200:
                    return
                soup = BeautifulSoup(res.content, "html.parser")
                for tag in soup(["script", "style", "nav", "header", "footer", "aside", "form"]):
                    tag.decompose()
                area = soup.find("main") or soup.find("article") or soup.find("body") or soup
                text = " ".join(area.get_text(" ", strip=True).split())
                if text:
                    item["content"] = text[:per_page_limit]
            except Exception as e:
                print(f"[Enrich] Failed to fetch {item['url']}: {e}")

        with concurrent.futures.ThreadPoolExecutor(max_workers=max_enrich) as ex:
            ex.map(fetch_one, thin)

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
    elif query_lower.startswith("wikipedia:"):
        raw_query = query[len("wikipedia:"):].strip()
        results_pool = run_wikipedia(raw_query)
    elif query_lower.startswith("music:"):
        raw_query = query[len("music:"):].strip()
        try:
            import musicbrainzngs
            musicbrainzngs.set_useragent("Sanctuary", "1.0", "https://github.com/sanctuary")
            mb_results = []
            artist_res = musicbrainzngs.search_artists(artist=raw_query, limit=5)
            for artist in artist_res.get("artist-list", []):
                name = artist.get("name", "")
                mbid = artist.get("id", "")
                area = artist.get("area", {}).get("name", "")
                tags = ", ".join(t.get("name", "") for t in artist.get("tag-list", [])[:5])
                disambiguation = artist.get("disambiguation", "")
                desc_parts = []
                if area:
                    desc_parts.append(f"From: {area}")
                if tags:
                    desc_parts.append(f"Tags: {tags}")
                if disambiguation:
                    desc_parts.append(disambiguation)
                mb_results.append({
                    "title": name,
                    "url": f"https://musicbrainz.org/artist/{mbid}",
                    "content": " | ".join(desc_parts) if desc_parts else name,
                    "source": "MusicBrainz"
                })
            rec_res = musicbrainzngs.search_recordings(query=raw_query, limit=5)
            for rec in rec_res.get("recording-list", []):
                title = rec.get("title", "")
                mbid = rec.get("id", "")
                artist_credit = ", ".join(
                    a.get("artist", {}).get("name", "") 
                    for a in rec.get("artist-credit", []) 
                    if isinstance(a, dict)
                )
                releases = rec.get("release-list", [])
                album = releases[0].get("title", "") if releases else ""
                desc = f"by {artist_credit}" if artist_credit else ""
                if album:
                    desc += f" (from '{album}')"
                mb_results.append({
                    "title": title,
                    "url": f"https://musicbrainz.org/recording/{mbid}",
                    "content": desc.strip(),
                    "source": "MusicBrainz"
                })
            results_pool = mb_results
        except ImportError:
            results_pool = [{"title": "MusicBrainz Unavailable", "url": "", "content": "Install musicbrainzngs: pip install musicbrainzngs", "source": "System"}]
        except Exception as e:
            print(f"[MusicBrainz] Error: {e}")
            results_pool = []
    else:
        # Standard concurrent search blending
        if search_engine == "web_crawling":
            futures = {
                _search_executor.submit(run_searxng, query): "SearXNG",
                _search_executor.submit(run_baidu, query): "Baidu",
                _search_executor.submit(run_duckduckgo, query): "DuckDuckGo",
                _search_executor.submit(run_brave, query): "Brave",
                _search_executor.submit(run_tavily, query): "Tavily",
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

            # Deduplicate by URL, collapsing mobile/desktop variations
            seen_urls = set()
            unique_results = []
            for r in results_pool:
                url_clean = r["url"].lower().strip().rstrip('/')
                compare_url = url_clean.replace("https://m.", "https://www.").replace("http://m.", "http://www.")
                if compare_url not in seen_urls:
                    seen_urls.add(compare_url)
                    unique_results.append(r)

            # Query Wikipedia if other sources returned empty
            if not unique_results:
                print("[Web Crawling] Primary sources empty. Querying Wikipedia.")
                wiki_results = run_wikipedia(query)
                for r in wiki_results:
                    url_clean = r["url"].lower().strip().rstrip('/')
                    compare_url = url_clean.replace("https://m.", "https://www.").replace("http://m.", "http://www.")
                    if compare_url not in seen_urls:
                        seen_urls.add(compare_url)
                        unique_results.append(r)

            results_pool = unique_results

            # Enrich results that came back with thin snippets
            enrich_thin_results(results_pool)

        elif search_engine == "wikipedia":
            results_pool = run_wikipedia(query)

    if not results_pool:
        return "No search results found."

    # Directly format search results for local LLM consumption
    lines = []
    for r in results_pool[:10]:
        lines.append(f"Title: {r['title']}\nURL: {r['url']}\nSource: {r['source']}\nSnippet: {r['content']}")
    return "\n\n".join(lines)


@track_tool_activity
def google_search(query: str) -> str:
    """Wrapper that delegates search queries to web_search."""
    return web_search(query)

# ==============================================================================
# FILE MANAGEMENT TOOLS
# ==============================================================================

@track_tool_activity
def read_file(path: str, start_line: int = None, end_line: int = None) -> str:
    """Reads the contents of a file at the specified path with 1-indexed line numbers.
    Supports plain text, markdown, code files, PDFs, DOCX, and XLSX files.

    Args:
        path: The file path to read (absolute or relative to workspace folders).
        start_line: Optional 1-indexed starting line number.
        end_line: Optional 1-indexed ending line number (inclusive).

    Returns:
        The line-numbered content of the file or an error message.
    """
    try:
        normalized_path = resolve_workspace_path(path)
        if not os.path.exists(normalized_path):
            return f"Error reading file '{path}': File not found at '{normalized_path}'."
        if os.path.isdir(normalized_path):
            return f"Error reading file '{path}': '{normalized_path}' is a directory. Use get_workspace_structure(path=\"{path}\") or find_files(path=\"{path}\") instead."
        path_lower = normalized_path.lower()
        
        # PDF File Handling
        if path_lower.endswith('.pdf'):
            try:
                import pypdf
                reader = pypdf.PdfReader(normalized_path)
                text_parts = []
                for page in reader.pages:
                    text = page.extract_text()
                    if text:
                        text_parts.append(text)
                combined = "\n\n".join(text_parts).strip()
                if not combined and len(reader.pages) > 0:
                    return (
                        f"Error reading PDF file '{path}': "
                        "The PDF file contains pages but no digital text. "
                        "It is likely a scanned document or consists solely of images."
                    )
                return combined
            except ImportError:
                return "Error: `pypdf` is not installed. Please install it with `pip install pypdf`."
            except Exception as pdf_err:
                return f"Error reading PDF file '{path}': {pdf_err}"

        # Word Document (.docx) Handling
        if path_lower.endswith('.docx'):
            try:
                import docx
                doc = docx.Document(normalized_path)
                full_text = [para.text for para in doc.paragraphs if para.text.strip()]
                return "\n\n".join(full_text)
            except ImportError:
                return "Error: `python-docx` is not installed. Please install it with `pip install python-docx`."
            except Exception as docx_err:
                return f"Error reading DOCX file '{path}': {docx_err}"

        # Excel Spreadsheet (.xlsx / .xls) Handling
        if path_lower.endswith(('.xlsx', '.xls')):
            try:
                import openpyxl
                wb = openpyxl.load_workbook(normalized_path, data_only=True)
                output = []
                for sheet in wb.sheetnames:
                    ws = wb[sheet]
                    output.append(f"--- Sheet: {sheet} ---")
                    for row in ws.iter_rows(values_only=True):
                        if any(cell is not None for cell in row):
                            row_str = " | ".join(str(cell) if cell is not None else "" for cell in row)
                            output.append(row_str)
                    output.append("")
                return "\n".join(output).strip()
            except ImportError:
                return "Error: `openpyxl` is not installed. Please install it with `pip install openpyxl`."
            except Exception as xlsx_err:
                return f"Error reading Excel file '{path}': {xlsx_err}"

        # Google Doc Shortcut Warning
        if path_lower.endswith('.gdoc'):
            return (
                f"Error: '{path}' is a Google Doc shortcut file. "
                "Google Doc shortcut files (.gdoc) do not contain the document text locally. "
                "Please copy and paste the document content directly into the chat."
            )
            
        # Standard Text / Source Code Files
        with open(normalized_path, "r", encoding="utf-8", errors="replace") as f:
            all_lines = f.readlines()

        total_lines = len(all_lines)
        if total_lines == 0:
            return f"File: {normalized_path} (Empty file, 0 lines)"

        max_lines_per_read = 300
        s = max(1, int(start_line)) if start_line is not None else 1
        if s > total_lines:
            return f"Error: start_line ({s}) exceeds total lines ({total_lines}) in '{normalized_path}'."

        if end_line is not None:
            e = min(total_lines, max(s, int(end_line)))
            if e - s + 1 > max_lines_per_read:
                e = s + max_lines_per_read - 1
        else:
            e = min(total_lines, s + max_lines_per_read - 1)

        numbered_lines = [
            f"{idx}: {all_lines[idx - 1].rstrip(chr(13) + chr(10))}"
            for idx in range(s, e + 1)
        ]
        header = f"File: {normalized_path} (Lines {s}-{e} of {total_lines})\n"
        body = "\n".join(numbered_lines)
        if e < total_lines:
            next_start = e + 1
            next_end = min(total_lines, e + max_lines_per_read)
            body += f"\n\n... [Showing lines {s}-{e} of {total_lines}. Call read_file(path=\"{path}\", start_line={next_start}, end_line={next_end}) to view more.]"
        return header + body

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
        normalized_path = resolve_workspace_path(path)
        if not confirm_tool_execution("write_file", f"Path: {normalized_path}\nContent Preview:\n{content[:500]}"):
            return "Error: Tool execution denied by user."
            
        parent_dir = os.path.dirname(normalized_path)
        if parent_dir and not os.path.exists(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)
            
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.write(content)
        return f"Successfully wrote to file '{normalized_path}'."
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
        normalized_path = resolve_workspace_path(path)
        if not confirm_tool_execution("replace_in_file", f"Path: {normalized_path}\n\nReplacing:\n{old_text[:300]}\n\nWith:\n{new_text[:300]}"):
            return "Error: Tool execution denied by user."
            
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist at '{normalized_path}'."
            
        with open(normalized_path, "r", encoding="utf-8") as f:
            content = f.read()
            
        if old_text not in content:
            normalized_content = content.replace("\r\n", "\n")
            normalized_old = old_text.replace("\r\n", "\n")
            normalized_new = new_text.replace("\r\n", "\n")
            if normalized_old not in normalized_content:
                return f"Error: Could not find exact text match for replacement in '{normalized_path}'. Read the file first with read_file to inspect exact lines."
            updated_content = normalized_content.replace(normalized_old, normalized_new, 1)
        else:
            updated_content = content.replace(old_text, new_text, 1)
            
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.write(updated_content)
        return f"Successfully replaced content in '{normalized_path}'."
    except Exception as e:
        return f"Error modifying file '{path}': {e}"


@track_tool_activity
def run_shell_command(command: str, cwd: str = "") -> str:
    """Runs a shell command in the workspace directory and returns its output.

    Ensure commands complete within 30 seconds. Use targeted listing and search commands
    instead of recursive directory operations (like 'dir /s', 'find .', or 'grep -r')
    to prevent timeout errors.

    Args:
        command: The shell command to run.
        cwd: Optional working directory (defaults to the active project workspace folder).

    Returns:
        The standard output and standard error from running the command.
    """
    try:
        target_cwd = resolve_workspace_cwd(cwd)
        if not confirm_tool_execution("run_shell_command", f"CWD: {target_cwd}\nCommand:\n{command}"):
            return "Error: Tool execution denied by user."
            
        result = subprocess.run(
            command,
            shell=True,
            cwd=target_cwd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30
        )
        output = f"Working Directory: {target_cwd}\nExit Code: {result.returncode}\n"
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
def get_workspace_structure(path: str = "") -> str:
    """Recursively lists files and directories in the specified path or all configured project folders,
    excluding virtual environments (.venv), caches (__pycache__), and git directories.
    Safeguarded with maximum depth and line limits for large workspace directories.

    Args:
        path: Optional subdirectory or workspace folder path to inspect.

    Returns:
        A text representation of the workspace directory tree structure.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist", ".idea", ".vscode"}
    
    if path and path.strip():
        resolved = resolve_workspace_path(path.strip())
        if not os.path.exists(resolved):
            return f"Error: Directory '{path}' does not exist at '{resolved}'."
        if os.path.isfile(resolved):
            return f"'{resolved}' is a file. Use read_file(path=\"{path}\") to view its contents."
        folders = [resolved]
    else:
        folders = _get_prioritized_folders()
        
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
            
        visible_items = [item for item in items if item not in exclude_dirs]
        for i, item in enumerate(visible_items):
            if len(lines) >= max_lines:
                truncated = True
                break
                
            item_path = os.path.join(directory, item)
            is_last = (i == len(visible_items) - 1)
            connector = "└── " if is_last else "├── "
            
            lines.append(f"{prefix}{connector}{item}")
            
            if os.path.isdir(item_path):
                new_prefix = prefix + ("    " if is_last else "│   ")
                _build_tree(item_path, new_prefix, depth + 1)
                
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
        lines.append("... [Tree truncated: maximum list limit of 300 lines or depth level of 3 reached. Pass path=\"...\" to get_workspace_structure or use find_files / search_codebase.]")
        
    return "\n".join(lines).strip()


@track_tool_activity
def find_files(pattern: str = "", path: str = "") -> str:
    """Finds files across the workspace whose filenames or relative paths match a substring or glob pattern.

    Args:
        pattern: Substring or glob pattern to match against file names (e.g. '*.py', 'router', 'package.json'). Leave empty to list files.
        path: Optional directory path to restrict the search.

    Returns:
        A list of matching file paths, or a 'no files found' message.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist", ".idea", ".vscode"}
    if path and path.strip():
        resolved = resolve_workspace_path(path.strip())
        if not os.path.exists(resolved):
            return f"Error: Path '{path}' does not exist at '{resolved}'."
        folders = [resolved]
    else:
        folders = _get_prioritized_folders()

    pat = (pattern or "").strip().lower()
    is_glob = any(ch in pat for ch in ("*", "?", "["))
    matches = []
    max_matches = 100
    truncated = False

    for folder in folders:
        if not os.path.exists(folder):
            continue
        if os.path.isfile(folder):
            matches.append(folder)
            continue
        for root, dirs, files in os.walk(folder):
            dirs[:] = [d for d in dirs if d not in exclude_dirs]
            for file in sorted(files):
                full_path = os.path.join(root, file)
                rel_path = os.path.relpath(full_path, folder)
                file_lower = file.lower()
                rel_lower = rel_path.lower().replace("\\", "/")
                if not pat:
                    matched = True
                elif is_glob:
                    matched = fnmatch.fnmatch(file_lower, pat) or fnmatch.fnmatch(rel_lower, pat)
                else:
                    matched = (pat in file_lower) or (pat in rel_lower)
                if matched:
                    display_path = os.path.join(os.path.basename(folder), rel_path) if len(folders) > 1 else rel_path
                    matches.append(f"{display_path}  ({full_path})")
                    if len(matches) >= max_matches:
                        truncated = True
                        break
            if truncated:
                break
        if truncated:
            break

    if not matches:
        return f"No files found matching pattern '{pattern}'."

    output = f"Found {len(matches)}{'+' if truncated else ''} matching file(s):\n" + "\n".join(matches)
    if truncated:
        output += f"\n\n... [Results truncated at {max_matches} files. Refine `pattern` or specify `path`.]"
    return output


@track_tool_activity
def search_codebase(keyword: str, path: str = "") -> str:
    """Performs a case-insensitive search for a keyword or pattern inside text files
    in the workspace, returning matching file paths, line numbers, and snippets.
    Safeguarded with a maximum match limit for large workspaces.

    Args:
        keyword: The text pattern or keyword to search for.
        path: Optional directory or file path to restrict the search.

    Returns:
        A list of matching snippets grouped by file, or a 'no matches found' message.
    """
    exclude_dirs = {".venv", "__pycache__", ".git", "node_modules", "dist", ".idea", ".vscode"}
    exclude_extensions = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".pdf", ".pyc", ".db", ".zip", ".tar", ".gz", ".xlsx", ".docx"}
    results = []
    max_files = 25
    truncated = False
    
    if path and path.strip():
        resolved = resolve_workspace_path(path.strip())
        if not os.path.exists(resolved):
            return f"Error: Search path '{path}' does not exist at '{resolved}'."
        folders = [resolved]
    else:
        folders = _get_prioritized_folders()
        
    keyword_lower = keyword.lower()
    
    for folder in folders:
        if not os.path.exists(folder):
            continue
        if os.path.isfile(folder):
            try:
                with open(folder, "r", encoding="utf-8", errors="ignore") as f:
                    lines = f.readlines()
                file_matches = [
                    f"  Line {line_idx + 1}: {line.strip()}"
                    for line_idx, line in enumerate(lines)
                    if keyword_lower in line.lower()
                ]
                if file_matches:
                    results.append(f"File: {folder}\n" + "\n".join(file_matches[:15]))
            except Exception:
                pass
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
                display_path = os.path.join(os.path.basename(folder), rel_path) if len(folders) > 1 else rel_path
                
                try:
                    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
                        lines = f.readlines()
                        
                    file_matches = []
                    for line_idx, line in enumerate(lines):
                        if keyword_lower in line.lower():
                            file_matches.append(f"  Line {line_idx + 1}: {line.strip()}")
                            
                    if file_matches:
                        results.append(f"File: {display_path} ({file_path})\n" + "\n".join(file_matches[:10]))
                except Exception:
                    continue
                    
    if not results:
        return f"No matches found for keyword: '{keyword}'"
        
    output = "\n\n".join(results)
    if truncated:
        output += "\n\n... [Search results truncated: maximum limit of 25 matched files reached. Refine your keyword or pass path=\"...\".]"
    return output

# ==============================================================================
# COMFYUI TOOLS
# ==============================================================================

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
def apply_comfy_workflow(workflow_path: str, parameters: dict, save_path: str, session_id: str = None) -> str:
    """Executes a specified ComfyUI workflow JSON template with custom parameter mappings and saves the output.

    Args:
        workflow_path: Path to the workflow JSON file.
        parameters: Dictionary of placeholder keys and their replacement values.
        save_path: Path where the generated image should be saved.
        session_id: Optional session identifier used to honour cancellation requests.

    Returns:
        The filesystem path of the saved image, or an error message.
    """
    import os
    import json
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

    # Ensure LLM is offloaded and ComfyUI is running before submitting workflow
    try:
        from adapters.vram_orchestrator import start_img
        start_img()
    except Exception as e:
        print(f"[apply_comfy_workflow] VRAM orchestration note: {e}", flush=True)

    from adapters.comfy_manager import check_comfy_running, start_comfy_server
    if not check_comfy_running(force_refresh=True):
        print("[apply_comfy_workflow] ComfyUI offline. Starting server...", flush=True)
        start_comfy_server()
        import time as _time
        for _ in range(30):
            _time.sleep(2.0)
            if check_comfy_running(force_refresh=True):
                break
        else:
            return "Error: ComfyUI server failed to start within 60 seconds."

    def _cancel_comfy_job(pid: str):
        """Tell ComfyUI to interrupt the running job and remove it from the queue."""
        try:
            requests.post(f"{comfy_url}/interrupt", timeout=3)
        except Exception:
            pass
        try:
            requests.post(f"{comfy_url}/queue", json={"delete": [pid]}, timeout=3)
        except Exception:
            pass

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
        from runners.runner import cancelled_sessions
        for _ in range(300):
            # Honour session cancellation — stop polling and kill the ComfyUI job
            if session_id and session_id in cancelled_sessions:
                _cancel_comfy_job(prompt_id)
                return "Error: Image generation cancelled by user."

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
                                    
                                    # Clean up temporary output from ComfyUI server folder
                                    try:
                                        from adapters.comfy_manager import COMFYUI_DIR
                                        img_type = img.get("type", "temp")
                                        comfy_file = os.path.normpath(os.path.join(COMFYUI_DIR, img_type, img.get("subfolder", ""), filename))
                                        if os.path.exists(comfy_file):
                                            os.remove(comfy_file)
                                            print(f"[COMFY IMAGE] Cleaned up {img_type} output image: {comfy_file}")
                                    except Exception as e_clean:
                                        print(f"[COMFY IMAGE] Warning: Failed to clean up file: {e_clean}")
                                        
                                    return save_path
                                else:
                                    raise Exception(f"Error downloading image: status {view_res.status_code}")
            time.sleep(1)
        raise Exception("Image generation timed out on ComfyUI server after 300 seconds.")
    except Exception as e:
        return f"Error executing ComfyUI workflow: {e}"

@track_tool_activity
def generate_local_image(prompt: str, count: int = 3) -> str:
    """Generates local portrait image(s) using ComfyUI with program-specific workflow configurations.
    
    Args:
        prompt: A prompt describing what you are doing or the scene/expression.
        count: Number of images to generate (defaults to 3 for initial portrait generation, 1 for single slot reroll).
        
    Returns:
        Markdown link(s) to the generated portrait image(s), or an error message.
    """
    import os
    import time
    import json
    
    from runners.program import get_active_program
    active_program = get_active_program()

    # Load image prompt tags from program details
    img_details_val = ""
    neg_details_val = ""
    
    program_json_path = os.path.normpath(os.path.join(
        root_dir, "core", "programs", active_program, f"{active_program}.json"
    ))
    if os.path.exists(program_json_path):
        try:
            with open(program_json_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            card = raw.get("data", raw)
            sanctuary = card.get("extensions", {}).get("sanctuary", {})
            img_details = sanctuary.get("image_details", {})
            img_details_val = img_details.get("positive", "")
            neg_details_val = img_details.get("negative", "")
        except Exception as e:
            print(f"[DEBUG] Error reading active program JSON for image generation: {e}", flush=True)

    # Combine prompt and image details
    from core.program_config import replace_placeholders
    final_prompt = replace_placeholders(prompt)
    if img_details_val:
        img_details_clean = replace_placeholders(img_details_val).strip()
        if img_details_clean:
            if final_prompt and not final_prompt.endswith(","):
                final_prompt += ", "
            final_prompt += img_details_clean

    base_negative = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text"
    if neg_details_val and neg_details_val.strip():
        neg_clean = replace_placeholders(neg_details_val).strip().rstrip(",")
        final_negative = f"{neg_clean}, {base_negative}"
    else:
        final_negative = base_negative

    base_timestamp = int(time.time() * 1000)
    portraits_dir = os.path.normpath(os.path.join(root_dir, "core", "programs", active_program, "portraits"))
    os.makedirs(portraits_dir, exist_ok=True)
    num_images = max(1, int(count or 3))

    # Execute pure in-process DirectML GPU diffusion engine
    try:
        from adapters.vram_orchestrator import start_img
        from core.engine_diffusion import generate_portrait_image
        from runners.runner import cancelled_sessions

        start_img()
        sess_id = current_session_id.get()
        if sess_id in cancelled_sessions:
            return "Error: Portrait generation cancelled by user."

        stems = []
        local_filenames = []
        local_paths = []
        for idx in range(num_images):
            suffix = f"_{idx + 1}" if num_images > 1 else ""
            stem = f"portrait_{base_timestamp}{suffix}"
            local_filename = f"{stem}.png"
            stems.append(stem)
            local_filenames.append(local_filename)
            local_paths.append(os.path.join(portraits_dir, local_filename))

        if num_images == 1:
            generate_portrait_image(
                prompt=final_prompt,
                negative_prompt=final_negative,
                save_path=local_paths[0]
            )
        else:
            generate_portrait_image(
                prompt=final_prompt,
                negative_prompt=final_negative,
                save_paths=local_paths,
            )

        markdown_links = []
        for stem, local_filename in zip(stems, local_filenames):
            json_path = os.path.join(portraits_dir, f"{stem}.json")
            try:
                with open(json_path, "w", encoding="utf-8") as jf:
                    json.dump(
                        {
                            "prompt": prompt,
                            "full_prompt": final_prompt,
                            "negative_prompt": final_negative,
                            "engine": "in_process_gpu",
                        },
                        jf,
                        indent=4,
                    )
            except Exception:
                pass
            markdown_links.append(f"![Portrait](/images/portraits/{local_filename})")

        return "\n".join(markdown_links)
    except Exception as e:
        print(f"[engine_diffusion] Error generating portrait: {e}")
        return f"Error generating portrait: {e}"

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
    from PIL import Image
    
    from variables.settings import COMFYUI_SERVER_URL, get_workflow_path
    from adapters.comfy_manager import COMFYUI_DIR, check_comfy_running, _resolver_worker, resolution_status

    workflow_path = get_workflow_path("Video")
    
    if not os.path.exists(workflow_path):
        raise Exception("No video workflow found. Save a ComfyUI API-format workflow as models/workflows/VideoWorkflow.json.")
        
    if not os.path.exists(image_path):
        raise Exception(f"Source image not found at '{image_path}'")
        
    # Copy and resize source image to ComfyUI's input directory using PIL
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
    
    # Ensure ComfyUI server is running
    if not check_comfy_running(force_refresh=True):
        raise Exception("ComfyUI server is offline. Please start the ComfyUI engine manually from the settings panel.")
            
    # Run dependency resolution inline to ensure missing custom nodes or models are downloaded/installed
    print("[COMFY VIDEO] Checking and resolving workflow dependencies inline...")
    _resolver_worker(json.dumps(populated_workflow))
    if resolution_status.get("status") == "failed":
        print(f"[COMFY VIDEO] Dependency resolution failed: {resolution_status.get('progress')}")
        raise Exception(f"Failed to resolve workflow dependencies: {resolution_status.get('progress')}")
    print("[COMFY VIDEO] Dependency resolution completed successfully.")
    
    # Wait for ComfyUI to come back online if it was restarted
    print("[COMFY VIDEO] Waiting for ComfyUI server to be responsive...")
    for _ in range(60):  # up to 60 seconds
        if check_comfy_running(force_refresh=True):
            break
        time.sleep(1)
        
    print(f"[COMFY VIDEO] Populated workflow JSON:\n{json.dumps(populated_workflow, indent=2)}")
    
    comfy_url = COMFYUI_SERVER_URL
    print(f"[COMFY VIDEO] Submitting workflow to ComfyUI server: {comfy_url}")
    
    res = requests.post(f"{comfy_url}/prompt", json={"prompt": populated_workflow}, timeout=10.0)
    if res.status_code != 200:
        # Clean up input image on error
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
                        temp_dir = os.path.normpath(os.path.join(COMFYUI_DIR, "temp"))
                        if os.path.exists(temp_dir):
                            newest_file = None
                            newest_time = 0
                            for f_name in os.listdir(temp_dir):
                                if f_name.startswith("civitai_") and f_name.lower().endswith((".mp4", ".webm", ".gif")):
                                    f_path = os.path.join(temp_dir, f_name)
                                    mtime = os.path.getmtime(f_path)
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
            
        # Determine correct file extension
        _, ext = os.path.splitext(completed_filename)
        if not ext:
            ext = ".mp4"
            
        # Determine save path: next to the original portrait/image
        source_dir = os.path.dirname(image_path)
        source_base, _ = os.path.splitext(source_filename)
        output_filename = f"{source_base}{ext}"
        save_path = os.path.join(source_dir, output_filename)
        
        print(f"[COMFY VIDEO] Saving output video/animated media to {save_path}")
        with open(save_path, "wb") as out_file:
            out_file.write(view_res.content)
            
        # Delete temp file from ComfyUI server folder to avoid accumulation
        try:
            folder_type = file_info.get("type", "output")
            folder_name = "temp" if folder_type == "temp" else "output"
            comfy_temp_file = os.path.normpath(os.path.join(COMFYUI_DIR, folder_name, file_info.get("subfolder", ""), completed_filename))
            if os.path.exists(comfy_temp_file):
                os.remove(comfy_temp_file)
                print(f"[COMFY VIDEO] Cleaned up temp output video: {comfy_temp_file}")
        except Exception as e_clean:
            print(f"[COMFY VIDEO] Warning: Failed to clean up temp file: {e_clean}")
            
        # Calculate relative public web server URL
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
        # Clean up temporary input image from ComfyUI input directory
        try:
            if os.path.exists(comfy_input_path):
                os.remove(comfy_input_path)
        except Exception as e:
            print(f"[COMFY VIDEO] Warning: Failed to delete temp input image {comfy_input_path}: {e}")

# ==============================================================================
# GENERALIST FILE AND BACKGROUND EXECUTION SYSTEM
# ==============================================================================

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
def run_command_async(command: str, cwd: str = "", wait_seconds: float = 6.0) -> str:
    """Spawns a shell command in the background, waits briefly for startup logs, and returns its task ID and initial output.

    Args:
        command: The shell command to run.
        cwd: Optional working directory (defaults to the active project workspace folder).
        wait_seconds: Seconds to wait for initial startup output before returning (default 6.0).

    Returns:
        A status message with the task ID and initial output, or an error.
    """
    try:
        target_cwd = resolve_workspace_cwd(cwd)
        if not confirm_tool_execution("run_command_async", f"CWD: {target_cwd}\nCommand:\n{command}"):
            return "Error: Tool execution denied by user."

        task_id = f"task_{int(time.time())}_{uuid.uuid4().hex[:4]}"
        
        process = lifecycle.track(subprocess.Popen(
            command,
            shell=True,
            cwd=target_cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1
        ))
        
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
            'cwd': target_cwd,
            'process': process,
            'stdout': stdout_log,
            'stderr': stderr_log,
            'start_time': time.time(),
            'threads': (t1, t2)
        }
        
        with tasks_lock:
            background_tasks[task_id] = task_info

        wait_limit = max(0.0, min(float(wait_seconds or 0.0), 15.0))
        start_wait = time.time()
        while time.time() - start_wait < wait_limit:
            if process.poll() is not None:
                break
            time.sleep(0.25)

        poll = process.poll()
        status = "running" if poll is None else f"exited ({poll})"
        stdout_txt = "".join(stdout_log).strip()
        stderr_txt = "".join(stderr_log).strip()

        output = (
            f"Task ID: {task_id}\n"
            f"Status: {status}\n"
            f"Working Directory: {target_cwd}\n"
            f"Command: `{command}`"
        )
        if stdout_txt:
            output += f"\n--- Initial Standard Output ---\n{stdout_txt[-1500:]}"
        if stderr_txt:
            output += f"\n--- Initial Standard Error ---\n{stderr_txt[-1500:]}"
        return output
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
        normalized_path = resolve_workspace_path(path)
        if not confirm_tool_execution("replace_file_content", f"Path: {normalized_path}\nLines: {start_line}-{end_line}\nTarget Preview:\n{target_content[:200]}\nReplacement Preview:\n{replacement_content[:200]}"):
            return "Error: Tool execution denied by user."
            
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist at '{normalized_path}'."
            
        with open(normalized_path, "r", encoding="utf-8") as f:
            lines = f.readlines()
            
        start_line = int(start_line)
        end_line = int(end_line)
        if start_line < 1 or end_line > len(lines) or start_line > end_line:
            return f"Error: Invalid line range {start_line}-{end_line}. File has {len(lines)} lines."
            
        actual_subset = "".join(lines[start_line-1:end_line])
        
        def normalize(s):
            return s.replace('\r\n', '\n').strip()
            
        if normalize(actual_subset) != normalize(target_content):
            return f"Error: Content within lines {start_line}-{end_line} does not match target_content.\nActual:\n{actual_subset}\nTarget:\n{target_content}"
            
        if replacement_content and not replacement_content.endswith("\n") and end_line < len(lines):
            replacement_content += "\n"
        new_lines = lines[:start_line-1] + [replacement_content] + lines[end_line:]
        
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.writelines(new_lines)
            
        return f"Successfully modified lines {start_line}-{end_line} in '{normalized_path}'."
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
        normalized_path = resolve_workspace_path(path)
        preview_lines = []
        for i, chunk in enumerate(replacement_chunks):
            preview_lines.append(f"Chunk {i+1} (Lines {chunk.get('start_line')}-{chunk.get('end_line')}):\nTarget: {chunk.get('target_content')[:100]}\nReplacement: {chunk.get('replacement_content')[:100]}")
        preview_text = "\n\n".join(preview_lines)
        if not confirm_tool_execution("multi_replace_file_content", f"Path: {normalized_path}\n\n{preview_text}"):
            return "Error: Tool execution denied by user."
            
        if not os.path.exists(normalized_path):
            return f"Error: File '{path}' does not exist at '{normalized_path}'."
            
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
            if replacement and not replacement.endswith("\n") and end_line < len(lines):
                replacement += "\n"
            lines = lines[:start_line-1] + [replacement] + lines[end_line:]
            
        with open(normalized_path, "w", encoding="utf-8") as f:
            f.writelines(lines)
            
        return f"Successfully applied {len(replacement_chunks)} replacements to '{normalized_path}'."
    except Exception as e:
        return f"Error modifying file '{path}': {e}"

@track_tool_activity
def add_quest(title: str, notes: str, due: str = None, location: str = "", reminder_minutes: int = 15) -> str:
    """Creates a new quest and adds it to the user's quest log.
    
    Args:
        title: Title/name of the quest.
        notes: Objectives of the quest, separated by newlines or commas.
        due: Target local date/time as ISO 8601 (e.g. "2026-10-29T09:00"). Defaults to now.
        location: Optional location coordinates or address.
        reminder_minutes: Optional alert/alarm trigger in minutes before due.
    """
    from datetime import datetime
    from core import quest_manager

    try:
        due_dt = quest_manager.parse_due(due) if due else datetime.now().astimezone()
    except ValueError:
        return f"Error adding quest: due '{due}' is not ISO 8601. Use the local format YYYY-MM-DDTHH:MM."

    try:
        reminder_min_val = int(reminder_minutes)
    except (ValueError, TypeError):
        reminder_min_val = 15

    raw_notes = notes.replace('\\n', '\n')
    objectives = [line.strip() for line in raw_notes.split('\n') if line.strip()] or [notes.strip()]

    try:
        quest = quest_manager.add_quest(title.strip(), objectives, due_dt, location.strip(), reminder_min_val)
    except Exception as e:
        return f"Error adding quest: {e}"
    if quest is None:
        return f"Quest '{title.strip()}' is already in the log."
    return f"Successfully added quest: '{quest['title']}' due {due_dt.strftime('%A, %B %d at %I:%M %p')} with {len(objectives)} objectives."

@track_tool_activity
def add_journal_entry(keyphrases: str, content: str) -> str:
    """Saves a memory journal entry for the active program.
    
    Args:
        keyphrases: Comma separated keywords or phrases that trigger this memory.
        content: The specific, important detail or memory to record (up to 300 characters).
    """
    try:
        from tools.journals import add_journal_entry as add_entry
        from runners.program import get_active_program
        active_prog = get_active_program()
        entry = add_entry(keyphrases, content, active_prog)
        return f"Successfully saved memory journal entry: {entry.get('content')}"
    except Exception as e:
        return f"Error saving memory journal entry: {e}"


@track_tool_activity
def search_music(query: str, mode: str = "deep_cuts") -> str:
    """Searches for music, deep cuts, forgotten artists, and obscure recordings with cultural lore.
    
    Args:
        query: Search term, artist, track, album, mood, or thematic topic.
        mode: Discovery mode ('deep_cuts', 'kexp', 'theme_time', 'bandcamp', 'artist').
    
    Returns:
        Curated list of matching artists, recordings, and liner notes.
    """
    import re
    from concurrent.futures import ThreadPoolExecutor

    mode_lower = (mode or "deep_cuts").lower().strip()
    raw_query = query.strip()

    # Strip meta query wrappers for clean entity extraction
    cleaned = re.sub(
        r"\b(deep cuts|obscure tracks|obscure songs|obscure artists|music like|songs like|artists like|similar to|find me|recommendations for|recommend)\b",
        "",
        raw_query,
        flags=re.IGNORECASE
    ).strip(" :-,")

    clean_query = cleaned if cleaned else raw_query
    results = []

    # 1. MusicBrainz Structured Discovery
    try:
        import musicbrainzngs
        musicbrainzngs.set_useragent("Sanctuary", "1.0", "https://github.com/sanctuary")

        # Artist search
        if mode_lower in ("artist", "deep_cuts", "kexp"):
            artist_res = musicbrainzngs.search_artists(artist=clean_query, limit=3)
            for artist in artist_res.get("artist-list", []):
                name = artist.get("name", "")
                mbid = artist.get("id", "")
                area = artist.get("area", {}).get("name", "")
                tags = ", ".join(t.get("name", "") for t in artist.get("tag-list", [])[:5])
                disambig = artist.get("disambiguation", "")
                meta_parts = []
                if area:
                    meta_parts.append(f"Origin: {area}")
                if tags:
                    meta_parts.append(f"Tags: {tags}")
                if disambig:
                    meta_parts.append(f"Note: {disambig}")
                results.append({
                    "title": f"Artist: {name}",
                    "url": f"https://musicbrainz.org/artist/{mbid}",
                    "details": " | ".join(meta_parts) if meta_parts else "MusicBrainz Artist",
                    "source": "MusicBrainz"
                })

        # Recording / track search
        rec_res = musicbrainzngs.search_recordings(query=clean_query, limit=4)
        for rec in rec_res.get("recording-list", []):
            title = rec.get("title", "")
            mbid = rec.get("id", "")
            artist_credit = ", ".join(
                a.get("artist", {}).get("name", "")
                for a in rec.get("artist-credit", [])
                if isinstance(a, dict)
            )
            releases = rec.get("release-list", [])
            album = releases[0].get("title", "") if releases else ""
            date = releases[0].get("date", "") if releases else ""
            desc_parts = []
            if artist_credit:
                desc_parts.append(f"by {artist_credit}")
            if album:
                desc_parts.append(f"Album: '{album}'")
            if date:
                desc_parts.append(f"Year: {date[:4]}")
            results.append({
                "title": f"Track: '{title}'",
                "url": f"https://musicbrainz.org/recording/{mbid}",
                "details": " | ".join(desc_parts) if desc_parts else "MusicBrainz Recording",
                "source": "MusicBrainz"
            })
    except Exception as e:
        print(f"[MusicBrainz Search Error] {e}")

    # 2. Targeted Crate-Digging Queries
    crate_queries = []
    if mode_lower == "kexp":
        crate_queries.append(f"site:kexp.org {clean_query}")
        crate_queries.append(f"{clean_query} \"similar artists\" OR \"KEXP session\"")
    elif mode_lower == "theme_time":
        crate_queries.append(f"site:themetimeradio.com {clean_query}")
        crate_queries.append(f"\"{clean_query}\" \"Theme Time Radio Hour\"")
    elif mode_lower == "bandcamp":
        crate_queries.append(f"site:bandcamp.com/album {clean_query}")
        crate_queries.append(f"site:bandcamp.com/tag/{clean_query.replace(' ', '-')}")
    else:  # deep_cuts (default)
        crate_queries.append(f"site:rateyourmusic.com/list \"{clean_query}\"")
        crate_queries.append(f"\"{clean_query}\" \"similar artists\" OR \"sounds like\" OR \"underrated\"")
        crate_queries.append(f"site:bandcamp.com {clean_query}")

    def run_web_query(q_str):
        try:
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS
            ddgs = DDGS(timeout=5)
            hits = ddgs.text(q_str, max_results=3)
            out = []
            junk_keywords = ("buy vinyl", "180 gram", "add to cart", "marketplace", "shipping", "seller rating", "in stock")
            for h in (hits or []):
                u = h.get("href", "")
                t = h.get("title", "")
                b = h.get("body", "")
                if u and not any(k in t.lower() or k in b.lower() for k in junk_keywords):
                    out.append({
                        "title": t,
                        "url": u,
                        "details": b,
                        "source": "Crate Digger"
                    })
            return out
        except Exception:
            return []

    with ThreadPoolExecutor(max_workers=len(crate_queries) or 1) as pool:
        web_res_lists = pool.map(run_web_query, crate_queries)
        for wlist in web_res_lists:
            results.extend(wlist)

    if not results:
        return f"No music results found for '{query}' (mode: {mode})."

    # Deduplicate by URL or title
    seen = set()
    formatted = []
    for r in results:
        key = (r.get("url") or r.get("title", "")).lower()
        if key in seen:
            continue
        seen.add(key)
        formatted.append(f"• {r['title']}\n  Details: {r['details']}\n  Link: {r['url']}\n  Source: {r['source']}")

    return f"[Music Discovery: Mode='{mode_lower}', Query='{clean_query}']\n\n" + "\n\n".join(formatted[:8])