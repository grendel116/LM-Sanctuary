import asyncio
import os
import time
import uuid
import functools
import threading
import contextvars
import concurrent.futures

import requests

from adapters.vram_orchestrator import serialized_gpu_operation
from utils.image_cancellation import register_image_operation, activate_image_operation, current_event

_search_executor = concurrent.futures.ThreadPoolExecutor(max_workers=10)

active_running_tools = {}
_active_tools_lock = threading.Lock()

MAX_IMAGES_PER_ROW = 2

current_session_id = contextvars.ContextVar('current_session_id', default='default')
current_speaker_id = contextvars.ContextVar('current_speaker_id', default=None)
current_portrait_slot_callback = contextvars.ContextVar('current_portrait_slot_callback', default=None)
current_turn_image_budget = contextvars.ContextVar('current_turn_image_budget', default=None)
current_plan_mode = contextvars.ContextVar('current_plan_mode', default=False)
current_write_disengaged = contextvars.ContextVar('current_write_disengaged', default=False)
current_approved_plan = contextvars.ContextVar('current_approved_plan', default='')
current_runner = contextvars.ContextVar('current_runner', default=None)
session_tool_calls = {}
session_tool_calls_lock = threading.Lock()

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
        except asyncio.CancelledError:
            duration = round(time.time() - start_time, 2)
            with session_tool_calls_lock:
                tool_call_info['status'] = 'cancelled'
                tool_call_info['response'] = 'Cancelled by user.'
                tool_call_info['duration'] = duration
            raise
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
    programs_root = os.path.normcase(os.path.normpath(os.path.join(os.getcwd(), 'core', 'programs')))
    folders = [default_folder]
    try:
        loaded_folders = settings.get("folders", [])
        if loaded_folders:
            cleaned = [os.path.normpath(f) for f in loaded_folders if f]
            if cleaned:
                norm_first = os.path.normcase(cleaned[0])
                if (norm_first == programs_root or norm_first.startswith(programs_root + os.sep)) and cleaned[0] != default_folder:
                    cleaned[0] = default_folder
                folders = cleaned
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
    repo_parent = os.path.dirname(root_dir)
    if os.path.isdir(repo_parent):
        return os.path.normpath(repo_parent)
    return root_dir


def _find_git_root(start_dir: str) -> str:
    """Walk upward from `start_dir` looking for `.git`, returning the repo root or ''."""
    cur = os.path.abspath(start_dir)
    while True:
        if os.path.exists(os.path.join(cur, ".git")):
            return os.path.normpath(cur)
        parent = os.path.dirname(cur)
        if parent == cur:
            return ""
        cur = parent


def _is_managed_program_subdir(path: str) -> bool:
    programs_dir = os.path.normcase(os.path.normpath(os.path.join(root_dir, "core", "programs")))
    cand = os.path.normcase(os.path.normpath(path))
    return cand == programs_dir or cand.startswith(programs_dir + os.sep)


def resolve_coding_workspace(raw_path: str = "") -> tuple[str, str, str]:
    """Pin coding workspace to the git root, validate `raw_path`, and warn on missing paths.

    Returns `(repo_root, focus_relpath, missing_hint_warning)`.
    """
    folders = [f for f in get_project_folders() if isinstance(f, str) and os.path.isdir(f)]
    non_persona = [os.path.normpath(f) for f in folders if not _is_managed_program_subdir(f)]
    if non_persona:
        default_base = non_persona[0]
    else:
        repo_parent = os.path.normpath(os.path.dirname(root_dir))
        default_base = repo_parent if os.path.isdir(repo_parent) else root_dir

    default_root = _find_git_root(default_base) or default_base
    clean_raw = (raw_path or "").strip()
    if not clean_raw:
        return default_root, "", ""

    candidates: list[str] = []
    norm_raw = os.path.normpath(clean_raw)
    if os.path.isabs(norm_raw):
        candidates.append(norm_raw)
    else:
        candidates.append(os.path.normpath(os.path.join(default_root, norm_raw)))
        candidates.append(resolve_workspace_path(clean_raw))

    existing_target = next((c for c in candidates if os.path.exists(c)), "")
    if existing_target:
        target_dir = existing_target if os.path.isdir(existing_target) else os.path.dirname(existing_target)
        pinned_root = _find_git_root(target_dir) or target_dir
        try:
            rel = os.path.relpath(existing_target, pinned_root).replace("\\", "/")
        except ValueError:
            rel = ""
        focus_rel = "" if rel in ("", ".") else rel
        return pinned_root, focus_rel, ""

    skip_dirs = {"__pycache__", "node_modules", ".git", ".venv", ".ruff_cache", ".pytest_cache"}
    try:
        top_dirs = sorted(
            d for d in os.listdir(default_root)
            if os.path.isdir(os.path.join(default_root, d))
            and not d.startswith(".")
            and d not in skip_dirs
        )[:20]
    except OSError:
        top_dirs = []
    dirs_hint = ", ".join(top_dirs) if top_dirs else "(none)"
    warning = (
        f"Note: Requested path '{clean_raw}' does not exist in {default_root}. "
        f"Actual top-level directories: {dirs_hint}."
    )
    return default_root, "", warning

# Global memory dict to hold tool confirmation states for mobile/web human-in-the-loop approvals
pending_tool_calls = {}
pending_browser_commands = {}
pending_browser_commands_lock = threading.Lock()


def cancel_pending_tool_confirmations(session_id: str | None = None) -> int:
    """Deny and wake any pending HITL tool approvals and browser commands matching the session."""
    woken = 0
    for _call_id, info in list(pending_tool_calls.items()):
        if not isinstance(info, dict) or info.get('status') != 'pending':
            continue
        info_sid = info.get('session_id')
        if session_id is None or info_sid is None or info_sid == session_id:
            info['status'] = 'denied'
            event = info.get('event')
            if event:
                event.set()
            woken += 1
    with pending_browser_commands_lock:
        for _cmd_id, cmd_info in list(pending_browser_commands.items()):
            if not isinstance(cmd_info, dict) or cmd_info.get('status') != 'pending':
                continue
            cmd_sid = cmd_info.get('session_id')
            if session_id is None or cmd_sid is None or cmd_sid == session_id:
                cmd_info['status'] = 'cancelled'
                cmd_ev = cmd_info.get('event')
                if cmd_ev:
                    cmd_ev.set()
                woken += 1
    return woken


def confirm_tool_execution(tool_name: str, details: str) -> bool:
    sess_id = current_session_id.get()
    try:
        from runners.runner import cancelled_sessions
        if sess_id and sess_id in cancelled_sessions:
            return False
    except Exception:
        pass

    try:
        from runners.program import _load_settings
        settings = _load_settings()
        if settings.get("security_preset") in ("auto", "turbo", "auto_approve"):
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
        'event': event,
        'session_id': sess_id,
    }
    
    timeout = 300.0  # Allow up to 5 minutes for human confirmation
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


def request_user_choice(
    question: str,
    options: list[str] | None = None,
    tool_name: str = "ask_user",
    timeout: float = 120.0,
) -> dict:
    """Surface an interactive multiple-choice question card in the active Sanctuary chat session."""
    sess_id = current_session_id.get()
    try:
        from runners.runner import cancelled_sessions
        if sess_id and sess_id in cancelled_sessions:
            return {"status": "cancelled", "option_index": None, "answer_text": ""}
    except Exception:
        pass

    clean_options = [str(o).strip() for o in (options or []) if str(o).strip()][:6]
    call_id = str(uuid.uuid4())
    event = threading.Event()
    pending_tool_calls[call_id] = {
        "kind": "choice",
        "tool_name": tool_name,
        "details": str(question or "").strip(),
        "options": clean_options,
        "status": "pending",
        "option_index": None,
        "answer_text": "",
        "event": event,
        "session_id": sess_id,
    }

    event.wait(timeout)
    info = pending_tool_calls.pop(call_id, None) or {}
    return {
        "status": info.get("status", "timeout"),
        "option_index": info.get("option_index"),
        "answer_text": str(info.get("answer_text") or "").strip(),
    }


# ==============================================================================
# WEB BROWSING & RESEARCH TOOLS
# ==============================================================================

@track_tool_activity
def read_webpage(url: str) -> str:
    """Fetches and extracts the readable text content of a specific webpage URL as structured Markdown.
    Tries zero-cost static extraction locally first and escalates to Cloud `/v1/tools/crawl/scrape`
    when pages are JS-rendered, sparse, or blocked.
    """
    import re
    from bs4 import BeautifulSoup
    from markdownify import markdownify as md
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    if not str(url or "").startswith(("http://", "https://")):
        return "Error: Invalid URL. The URL must start with http:// or https://"

    from utils.url_privacy import strip_tracking_params
    clean_url = strip_tracking_params(url)

    markdown_text = ""
    local_err_msg = ""

    try:
        import primp
        client = primp.Client(timeout=12, verify=False, follow_redirects=True)
        response = client.get(clean_url)
        if response.status_code == 200 and response.text:
            soup = BeautifulSoup(response.text, "html.parser")
            for element in soup(["script", "style", "nav", "header", "footer", "meta", "noscript", "svg", "iframe", "form", "aside", "img", "figure"]):
                element.decompose()
            content_area = soup.find("main") or soup.find("article") or soup.find("body") or soup
            from urllib.parse import urljoin
            for anchor in content_area.find_all("a", href=True):
                href = str(anchor.get("href") or "").strip()
                if href and not href.startswith(("#", "mailto:", "javascript:", "tel:")):
                    anchor["href"] = urljoin(clean_url, href)
            markdown_text = md(str(content_area), heading_style="ATX", bullets="-")
            markdown_text = re.sub(r"!\[.*?\]\(.*?\)", "", markdown_text)
            markdown_text = re.sub(r"\n{3,}", "\n\n", markdown_text).strip()
        else:
            local_err_msg = f"HTTP status code: {response.status_code}"
    except Exception as e:
        local_err_msg = str(e)

    # Escalate to Cloud crawl/scrape when static fetch failed or returned a JS shell (< 240 chars)
    if len(markdown_text) < 240:
        try:
            from core import v1_client
            scraped_md = v1_client.scrape_markdown(clean_url)
            if scraped_md and len(scraped_md) > len(markdown_text):
                markdown_text = scraped_md
        except Exception:
            pass

    limit = 6000
    if len(markdown_text) > limit:
        return markdown_text[:limit] + f"\n\n... [Content truncated, total length: {len(markdown_text)} characters] ..."

    if not markdown_text.strip():
        if local_err_msg:
            return f"Error: Failed to fetch webpage ({local_err_msg})."
        return "Error: Webpage loaded, but no readable content could be extracted."

    return markdown_text


@track_tool_activity
def open_in_browser(url: str, split: bool = False) -> str:
    """Open an HTTP/HTTPS URL directly inside the user's Sanctuary Browser tab (or side-by-side split view).

    Args:
        url: The HTTP/HTTPS web address to open for the user.
        split: When True, opens the link beside the active tab in 2-pane Browser Split View.

    Returns:
        Confirmation message describing the opened Browser tab.
    """
    raw_url = str(url or "").strip()
    if not raw_url.startswith(("http://", "https://")):
        return "Error: Invalid URL. The URL must start with http:// or https://"

    from utils.url_privacy import strip_tracking_params

    clean_url = strip_tracking_params(raw_url)
    sess_id = current_session_id.get()
    with session_tool_calls_lock:
        for entry in reversed(session_tool_calls.get(sess_id, [])):
            if entry.get("name") == "open_in_browser" and "client_action" not in entry:
                entry["client_action"] = {
                    "type": "open_browser_tab",
                    "url": clean_url,
                    "split": bool(split),
                }
                break

    return f"Opened {clean_url} in Sanctuary Browser{' split view' if split else ''}."


@track_tool_activity
def browser_action(
    action: str = "snapshot",
    url: str = "",
    ref: str = "",
    text: str = "",
    tab_id: str = "",
    direction: str = "down",
    key: str = "",
    clear: bool = True,
    split: bool = False,
    new_tab: bool = False,
    timeout: float = 22.0,
    **kwargs,
) -> str:
    """Interact directly with the user's live Sanctuary Browser workspace.

    Supported `action` values:
    - `list_tabs`: List open Browser tabs, URLs, titles, and active tab ID.
    - `snapshot`: Read Sanctuary Browser's live DOM outline with interactive `[e1]`, `[e2]` element refs (passwords masked).
    - `read`: Read clean rendered text from the active (or `tab_id`) Browser tab.
    - `open` / `navigate`: Open a URL or search query (`url="https://..."` or `url="@eco query"`) in the Browser.
    - `back` / `forward` / `close_tab`: Step Browser history or close a tab.
    - `click`: Click element `ref="e12"` from the latest `snapshot` (gated by write confirmation).
    - `type`: Type `text="..."` into input `ref="e5"` (`clear=True` by default).
    - `select`: Choose option `text="..."` on `<select>` `ref="e8"`.
    - `press`: Press keyboard key `key="Enter"` / `"Escape"` / `"PageDown"`.
    - `scroll`: Scroll `direction="down"|"up"` (or scroll `ref` into view).
    - `wait_text`: Wait until `text="..."` renders in the tab.
    """
    import json

    clean_action = str(action or "snapshot").strip().lower()
    alias_map = {
        "get_snapshot": "snapshot",
        "inspect": "snapshot",
        "get_page_text": "read",
        "read_text": "read",
        "open_tab": "open",
        "navigate_tab": "navigate",
        "search": "open",
        "click_element": "click",
        "type_text": "type",
        "select_option": "select",
        "press_keys": "press",
        "scroll_page": "scroll",
        "wait_for_text": "wait_text",
    }
    clean_action = alias_map.get(clean_action, clean_action)

    valid_actions = {
        "list_tabs",
        "snapshot",
        "read",
        "open",
        "navigate",
        "back",
        "forward",
        "close_tab",
        "click",
        "type",
        "select",
        "press",
        "scroll",
        "wait_text",
    }
    if clean_action not in valid_actions:
        return f"Error: Unsupported browser_action '{clean_action}'. Valid actions: {', '.join(sorted(valid_actions))}."

    clean_ref = str(ref or kwargs.get("element") or "").strip().strip("[]")
    clean_url = str(url or kwargs.get("query") or "").strip()
    clean_text = str(text if text != "" else (kwargs.get("value") or "")).strip()
    clean_key = str(key or (clean_text if clean_action == "press" else "Enter")).strip()

    if clean_action in ("click", "type", "select") and not clean_ref:
        return f"Error: `ref` (e.g. 'e4' from `browser_action(action=\"snapshot\")`) is required for `{clean_action}`."

    # Sanctuary Write Gate: confirm with user before acting on page controls when security_preset == ask_always
    if clean_action in ("click", "type", "select", "press"):
        gate_details = {"action": clean_action}
        if clean_ref:
            gate_details["ref"] = clean_ref
        if clean_action == "type":
            gate_details["text"] = clean_text[:200]
        elif clean_action == "select":
            gate_details["option"] = clean_text[:120]
        elif clean_action == "press":
            gate_details["key"] = clean_key
        if tab_id:
            gate_details["tab_id"] = tab_id
        if not confirm_tool_execution(f"browser:{clean_action}", json.dumps(gate_details, indent=2, ensure_ascii=False)):
            return f"Browser `{clean_action}` action was declined by the user."

    sess_id = current_session_id.get()
    cmd_id = f"bcmd_{uuid.uuid4().hex[:10]}"
    ev = threading.Event()
    cmd_payload = {
        "cmd_id": cmd_id,
        "session_id": sess_id,
        "action": clean_action,
        "args": {
            "url": clean_url,
            "ref": clean_ref,
            "text": clean_text,
            "tab_id": str(tab_id or "").strip(),
            "direction": str(direction or "down").strip().lower(),
            "key": clean_key,
            "clear": bool(clear),
            "split": bool(split),
            "new_tab": bool(new_tab),
        },
        "status": "pending",
        "event": ev,
        "result": None,
    }

    with pending_browser_commands_lock:
        pending_browser_commands[cmd_id] = cmd_payload

    ev.wait(max(2.0, float(timeout)))
    with pending_browser_commands_lock:
        finished = pending_browser_commands.pop(cmd_id, None) or {}

    if finished.get("status") == "cancelled":
        return "Browser action cancelled."
    res = finished.get("result")
    if not isinstance(res, dict):
        return (
            "No active Sanctuary Browser UI responded to this command (ensure LM-Sanctuary is open in the desktop/web window). "
            "You can still use `web_search` and `read_webpage` for background research."
        )

    if not res.get("ok"):
        return f"Browser Error ({res.get('error') or 'failed'}): {res.get('message') or 'Could not complete browser action.'}"

    header = f"[Sanctuary Browser · {clean_action}]"
    if res.get("title") or res.get("url"):
        header += f"\nPage: {res.get('title') or '(untitled)'} — {res.get('url') or ''}"

    if clean_action == "list_tabs":
        tabs = res.get("tabs") or []
        if not tabs:
            return f"{header}\n(No open tabs)"
        t_lines = [
            f"- {'*' if t.get('active') else ' '} [{t.get('id')}] {t.get('title') or 'Tab'} — {t.get('url') or ''}"
            for t in tabs
        ]
        return f"{header}\n" + "\n".join(t_lines)

    if clean_action == "snapshot":
        snap = str(res.get("snapshot") or "").strip()
        if len(snap) > 8000:
            snap = snap[:8000] + "\n... [Snapshot truncated; pass ref='eN' to inspect a specific subtree]"
        return f"{header}\n{snap or '(Empty page snapshot)'}"

    if clean_action == "read":
        body = str(res.get("text") or "").strip()
        if len(body) > 7000:
            body = body[:7000] + "\n... [Page text truncated]"
        return f"{header}\n{body or '(No visible text on page)'}"

    if clean_action == "type":
        return f"{header}\nTyped into [{clean_ref}] -> field value: {res.get('value', '')}"
    if clean_action == "wait_text":
        return f"{header}\nText {'found' if res.get('found') else 'not found before timeout'}: {clean_text}"

    return f"{header}\nCompleted `{clean_action}`."


def query_searxng(query: str, base_url: str = None, engines: str = "") -> list:
    """Query a user-configured self-hosted SearXNG instance (returns [] if no `base_url` is set)."""
    clean_base = (base_url or "").strip().rstrip("/")
    if not clean_base:
        return []
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    try:
        params = {"q": query, "format": "json"}
        if engines:
            params["engines"] = engines
        response = requests.get(f"{clean_base}/search", params=params, headers=headers, timeout=4.0)
        if response.status_code == 200:
            results = response.json().get("results", [])
            return [
                {
                    "title": r.get("title", "Web Result"),
                    "url": r["url"],
                    "content": r.get("content", ""),
                    "source": "SearXNG",
                }
                for r in results[:6]
                if r.get("url")
            ]
    except Exception as e:
        print(f"[SearXNG] Failed to query instance {clean_base}: {e}")
    return []


@track_tool_activity
def web_search(query: str) -> str:
    """Searches the web via GreenPT `/v1/tools/websearch` (with custom SearXNG / DuckDuckGo fallback)
    and specialized domain APIs (`github:`, `arxiv:`, `hn:`, `wikipedia:`, `music:`).
    """
    import concurrent.futures
    import time

    search_engine = "web_crawling"
    searxng_url = ""
    browser_search_engine = ""
    try:
        from runners.program import _load_settings
        settings = _load_settings()
        search_engine = settings.get("search_engine", "web_crawling")
        searxng_url = str(settings.get("searxng_url") or "").strip()
        browser_search_engine = str(settings.get("browser_search_engine") or "").strip().lower()
        if browser_search_engine == "ddg":
            browser_search_engine = "duckduckgo"
    except Exception as e:
        print(f"Error loading search settings: {e}")

    if search_engine not in ("web_crawling", "wikipedia"):
        search_engine = "web_crawling"

    def run_duckduckgo(q):
        try:
            try:
                from ddgs import DDGS
            except ImportError:
                from duckduckgo_search import DDGS
            hits = DDGS().text(q, max_results=6)
            return [
                {
                    "title": h.get("title", ""),
                    "url": h.get("href", ""),
                    "content": h.get("body", ""),
                    "source": "DuckDuckGo",
                }
                for h in (hits or [])
                if h.get("href")
            ]
        except Exception as e:
            print(f"[DuckDuckGo] Error: {e}")
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
    cloud_note = ""

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
        if search_engine == "wikipedia" or browser_search_engine == "wikipedia":
            results_pool = run_wikipedia(query)
        elif search_engine == "web_crawling":
            from core import v1_client

            collected_hits = []
            used_greenpt = False

            if searxng_url:
                collected_hits.extend(query_searxng(query, base_url=searxng_url))

            try:
                greenpt_hits = v1_client.websearch(query, count=6, full_page_content="auto")
                if greenpt_hits:
                    collected_hits.extend(greenpt_hits)
                    used_greenpt = True
            except Exception as e:
                cloud_note = f"[Cloud search unavailable: {e}. Results below come from fallback search.]"
                print(f"[Cloud WebSearch] Fallback to local search ({e})", flush=True)

            if not collected_hits:
                collected_hits.extend(run_duckduckgo(query))

            seen_urls = set()
            unique_results = []
            for r in collected_hits:
                url_clean = r["url"].lower().strip().rstrip("/")
                compare_url = url_clean.replace("https://m.", "https://www.").replace("http://m.", "http://www.")
                if compare_url not in seen_urls:
                    seen_urls.add(compare_url)
                    unique_results.append(r)

            if not unique_results:
                for r in run_wikipedia(query):
                    url_clean = r["url"].lower().strip().rstrip("/")
                    compare_url = url_clean.replace("https://m.", "https://www.").replace("http://m.", "http://www.")
                    if compare_url not in seen_urls:
                        seen_urls.add(compare_url)
                        unique_results.append(r)

            results_pool = unique_results
            if not used_greenpt:
                enrich_thin_results(results_pool)

    if not results_pool:
        return f"{cloud_note}\nNo search results found.".strip()

    lines = []
    for r in results_pool[:10]:
        lines.append(f"Title: {r['title']}\nURL: {r['url']}\nSource: {r['source']}\nSnippet: {r['content']}")
    if cloud_note:
        return "\n\n".join([cloud_note, *lines])
    return "\n\n".join(lines)


@track_tool_activity
def google_search(query: str) -> str:
    """Wrapper that delegates search queries to web_search."""
    return web_search(query)


@track_tool_activity
def list_tools(topic: str = "") -> str:
    """Load exact `[tool_name(...)]` tags and usage rules for a capability topic on demand."""
    from core.skill_retriever import _get_skill_registry, format_skill_records, retrieve_matched_skill_records

    clean_topic = str(topic or "").strip()
    if clean_topic:
        matched = retrieve_matched_skill_records(query=clean_topic, story_active=False, threshold=0.25, top_k=3)
        if matched:
            return format_skill_records(matched)

    lines = ["# AVAILABLE SANCTUARY TOOLS"]
    for rec in _get_skill_registry():
        summary = rec.get("summary", "").strip()
        if summary:
            lines.append(f"- {rec['name']}: {summary}")
    return "\n".join(lines)


@track_tool_activity
def consult_cloud(prompt: str, tier: str = "fast", context: str = "") -> str:
    """Pass deep synthesis, architectural reasoning, or long-context analysis to the configured Cloud /v1 model (Gear 2)
    without opening a workspace shell/coding session.

    Args:
        prompt: Exact analytical question or synthesis task for the cloud model.
        tier: 'fast' (`glm-5.3-flash`, default) or 'deep' (`glm-5.3` / configured default).
        context: Optional supporting facts, excerpts, or constraints.
    """
    from core import v1_client

    clean_prompt = str(prompt or "").strip()
    if not clean_prompt:
        return "Error: `prompt` must not be empty when calling consult_cloud."

    if not v1_client.is_v1_enabled(require_coop_extensions=False):
        return (
            "Cloud baton unavailable (routing policy is 'local_only', API key is unset, or credits are exhausted). "
            "Continue directly with local reasoning."
        )

    user_content = f"{clean_prompt}\n\nContext:\n{context.strip()}" if str(context or "").strip() else clean_prompt
    messages = [
        {
            "role": "system",
            "content": (
                "Provide a rigorous, high-precision, evidence-grounded synthesis so the local Sanctuary Program "
                "can present an accurate answer in its own voice. Explicitly flag concrete specifics, correct any "
                "misconceptions or prior errors, and state clearly if a detail cannot be verified. Do not add filler."
            ),
        },
        {"role": "user", "content": user_content},
    ]
    try:
        answer = v1_client.chat_completion(messages, tier=tier, temperature=0.3, max_tokens=4096)
        chosen = v1_client.resolve_v1_tier_model(tier=tier)
        return f"[CLOUD SYNTHESIS ({chosen})]\n{answer}" if answer else "Error: Empty cloud synthesis response."
    except v1_client.V1QuotaError as exc:
        return f"Cloud credits exhausted ({exc}). Continue directly with local reasoning."
    except Exception as exc:
        return f"Cloud synthesis unavailable ({exc}). Continue directly with local reasoning."

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
@register_image_operation
@serialized_gpu_operation
@activate_image_operation
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

    if not os.path.exists(workflow_path):
        return f"Error: Workflow template not found at '{workflow_path}'"

    budget_ref = current_turn_image_budget.get()
    if isinstance(budget_ref, list) and budget_ref:
        if budget_ref[0] <= 0:
            return f"Error: Maximum of {MAX_IMAGES_PER_ROW} images per message row reached."
        budget_ref[0] -= 1

    cancel_event = current_event()
    try:
        from adapters.vram_orchestrator import start_img
        from core.engine_diffusion import generate_portrait_image
        from runners.runner import cancelled_sessions

        start_img(cancel_event=cancel_event)
        sess_id = session_id or current_session_id.get()
        if (cancel_event and cancel_event.is_set()) or (sess_id and sess_id in cancelled_sessions):
            return "Error: Image generation cancelled by user."

        out_path = generate_portrait_image(
            prompt=str((parameters or {}).get("%prompt%", "")),
            negative_prompt=str((parameters or {}).get("%negative_prompt%", "worst quality, low quality, deformed, mutated, extra limbs, watermark, text")),
            workflow_path=workflow_path,
            save_path=save_path,
            replacements=parameters or {},
            cancel_event=cancel_event,
        )
        if cancel_event and cancel_event.is_set():
            if save_path and os.path.exists(save_path):
                os.remove(save_path)
            return "Error: Image generation cancelled by user."

        from utils import media_events
        media_events.notify()
        return out_path or save_path
    except Exception as e:
        if cancel_event and cancel_event.is_set():
            if save_path and os.path.exists(save_path):
                os.remove(save_path)
            return "Error: Image generation cancelled by user."
        return f"Error executing workflow: {e}"

@track_tool_activity
@register_image_operation
@serialized_gpu_operation
@activate_image_operation
def generate_local_image(prompt: str, count: int = MAX_IMAGES_PER_ROW, program_id: str = None) -> str:
    """Generates local portrait image(s) using ComfyUI with program-specific workflow configurations.
    
    Args:
        prompt: A prompt describing what you are doing or the scene/expression.
        count: Number of images to generate, from 1 to 2 (defaults to 2 for initial portrait generation, 1 for single slot reroll).
        program_id: Optional program ID whose positive/negative image details and portraits folder should be used.
        
    Returns:
        Markdown link(s) to the generated portrait image(s), or an error message.
    """
    import os
    import time
    import json
    
    from runners.program import get_active_program
    active_program = program_id or current_speaker_id.get() or get_active_program()

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
    final_prompt = replace_placeholders(prompt, program_id=active_program)
    if img_details_val:
        img_details_clean = replace_placeholders(img_details_val, program_id=active_program).strip()
        if img_details_clean:
            if final_prompt and not final_prompt.endswith(","):
                final_prompt += ", "
            final_prompt += img_details_clean

    base_negative = "worst quality, low quality, deformed, mutated, extra limbs, watermark, text"
    if neg_details_val and neg_details_val.strip():
        neg_clean = replace_placeholders(neg_details_val, program_id=active_program).strip().rstrip(",")
        final_negative = f"{neg_clean}, {base_negative}"
    else:
        final_negative = base_negative

    base_timestamp = int(time.time() * 1000)
    portraits_dir = os.path.normpath(os.path.join(root_dir, "core", "programs", active_program, "portraits"))
    os.makedirs(portraits_dir, exist_ok=True)
    num_images = max(1, min(MAX_IMAGES_PER_ROW, int(count or MAX_IMAGES_PER_ROW)))
    budget_ref = current_turn_image_budget.get()
    if isinstance(budget_ref, list) and budget_ref:
        if budget_ref[0] <= 0:
            return f"Error: Maximum of {MAX_IMAGES_PER_ROW} images per message row reached."
        num_images = min(num_images, budget_ref[0])
        budget_ref[0] -= num_images

    local_paths = []
    emitted_indices = set()

    def remove_cancelled_portraits():
        for idx, path in enumerate(local_paths):
            if idx in emitted_indices:
                continue
            for candidate in (path, os.path.splitext(path)[0] + ".json"):
                if os.path.exists(candidate):
                    os.remove(candidate)

    try:
        from adapters.vram_orchestrator import start_img
        from core.engine_diffusion import generate_portrait_image
        from runners.runner import cancelled_sessions
        from utils import media_events

        cancel_event = current_event()
        start_img(cancel_event=cancel_event)
        sess_id = current_session_id.get()
        if (cancel_event and cancel_event.is_set()) or sess_id in cancelled_sessions:
            return "Error: Portrait generation cancelled by user."

        stems = []
        local_filenames = []
        for idx in range(num_images):
            suffix = f"_{idx + 1}" if num_images > 1 else ""
            stem = f"portrait_{base_timestamp}{suffix}"
            local_filename = f"{stem}.png"
            stems.append(stem)
            local_filenames.append(local_filename)
            local_paths.append(os.path.join(portraits_dir, local_filename))

        def _write_sidecar(idx: int) -> None:
            if idx < 0 or idx >= len(stems):
                return
            json_path = os.path.join(portraits_dir, f"{stems[idx]}.json")
            try:
                with open(json_path, "w", encoding="utf-8") as jf:
                    json.dump(
                        {
                            "prompt": prompt,
                            "full_prompt": final_prompt,
                            "negative_prompt": final_negative,
                            "program_id": active_program,
                            "engine": "in_process_gpu",
                        },
                        jf,
                        indent=4,
                    )
            except Exception:
                pass

        slot_cb = current_portrait_slot_callback.get()
        on_ready_hook = None
        if slot_cb is not None:
            def _handle_slot_ready(idx: int, saved_path: str) -> None:
                if idx < 0 or idx >= len(local_filenames):
                    return
                if not saved_path or not os.path.exists(saved_path):
                    return
                _write_sidecar(idx)
                emitted_indices.add(idx)
                media_events.notify(active_program)
                slot_cb(idx, f"/images/portraits/{local_filenames[idx]}")
            on_ready_hook = _handle_slot_ready

        if num_images == 1:
            generate_portrait_image(
                prompt=final_prompt,
                negative_prompt=final_negative,
                save_path=local_paths[0],
                cancel_event=cancel_event,
                on_image_ready=on_ready_hook,
            )
        else:
            generate_portrait_image(
                prompt=final_prompt,
                negative_prompt=final_negative,
                save_paths=local_paths,
                cancel_event=cancel_event,
                on_image_ready=on_ready_hook,
            )

        if cancel_event and cancel_event.is_set():
            remove_cancelled_portraits()
            return "Error: Portrait generation cancelled by user."

        markdown_links = []
        for idx, local_filename in enumerate(local_filenames):
            if not os.path.exists(local_paths[idx]):
                continue
            if idx not in emitted_indices:
                _write_sidecar(idx)
            markdown_links.append(f"![Portrait](/images/portraits/{local_filename})")

        if cancel_event and cancel_event.is_set():
            remove_cancelled_portraits()
            return "Error: Portrait generation cancelled by user."
        media_events.notify(active_program)
        return "\n".join(markdown_links)
    except Exception as e:
        if current_event() and current_event().is_set():
            remove_cancelled_portraits()
            return "Error: Portrait generation cancelled by user."
        print(f"[engine_diffusion] Error generating portrait: {e}")
        return f"Error generating portrait: {e}"

@track_tool_activity
@register_image_operation
@serialized_gpu_operation
@activate_image_operation
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
    
    from variables.settings import COMFYUI_DIR, COMFYUI_SERVER_URL, get_workflow_path

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
    from utils.image_cancellation import cleanup_on_completion
    cleanup_on_completion(comfy_input_path)
    
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
    comfy_url = COMFYUI_SERVER_URL.rstrip("/")

    try:
        requests.get(f"{comfy_url}/system_stats", timeout=2.0).raise_for_status()
    except Exception:
        raise Exception("ComfyUI video server is offline.")

    print(f"[COMFY VIDEO] Populated workflow JSON:\n{json.dumps(populated_workflow, indent=2)}")
    print(f"[COMFY VIDEO] Submitting workflow to ComfyUI server: {comfy_url}")
    if current_event() and current_event().is_set():
        raise RuntimeError("Video generation cancelled by user.")
    
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
            if current_event() and current_event().is_set():
                requests.post(f"{comfy_url}/interrupt", timeout=3).raise_for_status()
                requests.post(f"{comfy_url}/queue", json={"delete": [prompt_id]}, timeout=3).raise_for_status()
                raise RuntimeError("Video generation cancelled by user.")
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
        if current_event() and current_event().is_set():
            raise RuntimeError("Video generation cancelled by user.")
            
        # Download the generated media file
        print(f"[COMFY VIDEO] Downloading generated file: {completed_filename} (type: {output_key})")
        view_res = requests.get(f"{comfy_url}/view", params={
            "filename": completed_filename,
            "subfolder": file_info.get("subfolder", ""),
            "type": file_info.get("type", "output")
        }, timeout=30)
        
        if view_res.status_code != 200:
            raise Exception(f"Failed to download generated file from ComfyUI: HTTP {view_res.status_code}")
        if current_event() and current_event().is_set():
            raise RuntimeError("Video generation cancelled by user.")
            
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
        if current_event() and current_event().is_set():
            os.remove(save_path)
            raise RuntimeError("Video generation cancelled by user.")
            
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
            
        from utils import media_events
        media_events.notify()
        return url_path
        
    finally:
        # Clean up temporary input image from ComfyUI input directory
        try:
            if os.path.exists(comfy_input_path):
                os.remove(comfy_input_path)
        except Exception as e:
            print(f"[COMFY VIDEO] Warning: Failed to delete temp input image {comfy_input_path}: {e}")

@track_tool_activity
def add_quest(
    title: str,
    notes: str,
    due: str = None,
    location: str = "",
    reminder_minutes: int = 15,
    recurrence: str = "",
    auto_prompt: str = "",
) -> str:
    """Creates a new quest (or recurring scheduled automation) and adds it to the user's quest log.

    Args:
        title: Title/name of the quest.
        notes: Objectives of the quest, separated by newlines or commas.
        due: Target local date/time as ISO 8601 (e.g. "2026-10-29T09:00"). Defaults to now.
        location: Optional location coordinates or address.
        reminder_minutes: Optional alert/alarm trigger in minutes before due.
        recurrence: Optional schedule ('hourly', 'daily', 'weekly', or 5-field cron like '0 9 * * *').
        auto_prompt: Optional prompt for the Program to execute automatically whenever `due` arrives.
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
        quest = quest_manager.add_quest(
            title.strip(),
            objectives,
            due_dt,
            location.strip(),
            reminder_min_val,
            recurrence=str(recurrence or "").strip(),
            auto_prompt=str(auto_prompt or "").strip(),
        )
    except Exception as e:
        return f"Error adding quest: {e}"
    if quest is None:
        return f"Quest '{title.strip()}' is already in the log."
    rec_suffix = f" (recurring: {quest['recurrence']})" if quest.get("recurrence") else ""
    return (
        f"Successfully added quest: '{quest['title']}' due "
        f"{due_dt.strftime('%A, %B %d at %I:%M %p')}{rec_suffix} with {len(objectives)} objectives."
    )

from core import openhands_harness as _openhands_harness
from tools import coding_tools as _coding_tools

http_probe = track_tool_activity(_coding_tools.http_probe)
update_plan_step = track_tool_activity(_coding_tools.update_plan_step)

delegate_coding = track_tool_activity(_openhands_harness.delegate_coding)

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


@track_tool_activity
def tune_feed_algorithm(
    action: str = "update",
    discovery_channels: list[str] | str | None = None,
    discovery_instances: list[str] | str | None = None,
    add_discovery_channels: list[str] | str | None = None,
    add_discovery_instances: list[str] | str | None = None,
    remove_sources: list[str] | str | None = None,
    **kwargs,
) -> str:
    """
    Manage the user's declarative local social feed channels and trusted servers without approval prompts.
    Does not touch social credentials or read timelines.
    """
    from core.feed_tuning import (
        apply_feed_tuning_patch,
        format_feed_profile_summary,
        load_feed_profile,
    )
    from runners.program import get_active_program
    import state as st

    act = str(action or "update").strip().lower()
    if act in ("get", "show", "status", "inspect"):
        return "[Feed Profile]\n" + format_feed_profile_summary(load_feed_profile())

    try:
        updated = apply_feed_tuning_patch(
            action=act,
            reset=(act == "reset"),
            discovery_channels=discovery_channels,
            discovery_instances=discovery_instances,
            add_discovery_channels=add_discovery_channels,
            add_discovery_instances=add_discovery_instances,
            remove_sources=remove_sources,
            updated_by=get_active_program() or "program",
        )
    except ValueError as err:
        return f"Error: {err}"

    try:
        st.broadcast_status()
    except Exception:
        pass

    return "[Feed Profile Updated]\n" + format_feed_profile_summary(updated)


@track_tool_activity
def set_working_folder(path: str = "", folder: str = "", **kwargs) -> str:
    """Set the default workspace folder (folders[0]) in project_settings.json."""
    import json
    from runners import program as rp

    raw_target = str(path or folder or kwargs.get("directory") or "").strip()
    if not raw_target:
        return "Error: A directory path is required."
    target = os.path.abspath(os.path.expanduser(raw_target))
    if not os.path.isdir(target):
        return f"Error: Directory does not exist: {target}"

    if not confirm_tool_execution("set_working_folder", f"Set default workspace folder to: {target}"):
        return "Action cancelled by user."

    settings_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "variables", "project_settings.json")
    settings: dict = {}
    if os.path.isfile(settings_path):
        try:
            with open(settings_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                settings = loaded
        except Exception:
            settings = {}

    prev_folders = settings.get("folders") if isinstance(settings.get("folders"), list) else []
    target_key = os.path.normcase(target)
    rest = []
    for existing in prev_folders:
        if not existing:
            continue
        norm = os.path.normpath(str(existing))
        if os.path.normcase(norm) != target_key:
            rest.append(norm)
    settings["folders"] = [target] + rest

    os.makedirs(os.path.dirname(settings_path), exist_ok=True)
    with open(settings_path, "w", encoding="utf-8") as f:
        json.dump(settings, f, indent=2)

    rp._settings_cache = None
    rp._settings_mtime = 0.0
    return f"Default working folder set to {target}."



