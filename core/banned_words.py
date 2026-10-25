import sys
import os
import json
import re
import asyncio
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from variables.settings import BANNED_WORDS_FILE

DEFAULT_BIAS_WEIGHT = -100.0

# Pattern for negative-positive contrast cliches and false binaries
# (e.g., "it's not X; it's Y", "X isn't A—it's B", "not just X, but Y", "X, not Y", "stop X-ing and start Y-ing")
_PRONOUNS = r"(?:it|that|this|there|you|they|he|she|we|i)"
_NEG_VERBS = (
    r"(?:isn['\u2019]?t|aren['\u2019]?t|wasn['\u2019]?t|weren['\u2019]?t|is\s+not|are\s+not|was\s+not|were\s+not|ain['\u2019]?t|['\u2019]s\s+not|['\u2019]re\s+not|"
    r"didn['\u2019]?t|did\s+not|doesn['\u2019]?t|does\s+not|don['\u2019]?t|do\s+not|"
    r"hasn['\u2019]?t|has\s+not|haven['\u2019]?t|have\s+not|hadn['\u2019]?t|had\s+not|"
    r"won['\u2019]?t|will\s+not|wouldn['\u2019]?t|would\s+not|can['\u2019]?t|cannot|can\s+not|couldn['\u2019]?t|could\s+not|shouldn['\u2019]?t|should\s+not)"
)
_POS_TARGETS = (
    r"(?:it['\u2019]s|it\s+is|that['\u2019]s|that\s+is|this\s+is|you['\u2019]re|you\s+are|they['\u2019]re|they\s+are|he['\u2019]s|he\s+is|she['\u2019]s|she\s+is|we['\u2019]re|we\s+are|there['\u2019]s|there\s+is|what['\u2019]s|what\s+is|"
    r"it\s+was|that\s+was|this\s+was|there\s+was|they\s+were|we\s+were|he\s+was|she\s+was|you\s+were|"
    r"we['\u2019]ve|they['\u2019]ve|you['\u2019]ve|i['\u2019]ve|we\s+have|they\s+have|you\s+have|i\s+have|"
    r"but\s+also|but\s+rather|but\s+instead|but\s+it['\u2019]s|but\s+it\s+is|instead|rather)"
)
_DELIMITERS = r"(?:[;,:\u2013\u2014-]|--)"
_HARD_DELIMITERS = r"(?:[;:\u2013\u2014-]|--)"

ANTITHESIS_PATTERN = re.compile(
    rf"\b{_NEG_VERBS}\s+[^;:.!?]+(?:{_DELIMITERS}\s*\b(?:{_POS_TARGETS}|but\s+\w+)|{_HARD_DELIMITERS}\s*\b(?:{_PRONOUNS}\s+\w+|(?:the|a|an)\s+\w+\s+(?:is|are|was|were)\b))\b"
    rf"|\bnot\s+(?:a|an|the|just|only|merely|simply|as|for|about|by|in|to|from|with|because)\s+[^;:.!?]+{_DELIMITERS}\s*\b(?:{_POS_TARGETS}|but\b|{_PRONOUNS}\b)"
    rf"|[a-z0-9\"'\u201d\u2019]\s*{_DELIMITERS}\s*not\s+(?:a|an|the|just|only|merely|simply|some|your|their|our|his|her|its|by|for|from|in|on|about|around|through|with|because|out\s+of|\w+ing)\b"
    rf"|\bstop(?:s|ped|ping)?\s+[^;:.!?]+\band\s+start(?:s|ed|ing)?\s+\w+ing\b"
    rf"|\b(?:don['\u2019]?t|do\s+not|never)\s+(\w+)\s+[^;:.!?]+{_HARD_DELIMITERS}\s*(?:\1|instead|rather)\b"
    rf"|\bless\s+(?:about|of\s+a)\s+[^;:.!?]+\b(?:and\s+)?more\s+(?:about|of\s+a)\b",
    re.IGNORECASE
)

_cached_words_mtime: float = 0.0
_cached_words: list[str] = []
_cached_regex: Optional[re.Pattern] = None
_cached_token_ids: set[int] = set()

def load_banned_words() -> list[str]:
    """Loads and caches banned words from variables/banned_words.json."""
    global _cached_words_mtime, _cached_words, _cached_regex, _cached_token_ids
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

def _expand_root_stems(words: list[str]) -> list[str]:
    """Normalizes pluralized entries into root stems while preserving original words."""
    roots = []
    seen = set()
    for word in words:
        clean = word.strip().lower()
        if not clean:
            continue
        candidates = [clean]
        if len(clean) > 4 and clean.endswith(("sses", "shes", "ches", "xes", "zes")):
            candidates.append(clean[:-2])
        elif len(clean) > 4 and clean.endswith("ies"):
            candidates.append(f"{clean[:-3]}y")
        elif len(clean) > 3 and clean.endswith("s") and not clean.endswith(("ss", "us", "is")):
            candidates.append(clean[:-1])
        for c in candidates:
            if c not in seen:
                seen.add(c)
                roots.append(c)
    return roots

def get_banned_word_variants() -> set[str]:
    """Expands root banned words into cased and inflected variants."""
    words = _expand_root_stems(load_banned_words())
    variants = set()
    for clean in words:
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

    words = _expand_root_stems(load_banned_words())
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
        os.path.join(base_dir, "models", "llm", model_name),
        os.path.join(user_profile, ".lmstudio", "models", model_name),
        model_name,
    ]
    for p in candidates:
        if os.path.isfile(p):
            return os.path.normpath(p)
    return None

def resolve_tokens_from_gguf(gguf_path: str, variants: set[str]) -> set[int]:
    """Extracts exact single-token IDs (and unambiguous >=6-char stem tokens) from a GGUF model."""
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
    except ImportError:
        pass
    except Exception as e:
        print(f"[BANNED WORDS] llama_cpp vocab tokenization note: {e}", flush=True)

    # Priority 2: Standalone llama-tokenize binary (line-by-line verification)
    try:
        import subprocess
        base_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        tok_exe = os.path.join(base_dir, "utils", "llama-bin", "llama-tokenize.exe" if os.name == "nt" else "llama-tokenize")
        if os.path.isfile(tok_exe):
            sorted_variants = sorted(list(variants))
            payload = "\n" + "\n".join(sorted_variants) + "\n"
            flags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, "CREATE_NO_WINDOW") else 0x08000000
            out = subprocess.check_output(
                [tok_exe, "-m", gguf_path, "-p", payload, "--no-bos"],
                stderr=subprocess.DEVNULL,
                text=True,
                creationflags=flags if os.name == "nt" else 0
            )
            newline_tid = None
            tokens_by_line = []
            curr_tokens = []
            for line in out.splitlines():
                m = re.match(r"^\s*(\d+)\s*->\s*(.*)", line)
                if m:
                    tid = int(m.group(1))
                    tstr = m.group(2).strip("'")
                    if newline_tid is None:
                        newline_tid = tid
                        continue
                    if tid == newline_tid:
                        tokens_by_line.append(curr_tokens)
                        curr_tokens = []
                    else:
                        curr_tokens.append((tid, tstr))
            if curr_tokens:
                tokens_by_line.append(curr_tokens)

            resolved_ids = set()
            for toks in tokens_by_line:
                if len(toks) == 1:
                    resolved_ids.add(toks[0][0])
                elif len(toks) > 1 and len(toks[0][1].strip()) >= 6:
                    resolved_ids.add(toks[0][0])
            return resolved_ids
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

_SENTENCE_SPLIT_RE = re.compile(r'(\n+|(?<=[.!?])\s+|(?<=[.!?][*"\u201d\u2019)\]])\s+)')
_MOOD_TAG_RE = re.compile(r'(\s*(?:`?\s*<mood\b[^>]*?(?:/>|>.*?</mood>|>)\s*`?|`?\s*\[mood[:\s][^\]]*\]\s*`?)\s*)$', re.IGNORECASE | re.DOTALL)

async def _rewrite_single_sentence(sentence: str, llm_call_func, target_model: str, banned_regex) -> str:
    """Evaluates and rewrites individual sentences while retaining Markdown formatting."""
    stripped = sentence.strip()
    if not stripped or "```" in stripped or stripped.startswith(("![", "<mood", "[mood:")):
        return sentence

    found_banned = set(banned_regex.findall(sentence)) if banned_regex else set()
    has_antithesis = bool(ANTITHESIS_PATTERN.search(sentence))

    if not found_banned and not has_antithesis:
        return sentence

    instructions = []
    if found_banned:
        words_str = ", ".join(f'"{w}"' for w in sorted(found_banned))
        instructions.append(f"- Replace these words with direct synonyms: {words_str}.")

    if has_antithesis:
        instructions.append(
            "- State what is directly and affirmatively. Convert any binary contrast (such as 'not X, it is Y', 'X, not Y', or 'stop X and start Y') into a single clear, direct assertion."
        )

    rules_text = "\n".join(instructions)
    prompt = (
        "Rewrite this single sentence adhering strictly to these directives:\n\n"
        f"{rules_text}\n\n"
        "Preserve all Markdown syntax, including italics (*action*) and bold (**emphasis**). "
        "Output only the rewritten sentence.\n\n"
        f'Sentence: "{sentence}"'
    )

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
    """Splits text into sentences while preserving whitespace/paragraph structure and runs concurrent rewrites."""
    if not text or "```" in text:
        return text

    banned_regex = get_banned_words_regex()
    if not ANTITHESIS_PATTERN.search(text) and not (banned_regex and banned_regex.search(text)):
        return text

    mood_suffix = ""
    mood_match = _MOOD_TAG_RE.search(text)
    if mood_match:
        mood_suffix = mood_match.group(1)
        text = text[:mood_match.start()]

    parts = _SENTENCE_SPLIT_RE.split(text)

    sentence_indices = [i for i in range(0, len(parts), 2) if parts[i].strip()]
    if not sentence_indices:
        return text + mood_suffix

    rewritten_sentences = await asyncio.gather(
        *[_rewrite_single_sentence(parts[i], llm_call_func, target_model, banned_regex) for i in sentence_indices]
    )
    for idx, rewritten in zip(sentence_indices, rewritten_sentences):
        parts[idx] = rewritten

    return "".join(parts) + mood_suffix