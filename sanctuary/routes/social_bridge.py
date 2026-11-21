"""Stateless Flask Blueprint exposing /api/social/* bridge endpoints for browser/APK clients."""

from __future__ import annotations

from typing import Any
from urllib.parse import urlparse

import httpx
from flask import Blueprint, jsonify, request

from utils.link_preview import fetch_link_preview
from utils.llm_translate import translate_with_local_llm
from utils.semantic_scorer import score_items_for_concepts

social_bridge_bp = Blueprint("social_bridge", __name__, url_prefix="/api/social")
_THREADS_ALLOWED_METHODS = frozenset({"GET", "POST", "DELETE"})


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

    owns_client = http_client is None
    client = http_client or httpx.Client(timeout=15.0, follow_redirects=False)
    try:
        res = client.request(
            clean_method,
            clean_url,
            headers=req_headers or None,
            content=req_content,
        )
    finally:
        if owns_client:
            client.close()

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
    return jsonify(
        score_items_for_concepts(
            items,
            boost,
            dampen,
            positive_examples=pos_ex,
            negative_examples=neg_ex,
        )
    )


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
