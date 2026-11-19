"""Persistent call graph of the repo's Python code, built with ast and refreshed incrementally by file mtime."""
import ast
import json
import os
import threading

_lock = threading.Lock()
_SKIP = {".git", ".venv", "venv", "node_modules", "__pycache__", "comfy_engine", "models", "logs", "data", "certs", ".ruff_cache", "sessions", "lorebooks"}


def _root() -> str:
    from tools.tools import root_dir
    return root_dir


def _cache_path() -> str:
    folder = os.path.join(_root(), "data")
    os.makedirs(folder, exist_ok=True)
    return os.path.join(folder, "symbol_graph.json")


def _call_name(node: ast.Call):
    f = node.func
    if isinstance(f, ast.Name):
        return f.id
    if isinstance(f, ast.Attribute):
        return f.attr
    return None


def _index_file(abs_path: str, rel: str) -> dict:
    with open(abs_path, "r", encoding="utf-8", errors="replace") as fh:
        tree = ast.parse(fh.read())
    defs = {}

    def visit(body, prefix=""):
        for n in body:
            if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                qual = prefix + n.name
                calls = {}
                if isinstance(n, ast.ClassDef):
                    walk_nodes = [s for s in n.body if not isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef))]
                else:
                    walk_nodes = [n]
                for root_node in walk_nodes:
                    for sub in ast.walk(root_node):
                        if isinstance(sub, ast.Call):
                            c = _call_name(sub)
                            if c:
                                calls.setdefault(c, sub.lineno)
                defs[qual] = {"line": n.lineno, "end": getattr(n, "end_lineno", n.lineno), "calls": calls}
                if isinstance(n, ast.ClassDef):
                    visit(n.body, qual + ".")

    visit(tree.body)
    # Calls made at module level (e.g. init_runner() at import time) belong to a pseudo-symbol.
    top = {}
    for n in tree.body:
        if not isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            for sub in ast.walk(n):
                if isinstance(sub, ast.Call):
                    c = _call_name(sub)
                    if c:
                        top.setdefault(c, sub.lineno)
    if top:
        defs["<module>"] = {"line": 1, "end": 1, "calls": top}
    return defs


def _load_graph() -> dict:
    root = _root()
    path = _cache_path()
    graph = {"files": {}}
    try:
        with open(path, "r", encoding="utf-8") as f:
            graph = json.load(f)
    except Exception:
        pass
    files = graph.setdefault("files", {})
    seen = set()
    changed = False
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in _SKIP and not d.startswith(".")]
        for fn in fns:
            if not fn.endswith(".py"):
                continue
            abs_p = os.path.join(dp, fn)
            rel = os.path.relpath(abs_p, root).replace("\\", "/")
            seen.add(rel)
            try:
                mt = os.path.getmtime(abs_p)
            except OSError:
                continue
            if rel in files and files[rel].get("mtime") == mt:
                continue
            try:
                files[rel] = {"mtime": mt, "defs": _index_file(abs_p, rel)}
            except Exception:
                files[rel] = {"mtime": mt, "defs": {}}
            changed = True
    for rel in [r for r in files if r not in seen]:
        del files[rel]
        changed = True
    if changed:
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(graph, f)
        os.replace(tmp, path)
    return graph


def callers_in_range(abs_path: str, start: int, end: int, max_funcs: int = 6) -> str:
    """Compact 'who calls the functions defined in this line range' facts, so cross-chunk claims need no guessing."""
    try:
        if not abs_path.lower().endswith(".py"):
            return ""
        with _lock:
            graph = _load_graph()
        root = _root()
        rel = os.path.relpath(abs_path, root).replace("\\", "/")
        defs = graph["files"].get(rel, {}).get("defs", {})
        inside = [(q, d) for q, d in defs.items() if q != "<module>" and start <= d["line"] <= end]
        if not inside:
            return ""
        callers_of = {}
        for frel, info in graph["files"].items():
            for qual, d in info["defs"].items():
                for c, ln in d["calls"].items():
                    callers_of.setdefault(c, []).append((frel, qual, ln))
        rows = []
        for qual, d in inside:
            short = qual.split(".")[-1]
            cs = [(f, q, ln) for f, q, ln in callers_of.get(short, []) if not (f == rel and q == qual)]
            rows.append((len(cs), qual, cs))
        rows.sort(key=lambda r: -r[0])
        lines = []
        for n, qual, cs in rows[:max_funcs]:
            if cs:
                shown = ", ".join(f"{q} ({f.split('/')[-1]}:{ln})" for f, q, ln in cs[:3]) + (f" +{n - 3} more" if n > 3 else "")
                lines.append(f"{qual} <- called by {shown}")
            else:
                lines.append(f"{qual} <- no direct callers (route/decorator/dynamic use is possible)")
        return "\n[call graph: callers of functions defined in this range]\n" + "\n".join(lines)
    except Exception:
        return ""


def symbol_graph(symbol: str, max_results: int = 25) -> str:
    """Looks up a Python function/class in the repo's call graph: where it is defined, WHO CALLS IT (file:function:line), and what it calls.
    Cheaper and more precise than searching text. Use it to check a caller contract, find the blast radius of a change, or confirm a function is used at all.

    Args:
        symbol: Function, method or class name, e.g. "init_runner" or "OsHistoryAdapter.get_openai_messages" (a bare method name also matches).
        max_results: Cap on callers/callees listed.
    """
    try:
        name = (symbol or "").strip()
        if not name:
            return "Error: provide a symbol name."
        short = name.split(".")[-1]
        with _lock:
            graph = _load_graph()
        defined, callers = [], []
        callees = {}
        for rel, info in graph["files"].items():
            for qual, d in info["defs"].items():
                if qual == name or ("." not in name and qual.split(".")[-1] == short):
                    defined.append(f"{rel}:{d['line']}-{d['end']} {qual}")
                    for c, ln in d["calls"].items():
                        callees.setdefault(c, f"{rel}:{ln}")
                if short in d["calls"]:
                    callers.append(f"{rel}:{d['calls'][short]} in {qual}")
        if not defined and not callers:
            return f"'{name}' is not defined or called anywhere in the indexed Python files (it may be a library call or in a non-Python file)."
        known = {q.split(".")[-1] for info in graph["files"].values() for q in info["defs"]}
        local_callees = [f"{c} ({loc})" for c, loc in callees.items() if c in known and c != short]
        out = [f"{name}:"]
        out.append("DEFINED: " + ("; ".join(defined[:5]) if defined else "not in repo (external)"))
        out.append(f"CALLED BY ({len(callers)}): " + ("; ".join(callers[:max_results]) if callers else "nobody — unused or only referenced dynamically (routes/decorators/getattr)"))
        if len(callers) > max_results:
            out.append(f"(+{len(callers) - max_results} more callers)")
        if local_callees:
            out.append(f"CALLS (repo functions, {len(local_callees)}): " + "; ".join(local_callees[:max_results]))
        return "\n".join(out)
    except Exception as e:
        return f"Error querying symbol graph: {e}"
