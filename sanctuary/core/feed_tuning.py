"""Declarative, token-free local feed algorithm configuration store."""

import copy
import json
import os
import re
import threading
import time
from typing import Any

_IO_LOCK = threading.RLock()
_STAMP_CACHE: dict[str, tuple[int, int]] = {}

DEFAULT_DISCOVERY_CHANNELS: tuple[str, ...] = ()
DEFAULT_DISCOVERY_INSTANCES: tuple[str, ...] = ()


def default_feed_profile() -> dict[str, Any]:
    return {
        "version": 2,
        "updatedAt": 0,
        "updatedBy": "default",
        "discoveryChannels": [],
        "discoveryInstances": [],
    }


def _profile_path() -> str:
    import variables.settings as vs

    return os.path.join(vs.VARIABLES_DIR, "feed_profile.json")


def _clean_concept_list(raw: Any, max_items: int = 24) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        items = [part.strip() for part in raw.replace(";", ",").split(",")]
    elif isinstance(raw, (list, tuple, set)):
        items = [str(part).strip() for part in raw if part is not None]
    else:
        return []

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        text = " ".join(item.split())[:160].strip()
        if not text:
            continue
        low = text.lower()
        if low in seen:
            continue
        seen.add(low)
        cleaned.append(text)
        if len(cleaned) >= max_items:
            break
    return cleaned


_PUBLIC_HOST_RE = re.compile(r"^[a-z0-9-]+(?:\.[a-z0-9-]+)+$", re.IGNORECASE)
_IPV4_HOST_RE = re.compile(r"^\d+(?:\.\d+){3}$")


def _clean_instance_list(raw: Any, max_items: int = 12) -> list[str]:
    if raw is None:
        return []
    if isinstance(raw, str):
        items = [part.strip() for part in raw.replace(";", ",").split(",")]
    elif isinstance(raw, (list, tuple, set)):
        items = [str(part).strip() for part in raw if part is not None]
    else:
        return []

    cleaned: list[str] = []
    seen: set[str] = set()
    for item in items:
        host = item.strip().lower()
        if not host:
            continue
        if host.startswith("https://"):
            host = host[len("https://") :]
        elif host.startswith("http://"):
            host = host[len("http://") :]
        elif host.startswith("://"):
            host = host[len("://") :]
        host = host.split("/", 1)[0].split("?", 1)[0].split("#", 1)[0]
        host = host.rsplit(":", 1)[0] if ":" in host and host.rsplit(":", 1)[1].isdigit() else host
        host = host.rstrip(".")
        if not host or not _PUBLIC_HOST_RE.match(host):
            continue
        if _IPV4_HOST_RE.match(host) or host == "localhost" or host.endswith((".local", ".ts.net")):
            continue
        if host in seen:
            continue
        seen.add(host)
        cleaned.append(host)
        if len(cleaned) >= max_items:
            break
    return cleaned


def normalize_feed_profile(raw: Any, *, preserve_updated_at: int | None = None) -> dict[str, Any]:
    """Validate and clamp a FeedTuningProfile dictionary."""
    base = default_feed_profile()
    if not isinstance(raw, dict):
        if preserve_updated_at is not None:
            base["updatedAt"] = int(preserve_updated_at)
        return base

    discovery_channels = _clean_concept_list(raw.get("discoveryChannels"), max_items=24)
    discovery_instances = _clean_instance_list(raw.get("discoveryInstances"), max_items=12)

    try:
        updated_at = int(raw.get("updatedAt") or 0)
    except (TypeError, ValueError):
        updated_at = 0
    if preserve_updated_at is not None:
        updated_at = max(updated_at, int(preserve_updated_at))

    updated_by = str(raw.get("updatedBy") or "default").strip()[:64] or "default"
    return {
        "version": 2,
        "updatedAt": max(0, updated_at),
        "updatedBy": updated_by,
        "discoveryChannels": discovery_channels,
        "discoveryInstances": discovery_instances,
    }


def load_feed_profile() -> dict[str, Any]:
    path = _profile_path()
    with _IO_LOCK:
        if not os.path.exists(path):
            return default_feed_profile()
        try:
            with open(path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            return normalize_feed_profile(raw)
        except Exception:
            return default_feed_profile()


def get_feed_profile_updated_at() -> int:
    """Fast timestamp accessor used by /api/mobile/health."""
    path = _profile_path()
    with _IO_LOCK:
        try:
            st_res = os.stat(path)
        except OSError:
            return 0
        cached = _STAMP_CACHE.get(path)
        if cached and cached[0] == st_res.st_mtime_ns:
            return cached[1]
        profile = load_feed_profile()
        ts = int(profile.get("updatedAt") or 0)
        _STAMP_CACHE[path] = (st_res.st_mtime_ns, ts)
        return ts


def save_feed_profile(profile: dict[str, Any], *, updated_by: str | None = None, bump_timestamp: bool = True) -> dict[str, Any]:
    path = _profile_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _IO_LOCK:
        prev = load_feed_profile()
        prev_ts = int(prev.get("updatedAt") or 0)
        candidate = copy.deepcopy(profile if isinstance(profile, dict) else {})
        if updated_by:
            candidate["updatedBy"] = updated_by
        normalized = normalize_feed_profile(candidate)
        if bump_timestamp:
            now_ms = int(time.time() * 1000)
            normalized["updatedAt"] = max(now_ms, prev_ts + 1, int(normalized.get("updatedAt") or 0))
        elif normalized["updatedAt"] <= 0 and prev_ts > 0:
            normalized["updatedAt"] = prev_ts

        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(normalized, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        try:
            _STAMP_CACHE[path] = (os.stat(path).st_mtime_ns, int(normalized["updatedAt"]))
        except OSError:
            _STAMP_CACHE.pop(path, None)
        return normalized


def apply_feed_tuning_patch(
    *,
    action: str = "update",
    reset: bool = False,
    discovery_channels: Any = None,
    discovery_instances: Any = None,
    add_discovery_channels: Any = None,
    add_discovery_instances: Any = None,
    remove_sources: Any = None,
    updated_by: str = "program",
) -> dict[str, Any]:
    """Merge partial discovery channel/server updates into feed_profile.json atomically."""
    current = load_feed_profile()
    next_channels = list(current.get("discoveryChannels") or [])
    next_instances = list(current.get("discoveryInstances") or [])

    if reset or str(action or "").strip().lower() == "reset":
        next_channels = []
        next_instances = []

    if discovery_channels is not None:
        next_channels = _clean_concept_list(discovery_channels, max_items=24)
    if discovery_instances is not None:
        next_instances = _clean_instance_list(discovery_instances, max_items=12)

    if add_discovery_channels is not None:
        next_channels = _clean_concept_list(
            [*next_channels, *_clean_concept_list(add_discovery_channels, max_items=24)],
            max_items=24,
        )

    if add_discovery_instances is not None:
        next_instances = _clean_instance_list(
            [*next_instances, *_clean_instance_list(add_discovery_instances, max_items=12)],
            max_items=12,
        )

    if remove_sources is not None:
        rm_channels = {c.lower() for c in _clean_concept_list(remove_sources, max_items=64)}
        rm_instances = set(_clean_instance_list(remove_sources, max_items=64))
        if rm_channels:
            next_channels = [c for c in next_channels if c.lower() not in rm_channels]
        if rm_instances or rm_channels:
            next_instances = [h for h in next_instances if h not in rm_instances and h not in rm_channels]

    return save_feed_profile(
        {
            "version": 2,
            "discoveryChannels": next_channels,
            "discoveryInstances": next_instances,
        },
        updated_by=updated_by,
        bump_timestamp=True,
    )


def format_feed_profile_summary(profile: dict[str, Any]) -> str:
    """Human-readable summary returned to Programs and activity logs."""
    channels = profile.get("discoveryChannels") or []
    instances = profile.get("discoveryInstances") or []
    lines = [
        f"UpdatedBy: {profile.get('updatedBy', 'default')}",
        f"Discovery Channels: {', '.join(channels) if channels else 'auto-synced & learned taste'}",
        f"Trusted Servers: {', '.join(instances) if instances else 'connected home server only'}",
    ]
    return "\n".join(lines)
