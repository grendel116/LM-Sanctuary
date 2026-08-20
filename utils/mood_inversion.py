"""Optional program mood-inversion policy and per-session state."""

import copy
import json
import os
import re
import requests

DEFAULT_MOOD_NAMES = (
    "intimate",
    "excited",
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


def _mood_excerpt(text: str, edge_tokens: int = 24) -> str:
    """Keep the opening context and emotional landing of a message."""
    tokens = re.findall(r"\S+", text)
    if len(tokens) <= edge_tokens * 2:
        return " ".join(tokens)
    opening = " ".join(tokens[:edge_tokens])
    ending = " ".join(tokens[-edge_tokens:])
    return f"[opening] {opening} [ending] {ending}"


def analyze_sentiment_with_llm(text: str) -> dict:
    """Classify mood as bounded UI metadata, not a second conversation."""
    if not text:
        return mood_details("calm", 0.0)

    api_key = os.getenv("REMOTE_API_KEY", "").strip()
    remote_url = os.getenv("REMOTE_CLOUD_URL", "").strip()
    remote_configured = bool(
        api_key and api_key != "your_remote_api_key_here" and
        remote_url and remote_url != "your_remote_cloud_url_here"
    )
    
    system_instruction = (
        "Classify the message mood. Respond ONLY with a single-line valid JSON object matching this exact format: "
        '{"name": "calm", "intensity": 0.5}. '
        "Do not include markdowns, line breaks, or extra text. "
        "Allowed names: calm, intimate, excited, intense, sad, analytical, focused."
    )

    excerpt = _mood_excerpt(text)

    try:
        from variables import REMOTE_SERVER_URL, get_remote_server_headers
        endpoint = remote_url if remote_configured else REMOTE_SERVER_URL
        headers = get_remote_server_headers()
        payload = {
            "messages": [
                {"role": "system", "content": system_instruction},
                {"role": "user", "content": excerpt},
            ],
            "temperature": 0.0,
            "max_tokens": 32,
            "response_format": {"type": "json_object"},
        }
        if remote_configured:
            from variables import DEFAULT_REMOTE_MODEL
            payload["model"] = DEFAULT_REMOTE_MODEL
            headers = {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"}
        else:
            target_model = os.getenv("LOCAL_MODEL_NAME")
            if target_model:
                payload["model"] = target_model

        response = requests.post(endpoint, json=payload, headers=headers, timeout=(2, 4))
        if response.status_code == 200:
            content = response.json()["choices"][0]["message"]["content"]
            match = re.search(r"\{.*\}", content, re.DOTALL)
            result = json.loads(match.group(0) if match else content)
            name = str(result.get("name", "calm")).lower().strip()
            intensity = float(result.get("intensity", 0.5))
            if name in DEFAULT_MOOD_NAMES + ("calm",):
                return mood_details(name, intensity)
    except Exception as exc:
        print(f"[MOOD] Fast classification unavailable: {exc}")

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
