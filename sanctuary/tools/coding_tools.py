"""In-process workspace coding primitives and OpenAI tool schemas (zero regex)."""

from __future__ import annotations

import os
import subprocess
import sys
import time
from typing import Any

_SKIP_DIRS = frozenset({
    ".git",
    "node_modules",
    "__pycache__",
    ".venv",
    "venv",
    ".pytest_cache",
    ".ruff_cache",
    "gecko_profile",
    "webview_data",
})

_GREP_SKIP_DIRS = _SKIP_DIRS | frozenset({
    "comfy_engine",
    "models",
    "portraits",
    "uploads",
    "logs",
    "dist",
    "build",
    "coverage",
})

_GREP_SKIP_FILES = frozenset({
    "vocab.json",
    "tokenizer.json",
    "merges.txt",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
})

_GIT_GREP_EXCLUDES = (
    ":!sanctuary/core/comfy_engine/**",
    ":!**/vocab.json",
    ":!**/tokenizer.json",
    ":!**/merges.txt",
    ":!**/package-lock.json",
    ":!**/*.min.js",
    ":!**/*.min.css",
)

_MAX_READ_LINES = 400
_MAX_READ_CHARS = 24000
_MAX_CMD_OUTPUT_CHARS = 12000
_MAX_GREP_MATCHES = 60
_CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000) if sys.platform == "win32" else 0


def _allowed_roots() -> tuple[str, list[str]]:
    import tools.tools as tools_mod

    repo_root, _, _ = tools_mod.resolve_coding_workspace("")
    repo_root = os.path.normpath(os.path.abspath(repo_root))
    roots = [repo_root]
    for folder in tools_mod.get_project_folders():
        if isinstance(folder, str) and folder.strip():
            norm = os.path.normpath(os.path.abspath(folder))
            if norm not in roots:
                roots.append(norm)
    return repo_root, roots


def _is_within_root(candidate: str, root: str) -> bool:
    cand_nc = os.path.normcase(os.path.abspath(candidate))
    root_nc = os.path.normcase(os.path.abspath(root))
    return cand_nc == root_nc or cand_nc.startswith(root_nc + os.sep)


def _format_rel_path(abs_path: str, repo_root: str) -> str:
    if _is_within_root(abs_path, repo_root):
        rel = os.path.relpath(abs_path, repo_root).replace("\\", "/")
        return "." if rel == "." else rel
    return abs_path.replace("\\", "/")


def _missing_target_hint(abs_path: str, raw_path: str, repo_root: str) -> str:
    parent = os.path.dirname(abs_path)
    sample_dir = parent if os.path.isdir(parent) else repo_root
    try:
        entries = sorted(
            e for e in os.listdir(sample_dir)
            if e not in _SKIP_DIRS and not e.startswith(".git")
        )[:20]
    except OSError:
        entries = []
    rel_sample = _format_rel_path(sample_dir, repo_root)
    hint = ", ".join(entries) if entries else "(empty)"
    return f"Error: Path does not exist: '{raw_path}'. Entries in {rel_sample}: {hint}"


def _resolve_workspace_target(raw_path: str, must_exist: bool = True) -> tuple[str, str, str]:
    """Resolve a path relative to the active coding workspace, rejecting escapes."""
    repo_root, roots = _allowed_roots()
    cleaned = (raw_path or "").strip()
    if not cleaned or cleaned == ".":
        return repo_root, ".", ""

    norm_in = os.path.normpath(cleaned)
    if os.path.isabs(norm_in):
        abs_path = os.path.abspath(norm_in)
    else:
        abs_path = os.path.abspath(os.path.join(repo_root, norm_in))

    if not any(_is_within_root(abs_path, r) for r in roots):
        return "", "", f"Error: Path escapes workspace root: '{raw_path}'."

    rel_display = _format_rel_path(abs_path, repo_root)
    if must_exist and not os.path.exists(abs_path):
        return "", "", _missing_target_hint(abs_path, raw_path, repo_root)
    return abs_path, rel_display, ""


def _read_only_band_notice() -> str | None:
    import tools.tools as tools_mod

    if getattr(tools_mod, "current_plan_mode", None) and tools_mod.current_plan_mode.get():
        return "[Plan Mode Read-Only Band]: File writes and shell commands are disabled during `/plan`. Inspect files read-only first."
    if getattr(tools_mod, "current_write_disengaged", None) and tools_mod.current_write_disengaged.get():
        return "[Read-Only Band Active]: File edits and commands are disabled in this step. Inspect files read-only first."
    return None


def list_dir(path: str = "") -> str:
    """List sorted subdirectories and files in a workspace directory."""
    abs_path, rel_display, err = _resolve_workspace_target(path, must_exist=True)
    if err:
        return err
    if not os.path.isdir(abs_path):
        return f"Error: '{rel_display}' is a file, not a directory. Use read_file instead."

    try:
        names = os.listdir(abs_path)
    except OSError as exc:
        return f"Error: Unable to list directory '{rel_display}': {exc}"

    dirs: list[str] = []
    files: list[str] = []
    for name in sorted(names, key=str.lower):
        if name in _SKIP_DIRS:
            continue
        full = os.path.join(abs_path, name)
        if os.path.isdir(full):
            dirs.append(f"{name}/")
        else:
            try:
                size_kb = os.path.getsize(full) / 1024.0
                files.append(f"{name} ({size_kb:.1f} KB)")
            except OSError:
                files.append(name)

    combined = dirs + files
    total = len(combined)
    shown = combined[:200]
    header = f"[Directory: {rel_display} ({len(dirs)} dirs, {len(files)} files)]"
    if not shown:
        return f"{header}\n(empty)"
    trunc = f"\n... [{total - 200} more entries omitted]" if total > 200 else ""
    return f"{header}\n" + "\n".join(shown) + trunc


def read_file(path: str, start_line: int = 1, end_line: int = 250) -> str:
    """Read a bounded line range from a UTF-8 text file in the workspace."""
    if not str(path or "").strip():
        return "Error: path is required for read_file."
    abs_path, rel_display, err = _resolve_workspace_target(path, must_exist=True)
    if err:
        return err
    if os.path.isdir(abs_path):
        return f"Error: '{rel_display}' is a directory. Use list_dir(path=\"{rel_display}\") instead."

    try:
        with open(abs_path, "rb") as f:
            raw = f.read()
    except OSError as exc:
        return f"Error: Unable to read '{rel_display}': {exc}"

    if b"\x00" in raw[:4096]:
        return f"Error: '{rel_display}' appears to be a binary file ({len(raw)} bytes)."

    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    total_lines = len(lines)
    if total_lines == 0:
        return f"[File: {rel_display} (0 lines, empty)]"

    try:
        s_line = max(1, int(start_line or 1))
    except (TypeError, ValueError):
        s_line = 1
    try:
        e_line = int(end_line) if end_line else (s_line + 249)
    except (TypeError, ValueError):
        e_line = s_line + 249

    if e_line < s_line:
        e_line = s_line
    e_line = min(total_lines, e_line, s_line + _MAX_READ_LINES - 1)
    if s_line > total_lines:
        return f"Error: start_line {s_line} exceeds total lines ({total_lines}) in {rel_display}."

    out_lines: list[str] = []
    char_count = 0
    actual_end = s_line - 1
    for line_no in range(s_line, e_line + 1):
        formatted = f"{line_no}: {lines[line_no - 1]}"
        if out_lines and (char_count + len(formatted) + 1) > _MAX_READ_CHARS:
            break
        out_lines.append(formatted)
        char_count += len(formatted) + 1
        actual_end = line_no

    header = f"[File: {rel_display} (lines {s_line}-{actual_end} of {total_lines})]"
    return header + "\n" + "\n".join(out_lines)


def grep_search(query: str, path: str = "", case_sensitive: bool = False) -> str:
    """Perform fixed-string literal search across the workspace (zero regex)."""
    clean_q = str(query or "")
    if not clean_q:
        return "Error: query is required for grep_search."

    repo_root, _ = _allowed_roots()
    scope_abs = repo_root
    scope_rel = ""
    if str(path or "").strip():
        scope_abs, scope_rel, err = _resolve_workspace_target(path, must_exist=True)
        if err:
            return err

    matches: list[str] = []
    seen_lines: set[str] = set()

    if os.path.exists(os.path.join(repo_root, ".git")) and _is_within_root(scope_abs, repo_root):
        cmd = ["git", "grep", "-n", "-I", "-F"]
        if not case_sensitive:
            cmd.append("-i")
        cmd.extend(["-e", clean_q, "--"])
        cmd.append(scope_rel if (scope_rel and scope_rel != ".") else ".")
        cmd.extend(_GIT_GREP_EXCLUDES)
        try:
            proc = subprocess.run(
                cmd,
                cwd=repo_root,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                creationflags=_CREATE_NO_WINDOW,
            )
            if proc.returncode == 0 and proc.stdout:
                for line in proc.stdout.splitlines():
                    if not line:
                        continue
                    seen_lines.add(line)
                    matches.append(line[:400])
                    if len(matches) >= _MAX_GREP_MATCHES:
                        break
        except Exception:
            pass

    if len(matches) < _MAX_GREP_MATCHES:
        needle = clean_q if case_sensitive else clean_q.lower()
        target_files: list[str] = []
        if os.path.isfile(scope_abs):
            target_files = [scope_abs]
        else:
            for root_dir, dirs, filenames in os.walk(scope_abs):
                dirs[:] = sorted(d for d in dirs if d not in _GREP_SKIP_DIRS)
                for fname in sorted(filenames):
                    if fname in _GREP_SKIP_FILES or fname.endswith((".min.js", ".min.css")):
                        continue
                    target_files.append(os.path.join(root_dir, fname))

        for fpath in target_files:
            if len(matches) >= _MAX_GREP_MATCHES:
                break
            try:
                if os.path.getsize(fpath) > 1_048_576:
                    continue
                with open(fpath, "rb") as f:
                    raw = f.read()
                if b"\x00" in raw[:4096]:
                    continue
                text = raw.decode("utf-8", errors="replace")
            except OSError:
                continue
            rel = _format_rel_path(fpath, repo_root)
            for idx, line in enumerate(text.splitlines(), start=1):
                hay = line if case_sensitive else line.lower()
                if needle in hay:
                    entry = f"{rel}:{idx}: {line.strip()}"
                    if entry not in seen_lines:
                        seen_lines.add(entry)
                        matches.append(entry[:400])
                        if len(matches) >= _MAX_GREP_MATCHES:
                            break

    if not matches:
        return f"No matches found for '{clean_q}'."
    suffix = f"\n... [showing first {_MAX_GREP_MATCHES} matches]" if len(matches) >= _MAX_GREP_MATCHES else ""
    return f"[grep_search: '{clean_q}' ({len(matches)} matches)]\n" + "\n".join(matches) + suffix


def edit_file(path: str = "", target: str = "", replacement: str | None = None) -> str:
    """Replace one exact text block in a workspace file, preserving line endings."""
    band_notice = _read_only_band_notice()
    if band_notice:
        return band_notice

    if not str(path or "").strip():
        return "Error: path is required for edit_file."
    if target is None or target == "":
        return "Error: target must not be empty. Use write_file to create or overwrite an entire file."
    if replacement is None:
        return "Error: 'replacement' argument is required for edit_file (pass replacement=\"\" explicitly to delete lines)."

    abs_path, rel_display, err = _resolve_workspace_target(path, must_exist=True)
    if err:
        return err
    if os.path.isdir(abs_path):
        return f"Error: '{rel_display}' is a directory."

    import tools.tools as tools_mod

    if not tools_mod.confirm_tool_execution("edit_file", f"Edit {rel_display}"):
        return "Action cancelled by user."

    try:
        with open(abs_path, "rb") as f:
            raw = f.read()
    except OSError as exc:
        return f"Error: Unable to read '{rel_display}': {exc}"

    newline = "\r\n" if b"\r\n" in raw else "\n"
    norm_text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n")
    norm_target = str(target).replace("\r\n", "\n")
    norm_repl = str(replacement or "").replace("\r\n", "\n")

    count = norm_text.count(norm_target)
    if count == 0:
        return f"Error: Target block not found in {rel_display}. Call read_file first to copy exact lines and indentation."
    if count > 1:
        occ_lines: list[str] = []
        pos = 0
        while len(occ_lines) < 10:
            idx = norm_text.find(norm_target, pos)
            if idx == -1:
                break
            line_num = norm_text.count("\n", 0, idx) + 1
            occ_lines.append(f"L{line_num}")
            pos = idx + max(1, len(norm_target))
        return (
            f"Error: Target block matched {count} locations in {rel_display} "
            f"(lines {', '.join(occ_lines)}). Include 2-3 surrounding lines in target to make it unique."
        )

    match_idx = norm_text.find(norm_target)
    start_line = norm_text.count("\n", 0, match_idx) + 1
    new_norm = norm_text.replace(norm_target, norm_repl, 1)
    out_bytes = new_norm.replace("\n", newline).encode("utf-8")

    try:
        with open(abs_path, "wb") as f:
            f.write(out_bytes)
    except OSError as exc:
        return f"Error: Unable to write '{rel_display}': {exc}"

    removed = len(norm_target.splitlines()) or 1
    added = len(norm_repl.splitlines()) if norm_repl else 0
    new_lines = new_norm.splitlines()
    p_start = max(1, start_line - 1)
    p_end = min(len(new_lines), start_line + max(1, added) + 1)
    preview = "\n".join(f"{ln}: {new_lines[ln - 1]}" for ln in range(p_start, p_end + 1))
    return f"Edited {rel_display} (+{added} -{removed} lines at L{start_line}).\n{preview}"


def write_file(path: str, content: str, overwrite: bool = True) -> str:
    """Create or overwrite a UTF-8 file inside the workspace."""
    band_notice = _read_only_band_notice()
    if band_notice:
        return band_notice

    if not str(path or "").strip():
        return "Error: path is required for write_file."

    abs_path, rel_display, err = _resolve_workspace_target(path, must_exist=False)
    if err:
        return err
    if os.path.isdir(abs_path):
        return f"Error: '{rel_display}' is a directory."
    if not overwrite and os.path.exists(abs_path):
        return f"Error: File already exists: {rel_display} (pass overwrite=True or use edit_file)."

    import tools.tools as tools_mod

    if not tools_mod.confirm_tool_execution("write_file", f"Write {rel_display}"):
        return "Action cancelled by user."

    parent = os.path.dirname(abs_path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    text = str(content or "")
    try:
        with open(abs_path, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
    except OSError as exc:
        return f"Error: Unable to write '{rel_display}': {exc}"

    line_count = len(text.splitlines()) if text else 0
    return f"Wrote {rel_display} ({line_count} lines)."


def _kill_process_tree(proc: subprocess.Popen[bytes]) -> None:
    if proc.poll() is not None:
        return
    if sys.platform == "win32":
        try:
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=5,
                creationflags=_CREATE_NO_WINDOW,
            )
        except Exception:
            pass
    try:
        proc.kill()
    except Exception:
        pass


def _truncate_cmd_output(text: str) -> str:
    if len(text) <= _MAX_CMD_OUTPUT_CHARS:
        return text
    omitted = len(text) - 11500
    return f"{text[:7500]}\n\n... [{omitted} chars omitted] ...\n\n{text[-4000:]}"


def run_command(command: str, cwd: str = "", timeout: int = 60) -> str:
    """Execute a headless shell command in the workspace and return bounded output."""
    band_notice = _read_only_band_notice()
    if band_notice:
        return band_notice

    clean_cmd = str(command or "").strip()
    if not clean_cmd:
        return "Error: command is required for run_command."

    work_cwd, rel_cwd, err = _resolve_workspace_target(cwd, must_exist=True)
    if err:
        return err
    if os.path.isfile(work_cwd):
        work_cwd = os.path.dirname(work_cwd)

    import tools.tools as tools_mod

    if not tools_mod.confirm_tool_execution("run_command", f"Run in {rel_cwd}: {clean_cmd}"):
        return "Action cancelled by user."

    try:
        eff_timeout = max(5, min(180, int(timeout or 60)))
    except (TypeError, ValueError):
        eff_timeout = 60

    argv = (
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", clean_cmd]
        if sys.platform == "win32"
        else ["/bin/sh", "-c", clean_cmd]
    )
    proc = subprocess.Popen(
        argv,
        cwd=work_cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        creationflags=_CREATE_NO_WINDOW,
    )

    sess_id = tools_mod.current_session_id.get()
    deadline = time.monotonic() + eff_timeout
    try:
        from runners.runner import cancelled_sessions
    except Exception:
        cancelled_sessions = set()

    cancelled = False
    timed_out = False
    while proc.poll() is None:
        if sess_id and sess_id in cancelled_sessions:
            cancelled = True
            _kill_process_tree(proc)
            break
        if time.monotonic() >= deadline:
            timed_out = True
            _kill_process_tree(proc)
            break
        time.sleep(0.2)

    try:
        raw_out, _ = proc.communicate(timeout=3)
    except Exception:
        raw_out = b""
    out_text = _truncate_cmd_output((raw_out or b"").decode("utf-8", errors="replace").strip())

    if cancelled:
        return "Cancelled by user."
    if timed_out:
        return f"Error: Command timed out after {eff_timeout}s.\n{out_text}".strip()
    if proc.returncode == 0:
        return f"[Command succeeded (exit 0)]\n{out_text}" if out_text else "[Command succeeded (exit 0)]"
    return f"Error: Command exited with code {proc.returncode}.\n{out_text}".strip()


def _fn_schema(name: str, description: str, properties: dict[str, Any], required: list[str]) -> dict[str, Any]:
    return {
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": {
                "type": "object",
                "properties": properties,
                "required": required,
            },
        },
    }


READ_BAND_SCHEMAS: list[dict[str, Any]] = [
    _fn_schema(
        "list_dir",
        "List directories and files in the workspace.",
        {"path": {"type": "string", "description": "Relative or workspace path (empty for root)."}},
        [],
    ),
    _fn_schema(
        "read_file",
        "Read numbered lines from a text file in the workspace.",
        {
            "path": {"type": "string", "description": "File path to read."},
            "start_line": {"type": "integer", "description": "1-based start line (default 1)."},
            "end_line": {"type": "integer", "description": "1-based end line (default 250)."},
        },
        ["path"],
    ),
    _fn_schema(
        "grep_search",
        "Fixed-string literal search across workspace files.",
        {
            "query": {"type": "string", "description": "Exact literal text to search for."},
            "path": {"type": "string", "description": "Optional directory or file scope."},
            "case_sensitive": {"type": "boolean", "description": "Case-sensitive match (default false)."},
        },
        ["query"],
    ),
]

WRITE_BAND_SCHEMAS: list[dict[str, Any]] = [
    _fn_schema(
        "edit_file",
        "Replace one exact unique block of text in an existing file.",
        {
            "path": {"type": "string", "description": "File path to edit."},
            "target": {"type": "string", "description": "Exact existing lines to replace."},
            "replacement": {"type": "string", "description": "Replacement lines."},
        },
        ["path", "target", "replacement"],
    ),
    _fn_schema(
        "write_file",
        "Create or overwrite a file in the workspace.",
        {
            "path": {"type": "string", "description": "File path to write."},
            "content": {"type": "string", "description": "Full UTF-8 file content."},
            "overwrite": {"type": "boolean", "description": "Allow overwriting existing file (default true)."},
        },
        ["path", "content"],
    ),
    _fn_schema(
        "run_command",
        "Run a headless shell command (tests, git, builds) in the workspace.",
        {
            "command": {"type": "string", "description": "Command line to execute."},
            "cwd": {"type": "string", "description": "Optional working directory inside workspace."},
            "timeout": {"type": "integer", "description": "Timeout in seconds (default 60)."},
        },
        ["command"],
    ),
]

WEB_BAND_SCHEMAS: list[dict[str, Any]] = [
    _fn_schema(
        "read_webpage",
        "Fetch and extract readable Markdown from a URL.",
        {"url": {"type": "string", "description": "HTTP or HTTPS URL."}},
        ["url"],
    ),
    _fn_schema(
        "web_search",
        "Search the web for documentation or current information.",
        {"query": {"type": "string", "description": "Search query."}},
        ["query"],
    ),
]
