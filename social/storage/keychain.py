"""OS Credential Manager / Keychain storage with AES-GCM encrypted local vault fallback."""

from __future__ import annotations

import base64
import ctypes
import hashlib
import json
import os
import platform
import subprocess
import sys
import threading
import uuid
from ctypes import wintypes
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from cryptography.hazmat.primitives import hashes

_CRED_TYPE_GENERIC = 1
_CRED_PERSIST_LOCAL_MACHINE = 2
_WIN32_MAX_BLOB_BYTES = 2400


class _FILETIME(ctypes.Structure):
    _fields_ = [
        ("dwLowDateTime", wintypes.DWORD),
        ("dwHighDateTime", wintypes.DWORD),
    ]


class _CREDENTIALW(ctypes.Structure):
    _fields_ = [
        ("Flags", wintypes.DWORD),
        ("Type", wintypes.DWORD),
        ("TargetName", wintypes.LPWSTR),
        ("Comment", wintypes.LPWSTR),
        ("LastWritten", _FILETIME),
        ("CredentialBlobSize", wintypes.DWORD),
        ("CredentialBlob", ctypes.POINTER(ctypes.c_ubyte)),
        ("Persist", wintypes.DWORD),
        ("AttributeCount", wintypes.DWORD),
        ("Attributes", ctypes.c_void_p),
        ("TargetAlias", wintypes.LPWSTR),
        ("UserName", wintypes.LPWSTR),
    ]


def _win32_advapi32():
    dll = ctypes.WinDLL("Advapi32.dll", use_last_error=True)
    dll.CredWriteW.argtypes = [ctypes.POINTER(_CREDENTIALW), wintypes.DWORD]
    dll.CredWriteW.restype = wintypes.BOOL
    dll.CredReadW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        ctypes.POINTER(ctypes.POINTER(_CREDENTIALW)),
    ]
    dll.CredReadW.restype = wintypes.BOOL
    dll.CredDeleteW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD]
    dll.CredDeleteW.restype = wintypes.BOOL
    dll.CredEnumerateW.argtypes = [
        wintypes.LPCWSTR,
        wintypes.DWORD,
        ctypes.POINTER(wintypes.DWORD),
        ctypes.POINTER(ctypes.POINTER(ctypes.POINTER(_CREDENTIALW))),
    ]
    dll.CredEnumerateW.restype = wintypes.BOOL
    dll.CredFree.argtypes = [ctypes.c_void_p]
    dll.CredFree.restype = None
    return dll


def _command_exists(cmd: str) -> bool:
    from shutil import which
    return which(cmd) is not None


class KeychainStore:
    """Store social credentials in the platform keyring or a 0600 AES-GCM local vault."""

    def __init__(
        self,
        vault_dir: str | Path | None = None,
        service_prefix: str = "LM-Sanctuary/social",
        force_fallback: bool = False,
    ) -> None:
        base_dir = Path(vault_dir) if vault_dir else Path(__file__).resolve().parents[1] / "data"
        self.vault_dir = base_dir
        self.vault_path = base_dir / "vault.enc"
        self.key_seed_path = base_dir / ".vault.seed"
        self.service_prefix = service_prefix.rstrip("/")
        self._lock = threading.RLock()

        env_fallback = os.getenv("SANCTUARY_KEYCHAIN_FALLBACK", "").strip() == "1"
        self.backend = self._detect_backend(force_fallback or env_fallback)

    def _detect_backend(self, use_fallback: bool) -> str:
        if use_fallback:
            return "vault_enc"
        if sys.platform == "win32":
            try:
                _win32_advapi32()
                return "win32_credman"
            except Exception:
                return "vault_enc"
        if sys.platform == "darwin" and Path("/usr/bin/security").exists():
            return "macos_keychain"
        if _command_exists("secret-tool") and (os.getenv("DBUS_SESSION_BUS_ADDRESS") or os.getenv("DISPLAY")):
            return "secret_tool"
        return "vault_enc"

    def _target_name(self, key: str) -> str:
        clean_key = str(key or "").strip()
        if not clean_key:
            raise ValueError("Credential key is required")
        return f"{self.service_prefix}/{clean_key}"

    # ── AES-GCM encrypted vault fallback (0600) ──────────────────────────

    def _derive_vault_key(self) -> bytes:
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        if self.key_seed_path.exists():
            seed = self.key_seed_path.read_bytes()
        else:
            seed = os.urandom(32)
            tmp = self.key_seed_path.with_suffix(".seed.tmp")
            tmp.write_bytes(seed)
            try:
                os.chmod(tmp, 0o600)
            except OSError:
                pass
            os.replace(tmp, self.key_seed_path)
            try:
                os.chmod(self.key_seed_path, 0o600)
            except OSError:
                pass

        machine_ctx = f"{platform.node()}|{os.getlogin() if hasattr(os, 'getlogin') else ''}|{uuid.getnode()}".encode("utf-8")
        salt = hashlib.sha256(seed + machine_ctx).digest()[:16]
        kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=salt, iterations=120_000)
        return kdf.derive(seed)

    def _read_vault_map(self) -> dict[str, dict[str, Any]]:
        if not self.vault_path.exists():
            return {}
        try:
            raw = self.vault_path.read_bytes()
            if len(raw) < 13:
                return {}
            nonce, ct = raw[:12], raw[12:]
            pt = AESGCM(self._derive_vault_key()).decrypt(nonce, ct, b"lm-sanctuary-vault-v1")
            data = json.loads(pt.decode("utf-8"))
            return data if isinstance(data, dict) else {}
        except Exception:
            return {}

    def _write_vault_map(self, mapping: dict[str, dict[str, Any]]) -> None:
        self.vault_dir.mkdir(parents=True, exist_ok=True)
        nonce = os.urandom(12)
        plaintext = json.dumps(mapping, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        ct = AESGCM(self._derive_vault_key()).encrypt(nonce, plaintext, b"lm-sanctuary-vault-v1")
        tmp = self.vault_path.with_suffix(".enc.tmp")
        tmp.write_bytes(nonce + ct)
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, self.vault_path)
        try:
            os.chmod(self.vault_path, 0o600)
        except OSError:
            pass

    # ── Win32 Credential Manager ─────────────────────────────────────────

    def _win32_write(self, target: str, raw_json: str) -> None:
        blob = raw_json.encode("utf-8")
        if len(blob) > _WIN32_MAX_BLOB_BYTES:
            # Store oversized token payloads in encrypted vault and point cred entry at marker.
            with self._lock:
                mapping = self._read_vault_map()
                mapping[target] = json.loads(raw_json)
                self._write_vault_map(mapping)
            blob = json.dumps({"__vault_ref": True}).encode("utf-8")

        dll = _win32_advapi32()
        buf = (ctypes.c_ubyte * len(blob)).from_buffer_copy(blob)
        cred = _CREDENTIALW(
            Flags=0,
            Type=_CRED_TYPE_GENERIC,
            TargetName=target,
            Comment="LM-Sanctuary social credential",
            LastWritten=_FILETIME(0, 0),
            CredentialBlobSize=len(blob),
            CredentialBlob=buf,
            Persist=_CRED_PERSIST_LOCAL_MACHINE,
            AttributeCount=0,
            Attributes=None,
            TargetAlias=None,
            UserName="sanctuary",
        )
        ok = dll.CredWriteW(ctypes.byref(cred), 0)
        if not ok:
            raise OSError(f"CredWriteW failed (winerror={ctypes.get_last_error()})")

    def _win32_read(self, target: str) -> str | None:
        dll = _win32_advapi32()
        pcred = ctypes.POINTER(_CREDENTIALW)()
        ok = dll.CredReadW(target, _CRED_TYPE_GENERIC, 0, ctypes.byref(pcred))
        if not ok:
            return None
        try:
            cred = pcred.contents
            size = int(cred.CredentialBlobSize)
            if size <= 0 or not cred.CredentialBlob:
                return None
            raw_bytes = bytes(ctypes.cast(cred.CredentialBlob, ctypes.POINTER(ctypes.c_ubyte * size)).contents)
            text = raw_bytes.decode("utf-8")
            parsed = json.loads(text)
            if isinstance(parsed, dict) and parsed.get("__vault_ref"):
                with self._lock:
                    val = self._read_vault_map().get(target)
                    return json.dumps(val) if val is not None else None
            return text
        finally:
            dll.CredFree(pcred)

    def _win32_delete(self, target: str) -> bool:
        dll = _win32_advapi32()
        deleted_cred = bool(dll.CredDeleteW(target, _CRED_TYPE_GENERIC, 0))
        with self._lock:
            mapping = self._read_vault_map()
            if target in mapping:
                mapping.pop(target, None)
                self._write_vault_map(mapping)
                deleted_cred = True
        return deleted_cred

    def _win32_list(self) -> list[str]:
        dll = _win32_advapi32()
        count = wintypes.DWORD(0)
        pcreds = ctypes.POINTER(ctypes.POINTER(_CREDENTIALW))()
        filter_str = f"{self.service_prefix}/*"
        ok = dll.CredEnumerateW(filter_str, 0, ctypes.byref(count), ctypes.byref(pcreds))
        if not ok:
            return []
        prefix = f"{self.service_prefix}/"
        keys: list[str] = []
        try:
            for idx in range(int(count.value)):
                tname = pcreds[idx].contents.TargetName or ""
                if tname.startswith(prefix):
                    keys.append(tname[len(prefix):])
        finally:
            dll.CredFree(pcreds)
        return keys

    # ── Public API ───────────────────────────────────────────────────────

    def set_secret(self, key: str, secret: dict[str, Any]) -> None:
        target = self._target_name(key)
        raw_json = json.dumps(secret or {}, ensure_ascii=False)
        with self._lock:
            if self.backend == "win32_credman":
                self._win32_write(target, raw_json)
                return
            if self.backend == "macos_keychain":
                encoded = base64.b64encode(raw_json.encode("utf-8")).decode("ascii")
                subprocess.run(
                    ["/usr/bin/security", "add-generic-password", "-U", "-s", self.service_prefix, "-a", key, "-w", encoded],
                    check=True,
                    capture_output=True,
                )
                return
            if self.backend == "secret_tool":
                encoded = base64.b64encode(raw_json.encode("utf-8")).decode("ascii")
                subprocess.run(
                    ["secret-tool", "store", "--label", "LM-Sanctuary", "service", self.service_prefix, "account", key],
                    input=encoded.encode("utf-8"),
                    check=True,
                    capture_output=True,
                )
                return
            mapping = self._read_vault_map()
            mapping[key] = json.loads(raw_json)
            self._write_vault_map(mapping)

    def get_secret(self, key: str) -> dict[str, Any] | None:
        target = self._target_name(key)
        with self._lock:
            if self.backend == "win32_credman":
                raw = self._win32_read(target)
                return json.loads(raw) if raw else None
            if self.backend == "macos_keychain":
                res = subprocess.run(
                    ["/usr/bin/security", "find-generic-password", "-s", self.service_prefix, "-a", key, "-w"],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                if res.returncode != 0 or not res.stdout.strip():
                    return None
                return json.loads(base64.b64decode(res.stdout.strip()).decode("utf-8"))
            if self.backend == "secret_tool":
                res = subprocess.run(
                    ["secret-tool", "lookup", "service", self.service_prefix, "account", key],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                if res.returncode != 0 or not res.stdout.strip():
                    return None
                return json.loads(base64.b64decode(res.stdout.strip()).decode("utf-8"))
            val = self._read_vault_map().get(key)
            return dict(val) if isinstance(val, dict) else None

    def delete_secret(self, key: str) -> bool:
        target = self._target_name(key)
        with self._lock:
            if self.backend == "win32_credman":
                return self._win32_delete(target)
            if self.backend == "macos_keychain":
                res = subprocess.run(
                    ["/usr/bin/security", "delete-generic-password", "-s", self.service_prefix, "-a", key],
                    check=False,
                    capture_output=True,
                )
                return res.returncode == 0
            if self.backend == "secret_tool":
                res = subprocess.run(
                    ["secret-tool", "clear", "service", self.service_prefix, "account", key],
                    check=False,
                    capture_output=True,
                )
                return res.returncode == 0
            mapping = self._read_vault_map()
            if key not in mapping:
                return False
            mapping.pop(key, None)
            self._write_vault_map(mapping)
            return True

    def list_keys(self) -> list[str]:
        with self._lock:
            if self.backend == "win32_credman":
                return self._win32_list()
            if self.backend == "vault_enc":
                return sorted(self._read_vault_map().keys())
            return []
