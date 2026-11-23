"""Phase 1 verification suite for the relocated sanctuary/ Blueprints and web/ static serving."""

import asyncio
import json
import os
import shutil
import sys
import tempfile
import time
from pathlib import Path
from unittest import mock

# 1. Disable LLM autostart and background cache prewarm BEFORE importing backend modules
os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"

import dotenv
dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

import variables.settings as vs
import runners.program as rp
import runners.runner as rr
import core.program_config as cpc
import core.mood_inversion as cmi
from utils.utils import _get_safe_local_path


def verify_default_paths_and_guardrails():
    assert os.path.normpath(vs.WEB_DIR) == os.path.normpath(REPO_ROOT / "web"), vs.WEB_DIR
    assert os.path.normpath(vs.PROGRAMS_DIR) == os.path.normpath(SANCTUARY_DIR / "core" / "programs"), vs.PROGRAMS_DIR
    if not os.getenv("COMFYUI_DIR"):
        assert os.path.normpath(vs.COMFYUI_DIR) == os.path.normpath(REPO_ROOT.parent / "ComfyUI"), vs.COMFYUI_DIR

    # Verify _get_safe_local_path is independent of working directory
    orig_cwd = os.getcwd()
    try:
        os.chdir(REPO_ROOT)
        p1 = _get_safe_local_path("/images/portraits/sample.png", program_id="sebile")
        os.chdir(tempfile.gettempdir())
        p2 = _get_safe_local_path("/images/portraits/sample.png", program_id="sebile")
        assert os.path.abspath(p1) == os.path.abspath(p2), (p1, p2)
    finally:
        os.chdir(orig_cwd)

    # Confirm zero AI social dispatch files were added
    forbidden = [
        SANCTUARY_DIR / "tools" / "social_dispatch.py",
        SANCTUARY_DIR / "core" / "skills" / "social_dispatch",
        SANCTUARY_DIR / "adapters" / "threads_adapter.py",
        SANCTUARY_DIR / "adapters" / "fediverse_adapter.py",
        SANCTUARY_DIR / "variables" / "social_accounts.json",
    ]
    for path in forbidden:
        assert not path.exists(), f"Forbidden social backend path exists: {path}"

    # Verify Windows console suppression helpers & zero powershell shell=True calls in local_server
    import subprocess
    from utils import lifecycle
    local_server_src = (SANCTUARY_DIR / "runners" / "local_server.py").read_text(encoding="utf-8")
    assert "powershell" not in local_server_src.lower()
    assert "shell=True" not in local_server_src

    if os.name == "nt":
        popen_kwargs = {}
        lifecycle._apply_no_window_popen_defaults(popen_kwargs)
        assert popen_kwargs["creationflags"] & subprocess.CREATE_NO_WINDOW
        assert popen_kwargs["startupinfo"].wShowWindow == 0

        explicit_console = {"creationflags": subprocess.CREATE_NEW_CONSOLE}
        lifecycle._apply_no_window_popen_defaults(explicit_console)
        assert (explicit_console["creationflags"] & subprocess.CREATE_NO_WINDOW) == 0


verify_default_paths_and_guardrails()

# Isolate storage into a clean temp workspace before importing state / app
TMPDIR = tempfile.mkdtemp(prefix="sanctuary_p1_")
TMP_SANCTUARY = Path(TMPDIR) / "sanctuary"
TMP_PROGS = TMP_SANCTUARY / "core" / "programs"
TMP_VARS = TMP_SANCTUARY / "variables"
TMP_PROGS.mkdir(parents=True, exist_ok=True)
TMP_VARS.mkdir(parents=True, exist_ok=True)

for pid, pname, accent in (("sebile", "Sebile", "#85b9eb"), ("aria", "Aria", "#f472b6")):
    pdir = TMP_PROGS / pid
    (pdir / "sessions").mkdir(parents=True, exist_ok=True)
    (pdir / "portraits").mkdir(parents=True, exist_ok=True)
    card = {
        "spec": "chara_card_v3",
        "data": {
            "name": pname,
            "description": f"{pname} desc",
            "personality": "calm",
            "scenario": "sanctuary",
            "first_mes": f"Hello from {pname}.",
            "system_prompt": "",
            "post_history_instructions": "",
            "extensions": {
                "sanctuary": {
                    "program_id": pid,
                    "story_mode": False,
                    "image_details": {"positive": "", "negative": ""},
                }
            },
        },
    }
    (pdir / f"{pid}.json").write_text(json.dumps(card, indent=2), encoding="utf-8")
    (pdir / "theme.json").write_text(json.dumps({"primary_accent": accent}), encoding="utf-8")

legacy_settings = {
    "active_program": "aria",
    "active_session": "default",
    "active_user": "builder",
    "folders": [str(REPO_ROOT / "sanctuary" / "core" / "programs" / "sebile")],
}
(TMP_VARS / "project_settings.json").write_text(json.dumps(legacy_settings), encoding="utf-8")

vs.BASE_DIR = str(TMP_SANCTUARY)
vs.VARIABLES_DIR = str(TMP_VARS)
vs.PROGRAMS_DIR = str(TMP_PROGS)
rp.PARENT_DIR = str(TMP_SANCTUARY)
rp._settings_cache = None
rp._settings_mtime = 0.0
rr.project_root = TMP_SANCTUARY
rr.PROGRAMS_DIR = TMP_PROGS
cpc.PROGRAMS_DIR = str(TMP_PROGS)
cmi.PROGRAMS_DIR = str(TMP_PROGS)

import state as st
st.base_dir = TMP_SANCTUARY
st.project_root = Path(TMPDIR)
st.env_path = Path(TMPDIR) / ".env"
from utils import social_vault
social_vault.DATA_DIR = TMP_SANCTUARY / "data" / "social_vault"

import app as app_mod

os.environ.pop("AUTH_USER", None)
os.environ.pop("AUTH_PASS", None)


def run_tests():
    # Test _migrate_legacy_folders remaps <REPO_ROOT>/core/programs/... -> <PARENT_DIR>/core/programs/...
    stale_path = os.path.normpath(os.path.join(os.path.dirname(str(TMP_SANCTUARY)), "core", "programs", "aria"))
    os.makedirs(os.path.dirname(stale_path), exist_ok=True)
    migrated_cfg = {"folders": [stale_path]}
    # Ensure stale_path itself doesn't exist while TMP_PROGS / aria does
    assert not os.path.exists(stale_path)
    assert rp._migrate_legacy_folders(migrated_cfg) is True
    assert os.path.normpath(migrated_cfg["folders"][0]) == os.path.normpath(TMP_PROGS / "aria"), migrated_cfg

    # 1. Verify route registration parity
    rules = {rule.rule for rule in app_mod.app.url_map.iter_rules()}
    expected_routes = {
        "/",
        "/index.html",
        "/manifest.json",
        "/api/health",
        "/api/config",
        "/api/mobile/health",
        "/api/events/status",
        "/history",
        "/chat",
        "/edit",
        "/continue",
        "/delete",
        "/reset",
        "/pending_tool_call",
        "/api/session_tool_calls",
        "/approve_tool",
        "/api/cancel_chat",
        "/api/proactive_action",
        "/images/<path:filename>",
        "/programs/<program_id>/profile.png",
        "/regenerate_image",
        "/api/portrait/generate",
        "/api/animate_image",
        "/api/tts",
        "/api/voice_call/start",
        "/api/voice_call/save",
        "/api/programs",
        "/api/programs/select",
        "/api/programs/profile/save",
        "/api/programs/rename",
        "/api/programs/delete",
        "/api/programs/group_session/start",
        "/api/databank/files",
        "/api/lorebooks",
        "/api/quests",
        "/api/models/native/list",
        "/v1/chat/completions",
    }
    missing = expected_routes - rules
    assert not missing, f"Missing routes: {sorted(missing)}"

    client = app_mod.app.test_client()
    remote_http = client.get(
        "/api/mobile/health",
        environ_overrides={"REMOTE_ADDR": "192.168.1.25"},
    )
    assert remote_http.status_code == 426
    tailscale_http = client.get(
        "/api/mobile/health",
        environ_overrides={"REMOTE_ADDR": "100.64.0.25"},
    )
    assert tailscale_http.status_code != 426
    loopback_http = client.get(
        "/api/mobile/health",
        environ_overrides={"REMOTE_ADDR": "127.0.0.1"},
    )
    assert loopback_http.status_code != 426

    # 2. Pure-static web/ SPA routes contain zero Jinja tags and serve modular ES6 files
    r_index = client.get("/")
    assert r_index.status_code == 200
    body = r_index.data
    assert b"url_for(" not in body and b"{%" not in body
    assert b"./app/_layout.js" in body and b"./assets/css/shell.css" in body

    assert client.get("/manifest.json").status_code == 200
    assert client.get("/sw.js").status_code == 200
    assert client.get("/assets/css/shell.css").status_code == 200
    assert client.get("/assets/css/sanctuary.css").status_code == 200
    assert client.get("/app/_layout.js").status_code == 200
    assert client.get("/components/FediverseShareButton.js").status_code == 200
    assert client.get("/components/sanctuary/MessageRow.js").status_code == 200
    assert not (REPO_ROOT / "web" / "assets" / "vendor" / "sanctuary-legacy.js").exists()

    # 3. CORS allowlist & Tailscale CGNAT (100.64.0.0/10) check on OPTIONS & GET
    for allowed in (
        "capacitor://localhost",
        "http://localhost:8080",
        "http://192.168.1.25:5000",
        "http://100.100.10.5:5000",
    ):
        opt = client.options("/api/mobile/health", headers={"Origin": allowed})
        assert opt.status_code == 204
        assert opt.headers.get("Access-Control-Allow-Origin") == allowed
        assert opt.headers.get("Access-Control-Allow-Credentials") == "true"

        get_res = client.get("/api/mobile/health", headers={"Origin": allowed})
        assert get_res.status_code == 200
        assert get_res.headers.get("Access-Control-Allow-Origin") == allowed

    for disallowed in ("http://evil.example.com", "http://100.128.0.1:5000"):
        bad = client.get("/api/mobile/health", headers={"Origin": disallowed})
        assert "Access-Control-Allow-Origin" not in bad.headers, f"Unexpected CORS for {disallowed}"

    # 4. /api/config & <50ms /api/mobile/health + gpu_mode + idle thought cache
    cfg_res = client.get("/api/config")
    assert cfg_res.status_code == 200
    cfg = cfg_res.get_json()
    assert cfg["active_program"] == "aria"
    assert cfg["theme"]["primary_accent"] == "#f472b6"

    from adapters import vram_orchestrator
    vram_orchestrator._current_mode = "IMG"
    try:
        with mock.patch("requests.post") as m_post:
            m_post.return_value = mock.MagicMock(
                status_code=200,
                json=lambda: {"choices": [{"message": {"content": '{"content": "Quiet night in the Sanctuary."}'}}]},
            )
            with mock.patch.object(vram_orchestrator, "start_llm", return_value=True):
                p_res = client.post("/api/proactive_action", json={"session_id": "default", "model": "local-llm"})
                assert p_res.status_code == 200, p_res.get_data(as_text=True)

        t0 = time.perf_counter()
        mh = client.get("/api/mobile/health")
        elapsed_ms = (time.perf_counter() - t0) * 1000.0
        assert mh.status_code == 200
        mdata = mh.get_json()
        assert mdata["gpu_mode"] == "diffusion", mdata
        assert elapsed_ms < 50.0, f"/api/mobile/health took {elapsed_ms:.1f}ms"
        aria_entry = next(p for p in mdata["programs"] if p["id"] == "aria")
        assert aria_entry["accent_color"] == "#f472b6"
        assert aria_entry["idle_thought"] == "Quiet night in the Sanctuary."
    finally:
        vram_orchestrator._current_mode = None

    # 5. Blueprint parity checks: profile save, cancel_chat, voice_call/save, portrait/generate, edit_turn rollback
    runner = st.runner
    runner_id = id(runner)
    sid = "default"
    runner.mark_generating(sid)

    save_res = client.post(
        "/api/programs/profile/save",
        json={
            "program_id": "aria",
            "name": "Aria Prime",
            "description": "Updated",
            "personality": "sharp",
            "scenario": "sanctuary",
            "first_mes": "Welcome.",
            "system_prompt": "",
            "post_history_instructions": "",
            "extensions": {"sanctuary": {"program_id": "aria", "story_mode": False}},
        },
    )
    assert save_res.status_code == 200
    assert save_res.get_json()["character_name"] == "Aria Prime"
    assert id(st.runner) == runner_id

    # Seed turn then simulate edit_turn failure to verify transactional rollback via Blueprint stack
    asyncio.run(runner.append_message_to_session(sid, "user", "Hi Aria", msg_id="usr_seed_1"))
    asyncio.run(
        runner.append_message_to_session(
            sid, "program", "Hello!", msg_id="prgm_seed_1", sender_id="aria", sender_name="Aria Prime"
        )
    )
    expected_before_ids = [m["id"] for m in runner.sessions_history[sid]]
    assert expected_before_ids[-2:] == ["usr_seed_1", "prgm_seed_1"], expected_before_ids

    async def fail_loop(self, *a, **kw):
        raise asyncio.CancelledError()

    with mock.patch.object(rr.OpenSourceRunner, "_execute_local_llm_loop", new=fail_loop), \
         mock.patch.object(rr, "_get_databank_contexts", return_value=("", None)):
        try:
            asyncio.run(runner.edit_turn(sid, "usr_seed_1", "Broken edit"))
            raise AssertionError("Expected CancelledError")
        except asyncio.CancelledError:
            pass

    assert [m["id"] for m in runner.sessions_history[sid]] == expected_before_ids

    cancel_res = client.post("/api/cancel_chat", json={"session_id": sid})
    assert cancel_res.status_code == 200
    assert sid not in st.runner.generating_sessions

    vc_res = client.post(
        "/api/voice_call/save",
        json={"session_id": sid, "transcript": json.dumps({"duration": "8s", "turns": []})},
    )
    assert vc_res.status_code == 200
    assert vc_res.get_json()["message"]["id"].startswith("voice_")

    import tools.tools as tools_mod

    seen_generating = []
    seen_counts = []

    def fake_portrait(*a, **kw):
        seen_generating.append(sid in st.runner.generating_sessions)
        seen_counts.append(kw.get("count"))
        return "![Portrait](/images/portraits/test.png)"

    with mock.patch("routes.media.extract_portrait_tags_from_context", return_value="1girl"), \
         mock.patch.object(tools_mod, "generate_local_image", side_effect=fake_portrait), \
         mock.patch.object(st, "broadcast_media_change", return_value=None):
        p_res = client.post(
            "/api/portrait/generate",
            json={
                "session_id": sid,
                "speaker_id": "aria",
                "prompt": "test",
                "count": 1,
                "stream": False,
                "msg_id": "prgm_client_456",
            },
        )
        p_default_res = client.post(
            "/api/portrait/generate",
            json={
                "session_id": sid,
                "speaker_id": "aria",
                "prompt": "test two up",
                "stream": False,
                "msg_id": "prgm_client_457",
            },
        )
    assert p_res.status_code == 200
    assert p_default_res.status_code == 200
    assert seen_generating == [True, True]
    assert seen_counts == [1, 2]
    assert p_res.get_json()["program_msg_id"] == "prgm_client_456"
    assert sid not in st.runner.generating_sessions

    # Session conversation CRUD endpoints (/api/sessions, /create, /rename, /delete)
    create_sess_res = client.post("/api/sessions/create", json={"program_id": "aria", "title": "Dialectic Notes"})
    assert create_sess_res.status_code == 200
    created_sess = create_sess_res.get_json()["session"]
    created_sid = created_sess["id"]
    assert created_sess["title"] == "Dialectic Notes"

    rename_sess_res = client.post(
        "/api/sessions/rename",
        json={"program_id": "aria", "session_id": created_sid, "title": "Renamed Notes"},
    )
    assert rename_sess_res.status_code == 200

    list_sess_res = client.get("/api/sessions?program_id=aria")
    assert list_sess_res.status_code == 200
    sess_entries = list_sess_res.get_json()["sessions"]
    assert any(s["id"] == created_sid and s["title"] == "Renamed Notes" for s in sess_entries)

    progs_res = client.get("/api/programs")
    assert progs_res.status_code == 200
    assert "personality" in progs_res.get_json()["programs"][0]

    del_sess_res = client.post("/api/sessions/delete", json={"program_id": "aria", "session_id": created_sid})
    assert del_sess_res.status_code == 200
    list_after_del = client.get("/api/sessions?program_id=aria").get_json()["sessions"]
    assert all(s["id"] != created_sid for s in list_after_del)

    # Shared-post card metadata + clean user_note survive /chat -> /history -> /api/sessions
    async def fake_run_async(session_id, new_message_text, *a, **kw):
        await runner.append_message_to_session(session_id, "user", new_message_text, msg_id=kw.get("msg_id") or "usr_sp_1")
        await runner.append_message_to_session(
            session_id, "program", "Looks peaceful.", msg_id="prgm_sp_1", sender_id="aria", sender_name="Aria Prime"
        )
        return "Looks peaceful.", [], (kw.get("msg_id") or "usr_sp_1"), "prgm_sp_1"

    sp_payload = {
        "session_id": sid,
        "msg_id": "usr_sp_1",
        "message": "[Shared post by Charlie]\nRelaxing day",
        "shared_post": {
            "authorName": "Charlie",
            "authorHandle": "@charlie@mastodon.social",
            "text": "Relaxing day",
            "mediaUrl": "https://mastodon.social/media/1.png",
            "url": "https://mastodon.social/@charlie/1",
            "network": "fediverse",
        },
        "user_note": "Mood check",
    }
    with mock.patch.object(st.runner, "run_async", side_effect=fake_run_async), \
         mock.patch.object(st, "build_generation_response", return_value=({"status": "ok"}, 200)):
        sp_chat_res = client.post("/chat", json=sp_payload)
    assert sp_chat_res.status_code == 200

    hist_res = client.get(f"/history?session_id={sid}")
    assert hist_res.status_code == 200
    sp_hist_item = next(m for m in hist_res.get_json()["history"] if m["id"] == "usr_sp_1")
    assert sp_hist_item["shared_post"]["authorName"] == "Charlie"
    assert sp_hist_item["user_note"] == "Mood check"

    # Rerolling the program reply via /edit preserves shared_post and user_note on the user message
    async def fake_reroll_llm_loop(*a, **kw):
        runner._upsert_history_message(
            sid,
            {
                "id": "prgm_sp_2",
                "role": "program",
                "text": "Still peaceful!",
                "sender_id": "aria",
                "sender_name": "Aria Prime",
                "timestamp": time.time(),
            },
        )
        return "Still peaceful!", [], "prgm_sp_2"

    with mock.patch.object(st.runner, "_execute_local_llm_loop", side_effect=fake_reroll_llm_loop), \
         mock.patch.object(st, "build_generation_response", return_value=({"status": "ok"}, 200)):
        reroll_res = client.post("/edit", json={"session_id": sid, "msg_id": "prgm_sp_1", "new_text": None})
    assert reroll_res.status_code == 200
    hist_after_reroll = client.get(f"/history?session_id={sid}").get_json()["history"]
    sp_after_reroll = next(m for m in hist_after_reroll if m["id"] == "usr_sp_1")
    assert sp_after_reroll["shared_post"]["authorName"] == "Charlie"
    assert sp_after_reroll["user_note"] == "Mood check"

    # Unapproved feed tuning skill/tool & declarative /api/feed_profile sync
    fp_get = client.get("/api/feed_profile")
    assert fp_get.status_code == 200
    fp_get_json = fp_get.get_json()
    assert fp_get_json["version"] == 2
    assert "sliders" not in fp_get_json
    assert fp_get_json["discoveryChannels"] == []
    assert fp_get_json["discoveryInstances"] == []

    with mock.patch.object(tools_mod, "confirm_tool_execution", side_effect=AssertionError("Should never require approval")):
        tool_out = tools_mod.tune_feed_algorithm(
            add_discovery_channels=[
                "cooperatives",
                "at://did:plc:abc123/app.bsky.feed.generator/for-science",
            ],
            add_discovery_instances=["https://kolektiva.social/", "fosstodon.org"],
        )
    assert "[Feed Profile Updated]" in tool_out

    fp_after_tool = client.get("/api/feed_profile").get_json()
    assert "sliders" not in fp_after_tool
    assert fp_after_tool["discoveryChannels"] == [
        "cooperatives",
        "at://did:plc:abc123/app.bsky.feed.generator/for-science",
    ]
    assert fp_after_tool["discoveryInstances"] == ["kolektiva.social", "fosstodon.org"]
    assert fp_after_tool["updatedAt"] > 0

    mh_after_tune = client.get("/api/mobile/health").get_json()
    assert mh_after_tune["feed_profile_updated_at"] == fp_after_tool["updatedAt"]

    fp_put = client.put(
        "/api/feed_profile",
        json={
            "discoveryChannels": ["mutual aid", "#woodworking"],
            "discoveryInstances": ["https://hachyderm.io/", "fosstodon.org"],
        },
    )
    assert fp_put.status_code == 200
    fp_put_json = fp_put.get_json()
    assert fp_put_json["discoveryChannels"] == ["mutual aid", "#woodworking"]
    assert fp_put_json["discoveryInstances"] == ["hachyderm.io", "fosstodon.org"]

    tool_rm = tools_mod.tune_feed_algorithm(remove_sources=["#woodworking", "hachyderm.io"])
    assert "[Feed Profile Updated]" in tool_rm
    fp_after_rm = client.get("/api/feed_profile").get_json()
    assert fp_after_rm["discoveryChannels"] == ["mutual aid"]
    assert fp_after_rm["discoveryInstances"] == ["fosstodon.org"]

    tool_reset = tools_mod.tune_feed_algorithm(action="reset")
    assert "[Feed Profile Updated]" in tool_reset
    fp_reset = client.get("/api/feed_profile").get_json()
    assert fp_reset["discoveryChannels"] == []
    assert fp_reset["discoveryInstances"] == []

    flt_put = client.put(
        "/api/social/accounts/filters",
        json={
            "filters": [
                {"id": "f1", "title": "Ukraine", "phrase": "Ukraine", "filter_action": "hide"},
                {"id": "f2", "title": "Topics", "keywords": ["AI", "Crypto"], "filter_action": "warn"},
            ]
        },
    )
    assert flt_put.status_code == 200
    assert len(flt_put.get_json()["filters"]) == 2
    flt_get = client.get("/api/social/accounts/filters").get_json()
    assert flt_get["filters"][0]["phrase"] == "Ukraine"
    assert flt_get["filters"][1]["keywords"] == ["AI", "Crypto"]

    # New programs without a portrait return the Profile-tab user SVG icon instead of 404
    default_avatar_res = client.get("/programs/aria/profile.png")
    assert default_avatar_res.status_code == 200
    assert default_avatar_res.mimetype == "image/svg+xml"
    assert '<circle cx="12" cy="7" r="4">' in default_avatar_res.get_data(as_text=True)

    # Confirm zero remaining webbrowser.open calls across sanctuary/ and web/
    for scan_dir in (SANCTUARY_DIR, REPO_ROOT / "web"):
        for fpath in scan_dir.rglob("*"):
            if fpath.suffix in (".py", ".js") and fpath.is_file():
                assert "webbrowser.open" not in fpath.read_text(encoding="utf-8", errors="ignore"), fpath

    # Sebile has zero gatekeeper restrictions: any user can edit, recolor, rename, and delete Sebile
    seb_save = client.post(
        "/api/programs/profile/save",
        json={"program_id": "sebile", "name": "Sebile", "personality": "unrestricted"},
    )
    assert seb_save.status_code == 200
    seb_pal = client.post("/api/programs/palette", json={"program_id": "sebile", "color": "#10b981"})
    assert seb_pal.status_code == 200
    seb_ren = client.post("/api/programs/rename", json={"program_id": "sebile", "new_name": "Sebile Unbound"})
    assert seb_ren.status_code == 200
    assert seb_ren.get_json()["new_id"] == "sebileunbound"
    assert (TMP_PROGS / "sebileunbound" / "sebileunbound.json").is_file()
    seb_del = client.post("/api/programs/delete", json={"program_id": "sebileunbound"})
    assert seb_del.status_code == 200
    assert not (TMP_PROGS / "sebileunbound").exists()

    # Also verify deleting 'sebile' directly when created/active cleanly switches to remaining program ('aria')
    (TMP_PROGS / "sebile" / "sessions").mkdir(parents=True, exist_ok=True)
    (TMP_PROGS / "sebile" / "sebile.json").write_text(
        json.dumps({"spec": "chara_card_v3", "data": {"name": "Sebile", "extensions": {"sanctuary": {"program_id": "sebile"}}}}),
        encoding="utf-8",
    )
    assert client.post("/api/programs/select", json={"program_id": "sebile"}).status_code == 200
    direct_del = client.post("/api/programs/delete", json={"program_id": "sebile"})
    assert direct_del.status_code == 200
    assert direct_del.get_json()["switched_to"] == "aria"
    assert not (TMP_PROGS / "sebile").exists()
    # Cleanly ensure 'aria' deletion down to 0 programs does not fabricate a phantom 'sebile' directory
    last_del = client.post("/api/programs/delete", json={"program_id": "aria"})
    assert last_del.status_code == 200
    assert last_del.get_json()["switched_to"] is None
    assert not (TMP_PROGS / "sebile").exists()

    # Recent social posts: sort newest-first, render clock times, stay in load_user_instructions (not load_dynamic_runtime_context)
    import datetime as dt_mod
    from routes.programs import _normalize_recent_social_posts
    cpc.USER_PROFILES_DIR = str(TMP_VARS / "user_profiles")
    os.makedirs(cpc.USER_PROFILES_DIR, exist_ok=True)
    now_utc = dt_mod.datetime.now(dt_mod.timezone.utc)
    older_iso = (now_utc - dt_mod.timedelta(hours=7)).strftime("%Y-%m-%dT%H:%M:%SZ")
    newer_iso = (now_utc - dt_mod.timedelta(minutes=10)).strftime("%Y-%m-%dT%H:%M:%SZ")
    stale_iso = (now_utc - dt_mod.timedelta(hours=80)).strftime("%Y-%m-%dT%H:%M:%SZ")
    normalized_posts = _normalize_recent_social_posts([
        {"text": "Pinned older post from morning", "created_at": older_iso},
        {"text": "Brand new post from 10m ago", "created_at": newer_iso},
    ])
    assert normalized_posts[0]["text"] == "Brand new post from 10m ago"
    assert normalized_posts[1]["text"] == "Pinned older post from morning"

    (Path(cpc.USER_PROFILES_DIR) / "builder_recent_posts.json").write_text(
        json.dumps([
            {"text": "Too old stale post", "created_at": stale_iso},
            {"text": "Morning post 7h ago", "created_at": older_iso},
            {"text": "Newest post 10m ago", "created_at": newer_iso},
        ]),
        encoding="utf-8",
    )
    user_inst = cpc.load_user_instructions()
    dyn_ctx = cpc.load_dynamic_runtime_context()
    assert "### USER'S RECENT PUBLIC POSTS (Passive Background Only)" in user_inst
    assert "### USER'S RECENT" not in dyn_ctx
    assert "Too old stale post" not in user_inst
    pos_new = user_inst.find("Newest post 10m ago")
    pos_old = user_inst.find("Morning post 7h ago")
    assert 0 < pos_new < pos_old
    assert ("AM]" in user_inst or "PM]" in user_inst)

    print(f"PHASE_1_BACKEND_VERIFIED (mobile/health={elapsed_ms:.1f}ms, routes={len(rules)})")


if __name__ == "__main__":
    try:
        run_tests()
    finally:
        shutil.rmtree(TMPDIR, ignore_errors=True)
