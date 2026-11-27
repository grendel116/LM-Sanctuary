"""OpenAI-compatible `/v1` client for LM-Sanctuary (Gear 2 chat, streaming tool calls, model limit discovery, and optional cooperative `/v1` extensions)."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import threading
import time
from typing import Any
from urllib.parse import urlparse

import requests

from variables.settings import BASE_DIR as SANCTUARY_DIR

DEFAULT_V1_BASE_URL = "https://api.greenpt.ai/v1"
FAST_CLOUD_MODEL = "glm-5.3-flash"
DEEP_CLOUD_MODEL = "glm-5.3"
VISION_CLOUD_MODEL = "deepseek-v4.1-flash-1017"
RERANK_MODEL = "green-rerank"

VALID_ROUTING_POLICIES = frozenset({"auto", "local_only", "eco_flash", "private_tee"})

PROVIDER_ROLE_DEFAULTS: dict[str, dict[str, str]] = {
    "greenpt": {
        "fast": "glm-5.3-flash",
        "deep": "glm-5.3",
        "vision": "deepseek-v4.1-flash-1017",
        "private": "glm-5.3",
    },
    "inference_coop": {
        "fast": "glm-flash-green",
        "deep": "greenpt/glm-5.3",
        "vision": "deepseek-flash-green",
        "private": "glm-tee",
        "private_vision": "deepseek-flash-tee",
    },
    "tinfoil": {
        "fast": "gpt-oss-120b",
        "deep": "glm-5.3",
        "vision": "deepseek-v4-1-flash",
        "private": "glm-5.3",
    },
    "regolo": {
        "fast": "mistral-small-4-119b",
        "deep": "apertus-70b",
        "vision": "gemma4-31b",
        "private": "apertus-70b",
    },
}

_SETTINGS_PATH = os.path.join(SANCTUARY_DIR, "variables", "project_settings.json")
_SKILL_SYNC_CACHE_PATH = os.path.join(SANCTUARY_DIR, "data", "greenpt_skills_sync.json")

_STATE_LOCK = threading.Lock()
_QUOTA_COOLDOWN_SECONDS = 120.0
_quota_exhausted_until: float = 0.0
_quota_exhausted_key_fp: str = ""
_MODEL_INFO_CACHE: dict[str, dict[str, dict[str, Any]]] = {}

_ORIG_POST = requests.post
_ORIG_GET = requests.get
_ORIG_PATCH = requests.patch
_HTTP_SESSION = requests.Session()


def _http_post(url: str, **kwargs):
    fn = requests.post if requests.post is not _ORIG_POST else _HTTP_SESSION.post
    return fn(url, **kwargs)


def _http_get(url: str, **kwargs):
    fn = requests.get if requests.get is not _ORIG_GET else _HTTP_SESSION.get
    return fn(url, **kwargs)


def _http_patch(url: str, **kwargs):
    fn = requests.patch if requests.patch is not _ORIG_PATCH else _HTTP_SESSION.patch
    return fn(url, **kwargs)


class V1QuotaError(RuntimeError):
    """Raised when the configured `/v1` endpoint rejects a call with HTTP 402 (no credits)."""


def _key_fingerprint(api_key: str) -> str:
    if not api_key:
        return ""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12]


def _is_kdbx_vault_active() -> bool:
    try:
        from utils.social_vault import is_keepassxc_vault_enabled

        return is_keepassxc_vault_enabled()
    except Exception:
        return False


def _resolve_api_key(raw: dict[str, Any]) -> tuple[str, str]:
    """Resolve the `/v1` API key and an unavailable reason if missing or locked."""
    in_vault = raw.get("v1_api_key_in_vault") or raw.get("greenpt_api_key_in_vault")
    has_plain = bool(str(raw.get("v1_api_key") or raw.get("greenpt_api_key") or "").strip())
    use_vault = bool(in_vault) or (
        "v1_api_key_in_vault" not in raw
        and "greenpt_api_key_in_vault" not in raw
        and not has_plain
        and _is_kdbx_vault_active()
    )
    if use_vault:
        try:
            from utils.keepassxc_client import get_keepassxc_bridge

            bridge = get_keepassxc_bridge()
            if not bridge.is_unlocked():
                return "", "vault locked: unlock the Sanctuary Vault to use Cloud /v1"
            key = (bridge.get_secret("v1_api_key") or bridge.get_secret("greenpt_api_key") or "").strip()
            return key, "" if key else "Cloud API key missing from the unlocked vault"
        except Exception as exc:
            return "", f"vault unavailable ({exc})"

    key = (
        str(raw.get("v1_api_key") or "").strip()
        or str(raw.get("greenpt_api_key") or "").strip()
        or os.getenv("V1_API_KEY", "").strip()
        or os.getenv("CLOUD_API_KEY", "").strip()
        or os.getenv("GREENPT_API_KEY", "").strip()
    )
    return key, "" if key else "no Cloud API key configured"


def get_v1_settings(settings_path: str | None = None) -> dict[str, Any]:
    """Load OpenAI-compatible `/v1` settings from `project_settings.json` + env vars."""
    target_path = settings_path or _SETTINGS_PATH
    raw: dict[str, Any] = {}
    if os.path.isfile(target_path):
        try:
            with open(target_path, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                raw = loaded
        except (OSError, json.JSONDecodeError):
            raw = {}

    api_key, key_unavailable_reason = _resolve_api_key(raw)
    base_url = (
        str(raw.get("v1_base_url") or "").strip()
        or str(raw.get("greenpt_base_url") or "").strip()
        or os.getenv("V1_BASE_URL", "").strip()
        or os.getenv("CLOUD_BASE_URL", "").strip()
        or os.getenv("GREENPT_BASE_URL", "").strip()
        or DEFAULT_V1_BASE_URL
    ).rstrip("/")

    policy = (
        str(raw.get("routing_policy") or "").strip().lower()
        or os.getenv("SANCTUARY_ROUTING_POLICY", "auto").strip().lower()
    )
    if policy not in VALID_ROUTING_POLICIES:
        policy = "auto"

    provider = detect_v1_provider(base_url)

    default_model = (
        str(raw.get("openhands_model") or "").strip()
        or os.getenv("OPENHANDS_MODEL", "").strip()
        or DEEP_CLOUD_MODEL
    )
    if provider == "inference_coop" and default_model == DEEP_CLOUD_MODEL:
        default_model = "glm-tee" if policy == "private_tee" else "greenpt/glm-5.3"

    fast_model = (
        str(raw.get("cloud_fast_model") or "").strip()
        or os.getenv("CLOUD_FAST_MODEL", "").strip()
    )
    vision_model = (
        str(raw.get("cloud_vision_model") or "").strip()
        or os.getenv("CLOUD_VISION_MODEL", "").strip()
    )
    private_model = (
        str(raw.get("cloud_private_model") or "").strip()
        or os.getenv("CLOUD_PRIVATE_MODEL", "").strip()
    )
    checkpoint_model = (
        str(raw.get("v1_checkpoint_model") or "").strip()
        or str(raw.get("cloud_checkpoint_model") or "").strip()
        or os.getenv("V1_CHECKPOINT_MODEL", "").strip()
        or os.getenv("CLOUD_CHECKPOINT_MODEL", "").strip()
    )

    def _int_setting(keys: tuple[str, ...], env_keys: tuple[str, ...], default: int, minimum: int) -> tuple[int, bool]:
        raw_val: Any = None
        for k in keys:
            cand = raw.get(k)
            if cand not in (None, ""):
                raw_val = cand
                break
        if raw_val in (None, ""):
            for ek in env_keys:
                cand = os.getenv(ek, "").strip()
                if cand:
                    raw_val = cand
                    break
        if raw_val not in (None, ""):
            try:
                parsed = int(str(raw_val).strip())
                if parsed >= minimum:
                    return parsed, True
            except (TypeError, ValueError):
                pass
        return default, False

    context_tokens, context_tokens_explicit = _int_setting(
        ("v1_context_tokens", "cloud_context_tokens"),
        ("V1_CONTEXT_TOKENS", "CLOUD_CONTEXT_TOKENS"),
        262144,
        32768,
    )
    max_output_tokens, max_output_tokens_explicit = _int_setting(
        ("v1_max_output_tokens", "cloud_max_output_tokens"),
        ("V1_MAX_OUTPUT_TOKENS", "CLOUD_MAX_OUTPUT_TOKENS"),
        65536,
        4096,
    )

    return {
        "api_key": api_key,
        "key_unavailable_reason": key_unavailable_reason,
        "base_url": base_url,
        "provider": provider,
        "routing_policy": policy,
        "default_model": default_model,
        "fast_model": fast_model,
        "vision_model": vision_model,
        "private_model": private_model,
        "checkpoint_model": checkpoint_model,
        "context_tokens": context_tokens,
        "context_tokens_explicit": context_tokens_explicit,
        "max_output_tokens": max_output_tokens,
        "max_output_tokens_explicit": max_output_tokens_explicit,
    }


def is_local_endpoint(base_url: str) -> bool:
    host = (urlparse(base_url or "").hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "0.0.0.0", "::1")


def detect_v1_provider(base_url: str | None = None) -> str:
    """Identify the configured OpenAI-compatible `/v1` provider family by hostname."""
    if base_url is None:
        base_url = get_v1_settings()["base_url"]
    host = (urlparse(base_url or "").hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "0.0.0.0", "::1"):
        return "local"
    if host == "greenpt.ai" or host.endswith(".greenpt.ai"):
        return "greenpt"
    if host == "inference.coop" or host.endswith(".inference.coop"):
        return "inference_coop"
    if host == "tinfoil.sh" or host.endswith(".tinfoil.sh"):
        return "tinfoil"
    if host == "regolo.ai" or host.endswith(".regolo.ai"):
        return "regolo"
    return "custom"


def supports_coop_extensions(base_url: str | None = None) -> bool:
    """Return True if `base_url` exposes EU cooperative `/v1/tools/*`, `/v1/rerank`, and `/v1/skills` extensions."""
    url = base_url if base_url is not None else get_v1_settings()["base_url"]
    host = (urlparse(url or "").hostname or "").lower()
    return host in ("greenpt.ai", "api.greenpt.ai", "api.eu.greenpt.ai")


def is_quota_exhausted(api_key: str | None = None) -> bool:
    cfg = get_v1_settings()
    fp = _key_fingerprint(api_key if api_key is not None else cfg["api_key"])
    with _STATE_LOCK:
        if not _quota_exhausted_until:
            return False
        if fp != _quota_exhausted_key_fp or time.monotonic() >= _quota_exhausted_until:
            return False
        return True


def mark_quota_exhausted(api_key: str | None = None, cooldown: float = _QUOTA_COOLDOWN_SECONDS) -> None:
    cfg = get_v1_settings()
    fp = _key_fingerprint(api_key if api_key is not None else cfg["api_key"])
    with _STATE_LOCK:
        global _quota_exhausted_until, _quota_exhausted_key_fp
        _quota_exhausted_key_fp = fp
        _quota_exhausted_until = time.monotonic() + max(5.0, cooldown)


def clear_quota_cooldown() -> None:
    with _STATE_LOCK:
        global _quota_exhausted_until, _quota_exhausted_key_fp
        _quota_exhausted_until = 0.0
        _quota_exhausted_key_fp = ""
        _MODEL_INFO_CACHE.clear()


def v1_unavailable_reason(require_coop_extensions: bool = False) -> str:
    """Return a short reason string if Cloud `/v1` is unavailable, or '' when ready."""
    cfg = get_v1_settings()
    if cfg["routing_policy"] == "local_only":
        return "routing_policy=local_only"
    if not cfg["api_key"] and not is_local_endpoint(cfg["base_url"]):
        return cfg["key_unavailable_reason"] or "no Cloud API key configured"
    if require_coop_extensions and not supports_coop_extensions(cfg["base_url"]):
        return "endpoint does not advertise cooperative /v1 extensions"
    if is_quota_exhausted(cfg["api_key"]):
        return "HTTP 402 quota cooldown"
    return ""


def is_v1_enabled(require_coop_extensions: bool = False) -> bool:
    """Return True when `/v1` routing is permitted, configured, and not in 402 cooldown."""
    return not v1_unavailable_reason(require_coop_extensions)


def _auth_headers(api_key: str, json_body: bool = True) -> dict[str, str]:
    headers: dict[str, str] = {}
    if json_body:
        headers["Content-Type"] = "application/json"
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"
    return headers


def _check_402(resp: requests.Response, api_key: str) -> None:
    if resp.status_code == 402:
        mark_quota_exhausted(api_key)
        raise V1QuotaError(f"HTTP 402: {resp.text[:240]}")


def _first_positive_int(obj: dict[str, Any], keys: tuple[str, ...], minimum: int) -> int | None:
    sources = [obj]
    top = obj.get("top_provider")
    if isinstance(top, dict):
        sources.append(top)
    for src in sources:
        for key in keys:
            val = src.get(key)
            if val in (None, "", False):
                continue
            try:
                num = int(val)
                if num >= minimum:
                    return num
            except (TypeError, ValueError):
                continue
    return None


def get_v1_model_info(model: str) -> dict[str, Any]:
    """Return context_tokens, max_output_tokens, output_uncapped, and supports_reasoning_effort via `/v1/models` + `/v1/pricing`."""
    cfg = get_v1_settings()
    base = cfg["base_url"]
    model_id = (model or "").strip()

    with _STATE_LOCK:
        cached_models = _MODEL_INFO_CACHE.get(base)

    if cached_models is None and is_v1_enabled():
        fetched: dict[str, dict[str, Any]] = {}
        try:
            resp = _http_get(f"{base}/models", headers=_auth_headers(cfg["api_key"]), timeout=4.0)
            if resp.status_code == 200 and resp.content:
                body = resp.json()
                rows = body.get("data") if isinstance(body, dict) else body
                if isinstance(rows, list):
                    for item in rows:
                        if not isinstance(item, dict):
                            continue
                        mid = str(item.get("id") or "").strip()
                        if not mid:
                            continue
                        ctx = _first_positive_int(
                            item, ("context_length", "contextWindowTokens", "max_model_len", "context_window"), 4096
                        )
                        out_max = _first_positive_int(
                            item, ("max_output_tokens", "maxOutputTokens", "max_completion_tokens"), 1024
                        )
                        uncapped = (
                            ("maxOutputTokens" in item and item["maxOutputTokens"] is None)
                            or ("max_output_tokens" in item and item["max_output_tokens"] is None)
                        )
                        params = item.get("supported_parameters")
                        supports_re = (
                            ("reasoning_effort" in params)
                            if isinstance(params, list)
                            else None
                        )
                        fetched[mid] = {
                            "context_tokens": ctx,
                            "max_output_tokens": out_max,
                            "output_uncapped": uncapped,
                            "supports_reasoning_effort": supports_re,
                        }
        except Exception:
            pass

        if detect_v1_provider(base) == "greenpt" and (
            not fetched or any(v.get("context_tokens") is None for v in fetched.values())
        ):
            try:
                p_resp = _http_get(f"{base}/pricing", headers=_auth_headers(cfg["api_key"]), timeout=4.0)
                if p_resp.status_code == 200 and p_resp.content:
                    p_body = p_resp.json()
                    p_rows = p_body.get("data") if isinstance(p_body, dict) else p_body
                    if isinstance(p_rows, list):
                        has_models_filter = bool(fetched)
                        for p_item in p_rows:
                            if not isinstance(p_item, dict):
                                continue
                            mid = str(p_item.get("id") or "").strip()
                            if not mid or (has_models_filter and mid not in fetched):
                                continue
                            p_ctx = _first_positive_int(p_item, ("contextWindowTokens", "context_length"), 4096)
                            p_out = _first_positive_int(p_item, ("maxOutputTokens", "max_output_tokens"), 1024)
                            p_uncapped = "maxOutputTokens" in p_item and p_item["maxOutputTokens"] is None
                            cur = fetched.setdefault(
                                mid,
                                {
                                    "context_tokens": None,
                                    "max_output_tokens": None,
                                    "output_uncapped": False,
                                    "supports_reasoning_effort": None,
                                },
                            )
                            if cur["context_tokens"] is None and p_ctx is not None:
                                cur["context_tokens"] = p_ctx
                            if cur["max_output_tokens"] is None and p_out is not None:
                                cur["max_output_tokens"] = p_out
                            if cur["max_output_tokens"] is None and p_uncapped:
                                cur["output_uncapped"] = True
            except Exception:
                pass

        with _STATE_LOCK:
            _MODEL_INFO_CACHE[base] = fetched
            cached_models = fetched

    entry = (cached_models or {}).get(model_id) or {}
    ctx_tokens = (
        cfg["context_tokens"]
        if cfg["context_tokens_explicit"]
        else (entry.get("context_tokens") or cfg["context_tokens"])
    )
    output_uncapped = bool(entry.get("output_uncapped") and not cfg["max_output_tokens_explicit"])
    out_tokens = (
        cfg["max_output_tokens"]
        if cfg["max_output_tokens_explicit"]
        else (entry.get("max_output_tokens") or cfg["max_output_tokens"])
    )
    return {
        "context_tokens": int(ctx_tokens),
        "max_output_tokens": int(out_tokens),
        "output_uncapped": output_uncapped,
        "supports_reasoning_effort": entry.get("supports_reasoning_effort"),
    }


def normalize_skill_slug(name: str) -> str:
    raw = (name or "").strip().lower()
    out: list[str] = []
    prev_dash = False
    for ch in raw:
        if ch.isalnum() or ch in "_-":
            out.append(ch)
            prev_dash = False
        elif not prev_dash:
            out.append("-")
            prev_dash = True
    slug = "".join(out).strip("-_")
    return slug[:64] or "sanctuary-skill"


def websearch(
    query: str,
    count: int = 6,
    full_page_content: str | bool = "auto",
    timeout: float = 12.0,
) -> list[dict[str, str]]:
    """Query cooperative `/v1/tools/websearch`."""
    clean_q = (query or "").strip()
    if not clean_q:
        return []
    reason = v1_unavailable_reason(require_coop_extensions=True)
    if reason:
        raise RuntimeError(reason)

    cfg = get_v1_settings()
    resp = _http_post(
        f"{cfg['base_url']}/tools/websearch",
        headers=_auth_headers(cfg["api_key"]),
        json={
            "query": clean_q,
            "count": max(1, min(10, int(count))),
            "fullPageContent": full_page_content,
        },
        timeout=timeout,
    )
    _check_402(resp, cfg["api_key"])
    if resp.status_code != 200:
        raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    payload = resp.json() if resp.content else {}
    raw_items = (
        payload.get("results")
        or payload.get("web")
        or payload.get("data")
        or (payload if isinstance(payload, list) else [])
    )
    if isinstance(raw_items, dict):
        raw_items = raw_items.get("results") or []

    parsed: list[dict[str, str]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or item.get("link") or "").strip()
        if not url:
            continue
        title = str(item.get("title") or "Web Result").strip()
        passage = str(item.get("relevant_content") or "").strip()
        snippet = str(
            item.get("snippet") or item.get("description") or item.get("content") or ""
        ).strip()
        combined = f"{snippet}\n{passage}".strip() if (passage and snippet and passage != snippet) else (passage or snippet)
        parsed.append(
            {
                "title": title,
                "url": url,
                "content": combined[:2400],
                "source": "Cloud Search",
            }
        )
    return parsed


def scrape_markdown(url: str, timeout: float = 20.0) -> str:
    """Scrape clean Markdown from a JS/cookie-gated page via `/v1/tools/crawl/scrape`."""
    clean_url = (url or "").strip()
    if not clean_url or not is_v1_enabled(require_coop_extensions=True):
        return ""

    cfg = get_v1_settings()
    resp = _http_post(
        f"{cfg['base_url']}/tools/crawl/scrape",
        headers=_auth_headers(cfg["api_key"]),
        json={"url": clean_url, "format": "markdown"},
        timeout=timeout,
    )
    _check_402(resp, cfg["api_key"])
    if resp.status_code != 200:
        return ""

    data = resp.json() if resp.content else {}
    if not isinstance(data, dict):
        return ""
    nested = data.get("data") if isinstance(data.get("data"), dict) else {}
    text = (
        data.get("markdown")
        or data.get("content")
        or nested.get("markdown")
        or nested.get("content")
        or ""
    )
    return str(text).strip()


def convert_document(file_path: str, filename: str | None = None, timeout: float = 45.0) -> str:
    """Convert PDF/DOCX/PPTX/XLSX/image files to Markdown via Docling OCR `/v1/tools/documents/convert/file`."""
    if not file_path or not os.path.isfile(file_path) or not is_v1_enabled(require_coop_extensions=True):
        return ""

    cfg = get_v1_settings()
    fname = filename or os.path.basename(file_path)
    mime = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    headers = _auth_headers(cfg["api_key"], json_body=False)
    endpoint = f"{cfg['base_url']}/tools/documents/convert/file"

    with open(file_path, "rb") as fp:
        resp = _http_post(
            endpoint,
            headers=headers,
            files={"files": (fname, fp, mime)},
            data={"to_formats": "md"},
            timeout=timeout,
        )
    _check_402(resp, cfg["api_key"])
    if resp.status_code != 200:
        return ""

    data = resp.json() if resp.content else {}
    if not isinstance(data, dict):
        return ""
    doc_obj = data.get("document") if isinstance(data.get("document"), dict) else {}
    text = (
        doc_obj.get("md_content")
        or data.get("md_content")
        or data.get("markdown")
        or data.get("text")
        or data.get("content")
        or ""
    )
    return str(text).strip()


def rerank(
    query: str,
    documents: list[str],
    top_n: int = 5,
    model: str = RERANK_MODEL,
    timeout: float = 8.0,
) -> list[tuple[int, float]]:
    """Rerank candidate chunks via `POST /v1/rerank`. Returns `[(index, score), ...]`."""
    if not query or len(documents) <= 1 or not is_v1_enabled(require_coop_extensions=True):
        return []

    cfg = get_v1_settings()
    resp = _http_post(
        f"{cfg['base_url']}/rerank",
        headers=_auth_headers(cfg["api_key"]),
        json={
            "model": model,
            "query": query,
            "documents": documents,
            "top_n": max(1, min(int(top_n), len(documents))),
        },
        timeout=timeout,
    )
    _check_402(resp, cfg["api_key"])
    if resp.status_code != 200:
        return []

    data = resp.json() if resp.content else {}
    items = data.get("results") or data.get("data") or []
    ranked: list[tuple[int, float]] = []
    for item in items:
        if not isinstance(item, dict) or "index" not in item:
            continue
        idx = int(item["index"])
        score = float(item.get("relevance_score", item.get("score", 0.0)))
        if 0 <= idx < len(documents):
            ranked.append((idx, score))
    ranked.sort(key=lambda pair: pair[1], reverse=True)
    return ranked


def _load_skill_sync_cache() -> dict[str, Any]:
    if not os.path.isfile(_SKILL_SYNC_CACHE_PATH):
        return {}
    try:
        with open(_SKILL_SYNC_CACHE_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def _save_skill_sync_cache(cache: dict[str, Any]) -> None:
    try:
        os.makedirs(os.path.dirname(_SKILL_SYNC_CACHE_PATH), exist_ok=True)
        tmp = f"{_SKILL_SYNC_CACHE_PATH}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(cache, f, indent=2, ensure_ascii=False)
        os.replace(tmp, _SKILL_SYNC_CACHE_PATH)
    except OSError:
        pass


def format_skill_payload(record: dict[str, Any]) -> dict[str, str]:
    """Normalize a Sanctuary skill record into the `/v1/skills` schema."""
    slug = normalize_skill_slug(str(record.get("name") or "skill"))
    raw_title = str(record.get("title") or slug.replace("_", " ").replace("-", " ").title()).strip()
    raw_desc = str(record.get("description") or raw_title).strip()
    raw_instr = str(record.get("instruction_body") or record.get("instructions") or "").strip()
    return {
        "name": slug,
        "title": raw_title[:120],
        "description": raw_desc[:500],
        "instructions": raw_instr[:20000],
    }


def sync_skill(record: dict[str, Any], timeout: float = 10.0) -> str | None:
    """Ensure `record` is synced to `/v1/skills` and return its slug name."""
    if not is_v1_enabled(require_coop_extensions=True):
        return None

    payload = format_skill_payload(record)
    if not payload["instructions"]:
        return None

    cfg = get_v1_settings()
    cache_key = f"{cfg['base_url']}::{payload['name']}"
    digest = hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    cache = _load_skill_sync_cache()
    cached_entry = cache.get(cache_key)
    if isinstance(cached_entry, dict) and cached_entry.get("sha256") == digest:
        return payload["name"]

    headers = _auth_headers(cfg["api_key"])
    base = cfg["base_url"]
    skill_id = cached_entry.get("id") if isinstance(cached_entry, dict) else None

    if not skill_id:
        list_resp = _http_get(f"{base}/skills", headers=headers, timeout=timeout)
        _check_402(list_resp, cfg["api_key"])
        if list_resp.status_code == 200:
            body = list_resp.json() if list_resp.content else {}
            skills_list = body.get("data") if isinstance(body, dict) else body
            if isinstance(skills_list, list):
                for existing in skills_list:
                    if isinstance(existing, dict) and existing.get("name") == payload["name"]:
                        skill_id = existing.get("id")
                        break

    if skill_id:
        resp = _http_patch(
            f"{base}/skills/{skill_id}",
            headers=headers,
            json=payload,
            timeout=timeout,
        )
    else:
        resp = _http_post(
            f"{base}/skills",
            headers=headers,
            json=payload,
            timeout=timeout,
        )
    _check_402(resp, cfg["api_key"])
    if resp.status_code not in (200, 201):
        return None

    res_json = resp.json() if resp.content else {}
    if isinstance(res_json, dict):
        skill_id = res_json.get("id") or (res_json.get("data") or {}).get("id") or skill_id

    cache[cache_key] = {"id": skill_id or payload["name"], "sha256": digest}
    _save_skill_sync_cache(cache)
    return payload["name"]


def resolve_v1_tier_model(tier: str = "fast", has_vision: bool = False, sensitive: bool = False) -> str:
    """Select the configured `/v1` model for a requested reasoning or privacy role."""
    cfg = get_v1_settings()
    preset = PROVIDER_ROLE_DEFAULTS.get(cfg["provider"], {})
    is_private = bool(sensitive or cfg["routing_policy"] == "private_tee")
    clean_tier = (tier or "fast").strip().lower()

    if has_vision or clean_tier in ("vision", "multimodal"):
        if is_private:
            return (
                cfg["vision_model"]
                or preset.get("private_vision")
                or preset.get("vision")
                or cfg["default_model"]
            )
        return cfg["vision_model"] or preset.get("vision") or cfg["default_model"]

    if is_private and (
        clean_tier in ("plan", "deep_plan", "deep_recovery", "deep", "pro", "architect", "coding", "private")
        or cfg["routing_policy"] == "private_tee"
    ):
        return cfg["private_model"] or preset.get("private") or cfg["default_model"]

    if clean_tier in ("plan", "deep_plan", "deep_recovery"):
        return cfg["default_model"] or preset.get("deep") or DEEP_CLOUD_MODEL

    if cfg["routing_policy"] == "eco_flash" or clean_tier == "fast":
        return cfg["fast_model"] or preset.get("fast") or cfg["default_model"]

    if clean_tier in ("deep", "pro", "architect", "coding"):
        return cfg["default_model"] or preset.get("deep") or DEEP_CLOUD_MODEL

    return cfg["fast_model"] or preset.get("fast") or cfg["default_model"]


def supports_systemone(base_url: str | None = None) -> bool:
    """Return True when the endpoint exposes Metis `/v1/systemone` decision API."""
    return detect_v1_provider(base_url) in ("greenpt", "inference_coop")


def systemone_decide(
    state: str,
    questions: dict[str, dict[str, Any]],
    *,
    timeout: float = 6.0,
) -> dict[str, Any] | None:
    """Call `/v1/systemone` for calibrated non-prose decisions."""
    if not state or not questions or not is_v1_enabled(require_coop_extensions=False):
        return None
    cfg = get_v1_settings()
    if not supports_systemone(cfg["base_url"]):
        return None
    try:
        resp = _http_post(
            f"{cfg['base_url']}/systemone",
            headers=_auth_headers(cfg["api_key"]),
            json={"model": "metis", "state": str(state), "questions": questions},
            timeout=timeout,
        )
        _check_402(resp, cfg["api_key"])
        if resp.status_code != 200:
            return None
        return resp.json() if resp.content else None
    except V1QuotaError:
        raise
    except Exception:
        return None


_INT_TOOL_ARG_KEYS = frozenset({"start_line", "end_line", "timeout"})
_BOOL_TOOL_ARG_KEYS = frozenset({"overwrite", "case_sensitive"})


def _coerce_xml_arg(key: str, val: str) -> Any:
    trimmed = val.strip()
    if key in _INT_TOOL_ARG_KEYS:
        try:
            return int(trimmed)
        except ValueError:
            return val
    if key in _BOOL_TOOL_ARG_KEYS:
        low = trimmed.lower()
        if low == "true":
            return True
        if low == "false":
            return False
    return val


def _extract_xml_tool_calls(raw_content: str) -> tuple[str, list[dict[str, Any]], bool]:
    """Extract GLM `<tool_call>` blocks and strip any truncated unclosed `<tool_call>` tail (zero regex)."""
    text = str(raw_content or "")
    for stop_tok in ("<|observation|>", "<|user|>"):
        s_idx = text.find(stop_tok)
        if s_idx != -1:
            text = text[:s_idx]

    if "<tool_call>" not in text:
        return text.strip(), [], False

    out_parts: list[str] = []
    recovered: list[dict[str, Any]] = []
    truncated = False
    cursor = 0
    open_tag = "<tool_call>"
    close_tag = "</tool_call>"

    while cursor < len(text):
        start = text.find(open_tag, cursor)
        if start == -1:
            out_parts.append(text[cursor:])
            break
        out_parts.append(text[cursor:start])
        inner_start = start + len(open_tag)
        end = text.find(close_tag, inner_start)
        if end == -1:
            truncated = True
            break

        block = text[inner_start:end].strip()
        cursor = end + len(close_tag)

        if block.startswith("{"):
            try:
                obj = json.loads(block)
                if isinstance(obj, dict) and obj.get("name"):
                    args = obj.get("arguments")
                    recovered.append({
                        "id": f"xml_{len(recovered)}",
                        "name": str(obj["name"]).strip(),
                        "args": args if isinstance(args, dict) else {},
                    })
                    continue
            except json.JSONDecodeError:
                pass

        arg_pos = block.find("<arg_key>")
        fn_name = (block[:arg_pos] if arg_pos != -1 else block).strip()
        if fn_name:
            args_dict: dict[str, Any] = {}
            k_cursor = arg_pos if arg_pos != -1 else len(block)
            while k_cursor < len(block):
                ks = block.find("<arg_key>", k_cursor)
                if ks == -1:
                    break
                ke = block.find("</arg_key>", ks + 9)
                if ke == -1:
                    break
                key_name = block[ks + 9 : ke].strip()
                vs = block.find("<arg_value>", ke + 10)
                if vs == -1:
                    break
                ve = block.find("</arg_value>", vs + 11)
                if ve == -1:
                    break
                val_raw = block[vs + 11 : ve]
                if key_name:
                    args_dict[key_name] = _coerce_xml_arg(key_name, val_raw)
                k_cursor = ve + 12
            recovered.append({
                "id": f"xml_{len(recovered)}",
                "name": fn_name,
                "args": args_dict,
            })

    return "".join(out_parts).strip(), recovered, truncated


def _consume_sse_choices(resp: requests.Response) -> list[dict[str, Any]]:
    """Assemble OpenAI-style choices from a streaming `text/event-stream` response."""
    content_parts: list[str] = []
    tc_by_index: dict[int, dict[str, Any]] = {}
    finish_reason = ""
    had_reasoning = False

    for raw_line in resp.iter_lines(decode_unicode=True):
        if raw_line is None:
            continue
        line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line)
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        data_str = line[5:].strip()
        if data_str == "[DONE]":
            break
        try:
            chunk = json.loads(data_str)
        except json.JSONDecodeError:
            continue
        choices = chunk.get("choices") or []
        if not choices or not isinstance(choices[0], dict):
            continue
        c0 = choices[0]
        if c0.get("finish_reason"):
            finish_reason = str(c0["finish_reason"])
        delta = c0.get("delta") or {}
        if not isinstance(delta, dict):
            continue
        if delta.get("reasoning_content") or delta.get("reasoning"):
            had_reasoning = True
        if delta.get("content"):
            content_parts.append(str(delta["content"]))
        for tc_delta in delta.get("tool_calls") or []:
            if not isinstance(tc_delta, dict):
                continue
            idx = int(tc_delta.get("index") or 0)
            entry = tc_by_index.setdefault(idx, {"id": "", "type": "function", "function": {"name": "", "arguments": []}})
            if tc_delta.get("id"):
                entry["id"] = str(tc_delta["id"])
            fn = tc_delta.get("function") or {}
            if isinstance(fn, dict):
                if fn.get("name"):
                    entry["function"]["name"] = str(fn["name"])
                if fn.get("arguments") is not None:
                    entry["function"]["arguments"].append(str(fn["arguments"]))

    assembled_tcs = [
        {
            "id": tc["id"],
            "type": "function",
            "function": {
                "name": tc["function"]["name"],
                "arguments": "".join(tc["function"]["arguments"]),
            },
        }
        for _, tc in sorted(tc_by_index.items())
    ]
    return [{
        "index": 0,
        "finish_reason": finish_reason,
        "had_reasoning": had_reasoning,
        "message": {
            "role": "assistant",
            "content": "".join(content_parts),
            **({"tool_calls": assembled_tcs} if assembled_tcs else {}),
        },
    }]


def chat_completion_step(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    tier: str = "fast",
    temperature: float = 0.5,
    max_tokens: int = 0,
    skill_record: dict[str, Any] | None = None,
    sensitive: bool = False,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str = "auto",
    reasoning_effort: str | None = None,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Execute a `/v1/chat/completions` step with SSE streaming, returning content + normalized native tool_calls."""
    if not is_v1_enabled(require_coop_extensions=False):
        return {"content": "", "tool_calls": [], "model": "", "truncated_tool_call": False, "finish_reason": ""}

    cfg = get_v1_settings()
    has_vision = any(
        isinstance(m.get("content"), list)
        and any(isinstance(part, dict) and part.get("type") == "image_url" for part in m["content"])
        for m in messages
        if isinstance(m, dict)
    )
    chosen_model = (model or "").strip() or resolve_v1_tier_model(
        tier=tier, has_vision=has_vision, sensitive=sensitive
    )
    model_info = get_v1_model_info(chosen_model)
    cap = model_info["max_output_tokens"]

    clean_tier = (tier or "fast").strip().lower()
    deep_tiers = ("plan", "deep_plan", "deep_recovery", "deep", "pro", "architect", "coding")
    is_deep_call = clean_tier in deep_tiers and "flash" not in chosen_model.lower()
    req_max = int(max_tokens or 0)
    if model_info.get("output_uncapped"):
        if req_max > 0:
            eff_max_tokens: int | None = req_max
        elif is_deep_call or tools:
            eff_max_tokens = None
        else:
            eff_max_tokens = 2048
    elif is_deep_call:
        eff_max_tokens = max(cap, req_max) if req_max > cap else cap
    elif tools:
        eff_max_tokens = min(cap, max(16384, req_max))
    else:
        eff_max_tokens = min(cap, max(2048, req_max))

    payload: dict[str, Any] = {
        "model": chosen_model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }
    if eff_max_tokens is not None:
        payload["max_tokens"] = eff_max_tokens
    supports_re = model_info["supports_reasoning_effort"]
    if not has_vision and (
        supports_re is True
        or (
            supports_re is None
            and cfg["provider"] in ("greenpt", "inference_coop", "tinfoil")
            and any(k in chosen_model.lower() for k in ("glm", "deepseek"))
        )
    ):
        payload["reasoning_effort"] = (
            reasoning_effort.strip().lower()
            if reasoning_effort and reasoning_effort.strip()
            else ("medium" if is_deep_call else "low")
        )

    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice

    if skill_record and supports_coop_extensions(cfg["base_url"]) and not sensitive and cfg["routing_policy"] != "private_tee":
        try:
            synced_slug = sync_skill(skill_record, timeout=6.0)
            if synced_slug:
                payload["skills"] = synced_slug
        except V1QuotaError:
            raise
        except Exception:
            pass

    endpoint_url = f"{cfg['base_url']}/chat/completions"
    resp = _http_post(
        endpoint_url,
        headers=_auth_headers(cfg["api_key"]),
        json=payload,
        stream=True,
        timeout=(15.0, max(30.0, float(timeout))),
    )
    _check_402(resp, cfg["api_key"])
    if resp.status_code != 200:
        raise RuntimeError(f"POST {endpoint_url} HTTP {resp.status_code} (model={chosen_model}): {resp.text[:400]}")

    ctype = str((getattr(resp, "headers", None) or {}).get("Content-Type") or "").lower()
    if ctype.startswith("text/event-stream"):
        choices = _consume_sse_choices(resp)
    else:
        body = resp.json() if resp.content else {}
        choices = body.get("choices") or []

    if not choices:
        return {"content": "", "tool_calls": [], "model": chosen_model, "truncated_tool_call": False, "finish_reason": ""}

    finish_reason = str(choices[0].get("finish_reason") or "").lower()
    msg = choices[0].get("message") or {}
    had_reasoning = bool(
        choices[0].get("had_reasoning") or msg.get("reasoning_content") or msg.get("reasoning")
    )
    raw_content = str(msg.get("content") or "")
    content, xml_tcs, truncated_tool_call = _extract_xml_tool_calls(raw_content)

    parsed_tcs: list[dict[str, Any]] = []
    for raw_tc in msg.get("tool_calls") or []:
        if not isinstance(raw_tc, dict):
            continue
        fn = raw_tc.get("function") or {}
        fn_name = str(fn.get("name") or "").strip()
        if not fn_name:
            continue
        raw_args = fn.get("arguments")
        if isinstance(raw_args, dict):
            parsed_args = raw_args
        elif isinstance(raw_args, str) and raw_args.strip():
            try:
                loaded = json.loads(raw_args)
                parsed_args = loaded if isinstance(loaded, dict) else {}
            except json.JSONDecodeError:
                parsed_args = {}
        else:
            parsed_args = {}

        if finish_reason == "length" and (
            (fn_name == "edit_file" and "replacement" not in parsed_args)
            or (fn_name == "write_file" and "content" not in parsed_args)
        ):
            truncated_tool_call = True
            continue

        parsed_tcs.append({
            "id": str(raw_tc.get("id") or ""),
            "name": fn_name,
            "args": parsed_args,
        })

    if not parsed_tcs and xml_tcs:
        parsed_tcs = xml_tcs

    if finish_reason == "length" and not content and not parsed_tcs and not truncated_tool_call:
        if had_reasoning and tools:
            truncated_tool_call = True
        else:
            raise RuntimeError(
                f"Model '{chosen_model}' exhausted max_tokens={eff_max_tokens or 'uncapped'} before producing output (finish_reason=length)."
            )

    return {
        "content": content,
        "tool_calls": parsed_tcs,
        "model": chosen_model,
        "truncated_tool_call": truncated_tool_call,
        "finish_reason": finish_reason,
    }


def chat_completion(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    tier: str = "fast",
    temperature: float = 0.5,
    max_tokens: int = 2048,
    skill_record: dict[str, Any] | None = None,
    sensitive: bool = False,
    timeout: float = 60.0,
) -> str:
    """Execute a `/v1/chat/completions` call and return the assistant text."""
    res = chat_completion_step(
        messages,
        model=model,
        tier=tier,
        temperature=temperature,
        max_tokens=max_tokens,
        skill_record=skill_record,
        sensitive=sensitive,
        timeout=timeout,
    )
    return str(res.get("content") or "")
