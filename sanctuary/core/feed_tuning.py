"""Declarative, token-free local feed algorithm configuration store."""

import copy
import json
import os
import threading
import time
from typing import Any

_IO_LOCK = threading.RLock()
_STAMP_CACHE: dict[str, tuple[int, int]] = {}

SLIDER_SPECS: dict[str, tuple[int, int, int]] = {
    "recencyHalfLifeHours": (0, 48, 0),
    "smallWeb": (-100, 100, 0),
    "authorDiversity": (0, 100, 0),
    "reposts": (-100, 100, 0),
    "longform": (-100, 100, 0),
    "media": (-100, 100, 0),
    "reciprocity": (0, 100, 0),
    "commercial": (-100, 100, 0),
    "bourgeoisPolitics": (-100, 100, 0),
    "matureContent": (-100, 100, 0),
}

SLIDER_ALIASES: dict[str, str] = {
    "recency": "recencyHalfLifeHours",
    "recency_half_life": "recencyHalfLifeHours",
    "recency_half_life_hours": "recencyHalfLifeHours",
    "recencyhalflifehours": "recencyHalfLifeHours",
    "small_web": "smallWeb",
    "smallweb": "smallWeb",
    "anti_viral": "smallWeb",
    "antiviral": "smallWeb",
    "author_diversity": "authorDiversity",
    "authordiversity": "authorDiversity",
    "diversity": "authorDiversity",
    "repost": "reposts",
    "boosts": "reposts",
    "long_form": "longform",
    "text_depth": "longform",
    "text_depth_weight": "longform",
    "media_weight": "media",
    "reciprocity_weight": "reciprocity",
    "commercial_weight": "commercial",
    "ads": "commercial",
    "bourgeois_politics": "bourgeoisPolitics",
    "bourgeoispolitics": "bourgeoisPolitics",
    "bourgeois_politics_weight": "bourgeoisPolitics",
    "politics": "bourgeoisPolitics",
    "mature": "matureContent",
    "mature_content": "matureContent",
    "maturecontent": "matureContent",
    "mature_content_weight": "matureContent",
    "nsfw": "matureContent",
}

FEED_PRESETS: dict[str, dict[str, int]] = {
    "chronological": {k: 0 for k in SLIDER_SPECS},
    "reset": {k: 0 for k in SLIDER_SPECS},
    "small_web": {
        "recencyHalfLifeHours": 8,
        "smallWeb": 75,
        "authorDiversity": 60,
        "reposts": -35,
        "longform": 25,
        "media": 0,
        "reciprocity": 50,
        "commercial": -70,
        "bourgeoisPolitics": -50,
        "matureContent": 0,
    },
    "deep_reading": {
        "recencyHalfLifeHours": 16,
        "smallWeb": 45,
        "authorDiversity": 50,
        "reposts": -50,
        "longform": 80,
        "media": -25,
        "reciprocity": 25,
        "commercial": -80,
        "bourgeoisPolitics": -40,
        "matureContent": 0,
    },
    "anti_noise": {
        "recencyHalfLifeHours": 6,
        "smallWeb": 55,
        "authorDiversity": 65,
        "reposts": -60,
        "longform": 20,
        "media": 0,
        "reciprocity": 35,
        "commercial": -100,
        "bourgeoisPolitics": -100,
        "matureContent": 0,
    },
    "visual_art": {
        "recencyHalfLifeHours": 12,
        "smallWeb": 35,
        "authorDiversity": 45,
        "reposts": 0,
        "longform": -30,
        "media": 85,
        "reciprocity": 25,
        "commercial": -60,
        "bourgeoisPolitics": -40,
        "matureContent": 0,
    },
}


def default_feed_profile() -> dict[str, Any]:
    return {
        "version": 1,
        "updatedAt": 0,
        "updatedBy": "default",
        "sliders": {k: default_val for k, (_, _, default_val) in SLIDER_SPECS.items()},
        "boostConcepts": [],
        "dampenConcepts": [],
    }


def _profile_path() -> str:
    import variables.settings as vs

    return os.path.join(vs.VARIABLES_DIR, "feed_profile.json")


def _clamp_int(value: Any, low: int, high: int, fallback: int) -> int:
    try:
        num = int(round(float(value)))
    except (TypeError, ValueError):
        return fallback
    return max(low, min(high, num))


def _clean_concept_list(raw: Any, max_items: int = 16) -> list[str]:
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
        text = " ".join(item.split())[:80].strip()
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


def _canonical_slider_key(raw_key: str) -> str | None:
    if raw_key in SLIDER_SPECS:
        return raw_key
    norm = str(raw_key or "").strip().lower().replace("-", "_").replace(" ", "_")
    if norm in SLIDER_ALIASES:
        return SLIDER_ALIASES[norm]
    for canonical in SLIDER_SPECS:
        if canonical.lower() == norm.replace("_", ""):
            return canonical
    return None


def normalize_feed_profile(raw: Any, *, preserve_updated_at: int | None = None) -> dict[str, Any]:
    """Validate and clamp a FeedTuningProfile dictionary."""
    base = default_feed_profile()
    if not isinstance(raw, dict):
        if preserve_updated_at is not None:
            base["updatedAt"] = int(preserve_updated_at)
        return base

    raw_sliders = raw.get("sliders") if isinstance(raw.get("sliders"), dict) else {}
    sliders = dict(base["sliders"])
    for key, (low, high, default_val) in SLIDER_SPECS.items():
        if key in raw_sliders:
            sliders[key] = _clamp_int(raw_sliders[key], low, high, default_val)

    boost = _clean_concept_list(raw.get("boostConcepts"))
    dampen_raw = _clean_concept_list(raw.get("dampenConcepts"))
    boost_lower = {c.lower() for c in boost}
    dampen = [c for c in dampen_raw if c.lower() not in boost_lower]

    try:
        updated_at = int(raw.get("updatedAt") or 0)
    except (TypeError, ValueError):
        updated_at = 0
    if preserve_updated_at is not None:
        updated_at = max(updated_at, int(preserve_updated_at))

    updated_by = str(raw.get("updatedBy") or "default").strip()[:64] or "default"
    return {
        "version": 1,
        "updatedAt": max(0, updated_at),
        "updatedBy": updated_by,
        "sliders": sliders,
        "boostConcepts": boost,
        "dampenConcepts": dampen,
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
    preset: str = "",
    sliders: dict[str, Any] | None = None,
    boost_concepts: Any = None,
    dampen_concepts: Any = None,
    add_boost_concepts: Any = None,
    add_dampen_concepts: Any = None,
    remove_concepts: Any = None,
    updated_by: str = "program",
) -> dict[str, Any]:
    """Merge partial slider/preset/concept updates into feed_profile.json atomically."""
    current = load_feed_profile()
    next_sliders = dict(current["sliders"])
    next_boost = list(current["boostConcepts"])
    next_dampen = list(current["dampenConcepts"])

    preset_key = str(preset or "").strip().lower().replace("-", "_").replace(" ", "_")
    if preset_key:
        if preset_key not in FEED_PRESETS:
            valid = ", ".join(sorted(FEED_PRESETS))
            raise ValueError(f"Unknown feed preset '{preset}'. Valid presets: {valid}")
        next_sliders = dict(FEED_PRESETS[preset_key])
        if preset_key == "reset":
            next_boost = []
            next_dampen = []

    if isinstance(sliders, dict):
        for raw_k, raw_v in sliders.items():
            if raw_v is None:
                continue
            canon = _canonical_slider_key(raw_k)
            if not canon:
                continue
            low, high, default_val = SLIDER_SPECS[canon]
            next_sliders[canon] = _clamp_int(raw_v, low, high, next_sliders.get(canon, default_val))

    if boost_concepts is not None:
        next_boost = _clean_concept_list(boost_concepts)
    if dampen_concepts is not None:
        next_dampen = _clean_concept_list(dampen_concepts)

    if add_boost_concepts is not None:
        additions = _clean_concept_list(add_boost_concepts)
        add_lower = {c.lower() for c in additions}
        next_dampen = [c for c in next_dampen if c.lower() not in add_lower]
        next_boost = _clean_concept_list([*next_boost, *additions])

    if add_dampen_concepts is not None:
        additions = _clean_concept_list(add_dampen_concepts)
        add_lower = {c.lower() for c in additions}
        next_boost = [c for c in next_boost if c.lower() not in add_lower]
        next_dampen = _clean_concept_list([*next_dampen, *additions])

    if remove_concepts is not None:
        to_remove = {c.lower() for c in _clean_concept_list(remove_concepts, max_items=64)}
        if to_remove:
            next_boost = [c for c in next_boost if c.lower() not in to_remove]
            next_dampen = [c for c in next_dampen if c.lower() not in to_remove]

    return save_feed_profile(
        {
            "version": 1,
            "sliders": next_sliders,
            "boostConcepts": next_boost,
            "dampenConcepts": next_dampen,
        },
        updated_by=updated_by,
        bump_timestamp=True,
    )


def format_feed_profile_summary(profile: dict[str, Any]) -> str:
    """Human-readable summary returned to Programs and activity logs."""
    sliders = profile.get("sliders") or {}
    active_parts = [f"{k}={v}" for k, v in sliders.items() if int(v or 0) != 0]
    boost = profile.get("boostConcepts") or []
    dampen = profile.get("dampenConcepts") or []
    lines = [
        f"UpdatedBy: {profile.get('updatedBy', 'default')}",
        f"Active Sliders: {', '.join(active_parts) if active_parts else 'default (strict chronological)'}",
        f"Boost Concepts: {', '.join(boost) if boost else 'none'}",
        f"Dampen Concepts: {', '.join(dampen) if dampen else 'none'}",
    ]
    return "\n".join(lines)
