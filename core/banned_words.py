import sys
import os
import json
import re
import asyncio
from functools import lru_cache

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables.settings import BANNED_WORDS_FILE

DEFAULT_BIAS_WEIGHT = -10.0

ANTITHESIS_PATTERN = re.compile(
    r"\b(?:it's|that's|this\s+is|this\s+isn't|it\s+isn't)\s+(?:just\s+)?not\b"
    r"|\b(?:is|are|was|were)n't\s+(?:just\s+)?[^;,.!?]+[;,]?\s*(?:it's|it\s+is|this\s+is)\b"
    r"|\bnot\s+a\s+[^;,.!?]+[;,]\s*(?:it's|it\s+is|this\s+is)\b",
    re.IGNORECASE
)

@lru_cache(maxsize=1)
def load_banned_words() -> list[str]:
    """Loads and caches banned words from file."""
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

@lru_cache(maxsize=1)
def get_banned_words_regex() -> re.Pattern | None:
    """Builds pre-compiled regular expression for banned words."""
    words = load_banned_words()
    if not words:
        return None
    pattern = r"\b(?:" + "|".join(map(re.escape, words)) + r")\b"
    return re.compile(pattern, re.IGNORECASE)

def generate_llama_cli_args(gguf_path: str, bias_weight: float = None) -> list[str]:
    """Generates CLI flags for llama-server logit bias."""
    if bias_weight is None:
        bias_weight = DEFAULT_BIAS_WEIGHT
        
    words = load_banned_words()
    if not words or not os.path.isfile(gguf_path):
        return []

    token_ids = set()
    try:
        from llama_cpp import Llama
        llm = Llama(model_path=gguf_path, vocab_only=True, verbose=False)
        for word in words:
            clean_word = word.strip()
            if not clean_word:
                continue
            variants = [clean_word, f" {clean_word}", clean_word.capitalize(), f" {clean_word.capitalize()}"]
            for variant in variants:
                ids = llm.tokenize(variant.encode("utf-8"), add_special=False)
                for t_id in ids:
                    token_ids.add(int(t_id))
        del llm
    except Exception as e:
        print(f"[BANNED WORDS] Notice: Tokenization skipped ({e}).", flush=True)
        return []

    cli_args = []
    for token_id in token_ids:
        sign_str = "" if bias_weight < 0 else "+"
        cli_args.extend(["--logit-bias", f"{token_id}{sign_str}{bias_weight}"])
    return cli_args

import re

# Strict pattern for 'not X, [it's] Y' or 'not A; B' contrast structures
ANTITHESIS_PATTERN = re.compile(
    r"\b(?:it's|that's|this\s+is)\s+not\s+[^;,.!?]+[;,]?\s*(?:it's|it\s+is|you're|there's)\b"
    r"|\bnot\s+a\s+[^;,.!?]+[;,]\s*(?:it's|it\s+is|this\s+is)\b",
    re.IGNORECASE
)

async def _rewrite_single_sentence(sentence: str, llm_call_func, target_model: str, banned_regex) -> str:
    """Evaluates and rewrites individual sentences while retaining Markdown formatting."""
    found_banned = set(banned_regex.findall(sentence)) if banned_regex else set()
    has_antithesis = bool(ANTITHESIS_PATTERN.search(sentence))

    if not found_banned and not has_antithesis:
        return sentence

    instructions = []
    if found_banned:
        words_str = ", ".join(f'"{w}"' for w in found_banned)
        instructions.append(f"- Replace these forbidden words: {words_str}.")
    
    if has_antithesis:
        instructions.append("- Convert 'not X, it is Y' contrast structures into direct, positive assertions.")

    rules_text = "\n".join(instructions)
    prompt = f"""[INST] Rewrite this single sentence adhering strictly to these rules:

{rules_text}

CRITICAL: Preserve ALL Markdown syntax, including asterisks for actions (*action*) and emphasis (**bold**). Output ONLY the direct rewritten sentence.

Sentence: "{sentence}" [/INST]"""

    try:
        max_tokens = max(64, int(len(sentence.split()) * 2))
        rewritten = await llm_call_func(
            prompt=prompt,
            model=target_model,
            temperature=0.0,
            max_tokens=max_tokens
        )
        if rewritten and len(rewritten.strip()) > 0:
            return rewritten.strip().strip('"')
    except Exception as e:
        print(f"[REWRITE ERROR] {e}")

    return sentence

async def replace_banned_words_async(text: str, llm_call_func, target_model: str) -> str:
    """Splits text into sentences and runs concurrent rewrites."""
    if not text:
        return text

    banned_regex = get_banned_words_regex()
    sentence_ending = re.compile(r'(?<=[.!?])\s+')
    sentences = sentence_ending.split(text)

    tasks = [
        _rewrite_single_sentence(s, llm_call_func, target_model, banned_regex)
        for s in sentences
    ]
    
    rewritten_sentences = await asyncio.gather(*tasks)
    return " ".join(rewritten_sentences)