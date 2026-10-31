"""Structure-aware reading and post-edit verification primitives.

The model reads one symbol or one line range at a time (outline_file / read_symbol / read_file) and every read of
Python code carries machine-computed facts (see codefacts). Whole-file reviews run through codejob instead.
"""
import ast
import json
import os
import re

MAX_OUTLINE_ENTRIES = 400

_GENERIC_DEF_RE = re.compile(
    r"^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*"
    r"(?:(?P<kind>class|interface|struct|enum|function|func|fn|def)\s+(?P<name>[A-Za-z_$][\w$]*)"
    r"|(?:const|let|var)\s+(?P<arrow>[A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)"
)


def _max_symbol_lines() -> int:
    try:
        ctx = int(os.getenv("LOCAL_CONTEXT", "8192"))
    except ValueError:
        ctx = 8192
    return max(80, min(400, ctx // 60))


def _resolve(path: str) -> str:
    from tools.tools import resolve_workspace_path
    return resolve_workspace_path(path)


def read_lines(path: str):
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        return f.read().splitlines()


def _python_symbols(source: str):
    """Returns [(qualified_name, kind, start, end, signature)] with 1-indexed inclusive lines."""
    tree = ast.parse(source)
    lines = source.splitlines()
    out = []

    def visit(node, prefix):
        for child in getattr(node, "body", []):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kind = "class" if isinstance(child, ast.ClassDef) else "def"
                start = min([child.lineno] + [d.lineno for d in child.decorator_list])
                name = f"{prefix}{child.name}"
                out.append((name, kind, start, child.end_lineno, lines[child.lineno - 1].strip()))
                if kind == "class":
                    visit(child, name + ".")

    visit(tree, "")
    return out


def _generic_symbols(lines):
    """Brace/indent-agnostic fallback: each definition runs until the next definition at the same or lower indent."""
    defs = []
    for i, line in enumerate(lines, 1):
        m = _GENERIC_DEF_RE.match(line)
        if m:
            name = m.group("name") or m.group("arrow")
            kind = m.group("kind") or "function"
            defs.append([name, kind, i, len(line) - len(line.lstrip()), line.strip()])
    out = []
    for idx, (name, kind, start, indent, sig) in enumerate(defs):
        end = len(lines)
        for nxt in defs[idx + 1:]:
            if nxt[3] <= indent:
                end = nxt[2] - 1
                break
        while end > start and not lines[end - 1].strip():
            end -= 1
        out.append((name, kind, start, end, sig))
    return out


def symbols_for(path: str):
    lines = read_lines(path)
    if path.lower().endswith(".py"):
        try:
            return lines, _python_symbols("\n".join(lines))
        except SyntaxError:
            pass
    return lines, _generic_symbols(lines)


def chunk_file(path: str, max_lines: int = 150):
    """Splits a file into contiguous line ranges that together cover EVERY line exactly once.
    Small functions are grouped, big ones isolated. Returns (lines, [(start, end, [symbol names])])."""
    lines, symbols = symbols_for(path)
    leaves = sorted((s for s in symbols if not any(o[0].startswith(s[0] + ".") for o in symbols)), key=lambda s: s[2])
    chunks, cur_start, cur_names = [], 1, []
    for name, _kind, start, end, _sig in leaves:
        if cur_names and (end - cur_start + 1) > max_lines and start > cur_start:
            chunks.append((cur_start, start - 1, cur_names))
            cur_start, cur_names = start, []
        cur_names.append(name)
    chunks.append((cur_start, max(len(lines), cur_start), cur_names))
    return lines, chunks


def outline_file(path: str) -> str:
    """Lists classes/functions in a code file with line spans, so a large file can be read one symbol at a time.

    Args:
        path: The code file path (absolute or relative to workspace folders).
    """
    try:
        resolved = _resolve(path)
        if not os.path.isfile(resolved):
            return f"Error: '{path}' is not a file (resolved to '{resolved}')."
        lines, symbols = symbols_for(resolved)
        header = f"{resolved} — {len(lines)} lines, {len(symbols)} symbols"
        if not symbols:
            return header + "\nNo symbols detected. Use read_file(path, start_line, end_line) in chunks of ~150 lines."
        rows = [f"{name} {start}-{end}" for name, _kind, start, end, _sig in symbols[:MAX_OUTLINE_ENTRIES]]
        if len(symbols) > MAX_OUTLINE_ENTRIES:
            rows.append(f"... {len(symbols) - MAX_OUTLINE_ENTRIES} more symbols not shown")
        tail = '\nRead one with: [read_symbol(path="...", symbol="Name")]'
        if len(lines) > 400:
            tail += (
                f'\nThis file is too large to audit by hand within your context. To review all of it, call '
                f'[review_code(path="{path}", goal="...")] (then [review_code()] until REVIEW COMPLETE); '
                "it covers every line and checks each claim for you. Use read_symbol only for targeted questions."
            )
        return header + " (name startline-endline)\n" + "\n".join(rows) + tail
    except Exception as e:
        return f"Error outlining '{path}': {e}"


def read_symbol(path: str, symbol: str, include_imports: bool = True) -> str:
    """Reads exactly one function or class (e.g. "MyClass.method") with line numbers, plus the file's import block.

    Args:
        path: The code file path.
        symbol: Symbol name; use Class.method for methods. A unique partial name also works.
        include_imports: Prepend the file's leading import lines for context.
    """
    try:
        from tools.codefacts import facts
        resolved = _resolve(path)
        if not os.path.isfile(resolved):
            return f"Error: '{path}' is not a file (resolved to '{resolved}')."
        lines, symbols = symbols_for(resolved)
        wanted = (symbol or "").strip()
        exact = [s for s in symbols if s[0] == wanted]
        matches = exact or [s for s in symbols if s[0].endswith("." + wanted) or s[0].lower() == wanted.lower()]
        if len(matches) > 1:
            names = ", ".join(f"{m[0]} (L{m[2]})" for m in matches[:10])
            return f"Error: '{symbol}' is ambiguous. Candidates: {names}"
        if not matches:
            return f"Error: symbol '{symbol}' not found in '{path}'. Run outline_file first."
        name, kind, start, end, _ = matches[0]
        shown_end = min(end, start + _max_symbol_lines() - 1)
        parts = []
        if include_imports:
            imports = []
            for i, line in enumerate(lines[: max(start - 1, 0)], 1):
                if re.match(r"\s*(import |from \S+ import |const .*require\(|#include|using |use )", line):
                    imports.append(f"{i:>5}: {line}")
                if len(imports) >= 40:
                    break
            if imports:
                parts.append("# imports\n" + "\n".join(imports))
        body = "\n".join(f"{i:>5}: {lines[i - 1]}" for i in range(start, shown_end + 1))
        parts.append(f"# {kind} {name}  L{start}-{end}\n{body}" + facts(resolved, start, shown_end))
        if shown_end < end:
            parts.append(f"[Truncated at {_max_symbol_lines()} lines; continue with read_file(path, start_line={shown_end + 1}, end_line={end})]")
        return "\n\n".join(parts)
    except Exception as e:
        return f"Error reading symbol '{symbol}' in '{path}': {e}"


_SKIP_DIRS = {".git", ".venv", "venv", "node_modules", "__pycache__", "comfy_engine", "models", "logs", "data", "certs", ".ruff_cache", "sessions", "lorebooks"}
CODE_EXTS = {".py", ".js", ".ts", ".tsx", ".jsx", ".html", ".css", ".ps1", ".bat"}


def find_references(symbol: str, path: str = "", max_results: int = 30) -> str:
    """Answers 'where is this name defined, set and used?' for the whole repo. For Python functions/classes it leads with the call
    graph (definition, callers, callees); then lists every textual mention as file:line. Use it to VERIFY a suspicion that depends on
    code outside your current chunk (uninitialized global, missing import, who calls this).

    Args:
        symbol: Identifier to look for, e.g. "runner" or "init_runner" or "Class.method".
        path: Optional folder or file to limit the textual search (defaults to the workspace root).
        max_results: Cap on textual hits returned.
    """
    try:
        from tools.tools import root_dir
        from tools.symbolgraph import symbol_graph
        name = (symbol or "").strip()
        if not re.fullmatch(r"[A-Za-z_$][\w$.]*", name):
            return "Error: symbol must be a plain identifier."
        graph = symbol_graph(name)
        graph = "" if graph.startswith(("Error", "'")) else graph + "\n\n"
        short = name.split(".")[-1]
        base = _resolve(path) if path else root_dir
        pat = re.compile(r"(?<![\w$])" + re.escape(short) + r"(?![\w$])")
        files = [base] if os.path.isfile(base) else []
        if not files:
            for dp, dns, fns in os.walk(base):
                dns[:] = [d for d in dns if d not in _SKIP_DIRS]
                files += [os.path.join(dp, f) for f in fns if os.path.splitext(f)[1].lower() in CODE_EXTS]
        hits, total = [], 0
        for fp in files:
            try:
                if os.path.getsize(fp) > 2_000_000:
                    continue
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    for i, line in enumerate(f, 1):
                        if pat.search(line):
                            total += 1
                            if len(hits) < max_results:
                                s = line.strip()
                                kind = "DEF" if re.match(r"(async\s+)?(def|class|function)\s", s) else \
                                       "ASSIGN" if re.match(re.escape(short) + r"\s*(:[^=]+)?=[^=]", s) else \
                                       "IMPORT" if re.match(r"(from|import)\s", s) else "use"
                                hits.append(f"{os.path.relpath(fp, root_dir)}:{i} [{kind}] {s[:110]}")
            except OSError:
                continue
        if not hits:
            return graph + f"No textual references to '{short}' found. It may be undefined, dynamically created, or outside the searched folders."
        extra = f"\n... {total - len(hits)} more not shown; narrow with path=" if total > len(hits) else ""
        return graph + f"{total} textual reference(s) to '{short}':\n" + "\n".join(hits) + extra
    except Exception as e:
        return f"Error searching references: {e}"


def verify_file(path: str) -> str:
    """Fast post-edit check. Returns '' when the file type has no checker, else a one-line OK or a list of problems."""
    import subprocess
    import sys
    try:
        from tools.codefacts import HARD_RULES
        resolved = _resolve(path)
        ext = os.path.splitext(resolved)[1].lower()
        if ext == ".py":
            with open(resolved, "r", encoding="utf-8", errors="replace") as f:
                src = f.read()
            try:
                ast.parse(src)
            except SyntaxError as e:
                return f"[verify] SYNTAX ERROR line {e.lineno}: {e.msg}. Fix it before continuing."
            try:
                r = subprocess.run(
                    [sys.executable, "-m", "ruff", "check", "--select", HARD_RULES, "--no-fix",
                     "--output-format", "concise", "--isolated", resolved],
                    capture_output=True, text=True, timeout=20,
                )
                issues = [ln for ln in r.stdout.splitlines() if ln.strip() and not ln.startswith(("All checks", "Found "))]
                if r.returncode == 1 and issues:
                    return f"[verify] {len(issues)} problem(s) after edit:\n" + "\n".join(issues[:8])
            except (FileNotFoundError, subprocess.TimeoutExpired):
                pass
            return "[verify] syntax OK, no undefined names."
        if ext == ".json":
            with open(resolved, "r", encoding="utf-8") as f:
                json.load(f)
            return "[verify] valid JSON."
        if ext in (".js", ".mjs", ".cjs"):
            r = subprocess.run(["node", "--check", resolved], capture_output=True, text=True, timeout=20)
            if r.returncode != 0:
                return f"[verify] SYNTAX ERROR:\n{r.stderr.strip()[:600]}"
            return "[verify] syntax OK."
        return ""
    except json.JSONDecodeError as e:
        return f"[verify] INVALID JSON line {e.lineno}: {e.msg}. Fix it before continuing."
    except Exception:
        return ""


def with_verify(message: str, path: str) -> str:
    """Appends verify_file output to a successful edit message."""
    note = verify_file(path)
    return f"{message}\n{note}" if note else message
