"""Stateless Flask Blueprint exposing /api/social/* bridge endpoints for browser/APK clients."""

from __future__ import annotations

import html
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import parse_qsl, quote, urlencode, urlparse

import httpx
from flask import Blueprint, jsonify, make_response, request

from utils.link_preview import fetch_link_preview
from utils.llm_translate import translate_with_local_llm
from utils.semantic_scorer import score_items_for_concepts

social_bridge_bp = Blueprint("social_bridge", __name__, url_prefix="/api/social")
_THREADS_ALLOWED_METHODS = frozenset({"GET", "POST", "DELETE"})
_THREADS_POST_ID_RE = re.compile(r"^[A-Za-z0-9_:-]{1,64}$")
_SHARED_THREADS_CLIENT = httpx.Client(
    timeout=15.0,
    follow_redirects=False,
    limits=httpx.Limits(max_connections=20, max_keepalive_connections=10),
)
_THREADS_BATCH_POOL = ThreadPoolExecutor(max_workers=6)


def _err(exc: Exception, status: int = 400):
    return jsonify({"error": str(exc)}), status


def _validate_threads_url(raw_url: str) -> str:
    text = str(raw_url or "").strip()
    if not text:
        raise ValueError("Missing Threads API URL")
    parsed = urlparse(text)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if (
        parsed.scheme != "https"
        or host != "graph.threads.net"
        or parsed.port is not None
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Only direct https://graph.threads.net/ URLs are permitted")
    return parsed.geturl()


def _relay_threads_request(
    raw_url: str,
    *,
    method: str = "GET",
    body: str = "",
    http_client: httpx.Client | None = None,
) -> dict[str, Any]:
    clean_url = _validate_threads_url(raw_url)
    clean_method = str(method or "GET").strip().upper()
    if clean_method not in _THREADS_ALLOWED_METHODS:
        raise ValueError(f"Unsupported Threads proxy HTTP method: {clean_method}")

    req_headers: dict[str, str] = {}
    req_content: bytes | None = None
    if clean_method == "POST" and body:
        req_headers["Content-Type"] = "application/x-www-form-urlencoded"
        req_content = str(body).encode("utf-8")

    client = http_client or _SHARED_THREADS_CLIENT
    res = client.request(
        clean_method,
        clean_url,
        headers=req_headers or None,
        content=req_content,
    )

    try:
        parsed_body: Any = res.json()
    except ValueError:
        parsed_body = res.text
    return {"status": res.status_code, "body": parsed_body}


@social_bridge_bp.route("/link-preview", methods=["POST"])
def social_link_preview():
    data = request.get_json(silent=True) or {}
    url = str(data.get("url") or "").strip()
    if not url:
        return jsonify({"error": "Missing URL"}), 400
    try:
        return jsonify({"card": fetch_link_preview(url)})
    except Exception as exc:
        return _err(exc)


@social_bridge_bp.route("/translate", methods=["POST"])
def social_translate_post():
    data = request.get_json(silent=True) or {}
    text = str(data.get("text") or "").strip()
    spoiler_text = str(data.get("spoilerText") or "").strip()
    if not text and not spoiler_text:
        return jsonify({"error": "Post text is required"}), 400
    result = translate_with_local_llm(
        text,
        spoiler_text=spoiler_text,
        source_lang=str(data.get("sourceLang") or "auto"),
        target_lang=str(data.get("targetLang") or "en"),
    )
    if result is None:
        return jsonify({"available": False}), 503
    return jsonify(result)


@social_bridge_bp.route("/feed/semantic-score", methods=["POST"])
def social_feed_semantic_score():
    data = request.get_json(silent=True) or {}
    items = data.get("items") if isinstance(data.get("items"), list) else []
    boost = data.get("boostConcepts") if isinstance(data.get("boostConcepts"), list) else []
    dampen = data.get("dampenConcepts") if isinstance(data.get("dampenConcepts"), list) else []
    pos_ex = data.get("positiveExamples") if isinstance(data.get("positiveExamples"), list) else []
    neg_ex = data.get("negativeExamples") if isinstance(data.get("negativeExamples"), list) else []
    include_axes = bool(data.get("includeAxes", False))
    return jsonify(
        score_items_for_concepts(
            items,
            boost,
            dampen,
            positive_examples=pos_ex,
            negative_examples=neg_ex,
            include_axes=include_axes,
        )
    )


_YT_EMBED_PATH_RE = re.compile(r"^/embed/[A-Za-z0-9_-]{11}$")
_VIMEO_EMBED_PATH_RE = re.compile(r"^/video/[0-9]{5,15}$")
_SAFE_EMBED_QUERY_KEYS = frozenset({"autoplay", "rel", "dnt"})


def _validate_video_embed_url(raw_url: str) -> str:
    text = str(raw_url or "").strip()
    if not text:
        raise ValueError("Missing embed URL")
    parsed = urlparse(text)
    host = (parsed.hostname or "").strip().lower().rstrip(".")
    if (
        parsed.scheme != "https"
        or parsed.port is not None
        or parsed.username
        or parsed.password
    ):
        raise ValueError("Only direct HTTPS embed URLs are permitted")
    if host == "www.youtube-nocookie.com" and _YT_EMBED_PATH_RE.match(parsed.path or ""):
        pass
    elif host == "player.vimeo.com" and _VIMEO_EMBED_PATH_RE.match(parsed.path or ""):
        pass
    else:
        raise ValueError("Unsupported video embed provider or path")

    safe_params = [
        (k, v)
        for k, v in parse_qsl(parsed.query, keep_blank_values=False)
        if k in _SAFE_EMBED_QUERY_KEYS and v.isalnum()
    ]
    query = urlencode(safe_params)
    base = f"https://{host}{parsed.path}"
    return f"{base}?{query}" if query else base


@social_bridge_bp.route("/video-embed", methods=["GET"])
def social_video_embed():
    raw_src = str(request.args.get("src") or "").strip()
    try:
        safe_src = _validate_video_embed_url(raw_src)
    except ValueError as exc:
        return _err(exc, 400)

    escaped_src = html.escape(safe_src, quote=True)
    doc = (
        "<!doctype html><html><head>"
        '<meta charset="utf-8">'
        '<meta name="referrer" content="strict-origin-when-cross-origin">'
        "<style>html,body,iframe{margin:0;padding:0;width:100%;height:100%;border:0;background:#000;overflow:hidden;display:block}</style>"
        "</head><body>"
        f'<iframe src="{escaped_src}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" '
        'allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>'
        "</body></html>"
    )
    resp = make_response(doc, 200)
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Content-Security-Policy"] = (
        "default-src 'none'; style-src 'unsafe-inline'; "
        "frame-src https://www.youtube-nocookie.com https://www.youtube.com https://player.vimeo.com; "
        "frame-ancestors 'self' http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*;"
    )
    return resp


@social_bridge_bp.route("/threads-proxy", methods=["POST"])
def social_threads_proxy():
    data = request.get_json(silent=True) or {}
    raw_url = str(data.get("url") or "").strip()
    method = str(data.get("method") or "GET").strip().upper()
    body = str(data.get("body") or "")
    try:
        return jsonify(_relay_threads_request(raw_url, method=method, body=body))
    except ValueError as exc:
        return _err(exc, 400)
    except httpx.HTTPError as exc:
        return _err(exc, 502)


@social_bridge_bp.route("/threads-insights-batch", methods=["POST"])
def social_threads_insights_batch():
    data = request.get_json(silent=True) or {}
    token = str(data.get("accessToken") or "").strip()
    raw_ids = data.get("postIds") if isinstance(data.get("postIds"), list) else []
    if not token:
        return jsonify({"error": "accessToken is required"}), 400

    clean_ids: list[str] = []
    seen: set[str] = set()
    for raw in raw_ids:
        pid = re.sub(r"^threads:(?:notif:)?", "", str(raw or "").strip())
        if not pid or pid in seen or not _THREADS_POST_ID_RE.match(pid):
            continue
        seen.add(pid)
        clean_ids.append(pid)
        if len(clean_ids) >= 30:
            break

    if not clean_ids:
        return jsonify({"results": {}})

    encoded_token = quote(token, safe="")

    def _fetch_one(pid: str) -> tuple[str, dict[str, int] | None]:
        url = (
            f"https://graph.threads.net/v1.0/{quote(pid, safe='')}/insights"
            f"?metric=likes,replies,reposts,quotes&access_token={encoded_token}"
        )
        try:
            relayed = _relay_threads_request(url, method="GET", http_client=_SHARED_THREADS_CLIENT)
        except Exception:
            return pid, None
        if relayed.get("status") != 200:
            return pid, None
        body = relayed.get("body")
        rows = body.get("data") if isinstance(body, dict) and isinstance(body.get("data"), list) else None
        if rows is None:
            return pid, None
        likes = 0
        replies = 0
        reposts = 0
        quotes = 0
        for row in rows:
            if not isinstance(row, dict):
                continue
            name = str(row.get("name") or "").lower()
            total_val = row.get("total_value")
            values = row.get("values")
            if isinstance(total_val, dict) and "value" in total_val:
                raw_val = total_val.get("value")
            elif isinstance(values, list) and values and isinstance(values[0], dict):
                raw_val = values[0].get("value")
            else:
                raw_val = 0
            try:
                val = int(raw_val or 0)
            except (TypeError, ValueError):
                val = 0
            if name == "likes":
                likes = val
            elif name == "replies":
                replies = val
            elif name == "reposts":
                reposts = val
            elif name == "quotes":
                quotes = val
        return pid, {"likes": likes, "replies": replies, "reposts": reposts + quotes}

    results_map: dict[str, dict[str, int]] = {}
    for pid, metrics in _THREADS_BATCH_POOL.map(_fetch_one, clean_ids):
        if metrics is not None:
            results_map[pid] = metrics

    return jsonify({"results": results_map})
