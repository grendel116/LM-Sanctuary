import sys
import os
import json
import re
import asyncio
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables.settings import BANNED_WORDS_FILE

DEFAULT_BIAS_WEIGHT = -100.0

# Pattern for negative-positive contrast cliches (e.g., "it's not X; it's Y", "it isn't X; it's Y", "wasn't just a...; it was a...", "not just X, but Y")
_PRONOUNS = r"(?:it|that|this|there|you|they|he|she|we|i)"
_NEG_VERBS = (
    r"(?:isn'?t|aren'?t|wasn'?t|weren'?t|is\s+not|are\s+not|was\s+not|were\s+not|ain'?t|'s\s+not|'re\s+not|"
    r"didn'?t|did\s+not|doesn'?t|does\s+not|don'?t|do\s+not|"
    r"hasn'?t|has\s+not|haven'?t|have\s+not|hadn'?t|had\s+not|"
    r"won'?t|will\s+not|wouldn'?t|would\s+not|can'?t|cannot|can\s+not|couldn'?t|could\s+not|shouldn'?t|should\s+not)"
)
_POS_TARGETS = (
    r"(?:it'?s|it\s+is|that'?s|that\s+is|this\s+is|you'?re|you\s+are|they'?re|they\s+are|he'?s|he\s+is|she'?s|she\s+is|we'?re|we\s+are|there'?s|there\s+is|what'?s|what\s+is|"
    r"it\s+was|that\s+was|this\s+was|there\s+was|they\s+were|we\s+were|he\s+was|she\s+was|you\s+were|"
    r"we'?ve|they'?ve|you'?ve|i'?ve|we\s+have|they\s+have|you\s+have|i\s+have|"
    r"but\s+also|but\s+rather|but\s+instead|but\s+it'?s|but\s+it\s+is|instead|rather)"
)
_DELIMITERS = r"(?:[;,:\u2013\u2014-]|--)"

ANTITHESIS_PATTERN = re.compile(
    rf"\b(?:{_PRONOUNS}\s+)?{_NEG_VERBS}\s+[^;:.!?]+(?:{_DELIMITERS}\s*(?:{_POS_TARGETS}|{_PRONOUNS}(?:\s+\w+)?)|{_DELIMITERS}?\s*(?:{_POS_TARGETS}))\b"
    rf"|\bnot\s+(?:a|an|just|only|merely|simply)\s+[^;:.!?]+{_DELIMITERS}?\s*(?:{_POS_TARGETS}|but\s+\w+|{_PRONOUNS})\b",
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
            _cached_token_ids = set()
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
        forms = {clean}
        if clean.endswith(("s", "sh", "ch", "x", "z")):
            forms.add(f"{clean}es")
        elif clean.endswith("y") and len(clean) > 1 and clean[-2] not in "aeiou":
            forms.add(f"{clean[:-1]}ies")
        else:
            forms.add(f"{clean}s")

        if clean.endswith("e"):
            forms.add(f"{clean}d")
            if not clean.endswith(("ee", "oe", "ye")):
                forms.add(f"{clean[:-1]}ing")
            else:
                forms.add(f"{clean}ing")
            forms.add(f"{clean}r")
            forms.add(f"{clean}st")
        elif clean.endswith("y") and len(clean) > 1 and clean[-2] not in "aeiou":
            forms.add(f"{clean[:-1]}ied")
            forms.add(f"{clean}ing")
        else:
            forms.add(f"{clean}ed")
            forms.add(f"{clean}ing")
            forms.add(f"{clean}er")
            forms.add(f"{clean}est")

        if not clean.endswith("ly"):
            forms.add(f"{clean}ly")

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
    pattern = r"\b(?:" + "|".join(escaped) + r")(?:s|es|ed|ing|ly|er|est)?\b"
    _cached_regex = re.compile(pattern, re.IGNORECASE)
    return _cached_regex

def _get_token_cache_path() -> str:
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_dir, "variables", ".banned_tokens_cache.json")

def _load_token_cache(model_key: str = None) -> set[int]:
    cache_path = _get_token_cache_path()
    if os.path.exists(cache_path) and os.path.exists(BANNED_WORDS_FILE):
        try:
            if os.path.getmtime(cache_path) >= os.path.getmtime(BANNED_WORDS_FILE):
                with open(cache_path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    cached_model = data.get("model")
                    if model_key and cached_model and cached_model != model_key:
                        return set()
                    return set(data.get("token_ids", []))
        except Exception:
            pass
    return set()

def _save_token_cache(token_ids: set[int], model_key: str = None):
    cache_path = _get_token_cache_path()
    try:
        data = {"token_ids": sorted(list(token_ids))}
        if model_key:
            data["model"] = model_key
        with open(cache_path, "w", encoding="utf-8") as f:
            json.dump(data, f)
    except Exception:
        pass

def _find_default_gguf_path() -> Optional[str]:
    model_name = os.getenv("LOCAL_MODEL_NAME", "")
    if not model_name:
        return None
    base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    user_profile = os.environ.get("USERPROFILE") or os.path.expanduser("~")
    candidates = [
        os.path.join(base_dir, "models", model_name),
        os.path.join(user_profile, ".lmstudio", "models", model_name),
        model_name,
    ]
    for p in candidates:
        if os.path.isfile(p):
            return os.path.normpath(p)
    return None

def resolve_tokens_from_gguf(gguf_path: str, variants: set[str]) -> set[int]:
    """Extracts exact single-token IDs from a GGUF model for the given word variants."""
    if not gguf_path or not os.path.isfile(gguf_path) or not variants:
        return set()

    # Priority 1: In-process via llama_cpp (fast, vocab_only=True without VRAM allocation)
    try:
        import llama_cpp
        params = llama_cpp.llama_model_default_params()
        params.vocab_only = True
        model = llama_cpp.llama_model_load_from_file(gguf_path.encode("utf-8"), params)
        if model:
            try:
                vocab = llama_cpp.llama_model_get_vocab(model)
                single_ids = set()
                for v in variants:
                    vb = v.encode("utf-8")
                    n_max = len(vb) + 2
                    tokens = (llama_cpp.llama_token * n_max)()
                    n = llama_cpp.llama_tokenize(vocab, vb, len(vb), tokens, n_max, False, False)
                    if n == 1:
                        single_ids.add(int(tokens[0]))
                return single_ids
            finally:
                llama_cpp.llama_model_free(model)
    except Exception as e:
        print(f"[BANNED WORDS] llama_cpp vocab tokenization note: {e}", flush=True)

    # Priority 2: Standalone llama-tokenize binary (line-by-line single-token verification)
    try:
        import subprocess
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        tok_exe = os.path.join(base_dir, "utils", "llama-bin", "llama-tokenize.exe" if os.name == "nt" else "llama-tokenize")
        if os.path.isfile(tok_exe):
            sorted_variants = sorted(list(variants))
            payload = "\n".join(sorted_variants) + "\n"
            flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000
            out = subprocess.check_output(
                [tok_exe, "-m", gguf_path, "-p", payload, "--no-bos"],
                stderr=subprocess.DEVNULL,
                text=True,
                creationflags=flags if os.name == "nt" else 0
            )
            tokens_by_line = []
            curr_tokens = []
            for line in out.splitlines():
                m = re.match(r"^\s*(\d+)\s*->", line)
                if m:
                    tid = int(m.group(1))
                    if tid == 107:
                        tokens_by_line.append(curr_tokens)
                        curr_tokens = []
                    else:
                        curr_tokens.append(tid)
            if curr_tokens:
                tokens_by_line.append(curr_tokens)

            return {toks[0] for toks in tokens_by_line if len(toks) == 1}
    except Exception as e:
        print(f"[BANNED WORDS] llama-tokenize CLI fallback note: {e}", flush=True)

    return set()

def resolve_tokens_from_server(server_url: str, variants: set[str]) -> set[int]:
    """Resolves single-token IDs via running llama-server /tokenize endpoint."""
    if not server_url or not variants:
        return set()
    base_url = server_url.split("/v1/")[0].rstrip("/")
    tokenize_url = f"{base_url}/tokenize"
    import requests
    single_ids = set()
    for v in variants:
        try:
            resp = requests.post(tokenize_url, json={"content": v}, timeout=0.5)
            if resp.status_code == 200:
                toks = resp.json().get("tokens", [])
                if len(toks) == 1:
                    single_ids.add(int(toks[0]))
        except Exception:
            break
    return single_ids

def resolve_token_ids(server_url: str = None, gguf_path: str = None) -> set[int]:
    """Resolves single-token IDs for banned words."""
    global _cached_token_ids
    if _cached_token_ids:
        return _cached_token_ids

    if not gguf_path:
        gguf_path = _find_default_gguf_path()

    model_key = os.path.basename(gguf_path) if gguf_path else None
    cached_disk = _load_token_cache(model_key)
    if cached_disk:
        _cached_token_ids = cached_disk
        return _cached_token_ids

    variants = get_banned_word_variants()
    if not variants:
        return set()

    resolved = set()
    if gguf_path and os.path.isfile(gguf_path):
        resolved = resolve_tokens_from_gguf(gguf_path, variants)

    if not resolved and server_url:
        resolved = resolve_tokens_from_server(server_url, variants)

    if resolved:
        _cached_token_ids = resolved
        _save_token_cache(resolved, model_key)

    return _cached_token_ids

def get_logit_bias_dict(server_url: str = None, bias_weight: float = DEFAULT_BIAS_WEIGHT, gguf_path: str = None) -> dict[str, float]:
    """Returns logit_bias dictionary {token_id_str: bias_weight} for OpenAI API requests."""
    token_ids = resolve_token_ids(server_url=server_url, gguf_path=gguf_path)
    if not token_ids:
        return {}
    return {str(t_id): float(bias_weight) for t_id in token_ids}

def generate_llama_cli_args(gguf_path: str = None, bias_weight: float = None) -> list[str]:
    """Generates CLI flags for llama-server logit bias at startup."""
    if bias_weight is None:
        bias_weight = DEFAULT_BIAS_WEIGHT

    token_ids = resolve_token_ids(gguf_path=gguf_path)
    if not token_ids:
        return []

    sign_str = "" if bias_weight < 0 else "+"
    bias_str = ",".join(f"{t_id}{sign_str}{bias_weight}" for t_id in sorted(token_ids))
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
        instructions.append("- Convert contrast structures (such as 'not X, it is Y' or 'didn't just X; they Y') into direct, positive assertions.")

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