import asyncio
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SANCTUARY_DIR = Path(__file__).resolve().parents[1]
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from lxml import etree  # noqa: E402
from runners.runner import OpenSourceRunner  # noqa: E402
from utils import keepassxc_client, social_vault  # noqa: E402
from utils.session_data import read_session_data, write_session_data  # noqa: E402


class _IsolatedRunner(OpenSourceRunner):
    def __init__(self, tmp_dir: str):
        self._lock = threading.RLock()
        self._async_session_locks = {}
        self.sessions_history = {}
        self.sessions_program = {}
        self.sessions_inversion_state = {}
        self.sessions_memory_state = {}
        self.sessions_group_meta = {}
        self.generating_sessions = set()
        self._generating_counts = {}
        self._memory_pipeline_sessions = set()
        self._loaded_sessions = set()
        self.program_id = "sebile"
        self.tmp_dir = tmp_dir

    def _get_session_path(self, session_id: str, program_id: str = None) -> str:
        prog_dir = os.path.join(self.tmp_dir, "core", "programs", program_id or self.program_id)
        os.makedirs(os.path.join(prog_dir, "sessions"), exist_ok=True)
        card = os.path.join(prog_dir, f"{os.path.basename(prog_dir)}.json")
        if not os.path.exists(card):
            with open(card, "w", encoding="utf-8") as f:
                json.dump({"name": "Sebile", "first_mes": "Hello there."}, f)
        return os.path.join(prog_dir, "sessions", f"{session_id}.json")


class KeyBoxAndEncryptedHistoryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self._orig_data_dir = social_vault.DATA_DIR
        self._orig_bridge = keepassxc_client._DEFAULT_BRIDGE
        social_vault.DATA_DIR = Path(self._tmp.name) / "social_data"
        social_vault.DATA_DIR.mkdir(parents=True, exist_ok=True)
        social_vault.clear_cached_vault_key()
        self.bridge = keepassxc_client.InAppKeePassVault(
            data_dir=social_vault.DATA_DIR,
            on_lock_callback=social_vault.clear_cached_vault_key,
            argon2_memory_kib=64,
            argon2_iterations=1,
            argon2_lanes=1,
        )
        keepassxc_client._DEFAULT_BRIDGE = self.bridge

    def tearDown(self):
        social_vault.clear_cached_vault_key()
        keepassxc_client._DEFAULT_BRIDGE = self._orig_bridge
        social_vault.DATA_DIR = self._orig_data_dir
        self._tmp.cleanup()

    def test_locked_vault_never_overwrites_or_poisons_encrypted_chat_history(self):
        info = self.bridge.create_vault("master-pw")
        social_vault.enable_keepassxc_vault(info["hash"])

        runner = _IsolatedRunner(self._tmp.name)
        session_path = runner._get_session_path("default", "sebile")
        original_messages = [
            {"id": "first_mes_1", "role": "program", "text": "Hello."},
            {"id": "usr_1", "role": "user", "text": "Important long history message"},
            {"id": "prgm_1", "role": "program", "text": "Saved response"},
        ]
        write_session_data(session_path, {"messages": original_messages})
        original_bytes = Path(session_path).read_bytes()

        # Lock vault and clear runner RAM (simulating Flask restart/reload)
        self.bridge.lock_database()
        runner.clear_cached_sessions()

        # Attempt to read history while locked must raise VaultLockedError and never overwrite file or cache []
        with self.assertRaises(social_vault.VaultLockedError):
            runner._ensure_first_message("default")
        with self.assertRaises(social_vault.VaultLockedError):
            asyncio.run(runner.get_history("default"))

        self.assertNotIn("default", runner.sessions_history)
        self.assertEqual(Path(session_path).read_bytes(), original_bytes)

        # Explicitly verify _save_session_to_disk refuses to overwrite an unloaded non-empty file
        runner._save_session_to_disk("default")
        self.assertEqual(Path(session_path).read_bytes(), original_bytes)

        # Unlock vault and verify full history restores cleanly
        self.bridge.unlock("master-pw")
        runner.clear_cached_sessions()
        restored = asyncio.run(runner.get_history("default"))
        self.assertEqual([m["id"] for m in restored], ["first_mes_1", "usr_1", "prgm_1"])
        self.assertEqual(restored[1]["text"], "Important long history message")
        decoded = read_session_data(session_path)
        self.assertEqual(len(decoded["messages"]), 3)

    def test_keybox_crud_search_summary_and_custom_field_preservation(self):
        info = self.bridge.create_vault("master-pw")
        social_vault.enable_keepassxc_vault(info["hash"])

        # Create entry without URL and with Notes + custom group
        created = self.bridge.save_entry(
            title="Home Router",
            login="admin",
            password="router-secret-1",
            url="",
            notes="192.168.1.1 admin console",
            group="Network",
        )
        self.assertEqual(created["title"], "Home Router")
        self.assertEqual(created["group"], "Network")
        self.assertEqual(created["notes"], "192.168.1.1 admin console")

        # Inject a custom XML <String> field directly to verify editing preserves unknown KDBX fields
        for _g, entry_el in self.bridge._iter_active_entries(self.bridge._tree):
            if keepassxc_client._uuid_b64_to_hex(entry_el.findtext("UUID") or "") == created["uuid"]:
                s_el = etree.SubElement(entry_el, "String")
                etree.SubElement(s_el, "Key").text = "CustomPin"
                etree.SubElement(s_el, "Value").text = "9944"

        # Edit entry (update title, login, password, notes, move to Homelab group)
        updated = self.bridge.save_entry(
            entry_uuid=created["uuid"],
            title="Core Router",
            login="root",
            password="router-secret-2",
            url="https://router.local",
            notes="Updated notes",
            group="Homelab",
        )
        self.assertEqual(updated["title"], "Core Router")
        self.assertEqual(updated["login"], "root")
        self.assertEqual(updated["password"], "router-secret-2")
        self.assertEqual(updated["group"], "Homelab")
        self.assertEqual(updated["notes"], "Updated notes")

        # Create API key entry and check summary excludes VAULT_MASTER_KEY_URL
        self.bridge.save_entry(
            title="GreenPT",
            key_name="greenpt_api_key",
            password="sk-test-key-value",
            kind="api_key",
            notes="Cloud model key",
        )
        summary = self.bridge.list_entries_summary()
        titles = {e["title"] for e in summary["entries"]}
        self.assertIn("Core Router", titles)
        self.assertIn("GreenPT", titles)
        self.assertNotIn(keepassxc_client.VAULT_MASTER_KEY_LOGIN, titles)
        self.assertIn("Homelab", summary["groups"])

        # Re-lock and re-unlock to verify persistence & custom field preservation
        self.bridge.lock_database()
        self.bridge.unlock("master-pw")
        reloaded = self.bridge.get_entry(created["uuid"])
        self.assertEqual(reloaded["password"], "router-secret-2")
        custom_val = ""
        for _g, entry_el in self.bridge._iter_active_entries(self.bridge._tree):
            if keepassxc_client._uuid_b64_to_hex(entry_el.findtext("UUID") or "") == created["uuid"]:
                custom_val = keepassxc_client._entry_strings(entry_el).get("CustomPin", "")
        self.assertEqual(custom_val, "9944")

        # Master key entry cannot be read/edited/deleted
        master_entries = self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)
        self.assertTrue(master_entries)
        with self.assertRaises(ValueError):
            self.bridge.get_entry(master_entries[0]["uuid"])
        with self.assertRaises(ValueError):
            self.bridge.delete_entry(master_entries[0]["uuid"])

    def test_journals_quests_databank_encrypted_and_external_kdbx_open_sync(self):
        from core import quest_manager
        from core.skills.vectorized_databank.databank import DataBankManager
        from tools import journals as journals_mod
        import variables.settings as vs

        info = self.bridge.create_vault("master-pw")
        social_vault.enable_keepassxc_vault(info["hash"])

        prog_dir = Path(self._tmp.name) / "core" / "programs" / "sebile"
        prog_dir.mkdir(parents=True, exist_ok=True)
        (prog_dir / "sebile.json").write_text('{"name": "Sebile"}', encoding="utf-8")

        orig_prog_dir = vs.PROGRAMS_DIR
        orig_j_dir = journals_mod.PROGRAMS_DIR
        orig_q_dir = quest_manager.PROGRAMS_DIR
        vs.PROGRAMS_DIR = str(prog_dir.parent)
        journals_mod.PROGRAMS_DIR = str(prog_dir.parent)
        quest_manager.PROGRAMS_DIR = str(prog_dir.parent)
        try:
            # Journals, quests, and databank must be encrypted on disk
            journals_mod.save_journal_entries([{"id": "j1", "content": "Private journal note"}], program_id="sebile")
            quest_manager._write(str(prog_dir / "quest_log.json"), [{"id": "q1", "title": "Private quest"}])
            db = DataBankManager(db_dir=str(prog_dir))
            db._save_data(str(prog_dir / "databank.json"), {"documents": [{"id": "d1", "title": "Private doc"}], "chunks": []})

            for fname in ("journals.json", "quest_log.json", "databank.json"):
                raw_txt = (prog_dir / fname).read_text(encoding="utf-8")
                self.assertTrue(raw_txt.startswith("LM_SANCTUARY_SESSION_V1\n"), f"{fname} must be encrypted at rest")
                self.assertNotIn("Private ", raw_txt)

            # Locking vault must block reading journals, quests, and databank
            self.bridge.lock_database()
            with self.assertRaises(social_vault.VaultLockedError):
                journals_mod.get_journal_entries("sebile")
            with self.assertRaises(social_vault.VaultLockedError):
                quest_manager.load_quests("sebile")
            with self.assertRaises(social_vault.VaultLockedError):
                db._load_data(str(prog_dir / "databank.json"))

            # Opening an external cloud-synced .kdbx file in place migrates master key and picks up external edits
            self.bridge.unlock("master-pw")
            master_entries = self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)
            carry_secret = master_entries[0]["password"]

            external_dir = Path(self._tmp.name) / "cloud_sync"
            external_vault = keepassxc_client.InAppKeePassVault(
                data_dir=external_dir,
                argon2_memory_kib=64,
                argon2_iterations=1,
                argon2_lanes=1,
            )
            external_vault.create_vault("cloud-pw")
            external_vault.save_entry(title="Phone Login", login="me@example.com", password="p1", url="https://example.org")
            ext_path = external_vault.vault_path()

            self.bridge.open_existing_vault(ext_path, "cloud-pw", carry_master_secret=carry_secret)
            new_hash, _ = self.bridge.get_database_hash()
            social_vault.enable_keepassxc_vault(new_hash)
            self.assertEqual(self.bridge.vault_path().resolve(), ext_path.resolve())
            self.assertEqual(journals_mod.get_journal_entries("sebile")[0]["content"], "Private journal note")

            # Simulate another device updating the synced .kdbx file on disk
            external_vault.unlock("cloud-pw")
            external_vault.save_entry(title="Desktop Update", login="other", password="p2", url="https://other.org")
            titles = {e["title"] for e in self.bridge.list_entries_summary()["entries"]}
            self.assertIn("Desktop Update", titles)
        finally:
            vs.PROGRAMS_DIR = orig_prog_dir
            journals_mod.PROGRAMS_DIR = orig_j_dir
            quest_manager.PROGRAMS_DIR = orig_q_dir

    def test_open_external_kdbx_and_unlock_recovery_with_and_without_preexisting_vault(self):
        from flask import Flask
        from routes.keepassxc import keepassxc_bp

        app = Flask(__name__)
        app.register_blueprint(keepassxc_bp)
        client = app.test_client()

        # 1) Create initial sanctuary.kdbx, enable vault, encrypt session data, then LOCK
        info = self.bridge.create_vault("same-pw")
        social_vault.enable_keepassxc_vault(info["hash"])
        orig_secret = self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)[0]["password"]

        runner = _IsolatedRunner(self._tmp.name)
        session_path = runner._get_session_path("default", "sebile")
        write_session_data(session_path, {"messages": [{"id": "m1", "role": "user", "text": "Keep me safe"}]})

        self.bridge.lock_database()
        runner.clear_cached_sessions()

        # External cloud.kdbx created outside Sanctuary (no VAULT_MASTER_KEY_URL entry)
        ext_dir = Path(self._tmp.name) / "cloud_same_pw"
        ext_vault = keepassxc_client.InAppKeePassVault(
            data_dir=ext_dir,
            argon2_memory_kib=64,
            argon2_iterations=1,
            argon2_lanes=1,
        )
        ext_vault.create_vault("same-pw")
        ext_path = ext_vault.vault_path()

        # Opening external .kdbx while sanctuary.kdbx is LOCKED must migrate key & decrypt session
        res = client.post("/api/keepassxc/open-file", json={"path": str(ext_path), "password": "same-pw"})
        self.assertEqual(res.status_code, 200, res.get_json())
        self.assertEqual(
            self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)[0]["password"],
            orig_secret,
        )
        self.assertEqual(read_session_data(session_path)["messages"][0]["text"], "Keep me safe")

        # 2) Different password on external .kdbx returns 409 needs_previous_password without clobbering kdbx_path.txt,
        #    and succeeds once previousPassword is provided.
        self.bridge.lock_database()
        ext_diff_dir = Path(self._tmp.name) / "cloud_diff_pw"
        ext_diff = keepassxc_client.InAppKeePassVault(
            data_dir=ext_diff_dir,
            argon2_memory_kib=64,
            argon2_iterations=1,
            argon2_lanes=1,
        )
        ext_diff.create_vault("cloud-only-pw")
        ext_diff_path = ext_diff.vault_path()
        # Reset custom path back to default sanctuary.kdbx
        self.bridge._custom_path_config().unlink(missing_ok=True)
        # Re-point social_vault.key to original hash
        self.bridge.unlock("same-pw")
        social_vault.enable_keepassxc_vault(info["hash"])
        self.bridge.lock_database()

        res_409 = client.post("/api/keepassxc/open-file", json={"path": str(ext_diff_path), "password": "cloud-only-pw"})
        self.assertEqual(res_409.status_code, 409)
        self.assertTrue(res_409.get_json().get("needs_previous_password"))

        res_ok = client.post(
            "/api/keepassxc/open-file",
            json={"path": str(ext_diff_path), "password": "cloud-only-pw", "previousPassword": "same-pw"},
        )
        self.assertEqual(res_ok.status_code, 200, res_ok.get_json())
        self.assertEqual(
            self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)[0]["password"],
            orig_secret,
        )
        self.assertEqual(read_session_data(session_path)["messages"][0]["text"], "Keep me safe")

        # 3) Immediate unlock() recovery when kdbx_path.txt already points to a bare external .kdbx
        #    while sanctuary.kdbx still sits in data_dir (exact user disk state before this fix)
        self.bridge.lock_database()
        bare_dir = Path(self._tmp.name) / "cloud_bare_recovery"
        bare_vault = keepassxc_client.InAppKeePassVault(
            data_dir=bare_dir,
            argon2_memory_kib=64,
            argon2_iterations=1,
            argon2_lanes=1,
        )
        bare_vault.create_vault("same-pw")
        bare_path = bare_vault.vault_path()
        self.bridge._custom_path_config().write_text(str(bare_path), encoding="utf-8")

        res_rec = client.post("/api/keepassxc/unlock", json={"password": "same-pw"})
        self.assertEqual(res_rec.status_code, 200, res_rec.get_json())
        self.assertEqual(
            self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)[0]["password"],
            orig_secret,
        )
        self.assertEqual(read_session_data(session_path)["messages"][0]["text"], "Keep me safe")

        # 4) No pre-existing sanctuary.kdbx at all + orphaned KXC1 marker + external .kdbx without VAULT_MASTER_KEY_URL
        self.bridge.lock_database()
        self.bridge._custom_path_config().unlink(missing_ok=True)
        (social_vault.DATA_DIR / "sanctuary.kdbx").unlink(missing_ok=True)
        fresh_dir = Path(self._tmp.name) / "cloud_no_preexisting"
        fresh_vault = keepassxc_client.InAppKeePassVault(
            data_dir=fresh_dir,
            argon2_memory_kib=64,
            argon2_iterations=1,
            argon2_lanes=1,
        )
        fresh_vault.create_vault("brand-new-pw")
        fresh_path = fresh_vault.vault_path()

        res_fresh = client.post("/api/keepassxc/open-file", json={"path": str(fresh_path), "password": "brand-new-pw"})
        self.assertEqual(res_fresh.status_code, 200, res_fresh.get_json())
        generated_secret = self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)[0]["password"]
        self.assertTrue(generated_secret)

        # 5) Second device opening that already-initialized cloud .kdbx preserves generated_secret
        self.bridge.lock_database()
        social_vault.clear_cached_vault_key()
        (social_vault.DATA_DIR / "social_vault.key").unlink(missing_ok=True)
        res_second = client.post("/api/keepassxc/open-file", json={"path": str(fresh_path), "password": "brand-new-pw"})
        self.assertEqual(res_second.status_code, 200, res_second.get_json())
        self.assertEqual(
            self.bridge.get_logins(keepassxc_client.VAULT_MASTER_KEY_URL)[0]["password"],
            generated_secret,
        )

    def test_multi_turn_chat_persists_program_responses_across_vault_lock_and_reload(self):
        from unittest.mock import patch

        info = self.bridge.create_vault("master-pw")
        social_vault.enable_keepassxc_vault(info["hash"])

        runner = _IsolatedRunner(self._tmp.name)
        session_path = runner._get_session_path("default", "sebile")
        runner._ensure_first_message("default")

        turn_counter = {"n": 0}

        async def _fake_llm_loop(
            session_id,
            adapter,
            model,
            inversion_directive,
            rag_context,
            new_message_text,
            invocation_id,
            speaker_id=None,
            shared_post=None,
        ):
            turn_counter["n"] += 1
            msg = adapter.append_assistant_message(
                f"Reply #{turn_counter['n']} to {new_message_text}",
                [],
                invocation_id,
                speaker_id=speaker_id,
            )
            return msg["text"], [], msg["id"]

        with patch.object(runner, "_execute_local_llm_loop", side_effect=_fake_llm_loop):
            _, _, _, prog_id_1 = asyncio.run(runner.run_async("default", "Turn 1"))
            self.assertTrue(asyncio.run(runner.set_message_duration("default", prog_id_1, 1.2)))
            asyncio.run(runner.run_async("default", "Turn 2"))
            _, _, _, prog_id_3 = asyncio.run(runner.run_async("default", "Turn 3"))

            # Lock vault, clear runner RAM (simulating reload/restart), unlock, and verify ALL 7 messages persisted
            self.bridge.lock_database()
            runner.clear_cached_sessions()
            self.bridge.unlock("master-pw")

            restored = asyncio.run(runner.get_history("default"))
            self.assertEqual(len(restored), 7)
            self.assertTrue(restored[0]["id"].startswith("first_mes_"))
            self.assertEqual(
                [m["text"] for m in restored[1:]],
                [
                    "Turn 1",
                    "Reply #1 to Turn 1",
                    "Turn 2",
                    "Reply #2 to Turn 2",
                    "Turn 3",
                    "Reply #3 to Turn 3",
                ],
            )
            self.assertEqual(restored[2]["duration"], 1.2)
            disk_msgs = read_session_data(session_path)["messages"]
            self.assertEqual(len(disk_msgs), 7)

            # Reroll Turn 3 via edit_turn, lock + clear cache + unlock, and verify rerolled reply persisted
            asyncio.run(runner.edit_turn("default", prog_id_3))
            self.bridge.lock_database()
            runner.clear_cached_sessions()
            self.bridge.unlock("master-pw")

            restored_after_reroll = asyncio.run(runner.get_history("default"))
            self.assertEqual(len(restored_after_reroll), 7)
            self.assertEqual(restored_after_reroll[-1]["text"], "Reply #4 to Turn 3")


if __name__ == "__main__":
    unittest.main()
