"""
Utility module for extracting the companion's self-declared mood state from generated text,
and mapping it strictly to dynamic heart indicator styles (glow, color, speed) in the UI.
"""
import re

def extract_and_strip_mood(text: str) -> tuple[str, dict]:
    """Parses the self-declared `<mood name="..." intensity="..."/>` tag from the end of the text.
    
    Returns:
        A tuple of (cleaned_text, mood_details_dict).
    """
    if not text:
        return "", {
            "name": "calm",
            "color": "#85b9eb",
            "glow": "rgba(133, 185, 235, 0.9)",
            "speed": "3.5s",
            "intensity": 0.0
        }

    # Match <mood name="..." intensity="..."/> at the end of the text
    # (Allow optional trailing whitespace)
    pattern = r'<mood\s+name="([^"]+)"\s+intensity="([^"]+)"\s*/>\s*$'
    match = re.search(pattern, text)
    
    if not match:
        # Fallback to defaults
        return text, {
            "name": "calm",
            "color": "#85b9eb",
            "glow": "rgba(133, 185, 235, 0.9)",
            "speed": "3.5s",
            "intensity": 0.0
        }
    
    mood_name = match.group(1).lower().strip()
    try:
        intensity = float(match.group(2))
    except ValueError:
        intensity = 0.5
        
    # Clamp intensity
    intensity = max(0.0, min(1.0, intensity))
    
    # Strip the tag from the text
    clean_text = text.replace(match.group(0), "").strip()
    
    # Map strictly to heart pulse colors and glows
    mood_details = {
        "intimate": {"color": "#ff4a75", "glow": "rgba(255, 74, 117, 0.9)"},
        "excited": {"color": "#ff1493", "glow": "rgba(255, 20, 147, 0.9)"},
        "calm": {"color": "#85b9eb", "glow": "rgba(133, 185, 235, 0.9)"},
        "intense": {"color": "#ff7b00", "glow": "rgba(255, 123, 0, 0.9)"},
        "sad": {"color": "#5f7d95", "glow": "rgba(95, 125, 149, 0.9)"}
    }
    
    details = mood_details.get(mood_name, mood_details["calm"]).copy()
    details["name"] = mood_name
    details["intensity"] = intensity
    
    # Calculate heart pulse speed based on intensity (from 3.5s slow down to 0.6s fast)
    speed_seconds = 3.5 - (intensity * 2.9)
    details["speed"] = f"{speed_seconds:.2f}s"
    
    return clean_text, details

def analyze_emotional_state(text: str) -> dict:
    """Legacy wrapper for extract_and_strip_mood returning only the mood dictionary."""
    _, mood = extract_and_strip_mood(text)
    return mood
