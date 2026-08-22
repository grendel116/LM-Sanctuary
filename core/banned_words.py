import sys
import os
import json

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables import BANNED_WORDS_FILE

# Set your preferred default logit bias penalty here (-2.0 allows literal use, suppresses tropes)
DEFAULT_BIAS_WEIGHT = -2.0

def load_banned_words() -> list[str]:
    """Loads the list of banned words from banned_words.json."""
    if not os.path.exists(BANNED_WORDS_FILE):
        return []
    try:
        with open(BANNED_WORDS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            banned = data.get("banned_words", [])
            if isinstance(banned, dict):
                return list(banned.keys())
            return list(banned)
    except Exception as e:
        print(f"[BANNED WORDS] Error loading {BANNED_WORDS_FILE}: {e}")
        return []

def generate_llama_cli_args(gguf_path: str, bias_weight: float = None) -> list[str]:
    """
    Generates CLI argument list for llama-server. 
    Uses llama_cpp python bindings to tokenize accurately if available.
    """
    if bias_weight is None:
        bias_weight = DEFAULT_BIAS_WEIGHT
        
    words = load_banned_words()
    if not words or not os.path.isfile(gguf_path):
        return []

    token_ids = set()
    
    try:
        # Try using llama_cpp library to tokenize the banned words directly from the model file
        from llama_cpp import Llama
        # Initialize a lightweight read just for tokenization mapping
        # (vocab_only=True avoids loading weights into VRAM)
        llm = Llama(model_path=gguf_path, vocab_only=True, verbose=False)
        
        for word in words:
            clean_word = word.strip()
            if not clean_word:
                continue
            # Tokenize variants (with/without leading spaces and capitalization)
            variants = [clean_word, f" {clean_word}", clean_word.capitalize(), f" {clean_word.capitalize()}"]
            for variant in variants:
                ids = llm.tokenize(variant.encode("utf-8"), add_special=False)
                for t_id in ids:
                    token_ids.add(int(t_id))
        
        # Clean up instance to free memory immediately
        del llm
        
    except (ImportError, Exception) as e:
        print(f"[BANNED WORDS] Notice: Could not tokenize via llama_cpp ({e}). Skipping dynamic logit bias.", flush=True)
        return []

    cli_args = []
    for token_id in token_ids:
        cli_args.extend(["--logit-bias", f"{token_id}{bias_weight}"])
        
    return cli_args