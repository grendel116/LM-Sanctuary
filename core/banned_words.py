import sys
import os
import json
import re
import asyncio
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables.settings import BANNED_WORDS_FILE

DEFAULT_BIAS_WEIGHT = -100.0

# Strict pattern for 'not X, [it's] Y' or 'not A; B' contrast structures
ANTITHESIS_PATTERN = re.compile(
    r"\b(?:it's|that's|this\s+is)\s+not\s+[^;,.!?]+[;,]?\s*(?:it's|it\s+is|you're|there's)\b"
    r"|\bnot\s+a\s+[^;,.!?]+[;,]\s*(?:it's|it\s+is|this\s+is)\b",
    re.IGNORECASE
)

_cached_words_mtime: float = 0.0
_cached_words: list[str] = []
_cached_regex: Optional[re.Pattern] = None
_cached_token_ids: set[int] = set()

def load_banned_words() -> list[str]:
    """Loads and caches banned words from variables/banned_words.json."""
    global _cached_words_mtime, _cached_words, _cached_regex
    if not os.path.exists(BANNED_WORDS_FILE):
        return []
    try:
        mtime = os.path.getmtime(BANNED_WORDS_FILE)
        if mtime != _cached_words_mtime or not _cached_words:
            with open(BANNED_WORDS_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                banned = data.get("banned_words", [])
                if isinstance(banned, dict):
                    _cached_words = [str(w).strip().lower() for w in banned.keys() if str(w).strip()]
                else:
                    _cached_words = [str(w).strip().lower() for w in banned if str(w).strip()]
            _cached_words_mtime = mtime
            _cached_regex = None
        return _cached_words
    except Exception as e:
        print(f"[BANNED WORDS] Error loading {BANNED_WORDS_FILE}: {e}", flush=True)
        return _cached_words or []

def get_banned_word_variants() -> set[str]:
    """Expands root banned words into cased and inflected variants."""
    words = load_banned_words()
    variants = set()
    for word in words:
        clean = word.strip().lower()
        if not clean:
            continue
        forms = {
            clean,
            f"{clean}s",
            f"{clean}es",
            f"{clean}ed",
            f"{clean}ing",
            f"{clean}ly",
            f"{clean}er",
            f"{clean}est",
            f"{clean}y",
        }
        for form in forms:
            variants.update([
                form,
                f" {form}",
                form.capitalize(),
                f" {form.capitalize()}",
                form.upper(),
                f" {form.upper()}",
            ])
    return variants

def get_banned_words_regex() -> Optional[re.Pattern]:
    """Builds pre-compiled regular expression for banned words and variants."""
    global _cached_regex
    if _cached_regex is not None:
        return _cached_regex

    words = load_banned_words()
    if not words:
        return None

    # Build pattern covering base words and common suffixes
    escaped = [re.escape(w) for w in words]
    pattern = r"\b(?:" + "|".join(escaped) + r")(?:s|es|ed|ing|ly|er|est|y)?\b"
    _cached_regex = re.compile(pattern, re.IGNORECASE)
    return _cached_regex

def _get_token_cache_path() -> str:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "variables", ".banned_tokens_cache.json")

def _load_token_cache() -> set[int]:
    cache_path = _get_token_cache_path()
    if os.path.exists(cache_path):
        try:
            with open(cache_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                return set(data.get("token_ids", []))
        except Exception:
            pass
    return set()

def _save_token_cache(token_ids: set[int]):
    cache_path = _get_token_cache_path()
    try:
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump({"token_ids": sorted(list(token_ids))}, f)
    except Exception:
        pass

def resolve_token_ids(server_url: str = None) -> set[int]:
    """Resolves single-token IDs for banned words via the server /tokenize endpoint."""
    global _cached_token_ids
    if _cached_token_ids:
        return _cached_token_ids

    # Try loading disk cache first
    cached_disk = _load_token_cache()
    if cached_disk:
        _cached_token_ids = cached_disk

    if not server_url:
        server_url = os.environ.get("LOCAL_SERVER_URL", "http://127.0.0.1:1234/v1/chat/completions")

    # Determine base server URL (e.g. http://127.0.0.1:1234)
    base_url = server_url.split("/v1/")[0].rstrip("/")
    tokenize_url = f"{base_url}/tokenize"

    variants = get_banned_word_variants()
    if not variants:
        return _cached_token_ids

    import requests
    resolved = set(_cached_token_ids)
    try:
        for v in variants:
            try:
                resp = requests.post(tokenize_url, json={"content": v}, timeout=1.0)
                if resp.status_code == 200:
                    toks = resp.json().get("tokens", [])
                    if len(toks) == 1:
                        resolved.add(int(toks[0]))
            except Exception:
                break

        if resolved:
            _cached_token_ids = resolved
            _save_token_cache(resolved)
    except Exception as e:
        print(f"[BANNED WORDS] Warning during token resolution: {e}", flush=True)

    return _cached_token_ids

def get_logit_bias_dict(server_url: str = None, bias_weight: float = DEFAULT_BIAS_WEIGHT) -> dict[str, float]:
    """Returns logit_bias dictionary {token_id_str: bias_weight} for OpenAI API requests."""
    token_ids = resolve_token_ids(server_url)
    if not token_ids:
        return {}
    return {str(t_id): float(bias_weight) for t_id in token_ids}

def generate_llama_cli_args(gguf_path: str = None, bias_weight: float = None) -> list[str]:
    """Generates CLI flags for llama-server logit bias at startup."""
    if bias_weight is None:
        bias_weight = DEFAULT_BIAS_WEIGHT

    token_ids = _load_token_cache()

    # If cache is empty and gguf_path is provided, try llama-tokenize.exe
    if not token_ids and gguf_path and os.path.isfile(gguf_path):
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        tok_exe = os.path.join(base_dir, "utils", "llama-bin", "llama-tokenize.exe" if os.name == 'nt' else "llama-tokenize")
        if os.path.isfile(tok_exe):
            try:
                import subprocess
                variants = get_banned_word_variants()
                # Run batch tokenization in chunks
                chunk = " ".join(variants)
                out = subprocess.check_output(
                    [tok_exe, "-m", gguf_path, "-p", chunk, "--ids", "--no-bos"],
                    stderr=subprocess.DEVNULL,
                    text=True
                ).strip()
                parsed = json.loads(out)
                if isinstance(parsed, list):
                    token_ids = set(parsed)
                    _save_token_cache(token_ids)
            except Exception as e:
                print(f"[BANNED WORDS] Tokenization via binary skipped: {e}", flush=True)

    if not token_ids:
        return []

    sign_str = "" if bias_weight < 0 else "+"
    bias_str = ",".join(f"{t_id}{sign_str}{bias_weight}" for t_id in token_ids)
    return ["--logit-bias", bias_str]

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
            temperature=0.4,
            max_tokens=max_tokens
        )
        if rewritten and len(rewritten.strip()) > 0:
            return rewritten.strip().strip('"')
    except Exception as e:
        print(f"[REWRITE ERROR] {e}", flush=True)

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