"""Threads data-export ZIP parser, Mastodon CSV builder, and paced Fediverse follow runner."""

from __future__ import annotations

import io
import json
import re
import threading
import time
import zipfile
from pathlib import Path
from typing import IO, Any

_VALID_THREADS_HANDLE_RE = re.compile(r"^[A-Za-z0-9_.][A-Za-z0-9._-]{0,63}$")


def decode_meta_mojibake(value: Any) -> str:
    """Fix Meta JSON export UTF-8 bytes decoded as Latin-1."""
    text = str(value or "")
    if not text:
        return ""
    if any(0x80 <= ord(ch) <= 0xFF for ch in text) and all(ord(ch) <= 0xFF for ch in text):
        try:
            return text.encode("latin-1").decode("utf-8")
        except Exception:
            return text
    return text


def _normalize_threads_handle(raw: Any) -> str:
    clean = decode_meta_mojibake(raw).strip().lstrip("@").lower()
    if not clean or not _VALID_THREADS_HANDLE_RE.match(clean):
        return ""
    return clean


def _parse_string_list_entries(payload: Any, wrapper_key: str) -> list[dict[str, Any]]:
    rows = payload.get(wrapper_key, []) if isinstance(payload, dict) else (payload if isinstance(payload, list) else [])
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        title = decode_meta_mojibake(row.get("title") or "").strip()
        sdata = row.get("string_list_data") or []
        for entry in sdata if isinstance(sdata, list) else []:
            if not isinstance(entry, dict):
                continue
            handle = _normalize_threads_handle(entry.get("value") or "")
            if not handle or handle in seen:
                continue
            seen.add(handle)
            out.append({
                "username": handle,
                "displayName": title,
                "timestamp": int(entry.get("timestamp") or 0),
            })
    return out


def parse_threads_export_zip(
    source: str | Path | bytes | IO[bytes],
    source_name: str = "",
) -> dict[str, Any]:
    """Extract following and mutuals (intersected with followers) from a Meta Threads export ZIP."""
    buf: Any
    name = source_name
    if isinstance(source, (str, Path)):
        p = Path(source)
        name = name or p.name
        buf = p
    elif isinstance(source, (bytes, bytearray)):
        buf = io.BytesIO(bytes(source))
        name = name or "threads-export.zip"
    else:
        buf = source
        name = name or "threads-export.zip"

    followers: list[dict[str, Any]] = []
    following: list[dict[str, Any]] = []

    with zipfile.ZipFile(buf, "r") as zf:
        for member in zf.namelist():
            norm = member.replace("\\", "/").lstrip("/")
            if norm.endswith("threads/followers.json") or norm == "followers.json":
                payload = json.loads(zf.read(member).decode("utf-8"))
                followers = _parse_string_list_entries(payload, "text_post_app_text_post_app_followers")
            elif norm.endswith("threads/following.json") or norm == "following.json":
                payload = json.loads(zf.read(member).decode("utf-8"))
                following = _parse_string_list_entries(payload, "text_post_app_text_post_app_following")

    follower_by_handle = {row["username"]: row for row in followers}
    mutuals: list[dict[str, Any]] = []
    for row in following:
        f_row = follower_by_handle.get(row["username"])
        if f_row is None:
            continue
        mutuals.append({
            "username": row["username"],
            "displayName": row["displayName"] or f_row["displayName"],
            "timestamp": row["timestamp"] or f_row["timestamp"],
        })

    return {
        "sourceName": name,
        "importedAt": int(time.time() * 1000),
        "counts": {
            "mutuals": len(mutuals),
            "following": len(following),
        },
        "mutuals": mutuals,
        "following": following,
    }


def build_mastodon_csv(kind: str, accounts: list[dict[str, Any]]) -> str:
    """Build Mastodon Web Preferences -> Import compatible follow CSV."""
    _ = str(kind or "").strip().lower()
    lines = ["Account address,Show boosts,Notify on new posts,Languages"]
    seen: set[str] = set()
    for row in accounts:
        raw = row.get("username") if isinstance(row, dict) else row
        handle = _normalize_threads_handle(raw)
        if not handle or handle in seen:
            continue
        seen.add(handle)
        lines.append(f"{handle}@threads.net,true,false,")
    return "\n".join(lines) + "\n"


def resolve_federated_threads_account(masto: Any, username: str) -> dict[str, Any] | None:
    """Lookup @<username>@threads.net on Mastodon, strictly verifying the returned host is Threads."""
    handle = _normalize_threads_handle(username)
    if not handle or not masto:
        return None
    target_acct = f"{handle}@threads.net"
    found = masto.lookup_account(target_acct)
    if not isinstance(found, dict) or not found.get("id"):
        return None
    ret_acct = str(found.get("acct") or "").strip().lstrip("@").lower()
    if ret_acct not in (target_acct, f"{handle}@threads.com"):
        return None
    return found


def seed_archive_into_store(
    store: Any,
    parsed: dict[str, Any],
) -> dict[str, Any]:
    """Persist parsed Threads following & mutuals lists into SQLite KV."""
    store.kv_put("kv", "threads_import_archive_v1", parsed)
    return {
        "sourceName": parsed.get("sourceName") or "",
        "importedAt": parsed.get("importedAt") or 0,
        "counts": parsed.get("counts") or {},
    }


class ThreadsImportJobRunner:
    """Rate-limit-paced background Mastodon @threads.net follow resolver."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._cancel_event = threading.Event()
        self._thread: threading.Thread | None = None
        self._state: dict[str, Any] = {
            "status": "idle",
            "total": 0,
            "processed": 0,
            "followed": 0,
            "notFederated": 0,
            "errors": 0,
            "currentHandle": "",
            "startedAt": 0,
            "finishedAt": 0,
            "errorMessage": "",
        }

    def status(self) -> dict[str, Any]:
        with self._lock:
            return dict(self._state)

    def cancel(self) -> dict[str, Any]:
        self._cancel_event.set()
        with self._lock:
            if self._state["status"] == "running":
                self._state["status"] = "cancelled"
                self._state["finishedAt"] = int(time.time() * 1000)
            return dict(self._state)

    def start_sync(
        self,
        masto: Any,
        *,
        follow_accounts: list[dict[str, Any]] | None = None,
        delay_sec: float = 1.1,
    ) -> dict[str, Any]:
        if not masto:
            raise RuntimeError("Connect Mastodon first")

        queue_handles: list[str] = []
        for row in follow_accounts or []:
            h = _normalize_threads_handle(row.get("username") if isinstance(row, dict) else row)
            if h:
                queue_handles.append(h)

        with self._lock:
            if self._state["status"] == "running" and self._thread and self._thread.is_alive():
                return dict(self._state)
            self._cancel_event.clear()
            now_ms = int(time.time() * 1000)
            self._state = {
                "status": "completed" if not queue_handles else "running",
                "total": len(queue_handles),
                "processed": 0,
                "followed": 0,
                "notFederated": 0,
                "errors": 0,
                "currentHandle": "",
                "startedAt": now_ms,
                "finishedAt": now_ms if not queue_handles else 0,
                "errorMessage": "",
            }
            if not queue_handles:
                return dict(self._state)

            worker = threading.Thread(
                target=self._run_worker,
                args=(masto, queue_handles, float(delay_sec)),
                daemon=True,
            )
            self._thread = worker
            worker.start()
            return dict(self._state)

    def _run_worker(self, masto: Any, queue_handles: list[str], delay_sec: float) -> None:
        try:
            for idx, handle in enumerate(queue_handles):
                if self._cancel_event.is_set():
                    with self._lock:
                        self._state["status"] = "cancelled"
                        self._state["finishedAt"] = int(time.time() * 1000)
                    return

                with self._lock:
                    self._state["currentHandle"] = f"{handle}@threads.net"

                for attempt in range(2):
                    try:
                        acc = resolve_federated_threads_account(masto, handle)
                        if not acc:
                            with self._lock:
                                self._state["notFederated"] += 1
                            break
                        masto.follow_account(str(acc["id"]), undo=False)
                        with self._lock:
                            self._state["followed"] += 1
                        break
                    except Exception as exc:
                        msg = str(exc)
                        if "429" in msg and attempt == 0 and not self._cancel_event.is_set():
                            self._cancel_event.wait(30.0)
                            continue
                        with self._lock:
                            self._state["errors"] += 1
                        break

                with self._lock:
                    self._state["processed"] += 1

                if delay_sec > 0 and idx + 1 < len(queue_handles):
                    self._cancel_event.wait(delay_sec)

            with self._lock:
                self._state["currentHandle"] = ""
                if self._state["status"] == "running":
                    self._state["status"] = "completed"
                self._state["finishedAt"] = int(time.time() * 1000)
        except Exception as exc:
            with self._lock:
                self._state["status"] = "error"
                self._state["errorMessage"] = str(exc)
                self._state["finishedAt"] = int(time.time() * 1000)
