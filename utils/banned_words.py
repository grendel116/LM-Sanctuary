import sys
import os
import json
import re

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables import BANNED_WORDS_FILE

def load_banned_words() -> dict:
    """Loads the dictionary of banned words and their replacements."""
    if not os.path.exists(BANNED_WORDS_FILE):
        print(f"[BANNED WORDS] Warning: {BANNED_WORDS_FILE} not found. Returning empty dictionary.")
        return {}
    try:
        with open(BANNED_WORDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data.get("banned_words", {})
    except Exception as e:
        print(f"[BANNED WORDS] Error loading {BANNED_WORDS_FILE}: {e}")
        return {}


def match_case(word: str, replacement: str) -> str:
    """Helper to match the casing of the original word to the replacement."""
    if word.isupper():
        return replacement.upper()
    if word.istitle():
        return replacement.capitalize()
    return replacement.lower()

def sanitize_text(text: str) -> str:
    """Scans and replaces banned words in text while preserving casing."""
    if not text:
        return text
        
    banned_map = load_banned_words()
    
    # Sort keys by length descending to replace plurals/longer words first
    sorted_words = sorted(banned_map.keys(), key=len, reverse=True)
    
    for word in sorted_words:
        replacement = banned_map[word]
        # Match word boundaries to prevent replacing parts of larger words (e.g., 'ghostly' should still match 'ghost' if desired, but boundary check prevents unintended matches)
        pattern = re.compile(rf'\b{re.escape(word)}\b', re.IGNORECASE)
        
        def replace_match(match):
            original = match.group(0)
            return match_case(original, replacement)
            
        text = pattern.sub(replace_match, text)
        
    return text
