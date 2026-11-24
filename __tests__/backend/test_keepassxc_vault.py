"""Verify in-app KDBX 4.0 vault, NaCl crypto_box protocol, API key vaulting, import/export, and origin guards."""

from __future__ import annotations

import base64
import json
import os
import shutil
import struct
import sys
import tempfile
from pathlib import Path

from flask import Flask

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from routes.keepassxc import keepassxc_bp
from routes.social_accounts import social_accounts_bp
from routes.system import system_bp
from utils import keepassxc_client, social_vault
import variables.settings as vs


def verify_nacl_vector() -> None:
    alice_sk = bytes.fromhex("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
    bob_pk = bytes.fromhex("de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
    bob_sk = bytes.fromhex("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb")
    alice_pk = bytes.fromhex("8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")
    nonce = bytes.fromhex("69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37")
    msg = bytes.fromhex(
        "be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffce5ecbaaf33bd751a"
        "1ac728d45e6c61296cdc3c01233561f41db66cce314adb310e3be8250c46f06dceea3a7fa134805"
        "7e2f6556ad6b1318a024a838f21af1fde048977eb48f59ffd4924ca1c60902e52f0a089bc768970"
        "40e082f937763848645e0705"
    )
    expected = bytes.fromhex(
        "f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce48332ea7164d96a4"
        "476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c97271d2c20f9b928fe2270d6fb863d5173"
        "8b48eeee314a7cc8ab932164548e526ae90224368517acfeabd6bb3732bc0e9da99832b61ca01b6"
        "de56244a9e88d5f9b37973f622a43d14a6599b1f654cb45a74e355a5"
    )
    ct = keepassxc_client.crypto_box(msg, nonce, bob_pk, alice_sk)
    assert ct == expected
    pt = keepassxc_client.crypto_box_open(ct, nonce, alice_pk, bob_sk)
    assert pt == msg
    assert keepassxc_client.increment_nonce(b"\xff" + b"\x00" * 23) == b"\x00\x01" + b"\x00" * 22


def run_tests() -> None:
    verify_nacl_vector()

    original_data_dir = social_vault.DATA_DIR
    original_vars_dir = vs.VARIABLES_DIR
    original_bridge = keepassxc_client._DEFAULT_BRIDGE
    original_greenpt_env = os.environ.get("GREENPT_API_KEY")
    temp_dir = Path(tempfile.mkdtemp(prefix="kdbx4_vault_test_"))
    vars_dir = temp_dir / "variables"
    vars_dir.mkdir(parents=True, exist_ok=True)

    bridge = keepassxc_client.InAppKeePassVault(
        data_dir=temp_dir,
        on_lock_callback=social_vault.clear_cached_vault_key,
        argon2_memory_kib=8192,
        argon2_iterations=1,
        argon2_lanes=1,
    )
    try:
        social_vault.DATA_DIR = temp_dir
        vs.VARIABLES_DIR = str(vars_dir)
        social_vault.clear_cached_vault_key()
        keepassxc_client._DEFAULT_BRIDGE = bridge

        app = Flask(__name__)
        app.register_blueprint(social_accounts_bp)
        app.register_blueprint(keepassxc_bp)
        app.register_blueprint(system_bp)
        client = app.test_client()

        # 1. Cross-origin & cross-site requests to social vault & keepassxc must be rejected with 403
        assert client.get("/api/social/accounts", headers={"Origin": "http://localhost:3000"}).status_code == 403
        assert client.get("/api/social/accounts", headers={"Sec-Fetch-Site": "cross-site"}).status_code == 403
        assert client.get("/api/keepassxc/status", headers={"Origin": "http://192.168.1.50:8080"}).status_code == 403

        # 2. Save a social account + plaintext API key locally, then create in-app KDBX 4.0 vault
        res = client.put(
            "/api/social/accounts/mastodon:davy",
            json={
                "meta": {"id": "mastodon:davy", "platform": "fediverse", "acct": "davy@mastodon.social"},
                "secrets": {"accessToken": "super_secret_masto_tok"},
            },
        )
        assert res.status_code == 200
        (vars_dir / "project_settings.json").write_text(
            json.dumps({"greenpt_api_key": "sk-plaintext-before-vault"}),
            encoding="utf-8",
        )

        setup_res = client.post("/api/keepassxc/setup", json={"password": "correct-horse-battery"})
        assert setup_res.status_code == 200, setup_res.get_data(as_text=True)
        setup_json = setup_res.get_json()
        assert setup_json["initialized"] is True
        assert setup_json["database_unlocked"] is True
        assert setup_json["vault_mode"] == "keepassxc"

        # Verify KDBX 4.0 magic bytes on disk and scrubbed plaintext settings/key
        kdbx_bytes = (temp_dir / "sanctuary.kdbx").read_bytes()
        sig1, sig2, ver = struct.unpack_from("<III", kdbx_bytes, 0)
        assert (sig1, sig2, ver) == (0x9AA2D903, 0xB54BFB67, 0x00040000)

        kxc_marker = (temp_dir / "social_vault.key").read_bytes()
        assert kxc_marker == f"KXC1:{setup_json['database_hash']}".encode("utf-8")

        disk_settings = json.loads((vars_dir / "project_settings.json").read_text(encoding="utf-8"))
        assert disk_settings["greenpt_api_key"] == ""
        assert disk_settings["greenpt_api_key_in_vault"] is True
        assert bridge.get_secret("greenpt_api_key") == "sk-plaintext-before-vault"

        # 3. Internal vault master key URL cannot be queried via /api/keepassxc/logins
        assert client.post("/api/keepassxc/logins", json={"url": social_vault.VAULT_MASTER_KEY_URL}).status_code == 400

        # 4. Locking zeroes RAM key, clears env API key, and returns HTTP 503
        assert client.post("/api/keepassxc/lock").get_json()["database_unlocked"] is False
        assert os.environ.get("GREENPT_API_KEY", "") == ""
        locked_accounts = client.get("/api/social/accounts")
        assert locked_accounts.status_code == 503
        assert locked_accounts.get_json()["locked"] is True

        # 5. Wrong master password fails with HTTP 401
        wrong_unlock = client.post("/api/keepassxc/unlock", json={"password": "wrong-password"})
        assert wrong_unlock.status_code == 401
        assert wrong_unlock.get_json()["auth_failed"] is True

        # 6. Correct master password unlocks social accounts + API key
        unlock_res = client.post("/api/keepassxc/unlock", json={"password": "correct-horse-battery"})
        assert unlock_res.status_code == 200
        assert unlock_res.get_json()["database_unlocked"] is True
        assert os.environ.get("GREENPT_API_KEY") == "sk-plaintext-before-vault"
        loaded = client.get("/api/social/accounts")
        assert loaded.status_code == 200
        assert loaded.get_json()["accounts"][0]["secrets"]["accessToken"] == "super_secret_masto_tok"

        # 7. Browser login save, domain-matched retrieval, export, and import round-trip
        assert client.post(
            "/api/keepassxc/save-login",
            json={"url": "https://bsky.app/login", "login": "davy.bsky.social", "password": "pw!"},
        ).status_code == 200
        logins_res = client.post("/api/keepassxc/logins", json={"url": "https://bsky.app/settings"})
        assert logins_res.status_code == 200
        assert logins_res.get_json()["entries"][0]["password"] == "pw!"

        exported_res = client.get("/api/keepassxc/export")
        assert exported_res.status_code == 200
        exported_bytes = exported_res.data

        # Import exported .kdbx into a fresh uninitialized vault instance
        import_dir = temp_dir / "import_target"
        import_dir.mkdir(parents=True, exist_ok=True)
        bridge2 = keepassxc_client.InAppKeePassVault(
            data_dir=import_dir,
            argon2_memory_kib=8192,
            argon2_iterations=1,
            argon2_lanes=1,
        )
        keepassxc_client._DEFAULT_BRIDGE = bridge2
        social_vault.DATA_DIR = import_dir
        imp_res = client.post(
            "/api/keepassxc/import",
            json={
                "kdbxBase64": base64.b64encode(exported_bytes).decode("ascii"),
                "password": "correct-horse-battery",
            },
        )
        assert imp_res.status_code == 200, imp_res.get_data(as_text=True)
        imp_logins = client.post("/api/keepassxc/logins", json={"url": "https://bsky.app/"})
        assert imp_logins.status_code == 200
        assert imp_logins.get_json()["entries"][0]["login"] == "davy.bsky.social"

        # 8. Verify native Argon2d KDBX 4.0 KDF import (KeePassXC default)
        argon2d_kdf_bytes = keepassxc_client._serialize_variant_dict([
            (0x42, "$UUID", keepassxc_client._KDF_ARGON2D),
            (0x42, "S", b"a" * 32),
            (0x04, "P", 1),
            (0x05, "M", 8192 * 1024),
            (0x05, "I", 1),
            (0x04, "V", 0x13),
        ])
        argon2d_params = keepassxc_client._parse_variant_dict(argon2d_kdf_bytes)
        ckey = keepassxc_client.composite_key_from_password("argon2d-pw")
        derived_d = keepassxc_client._derive_kdf(ckey, argon2d_params)
        assert len(derived_d) == 32
        assert derived_d != keepassxc_client._derive_kdf(
            ckey,
            {**argon2d_params, "$UUID": keepassxc_client._KDF_ARGON2ID},
        )

        print("KDBX4_INAPP_VAULT_AND_CORS_VERIFIED")
    finally:
        bridge.close()
        social_vault.clear_cached_vault_key()
        social_vault.DATA_DIR = original_data_dir
        vs.VARIABLES_DIR = original_vars_dir
        keepassxc_client._DEFAULT_BRIDGE = original_bridge
        if original_greenpt_env is None:
            os.environ.pop("GREENPT_API_KEY", None)
        else:
            os.environ["GREENPT_API_KEY"] = original_greenpt_env
        shutil.rmtree(temp_dir, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
