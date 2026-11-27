# SPDX-License-Identifier: AGPL-3.0-or-later
"""Encrypted server-side browser bookmark vault and public Reader Mode extractor."""

from __future__ import annotations

import re
from typing import Any, Callable, Mapping
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from flask import Blueprint, jsonify, request
from markdownify import markdownify as md

from utils import social_vault
from utils.link_preview import assert_safe_public_https_url
from utils.url_privacy import strip_tracking_params

browser_vault_bp = Blueprint("browser_vault", __name__, url_prefix="/api/browser")


@browser_vault_bp.errorhandler(social_vault.VaultLockedError)
def _handle_vault_locked(exc):
    return jsonify({"error": str(exc), "locked": True, "vault": "keepassxc"}), 503

_MAX_READER_BYTES = 512 * 1024
_MAX_PROBE_BYTES = 16 * 1024
_MAX_STATUS_ERR_BYTES = 64 * 1024
_MAX_READER_CHARS = 32000
_STRIPPED_TAGS = ("script", "style", "nav", "header", "footer", "meta", "noscript", "svg", "iframe", "form", "aside")
_BLOCK_COUNTED_TAGS = frozenset({"script", "iframe", "noscript"})
_BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0"


def inspect_frame_headers(headers: Mapping[str, str]) -> tuple[bool, str]:
    """Check X-Frame-Options and CSP frame-ancestors to detect iframe refusal policies."""
    lower = {str(k).lower(): str(v) for k, v in (headers or {}).items()}
    xfo = lower.get("x-frame-options", "").strip()
    if xfo:
        xfo_low = xfo.lower()
        if "deny" in xfo_low or "sameorigin" in xfo_low or "allow-from" in xfo_low:
            return False, f"X-Frame-Options: {xfo[:64]}"

    csp = lower.get("content-security-policy", "")
    if csp:
        for directive in csp.split(";"):
            part = directive.strip()
            if not part:
                continue
            tokens = part.split()
            if tokens and tokens[0].lower() == "frame-ancestors":
                sources = tokens[1:]
                if "*" not in sources:
                    return False, "Content-Security-Policy: frame-ancestors"

    return True, ""


def _fetch_bounded_html(
    start_url: str,
    http_client: httpx.Client | None = None,
    *,
    max_bytes: int = _MAX_READER_BYTES,
) -> tuple[str, str, int, bool, str]:
    allow_mock = http_client is not None
    current = start_url
    headers = {
        "User-Agent": _BROWSER_UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.8",
    }
    own_client = http_client is None
    client = http_client or httpx.Client(timeout=12.0)
    try:
        for _ in range(5):
            with client.stream("GET", current, headers=headers, follow_redirects=False) as res:
                if res.status_code in (301, 302, 303, 307, 308):
                    loc = res.headers.get("location") or ""
                    if not loc:
                        break
                    nxt = strip_tracking_params(urljoin(current, loc))
                    current = assert_safe_public_https_url(nxt, allow_unresolvable_mock=allow_mock)
                    continue
                frame_allowed, frame_reason = inspect_frame_headers(res.headers)
                ctype = (res.headers.get("content-type") or "").lower()
                if res.status_code < 400 and ctype and "html" not in ctype and "xhtml" not in ctype and "text/plain" not in ctype:
                    raise ValueError(f"Unsupported content type for Reader Mode: {ctype}")
                byte_cap = min(max_bytes, _MAX_STATUS_ERR_BYTES) if res.status_code >= 400 else max_bytes
                chunks: list[bytes] = []
                total = 0
                for chunk in res.iter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= byte_cap:
                        break
                raw_bytes = b"".join(chunks)[:byte_cap]
                html_text = (
                    raw_bytes.decode("utf-8", errors="replace")
                    if (not ctype or "html" in ctype or "xhtml" in ctype or "text/" in ctype)
                    else ""
                )
                return html_text, current, int(res.status_code), frame_allowed, frame_reason
    finally:
        if own_client:
            client.close()
    raise ValueError("Too many redirects")


def extract_reader_page_from_html(html_text: str, page_url: str) -> dict[str, Any]:
    """Parse raw HTML into clean Reader Mode Markdown, metadata, and stripped element count."""
    soup = BeautifulSoup(str(html_text or ""), "html.parser")
    host = (urlparse(page_url).hostname or "").removeprefix("www.")

    og_title_tag = soup.find("meta", attrs={"property": "og:title"}) or soup.find("meta", attrs={"name": "twitter:title"})
    og_site_tag = soup.find("meta", attrs={"property": "og:site_name"})
    meta_desc_tag = soup.find("meta", attrs={"property": "og:description"}) or soup.find("meta", attrs={"name": "description"})
    meta_desc = str(meta_desc_tag.get("content") or "").strip() if meta_desc_tag else ""

    raw_title = ""
    if og_title_tag and og_title_tag.get("content"):
        raw_title = str(og_title_tag.get("content")).strip()
    elif soup.title and soup.title.string:
        raw_title = str(soup.title.string).strip()

    blocked_count = 0
    for tag in soup.find_all(_STRIPPED_TAGS):
        if tag.name in _BLOCK_COUNTED_TAGS:
            blocked_count += 1
        tag.decompose()

    content_area = soup.find("article") or soup.find("main") or soup.find("body") or soup
    if not raw_title:
        h1 = content_area.find("h1") if content_area else None
        if h1:
            raw_title = h1.get_text(" ", strip=True)

    for anchor in content_area.find_all("a", href=True):
        href = str(anchor.get("href") or "").strip()
        if not href or href.startswith("#"):
            continue
        resolved = urljoin(page_url, href)
        scheme = urlparse(resolved).scheme.lower()
        if scheme in ("http", "https"):
            anchor["href"] = strip_tracking_params(resolved)
        else:
            anchor.unwrap()

    markdown_text = md(str(content_area), heading_style="ATX", bullets="-")
    markdown_text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", markdown_text)
    markdown_text = re.sub(r"\n{3,}", "\n\n", markdown_text).strip()
    if len(markdown_text) > _MAX_READER_CHARS:
        markdown_text = markdown_text[:_MAX_READER_CHARS].rstrip() + "\n\n… [Truncated]"

    plain_excerpt = re.sub(r"\s+", " ", content_area.get_text(" ", strip=True)).strip()
    if not plain_excerpt and meta_desc:
        plain_excerpt = re.sub(r"\s+", " ", meta_desc).strip()
    if len(plain_excerpt) > 360:
        plain_excerpt = plain_excerpt[:357].rstrip() + "…"

    site_name = str(og_site_tag.get("content") or "").strip()[:80] if og_site_tag else ""
    return {
        "url": page_url,
        "title": (raw_title or host or page_url)[:240],
        "siteName": site_name or host,
        "excerpt": plain_excerpt,
        "markdown": markdown_text,
        "hasArticleContent": bool(markdown_text.strip()),
        "blockedCount": blocked_count,
    }


def fetch_reader_page(
    raw_url: str,
    *,
    http_client: httpx.Client | None = None,
    fetcher: Callable[[str], tuple[str, str]] | None = None,
    mode: str = "reader",
) -> dict[str, Any]:
    """Strip tracking params, validate public HTTPS URL, and extract Reader Mode content or probe headers."""
    clean_url = strip_tracking_params(raw_url)
    allow_mock = http_client is not None or fetcher is not None
    safe_url = assert_safe_public_https_url(clean_url, allow_unresolvable_mock=allow_mock)
    if fetcher is not None:
        html_text, final_url = fetcher(safe_url)
        status_code, frame_allowed, frame_reason = 200, True, ""
    else:
        max_bytes = _MAX_PROBE_BYTES if mode == "probe" else _MAX_READER_BYTES
        html_text, final_url, status_code, frame_allowed, frame_reason = _fetch_bounded_html(
            safe_url, http_client=http_client, max_bytes=max_bytes
        )

    final_clean = strip_tracking_params(final_url or safe_url)
    page = extract_reader_page_from_html(html_text, final_clean)
    page["frameAllowed"] = frame_allowed
    page["frameBlockedReason"] = frame_reason
    page["statusCode"] = status_code
    if status_code >= 400:
        host = (urlparse(final_clean).hostname or "").removeprefix("www.") or final_clean
        page["error"] = f"HTTP {status_code} from {host}"
    return page


@browser_vault_bp.route("/bookmarks", methods=["GET"])
def list_bookmarks():
    return jsonify(social_vault.list_browser_bookmarks())


@browser_vault_bp.route("/bookmarks/<bookmark_id>", methods=["PUT", "DELETE"])
def bookmark_item(bookmark_id: str):
    if request.method == "DELETE":
        try:
            social_vault.delete_browser_bookmark(bookmark_id)
        except social_vault.InvalidBrowserBookmark as exc:
            return jsonify({"error": str(exc)}), 400
        return "", 204

    data = request.get_json(silent=True) or {}
    try:
        saved = social_vault.save_browser_bookmark(bookmark_id, data.get("bookmark"))
    except social_vault.DeletedBrowserBookmark as exc:
        return jsonify({"error": str(exc)}), 409
    except social_vault.InvalidBrowserBookmark as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"bookmark": saved})


@browser_vault_bp.route("/reader", methods=["POST"])
def reader_view():
    data = request.get_json(silent=True) or {}
    raw_url = str(data.get("url") or "").strip()
    if not raw_url:
        return jsonify({"error": "Missing URL"}), 400
    mode = str(data.get("mode") or "reader").strip().lower()
    if mode not in ("reader", "probe"):
        mode = "reader"
    try:
        page = fetch_reader_page(raw_url, mode=mode)
        if mode == "probe":
            return jsonify({
                "page": {
                    "url": page["url"],
                    "title": page["title"],
                    "siteName": page["siteName"],
                    "frameAllowed": page["frameAllowed"],
                    "frameBlockedReason": page["frameBlockedReason"],
                    "statusCode": page["statusCode"],
                    "error": page.get("error", ""),
                }
            })
        return jsonify({"page": page})
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    except httpx.HTTPError as exc:
        return jsonify({
            "page": None,
            "frameAllowed": False,
            "frameBlockedReason": "",
            "error": f"Connection failed: {exc}",
        }), 200


_SUGGEST_ENDPOINTS: dict[str, str] = {
    "duckduckgo": "https://duckduckgo.com/ac/?q={q}&type=list",
    "ecosia": "https://ac.ecosia.org/autocomplete?q={q}&type=list",
    "startpage": "https://www.startpage.com/osuggestions?q={q}",
    "brave": "https://search.brave.com/api/suggest?q={q}",
    "qwant": "https://api.qwant.com/v3/suggest?q={q}&locale=en_us",
    "wikipedia": "https://en.wikipedia.org/w/api.php?action=opensearch&search={q}&limit=6&format=json",
}


def fetch_search_suggestions(
    query: str,
    engine: str = "ecosia",
    *,
    http_client: httpx.Client | None = None,
) -> list[str]:
    """Fetch bounded search-as-you-type suggestions for a supported engine."""
    clean_q = " ".join(str(query or "").split())[:120].strip()
    if not clean_q:
        return []
    tmpl = _SUGGEST_ENDPOINTS.get(str(engine or "").strip().lower())
    if not tmpl:
        return []
    from urllib.parse import quote_plus
    url = tmpl.format(q=quote_plus(clean_q))
    try:
        if http_client is not None:
            resp = http_client.get(url, timeout=2.0)
        else:
            with httpx.Client(timeout=2.0, follow_redirects=True) as client:
                resp = client.get(url, headers={"Accept": "application/json"})
        if resp.status_code != 200:
            return []
        payload = resp.json()
    except Exception:
        return []

    raw_items: list[Any] = []
    if isinstance(payload, list) and len(payload) >= 2 and isinstance(payload[1], list):
        raw_items = payload[1]
    elif isinstance(payload, dict):
        data_obj = payload.get("data")
        if isinstance(data_obj, dict) and isinstance(data_obj.get("items"), list):
            raw_items = [it.get("value") for it in data_obj["items"] if isinstance(it, dict)]

    out: list[str] = []
    seen: set[str] = set()
    for item in raw_items:
        text = " ".join(str(item or "").split())[:120].strip()
        if not text:
            continue
        low = text.lower()
        if low in seen:
            continue
        seen.add(low)
        out.append(text)
        if len(out) >= 6:
            break
    return out


@browser_vault_bp.route("/suggest", methods=["GET"])
def search_suggest():
    q = str(request.args.get("q") or "").strip()
    engine = str(request.args.get("engine") or "ecosia").strip().lower()
    return jsonify({"suggestions": fetch_search_suggestions(q, engine)})
