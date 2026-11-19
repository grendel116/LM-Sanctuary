"""Ground truth about code, computed by tools rather than guessed by the model.

Three pure sources of fact: lint results for a whole file, the repo call graph, and a risk score
used to decide which code deserves attention first.
"""
import os
import re
import subprocess
import sys

# Hard rules are defects by construction: syntax errors, undefined names, redefinitions, invalid comparisons.
HARD_RULES = "E9,F63,F7,F82,F811"
# Advisory rules flag suspicious shapes that still need judgment (missing return, bare except, mutable defaults).
ADVISORY_RULES = "RET503,E722,B006,B008"

_lint_cache: dict = {}


def lint(path: str) -> list:
    """[(line, code, message, is_hard)] for the WHOLE file, so module-level names count as defined. Cached by mtime."""
    if not path.lower().endswith(".py"):
        return []
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    cached = _lint_cache.get(path)
    if cached and cached[0] == mtime:
        return cached[1]
    hits = []
    try:
        r = subprocess.run(
            [sys.executable, "-m", "ruff", "check", "--select", f"{HARD_RULES},{ADVISORY_RULES}", "--no-fix",
             "--output-format", "concise", "--isolated", path],
            capture_output=True, text=True, timeout=30,
        )
        hard_prefixes = tuple(HARD_RULES.split(","))
        for ln in r.stdout.splitlines():
            m = re.match(r".*?:(\d+):\d+: (\S+) (.*)", ln)
            if m:
                hits.append((int(m.group(1)), m.group(2), m.group(3)[:110], m.group(2).startswith(hard_prefixes)))
    except Exception:
        return []
    _lint_cache[path] = (mtime, hits)
    return hits


def lint_in_range(path: str, start: int, end: int) -> list:
    return [h for h in lint(path) if start <= h[0] <= end]


def callers_block(path: str, start: int, end: int, max_funcs: int = 6) -> str:
    """Who calls the functions defined in this line range (from the repo call graph)."""
    try:
        from tools.symbolgraph import callers_in_range
        return callers_in_range(path, start, end, max_funcs)
    except Exception:
        return ""


def facts(path: str, start: int, end: int) -> str:
    """The ground-truth block attached to every chunk the model (or a worker) reads."""
    if not path.lower().endswith(".py"):
        return ""
    out = []
    hits = lint_in_range(path, start, end)
    if hits:
        out.append(f"[lint L{start}-{end}, ruff on the whole file]")
        out += [f"L{ln} {code}: {msg}" for ln, code, msg, _hard in hits[:8]]
    else:
        out.append(f"[lint L{start}-{end}: ruff found no undefined names, syntax errors or suspicious shapes here. "
                   "Names used but not defined in this range ARE defined elsewhere in the file; do not call them bugs.]")
    callers = callers_block(path, start, end)
    if callers:
        out.append(callers.strip())
    return "\n" + "\n".join(out)


_RISK_PATTERNS = [
    (re.compile(r"\bexcept\s*:|\bexcept Exception:\s*pass"), 2, "swallowed errors"),
    (re.compile(r"\bglobal\s+\w+"), 2, "mutable globals"),
    (re.compile(r"\bos\.path\.join\(|\bopen\(|send_file|send_from_directory"), 1, "file paths"),
    (re.compile(r"subprocess|os\.system|eval\(|exec\(|shell=True"), 3, "shell/exec"),
    (re.compile(r"\bthreading\.|\bLock\(|asyncio\.(?:create_task|gather)"), 2, "concurrency"),
    (re.compile(r"request\.(?:json|args|form|files)"), 1, "request input"),
]


def risk(path: str, lines: list, ranges: list) -> list:
    """[(score, reasons)] per (start, end) range. Higher scores are examined first."""
    hits = lint(path)
    out = []
    for a, b in ranges:
        score, reasons = 0, []
        n_lint = sum(1 for h in hits if a <= h[0] <= b)
        if n_lint:
            score += 4 * n_lint
            reasons.append(f"{n_lint} lint hit{'s' if n_lint > 1 else ''}")
        chunk = "\n".join(lines[a - 1:b])
        for rx, weight, label in _RISK_PATTERNS:
            n = len(rx.findall(chunk))
            if n:
                score += weight * min(n, 4)
                reasons.append(label)
        branches = len(re.findall(r"^\s*(?:if|elif|for|while|try|except)\b", chunk, re.M))
        score += branches // 8
        if branches >= 25:
            reasons.append("complex")
        out.append((score, ", ".join(reasons[:3])))
    return out
