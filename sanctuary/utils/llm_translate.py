"""Stateless local llama-server translation helper for social posts."""

from __future__ import annotations

import os
import re
from typing import Any

import httpx

_THINK_BLOCK_RE = re.compile(r"<think>.*?</think>", re.IGNORECASE | re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<think>.*$", re.IGNORECASE | re.DOTALL)


def _strip_thinking(raw_text: str) -> str:
    cleaned = _THINK_BLOCK_RE.sub("", str(raw_text or ""))
    cleaned = _THINK_OPEN_RE.sub("", cleaned)
    return cleaned.strip()


def _resolve_llm_base_url(llm_base_url: str | None = None) -> str:
    raw = (llm_base_url or os.getenv("LOCAL_SERVER_URL") or "http://127.0.0.1:1234").strip()
    if not raw:
        return ""
    base = raw.rstrip("/")
    if base.endswith("/v1/chat/completions"):
        base = base[: -len("/v1/chat/completions")]
    elif base.endswith("/chat/completions"):
        base = base[: -len("/chat/completions")]
    if base.endswith("/v1"):
        base = base[: -len("/v1")]
    return base.rstrip("/")


def translate_with_local_llm(
    text: str,
    spoiler_text: str = "",
    source_lang: str = "auto",
    target_lang: str = "en",
    *,
    http_client: httpx.Client | None = None,
    llm_base_url: str | None = None,
) -> dict[str, Any] | None:
    """Translate plain text using an already-running llama-server, or return None if unavailable."""
    clean_text = str(text or "").strip()
    clean_spoiler = str(spoiler_text or "").strip()
    if not clean_text and not clean_spoiler:
        return None

    target = str(target_lang or "en").strip().lower() or "en"
    source = str(source_lang or "auto").strip().lower() or "auto"
    base_url = _resolve_llm_base_url(llm_base_url)
    if not base_url:
        return None

    owns_client = http_client is None
    client = http_client or httpx.Client(timeout=8.0)
    try:
        try:
            health = client.get(f"{base_url}/health", timeout=0.5)
            if health.status_code != 200:
                return None
        except Exception:
            return None

        def _ask(snippet: str) -> str:
            payload = {
                "model": os.getenv("LOCAL_MODEL_NAME", "local-llm"),
                "messages": [
                    {
                        "role": "system",
                        "content": (
                            f"Translate the following social media post accurately into {target}. "
                            "Preserve @mentions, #hashtags, URLs, and line breaks. Output ONLY the translated text."
                        ),
                    },
                    {"role": "user", "content": snippet},
                ],
                "temperature": 0.1,
                "max_tokens": 700,
                "stream": False,
            }
            resp = client.post(f"{base_url}/v1/chat/completions", json=payload, timeout=12.0)
            if resp.status_code >= 400:
                return ""
            body = resp.json()
            choices = body.get("choices") if isinstance(body, dict) else None
            if not choices or not isinstance(choices, list):
                return ""
            content = ((choices[0] or {}).get("message") or {}).get("content") or ""
            return _strip_thinking(str(content))

        try:
            translated = _ask(clean_text) if clean_text else ""
            if clean_text and not translated:
                return None
            translated_spoiler = _ask(clean_spoiler) if clean_spoiler else ""
            if clean_spoiler and not clean_text and not translated_spoiler:
                return None
            return {
                "text": translated,
                "spoilerText": translated_spoiler,
                "detectedSourceLanguage": source if source != "auto" else "",
                "provider": "Local LLM",
            }
        except Exception:
            return None
    finally:
        if owns_client:
            client.close()
