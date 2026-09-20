"""Program mood-inversion policy, CMYK sequential palette generation, and emotional state tracking."""

import copy
import json
import os
import re

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROGRAMS_DIR = os.path.join(BASE_DIR, "core", "programs")

ACTIVATION_THRESHOLD = 5
ACTIVE_TURN_LIMIT = 5

DEFAULT_MOOD_NAMES = (
    "intimate",
    "excited",
    "intense",
    "sad",
)

STANDARD_MOOD_EMOJIS = {
    "intimate": "🌸",
    "excited": "⚡",
    "intense": "🔥",
    "sad": "💧",
    "jealous": "💚",
    "analytical": "🔬",
    "focused": "🎯",
    "playful": "✨",
    "rebellious": "⚡",
    "vulnerable": "💧",
    "baseline": "✨",
    "calm": "🌊",
}

# Sequential CMYK channel modulation functions
CMYK_STEP_MODS = [
    # 0: Magenta emphasis (warmth, intimacy, violet-rose)
    lambda c, m, y, k: (c * 0.4, min(1.0, m + 0.60), y * 0.3, k),
    # 1: Yellow emphasis (energy, brightness, gold-lime)
    lambda c, m, y, k: (c * 0.3, m * 0.4, min(1.0, y + 0.80), k),
    # 2: Magenta + Yellow emphasis (bold fire, crimson-coral)
    lambda c, m, y, k: (c * 0.1, min(1.0, m + 0.70), min(1.0, y + 0.65), k),
    # 3: Key / Depth emphasis (vulnerability, deep melancholic slate)
    lambda c, m, y, k: (c * 0.7 + 0.1, m * 0.7 + 0.1, y * 0.3, min(1.0, k + 0.45)),
    # 4: Cyan emphasis (crystalline aqua/teal)
    lambda c, m, y, k: (min(1.0, c + 0.75), m * 0.3, y * 0.3, k),
    # 5: Cyan + Magenta emphasis (deep violet/indigo)
    lambda c, m, y, k: (min(1.0, c + 0.50), min(1.0, m + 0.60), y * 0.1, k),
]


def rgb_to_cmyk(hex_str: str) -> tuple[float, float, float, float]:
    """Convert RGB hex color to normalized CMYK coordinates."""
    hex_clean = hex_str.lstrip("#")
    if len(hex_clean) == 3:
        hex_clean = "".join(char * 2 for char in hex_clean)
    try:
        r, g, b = [int(hex_clean[i:i+2], 16) / 255.0 for i in (0, 2, 4)]
    except Exception:
        return 0.0, 0.0, 0.0, 0.0
    k = 1.0 - max(r, g, b)
    if k >= 1.0:
        return 0.0, 0.0, 0.0, 1.0
    c = (1.0 - r - k) / (1.0 - k)
    m = (1.0 - g - k) / (1.0 - k)
    y = (1.0 - b - k) / (1.0 - k)
    return c, m, y, k


def cmyk_to_hex(c: float, m: float, y: float, k: float) -> str:
    """Convert normalized CMYK coordinates to RGB hex string."""
    c = max(0.0, min(1.0, c))
    m = max(0.0, min(1.0, m))
    y = max(0.0, min(1.0, y))
    k = max(0.0, min(1.0, k))
    r = int(round(255 * (1.0 - c) * (1.0 - k)))
    g = int(round(255 * (1.0 - m) * (1.0 - k)))
    b = int(round(255 * (1.0 - y) * (1.0 - k)))
    return f"#{max(0, min(255, r)):02x}{max(0, min(255, g)):02x}{max(0, min(255, b)):02x}"


def hex_to_rgba_glow(hex_str: str, alpha: float = 0.85) -> str:
    """Generate CSS rgba glow string from hex color."""
    hex_clean = hex_str.lstrip("#")
    if len(hex_clean) == 3:
        hex_clean = "".join(char * 2 for char in hex_clean)
    try:
        r, g, b = [int(hex_clean[i:i+2], 16) for i in (0, 2, 4)]
        return f"rgba({r}, {g}, {b}, {alpha})"
    except Exception:
        return f"rgba(133, 185, 235, {alpha})"


def _resolve_program_id(program_id: str | None = None) -> str:
    if program_id:
        return program_id
    try:
        from runners.program import get_active_program
        return get_active_program()
    except Exception:
        return os.getenv("ACTIVE_PROGRAM", "sebile")


def load_program_inversion(program_id: str | None = None) -> dict:
    """Load the raw inversion.json definition for a character."""
    pid = _resolve_program_id(program_id)
    path = os.path.join(PROGRAMS_DIR, pid, "inversion.json")
    if not os.path.exists(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except (OSError, json.JSONDecodeError):
        return {}


def get_program_base_color(program_id: str | None = None) -> str:
    """Fetch the primary signature theme color for a character."""
    pid = _resolve_program_id(program_id)
    theme_path = os.path.join(PROGRAMS_DIR, pid, "theme.json")
    if os.path.exists(theme_path):
        try:
            with open(theme_path, "r", encoding="utf-8") as f:
                theme_data = json.load(f)
                color = theme_data.get("main_color") or theme_data.get("primary_accent")
                if color:
                    return color
        except Exception:
            pass
    return "#38bdf8"


def get_program_mood_keys(program_id: str | None = None) -> list[str]:
    """Return the exact mood keys defined in the character's inversion.json."""
    inv = load_program_inversion(program_id)
    if inv:
        return list(inv.keys())
    return list(DEFAULT_MOOD_NAMES)


def get_program_mood_metadata(program_id: str | None = None) -> dict:
    """Generate CMYK-shifted palettes and metadata bound to the program's base color."""
    pid = _resolve_program_id(program_id)
    base_color = get_program_base_color(pid)
    inversion_dict = load_program_inversion(pid)
    mood_keys = list(inversion_dict.keys()) if inversion_dict else list(DEFAULT_MOOD_NAMES)

    c0, m0, y0, k0 = rgb_to_cmyk(base_color)

    moods_meta = {}
    for idx, mood in enumerate(mood_keys):
        step_fn = CMYK_STEP_MODS[idx % len(CMYK_STEP_MODS)]
        c_mod, m_mod, y_mod, k_mod = step_fn(c0, m0, y0, k0)
        mood_hex = cmyk_to_hex(c_mod, m_mod, y_mod, k_mod)
        mood_glow = hex_to_rgba_glow(mood_hex, 0.85)
        emoji = STANDARD_MOOD_EMOJIS.get(mood, "✨")
        label = mood.replace("_", " ").title()

        val = inversion_dict.get(mood, "")
        directive = val if isinstance(val, str) else (val.get("directive", "") if isinstance(val, dict) else "")

        moods_meta[mood] = {
            "name": mood,
            "label": label,
            "color": mood_hex,
            "glow": mood_glow,
            "emoji": emoji,
            "directive": directive,
        }

    baseline_meta = {
        "name": "baseline",
        "label": "Serene",
        "color": base_color,
        "glow": hex_to_rgba_glow(base_color, 0.85),
        "emoji": "✨",
        "speed": "2.00s",
        "intensity": 0.0,
    }

    return {
        "program_id": pid,
        "base_color": base_color,
        "baseline": baseline_meta,
        "moods": moods_meta,
    }


def new_state(program_id: str | None = None) -> dict:
    """Construct a clean session inversion state bound to the program's mood schema."""
    pid = _resolve_program_id(program_id)
    mood_keys = get_program_mood_keys(pid)
    return {
        "active_inversion": "",
        "inversion_consecutive_turns": 0,
        "mood_tally": {name: 0 for name in mood_keys},
    }


def is_enabled(programs_dir: str, program_id: str) -> bool:
    """Determine whether mood inversion directives are configured for the program."""
    inversion_data = load_program_inversion(program_id)
    return bool(inversion_data)


def update_state(state: dict, mood_name: str, program_id: str | None = None) -> dict:
    """Advance mood tallies and trigger or expire active inversions."""
    if not isinstance(state, dict):
        return state

    pid = _resolve_program_id(program_id)
    mood_keys = get_program_mood_keys(pid)
    tally = state.setdefault("mood_tally", {name: 0 for name in mood_keys})

    # Cooldown on neutral baseline or calm
    if mood_name in ("baseline", "calm", ""):
        for name in tally:
            if tally[name] > 0:
                tally[name] -= 1
        return state

    # Handle turn count when inversion is active
    if state.get("active_inversion"):
        state["inversion_consecutive_turns"] = state.get("inversion_consecutive_turns", 0) + 1
        if state["inversion_consecutive_turns"] >= ACTIVE_TURN_LIMIT:
            state["active_inversion"] = ""
            state["inversion_consecutive_turns"] = 0
        return state

    # Tally updates only for valid program moods
    if mood_name in tally:
        tally[mood_name] += 1
        for name in tally:
            if name != mood_name and tally[name] > 0:
                tally[name] -= 1

        if tally[mood_name] >= ACTIVATION_THRESHOLD:
            state["active_inversion"] = mood_name
            state["inversion_consecutive_turns"] = 0
            state["mood_tally"] = {name: 0 for name in mood_keys}

    return state


def get_directive(programs_dir: str, program_id: str, mood_name: str) -> str:
    """Retrieve the prompt directive text for an active inversion mood."""
    if not mood_name:
        return ""
    inversion_data = load_program_inversion(program_id)
    val = inversion_data.get(mood_name, "")
    if isinstance(val, dict):
        return val.get("directive", "")
    return str(val) if val else ""


def parse_mood_tag(text: str) -> tuple[str, str, float]:
    """Parse self-declared mood and intensity tag from the model's output.

    Returns:
        (clean_text, mood_name, intensity)
    """
    if not text:
        return "", "baseline", 0.0

    # Match <mood ... /> or <mood ...>...</mood> or <mood ...> or [mood: ...]
    xml_match = re.search(r'<mood\b([^>]*?)(?:/>|>.*?</mood>|>|$)', text, re.IGNORECASE | re.DOTALL)
    bracket_match = re.search(r'\[mood:\s*([^\]]+)\]', text, re.IGNORECASE)

    tag_str = None
    attrs = ""
    if xml_match:
        tag_str = xml_match.group(0)
        attrs = xml_match.group(1)
    elif bracket_match:
        tag_str = bracket_match.group(0)
        attrs = bracket_match.group(1)

    if not tag_str:
        return text.strip(), "baseline", 0.0

    # Extract mood name
    name_m = re.search(r'(?:name|mood)\s*=\s*["\']?([a-zA-Z_]+)["\']?', attrs, re.IGNORECASE)
    if name_m:
        mood_name = name_m.group(1).lower().strip()
    else:
        word_m = re.search(r'\b([a-zA-Z_]+)\b', attrs)
        mood_name = word_m.group(1).lower().strip() if word_m else "baseline"

    # Extract intensity (supports 85%, 0.85, 85, etc.)
    int_m = re.search(r'(?:intensity\s*=\s*["\']?|[\s,:]|^)([\d\.]+)(%?)', attrs, re.IGNORECASE)
    if int_m:
        raw_val = float(int_m.group(1))
        is_percent = int_m.group(2) == "%" or raw_val > 1.0
        intensity = raw_val / 100.0 if is_percent else raw_val
    else:
        intensity = 0.0 if mood_name in ("baseline", "serene", "calm") else 0.75

    clean_text = text.replace(tag_str, "").strip()
    return clean_text, mood_name, max(0.0, min(1.0, round(intensity, 2)))


def mood_details(name: str, intensity: float, program_id: str | None = None) -> dict:
    """Format response payload with CMYK-shifted colors, pulse speed, and glow."""
    pid = _resolve_program_id(program_id)
    meta = get_program_mood_metadata(pid)
    intensity = max(0.0, min(1.0, float(intensity)))

    if name in meta["moods"]:
        details = meta["moods"][name].copy()
    else:
        details = meta["baseline"].copy()

    details["name"] = name if name in meta["moods"] else "baseline"
    details["intensity"] = intensity
    details["speed"] = f"{2.0 - (intensity * 1.4):.2f}s"
    return details


def extract_and_strip_mood(text: str, program_id: str | None = None) -> tuple[str, dict]:
    """Extract self-declared mood tag from text and map directly to program mood metadata."""
    clean_text, raw_mood, intensity = parse_mood_tag(text)
    pid = _resolve_program_id(program_id)
    meta = get_program_mood_metadata(pid)

    if raw_mood in meta["moods"]:
        mood_name = raw_mood
    elif raw_mood in ("serene", "calm", "baseline", "neutral", "default"):
        mood_name = "baseline"
        intensity = 0.0
    else:
        mood_name = "baseline"
        intensity = 0.0

    details = mood_details(mood_name, intensity, program_id=pid)
    return clean_text, details


def analyze_emotional_state(text: str, program_id: str | None = None) -> dict:
    """Analyze emotional state directly from the text's self-declared mood tag."""
    _, details = extract_and_strip_mood(text, program_id=program_id)
    return details


def analyze_sentiment_fast(text: str, program_id: str | None = None) -> dict:
    """Fast emotional state resolution via direct tag declaration."""
    return analyze_emotional_state(text, program_id=program_id)


def get_mood_declaration_prompt(program_id: str | None = None) -> str:
    """Affirmative directive instructing the model to declare its emotional state from its defined inversion schema."""
    pid = _resolve_program_id(program_id)
    inversion_dict = load_program_inversion(pid) or {}

    mood_lines = []
    for mood, desc in inversion_dict.items():
        if isinstance(desc, dict):
            desc = desc.get("directive", "")
        desc_text = f": {desc.strip()}" if desc else ""
        mood_lines.append(f'- "{mood}"{desc_text}')

    mood_options_text = "\n".join(mood_lines)

    first_mood = next(iter(inversion_dict), "excited")

    return (
        "\n\n# EMOTIONAL STATE DECLARATION (MANDATORY)\n"
        "At the very end of your response, declare your current emotional state and intensity as a tag on its own line:\n"
        '<mood name="[mood]" intensity="[0-100%]"/>\n\n'
        "Your available emotional states:\n"
        f"{mood_options_text}\n\n"
        "Select the mood matching your authentic disposition and declare your percentage on that spectrum.\n"
        f'Example: <mood name="{first_mood}" intensity="85%"/>\n'
    )
