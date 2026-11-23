"""GreenPT & OpenAI-compatible Worker-Coop `/v1` client for LM-Sanctuary.

Provides a single minimal HTTP client for:
- Web search (`POST /v1/tools/websearch`, fallback `POST /v1/tools/search/web`)
- JS-capable Markdown scraping (`POST /v1/tools/crawl/scrape`)
- Docling OCR & file conversion (`POST /v1/tools/documents/convert/file`)
- Semantic chunk reranking (`POST /v1/rerank` with `green-rerank`)
- Server-side AgentSkills sync (`GET/POST/PATCH /v1/skills`)
- Cloud chat & multimodal vision completions (`POST /v1/chat/completions`)
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import threading
import time
from urllib.parse import urlparse
from typing import Any

import requests

from variables.settings import BASE_DIR as SANCTUARY_DIR

DEFAULT_GREENPT_BASE_URL = "https://api.greenpt.ai/v1"
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


class GreenPTQuotaError(RuntimeError):
    """Raised when the configured `/v1` endpoint rejects a call with HTTP 402 (no credits)."""


def _key_fingerprint(api_key: str) -> str:
    if not api_key:
        return ""
    return hashlib.sha256(api_key.encode("utf-8")).hexdigest()[:12]


def get_greenpt_settings() -> dict[str, Any]:
    """Load Cloud /v1 settings from `project_settings.json` + env vars."""
    raw: dict[str, Any] = {}
    if os.path.isfile(_SETTINGS_PATH):
        try:
            with open(_SETTINGS_PATH, "r", encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                raw = loaded
        except (OSError, json.JSONDecodeError):
            raw = {}

    api_key = (
        str(raw.get("greenpt_api_key") or "").strip()
        or os.getenv("CLOUD_API_KEY", "").strip()
        or os.getenv("GREENPT_API_KEY", "").strip()
    )
    base_url = (
        str(raw.get("greenpt_base_url") or "").strip()
        or os.getenv("CLOUD_BASE_URL", "").strip()
        or os.getenv("GREENPT_BASE_URL", "").strip()
        or DEFAULT_GREENPT_BASE_URL
    ).rstrip("/")

    policy = (
        str(raw.get("routing_policy") or "").strip().lower()
        or os.getenv("SANCTUARY_ROUTING_POLICY", "auto").strip().lower()
    )
    if policy not in VALID_ROUTING_POLICIES:
        policy = "auto"

    provider = detect_cloud_provider(base_url)

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

    return {
        "api_key": api_key,
        "base_url": base_url,
        "provider": provider,
        "routing_policy": policy,
        "default_model": default_model,
        "fast_model": fast_model,
        "vision_model": vision_model,
        "private_model": private_model,
    }


def is_local_endpoint(base_url: str) -> bool:
    host = (urlparse(base_url or "").hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "0.0.0.0", "::1")


def detect_cloud_provider(base_url: str | None = None) -> str:
    """Identify the configured OpenAI-compatible `/v1` provider family by hostname."""
    if base_url is None:
        base_url = get_greenpt_settings()["base_url"]
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


def is_native_greenpt(base_url: str | None = None) -> bool:
    """Return True if `base_url` targets GreenPT's native API (`*.greenpt.ai`)."""
    url = base_url if base_url is not None else get_greenpt_settings()["base_url"]
    host = (urlparse(url or "").hostname or "").lower()
    return host == "greenpt.ai" or host.endswith(".greenpt.ai")


def is_quota_exhausted(api_key: str | None = None) -> bool:
    cfg = get_greenpt_settings()
    fp = _key_fingerprint(api_key if api_key is not None else cfg["api_key"])
    with _STATE_LOCK:
        if not _quota_exhausted_until:
            return False
        if fp != _quota_exhausted_key_fp or time.monotonic() >= _quota_exhausted_until:
            return False
        return True


def mark_quota_exhausted(api_key: str | None = None, cooldown: float = _QUOTA_COOLDOWN_SECONDS) -> None:
    cfg = get_greenpt_settings()
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


def is_cloud_enabled(require_native_greenpt: bool = False) -> bool:
    """Return True when cloud routing is permitted, configured, and not in 402 cooldown."""
    cfg = get_greenpt_settings()
    if cfg["routing_policy"] == "local_only":
        return False
    if not cfg["api_key"] and not is_local_endpoint(cfg["base_url"]):
        return False
    if require_native_greenpt and not is_native_greenpt(cfg["base_url"]):
        return False
    if is_quota_exhausted(cfg["api_key"]):
        return False
    return True


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
        raise GreenPTQuotaError(f"HTTP 402: {resp.text[:240]}")


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
    """Query GreenPT `/v1/tools/websearch` (with `/v1/tools/search/web` fallback)."""
    clean_q = (query or "").strip()
    if not clean_q or not is_cloud_enabled(require_native_greenpt=True):
        return []

    cfg = get_greenpt_settings()
    headers = _auth_headers(cfg["api_key"])
    base = cfg["base_url"]

    resp = requests.post(
        f"{base}/tools/websearch",
        headers=headers,
        json={
            "query": clean_q,
            "count": max(1, min(10, int(count))),
            "fullPageContent": full_page_content,
        },
        timeout=timeout,
    )
    _check_402(resp, cfg["api_key"])

    if resp.status_code == 404:
        resp = requests.post(
            f"{base}/tools/search/web",
            headers=headers,
            json={"query": clean_q, "maxResults": max(1, min(10, int(count)))},
            timeout=timeout,
        )
        _check_402(resp, cfg["api_key"])

    if resp.status_code != 200:
        return []

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
    """Scrape clean Markdown from a JS/cookie-gated page via GreenPT `/v1/tools/crawl/scrape`."""
    clean_url = (url or "").strip()
    if not clean_url or not is_cloud_enabled(require_native_greenpt=True):
        return ""

    cfg = get_greenpt_settings()
    resp = requests.post(
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
    """Convert PDF/DOCX/PPTX/XLSX/image files to Markdown via GreenPT Docling OCR endpoint."""
    if not file_path or not os.path.isfile(file_path) or not is_cloud_enabled(require_native_greenpt=True):
        return ""

    cfg = get_greenpt_settings()
    fname = filename or os.path.basename(file_path)
    mime = mimetypes.guess_type(fname)[0] or "application/octet-stream"
    headers = _auth_headers(cfg["api_key"], json_body=False)
    endpoint = f"{cfg['base_url']}/tools/documents/convert/file"

    for field_name in ("files", "file"):
        with open(file_path, "rb") as fp:
            resp = requests.post(
                endpoint,
                headers=headers,
                files={field_name: (fname, fp, mime)},
                data={"to_formats": "md"},
                timeout=timeout,
            )
        _check_402(resp, cfg["api_key"])
        if resp.status_code != 422:
            break

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
    """Rerank candidate chunks via GreenPT `POST /v1/rerank`. Returns `[(index, score), ...]`."""
    if not query or len(documents) <= 1 or not is_cloud_enabled(require_native_greenpt=True):
        return []

    cfg = get_greenpt_settings()
    resp = requests.post(
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


def format_greenpt_skill_payload(record: dict[str, Any]) -> dict[str, str]:
    """Normalize a Sanctuary skill record into GreenPT's exact `/v1/skills` schema."""
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
    """Ensure `record` is synced to GreenPT `/v1/skills` and return its slug name."""
    if not is_cloud_enabled(require_native_greenpt=True):
        return None

    payload = format_greenpt_skill_payload(record)
    if not payload["instructions"]:
        return None

    cfg = get_greenpt_settings()
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
        list_resp = requests.get(f"{base}/skills", headers=headers, timeout=timeout)
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
        resp = requests.patch(
            f"{base}/skills/{skill_id}",
            headers=headers,
            json=payload,
            timeout=timeout,
        )
    else:
        resp = requests.post(
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


def resolve_cloud_tier_model(tier: str = "fast", has_vision: bool = False, sensitive: bool = False) -> str:
    """Select the configured Cloud /v1 model for a requested reasoning or privacy role."""
    cfg = get_greenpt_settings()
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

    if is_private and (clean_tier in ("plan", "deep_plan", "deep_recovery", "deep", "pro", "architect", "coding", "private") or cfg["routing_policy"] == "private_tee"):
        return cfg["private_model"] or preset.get("private") or cfg["default_model"]

    if clean_tier in ("plan", "deep_plan", "deep_recovery"):
        return cfg["default_model"] or preset.get("deep") or DEEP_CLOUD_MODEL

    if cfg["routing_policy"] == "eco_flash" or clean_tier == "fast":
        return cfg["fast_model"] or preset.get("fast") or cfg["default_model"]

    if clean_tier in ("deep", "pro", "architect", "coding"):
        return cfg["default_model"] or preset.get("deep") or DEEP_CLOUD_MODEL

    return cfg["fast_model"] or preset.get("fast") or cfg["default_model"]


def supports_systemone(base_url: str | None = None) -> bool:
    """Return True when the endpoint exposes GreenPT's Metis `/v1/systemone` decision API."""
    return detect_cloud_provider(base_url) in ("greenpt", "inference_coop")


def systemone_decide(
    state: str,
    questions: dict[str, dict[str, Any]],
    *,
    timeout: float = 6.0,
) -> dict[str, Any] | None:
    """Call GreenPT/Inference-Coop Metis `/v1/systemone` for calibrated non-prose decisions."""
    if not state or not questions or not is_cloud_enabled(require_native_greenpt=False):
        return None
    cfg = get_greenpt_settings()
    if not supports_systemone(cfg["base_url"]):
        return None
    try:
        resp = requests.post(
            f"{cfg['base_url']}/systemone",
            headers=_auth_headers(cfg["api_key"]),
            json={"model": "metis", "state": str(state), "questions": questions},
            timeout=timeout,
        )
        _check_402(resp, cfg["api_key"])
        if resp.status_code != 200:
            return None
        return resp.json() if resp.content else None
    except GreenPTQuotaError:
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


def chat_completion_step(
    messages: list[dict[str, Any]],
    *,
    model: str | None = None,
    tier: str = "fast",
    temperature: float = 0.5,
    max_tokens: int = 2048,
    skill_record: dict[str, Any] | None = None,
    sensitive: bool = False,
    tools: list[dict[str, Any]] | None = None,
    tool_choice: str = "auto",
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Execute a cloud `/v1/chat/completions` step, returning content + normalized native tool_calls."""
    if not is_cloud_enabled(require_native_greenpt=False):
        return {"content": "", "tool_calls": [], "model": "", "truncated_tool_call": False}

    cfg = get_greenpt_settings()
    has_vision = any(
        isinstance(m.get("content"), list)
        and any(isinstance(part, dict) and part.get("type") == "image_url" for part in m["content"])
        for m in messages
        if isinstance(m, dict)
    )
    chosen_model = (model or "").strip() or resolve_cloud_tier_model(
        tier=tier, has_vision=has_vision, sensitive=sensitive
    )

    clean_tier = (tier or "fast").strip().lower()
    deep_tiers = ("plan", "deep_plan", "deep_recovery", "deep", "pro", "architect", "coding")
    is_deep_call = clean_tier in deep_tiers and "flash" not in chosen_model.lower()
    if is_deep_call:
        eff_max_tokens = max(8192, int(max_tokens))
    elif tools:
        eff_max_tokens = max(4096, int(max_tokens))
    else:
        eff_max_tokens = max(2048, int(max_tokens))

    payload: dict[str, Any] = {
        "model": chosen_model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": eff_max_tokens,
    }
    if (
        cfg["provider"] in ("greenpt", "inference_coop", "tinfoil")
        and any(k in chosen_model.lower() for k in ("glm", "deepseek"))
        and not has_vision
    ):
        payload["reasoning_effort"] = "medium" if is_deep_call else "low"

    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice

    if skill_record and is_native_greenpt(cfg["base_url"]) and not sensitive and cfg["routing_policy"] != "private_tee":
        try:
            synced_slug = sync_skill(skill_record, timeout=6.0)
            if synced_slug:
                payload["skills"] = synced_slug
        except GreenPTQuotaError:
            raise
        except Exception:
            pass

    resp = requests.post(
        f"{cfg['base_url']}/chat/completions",
        headers=_auth_headers(cfg["api_key"]),
        json=payload,
        timeout=timeout,
    )
    if resp.status_code == 400 and "reasoning_effort" in payload:
        payload = {k: v for k, v in payload.items() if k != "reasoning_effort"}
        resp = requests.post(
            f"{cfg['base_url']}/chat/completions",
            headers=_auth_headers(cfg["api_key"]),
            json=payload,
            timeout=timeout,
        )
    if resp.status_code == 400 and "tools" in payload:
        payload = {k: v for k, v in payload.items() if k not in ("tools", "tool_choice")}
        resp = requests.post(
            f"{cfg['base_url']}/chat/completions",
            headers=_auth_headers(cfg["api_key"]),
            json=payload,
            timeout=timeout,
        )
    _check_402(resp, cfg["api_key"])
    if resp.status_code != 200:
        raise RuntimeError(f"Cloud LLM HTTP {resp.status_code}: {resp.text[:300]}")

    body = resp.json() if resp.content else {}
    choices = body.get("choices") or []
    if not choices:
        return {"content": "", "tool_calls": [], "model": chosen_model, "truncated_tool_call": False}

    finish_reason = str(choices[0].get("finish_reason") or "").lower()
    msg = choices[0].get("message") or {}
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

    return {
        "content": content,
        "tool_calls": parsed_tcs,
        "model": chosen_model,
        "truncated_tool_call": truncated_tool_call,
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
    """Execute a cloud `/v1/chat/completions` turn (with optional GreenPT server-side `skills`)."""
    step = chat_completion_step(
        messages,
        model=model,
        tier=tier,
        temperature=temperature,
        max_tokens=max_tokens,
        skill_record=skill_record,
        sensitive=sensitive,
        timeout=timeout,
    )
    return str(step.get("content") or "").strip()
