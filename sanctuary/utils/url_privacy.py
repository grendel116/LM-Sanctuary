# SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store
"""Privacy URL normalization helpers (tracking-parameter stripping) for Sanctuary backend tools and routes."""

from __future__ import annotations

from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

TRACKING_EXACT_PARAMS = frozenset({
    "fbclid",
    "gclid",
    "dclid",
    "gbraid",
    "wbraid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "igsh",
    "igshid",
    "si",
    "_hsenc",
    "_hsmi",
    "vero_id",
    "mkt_tok",
    "oly_anon_id",
    "oly_enc_id",
    "rb_clickid",
    "s_cid",
    "wickedid",
    "yclid",
})

TRACKING_PARAM_PREFIXES = ("utm_", "pk_")


def _is_tracking_param(name: str) -> bool:
    key = str(name or "").strip().lower()
    if not key:
        return False
    if key in TRACKING_EXACT_PARAMS:
        return True
    return key.startswith(TRACKING_PARAM_PREFIXES)


def strip_tracking_params(raw_url: str) -> str:
    """Remove known tracking query parameters from http/https URLs while keeping fragments and functional params."""
    text = str(raw_url or "").strip()
    if not text:
        return ""
    try:
        parts = urlsplit(text)
    except Exception:
        return text
    if parts.scheme.lower() not in ("http", "https") or not parts.netloc:
        return text
    if not parts.query:
        return text
    filtered = [
        (k, v)
        for k, v in parse_qsl(parts.query, keep_blank_values=True)
        if not _is_tracking_param(k)
    ]
    new_query = urlencode(filtered, doseq=True)
    return urlunsplit((parts.scheme, parts.netloc, parts.path, new_query, parts.fragment))
