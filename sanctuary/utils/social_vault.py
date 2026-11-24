"""Encrypted server-side persistence for social credentials and conversation sessions."""

from __future__ import annotations

import ctypes
import ipaddress
import json
import os
import sqlite3
import threading
import time
from contextlib import closing
from pathlib import Path
from urllib.parse import urlparse

from cryptography.fernet import Fernet

DATA_DIR = Path(__file__).resolve().parents[2] / "social" / "data"
_DPAPI_PREFIX = b"DPAPI1:"
_RAW_KEY_PREFIX = b"RAW1:"
_KXC_PREFIX = b"KXC1:"
VAULT_MASTER_KEY_URL = "https://lm-sanctuary.local/vault-master-key"
VAULT_MASTER_KEY_LOGIN = "lm-sanctuary-vault"

_KXC_KEY_LOCK = threading.RLock()
_kxc_cached_key: tuple[str, bytes] | None = None


class VaultLockedError(RuntimeError):
    """Raised when KeePassXC escrow is enabled and the database is locked."""


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


def clear_cached_vault_key() -> None:
    global _kxc_cached_key
    with _KXC_KEY_LOCK:
        _kxc_cached_key = None


def is_keepassxc_vault_enabled() -> bool:
    key_path = DATA_DIR / "social_vault.key"
    try:
        return key_path.read_bytes().startswith(_KXC_PREFIX)
    except OSError:
        return False


def get_vault_mode() -> str:
    return "keepassxc" if is_keepassxc_vault_enabled() else "local"


def _resolve_keepassxc_fernet_key(expected_hash: str) -> bytes:
    global _kxc_cached_key
    from utils.keepassxc_client import (
        KeePassXCAssociationError,
        KeePassXCLockedError,
        KeePassXCUnavailableError,
        get_keepassxc_bridge,
    )

    bridge = get_keepassxc_bridge()
    with _KXC_KEY_LOCK:
        try:
            db_hash, _ver = bridge.get_database_hash(trigger_unlock=False, timeout=1.5)
        except (KeePassXCLockedError, KeePassXCUnavailableError) as exc:
            clear_cached_vault_key()
            raise VaultLockedError(
                "KeePassXC database is locked or unavailable. Unlock KeePassXC to access social credentials."
            ) from exc

        if expected_hash and db_hash != expected_hash:
            clear_cached_vault_key()
            raise VaultLockedError(
                "Active KeePassXC database does not match the paired vault database."
            )

        if _kxc_cached_key is not None and _kxc_cached_key[0] == db_hash:
            return _kxc_cached_key[1]

        try:
            entries = bridge.get_logins(VAULT_MASTER_KEY_URL, trigger_unlock=False, timeout=2.5)
        except (KeePassXCLockedError, KeePassXCAssociationError, KeePassXCUnavailableError) as exc:
            clear_cached_vault_key()
            raise VaultLockedError(f"KeePassXC vault access unavailable: {exc}") from exc

        chosen = None
        for ent in entries:
            if ent.get("login") == VAULT_MASTER_KEY_LOGIN and ent.get("password"):
                chosen = ent["password"]
                break
        if not chosen and entries and entries[0].get("password"):
            chosen = entries[0]["password"]
        if not chosen:
            raise VaultLockedError(
                "Vault master key entry not found in the unlocked KeePassXC database."
            )
        key_bytes = chosen.encode("ascii")
        _kxc_cached_key = (db_hash, key_bytes)
        return key_bytes


def _fernet() -> Fernet:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key_path = DATA_DIR / "social_vault.key"
    try:
        stored_key = key_path.read_bytes()
        if stored_key.startswith(_KXC_PREFIX):
            expected_hash = stored_key[len(_KXC_PREFIX) :].decode("utf-8", errors="ignore").strip()
            return Fernet(_resolve_keepassxc_fernet_key(expected_hash))
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
            stored_again = key_path.read_bytes()
            if stored_again.startswith(_KXC_PREFIX):
                expected_hash = stored_again[len(_KXC_PREFIX) :].decode("utf-8", errors="ignore").strip()
                return Fernet(_resolve_keepassxc_fernet_key(expected_hash))
            key = _decode_key_file(stored_again)
    return Fernet(key)


def _mirror_account_to_keepassxc(account_id: str, meta: dict, secrets: dict) -> None:
    try:
        from utils.keepassxc_client import get_keepassxc_bridge

        bridge = get_keepassxc_bridge()
        login_name = str(meta.get("acct") or meta.get("handle") or account_id).strip()
        bridge.set_login(
            f"https://lm-sanctuary.local/social/{account_id}",
            login_name,
            json.dumps(secrets, ensure_ascii=False),
            group="LM-Sanctuary",
        )
    except Exception:
        # Mirroring individual accounts into KeePassXC is best-effort once master key is escrowed.
        pass


def enable_keepassxc_vault(db_hash: str) -> dict:
    """Escrow the vault master key inside KeePassXC and remove the local key from disk."""
    global _kxc_cached_key
    clean_hash = str(db_hash or "").strip()
    if not clean_hash:
        raise ValueError("KeePassXC database hash is required")

    from utils.keepassxc_client import get_keepassxc_bridge

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key_path = DATA_DIR / "social_vault.key"
    bridge = get_keepassxc_bridge()

    existing_entries = bridge.get_logins(VAULT_MASTER_KEY_URL, trigger_unlock=False, timeout=2.5)
    existing_secret = ""
    for ent in existing_entries:
        if ent.get("login") == VAULT_MASTER_KEY_LOGIN and ent.get("password"):
            existing_secret = ent["password"]
            break
    if not existing_secret and existing_entries and existing_entries[0].get("password"):
        existing_secret = existing_entries[0]["password"]

    # Read existing accounts before replacing social_vault.key, then mirror them to KeePassXC.
    existing_accounts: list[dict] = []
    if key_path.is_file():
        try:
            existing_accounts = list_social_accounts()
        except Exception:
            existing_accounts = []

    had_local_key = False
    if existing_secret:
        key = existing_secret.encode("ascii")
        if key_path.is_file() and not key_path.read_bytes().startswith(_KXC_PREFIX):
            had_local_key = True
    elif key_path.is_file():
        stored = key_path.read_bytes()
        if stored.startswith(_KXC_PREFIX):
            with _KXC_KEY_LOCK:
                key = _kxc_cached_key[1] if _kxc_cached_key is not None else Fernet.generate_key()
        else:
            key = _decode_key_file(stored)
    else:
        key = Fernet.generate_key()

    # Validate key syntax before escrowing.
    Fernet(key)
    key_str = key.decode("ascii")
    if existing_secret != key_str:
        bridge.set_login(
            VAULT_MASTER_KEY_URL,
            VAULT_MASTER_KEY_LOGIN,
            key_str,
            group="LM-Sanctuary",
        )
        verified = bridge.get_logins(VAULT_MASTER_KEY_URL, trigger_unlock=False, timeout=2.5)
        if not any(ent.get("password") == key_str for ent in verified):
            raise RuntimeError("KeePassXC did not return the escrowed vault key on verification readback.")

    marker = _KXC_PREFIX + clean_hash.encode("utf-8")
    tmp_path = DATA_DIR / "social_vault.key.tmp"
    with tmp_path.open("wb") as f:
        f.write(marker)
    if os.name != "nt":
        tmp_path.chmod(0o600)
    os.replace(tmp_path, key_path)
    if os.name != "nt":
        key_path.chmod(0o600)

    with _KXC_KEY_LOCK:
        _kxc_cached_key = (clean_hash, key)

    for acc in existing_accounts:
        acc_meta = acc.get("meta") if isinstance(acc, dict) else None
        acc_secrets = acc.get("secrets") if isinstance(acc, dict) else None
        if isinstance(acc_meta, dict) and isinstance(acc_secrets, dict) and acc_meta.get("id"):
            if had_local_key:
                upsert_social_account(str(acc_meta["id"]), acc_meta, acc_secrets)
            else:
                _mirror_account_to_keepassxc(str(acc_meta["id"]), acc_meta, acc_secrets)

    return {"vault_mode": "keepassxc", "database_hash": clean_hash}


def disable_keepassxc_vault() -> dict:
    """Restore the active Fernet key from KeePassXC back to local protected storage."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    key_path = DATA_DIR / "social_vault.key"
    if not key_path.is_file():
        return {"vault_mode": "local"}
    stored = key_path.read_bytes()
    if not stored.startswith(_KXC_PREFIX):
        return {"vault_mode": "local"}
    expected_hash = stored[len(_KXC_PREFIX) :].decode("utf-8", errors="ignore").strip()
    key = _resolve_keepassxc_fernet_key(expected_hash)
    tmp_path = DATA_DIR / "social_vault.key.tmp"
    _write_key_file(tmp_path, key)
    os.replace(tmp_path, key_path)
    if os.name != "nt":
        key_path.chmod(0o600)
    clear_cached_vault_key()
    return {"vault_mode": "local"}


def is_loopback_addr(remote_addr: str | None) -> bool:
    try:
        addr = ipaddress.ip_address(str(remote_addr or "").strip())
    except ValueError:
        return False
    if addr.version == 6 and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    return bool(addr.is_loopback)


def is_trusted_vault_cors_origin(origin: str, host_header: str = "", scheme: str = "http") -> bool:
    clean = str(origin or "").strip()
    if not clean:
        return False
    if clean in ("capacitor://localhost", "ionic://localhost"):
        return True
    extra = [item.strip() for item in os.getenv("SANCTUARY_ALLOWED_ORIGINS", "").split(",") if item.strip()]
    if clean in extra:
        return True
    if host_header:
        try:
            parsed = urlparse(clean)
            if parsed.scheme in ("http", "https") and parsed.netloc and parsed.netloc.lower() == host_header.lower():
                return True
        except Exception:
            return False
    return False


def verify_trusted_vault_request(req) -> tuple[bool, int, str]:
    """Enforce strict same-origin / allowlisted-origin and remote Basic Auth on credential routes."""
    origin = str(req.headers.get("Origin") or "").strip()
    if origin and not is_trusted_vault_cors_origin(origin, req.host or "", req.scheme or "http"):
        return False, 403, "Cross-origin access to credential vault is forbidden."

    fetch_site = str(req.headers.get("Sec-Fetch-Site") or "").strip().lower()
    if fetch_site == "cross-site" and not is_trusted_vault_cors_origin(origin, req.host or "", req.scheme or "http"):
        return False, 403, "Cross-site access to credential vault is forbidden."

    if not is_loopback_addr(req.remote_addr):
        auth_user = os.getenv("AUTH_USER")
        auth_pass = os.getenv("AUTH_PASS")
        if auth_user and auth_pass:
            auth = req.authorization
            if not auth or auth.username != auth_user or auth.password != auth_pass:
                return False, 401, "Authentication required for remote credential vault access."
    return True, 200, ""


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
    if is_keepassxc_vault_enabled():
        _mirror_account_to_keepassxc(account_id, saved_meta, secrets)
    return {"meta": saved_meta, "secrets": secrets}


def delete_social_account(account_id: str) -> None:
    clean_id = str(account_id)
    with closing(_connect()) as conn:
        with conn:
            conn.execute("DELETE FROM social_accounts WHERE account_id = ?", (clean_id,))
    if is_keepassxc_vault_enabled():
        try:
            from utils.keepassxc_client import get_keepassxc_bridge

            bridge = get_keepassxc_bridge()
            if bridge.is_unlocked():
                target_url = f"https://lm-sanctuary.local/social/{clean_id}"
                summary = bridge.list_entries_summary()
                for ent in summary.get("entries", []):
                    if ent.get("url") == target_url and ent.get("uuid"):
                        bridge.delete_entry(ent["uuid"])
        except Exception:
            pass


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
