"""Verification suite for the lean /api/social/* stateless bridge and utilities."""

from __future__ import annotations

import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
from unittest import mock

import httpx

os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"

import dotenv

dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
if str(SANCTUARY_DIR) not in sys.path:
    sys.path.insert(0, str(SANCTUARY_DIR))

TMPDIR = tempfile.mkdtemp(prefix="sanctuary_social_bridge_")
TMP_SANCTUARY = Path(TMPDIR) / "sanctuary"
TMP_PROGS = TMP_SANCTUARY / "core" / "programs"
TMP_VARS = TMP_SANCTUARY / "variables"
(TMP_PROGS / "sebile" / "sessions").mkdir(parents=True, exist_ok=True)
(TMP_PROGS / "sebile" / "portraits").mkdir(parents=True, exist_ok=True)
TMP_VARS.mkdir(parents=True, exist_ok=True)
(TMP_PROGS / "sebile" / "sebile.json").write_text(
    json.dumps(
        {
            "spec": "chara_card_v3",
            "data": {
                "name": "Sebile",
                "description": "Sebile",
                "first_mes": "Hello",
                "extensions": {"sanctuary": {"program_id": "sebile"}},
            },
        }
    ),
    encoding="utf-8",
)
(TMP_PROGS / "sebile" / "theme.json").write_text(json.dumps({"primary_accent": "#85b9eb"}), encoding="utf-8")
(TMP_VARS / "project_settings.json").write_text(
    json.dumps({"active_program": "sebile", "active_session": "default", "active_user": "builder"}),
    encoding="utf-8",
)

import variables.settings as vs
import runners.program as rp
import runners.runner as rr
import core.program_config as cpc
import core.mood_inversion as cmi

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
from utils.link_preview import extract_first_https_url, fetch_link_preview, parse_video_embed
from utils.llm_translate import translate_with_local_llm
from utils.semantic_scorer import reset_semantic_scorer_cache, score_items_for_concepts


def test_route_surface() -> None:
    social_rules = {
        rule.rule for rule in app_mod.app.url_map.iter_rules() if rule.rule.startswith("/api/social")
    }
    assert social_rules == {
        "/api/social/accounts",
        "/api/social/accounts/<account_id>",
        "/api/social/accounts/filters",
        "/api/social/drafts",
        "/api/social/drafts/<draft_id>",
        "/api/social/linked-posts",
        "/api/social/linked-posts/<canonical_id>",
        "/api/social/link-preview",
        "/api/social/translate",
        "/api/social/feed/semantic-score",
        "/api/social/threads-insights-batch",
        "/api/social/threads-proxy",
        "/api/social/video-embed",
    }, f"Unexpected /api/social routes: {sorted(social_rules)}"

    client = app_mod.app.test_client()
    assert client.get("/api/social/timelines").status_code == 404
    assert client.post("/api/social/link-preview", json={}).status_code == 400
    assert client.post("/api/social/link-preview", json={"url": "https://127.0.0.1/secret"}).status_code == 400
    assert client.post("/api/social/translate", json={"text": ""}).status_code == 400
    assert client.post("/api/social/threads-proxy", json={"url": "https://evil.example/me"}).status_code == 400

    with mock.patch("routes.social_bridge.translate_with_local_llm", return_value=None):
        res_503 = client.post("/api/social/translate", json={"text": "Bonjour", "targetLang": "en"})
        assert res_503.status_code == 503
        assert res_503.get_json() == {"available": False}

    with mock.patch(
        "routes.social_bridge.translate_with_local_llm",
        return_value={
            "text": "Hello",
            "spoilerText": "",
            "detectedSourceLanguage": "fr",
            "provider": "Local LLM",
        },
    ):
        res_200 = client.post("/api/social/translate", json={"text": "Bonjour", "sourceLang": "fr", "targetLang": "en"})
        assert res_200.status_code == 200
        assert res_200.get_json()["text"] == "Hello"


def test_link_preview() -> None:
    assert (
        extract_first_https_url("Check https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB!")
        == "https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB"
    )
    v_info = parse_video_embed("https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB")
    assert v_info and v_info["provider"] == "youtube" and v_info["videoId"] == "j_wrosWPRTc"

    for bad_ssrf in (
        "https://127.0.0.1/secret",
        "https://10.0.0.5/internal",
        "http://localhost:5000/api",
        "https://node.local/x",
    ):
        ssrf_blocked = False
        try:
            fetch_link_preview(bad_ssrf)
        except ValueError:
            ssrf_blocked = True
        assert ssrf_blocked, f"Expected SSRF ValueError for {bad_ssrf}"

    def _preview_handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "www.youtube.com" and request.url.path == "/oembed":
            return httpx.Response(
                200,
                json={
                    "title": "Workers Anthem",
                    "author_name": "Solidarity",
                    "provider_name": "YouTube",
                    "thumbnail_url": "https://i.ytimg.com/vi/j_wrosWPRTc/hqdefault.jpg",
                },
            )
        if request.url.host == "article.example":
            return httpx.Response(
                200,
                headers={"content-type": "text/html; charset=utf-8"},
                text=(
                    '<html><head><meta property="og:title" content="Deep Dive">'
                    '<meta property="og:description" content="Analysis">'
                    '<meta property="og:image" content="/thumb.png"></head></html>'
                ),
            )
        return httpx.Response(404, json={})

    pv_client = httpx.Client(transport=httpx.MockTransport(_preview_handler))
    yt_card = fetch_link_preview("https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB", http_client=pv_client)
    assert yt_card and yt_card["title"] == "Workers Anthem"
    assert yt_card["embedUrl"].startswith("https://www.youtube-nocookie.com/embed/j_wrosWPRTc")

    art_card = fetch_link_preview("https://article.example/post", http_client=pv_client)
    assert art_card and art_card["title"] == "Deep Dive"
    assert art_card["image"] == "https://article.example/thumb.png"


def test_semantic_scorer() -> None:
    reset_semantic_scorer_cache()

    def fake_encode(texts):
        out = []
        for t in texts:
            tl = t.lower()
            if "cooperative" in tl or "union" in tl:
                out.append([1.0, 0.0, 0.0])
            elif "crypto" in tl or "sponsored" in tl:
                out.append([0.0, 1.0, 0.0])
            else:
                out.append([0.0, 0.0, 1.0])
        return out

    sem_res = score_items_for_concepts(
        [
            {"id": "p_coop", "text": "Worker cooperative bakeries thriving"},
            {"id": "p_crypto", "text": "Sponsored crypto drop today"},
            {"id": "p_neutral", "text": "Rainy morning walk"},
        ],
        boost_concepts=["worker cooperatives"],
        dampen_concepts=["crypto hype"],
        encode_fn=fake_encode,
    )
    assert sem_res["available"] is True
    assert sem_res["scores"]["p_coop"] > 0.5
    assert sem_res["scores"]["p_crypto"] < -0.5
    assert abs(sem_res["scores"]["p_neutral"]) < 0.01

    reset_semantic_scorer_cache()

    def fake_taste_encode(texts):
        out = []
        for t in texts:
            tl = t.lower()
            if "cooperative" in tl:
                out.append([1.0, 0.0, 0.0, 0.0])
            elif "agroecology" in tl or "forest" in tl:
                out.append([0.0, 1.0, 0.0, 0.0])
            elif "crypto" in tl or "sponsored" in tl:
                out.append([0.0, 0.0, 1.0, 0.0])
            else:
                out.append([0.0, 0.0, 0.0, 1.0])
        return out

    taste_res = score_items_for_concepts(
        [
            {"id": "t_coop", "text": "Worker cooperative bakeries organize"},
            {"id": "t_agro", "text": "Regional agroecology forest soil"},
            {"id": "t_crypto", "text": "Sponsored crypto drop today"},
            {"id": "t_neutral", "text": "Afternoon weather report"},
        ],
        positive_examples=[
            {"text": "Cooperative bylaws and assembly", "weight": 1.0},
            {"text": "Agroecology food forest handbook", "weight": 0.9},
        ],
        negative_examples=[{"text": "Sponsored crypto giveaway", "weight": 1.0}],
        encode_fn=fake_taste_encode,
    )
    assert taste_res["available"] is True
    assert taste_res["tasteScores"]["t_coop"] > 0.4
    assert taste_res["tasteScores"]["t_agro"] > 0.4
    assert taste_res["tasteScores"]["t_crypto"] < -0.4
    assert abs(taste_res["tasteScores"]["t_neutral"]) < 0.01

    reset_semantic_scorer_cache()

    def fake_axes_encode(texts):
        out = []
        for t in texts:
            tl = t.lower()
            if "bread" in tl or "cat" in tl or "silly" in tl or "hobby" in tl or "shed" in tl:
                out.append([1.0, 0.0, 0.0, 0.0, 0.0])
            elif "scientific" in tl or "materialist" in tl or "research" in tl or "quantum" in tl:
                out.append([0.0, 1.0, 0.0, 0.0, 0.0])
            elif "senate" in tl or "cable news" in tl or "campaign" in tl or "polling" in tl:
                out.append([0.0, 0.0, 1.0, 0.0, 0.0])
            elif "promo" in tl or "merch" in tl or "affiliate" in tl or "saas" in tl:
                out.append([0.0, 0.0, 0.0, 1.0, 0.0])
            else:
                out.append([0.0, 0.0, 0.0, 0.0, 1.0])
        return out

    axes_res = score_items_for_concepts(
        [
            {"id": "ax_chatter", "text": "Planing cedar in the shed"},
            {"id": "ax_science", "text": "Quantum measurement notes"},
            {"id": "ax_news", "text": "Midterm polling numbers"},
        ],
        include_axes=True,
        encode_fn=fake_axes_encode,
    )
    assert axes_res["available"] is True
    assert axes_res["axisScores"]["ax_chatter"]["everydayChatter"] > 0.4
    assert axes_res["axisScores"]["ax_chatter"]["scienceTheory"] < 0.0
    assert axes_res["axisScores"]["ax_science"]["scienceTheory"] > 0.4
    assert axes_res["axisScores"]["ax_news"]["newsPolitics"] > 0.4


def test_llm_translate() -> None:
    def _ok_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        if request.url.path == "/v1/chat/completions":
            body = json.loads(request.content.decode("utf-8"))
            user_text = body["messages"][1]["content"]
            if "alerta" in user_text.lower():
                return httpx.Response(200, json={"choices": [{"message": {"content": "<think>ponder</think>Warning"}}]})
            return httpx.Response(
                200,
                json={"choices": [{"message": {"content": "<think>thinking...</think>Hello world"}}]},
            )
        return httpx.Response(404)

    ok_client = httpx.Client(transport=httpx.MockTransport(_ok_handler))
    res = translate_with_local_llm(
        "Hola mundo",
        spoiler_text="Alerta",
        source_lang="es",
        target_lang="en",
        http_client=ok_client,
        llm_base_url="http://127.0.0.1:1234/v1",
    )
    assert res == {
        "text": "Hello world",
        "spoilerText": "Warning",
        "detectedSourceLanguage": "es",
        "provider": "Local LLM",
    }, res

    res_auto = translate_with_local_llm(
        "Hola mundo",
        source_lang="auto",
        target_lang="en",
        http_client=ok_client,
        llm_base_url="http://127.0.0.1:1234",
    )
    assert res_auto and res_auto["detectedSourceLanguage"] == ""

    def _down_handler(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    down_client = httpx.Client(transport=httpx.MockTransport(_down_handler))
    assert (
        translate_with_local_llm(
            "Hola",
            http_client=down_client,
            llm_base_url="http://127.0.0.1:1234",
        )
        is None
    )

    def _empty_handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/health":
            return httpx.Response(200, json={"status": "ok"})
        return httpx.Response(200, json={"choices": [{"message": {"content": "<think>only thoughts</think>"}}]})

    empty_client = httpx.Client(transport=httpx.MockTransport(_empty_handler))
    assert (
        translate_with_local_llm(
            "Hola",
            http_client=empty_client,
            llm_base_url="http://127.0.0.1:1234",
        )
        is None
    )


def test_threads_proxy() -> None:
    from routes.social_bridge import _relay_threads_request, _validate_threads_url

    assert _validate_threads_url("https://graph.threads.net/v1.0/me?fields=id") == (
        "https://graph.threads.net/v1.0/me?fields=id"
    )
    for bad_url in (
        "",
        "http://graph.threads.net/v1.0/me",
        "https://evil.example/v1.0/me",
        "https://graph.threads.net:8443/v1.0/me",
        "https://user:pass@graph.threads.net/v1.0/me",
        "https://127.0.0.1/v1.0/me",
    ):
        rejected = False
        try:
            _validate_threads_url(bad_url)
        except ValueError:
            rejected = True
        assert rejected, f"Expected ValueError for {bad_url!r}"

    seen_reqs: list[tuple[str, str, str, str]] = []

    def _threads_handler(request: httpx.Request) -> httpx.Response:
        seen_reqs.append(
            (
                request.method,
                str(request.url),
                request.headers.get("content-type", ""),
                request.content.decode("utf-8", errors="ignore"),
            )
        )
        if request.method == "POST":
            return httpx.Response(200, json={"id": "cont_123"})
        if request.method == "DELETE":
            return httpx.Response(400, json={"error": {"message": "Bad token"}})
        return httpx.Response(200, json={"id": "u_1", "username": "davy"})

    client = httpx.Client(transport=httpx.MockTransport(_threads_handler))
    res_get = _relay_threads_request("https://graph.threads.net/v1.0/me", method="GET", http_client=client)
    assert res_get == {"status": 200, "body": {"id": "u_1", "username": "davy"}}

    res_post = _relay_threads_request(
        "https://graph.threads.net/v1.0/me/threads",
        method="POST",
        body="media_type=TEXT&text=hello",
        http_client=client,
    )
    assert res_post == {"status": 200, "body": {"id": "cont_123"}}
    assert seen_reqs[1][2] == "application/x-www-form-urlencoded"
    assert seen_reqs[1][3] == "media_type=TEXT&text=hello"

    res_del = _relay_threads_request("https://graph.threads.net/v1.0/123", method="DELETE", http_client=client)
    assert res_del == {"status": 400, "body": {"error": {"message": "Bad token"}}}

    bad_method = False
    try:
        _relay_threads_request("https://graph.threads.net/v1.0/me", method="PUT", http_client=client)
    except ValueError:
        bad_method = True
    assert bad_method


def test_video_embed_route() -> None:
    client = app_mod.app.test_client()
    ok_res = client.get(
        "/api/social/video-embed?src=https%3A%2F%2Fwww.youtube-nocookie.com%2Fembed%2FdQw4w9WgXcQ%3Fautoplay%3D1%26rel%3D0%26bad%3Dxss"
    )
    assert ok_res.status_code == 200
    body = ok_res.get_data(as_text=True)
    assert 'src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&amp;rel=0"' in body
    assert 'bad=xss' not in body
    assert ok_res.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"
    csp = ok_res.headers.get("Content-Security-Policy", "")
    assert "frame-ancestors" in csp and "http://127.0.0.1:*" in csp

    vimeo_res = client.get(
        "/api/social/video-embed?src=https%3A%2F%2Fplayer.vimeo.com%2Fvideo%2F1234567%3Fautoplay%3D1"
    )
    assert vimeo_res.status_code == 200

    for bad in (
        "",
        "https://evil.example/embed/dQw4w9WgXcQ",
        "http://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
        "https://www.youtube-nocookie.com/watch?v=dQw4w9WgXcQ",
        'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" onclick="alert(1)',
    ):
        from urllib.parse import quote
        bad_res = client.get(f"/api/social/video-embed?src={quote(bad, safe='')}")
        assert bad_res.status_code == 400, f"Expected 400 for {bad!r}, got {bad_res.status_code}"


def test_threads_insights_batch() -> None:
    client = app_mod.app.test_client()

    bad = client.post("/api/social/threads-insights-batch", json={"postIds": ["123"]})
    assert bad.status_code == 400

    empty_res = client.post("/api/social/threads-insights-batch", json={"accessToken": "tok_1", "postIds": ["bad id!", ""]})
    assert empty_res.status_code == 200
    assert empty_res.get_json() == {"results": {}}

    seen_urls: list[str] = []

    def _fake_relay(raw_url: str, *, method: str = "GET", body: str = "", http_client=None):
        seen_urls.append(raw_url)
        if "/th_1/insights" in raw_url:
            return {
                "status": 200,
                "body": {
                    "data": [
                        {"name": "likes", "total_value": {"value": 4}},
                        {"name": "replies", "total_value": {"value": 1}},
                        {"name": "reposts", "total_value": {"value": 2}},
                        {"name": "quotes", "total_value": {"value": 1}},
                    ]
                },
            }
        return {"status": 500, "body": {"error": "transient"}}

    import routes.social_bridge as sb

    orig_relay = sb._relay_threads_request
    sb._relay_threads_request = _fake_relay
    try:
        ok = client.post(
            "/api/social/threads-insights-batch",
            json={"accessToken": "tok_1", "postIds": ["threads:th_1", "th_1", "th_2"]},
        )
        assert ok.status_code == 200
        assert ok.get_json() == {
            "results": {
                "th_1": {"likes": 4, "replies": 1, "reposts": 3},
            }
        }
        assert len(seen_urls) == 2
    finally:
        sb._relay_threads_request = orig_relay


def run_tests() -> None:
    test_route_surface()
    test_link_preview()
    test_semantic_scorer()
    test_llm_translate()
    test_threads_proxy()
    test_threads_insights_batch()
    test_video_embed_route()
    print("SOCIAL_BRIDGE_VERIFIED")


if __name__ == "__main__":
    try:
        run_tests()
    finally:
        shutil.rmtree(TMPDIR, ignore_errors=True)
