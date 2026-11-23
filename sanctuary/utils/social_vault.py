"""Encrypted server-side persistence for social credentials and conversation sessions."""

from __future__ import annotations

import ctypes
import json
import os
import sqlite3
import time
from contextlib import closing
from pathlib import Path

from cryptography.fernet import Fernet

DATA_DIR = Path(__file__).resolve().parents[2] / "social" / "data"
_DPAPI_PREFIX = b"DPAPI1:"
_RAW_KEY_PREFIX = b"RAW1:"


class InvalidSocialAccount(ValueError):
    """Raised when a client submits an invalid social account record."""


class InvalidSocialDraft(ValueError):
    """Raised when a client submits an invalid social draft record."""


class DeletedSocialDraft(InvalidSocialDraft):
    """Raised when a stale client attempts to restore a deleted draft."""


class InvalidSocialLinkedPost(ValueError):
    """Raised when a client submits invalid linked-post metadata."""


class DeletedSocialLinkedPost(InvalidSocialLinkedPost):
    """Raised when a stale client attempts to restore a deleted linked post."""


class InvalidBrowserBookmark(ValueError):
    """Raised when a client submits an invalid browser bookmark record."""


class DeletedBrowserBookmark(InvalidBrowserBookmark):
    """Raised when a stale client attempts to restore a deleted bookmark."""


MAX_SOCIAL_DRAFT_BYTES = 48 * 1024 * 1024
MAX_SOCIAL_LINKED_POST_BYTES = 64 * 1024
MAX_BROWSER_BOOKMARK_BYTES = 64 * 1024


def _database_path() -> Path:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    return DATA_DIR / "accounts.sqlite3"


def _protect_windows_key(key: bytes, protect: bool) -> bytes:
    from ctypes import wintypes

    class DataBlob(ctypes.Structure):
        _fields_ = [
            ("cbData", wintypes.DWORD),
            ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
        ]

    input_buffer = (ctypes.c_ubyte * len(key)).from_buffer_copy(key)
    input_blob = DataBlob(len(key), input_buffer)
    output_blob = DataBlob()
    crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]
    kernel32.LocalFree.restype = ctypes.c_void_p
    flags = 0x1

    if protect:
        transform = crypt32.CryptProtectData
        transform.argtypes = [
            ctypes.POINTER(DataBlob), wintypes.LPCWSTR, ctypes.POINTER(DataBlob),
            wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(DataBlob),
        ]
        transform.restype = wintypes.BOOL
        succeeded = transform(
            ctypes.byref(input_blob), None, None, None, None, flags, ctypes.byref(output_blob)
        )
        description = None
    else:
        transform = crypt32.CryptUnprotectData
        transform.argtypes = [
            ctypes.POINTER(DataBlob), ctypes.POINTER(wintypes.LPWSTR), ctypes.POINTER(DataBlob),
            wintypes.LPVOID, wintypes.LPVOID, wintypes.DWORD, ctypes.POINTER(DataBlob),
        ]
        transform.restype = wintypes.BOOL
        description = wintypes.LPWSTR()
        succeeded = transform(
            ctypes.byref(input_blob), ctypes.byref(description), None, None, None,
            flags, ctypes.byref(output_blob)
        )

    if not succeeded:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        return ctypes.string_at(output_blob.pbData, output_blob.cbData)
    finally:
        kernel32.LocalFree(output_blob.pbData)
        if description and description.value:
            kernel32.LocalFree(description)


def _encode_key_file(key: bytes) -> bytes:
    if os.name == "nt":
        return _DPAPI_PREFIX + _protect_windows_key(key, protect=True)
    return _RAW_KEY_PREFIX + key


def _decode_key_file(stored: bytes) -> bytes:
    if stored.startswith(_DPAPI_PREFIX):
        if os.name != "nt":
            raise RuntimeError("The social vault key was protected on Windows and cannot be opened here")
        return _protect_windows_key(stored[len(_DPAPI_PREFIX):], protect=False)
    if stored.startswith(_RAW_KEY_PREFIX):
        return stored[len(_RAW_KEY_PREFIX):]
    return stored


def _write_key_file(key_path: Path, key: bytes, exclusive: bool = False) -> None:
    mode = "xb" if exclusive else "wb"
    with key_path.open(mode) as key_file:
        key_file.write(_encode_key_file(key))
    if os.name != "nt":
        key_path.chmod(0o600)


def _fernet() -> Fernet:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key_path = DATA_DIR / "social_vault.key"
    try:
        stored_key = key_path.read_bytes()
        key = _decode_key_file(stored_key)
        if not stored_key.startswith(_DPAPI_PREFIX) and (
            not stored_key.startswith(_RAW_KEY_PREFIX) or os.name == "nt"
        ):
            _write_key_file(key_path, key)
        elif os.name != "nt":
            key_path.chmod(0o600)
    except FileNotFoundError:
        generated = Fernet.generate_key()
        try:
            _write_key_file(key_path, generated, exclusive=True)
            key = generated
        except FileExistsError:
            key = _decode_key_file(key_path.read_bytes())
    return Fernet(key)


def encrypt_data(data: bytes) -> bytes:
    return _fernet().encrypt(data)


def decrypt_data(data: bytes) -> bytes:
    return _fernet().decrypt(data)


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(_database_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS social_accounts (
            account_id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            metadata_json TEXT NOT NULL,
            encrypted_secrets BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS social_drafts (
            draft_id TEXT PRIMARY KEY,
            encrypted_draft BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS social_draft_deletions (
            draft_id TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS social_linked_posts (
            canonical_id TEXT PRIMARY KEY,
            encrypted_record BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS social_linked_post_deletions (
            canonical_id TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS browser_bookmarks (
            bookmark_id TEXT PRIMARY KEY,
            encrypted_bookmark BLOB NOT NULL,
            updated_at INTEGER NOT NULL
        )
        """
    )
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS browser_bookmark_deletions (
            bookmark_id TEXT PRIMARY KEY,
            deleted_at INTEGER NOT NULL
        )
        """
    )
    return conn


def list_social_accounts() -> list[dict]:
    cipher = _fernet()
    with closing(_connect()) as conn:
        with conn:
            rows = conn.execute(
                "SELECT account_id, metadata_json, encrypted_secrets FROM social_accounts ORDER BY account_id"
            ).fetchall()
            for row in rows:
                metadata = row["metadata_json"]
                raw_metadata = metadata.encode("utf-8") if isinstance(metadata, str) else bytes(metadata)
                if not raw_metadata.startswith(b"gAAAA"):
                    conn.execute(
                        "UPDATE social_accounts SET metadata_json = ? WHERE account_id = ?",
                        (cipher.encrypt(raw_metadata), row["account_id"]),
                    )
    accounts = []
    for row in rows:
        metadata = row["metadata_json"]
        raw_metadata = metadata.encode("utf-8") if isinstance(metadata, str) else bytes(metadata)
        if not raw_metadata.startswith(b"gAAAA"):
            raw_metadata = cipher.encrypt(raw_metadata)
        accounts.append({
            "meta": json.loads(cipher.decrypt(raw_metadata).decode("utf-8")),
            "secrets": json.loads(cipher.decrypt(row["encrypted_secrets"]).decode("utf-8")),
        })
    return accounts


def save_social_account(account_id: str, meta: dict, secrets: dict) -> dict:
    account_id = str(account_id or "").strip()
    if not account_id or len(account_id) > 256:
        raise InvalidSocialAccount("Account ID must be between 1 and 256 characters")
    if not isinstance(meta, dict) or str(meta.get("id") or "") != account_id:
        raise InvalidSocialAccount("Account metadata ID must match the requested account ID")
    if meta.get("platform") not in {"fediverse", "mastodon", "bluesky", "threads"}:
        raise InvalidSocialAccount("Unsupported social account platform")
    if not isinstance(secrets, dict):
        raise InvalidSocialAccount("Account secrets must be an object")

    saved_meta = dict(meta)
    saved_meta["platform"] = "fediverse" if saved_meta["platform"] == "mastodon" else saved_meta["platform"]
    try:
        updated_at = max(int(time.time() * 1000), int(saved_meta.get("updatedAt") or 0))
    except (TypeError, ValueError) as exc:
        raise InvalidSocialAccount("Account updatedAt must be a timestamp") from exc
    saved_meta["updatedAt"] = updated_at
    cipher = _fernet()
    encrypted_metadata = cipher.encrypt(json.dumps(saved_meta, ensure_ascii=False).encode("utf-8"))
    encrypted_secrets = cipher.encrypt(json.dumps(secrets, ensure_ascii=False).encode("utf-8"))
    with closing(_connect()) as conn:
        with conn:
            conn.execute(
                """
                INSERT INTO social_accounts (account_id, platform, metadata_json, encrypted_secrets, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(account_id) DO UPDATE SET
                    platform = excluded.platform,
                    metadata_json = excluded.metadata_json,
                    encrypted_secrets = excluded.encrypted_secrets,
                    updated_at = excluded.updated_at
                """,
                (
                    account_id,
                    saved_meta["platform"],
                    encrypted_metadata,
                    encrypted_secrets,
                    updated_at,
                ),
            )
    return {"meta": saved_meta, "secrets": secrets}


def delete_social_account(account_id: str) -> None:
    with closing(_connect()) as conn:
        with conn:
            conn.execute("DELETE FROM social_accounts WHERE account_id = ?", (str(account_id),))


def list_social_drafts() -> dict:
    cipher = _fernet()
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT encrypted_draft FROM social_drafts ORDER BY updated_at DESC"
        ).fetchall()
        deleted_ids = [
            row["draft_id"]
            for row in conn.execute(
                "SELECT draft_id FROM social_draft_deletions ORDER BY deleted_at"
            ).fetchall()
        ]
    return {
        "drafts": [
            json.loads(cipher.decrypt(row["encrypted_draft"]).decode("utf-8"))
            for row in rows
        ],
        "deletedIds": deleted_ids,
    }


def save_social_draft(draft_id: str, draft: dict) -> dict:
    draft_id = str(draft_id or "").strip()
    if not draft_id or len(draft_id) > 256:
        raise InvalidSocialDraft("Draft ID must be between 1 and 256 characters")
    if not isinstance(draft, dict) or str(draft.get("id") or "") != draft_id:
        raise InvalidSocialDraft("Draft ID must match the requested ID")

    saved_draft = dict(draft)
    try:
        saved_draft["updatedAt"] = int(saved_draft.get("updatedAt") or 0)
    except (OverflowError, TypeError, ValueError) as exc:
        raise InvalidSocialDraft("Draft updatedAt must be a timestamp") from exc
    serialized = json.dumps(saved_draft, ensure_ascii=False).encode("utf-8")
    if len(serialized) > MAX_SOCIAL_DRAFT_BYTES:
        raise InvalidSocialDraft("Draft exceeds the 48 MiB server limit")

    encrypted_draft = _fernet().encrypt(serialized)
    with closing(_connect()) as conn:
        with conn:
            deleted = conn.execute(
                "SELECT 1 FROM social_draft_deletions WHERE draft_id = ?",
                (draft_id,),
            ).fetchone()
            if deleted:
                raise DeletedSocialDraft("This draft was deleted on another device")
            conn.execute(
                """
                INSERT INTO social_drafts (draft_id, encrypted_draft, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(draft_id) DO UPDATE SET
                    encrypted_draft = excluded.encrypted_draft,
                    updated_at = excluded.updated_at
                """,
                (draft_id, encrypted_draft, saved_draft["updatedAt"]),
            )
    return saved_draft


def delete_social_draft(draft_id: str) -> None:
    draft_id = str(draft_id or "").strip()
    if not draft_id or len(draft_id) > 256:
        raise InvalidSocialDraft("Draft ID must be between 1 and 256 characters")
    with closing(_connect()) as conn:
        with conn:
            conn.execute("DELETE FROM social_drafts WHERE draft_id = ?", (draft_id,))
            conn.execute(
                """
                INSERT INTO social_draft_deletions (draft_id, deleted_at)
                VALUES (?, ?)
                ON CONFLICT(draft_id) DO UPDATE SET deleted_at = excluded.deleted_at
                """,
                (draft_id, int(time.time() * 1000)),
            )


def list_social_linked_posts() -> dict:
    cipher = _fernet()
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT encrypted_record FROM social_linked_posts ORDER BY updated_at DESC"
        ).fetchall()
        deleted_ids = [
            row["canonical_id"]
            for row in conn.execute(
                "SELECT canonical_id FROM social_linked_post_deletions ORDER BY deleted_at"
            ).fetchall()
        ]
    return {
        "records": [
            json.loads(cipher.decrypt(row["encrypted_record"]).decode("utf-8"))
            for row in rows
        ],
        "deletedIds": deleted_ids,
    }


def save_social_linked_post(record: dict) -> dict:
    if not isinstance(record, dict):
        raise InvalidSocialLinkedPost("Linked-post record must be an object")
    canonical_id = str(record.get("canonicalId") or "").strip()
    if not canonical_id or len(canonical_id) > 512:
        raise InvalidSocialLinkedPost("Canonical ID must be between 1 and 512 characters")

    fields = (
        "mastodonStatusId",
        "mastodonInstance",
        "blueskyUri",
        "blueskyCid",
        "threadsPostId",
        "parentCanonicalId",
    )
    saved = {"canonicalId": canonical_id}
    for field in fields:
        value = record.get(field)
        if value is not None and not isinstance(value, str):
            raise InvalidSocialLinkedPost(f"{field} must be a string")
        clean = str(value or "").strip()
        if len(clean) > 2048:
            raise InvalidSocialLinkedPost(f"{field} exceeds the 2048 character limit")
        if clean:
            saved[field] = clean
    try:
        saved["updatedAt"] = max(
            int(time.time() * 1000),
            int(record.get("updatedAt") or 0),
        )
    except (OverflowError, TypeError, ValueError) as exc:
        raise InvalidSocialLinkedPost("updatedAt must be a timestamp") from exc

    serialized = json.dumps(saved, ensure_ascii=False).encode("utf-8")
    if len(serialized) > MAX_SOCIAL_LINKED_POST_BYTES:
        raise InvalidSocialLinkedPost("Linked-post record exceeds the 64 KiB limit")
    cipher = _fernet()
    with closing(_connect()) as conn:
        with conn:
            deleted = conn.execute(
                "SELECT 1 FROM social_linked_post_deletions WHERE canonical_id = ?",
                (canonical_id,),
            ).fetchone()
            if deleted:
                raise DeletedSocialLinkedPost("This linked post was deleted on another device")
            previous = conn.execute(
                "SELECT encrypted_record FROM social_linked_posts WHERE canonical_id = ?",
                (canonical_id,),
            ).fetchone()
            if previous:
                existing = json.loads(cipher.decrypt(previous["encrypted_record"]).decode("utf-8"))
                for field in fields:
                    if not saved.get(field) and existing.get(field):
                        saved[field] = existing[field]
                saved["updatedAt"] = max(
                    saved["updatedAt"],
                    int(existing.get("updatedAt") or 0),
                )
                serialized = json.dumps(saved, ensure_ascii=False).encode("utf-8")
            conn.execute(
                """
                INSERT INTO social_linked_posts (canonical_id, encrypted_record, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(canonical_id) DO UPDATE SET
                    encrypted_record = excluded.encrypted_record,
                    updated_at = excluded.updated_at
                """,
                (canonical_id, cipher.encrypt(serialized), saved["updatedAt"]),
            )
    return saved


def delete_social_linked_post(canonical_id: str) -> None:
    canonical_id = str(canonical_id or "").strip()
    if not canonical_id or len(canonical_id) > 512:
        raise InvalidSocialLinkedPost("Canonical ID must be between 1 and 512 characters")
    with closing(_connect()) as conn:
        with conn:
            conn.execute("DELETE FROM social_linked_posts WHERE canonical_id = ?", (canonical_id,))
            conn.execute(
                """
                INSERT INTO social_linked_post_deletions (canonical_id, deleted_at)
                VALUES (?, ?)
                ON CONFLICT(canonical_id) DO UPDATE SET deleted_at = excluded.deleted_at
                """,
                (canonical_id, int(time.time() * 1000)),
            )


def list_browser_bookmarks() -> dict:
    cipher = _fernet()
    with closing(_connect()) as conn:
        rows = conn.execute(
            "SELECT encrypted_bookmark FROM browser_bookmarks ORDER BY updated_at DESC"
        ).fetchall()
        deleted_ids = [
            row["bookmark_id"]
            for row in conn.execute(
                "SELECT bookmark_id FROM browser_bookmark_deletions ORDER BY deleted_at"
            ).fetchall()
        ]
    return {
        "bookmarks": [
            json.loads(cipher.decrypt(row["encrypted_bookmark"]).decode("utf-8"))
            for row in rows
        ],
        "deletedIds": deleted_ids,
    }


def save_browser_bookmark(bookmark_id: str, bookmark: dict) -> dict:
    from urllib.parse import urlsplit

    bookmark_id = str(bookmark_id or "").strip()
    if not bookmark_id or len(bookmark_id) > 256:
        raise InvalidBrowserBookmark("Bookmark ID must be between 1 and 256 characters")
    if not isinstance(bookmark, dict) or str(bookmark.get("id") or "") != bookmark_id:
        raise InvalidBrowserBookmark("Bookmark ID must match the requested ID")

    raw_url = str(bookmark.get("url") or "").strip()
    if not raw_url or len(raw_url) > 2048:
        raise InvalidBrowserBookmark("Bookmark URL must be between 1 and 2048 characters")
    parsed = urlsplit(raw_url)
    if parsed.scheme.lower() not in ("http", "https") or not parsed.netloc:
        raise InvalidBrowserBookmark("Bookmark URL must use http:// or https://")

    now_ms = int(time.time() * 1000)
    try:
        updated_at = int(bookmark.get("updatedAt") or now_ms)
        created_at = int(bookmark.get("createdAt") or updated_at)
    except (OverflowError, TypeError, ValueError) as exc:
        raise InvalidBrowserBookmark("Bookmark timestamps must be integers") from exc

    saved_bookmark = {
        "id": bookmark_id,
        "url": raw_url,
        "title": str(bookmark.get("title") or "").strip()[:300],
        "folder": str(bookmark.get("folder") or "").strip()[:120],
        "createdAt": created_at,
        "updatedAt": updated_at,
    }
    serialized = json.dumps(saved_bookmark, ensure_ascii=False).encode("utf-8")
    if len(serialized) > MAX_BROWSER_BOOKMARK_BYTES:
        raise InvalidBrowserBookmark("Bookmark exceeds the 64 KiB server limit")

    encrypted_bookmark = _fernet().encrypt(serialized)
    with closing(_connect()) as conn:
        with conn:
            deleted = conn.execute(
                "SELECT 1 FROM browser_bookmark_deletions WHERE bookmark_id = ?",
                (bookmark_id,),
            ).fetchone()
            if deleted:
                raise DeletedBrowserBookmark("This bookmark was deleted on another device")
            conn.execute(
                """
                INSERT INTO browser_bookmarks (bookmark_id, encrypted_bookmark, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(bookmark_id) DO UPDATE SET
                    encrypted_bookmark = excluded.encrypted_bookmark,
                    updated_at = excluded.updated_at
                """,
                (bookmark_id, encrypted_bookmark, saved_bookmark["updatedAt"]),
            )
    return saved_bookmark


def delete_browser_bookmark(bookmark_id: str) -> None:
    bookmark_id = str(bookmark_id or "").strip()
    if not bookmark_id or len(bookmark_id) > 256:
        raise InvalidBrowserBookmark("Bookmark ID must be between 1 and 256 characters")
    with closing(_connect()) as conn:
        with conn:
            conn.execute("DELETE FROM browser_bookmarks WHERE bookmark_id = ?", (bookmark_id,))
            conn.execute(
                """
                INSERT INTO browser_bookmark_deletions (bookmark_id, deleted_at)
                VALUES (?, ?)
                ON CONFLICT(bookmark_id) DO UPDATE SET deleted_at = excluded.deleted_at
                """,
                (bookmark_id, int(time.time() * 1000)),
            )
