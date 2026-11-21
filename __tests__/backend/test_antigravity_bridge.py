"""Backend verification for the Antigravity coding bridge, purged local tools, and program GEMINI.md."""

from __future__ import annotations

import asyncio
import contextvars
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"

import dotenv

dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

from google.antigravity import types
from google.antigravity.hooks import hook_runner, hooks, policy

import core.program_config as cpc
import core.skill_retriever as sr
import runners.program as rp
import tools.antigravity_job as agj
import tools.tools as tools_mod
import utils.utils as utils_mod
import variables.settings as vs


def test_antigravity_bridge():
    # 1. Impotent local coding modules and tools must be completely removed
    for removed_file in (
        SANCTUARY_DIR / "tools" / "codejob.py",
        SANCTUARY_DIR / "tools" / "codenav.py",
        SANCTUARY_DIR / "tools" / "codefacts.py",
        SANCTUARY_DIR / "tools" / "symbolgraph.py",
        SANCTUARY_DIR / "data" / "symbol_graph.json",
    ):
        assert not removed_file.exists(), f"Removed file still exists: {removed_file}"

    removed_tools = (
        "read_file",
        "write_file",
        "replace_in_file",
        "replace_file_content",
        "multi_replace_file_content",
        "run_shell_command",
        "run_command_async",
        "manage_task",
        "wait_task",
        "get_workspace_structure",
        "find_files",
        "search_codebase",
        "outline_file",
        "read_symbol",
        "find_references",
        "review_code",
    )
    for tool_name in removed_tools:
        assert not hasattr(tools_mod, tool_name), f"Impotent tool still exposed: {tool_name}"

    assert callable(getattr(tools_mod, "delegate_coding", None)), "delegate_coding missing from tools.tools"

    # 2. Skill retriever exposes delegate_coding in Toolbelt and Vector instructions
    sr._skill_cache = None
    sr._skill_mtime = 0.0
    toolbelt = sr.get_toolbelt_block(story_active=False)
    assert "delegate_coding" in toolbelt
    assert "review_code" not in toolbelt
    assert "replace_file_content" not in toolbelt

    skill_prompt = sr.retrieve_skill_instructions("refactor the python codebase and run tests")
    assert "delegate_coding" in skill_prompt
    assert "Orchestrator (Neon)" in skill_prompt

    # 3. Emulated tool call parsing handles aliases, Windows paths, and multiline task strings
    assert utils_mod._normalize_tool_name("antigravity_code") == "delegate_coding"
    assert utils_mod._normalize_tool_name("code_with_antigravity") == "delegate_coding"
    assert utils_mod._normalize_tool_name("run_coding_task") == "delegate_coding"

    parsed = utils_mod._parse_emulated_tool_call(
        "delegate_coding",
        r'request="Fix bug in ranker\nAdd unit tests", cwd="C:\LLM\LM-Sanctuary", model="Orchestrator (Argon)", resume=False',
    )
    assert parsed["kwargs"]["task"] == "Fix bug in ranker\nAdd unit tests", parsed
    assert parsed["kwargs"]["path"] == "C:/LLM/LM-Sanctuary", parsed
    assert parsed["kwargs"]["model"] == "Orchestrator (Argon)", parsed
    assert parsed["kwargs"]["resume"] is False, parsed

    pos_parsed = utils_mod._parse_emulated_tool_call(
        "delegate_coding",
        r'"Fix newline\nwithout corrupting it"',
    )
    assert pos_parsed["args"] == ["Fix newline\nwithout corrupting it"], pos_parsed

    # 4. Model resolution defaults to Orchestrator (Neon) and honors aliases/env
    with mock.patch.dict(os.environ, {}, clear=False):
        os.environ.pop("ANTIGRAVITY_MODEL", None)
        assert agj.resolve_antigravity_model() == ("gemini-4-neon", "Orchestrator (Neon)")
        assert agj.resolve_antigravity_model("models/gemini-4-neon") == ("gemini-4-neon", "Orchestrator (Neon)")
        assert agj.resolve_antigravity_model("Orchestrator (Argon)") == (
            "gemini-4-argon",
            "Orchestrator (Argon)",
        )
        assert agj.resolve_antigravity_model("carbon") == ("gemini-4-carbon", "Orchestrator (Carbon)")
        assert agj.resolve_antigravity_model("flash") == ("gemini-3.8-flash", "Gemini 3.8 Flash")
        assert agj.resolve_antigravity_model("flash_lite") == ("gemini-3.5-flash-lite", "Gemini 3.5 Flash Lite")

        os.environ["ANTIGRAVITY_MODEL"] = "Orchestrator (Argon)"
        assert agj.resolve_antigravity_model() == ("gemini-4-argon", "Orchestrator (Argon)")
        assert agj.resolve_antigravity_model("neon") == ("gemini-4-neon", "Orchestrator (Neon)")

    # Isolate filesystem paths for GEMINI.md compilation & Antigravity pipeline tests
    tmpdir = Path(tempfile.mkdtemp(prefix="sanctuary_ag_test_"))
    orig_vs_vars = vs.VARIABLES_DIR
    orig_vs_progs = vs.PROGRAMS_DIR
    orig_cpc_progs = cpc.PROGRAMS_DIR
    orig_cpc_user_profiles = cpc.USER_PROFILES_DIR
    orig_rp_parent = rp.PARENT_DIR
    orig_tools_root = tools_mod.root_dir
    orig_settings_cache = rp._settings_cache
    orig_settings_mtime = rp._settings_mtime

    try:
        tmp_sanctuary = tmpdir / "sanctuary"
        tmp_vars = tmp_sanctuary / "variables"
        tmp_progs = tmp_sanctuary / "core" / "programs"
        tmp_profiles = tmp_vars / "user_profiles"
        tmp_ws = tmpdir / "workspace"
        tmp_sebile = tmp_progs / "sebile"
        tmp_progs.mkdir(parents=True, exist_ok=True)
        tmp_profiles.mkdir(parents=True, exist_ok=True)
        tmp_ws.mkdir(parents=True, exist_ok=True)
        tmp_sebile.mkdir(parents=True, exist_ok=True)

        shutil.copy2(SANCTUARY_DIR / "core" / "programs" / "sebile" / "sebile.json", tmp_sebile / "sebile.json")
        (tmp_profiles / "davy.md").write_text("# USER CONTEXT: Davy\n- Software builder in Seattle.\n", encoding="utf-8")

        settings_path = tmp_vars / "project_settings.json"
        settings_path.write_text(
            json.dumps(
                {
                    "active_program": "sebile",
                    "active_user": "davy",
                    "folders": [str(tmp_sebile), str(tmp_ws)],
                    "security_preset": "auto",
                    "artifact_review_policy": "auto_approve",
                }
            ),
            encoding="utf-8",
        )

        vs.VARIABLES_DIR = str(tmp_vars)
        vs.PROGRAMS_DIR = str(tmp_progs)
        cpc.PROGRAMS_DIR = str(tmp_progs)
        cpc.USER_PROFILES_DIR = str(tmp_profiles)
        rp.PARENT_DIR = str(tmp_sanctuary)
        tools_mod.root_dir = str(tmp_sanctuary)
        rp._settings_cache = None
        rp._settings_mtime = 0.0

        # 5. Program-specific GEMINI.md compilation (global + fallback)
        compiled_live = cpc.compile_program_gemini_md("sebile")
        assert "Directives of Dialectical Sources & Clean Architecture" in compiled_live
        assert "Root Code Focus" in compiled_live
        assert "# PROGRAM ETHOS & CHARACTER: Sebile" in compiled_live
        assert "# DELEGATION CONTRACT" in compiled_live
        assert "Sebile" in compiled_live
        assert "Davy" in compiled_live
        assert (tmp_sebile / "GEMINI.md").is_file()

        with mock.patch("os.path.expanduser", return_value=str(tmpdir / "empty_home")):
            compiled_fallback = cpc.compile_program_gemini_md("sebile")
            assert "Root Code Focus" in compiled_fallback
            assert "Rejection of Capitalist Logic and Churn" in compiled_fallback
            assert "Affirmative Directives and Simplicity" in compiled_fallback

        # 6. End-to-end delegate_coding under AUTO mode
        captured_configs = []
        decide_calls = []

        def fake_httpx_post(url, json=None, headers=None, timeout=None):
            user_prompt = json["messages"][1]["content"]
            decide_calls.append(user_prompt)
            if "AVAILABLE OPTIONS" in user_prompt:
                content = '{"decision": "Use SQLite for persistence", "selected_option": "sqlite", "rationale": "Zero external dependencies.", "needs_continuation": true}'
            else:
                content = '{"decision": "Yes, run pytest on the new module now.", "selected_option": "", "rationale": "Verification is required before reporting.", "needs_continuation": true}'
            return SimpleNamespace(
                status_code=200,
                json=lambda: {"choices": [{"message": {"content": content}}]},
            )

        class FakeResponse:
            def __init__(self, text_val: str):
                self._text = text_val
                self.stop_reason = types.StopReason.UNSPECIFIED

            async def text(self) -> str:
                return self._text

        class FakeAgent:
            def __init__(self, config):
                captured_configs.append(config)
                self.config = config
                self.conversation_id = "11111111-2222-3333-4444-555555555555"

            async def __aenter__(self):
                return self

            async def __aexit__(self, exc_type, exc, tb):
                return False

            async def chat(self, prompt: str):
                hr = hook_runner.HookRunner(hooks=self.config.hooks)
                turn_ctx = hooks.TurnContext(hooks.SessionContext())
                op_ctx = hooks.OperationContext(turn_ctx)

                # Simulate pre/post tool calls for edit_file & run_command
                tc_edit = types.ToolCall(
                    id="tc_1",
                    name="edit_file",
                    args={"TargetFile": str(tmp_ws / "module.py")},
                    canonical_path=str(tmp_ws / "module.py"),
                )
                dec_res, _, _ = await hr.dispatch_pre_tool_call(turn_ctx, tc_edit)
                assert dec_res.allow is True
                await hr.dispatch_post_tool_call(
                    op_ctx,
                    types.ToolResult(id="tc_1", name="edit_file", result="edited"),
                )

                tc_cmd = types.ToolCall(
                    id="tc_2",
                    name="run_command",
                    args={"CommandLine": "pytest -q"},
                )
                dec_cmd, _, _ = await hr.dispatch_pre_tool_call(turn_ctx, tc_cmd)
                assert dec_cmd.allow is True
                await hr.dispatch_post_tool_call(
                    op_ctx,
                    types.ToolResult(id="tc_2", name="run_command", result="1 passed"),
                )

                # Simulate ask_question handled by Sebile
                spec = types.AskQuestionInteractionSpec(
                    questions=[
                        types.AskQuestionEntry(
                            question="Which storage backend should we use?",
                            options=[
                                types.AskQuestionOption(id="json", text="Plain JSON"),
                                types.AskQuestionOption(id="sqlite", text="SQLite"),
                            ],
                        )
                    ]
                )
                _, q_resp, _ = await hr.dispatch_interaction(turn_ctx, spec)
                assert q_resp.responses[0].selected_option_ids == ["sqlite"], q_resp

                # Simulate stop hook intercepting a clarifying question
                stop_res = await hr.dispatch_stop(
                    turn_ctx,
                    types.StopArgs(
                        response_text="Should I run pytest now?",
                        trajectory_id="traj_1",
                        continuation_count=0,
                        stop_reason=types.StopReason.UNSPECIFIED,
                    ),
                )
                assert stop_res.decision == types.StopDecision.CONTINUE
                assert "pytest" in stop_res.reason.lower()

                return FakeResponse("Refactored module.py to use SQLite and ran pytest (1 passed).")

        tools_mod.session_tool_calls.clear()
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False), \
             mock.patch.object(agj, "Agent", FakeAgent), \
             mock.patch("httpx.post", side_effect=fake_httpx_post), \
             mock.patch("tools.tools.confirm_tool_execution", side_effect=AssertionError("Auto mode must not prompt user")):
            digest1 = tools_mod.delegate_coding(task="Refactor storage to SQLite", path=str(tmp_ws))

        assert "Model: Orchestrator (Neon) (gemini-4-neon)" in digest1, digest1
        assert "Conversation ID: 11111111-2222-3333-4444-555555555555" in digest1, digest1
        assert str(tmp_ws / "module.py") in digest1, digest1
        assert "`pytest -q` (ok)" in digest1, digest1
        assert "Decisions Made:" in digest1, digest1
        assert "sqlite" in digest1, digest1
        assert "Refactored module.py to use SQLite" in digest1, digest1
        assert len(decide_calls) == 2

        live_calls = tools_mod.session_tool_calls.get("default", [])
        assert any(c["name"] == "antigravity:edit_file" and c["status"] == "completed" for c in live_calls), live_calls
        assert any(c["name"] == "antigravity:run_command" and c["status"] == "completed" for c in live_calls), live_calls

        cfg1 = captured_configs[-1]
        assert cfg1.model == "gemini-4-neon"
        assert cfg1.workspaces == [str(tmp_ws.resolve())]
        assert any(p.name == "allow_all" for p in cfg1.policies)
        assert any(p.name == policy.WORKSPACE_ONLY_POLICY_NAME for p in cfg1.policies)
        assert cfg1.conversation_id is None

        # Second call with resume=True must pass persisted conversation_id
        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False), \
             mock.patch.object(agj, "Agent", FakeAgent), \
             mock.patch("httpx.post", side_effect=fake_httpx_post):
            digest2 = tools_mod.delegate_coding(task="Add index to table", path=str(tmp_ws), resume=True)

        assert "Conversation ID: 11111111-2222-3333-4444-555555555555" in digest2, digest2
        cfg2 = captured_configs[-1]
        assert cfg2.conversation_id == "11111111-2222-3333-4444-555555555555", cfg2.conversation_id
        assert cfg2.session_continuation_mode == types.SessionContinuationMode.CREATE_OR_RESUME

        # 7. Project Settings ask_always mode routes command/edit policies & decisions through confirm_tool_execution
        settings_path.write_text(
            json.dumps(
                {
                    "active_program": "sebile",
                    "active_user": "davy",
                    "folders": [str(tmp_sebile), str(tmp_ws)],
                    "security_preset": "ask_always",
                    "artifact_review_policy": "ask_always",
                }
            ),
            encoding="utf-8",
        )
        rp._settings_cache = None
        rp._settings_mtime = 0.0

        confirm_prompts = []

        def fake_confirm(tool_name: str, details: str) -> bool:
            confirm_prompts.append((tool_name, details))
            return True

        class AskModeFakeAgent(FakeAgent):
            async def chat(self, prompt: str):
                hr = hook_runner.HookRunner(
                    hooks=[policy.enforce(self.config.policies), *self.config.hooks]
                )
                turn_ctx = hooks.TurnContext(hooks.SessionContext())
                res_cmd, _, _ = await hr.dispatch_pre_tool_call(
                    turn_ctx,
                    types.ToolCall(id="tc_ask", name="run_command", args={"CommandLine": "pytest"}),
                )
                assert res_cmd.allow is True

                spec = types.AskQuestionInteractionSpec(
                    questions=[
                        types.AskQuestionEntry(
                            question="Proceed with migration?",
                            options=[types.AskQuestionOption(id="yes", text="Yes")],
                        )
                    ]
                )
                _, q_resp, _ = await hr.dispatch_interaction(turn_ctx, spec)
                assert q_resp.responses[0].selected_option_ids == ["yes"]
                return FakeResponse("Completed under ask_always approval.")

        with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False), \
             mock.patch.object(agj, "Agent", AskModeFakeAgent), \
             mock.patch("httpx.post", side_effect=fake_httpx_post), \
             mock.patch("tools.tools.confirm_tool_execution", side_effect=fake_confirm):
            digest_ask = tools_mod.delegate_coding(task="Run migration", path=str(tmp_ws), resume=False)

        assert "Completed under ask_always approval." in digest_ask
        assert any(name == "antigravity:run_command" for name, _ in confirm_prompts), confirm_prompts
        assert any(name == "antigravity_decision" for name, _ in confirm_prompts), confirm_prompts

        # 8. Project Settings gemini_api_key persists via /api/project_settings & works without .env key
        import state as st
        import app as app_mod

        orig_st_base = st.base_dir
        orig_vs_base = vs.BASE_DIR
        try:
            vs.BASE_DIR = str(tmp_sanctuary)
            st.base_dir = tmp_sanctuary
            client = app_mod.app.test_client()

            with mock.patch.dict(os.environ, {}, clear=False):
                os.environ.pop("GEMINI_API_KEY", None)
                os.environ.pop("GOOGLE_GENAI_USE_VERTEXAI", None)
                os.environ.pop("GOOGLE_GENAI_USE_ENTERPRISE", None)

                # Missing in both Project Settings and env returns actionable setup error
                err_out = tools_mod.delegate_coding(task="Check auth handling", path=str(tmp_ws))
                assert "Project Settings" in err_out and "GEMINI_API_KEY" in err_out

                # Save key via /api/project_settings and verify delegate_coding passes it without env key
                post_res = client.post(
                    "/api/project_settings",
                    json={
                        "folders": [str(tmp_sebile), str(tmp_ws)],
                        "security_preset": "auto",
                        "artifact_review_policy": "auto_approve",
                        "gemini_api_key": "AIza_from_project_settings",
                    },
                )
                assert post_res.status_code == 200
                assert post_res.get_json()["settings"]["gemini_api_key"] == "AIza_from_project_settings"
                assert client.get("/api/project_settings").get_json()["gemini_api_key"] == "AIza_from_project_settings"

                os.environ.pop("GEMINI_API_KEY", None)
                with mock.patch.object(agj, "Agent", FakeAgent), \
                     mock.patch("httpx.post", side_effect=fake_httpx_post), \
                     mock.patch("tools.tools.confirm_tool_execution", return_value=True):
                    digest_cfg_key = tools_mod.delegate_coding(
                        task="Run with Project Settings API key",
                        path=str(tmp_ws),
                        resume=False,
                    )
                assert "Orchestrator (Neon)" in digest_cfg_key
                assert captured_configs[-1].api_key == "AIza_from_project_settings"

            # 9. Cancellation stops active Antigravity jobs, real OS process trees, and blocked HITL confirmations
            import psutil
            import runners.runner as rr

            orig_rr_root = rr.project_root
            orig_rr_progs = rr.PROGRAMS_DIR
            orig_runner_prog = st.runner.program_id
            try:
                rr.project_root = tmp_sanctuary
                rr.PROGRAMS_DIR = tmp_progs
                st.runner.program_id = "sebile"
                st._cached_active_program = "sebile"

                # 9a. Cooperative response.cancel() + edit_turn rollback via /api/cancel_chat
                sid_coop = "ag_cancel_coop"
                st.cancelled_sessions.discard(sid_coop)
                st.runner.sessions_history[sid_coop] = [
                    {"id": "usr_1", "role": "user", "text": "First turn", "timestamp": 100.0},
                    {"id": "prgm_1", "role": "program", "sender_id": "sebile", "sender_name": "Sebile", "text": "Original reply", "timestamp": 101.0},
                ]
                st.runner.sessions_program[sid_coop] = "sebile"

                coop_started = threading.Event()
                coop_cancel_called = threading.Event()

                class CoopResponse:
                    def __init__(self):
                        self.stop_reason = types.StopReason.UNSPECIFIED
                        self._cancelled = asyncio.Event()

                    async def cancel(self):
                        coop_cancel_called.set()
                        self._cancelled.set()

                    async def text(self):
                        coop_started.set()
                        await self._cancelled.wait()
                        raise types.AntigravityCancelledError("Cancelled")

                class CoopAgent:
                    def __init__(self, config):
                        self.config = config
                        self.conversation_id = "22222222-3333-4444-5555-666666666666"

                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, exc_type, exc, tb):
                        return False

                    async def chat(self, prompt: str):
                        return CoopResponse()

                async def fake_llm_loop_coop(self, session_id, adapter, model, inversion_directive, rag_context, new_message_text, invocation_id, speaker_id=None):
                    loop = asyncio.get_running_loop()
                    tools_mod.current_session_id.set(session_id)
                    tools_mod.current_speaker_id.set(speaker_id or "sebile")
                    await loop.run_in_executor(
                        None,
                        contextvars.copy_context().run,
                        agj.delegate_coding,
                        "Run coop cancel task",
                        str(tmp_ws),
                        "",
                        False,
                    )
                    return "Should not finish", [], None

                edit_result_holder = {}

                def run_edit_request():
                    edit_client = app_mod.app.test_client()
                    resp = edit_client.post(
                        "/edit",
                        json={"session_id": sid_coop, "msg_id": "usr_1", "new_text": "Edited prompt"},
                    )
                    edit_result_holder["status"] = resp.status_code
                    edit_result_holder["json"] = resp.get_json()

                with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False), \
                     mock.patch.object(agj, "Agent", CoopAgent), \
                     mock.patch.object(rr.OpenSourceRunner, "_execute_local_llm_loop", new=fake_llm_loop_coop), \
                     mock.patch.object(rr, "_get_databank_contexts", return_value=("", None)):
                    edit_thread = threading.Thread(target=run_edit_request, daemon=True)
                    edit_thread.start()
                    assert coop_started.wait(timeout=5.0), "CoopAgent did not start"

                    cancel_res = client.post("/api/cancel_chat", json={"session_id": sid_coop})
                    assert cancel_res.status_code == 200
                    assert coop_cancel_called.is_set(), "response.cancel() was not triggered"
                    edit_thread.join(timeout=5.0)
                    assert not edit_thread.is_alive(), "Edit thread did not finish after cancel"

                assert edit_result_holder["status"] == 200
                assert edit_result_holder["json"].get("cancelled") is True
                assert [m["id"] for m in st.runner.sessions_history[sid_coop]] == ["usr_1", "prgm_1"]
                assert st.runner.sessions_history[sid_coop][0]["text"] == "First turn"
                assert sid_coop not in st.runner.generating_sessions

                # 9b. Real OS subprocess-tree termination when cooperative cancel stalls
                sid_tree = "ag_cancel_tree"
                st.cancelled_sessions.discard(sid_tree)
                parent_script = (
                    "import subprocess, sys, time; "
                    "c = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)']); "
                    "print(c.pid, flush=True); "
                    "time.sleep(60)"
                )
                parent_proc = subprocess.Popen(
                    [sys.executable, "-c", parent_script],
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                child_pid = int(parent_proc.stdout.readline().strip())
                assert psutil.pid_exists(parent_proc.pid)
                assert psutil.pid_exists(child_pid)

                tree_started = threading.Event()
                tree_exc_holder = {}

                class HungResponse:
                    stop_reason = types.StopReason.UNSPECIFIED

                    async def cancel(self):
                        # Ignore cooperative cancel to verify escalation kills the process tree
                        return None

                    async def text(self):
                        await asyncio.sleep(60)
                        return "unreachable"

                class HungAgent:
                    def __init__(self, config):
                        self.config = config
                        self.conversation_id = "33333333-4444-5555-6666-777777777777"
                        self._conversation = SimpleNamespace(
                            _connection=SimpleNamespace(_process=parent_proc)
                        )

                    async def __aenter__(self):
                        return self

                    async def __aexit__(self, exc_type, exc, tb):
                        # Blocks until _terminate_process_tree kills parent_proc
                        await asyncio.to_thread(parent_proc.wait, 10)
                        return False

                    async def chat(self, prompt: str):
                        tree_started.set()
                        return HungResponse()

                def run_hung_job():
                    token = tools_mod.current_session_id.set(sid_tree)
                    try:
                        agj.delegate_coding(task="Run stalled harness", path=str(tmp_ws), resume=False)
                    except BaseException as exc:
                        tree_exc_holder["exc"] = exc
                    finally:
                        tools_mod.current_session_id.reset(token)

                try:
                    with mock.patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=False), \
                         mock.patch.object(agj, "Agent", HungAgent):
                        tree_thread = threading.Thread(target=run_hung_job, daemon=True)
                        tree_thread.start()
                        assert tree_started.wait(timeout=5.0), "HungAgent did not start"

                        tree_cancel_res = client.post("/api/cancel_chat", json={"session_id": sid_tree})
                        assert tree_cancel_res.status_code == 200
                        tree_thread.join(timeout=5.0)
                        assert not tree_thread.is_alive(), "Hung Antigravity thread did not exit"

                    deadline = time.monotonic() + 2.0
                    while time.monotonic() < deadline and (
                        psutil.pid_exists(parent_proc.pid) or psutil.pid_exists(child_pid)
                    ):
                        time.sleep(0.05)

                    assert not psutil.pid_exists(parent_proc.pid), "Parent harness process survived cancel"
                    assert not psutil.pid_exists(child_pid), "Descendant child process survived cancel"
                    assert isinstance(tree_exc_holder.get("exc"), asyncio.CancelledError), tree_exc_holder
                finally:
                    st.cancelled_sessions.discard(sid_tree)
                    for pid_to_clean in (child_pid, parent_proc.pid):
                        try:
                            if psutil.pid_exists(pid_to_clean):
                                psutil.Process(pid_to_clean).kill()
                        except Exception:
                            pass

                # 9c. Blocked HITL confirm_tool_execution unblocks immediately on /api/cancel_chat
                sid_hitl = "ag_cancel_hitl"
                st.cancelled_sessions.discard(sid_hitl)
                hitl_result = {}

                def wait_hitl():
                    tok = tools_mod.current_session_id.set(sid_hitl)
                    try:
                        with mock.patch("runners.program._load_settings", return_value={"security_preset": "ask_always"}):
                            hitl_result["approved"] = tools_mod.confirm_tool_execution(
                                "antigravity:run_command", "pytest"
                            )
                    finally:
                        tools_mod.current_session_id.reset(tok)

                hitl_thread = threading.Thread(target=wait_hitl, daemon=True)
                hitl_thread.start()
                wait_deadline = time.monotonic() + 3.0
                while time.monotonic() < wait_deadline and not any(
                    v.get("session_id") == sid_hitl for v in tools_mod.pending_tool_calls.values()
                ):
                    time.sleep(0.02)

                assert any(v.get("session_id") == sid_hitl for v in tools_mod.pending_tool_calls.values())
                hitl_cancel_res = client.post("/api/cancel_chat", json={"session_id": sid_hitl})
                assert hitl_cancel_res.status_code == 200
                hitl_thread.join(timeout=2.0)
                assert not hitl_thread.is_alive(), "HITL confirmation remained blocked after cancel"
                assert hitl_result.get("approved") is False
                st.cancelled_sessions.discard(sid_hitl)
            finally:
                rr.project_root = orig_rr_root
                rr.PROGRAMS_DIR = orig_rr_progs
                st.runner.program_id = orig_runner_prog
        finally:
            st.base_dir = orig_st_base
            vs.BASE_DIR = orig_vs_base

        print("ANTIGRAVITY_BRIDGE_VERIFIED")
    finally:
        vs.VARIABLES_DIR = orig_vs_vars
        vs.PROGRAMS_DIR = orig_vs_progs
        cpc.PROGRAMS_DIR = orig_cpc_progs
        cpc.USER_PROFILES_DIR = orig_cpc_user_profiles
        rp.PARENT_DIR = orig_rp_parent
        tools_mod.root_dir = orig_tools_root
        rp._settings_cache = orig_settings_cache
        rp._settings_mtime = orig_settings_mtime
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    test_antigravity_bridge()
