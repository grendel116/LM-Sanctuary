"""Optional program mood-inversion policy and per-session state."""

import copy
import json
import os
import re
import requests

from variables.settings import LOCAL_SERVER_URL, get_local_server_headers

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


def analyze_sentiment_with_llm(text: str) -> dict:
    """Classify mood as bounded UI metadata."""
    if not text:
        return mood_details("calm", 0.0)

    system_instruction = (
        "Classify the message mood. Respond ONLY with a single-line valid JSON object matching this exact format: "
        '{"name": "calm", "intensity": 0.5}. '
        "Do not include markdowns, line breaks, or extra text. "
        "Allowed names: calm, intimate, excited, intense, sad, analytical, focused."
    )

    excerpt = _mood_excerpt(text)

    try:
        # Fetch configurations directly from environment variables
        base_endpoint = os.getenv("LOCAL_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions").rstrip("/")
        model_name = os.getenv("LOCAL_MODEL_NAME", "default-model")

        endpoint = (
            base_endpoint
            if "/v1/chat/completions" in base_endpoint
            else f"{base_endpoint}/v1/chat/completions"
        )

        headers = get_local_server_headers()

        payload = {
            "model": model_name,
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": excerpt},
            ],
            "temperature": 0.0,
            "max_tokens": 32,
            "response_format": {"type": "json_object"},
        }

        # Increased timeout tuple to allow large GGUF model processing (2s connect, 15s read)
        response = requests.post(
            endpoint, json=payload, headers=headers, timeout=(2, 15)
        )
        response.raise_for_status()

        content = response.json()["choices"][0]["message"]["content"]
        match = re.search(r"\{.*\}", content, re.DOTALL)
        raw_json = match.group(0) if match else content
        result = json.loads(raw_json)

        name = str(result.get("name", "calm")).lower().strip()
        intensity = float(result.get("intensity", 0.5))

        allowed_moods = set(DEFAULT_MOOD_NAMES) | {"calm"}
        if name in allowed_moods:
            return mood_details(name, intensity)

    except Exception as e:
        print(f"[MOOD] Sentiment classification failed: {e}")

    return mood_details("calm", 0.5)


def mood_details(name: str, intensity: float) -> dict:
    name = name if name in MOOD_COLORS else "calm"
    intensity = max(0.0, min(1.0, float(intensity)))
    details = MOOD_COLORS[name].copy()
    details["name"] = name
    details["intensity"] = intensity
    details["speed"] = f"{2.0 - (intensity * 1.4):.2f}s"
    return details


def extract_and_strip_mood(text: str) -> tuple[str, dict]:
    return text, analyze_sentiment_with_llm(text)


def analyze_emotional_state(text: str) -> dict:
    return analyze_sentiment_with_llm(text)
