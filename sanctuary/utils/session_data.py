"""Encrypted persistence helpers for conversation session files."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from cryptography.fernet import Fernet, InvalidToken

from utils.social_vault import VaultLockedError, decrypt_data, encrypt_data

_ENCRYPTED_PREFIX = b"LM_SANCTUARY_SESSION_V1\n"


def write_session_data(path: str | os.PathLike[str], data: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    plaintext = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
    encrypted = _ENCRYPTED_PREFIX + encrypt_data(plaintext)
    temp_path = target.with_name(target.name + ".tmp")
    temp_path.write_bytes(encrypted)
    os.replace(temp_path, target)


def read_session_data(path: str | os.PathLike[str]) -> Any:
    target = Path(path)
    raw = target.read_bytes()
    if raw.startswith(_ENCRYPTED_PREFIX):
        try:
            plaintext = decrypt_data(raw[len(_ENCRYPTED_PREFIX):])
        except InvalidToken as exc:
            raise VaultLockedError(
                "Encrypted session data could not be decrypted with the active vault key."
            ) from exc
        return json.loads(plaintext.decode("utf-8"))

    data = json.loads(raw.decode("utf-8"))
    write_session_data(target, data)
    return data


def reencrypt_with_donor_keys(programs_dir: str | os.PathLike[str], donor_keys: list[bytes]) -> int:
    if not donor_keys:
        return 0
    root = Path(programs_dir)
    reencrypted = 0
    targets: list[Path] = []
    for pattern in ("*/sessions/*.json", "*/journals.json", "*/quest_log.json", "*/databank.json"):
        targets.extend(root.glob(pattern))
    for path in targets:
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if not raw.startswith(_ENCRYPTED_PREFIX):
            continue
        ciphertext = raw[len(_ENCRYPTED_PREFIX):]
        try:
            decrypt_data(ciphertext)
            continue
        except (InvalidToken, VaultLockedError):
            pass
        for dk in donor_keys:
            try:
                plaintext = Fernet(dk).decrypt(ciphertext)
                parsed = json.loads(plaintext.decode("utf-8"))
            except Exception:
                continue
            write_session_data(path, parsed)
            reencrypted += 1
            break
    return reencrypted


def migrate_session_files(programs_dir: str | os.PathLike[str]) -> tuple[int, list[str]]:
    root = Path(programs_dir)
    migrated = 0
    failures = []
    targets: list[Path] = []
    for pattern in ("*/sessions/*.json", "*/journals.json", "*/quest_log.json", "*/databank.json"):
        targets.extend(root.glob(pattern))
    for path in targets:
        try:
            raw = path.read_bytes()
            if raw.startswith(_ENCRYPTED_PREFIX):
                continue
            data = json.loads(raw.decode("utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            failures.append(f"{path}: {exc}")
            continue
        write_session_data(path, data)
        migrated += 1
    return migrated, failures
