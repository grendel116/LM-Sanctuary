"""Non-coding web/plan primitives and OpenAI tool schemas (zero regex)."""

from __future__ import annotations

from contextlib import nullcontext
from typing import Any
from urllib.parse import urlparse

import requests

from core.openhands_harness import (  # noqa: F401
    _SHELL_ARGV,
    _SHELL_KIND,
    _SHELL_LABEL,
    resolve_shell as _resolve_shell,
    workspace_python,
)

_BLOCKED_PROBE_HEADERS = frozenset({"authorization", "proxy-authorization", "cookie", "x-api-key"})


def http_probe(url: str, method: str = "GET", headers: dict[str, str] | None = None) -> str:
    """Send one unauthenticated GET/HEAD/OPTIONS request and report status, headers, and body."""
    clean_url = str(url or "").strip()
    parsed = urlparse(clean_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        return "Error: http_probe requires an http:// or https:// URL."

    clean_method = str(method or "GET").strip().upper()
    if clean_method not in ("GET", "HEAD", "OPTIONS"):
        return "Error: http_probe only supports GET, HEAD, or OPTIONS."

    safe_headers: dict[str, str] = {"User-Agent": "LM-Sanctuary/1.0"}
    if isinstance(headers, dict):
        for k, v in headers.items():
            key_s = str(k or "").strip()
            if not key_s:
                continue
            if key_s.lower() in _BLOCKED_PROBE_HEADERS:
                return f"Error: http_probe never sends credentials or {key_s} headers."
            safe_headers[key_s] = str(v or "")

    try:
        resp = requests.request(clean_method, clean_url, headers=safe_headers, timeout=10.0)
    except Exception as exc:
        return f"Error: http_probe failed ({type(exc).__name__}: {exc})."

    hdr_lines = [
        f"{k}: {v}"
        for k, v in resp.headers.items()
        if k.lower() in ("content-type", "allow", "www-authenticate", "access-control-allow-origin", "location", "server")
    ]
    body = ""
    if clean_method != "HEAD" and resp.content:
        body = (resp.text or "").strip()[:3000]
    parts = [f"[HTTP {resp.status_code} {resp.reason or ''}] {clean_method} {clean_url}".strip()]
    if hdr_lines:
        parts.append("\n".join(hdr_lines))
    if body:
        parts.append(body)
    return "\n\n".join(parts)


def update_plan_step(step: int, status: str, note: str = "") -> str:
    """Update the status of a numbered step in the active session's persisted implementation plan."""
    import tools.tools as tools_mod
    from core.plan_state import update_step_status

    runner = tools_mod.current_runner.get()
    sess_id = tools_mod.current_session_id.get()
    if runner is None:
        return "Error: No active session runner for update_plan_step."
    try:
        step_int = int(step)
    except (TypeError, ValueError):
        return "Error: step must be an integer."

    lock_ctx = runner._lock if hasattr(runner, "_lock") else nullcontext()
    with lock_ctx:
        meta = runner._get_memory_meta(sess_id)
        res = update_step_status(meta, step_int, str(status or ""), str(note or ""))
        if not res.startswith("Error:") and hasattr(runner, "_save_session_to_disk"):
            runner._save_session_to_disk(sess_id)
    return res


def _fn_schema(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


WEB_BAND_SCHEMAS: list[dict[str, Any]] = [
    _fn_schema(
        "read_webpage",
        "Fetch and extract readable Markdown from a URL.",
        {"url": {"type": "string", "description": "HTTP or HTTPS URL."}},
        ["url"],
    ),
    _fn_schema(
        "web_search",
        "Search the web for documentation or current information.",
        {"query": {"type": "string", "description": "Search query."}},
        ["query"],
    ),
    _fn_schema(
        "http_probe",
        "Send one unauthenticated GET/HEAD/OPTIONS request and return the HTTP status, key headers, and body.",
        {
            "url": {"type": "string", "description": "HTTP or HTTPS URL to probe."},
            "method": {"type": "string", "description": "GET (default), HEAD, or OPTIONS."},
            "headers": {
                "type": "object",
                "description": "Optional extra request headers (no Authorization/Cookie).",
                "additionalProperties": {"type": "string"},
            },
        },
        ["url"],
    ),
]
