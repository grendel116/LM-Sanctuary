"""Verification suite for GreenPT `/v1` API compliance, 3-gear baton-passing, skills, and scheduler."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
import threading
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest import mock

os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"
os.environ["OPENHANDS_SUPPRESS_BANNER"] = "1"
os.environ["OH_TELEMETRY_CONSENT"] = "false"
os.environ.pop("AUTH_USER", None)
os.environ.pop("AUTH_PASS", None)

import dotenv

dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

import app as app_mod
from core import greenpt_client, quest_manager, scheduler, skill_retriever
from core.skills.vectorized_databank.databank import DataBankManager
from tools import openhands_job, openhands_worker, tools as tools_mod
from utils import utils as utils_mod


class _MockGreenPTHandler(BaseHTTPRequestHandler):
    log_requests: list[dict] = []
    skills_db: dict[str, dict] = {}
    return_402: bool = False

    def log_message(self, format: str, *args) -> None:  # noqa: A002
        return

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length > 0 else b""

    def _send_json(self, code: int, payload: object) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self) -> None:  # noqa: N802
        if self.return_402:
            self._send_json(402, {"error": "No remaining credits (EUR)"})
            return
        if self.path == "/v1/skills":
            self._send_json(200, {"data": list(self.skills_db.values())})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        raw = self._read_body()
        if self.return_402:
            self._send_json(402, {"error": "No remaining credits (EUR)"})
            return

        ctype = self.headers.get("Content-Type") or ""
        parsed = {}
        if "application/json" in ctype and raw:
            parsed = json.loads(raw.decode("utf-8"))

        self.log_requests.append(
            {
                "method": "POST",
                "path": self.path,
                "auth": self.headers.get("Authorization"),
                "json": parsed,
                "raw_len": len(raw),
            }
        )

        if self.path == "/v1/tools/websearch":
            q = parsed.get("query", "")
            self._send_json(
                200,
                {
                    "results": [
                        {
                            "title": f"GreenPT Hit for {q}",
                            "url": "https://coop.example.org/greenpt-hit",
                            "snippet": "Cooperative green infrastructure overview.",
                            "relevant_content": "Detailed extracted passage from fullPageContent=auto.",
                        }
                    ]
                },
            )
            return

        if self.path == "/v1/tools/crawl/scrape":
            self._send_json(
                200,
                {
                    "markdown": "# Clean Scraped SPA\n\nRendered via GreenPT crawl/scrape without cookie banners. "
                    + ("Solidarity content. " * 20)
                },
            )
            return

        if self.path == "/v1/tools/documents/convert/file":
            self._send_json(
                200,
                {
                    "document": {
                        "md_content": "# Converted Docling Document\n\nExtracted table and OCR paragraphs from uploaded binary."
                    }
                },
            )
            return

        if self.path == "/v1/rerank":
            docs = parsed.get("documents") or []
            # Reverse order to prove rerank reorders cosine candidates
            results = [
                {"index": idx, "relevance_score": round(0.95 - (pos * 0.1), 3)}
                for pos, idx in enumerate(reversed(range(len(docs))))
            ]
            self._send_json(200, {"results": results[: parsed.get("top_n", len(results))]})
            return

        if self.path == "/v1/skills":
            sid = f"sk_{len(self.skills_db) + 1}"
            rec = {"id": sid, **parsed}
            self.skills_db[sid] = rec
            self._send_json(201, rec)
            return

        if self.path == "/v1/chat/completions":
            model = parsed.get("model", "")
            skill = parsed.get("skills", "")
            self._send_json(
                200,
                {
                    "choices": [
                        {
                            "message": {
                                "role": "assistant",
                                "content": f"Cloud reply from {model}" + (f" [skill={skill}]" if skill else ""),
                            }
                        }
                    ]
                },
            )
            return

        self._send_json(404, {"error": "unknown route"})

    def do_PATCH(self) -> None:  # noqa: N802
        raw = self._read_body()
        parsed = json.loads(raw.decode("utf-8")) if raw else {}
        self.log_requests.append({"method": "PATCH", "path": self.path, "json": parsed})
        sid = self.path.rsplit("/", 1)[-1]
        rec = {"id": sid, **parsed}
        self.skills_db[sid] = rec
        self._send_json(200, rec)


def verify_all_skills_are_greenpt_and_agentskills_compliant() -> None:
    skill_retriever._skill_cache = None
    companion_records = skill_retriever._get_skill_registry()
    assert len(companion_records) >= 9, f"Expected >=9 companion skills, got {len(companion_records)}"

    names = {r["name"] for r in companion_records}
    assert "generative_ui" in names
    assert "quest_system" in names
    assert "auto_programming" in names

    for rec in companion_records:
        payload = greenpt_client.format_greenpt_skill_payload(rec)
        assert 1 <= len(payload["name"]) <= 64
        assert all(c.isalnum() or c in "-_" for c in payload["name"]), payload["name"]
        assert 1 <= len(payload["title"]) <= 120
        assert 1 <= len(payload["description"]) <= 500
        assert 10 <= len(payload["instructions"]) <= 20000

    # Verify ported open-source workspace skills for OpenHands
    ws_skills_root = REPO_ROOT / ".agents" / "skills"
    expected_ws_skills = {
        "modern_web_guidance",
        "browser_extensions",
        "multi_agent_workflow",
        "git_and_forge",
        "sanctuary_architecture",
    }
    for sname in expected_ws_skills:
        sfile = ws_skills_root / sname / "SKILL.md"
        assert sfile.is_file(), f"Missing workspace skill: {sfile}"
        meta, body = skill_retriever._parse_skill_frontmatter(sfile.read_text(encoding="utf-8"))
        assert meta.get("name") in (sname, sname.replace("_", "-"))
        assert 1 <= len(meta.get("description", "")) <= 500
        assert len(body) >= 50
        assert "gstatic.com" not in body


def verify_greenpt_endpoints_and_fallbacks() -> None:
    _MockGreenPTHandler.log_requests = []
    _MockGreenPTHandler.skills_db = {}
    _MockGreenPTHandler.return_402 = False

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), _MockGreenPTHandler)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()

    tmp = Path(tempfile.mkdtemp(prefix="greenpt_suite_"))
    try:
        base_url = f"http://127.0.0.1:{port}/v1"
        settings_file = tmp / "project_settings.json"
        sync_cache_file = tmp / "greenpt_skills_sync.json"
        settings_file.write_text(
            json.dumps(
                {
                    "greenpt_api_key": "sk-greenpt-test",
                    "greenpt_base_url": base_url,
                    "routing_policy": "auto",
                    "openhands_model": "glm-5.3",
                    "cloud_fast_model": "glm-5.3-flash",
                }
            ),
            encoding="utf-8",
        )

        with (
            mock.patch.object(greenpt_client, "_SETTINGS_PATH", str(settings_file)),
            mock.patch.object(greenpt_client, "_SKILL_SYNC_CACHE_PATH", str(sync_cache_file)),
            mock.patch.object(greenpt_client, "is_native_greenpt", return_value=True),
        ):
            greenpt_client.clear_quota_cooldown()

            # 1. WebSearch
            hits = greenpt_client.websearch("worker cooperatives", count=4, full_page_content="auto")
            assert len(hits) == 1
            assert hits[0]["source"] == "Cloud Search"
            assert "Detailed extracted passage" in hits[0]["content"]

            search_out = tools_mod.web_search("worker cooperatives")
            assert "GreenPT Hit for worker cooperatives" in search_out
            assert "Source: Cloud Search" in search_out

            # 2. Smart Webpage Scrape: rich static HTML stays local (0 cloud calls), sparse JS shell escalates
            before_scrapes = sum(1 for r in _MockGreenPTHandler.log_requests if r["path"] == "/v1/tools/crawl/scrape")
            rich_html = "<html><body><main><p>" + ("Static sovereign article text. " * 20) + "</p></main></body></html>"
            with mock.patch("primp.Client") as m_primp:
                m_primp.return_value.get.return_value = mock.Mock(status_code=200, text=rich_html)
                out_static = tools_mod.read_webpage("https://example.org/static")
            after_static = sum(1 for r in _MockGreenPTHandler.log_requests if r["path"] == "/v1/tools/crawl/scrape")
            assert "Static sovereign article text." in out_static
            assert after_static == before_scrapes, "Static rich page should not spend GreenPT scrape credits"

            sparse_html = "<html><body><div id='app'></div></body></html>"
            with mock.patch("primp.Client") as m_primp:
                m_primp.return_value.get.return_value = mock.Mock(status_code=200, text=sparse_html)
                out_spa = tools_mod.read_webpage("https://example.org/spa")
            after_spa = sum(1 for r in _MockGreenPTHandler.log_requests if r["path"] == "/v1/tools/crawl/scrape")
            assert "Clean Scraped SPA" in out_spa
            assert after_spa == before_scrapes + 1

            # 3. Docling Document Conversion (.docx) + Rerank in DataBankManager
            prog_db_dir = tmp / "sebile"
            prog_db_dir.mkdir(parents=True)
            docx_path = tmp / "coop_bylaws.docx"
            docx_path.write_bytes(b"PK\x03\x04fake-docx-binary")

            import numpy as np

            fake_embedder = mock.Mock()
            fake_embedder.encode.side_effect = lambda x: (
                np.array([[1.0, 0.0, 0.0] for _ in x])
                if isinstance(x, list)
                else np.array([1.0, 0.0, 0.0])
            )
            with mock.patch("core.skills.vectorized_databank.databank.get_embedding_model", return_value=fake_embedder):
                db = DataBankManager(db_dir=str(prog_db_dir))
                db.ingest_file(str(docx_path), "coop_bylaws.docx")
                db.ingest_text("Second cooperative charter chunk with equal cosine score.", "charter.md", "file")
                rag_res = db.query("bylaws", top_k=2, score_threshold=0.1)
                assert "charter.md" in rag_res.splitlines()[0], f"Expected green-rerank to reorder second chunk first: {rag_res}"

            # 4. Lazy Hash-Cached Skill Sync + Cloud Completion (`consult_cloud` & `ask_cloud` alias)
            gen_skill = next(r for r in skill_retriever._get_skill_registry() if r["name"] == "generative_ui")
            slug1 = greenpt_client.sync_skill(gen_skill)
            post_skills_count = sum(1 for r in _MockGreenPTHandler.log_requests if r["path"] == "/v1/skills")
            slug2 = greenpt_client.sync_skill(gen_skill)
            post_skills_count_after = sum(1 for r in _MockGreenPTHandler.log_requests if r["path"] == "/v1/skills")
            assert slug1 == "generative_ui" and slug2 == "generative_ui"
            assert post_skills_count == 1 and post_skills_count_after == 1, "Unchanged skill must hit sha256 cache"

            reply_cloud = greenpt_client.chat_completion(
                [{"role": "user", "content": "Build an interactive slider"}],
                tier="fast",
                skill_record=gen_skill,
            )
            assert "glm-5.3-flash" in reply_cloud
            assert "[skill=generative_ui]" in reply_cloud

            _, emulated_consult = utils_mod._execute_emulated_tool(
                "ask_cloud", 'query="Compare cooperative governance models", tier="deep"'
            )
            assert "CLOUD SYNTHESIS (glm-5.3)" in emulated_consult

            # 5. HTTP 402 Credit Exhaustion Cooldown -> Graceful Fallback
            _MockGreenPTHandler.return_402 = True
            graceful_msg = tools_mod.consult_cloud("Test under 402")
            assert "credits exhausted" in graceful_msg.lower() or "unavailable" in graceful_msg.lower()
            assert greenpt_client.is_quota_exhausted("sk-greenpt-test") is True
            assert greenpt_client.is_cloud_enabled() is False
            greenpt_client.clear_quota_cooldown()
            _MockGreenPTHandler.return_402 = False
    finally:
        httpd.shutdown()
        shutil.rmtree(tmp, ignore_errors=True)


def verify_subagent_tiering_auto_mode_and_user_choice_escalation() -> None:
    tmp = Path(tempfile.mkdtemp(prefix="oh_tier_"))
    try:
        settings_file = tmp / "project_settings.json"
        settings_file.write_text(
            json.dumps(
                {
                    "greenpt_api_key": "sk-greenpt-tier",
                    "greenpt_base_url": "https://api.greenpt.ai/v1",
                    "routing_policy": "auto",
                    "openhands_model": "glm-5.3",
                    "openhands_mode": "auto",
                }
            ),
            encoding="utf-8",
        )
        with mock.patch.object(openhands_job, "_PROJECT_SETTINGS_PATH", str(settings_file)):
            lead_cfg = openhands_job.resolve_greenpt_config(model="auto", subagent="")
            res_cfg = openhands_job.resolve_greenpt_config(model="auto", subagent="researcher")
            ver_cfg = openhands_job.resolve_greenpt_config(model="auto", subagent="verifier")
            imp_cfg = openhands_job.resolve_greenpt_config(model="auto", subagent="implementer")

            assert lead_cfg["raw_model"] == "glm-5.3"
            assert lead_cfg["fast_litellm_model"] == "openai/glm-5.3-flash"
            assert lead_cfg["mode"] == "auto"
            assert res_cfg["raw_model"] == "glm-5.3-flash"
            assert ver_cfg["raw_model"] == "glm-5.3-flash"
            assert imp_cfg["raw_model"] == "glm-5.3"

        # Verify OpenHands subagent factory applies fast_model to researcher/verifier but keeps parent on implementer
        from openhands.sdk import LLM
        from openhands.sdk.subagent.registry import _reset_registry_for_tests, get_agent_factory
        from openhands.tools.preset.default import get_default_tools

        get_default_tools(enable_browser=False, enable_sub_agents=True)
        _reset_registry_for_tests()
        openhands_worker.register_sanctuary_subagents(str(tmp), fast_model="openai/glm-5.3-flash")
        parent_llm = LLM(model="openai/glm-5.3", api_key="sk-test", base_url="https://api.greenpt.ai/v1")

        res_agent = get_agent_factory("researcher").factory_func(parent_llm)
        ver_agent = get_agent_factory("verifier").factory_func(parent_llm)
        imp_agent = get_agent_factory("implementer").factory_func(parent_llm)
        assert res_agent.llm.model == "openai/glm-5.3-flash"
        assert ver_agent.llm.model == "openai/glm-5.3-flash"
        assert imp_agent.llm.model == "openai/glm-5.3"

        # Verify [ESCALATE_TO_USER] round-trips through Flask /api/session_tool_calls & /approve_tool
        client = app_mod.app.test_client()
        decision_box: dict = {}

        def _run_escalated_decide():
            token = tools_mod.current_session_id.set("choice_sess")
            try:
                with mock.patch("requests.post") as m_post:
                    m_post.return_value = mock.Mock(
                        status_code=200,
                        json=lambda: {
                            "choices": [
                                {"message": {"content": "[ESCALATE_TO_USER] Let Davy pick the forge."}}
                            ]
                        },
                    )
                    decision_box["result"] = openhands_job._sebile_decide(
                        question="Which forge should we push to?",
                        options=["Codeberg (coop)", "GitHub"],
                        kind="ask_user",
                        program_id="sebile",
                        cwd=str(tmp),
                        instruction="Configure git remote",
                        config=lead_cfg,
                    )
            finally:
                tools_mod.current_session_id.reset(token)

        t = threading.Thread(target=_run_escalated_decide, daemon=True)
        t.start()

        # Poll Flask /api/session_tool_calls until choice card is pending, then submit option 0
        for _ in range(40):
            poll = client.get("/api/session_tool_calls?session_id=choice_sess").get_json()
            if poll and poll.get("call_id"):
                assert poll["kind"] == "choice"
                assert poll["options"] == ["Codeberg (coop)", "GitHub"]
                approve_res = client.post(
                    "/approve_tool",
                    json={
                        "call_id": poll["call_id"],
                        "status": "approved",
                        "option_index": 0,
                        "answer_text": "Codeberg (coop)",
                    },
                )
                assert approve_res.status_code == 200
                break
            threading.Event().wait(0.05)

        t.join(timeout=5.0)
        assert decision_box.get("result") == {
            "action": "answer",
            "option_index": 0,
            "text": "Codeberg (coop)",
        }
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify_quest_scheduler_and_cron() -> None:
    base = datetime(2026, 11, 22, 7, 30).astimezone()
    assert scheduler.compute_next_due("hourly", base) == base + timedelta(hours=1)
    assert scheduler.compute_next_due("daily", base) == base + timedelta(days=1)
    # 2026-11-22 is Sunday -> weekday cron `0 9 * * 1-5` should land Monday 2026-11-23 09:00
    nxt = scheduler.compute_next_due("0 9 * * 1-5", base)
    assert nxt is not None and nxt.weekday() == 0 and nxt.hour == 9 and nxt.minute == 0

    tmp = Path(tempfile.mkdtemp(prefix="sched_test_"))
    try:
        prog_dir = tmp / "sebile"
        prog_dir.mkdir(parents=True)
        (prog_dir / "sebile.json").write_text("{}", encoding="utf-8")
        fired: list[tuple] = []

        with (
            mock.patch.object(quest_manager, "PROGRAMS_DIR", str(tmp)),
            mock.patch("core.quest_manager.get_active_program", return_value="sebile"),
            mock.patch("runners.program.get_active_program", return_value="sebile"),
            mock.patch("runners.program.get_active_session", return_value="default"),
        ):
            past_due = base - timedelta(minutes=5)
            q = quest_manager.add_quest(
                title="Morning Briefing",
                objectives=["Summarize cooperative news"],
                due=past_due,
                location="",
                reminder_minutes=15,
                recurrence="daily",
                auto_prompt="Summarize cooperative news.",
            )
            assert q is not None
            triggered = scheduler.evaluate_due_automations(
                now=base,
                execute_callback=lambda p, s, prompt: fired.append((p, s, prompt)),
            )
            assert triggered == [q["id"]]
            assert len(fired) == 1
            assert "Summarize cooperative news." in fired[0][2]

            reloaded = quest_manager.load_quests("sebile")[0]
            assert quest_manager.parse_due(reloaded["due"]) > base
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def verify_sanctuary_browser_action_roundtrip() -> None:
    client = app_mod.app.test_client()
    out_box: dict = {}

    # 1. Read-only `snapshot` dispatches via /api/session_tool_calls and returns live [eN] refs
    def _run_snapshot():
        tok = tools_mod.current_session_id.set("b_sess")
        try:
            out_box["snap"] = tools_mod.browser_action(action="snapshot", timeout=5.0)
        finally:
            tools_mod.current_session_id.reset(tok)

    t1 = threading.Thread(target=_run_snapshot, daemon=True)
    t1.start()

    for _ in range(40):
        poll = client.get("/api/session_tool_calls?session_id=b_sess").get_json()
        bcmd = (poll or {}).get("browser_command")
        if bcmd and bcmd.get("cmd_id"):
            assert bcmd["action"] == "snapshot"
            res = client.post(
                "/api/browser/command_result",
                json={
                    "cmd_id": bcmd["cmd_id"],
                    "result": {
                        "ok": True,
                        "url": "https://www.ecosia.org/search?q=greenpt",
                        "title": "greenpt - Ecosia",
                        "snapshot": 'link "Welcome — GreenPT Docs" [e14]',
                    },
                },
            )
            assert res.status_code == 200
            break
        threading.Event().wait(0.05)

    t1.join(timeout=5.0)
    assert "[Sanctuary Browser · snapshot]" in out_box.get("snap", "")
    assert "[e14]" in out_box.get("snap", "")

    # 2. Mutating `click` goes through write-gate confirmation first, then dispatches to Browser
    def _run_click():
        tok = tools_mod.current_session_id.set("b_sess_click")
        try:
            with mock.patch("runners.program._load_settings", return_value={"security_preset": "ask_always"}):
                _, out_box["click"] = utils_mod._execute_emulated_tool(
                    "sanctuary_browser", 'action="click", ref="[e14]"'
                )
        finally:
            tools_mod.current_session_id.reset(tok)

    t2 = threading.Thread(target=_run_click, daemon=True)
    t2.start()

    approved_gate = False
    completed_cmd = False
    for _ in range(60):
        poll = client.get("/api/session_tool_calls?session_id=b_sess_click").get_json() or {}
        if poll.get("call_id") and not approved_gate:
            assert poll["tool_name"] == "browser:click"
            client.post("/approve_tool", json={"call_id": poll["call_id"], "status": "approved"})
            approved_gate = True
        bcmd = poll.get("browser_command")
        if bcmd and bcmd.get("cmd_id") and not completed_cmd:
            assert bcmd["action"] == "click"
            assert bcmd["args"]["ref"] == "e14"
            client.post(
                "/api/browser/command_result",
                json={
                    "cmd_id": bcmd["cmd_id"],
                    "result": {
                        "ok": True,
                        "url": "https://docs.greenpt.ai/",
                        "title": "Welcome — GreenPT Docs",
                    },
                },
            )
            completed_cmd = True
            break
        threading.Event().wait(0.05)

    t2.join(timeout=5.0)
    assert approved_gate and completed_cmd
    assert "Welcome — GreenPT Docs" in out_box.get("click", "")


if __name__ == "__main__":
    verify_all_skills_are_greenpt_and_agentskills_compliant()
    verify_greenpt_endpoints_and_fallbacks()
    verify_subagent_tiering_auto_mode_and_user_choice_escalation()
    verify_quest_scheduler_and_cron()
    verify_sanctuary_browser_action_roundtrip()
    print("ALL test_greenpt_compliance CHECKS PASSED")
