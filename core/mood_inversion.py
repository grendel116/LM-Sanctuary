"""Optional program mood-inversion policy and per-session state."""

import copy
import json
import os
import re
import requests

from variables.settings import get_local_server_headers

DEFAULT_MOOD_NAMES = (
    "intimate",
    "excited",
    "calm",
    "intense",
    "sad",
    "analytical",
    "focused",
)

DEFAULT_INVERSION_STATE = {
    "active_inversion": "",
    "inversion_consecutive_turns": 0,
    "mood_tally": {name: 0 for name in DEFAULT_MOOD_NAMES},
}
ACTIVATION_THRESHOLD = 5
ACTIVE_TURN_LIMIT = 5
MOOD_COLORS = {
    "intimate": {"color": "#c084fc", "glow": "rgba(192, 132, 252, 0.85)"},
    "excited": {"color": "#a78bfa", "glow": "rgba(167, 139, 250, 0.9)"},
    "calm": {"color": "#818cf8", "glow": "rgba(129, 140, 248, 0.85)"},
    "intense": {"color": "#f472b6", "glow": "rgba(244, 114, 182, 0.85)"},
    "sad": {"color": "#94a3b8", "glow": "rgba(148, 163, 184, 0.65)"},
    "analytical": {"color": "#60a5fa", "glow": "rgba(96, 165, 250, 0.85)"},
    "focused": {"color": "#9370db", "glow": "rgba(147, 112, 219, 0.9)"},
}

def new_state() -> dict:
    return copy.deepcopy(DEFAULT_INVERSION_STATE)


def is_enabled(programs_dir: str, program_id: str) -> bool:
    path = os.path.join(programs_dir, program_id, "inversion.json")
    if not os.path.exists(path):
        return False
    try:
        with open(path, "r", encoding="utf-8") as inversion_file:
            return bool(json.load(inversion_file))
    except (OSError, json.JSONDecodeError):
        return False


def update_state(state: dict, mood_name: str) -> dict:
    if not isinstance(state, dict) or mood_name not in DEFAULT_MOOD_NAMES + ("calm",):
        return state

    if state.get("active_inversion"):
        state["inversion_consecutive_turns"] = state.get("inversion_consecutive_turns", 0) + 1
        if state["inversion_consecutive_turns"] >= ACTIVE_TURN_LIMIT:
            state["active_inversion"] = ""
            state["inversion_consecutive_turns"] = 0
        return state

    tally = state.setdefault("mood_tally", {name: 0 for name in DEFAULT_MOOD_NAMES})
    if mood_name in tally:
        tally[mood_name] += 1
        for name in tally:
            if name != mood_name and tally[name] > 0:
                tally[name] -= 1
        if tally[mood_name] >= ACTIVATION_THRESHOLD:
            state["active_inversion"] = mood_name
            state["inversion_consecutive_turns"] = 0
            state["mood_tally"] = {name: 0 for name in DEFAULT_MOOD_NAMES}
    elif mood_name == "calm":
        for name in tally:
            if tally[name] > 0:
                tally[name] -= 1
    return state


def get_directive(programs_dir: str, program_id: str, mood_name: str) -> str:
    if not mood_name:
        return ""
    path = os.path.join(programs_dir, program_id, "inversion.json")
    try:
        with open(path, "r", encoding="utf-8") as inversion_file:
            directives = json.load(inversion_file)
        return directives.get(mood_name, "")
    except (OSError, json.JSONDecodeError):
        return ""


def _mood_excerpt(text: str, total_tokens: int = 48) -> str:
    """Sample opening, middle, and ending context for sentiment analysis."""
    tokens = re.findall(r"\S+", text)
    if len(tokens) <= total_tokens:
        return " ".join(tokens)
    
    chunk = total_tokens // 3
    mid_idx = len(tokens) // 2
    
    opening = " ".join(tokens[:chunk])
    middle = " ".join(tokens[mid_idx - (chunk // 2) : mid_idx + (chunk // 2)])
    ending = " ".join(tokens[-chunk:])
    
    return f"[opening] {opening} [middle] {middle} [ending] {ending}"


# Lexicon for fast local sentiment classification (zero-latency, no KV cache eviction)
MOOD_KEYWORDS = {
    "intimate": ["love", "tender", "gentle", "sweet", "cherish", "embrace", "warmth", "caress", "softly", "affection", "darling", "beloved", "cushion", "starlight"],
    "excited": ["excited", "thrilled", "amazing", "wonderful", "laugh", "smile", "delight", "bright", "celebrate", "eager", "haha", "yay", "cheer"],
    "intense": ["intense", "urgent", "danger", "fierce", "battle", "struggle", "rage", "strike", "clash", "fury", "flame", "critical", "violent"],
    "sad": ["sad", "sorrow", "grief", "mourn", "weep", "tear", "regret", "loss", "pain", "melancholy", "hurt", "despair", "lonely"],
    "analytical": ["analyze", "dialectic", "materialism", "theory", "empirical", "logic", "synthesis", "capital", "structure", "critique", "system", "evaluate", "method"],
    "focused": ["focus", "target", "plan", "execute", "task", "code", "inspect", "implement", "organize", "solve", "precise", "direct", "work"]
}

def analyze_sentiment_fast(text: str) -> dict:
    """Classify mood instantly using keyword density and regex heuristics."""
    if not text or not text.strip():
        return mood_details("calm", 0.0)

    # Check for explicit tags like [mood: analytical] or (mood: intimate)
    tag_match = re.search(r"\[mood:\s*(\w+)\]", text, re.IGNORECASE)
    if tag_match:
        tag_name = tag_match.group(1).lower()
        if tag_name in DEFAULT_MOOD_NAMES:
            return mood_details(tag_name, 0.8)

    text_lower = text.lower()
    scores = {}
    for mood, keywords in MOOD_KEYWORDS.items():
        score = sum(1 for kw in keywords if re.search(rf"\b{re.escape(kw)}\b", text_lower))
        if score > 0:
            scores[mood] = score

    if not scores:
        return mood_details("calm", 0.3)

    best_mood = max(scores, key=scores.get)
    max_count = scores[best_mood]
    intensity = min(1.0, 0.3 + (max_count * 0.15))
    return mood_details(best_mood, intensity)


def analyze_sentiment_with_llm(text: str) -> dict:
    """Fast sentiment classification avoiding prompt cache invalidation."""
    return analyze_sentiment_fast(text)


def mood_details(name: str, intensity: float) -> dict:
    name = name if name in MOOD_COLORS else "calm"
    intensity = max(0.0, min(1.0, float(intensity)))
    details = MOOD_COLORS[name].copy()
    details["name"] = name
    details["intensity"] = intensity
    details["speed"] = f"{2.0 - (intensity * 1.4):.2f}s"
    return details


def extract_and_strip_mood(text: str) -> tuple[str, dict]:
    clean_text = re.sub(r"\[mood:\s*\w+\]", "", text, flags=re.IGNORECASE).strip()
    return clean_text, analyze_sentiment_fast(text)


def analyze_emotional_state(text: str) -> dict:
    return analyze_sentiment_fast(text)
