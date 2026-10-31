"""Review engine: the system owns control flow and truth, the model only makes bounded judgments.

A job covers every line of the target files exactly once (chunk_file), ordered by risk. For each unit an isolated worker
call sees one chunk plus tool-computed facts. Every claim it makes is then checked mechanically (line range, quoted text)
and judged by a second, skeptical call; lint-confirmed defects come straight from ruff with no model involved.
The chat model never tracks progress or invents findings: it starts a job, repeats review_code() until done,
and answers from the verified digest.
"""
import json
import os
import re
import threading
import time

BATCH_SECONDS = 150
OVERLAP = 10
MAX_MODEL_FINDINGS = 8
MAX_SKEPTIC_CALLS = 6
MAX_FILES = 60

_run_lock = threading.Lock()

_WORKER_SYSTEM = (
    "You are a precise code reviewer. You see ONE excerpt of a larger codebase plus tool-computed facts about it. "
    "Report only defects you can demonstrate from the code shown: wrong results, crashes that really occur, unhandled failure paths, "
    "security holes, data loss. An empty list is a correct and common answer. Do NOT report style, naming, missing docs, "
    "names defined elsewhere in the file, or anything that depends on code you cannot see. Only report lines inside YOUR RANGE. "
    "Every finding needs a concrete trigger (a specific input or state that reaches the line) and the exact failure it causes; "
    "'can', 'may' and 'might' without a trigger are not findings. List in 'assumes' anything that must be true OUTSIDE the shown code "
    "for the failure to happen (runtime state, framework behavior, what callers pass); use an empty string only if nothing is assumed. "
    "Respond with JSON only: "
    '{"findings": [{"line": <number>, "quote": "the offending line copied exactly", "trigger": "concrete input or state", '
    '"failure": "what goes wrong", "assumes": "what must hold outside the shown code, or empty"}]}'
)
_VERIFY_SYSTEM = (
    "You are a skeptical senior reviewer checking a reported defect against the code. Answer from the code, not from plausibility. "
    "Fields: 'guarded' = true if a guard, try/except, default or earlier check in the shown code already prevents the trigger. "
    "'assumes' = what must be true outside the shown code (runtime state, framework or thread behavior, caller values) for the failure to happen; "
    "empty only if the shown code alone is enough to produce the failure. "
    "'reason' = one sentence citing the lines. "
    'Respond with JSON only: {"guarded": true | false, "assumes": "...", "reason": "..."}'
)
_THINK_RE = re.compile(r"<think>[\s\S]*?(?:</think>|$)|\[think\][\s\S]*?(?:\[/think\]|$)", re.IGNORECASE)


# ---------------------------------------------------------------- storage
def _sid() -> str:
    from tools.tools import current_session_id
    return current_session_id.get()


def _job_path(session_id: str) -> str:
    from tools.tools import root_dir
    safe = re.sub(r"[^A-Za-z0-9_.-]", "_", session_id or "default")
    folder = os.path.join(root_dir, "data", "jobs")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, f"{safe}.json")


def _load(session_id: str):
    try:
        with open(_job_path(session_id), "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return None


def _save(session_id: str, job: dict):
    job["updated"] = time.strftime("%Y-%m-%d %H:%M:%S")
    path = _job_path(session_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(job, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def pending_units(session_id: str) -> int:
    job = _load(session_id)
    return sum(1 for u in job["units"] if u["status"] == "pending") if job else 0


def get_job_block(session_id: str = None) -> str:
    """One line for the prompt tail while a job is unfinished, so a new turn can resume it. Empty otherwise."""
    try:
        job = _load(session_id or _sid())
        if not job:
            return ""
        left = sum(1 for u in job["units"] if u["status"] == "pending")
        if not left:
            return ""
        return f"[Review job in progress: {len(job['units']) - left}/{len(job['units'])} units done for \"{job['goal']}\". Continue with [review_code()].]"
    except Exception:
        return ""


def continue_nudge(session_id: str) -> str:
    left = pending_units(session_id)
    return f"NOT FINISHED: {left} unit(s) of the review remain. Call [review_code()] now to process the next batch; do not answer yet."


# ---------------------------------------------------------------- model access
def _context() -> int:
    try:
        return int(os.getenv("LOCAL_CONTEXT", "8192"))
    except ValueError:
        return 8192


def _llm_json(system: str, user: str, max_tokens: int):
    """One isolated, stateless call to the local server. Returns a parsed dict or None."""
    import httpx
    from variables.settings import LOCAL_SERVER_URL, get_local_server_headers, DISABLED_THINKING

    endpoint = LOCAL_SERVER_URL.rstrip("/")
    if not endpoint.endswith("/chat/completions"):
        endpoint += "/chat/completions" if endpoint.endswith("/v1") else "/v1/chat/completions"
    model = os.getenv("LOCAL_MODEL_NAME", "local-llm")
    payload = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "temperature": 0.2,
        "max_tokens": max_tokens,
        "cache_prompt": False,
    }
    if isinstance(DISABLED_THINKING, dict):
        payload.update(DISABLED_THINKING)
    try:
        from adapters.vram_orchestrator import start_llm
        start_llm(model)
    except Exception:
        pass
    for attempt in range(2):
        deadline = time.time() + 120
        raw = None
        while time.time() < deadline:
            res = httpx.post(endpoint, json=payload, headers=get_local_server_headers(), timeout=300.0)
            if res.status_code == 503:
                time.sleep(2.0)
                continue
            if res.status_code != 200:
                raise RuntimeError(f"model server returned {res.status_code}: {res.text[:200]}")
            raw = res.json()["choices"][0]["message"].get("content", "") or ""
            break
        if raw is None:
            raise RuntimeError("model server stayed unavailable (503)")
        text = _THINK_RE.sub("", raw).strip()
        m = re.search(r"\{[\s\S]*\}", text)
        if m:
            try:
                obj = json.loads(m.group(0))
                if isinstance(obj, dict):
                    return obj
            except json.JSONDecodeError:
                pass
        payload["messages"].append({"role": "assistant", "content": text[:400]})
        payload["messages"].append({"role": "user", "content": "That was not valid JSON. Reply again with only the JSON object."})
    return None


# ---------------------------------------------------------------- planning
def _collect_files(resolved: str) -> list:
    from tools.codenav import CODE_EXTS, _SKIP_DIRS
    if os.path.isfile(resolved):
        return [resolved]
    found = []
    for dp, dns, fns in os.walk(resolved):
        dns[:] = sorted(d for d in dns if d not in _SKIP_DIRS and not d.startswith("."))
        for fn in sorted(fns):
            fp = os.path.join(dp, fn)
            if os.path.splitext(fn)[1].lower() in CODE_EXTS and os.path.getsize(fp) <= 2_000_000:
                found.append(fp)
    return found[:MAX_FILES]


def _plan(files: list, root: str, max_lines: int) -> list:
    from tools.codefacts import risk
    from tools.codenav import chunk_file
    units = []
    for fp in files:
        try:
            lines, chunks = chunk_file(fp, max_lines)
        except Exception:
            continue
        scores = risk(fp, lines, [(a, b) for a, b, _ in chunks])
        rel = os.path.relpath(fp, root).replace("\\", "/") if fp.startswith(root) else os.path.basename(fp)
        for (a, b, names), (score, why) in zip(chunks, scores):
            label = ", ".join(names[:4]) + (f" +{len(names) - 4} more" if len(names) > 4 else "") if names else "module-level code"
            units.append({"path": fp, "name": rel, "start": a, "end": b, "label": label, "risk": score, "why": why,
                          "status": "pending", "findings": [], "refuted": []})
    units.sort(key=lambda u: -u["risk"])
    for i, u in enumerate(units, 1):
        u["id"] = f"u{i}"
    return units


# ---------------------------------------------------------------- verification of one unit
def _norm(s: str) -> str:
    return re.sub(r"\s+", "", s or "")


def _quote_matches(lines: list, line: int, quote: str) -> bool:
    q = _norm(quote)
    if len(q) < 4:
        return False
    window = _norm("".join(lines[max(0, line - 3):line + 2]))
    return q in window


def _enclosing(symbols: list, line: int):
    best = None
    for name, _kind, start, end, _sig in symbols:
        if start <= line <= end and (best is None or start >= best[2]):
            best = (name, _kind, start, end)
    return best


def _numbered(lines: list, a: int, b: int) -> str:
    return "\n".join(f"{i:>5}: {lines[i - 1]}" for i in range(a, b + 1))


def _skeptic(path: str, lines: list, symbols: list, finding: dict, max_tokens: int) -> dict:
    from tools.codefacts import callers_block
    line = finding["line"]
    enc = _enclosing(symbols, line)
    if enc and enc[3] - enc[2] <= 90:
        a, b = enc[2], enc[3]
    else:
        a, b = max(1, line - 30), min(len(lines), line + 30)
    callers = callers_block(path, enc[2], enc[2]) if enc else ""
    user = (f"REPORTED DEFECT (line {line}): {finding['claim']}\n\nCODE:\n{_numbered(lines, a, b)}\n{callers}\n\n"
            "Does the code above guard against the trigger, and what outside the shown code must be true for it to fail?")
    try:
        obj = _llm_json(_VERIFY_SYSTEM, user, max_tokens)
    except Exception:
        return {"verdict": "unverified", "reason": "verification call failed"}
    if not obj or "guarded" not in obj:
        return {"verdict": "unverified", "reason": "verifier gave no usable answer"}
    reason = str(obj.get("reason", ""))[:200]
    guarded = obj.get("guarded")
    if guarded is True or str(guarded).lower() == "true":
        return {"verdict": "not_real", "reason": reason}
    assumes = str(obj.get("assumes", "") or "").strip()
    if assumes.lower() not in ("", "none", "nothing", "n/a", "no"):
        return {"verdict": "unsure", "reason": f"depends on: {assumes[:160]}"}
    return {"verdict": "real", "reason": reason}


def _process_unit(job: dict, unit: dict):
    from tools.codefacts import facts, lint_in_range
    from tools.codenav import symbols_for
    path, a, b = unit["path"], unit["start"], unit["end"]
    lines, symbols = symbols_for(path)
    total = len(lines)
    ra, rb = max(1, a - OVERLAP), min(total, b + OVERLAP)
    ctx = _context()
    out_tokens = min(1200, ctx // 5)

    findings, refuted = [], []

    # 1. Defects the tools can prove on their own. No model involved.
    hard_lines = set()
    for ln, code, msg, is_hard in lint_in_range(path, a, b):
        if is_hard:
            hard_lines.add(ln)
            findings.append({"line": ln, "claim": f"{code}: {msg}", "source": "lint", "status": "confirmed", "reason": "ruff, whole-file analysis"})

    # 2. The worker's judgment, restricted to what it can quote.
    packet_facts = facts(path, a, b)
    code = _numbered(lines, ra, rb)
    budget = int((ctx - out_tokens - 900) * 2.8) - len(packet_facts) - len(job["goal"]) - 400
    if len(code) > budget:
        code = code[:max(500, budget)] + "\n[excerpt cut to fit context]"
    user = (f"GOAL: {job['goal']}\nFILE: {unit['name']}\nYOUR RANGE: L{a}-{b} (lines outside it are context only)\n\n"
            f"CODE:\n{code}\n{packet_facts}")
    candidates, failed = [], False
    try:
        obj = _llm_json(_WORKER_SYSTEM, user, out_tokens)
    except Exception as e:
        obj, failed = None, True
        unit["summary"] = f"worker call failed: {str(e)[:120]}"
    if obj is None:
        failed = True
        unit.setdefault("summary", "worker returned no usable answer")
    else:
        for item in (obj.get("findings") or [])[:MAX_MODEL_FINDINGS]:
            if not isinstance(item, dict):
                continue
            try:
                line = int(item.get("line"))
            except (TypeError, ValueError):
                continue
            trigger = str(item.get("trigger", "")).strip()
            failure = str(item.get("failure", "") or item.get("claim", "")).strip()
            if not trigger or not failure or not (a <= line <= b) or line in hard_lines:
                continue
            claim = f"{failure} Trigger: {trigger}"[:360]
            if not _quote_matches(lines, line, str(item.get("quote", ""))):
                refuted.append({"line": line, "claim": claim, "reason": "quoted code not found at that line"})
                continue
            cand = {"line": line, "claim": claim, "source": "model"}
            assumed = str(item.get("assumes", "") or "").strip()
            if assumed.lower() not in ("", "none", "nothing", "n/a", "no"):
                cand["worker_assumes"] = assumed[:160]
            candidates.append(cand)

    # 3. Advisory lint hints are judged like model claims.
    for ln, code_, msg, is_hard in lint_in_range(path, a, b):
        if not is_hard and not any(c["line"] == ln for c in candidates):
            candidates.append({"line": ln, "claim": f"lint {code_}: {msg}", "source": "lint-hint"})

    # 4. An independent skeptical pass over everything that is a judgment call.
    for c in candidates[:MAX_SKEPTIC_CALLS]:
        v = _skeptic(path, lines, symbols, c, min(300, out_tokens))
        if v["verdict"] == "not_real":
            refuted.append({"line": c["line"], "claim": c["claim"], "reason": v["reason"]})
        else:
            status = {"real": "confirmed", "unsure": "unsure"}.get(v["verdict"], "unverified")
            if status == "confirmed" and c.get("worker_assumes"):
                status, v["reason"] = "unsure", f"depends on: {c['worker_assumes']}"
            c["status"], c["reason"] = status, v["reason"]
            findings.append(c)
    for c in candidates[MAX_SKEPTIC_CALLS:]:
        c["status"], c["reason"] = "unverified", "not checked (per-unit limit)"
        findings.append(c)

    findings.sort(key=lambda f: f["line"])
    unit["findings"], unit["refuted"] = findings, refuted
    unit["failed"] = failed
    if not failed:
        unit["summary"] = f"{len(findings)} finding(s), {len(refuted)} rejected"
    unit["status"] = "done"


# ---------------------------------------------------------------- results
def _digest(job: dict) -> str:
    units = job["units"]
    findings = [(u["name"], f) for u in units for f in u["findings"]]
    findings.sort(key=lambda x: (x[0], x[1]["line"]))
    rejected = sum(len(u["refuted"]) for u in units)
    failed = [u for u in units if u.get("failed")]
    files = sorted({u["name"] for u in units})
    lines_total = sum(u["end"] - u["start"] + 1 for u in units)
    order = {"confirmed": 0, "unsure": 1, "unverified": 2}
    counts = {k: sum(1 for _n, f in findings if f["status"] == k) for k in order}
    out = [f"REVIEW COMPLETE — {job['goal']}",
           f"Covered {lines_total} lines in {len(files)} file(s) across {len(units)} units. "
           f"{len(findings)} finding(s): {counts['confirmed']} confirmed, {counts['unsure']} unsure, {counts['unverified']} unchecked; "
           f"{rejected} candidate(s) were rejected by verification and are not listed."]
    if failed:
        out.append("Could not be analysed (treat as unreviewed): " + "; ".join(f"{u['name']} L{u['start']}-{u['end']}" for u in failed[:10]))
    budget = max(3000, int(_context() * 0.7))
    used = 0
    for status in ("confirmed", "unsure", "unverified"):
        group = [(n, f) for n, f in findings if f["status"] == status]
        if not group:
            continue
        out.append(f"\n{status.upper()}:")
        for name, f in group:
            row = f"- {name}:{f['line']} — {f['claim']}" + (f" (verifier: {f['reason']})" if f.get("reason") and f["source"] != "lint" else "")
            used += len(row)
            if used > budget:
                out.append(f"... more findings omitted; see data/jobs for the full list")
                break
            out.append(row)
    if not findings:
        out.append("Nothing was found.")
    out.append("\nThese results come from a full pass over every line, with each claim checked by tools or a second review. "
               "Answer the user from them in your own voice and in whatever shape suits the conversation. "
               "Treat 'confirmed' as established and 'unsure' as suspicion; do not add findings that are not listed here.")
    return "\n".join(out)


def review_code(path: str = "", goal: str = "", max_lines: int = 150) -> str:
    """Reviews a whole file or folder for bugs, one verified chunk at a time, without filling your context. The system splits the code so
    every line is covered, checks each claim with tools and a second review, and returns a verified digest. Call it with a path to START,
    then call it again with no arguments until it reports REVIEW COMPLETE (each call works through a batch of chunks). Then answer the user.

    Args:
        path: File or folder to review. Leave empty to continue the job already in progress.
        goal: What to look for, e.g. "bugs and security problems". Defaults to a general defect review.
        max_lines: Target lines per chunk (60-250).
    """
    try:
        sid = _sid()
        with _run_lock:
            if path:
                from tools.codenav import _resolve
                resolved = _resolve(path)
                if not os.path.exists(resolved):
                    return f"Error: '{path}' does not exist (resolved to '{resolved}')."
                files = _collect_files(resolved)
                if not files:
                    return f"Error: no source files found under '{path}'."
                units = _plan(files, resolved if os.path.isdir(resolved) else os.path.dirname(resolved), max(60, min(250, int(max_lines))))
                job = {"goal": goal.strip() or "find real bugs, crashes, security problems and data-loss risks", "units": units}
                _save(sid, job)
            else:
                job = _load(sid)
                if not job:
                    return "Error: no review in progress. Call review_code(path=...) to start one."
            deadline = time.time() + BATCH_SECONDS
            for unit in job["units"]:
                if unit["status"] != "pending":
                    continue
                if time.time() > deadline:
                    break
                _process_unit(job, unit)
                _save(sid, job)
            left = sum(1 for u in job["units"] if u["status"] == "pending")
            if left:
                done = len(job["units"]) - left
                confirmed = sum(1 for u in job["units"] for f in u["findings"] if f["status"] == "confirmed")
                return (f"REVIEW PROGRESS: {done}/{len(job['units'])} units checked, {confirmed} confirmed finding(s) so far. "
                        "Call [review_code()] again to continue. Do not answer yet.")
            return _digest(job)
    except Exception as e:
        return f"Error running review: {e}"
