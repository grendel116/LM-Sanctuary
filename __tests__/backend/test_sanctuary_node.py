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

    def fake_portrait(*a, **kw):
        seen_generating.append(sid in st.runner.generating_sessions)
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
    assert p_res.status_code == 200
    assert seen_generating == [True]
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

    # Unapproved feed tuning skill/tool & declarative /api/feed_profile sync
    fp_get = client.get("/api/feed_profile")
    assert fp_get.status_code == 200
    assert fp_get.get_json()["sliders"]["commercial"] == 0

    with mock.patch.object(tools_mod, "confirm_tool_execution", side_effect=AssertionError("Should never require approval")):
        tool_out = tools_mod.tune_feed_algorithm(
            commercial=-100,
            bourgeois_politics=-100,
            mature_content=-80,
            small_web=70,
            add_boost_concepts=["worker cooperatives", "Linux audio"],
            add_dampen_concepts=["crypto hype"],
        )
    assert "[Feed Profile Updated]" in tool_out

    fp_after_tool = client.get("/api/feed_profile").get_json()
    assert fp_after_tool["sliders"]["commercial"] == -100
    assert fp_after_tool["sliders"]["bourgeoisPolitics"] == -100
    assert fp_after_tool["sliders"]["matureContent"] == -80
    assert fp_after_tool["sliders"]["smallWeb"] == 70
    assert fp_after_tool["boostConcepts"] == ["worker cooperatives", "Linux audio"]
    assert fp_after_tool["dampenConcepts"] == ["crypto hype"]
    assert fp_after_tool["updatedAt"] > 0

    mh_after_tune = client.get("/api/mobile/health").get_json()
    assert mh_after_tune["feed_profile_updated_at"] == fp_after_tool["updatedAt"]

    fp_put = client.put(
        "/api/feed_profile",
        json={
            "sliders": {"longform": 65, "commercial": -50},
            "boostConcepts": ["botanical art"],
            "dampenConcepts": [],
            "discoveryChannels": ["cooperatives", "mutual aid"],
            "discoveryInstances": ["https://kolektiva.social/", "fosstodon.org"],
        },
    )
    assert fp_put.status_code == 200
    fp_put_json = fp_put.get_json()
    assert fp_put_json["sliders"]["longform"] == 65
    assert fp_put_json["discoveryChannels"] == ["cooperatives", "mutual aid"]
    assert fp_put_json["discoveryInstances"] == ["kolektiva.social", "fosstodon.org"]

    tool_sanctuary = tools_mod.tune_feed_algorithm(
        preset="sanctuary",
        add_discovery_channels=["class struggle"],
        add_discovery_instances=["merveilles.town"],
    )
    assert "[Feed Profile Updated]" in tool_sanctuary
    fp_sanctuary = client.get("/api/feed_profile").get_json()
    assert fp_sanctuary["sliders"]["smallWeb"] == 80
    assert "class struggle" in fp_sanctuary["discoveryChannels"]
    assert "merveilles.town" in fp_sanctuary["discoveryInstances"]

    print(f"PHASE_1_BACKEND_VERIFIED (mobile/health={elapsed_ms:.1f}ms, routes={len(rules)})")


if __name__ == "__main__":
    try:
        run_tests()
    finally:
        shutil.rmtree(TMPDIR, ignore_errors=True)
