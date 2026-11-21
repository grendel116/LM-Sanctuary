"""Encrypted persistence helpers for conversation session files."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from utils.social_vault import decrypt_data, encrypt_data

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
        plaintext = decrypt_data(raw[len(_ENCRYPTED_PREFIX):])
        return json.loads(plaintext.decode("utf-8"))

    data = json.loads(raw.decode("utf-8"))
    write_session_data(target, data)
    return data


def migrate_session_files(programs_dir: str | os.PathLike[str]) -> tuple[int, list[str]]:
    root = Path(programs_dir)
    migrated = 0
    failures = []
    for path in root.glob("*/sessions/*.json"):
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
