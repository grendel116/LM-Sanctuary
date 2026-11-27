# SPDX-License-Identifier: AGPL-3.0-or-later
"""API routes for the in-app KDBX 4.0 credential vault & KeePassXC-protocol service."""

from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

from flask import Blueprint, Response, jsonify, request

from utils import social_vault
from utils.keepassxc_client import (
    KeePassXCAssociationError,
    KeePassXCAuthError,
    KeePassXCLockedError,
    KeePassXCMigrationPasswordError,
    KeePassXCUnavailableError,
    VAULT_MASTER_KEY_LOGIN,
    VAULT_MASTER_KEY_URL,
    get_keepassxc_bridge,
)

keepassxc_bp = Blueprint("keepassxc", __name__, url_prefix="/api/keepassxc")
_MAX_IMPORT_BYTES = 32 * 1024 * 1024


def _validate_browser_login_url(raw_url: str) -> str:
    clean = str(raw_url or "").strip()
    if not clean:
        raise ValueError("URL is required.")
    parsed = urlparse(clean)
    scheme = (parsed.scheme or "").lower()
    host = (parsed.hostname or "").lower()
    if not host or host == "lm-sanctuary.local" or host.endswith(".lm-sanctuary.local"):
        raise ValueError("Cannot query or overwrite internal Sanctuary vault entries.")
    if scheme == "https":
        return clean
    if scheme == "http" and host in ("localhost", "127.0.0.1", "::1"):
        return clean
    raise ValueError("Vault logins require an https:// URL (or http://localhost).")


@keepassxc_bp.before_request
def _guard_keepassxc():
    if request.method == "OPTIONS":
        return None
    ok, status, msg = social_vault.verify_trusted_vault_request(request)
    if not ok:
        return jsonify({"error": msg}), status
    if (
        request.path != "/api/keepassxc/status"
        and not social_vault.is_loopback_addr(request.remote_addr)
        and os.getenv("SANCTUARY_ALLOW_REMOTE_KEEPASSXC", "").strip() != "1"
    ):
        return jsonify({
            "error": "Vault unlocking and credential access are restricted to localhost."
        }), 403
    return None


@keepassxc_bp.errorhandler(KeePassXCAuthError)
def _handle_auth_error(exc):
    return jsonify({"error": str(exc), "auth_failed": True}), 401


@keepassxc_bp.errorhandler(KeePassXCLockedError)
@keepassxc_bp.errorhandler(social_vault.VaultLockedError)
def _handle_locked(exc):
    return jsonify({"error": str(exc), "locked": True, "vault": "keepassxc"}), 503


@keepassxc_bp.errorhandler(KeePassXCAssociationError)
def _handle_assoc_error(exc):
    return jsonify({"error": str(exc), "initialized": False, "associated": False}), 409


@keepassxc_bp.errorhandler(KeePassXCUnavailableError)
def _handle_unavailable(exc):
    return jsonify({"error": str(exc), "unavailable": True}), 503


@keepassxc_bp.errorhandler(KeePassXCMigrationPasswordError)
def _handle_migration_pw_error(exc):
    return jsonify({"error": str(exc), "needs_previous_password": True}), 409


def _sync_unlocked_vault_master_key(
    bridge,
    password: str,
    previous_vault_path: Path | None = None,
    previous_password: str = "",
) -> None:
    bridge.ensure_vault_master_key(
        password=password,
        previous_vault_path=previous_vault_path,
        previous_password=previous_password,
    )
    db_hash, _ver = bridge.get_database_hash()
    social_vault.enable_keepassxc_vault(db_hash)


def _stale_encrypted_files() -> list[str]:
    try:
        import state as st
        from utils.session_data import find_undecryptable_files

        if not get_keepassxc_bridge().is_unlocked():
            return []
        return find_undecryptable_files(os.path.join(st.base_dir, "core", "programs"))
    except Exception:
        return []


def _status_payload() -> dict:
    status = get_keepassxc_bridge().get_status()
    status["vault_mode"] = social_vault.get_vault_mode()
    status["stale_encrypted_files"] = _stale_encrypted_files()
    return status


def _clear_runner_session_cache() -> None:
    try:
        import state as st

        if getattr(st, "runner", None) is not None and hasattr(st.runner, "clear_cached_sessions"):
            st.runner.clear_cached_sessions()
    except Exception:
        pass


def _flush_runner_sessions() -> None:
    try:
        import state as st

        if (
            get_keepassxc_bridge().is_unlocked()
            and getattr(st, "runner", None) is not None
            and hasattr(st.runner, "flush_loaded_sessions")
        ):
            st.runner.flush_loaded_sessions()
    except Exception:
        pass


def _migrate_encrypted_program_files() -> None:
    try:
        import state as st
        from utils.session_data import migrate_session_files

        migrate_session_files(os.path.join(st.base_dir, "core", "programs"))
    except Exception:
        pass


def _recover_donor_encrypted_files(
    bridge,
    password: str,
    previous_password: str = "",
    extra_paths: list[Path] | None = None,
) -> int:
    try:
        import state as st
        from utils.session_data import reencrypt_with_donor_keys

        active_resolved = bridge.vault_path().expanduser().resolve()
        candidates: list[Path] = []
        for cand in [bridge.data_dir / "sanctuary.kdbx", *(extra_paths or [])]:
            if not cand:
                continue
            try:
                resolved = Path(cand).expanduser().resolve()
            except OSError:
                continue
            if resolved != active_resolved and resolved.is_file() and resolved not in candidates:
                candidates.append(resolved)

        pw_candidates = [pw for pw in (previous_password, password) if pw]
        donor_keys: list[bytes] = []
        seen_keys: set[bytes] = set()
        for donor in candidates:
            for pw in pw_candidates:
                try:
                    secret = bridge.extract_master_key_from_file(donor, pw)
                except Exception:
                    continue
                if secret:
                    kb = secret.encode("ascii")
                    if kb not in seen_keys:
                        seen_keys.add(kb)
                        donor_keys.append(kb)
                    break

        if donor_keys:
            return reencrypt_with_donor_keys(os.path.join(st.base_dir, "core", "programs"), donor_keys)
        return 0
    except Exception:
        return 0


def _sync_system_api_keys(*, migrate: bool = False, clear: bool = False) -> None:
    try:
        from routes import system as system_routes

        if clear:
            system_routes.clear_vault_api_keys_from_env()
            return
        if migrate:
            system_routes.migrate_plaintext_api_keys_to_vault()
        system_routes.sync_vault_api_keys_to_env()
    except Exception:
        pass


@keepassxc_bp.route("/status", methods=["GET"])
def status():
    return jsonify(_status_payload())


@keepassxc_bp.route("/setup", methods=["POST"])
@keepassxc_bp.route("/associate", methods=["POST"])
def setup_or_associate():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password") or "")
    prev_pw = str(data.get("previousPassword") or "")
    if not password:
        return jsonify({"error": "Master password is required."}), 400
    bridge = get_keepassxc_bridge()
    if bridge.is_unlocked():
        _flush_runner_sessions()
    if not bridge.is_initialized():
        bridge.create_vault(password)
    else:
        if not bridge.is_unlocked():
            bridge.unlock(password)
    _sync_unlocked_vault_master_key(bridge, password=password, previous_password=prev_pw)
    _migrate_encrypted_program_files()
    _clear_runner_session_cache()
    _sync_system_api_keys(migrate=True)
    return jsonify(_status_payload())


@keepassxc_bp.route("/unlock", methods=["POST"])
def unlock():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password") or "")
    prev_pw = str(data.get("previousPassword") or "")
    if not password:
        return jsonify({"error": "Master password is required."}), 400
    bridge = get_keepassxc_bridge()
    if bridge.is_unlocked():
        _flush_runner_sessions()
    bridge.unlock(password)
    if social_vault.is_keepassxc_vault_enabled():
        db_hash, _ver = bridge.get_database_hash()
        key_path = social_vault.DATA_DIR / "social_vault.key"
        expected_hash = ""
        if key_path.is_file():
            stored = key_path.read_bytes()
            if stored.startswith(social_vault._KXC_PREFIX):
                expected_hash = stored[len(social_vault._KXC_PREFIX) :].decode("utf-8", errors="ignore").strip()
        has_master = bool(bridge.get_logins(VAULT_MASTER_KEY_URL))
        if not has_master or (expected_hash and expected_hash != db_hash):
            _sync_unlocked_vault_master_key(bridge, password=password, previous_password=prev_pw)
        social_vault._fernet()
    _migrate_encrypted_program_files()
    _recover_donor_encrypted_files(bridge, password=password, previous_password=prev_pw)
    _clear_runner_session_cache()
    _sync_system_api_keys(migrate=True)
    return jsonify(_status_payload())


@keepassxc_bp.route("/recover-encrypted", methods=["POST"])
def recover_encrypted():
    data = request.get_json(silent=True) or {}
    prev_pw = str(data.get("previousPassword") or "")
    if not prev_pw:
        return jsonify({"error": "Previous vault password is required."}), 400
    bridge = get_keepassxc_bridge()
    if not bridge.is_unlocked():
        raise KeePassXCLockedError("Unlock the vault before recovering files.")
    recovered = _recover_donor_encrypted_files(bridge, password=prev_pw, previous_password=prev_pw)
    _clear_runner_session_cache()
    return jsonify({**_status_payload(), "recovered": recovered})


@keepassxc_bp.route("/browse-file", methods=["POST"])
def browse_kdbx_file():
    title = "Open .kdbx Vault"
    selected_path = ""
    if sys.platform == "darwin":
        try:
            cmd = [
                "osascript",
                "-e",
                f'set f to choose file of type {{"kdbx"}} with prompt {json.dumps(title)}',
                "-e",
                "POSIX path of f",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                selected_path = res.stdout.strip()
        except Exception:
            pass
    elif sys.platform.startswith("linux"):
        try:
            cmd = [
                "zenity",
                "--file-selection",
                f"--title={title}",
                "--file-filter=KeePass Databases (*.kdbx) | *.kdbx",
            ]
            res = subprocess.run(cmd, capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                selected_path = res.stdout.strip()
        except Exception:
            pass

    if not selected_path:
        script = (
            "import tkinter as tk\n"
            "from tkinter import filedialog\n"
            "root = tk.Tk()\n"
            "root.withdraw()\n"
            "root.attributes('-topmost', True)\n"
            "root.focus_force()\n"
            f"path = filedialog.askopenfilename(title={json.dumps(title)}, filetypes=[('KeePass KDBX Database', '*.kdbx'), ('All Files', '*.*')])\n"
            "root.destroy()\n"
            "if path:\n"
            "    print(path)\n"
        )
        try:
            res = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True)
            if res.returncode == 0 and res.stdout.strip():
                selected_path = res.stdout.strip().splitlines()[-1].strip()
        except Exception as exc:
            return jsonify({"error": str(exc)}), 500

    return jsonify({"path": selected_path, "cancelled": not bool(selected_path)})


@keepassxc_bp.route("/open-file", methods=["POST"])
def open_kdbx_file():
    data = request.get_json(silent=True) or {}
    file_path = str(data.get("path") or "").strip()
    password = str(data.get("password") or "")
    prev_pw = str(data.get("previousPassword") or "")
    if not file_path:
        return jsonify({"error": "Path to .kdbx file is required."}), 400
    if not password:
        return jsonify({"error": "Master password is required."}), 400

    bridge = get_keepassxc_bridge()
    prev_path = bridge.vault_path()
    carry_secret = ""

    try:
        target_secret = bridge.extract_master_key_from_file(file_path, password)
    except KeePassXCAuthError as exc:
        return jsonify({"error": str(exc), "auth_failed": True}), 401
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if social_vault.is_keepassxc_vault_enabled() and not target_secret:
        if bridge.is_unlocked():
            try:
                entries = bridge.get_logins(VAULT_MASTER_KEY_URL)
                for ent in entries:
                    if ent.get("login") == VAULT_MASTER_KEY_LOGIN and ent.get("password"):
                        carry_secret = ent["password"]
                        break
                if not carry_secret and entries and entries[0].get("password"):
                    carry_secret = entries[0]["password"]
            except Exception:
                pass
        else:
            target_resolved = Path(file_path).expanduser().resolve()
            donors: list[Path] = []
            for candidate in (prev_path, bridge.data_dir / "sanctuary.kdbx"):
                if not candidate:
                    continue
                try:
                    resolved = Path(candidate).expanduser().resolve()
                except OSError:
                    continue
                if resolved != target_resolved and resolved.is_file() and resolved not in donors:
                    donors.append(resolved)
            pw_candidates = [pw for pw in (prev_pw, password) if pw]
            for donor in donors:
                donor_had_auth_error = False
                donor_unlocked = False
                for pw in pw_candidates:
                    try:
                        secret = bridge.extract_master_key_from_file(donor, pw)
                        donor_unlocked = True
                        if secret:
                            carry_secret = secret
                        break
                    except KeePassXCAuthError:
                        donor_had_auth_error = True
                    except Exception:
                        break
                if carry_secret:
                    break
                if donor_had_auth_error and not donor_unlocked:
                    raise KeePassXCMigrationPasswordError(
                        "Enter the master password for your previous Sanctuary vault to migrate your encryption key."
                    )

    if bridge.is_unlocked():
        _flush_runner_sessions()

    try:
        bridge.open_existing_vault(file_path, password, carry_master_secret=carry_secret)
    except KeePassXCAuthError as exc:
        return jsonify({"error": str(exc), "auth_failed": True}), 401
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    _sync_unlocked_vault_master_key(
        bridge,
        password=password,
        previous_vault_path=prev_path,
        previous_password=prev_pw,
    )
    if social_vault.is_keepassxc_vault_enabled():
        social_vault._fernet()
    _migrate_encrypted_program_files()
    _recover_donor_encrypted_files(
        bridge,
        password=password,
        previous_password=prev_pw,
        extra_paths=[prev_path] if prev_path else None,
    )
    _clear_runner_session_cache()
    _sync_system_api_keys(migrate=True)
    return jsonify(_status_payload())


@keepassxc_bp.route("/lock", methods=["POST"])
def lock():
    _flush_runner_sessions()
    bridge = get_keepassxc_bridge()
    bridge.lock_database()
    social_vault.clear_cached_vault_key()
    _clear_runner_session_cache()
    _sync_system_api_keys(clear=True)
    return jsonify(_status_payload())


@keepassxc_bp.route("/disconnect", methods=["POST"])
def disconnect():
    data = request.get_json(silent=True) or {}
    password = str(data.get("password") or "")
    bridge = get_keepassxc_bridge()
    if bridge.is_initialized() and not bridge.is_unlocked() and password:
        bridge.unlock(password)
    if bridge.is_unlocked():
        _flush_runner_sessions()
    social_vault.disable_keepassxc_vault()
    _clear_runner_session_cache()
    return jsonify(_status_payload())


@keepassxc_bp.route("/change-password", methods=["POST"])
def change_password():
    data = request.get_json(silent=True) or {}
    current_pw = str(data.get("currentPassword") or "")
    new_pw = str(data.get("newPassword") or "")
    if not current_pw or not new_pw:
        return jsonify({"error": "Current and new master passwords are required."}), 400
    get_keepassxc_bridge().change_password(current_pw, new_pw)
    return jsonify(_status_payload())


@keepassxc_bp.route("/logins", methods=["POST"])
def logins():
    data = request.get_json(silent=True) or {}
    try:
        url = _validate_browser_login_url(data.get("url") or "")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    submit_url = str(data.get("submitUrl") or "").strip()
    entries = get_keepassxc_bridge().get_logins(url, submit_url=submit_url)
    safe_entries = [
        {
            "login": e.get("login", ""),
            "password": e.get("password", ""),
            "name": e.get("name", ""),
            "uuid": e.get("uuid", ""),
            "url": e.get("url", ""),
        }
        for e in entries
    ]
    return jsonify({"entries": safe_entries})


@keepassxc_bp.route("/save-login", methods=["POST"])
def save_login():
    data = request.get_json(silent=True) or {}
    try:
        url = _validate_browser_login_url(data.get("url") or "")
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    login = str(data.get("login") or "").strip()
    password = str(data.get("password") or "")
    entry_uuid = str(data.get("uuid") or "").strip()
    title = str(data.get("name") or "").strip()
    if not login or not password:
        return jsonify({"error": "Login and password are required."}), 400
    saved = get_keepassxc_bridge().set_login(
        url, login, password, entry_uuid=entry_uuid, title=title
    )
    return jsonify({"saved": True, "uuid": saved.get("uuid", "")})


@keepassxc_bp.route("/entries", methods=["GET"])
def entries():
    summary = get_keepassxc_bridge().list_entries_summary()
    return jsonify(summary)


@keepassxc_bp.route("/entry", methods=["POST"])
def get_entry():
    data = request.get_json(silent=True) or {}
    entry_uuid = str(data.get("uuid") or "").strip()
    if not entry_uuid:
        return jsonify({"error": "Entry UUID is required."}), 400
    try:
        entry = get_keepassxc_bridge().get_entry(entry_uuid)
    except KeyError:
        return jsonify({"error": "Entry not found."}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"entry": entry})


@keepassxc_bp.route("/save-entry", methods=["POST"])
def save_entry():
    data = request.get_json(silent=True) or {}
    bridge = get_keepassxc_bridge()
    try:
        saved = bridge.save_entry(
            entry_uuid=str(data.get("uuid") or "").strip(),
            title=str(data.get("title") or ""),
            login=str(data.get("login") or ""),
            password=data.get("password") if "password" in data else None,
            url=str(data.get("url") or ""),
            notes=str(data.get("notes") or ""),
            group=str(data.get("group") or ""),
            kind=str(data.get("kind") or "login"),
            key_name=str(data.get("key_name") or data.get("keyName") or ""),
        )
    except KeyError:
        return jsonify({"error": "Entry not found."}), 404
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    _sync_system_api_keys()
    if saved.get("key_name") == "greenpt_api_key":
        try:
            from routes import system as system_routes

            secret = str(saved.get("password") or "")
            system_routes.mark_greenpt_key_in_vault(bool(secret), secret)
        except Exception:
            pass
    return jsonify({"saved": True, "entry": saved, "entries": bridge.list_entries_summary()})


@keepassxc_bp.route("/delete-entry", methods=["POST"])
def delete_entry():
    data = request.get_json(silent=True) or {}
    entry_uuid = str(data.get("uuid") or "").strip()
    if not entry_uuid:
        return jsonify({"error": "Entry UUID is required."}), 400
    try:
        deleted = get_keepassxc_bridge().delete_entry(entry_uuid)
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400
    if deleted:
        _sync_system_api_keys()
    return jsonify({"deleted": deleted})


@keepassxc_bp.route("/api-keys", methods=["POST"])
def save_api_key():
    data = request.get_json(silent=True) or {}
    key_name = str(data.get("key_name") or data.get("keyName") or "").strip()
    secret = str(data.get("secret") or "")
    title = str(data.get("title") or "").strip()
    if not key_name:
        return jsonify({"error": "API key name is required."}), 400
    bridge = get_keepassxc_bridge()
    bridge.set_secret(key_name, secret, title=title or key_name)
    if key_name == "greenpt_api_key":
        try:
            from routes import system as system_routes

            system_routes.mark_greenpt_key_in_vault(bool(secret), secret)
        except Exception:
            if secret:
                os.environ["GREENPT_API_KEY"] = secret
            else:
                os.environ.pop("GREENPT_API_KEY", None)
    return jsonify({"saved": True, "entries": bridge.list_entries_summary()})


@keepassxc_bp.route("/export", methods=["GET"])
def export_kdbx():
    raw = get_keepassxc_bridge().export_kdbx_bytes()
    return Response(
        raw,
        mimetype="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="sanctuary-vault.kdbx"'},
    )


@keepassxc_bp.route("/import", methods=["POST"])
def import_kdbx():
    password = ""
    master_password = ""
    raw_bytes = b""
    if request.files and "file" in request.files:
        f = request.files["file"]
        raw_bytes = f.read(_MAX_IMPORT_BYTES + 1)
        password = str(request.form.get("password") or "")
        master_password = str(request.form.get("masterPassword") or "")
    else:
        data = request.get_json(silent=True) or {}
        b64_str = str(data.get("kdbxBase64") or "").strip()
        password = str(data.get("password") or "")
        master_password = str(data.get("masterPassword") or "")
        if b64_str:
            try:
                raw_bytes = base64.b64decode(b64_str.encode("ascii"), validate=True)
            except Exception:
                return jsonify({"error": "Invalid base64 .kdbx payload."}), 400

    if not raw_bytes:
        return jsonify({"error": ".kdbx file is required."}), 400
    if len(raw_bytes) > _MAX_IMPORT_BYTES:
        return jsonify({"error": ".kdbx file exceeds 32 MiB limit."}), 413
    if not password:
        return jsonify({"error": "Master password for the imported .kdbx file is required."}), 400

    bridge = get_keepassxc_bridge()
    try:
        res = bridge.import_kdbx_bytes(raw_bytes, password, master_password=master_password)
    except KeePassXCAuthError as exc:
        return jsonify({"error": str(exc), "auth_failed": True}), 401
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 400

    if res.get("created"):
        db_hash, _ver = bridge.get_database_hash()
        social_vault.enable_keepassxc_vault(db_hash)
    _clear_runner_session_cache()
    _sync_system_api_keys(migrate=True)
    payload = _status_payload()
    payload.update(res)
    return jsonify(payload)
