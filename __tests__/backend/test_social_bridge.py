"""Backend verification for social/ SQLite+Keychain subsystem, concurrent bridging, and Mastodon->Sanctuary profile isolation."""

from __future__ import annotations

import os
import re
import shutil
import sys
import tempfile
from pathlib import Path

os.environ["AUTO_START_LOCAL_LLM"] = "false"
os.environ["SANCTUARY_SKIP_PREWARM"] = "true"

import dotenv
dotenv.load_dotenv = lambda *a, **kw: False

REPO_ROOT = Path(__file__).resolve().parents[2]
SANCTUARY_DIR = REPO_ROOT / "sanctuary"
for p in (str(REPO_ROOT), str(SANCTUARY_DIR)):
    if p not in sys.path:
        sys.path.insert(0, p)

from social.core.schema.unified_item import deduplicate_unified_items, normalize_mastodon_status
from social.storage.keychain import KeychainStore
from social.storage.sqlite_store import SocialSQLiteStore
from social.sync_engine import SocialSyncEngine
from social.routes import set_social_engine_for_tests


class FakeMastodonAdapter:
    protocol = "mastodon"

    def __init__(self, instance_url="https://mastodon.social", access_token="m_tok"):
        self.instance_url = instance_url
        self.access_token = access_token
        self.calls = []
        self._counter = 200

    def verify_credentials(self):
        return {
            "id": "42",
            "username": "davy_test",
            "acct": "davy_test@mastodon.social",
            "display_name": "Davy Test",
            "note": "<p>Building free local software.</p>",
            "fields": [{"name": "Home", "value": "<a href=\"https://example.org\">example.org</a>"}],
        }

    def publish(self, draft, media=None, options=None):
        self._counter += 1
        sid = str(self._counter)
        self.calls.append(("publish", sid, draft, options))
        return {
            "id": f"mastodon:{sid}",
            "protocol": "mastodon",
            "url": f"{self.instance_url}/@davy_test/{sid}",
            "content_html": f"<p>{draft}</p>",
            "content_text": draft,
            "date_published": "2026-11-18T12:00:00Z",
            "author": {"id": "42", "name": "Davy Test", "handle": "davy_test@mastodon.social"},
            "attachments": [],
            "metrics": {"replies": 0, "reposts": 0, "likes": 0},
            "_meta": {"mastodon": {"statusId": sid, "uri": f"{self.instance_url}/s/{sid}", "visibility": "public"}},
        }

    def delete(self, native_meta):
        self.calls.append(("delete", native_meta.get("statusId")))
        return True

    def reply(self, target_item, draft, media=None, options=None):
        self.calls.append(("reply", target_item["id"], draft))
        return self.publish(draft)

    def fetch_notifications(self, cursor="", limit=30):
        return [
            {
                "id": "mastodon:notif:n1",
                "protocol": "mastodon",
                "url": "https://mastodon.social/@alice/1",
                "content_html": "<p>Merged notification body</p>",
                "content_text": "Merged notification body",
                "date_published": "2026-11-18T12:00:00Z",
                "author": {"id": "99", "name": "Alice", "handle": "alice.bsky.social@bsky.brid.gy"},
                "attachments": [],
                "metrics": {"replies": 0, "reposts": 0, "likes": 0},
                "_meta": {"mastodon": {"statusId": "1"}, "notification": {"notifId": "n1", "type": "mention"}},
            }
        ]

    def list_filters(self):
        return [{"id": "flt_m1", "title": "spam", "phrase": "spam", "filter_action": "hide"}]

    def create_filter(self, **kw):
        return {"id": "flt_m2", "title": kw.get("title"), "phrase": kw.get("phrase"), "filter_action": kw.get("filter_action", "hide")}

    def delete_filter(self, fid):
        return True

    def list_following(self, account_id, max_id="", limit=40):
        return {
            "accounts": [{"id": "90", "username": "peer", "acct": "peer@mastodon.social", "display_name": "Peer"}],
            "next_cursor": None,
        }

    def list_followers(self, account_id, max_id="", limit=40):
        return {
            "accounts": [{"id": "91", "username": "fan", "acct": "fan@mastodon.social", "display_name": "Fan"}],
            "next_cursor": None,
        }

    def list_follow_requests(self, limit=40):
        return []


class FakeBlueskyAdapter:
    protocol = "bluesky"

    def __init__(self, **kw):
        self.calls = []
        self._counter = 0

    def publish(self, draft, media=None, options=None):
        self._counter += 1
        uri = f"at://did:plc:davy/app.bsky.feed.post/p{self._counter}"
        self.calls.append(("publish", draft, options))
        return {
            "id": f"bluesky:{uri}",
            "protocol": "bluesky",
            "url": f"https://bsky.app/profile/davy.bsky.social/post/p{self._counter}",
            "content_html": f"<p>{draft}</p>",
            "content_text": draft,
            "date_published": "2026-11-18T12:00:01Z",
            "author": {"id": "did:plc:davy", "name": "Davy", "handle": "davy.bsky.social"},
            "attachments": [],
            "metrics": {"replies": 0, "reposts": 0, "likes": 0},
            "_meta": {"bluesky": {"uri": uri, "cid": f"cid_{self._counter}"}},
        }

    def delete(self, native_meta):
        self.calls.append(("delete", native_meta.get("uri")))
        return True

    def reply(self, target_item, draft, media=None, options=None):
        self.calls.append(("reply", target_item["id"], draft))
        return self.publish(draft)

    def fetch_notifications(self, cursor="", limit=30):
        return [
            {
                "id": "bluesky:notif:bn1",
                "protocol": "bluesky",
                "url": "https://bsky.app/profile/alice.bsky.social/post/1",
                "content_html": "<p>Merged notification body</p>",
                "content_text": "Merged notification body",
                "date_published": "2026-11-18T12:00:10Z",
                "author": {"id": "did:plc:alice", "name": "Alice", "handle": "alice.bsky.social"},
                "attachments": [],
                "metrics": {"replies": 0, "reposts": 0, "likes": 0},
                "_meta": {"bluesky": {"uri": "at://did:plc:alice/1", "cid": "c1"}, "notification": {"notifId": "bn1", "type": "mention"}},
            }
        ]

    def fetch_actor_profile(self, actor):
        return {
            "profile": {
                "id": actor,
                "did": actor,
                "protocol": "bluesky",
                "username": "bob.bsky.social",
                "acct": "bob.bsky.social",
                "display_name": "Bob",
                "avatar_url": "",
                "header_url": "",
                "url": "https://bsky.app/profile/bob.bsky.social",
                "note_html": "<p>ATProto bio</p>",
                "note_text": "ATProto bio",
                "fields": [{"name": "Home", "value": "https://bob.example/"}],
                "followers_count": 20,
                "following_count": 10,
                "statuses_count": 7,
            },
            "relationship": {"following": False, "followUri": None, "followed_by": True, "muting": False, "blocking": False, "blockUri": None},
        }

    def list_follows(self, actor, *, cursor="", limit=40):
        return {
            "accounts": [{"id": "did:plc:friend", "did": "did:plc:friend", "protocol": "bluesky", "username": "friend.bsky.social", "acct": "friend.bsky.social", "display_name": "Friend"}],
            "next_cursor": None,
        }

    def list_followers(self, actor, *, cursor="", limit=40):
        return {"accounts": [], "next_cursor": None}

    def search_actors(self, query, *, limit=15):
        return [{"id": "did:plc:bob", "did": "did:plc:bob", "protocol": "bluesky", "username": "bob.bsky.social", "acct": "bob.bsky.social", "display_name": "Bob"}]

    def search_posts(self, query, *, limit=15):
        return self.fetch_author_feed("did:plc:bob")

    def update_profile(self, **kw):
        self.calls.append(("update_profile", kw.get("display_name"), kw.get("fields")))
        return self.fetch_actor_profile("did:plc:davy")

    def fetch_author_feed(self, actor, *, tab="posts", cursor="", limit=15):
        return [
            {
                "id": f"bluesky:at://{actor}/app.bsky.feed.post/1",
                "protocol": "bluesky",
                "url": "https://bsky.app/profile/bob.bsky.social/post/1",
                "content_html": "<p>Author feed post</p>",
                "content_text": "Author feed post",
                "date_published": "2026-11-18T12:00:00Z",
                "author": {"id": actor, "name": "Bob", "handle": "bob.bsky.social"},
                "attachments": [],
                "metrics": {"replies": 0, "reposts": 0, "likes": 1},
                "_meta": {"bluesky": {"uri": f"at://{actor}/app.bsky.feed.post/1", "cid": "c_bob_1"}},
            }
        ]

    def follow_actor(self, target_did, *, follow_uri=None, undo=False):
        self.calls.append(("follow_actor", target_did, undo))
        return {"following": not undo, "followUri": None if undo else "at://did:plc:davy/app.bsky.graph.follow/f1"}

    def mute_actor(self, actor, *, undo=False):
        return {"muting": not undo}

    def block_actor(self, target_did, *, block_uri=None, undo=False):
        return {"blocking": not undo, "blockUri": None if undo else "at://did:plc:davy/app.bsky.graph.block/b1"}


class FailingThreadsAdapter:
    protocol = "threads"

    def __init__(self, fail_publish=True, **kw):
        self.fail_publish = fail_publish
        self.calls = []

    def publish(self, draft, media=None, options=None):
        if self.fail_publish:
            raise RuntimeError("Threads temporary rate limit")
        self.calls.append(("publish", draft))
        return {
            "id": "threads:th_900",
            "protocol": "threads",
            "content_text": draft,
            "content_html": f"<p>{draft}</p>",
            "date_published": "2026-11-18T12:00:02Z",
            "author": {"id": "th_u", "name": "davy", "handle": "davy"},
            "attachments": [],
            "metrics": {"replies": 0, "reposts": 0, "likes": 0},
            "_meta": {"threads": {"postId": "th_900"}},
        }

    def delete(self, native_meta):
        self.calls.append(("delete", native_meta.get("postId")))
        return True

    def reply(self, target_item, draft, media=None, options=None):
        self.calls.append(("reply", target_item["id"], draft))
        return self.publish(draft)

    def fetch_notifications(self, cursor="", limit=10):
        return []


def run_tests():
    tmpdir = Path(tempfile.mkdtemp(prefix="sanctuary_social_test_"))
    orig_profiles_dir = None
    orig_cpc_profiles_dir = None
    orig_rp_parent = None
    orig_active_user_env = os.environ.get("ACTIVE_USER")
    try:
        db = SocialSQLiteStore(db_path=tmpdir / "social.db")
        kc = KeychainStore(vault_dir=tmpdir / "vault", force_fallback=True)
        masto = FakeMastodonAdapter()
        bsky = FakeBlueskyAdapter()
        threads = FailingThreadsAdapter(fail_publish=False)

        profile_snapshots = []
        engine = SocialSyncEngine(
            store=db,
            keychain=kc,
            mastodon_adapter_factory=lambda inst, tok: masto,
            bluesky_adapter_factory=lambda **kw: bsky,
            threads_adapter_factory=lambda **kw: threads,
            on_profile_sync=lambda p: profile_snapshots.append(p),
            enable_streaming=False,
        )

        # Register active accounts in local store + Keychain (fallback AES-GCM in tmpdir)
        db.upsert_account(account_id="fediverse:davy_test@mastodon.social", protocol="mastodon", instance_url="https://mastodon.social", handle="davy_test@mastodon.social", display_name="Davy Test", is_primary=True, meta={"userId": "42"})
        kc.set_secret("fediverse:davy_test@mastodon.social", {"accessToken": "SECRET_MASTODON_TOKEN"})
        db.upsert_account(account_id="bluesky:did:plc:davy", protocol="bluesky", instance_url="https://bsky.social", handle="davy.bsky.social", is_primary=True, meta={"did": "did:plc:davy"})
        kc.set_secret("bluesky:did:plc:davy", {"accessJwt": "SECRET_BSKY_JWT", "refreshJwt": "SECRET_BSKY_REF"})
        db.upsert_account(account_id="threads:th_u", protocol="threads", handle="davy", is_primary=True, meta={"userId": "th_u"})
        kc.set_secret("threads:th_u", {"accessToken": "SECRET_THREADS_TOKEN"})

        # 1. Vault must encrypt secrets (zero plaintext in vault.enc)
        vault_raw = (tmpdir / "vault" / "vault.enc").read_bytes()
        assert b"SECRET_MASTODON_TOKEN" not in vault_raw
        assert b"SECRET_BSKY_JWT" not in vault_raw

        # 2. Outbound fan-out with >300 grapheme Bluesky auto-splitting & linkedIds storage
        long_text = ("word " * 70).strip() + " tail"
        pub_out = engine.publish_unified(draft=long_text)
        assert len(pub_out["items"]) == 1
        assert pub_out["linkedIds"]["mastodonStatusId"] == "201"
        assert pub_out["linkedIds"]["blueskyUri"].startswith("at://")
        assert pub_out["linkedIds"]["threadsPostId"] == "th_900"
        assert len([c for c in bsky.calls if c[0] == "publish"]) == 2
        assert len(profile_snapshots) >= 1
        assert profile_snapshots[-1]["recent_posts"][0]["text"] == long_text

        # 3. Synchronized parallel delete cleans Mastodon, Bluesky, and Threads
        del_out = engine.delete_unified(pub_out["items"][0]["id"])
        assert del_out["deleted"] is True
        assert any(c == ("delete", "201") for c in masto.calls)
        assert any(c[0] == "delete" for c in bsky.calls)
        assert any(c == ("delete", "th_900") for c in threads.calls)

        # 4. Partial bridge failure queues retry without aborting Mastodon
        threads.fail_publish = True
        part_out = engine.publish_unified(draft="Mastodon survives bridge outage")
        assert len(part_out["items"]) == 1
        assert len(part_out["retryQueue"]) == 1
        assert part_out["retryQueue"][0]["protocol"] == "threads"
        threads.fail_publish = False

        # 5. Protocol-routed reply keeps Bluesky replies off Mastodon
        masto.calls.clear()
        bsky_reply = engine.reply_unified(
            target_item={"id": "bluesky:at://did:plc:bob/post/1", "protocol": "bluesky", "_meta": {"bluesky": {"uri": "at://did:plc:bob/post/1", "cid": "c_bob"}}},
            draft="Hello ATProto",
        )
        assert bsky_reply["protocol"] == "bluesky"
        assert len(masto.calls) == 0

        # 6. Merged notifications deduplicate Bridgy mirror
        merged_notifs = engine.fetch_merged_notifications()
        assert len(merged_notifs["items"]) == 1

        # 7. Mount on Flask Blueprint and verify REST routes (isolated temp Sanctuary settings + profiles dir)
        import variables.settings as vs
        import runners.program as rp
        import core.program_config as cpc
        import sanctuary.app as sanctuary_app

        tmp_sanctuary = tmpdir / "sanctuary"
        tmp_vars = tmp_sanctuary / "variables"
        tmp_vars.mkdir(parents=True, exist_ok=True)
        (tmp_vars / "project_settings.json").write_text('{"active_user": "builder", "folders": []}', encoding="utf-8")

        orig_profiles_dir = vs.USER_PROFILES_DIR
        orig_cpc_profiles_dir = getattr(cpc, "USER_PROFILES_DIR", None)
        orig_rp_parent = rp.PARENT_DIR

        tmp_profiles_dir = str(tmp_vars / "user_profiles")
        vs.USER_PROFILES_DIR = tmp_profiles_dir
        if orig_cpc_profiles_dir is not None:
            cpc.USER_PROFILES_DIR = tmp_profiles_dir
        rp.PARENT_DIR = str(tmp_sanctuary)
        rp._settings_cache = None
        rp._settings_mtime = 0.0
        set_social_engine_for_tests(engine)

        client = sanctuary_app.app.test_client()
        assert client.get("/api/social/status").get_json()["isMastodonConnected"] is True
        assert client.post("/api/social/posts", json={"text": "Via Flask route"}).status_code == 200
        assert client.post("/api/social/filters", json={"title": "ads", "phrase": "ads", "filter_action": "hide"}).status_code == 200

        bsky_prof = client.get("/api/social/accounts/did:plc:bob/profile?protocol=bluesky").get_json()
        assert bsky_prof["profile"]["protocol"] == "bluesky"
        assert bsky_prof["profile"]["statuses_count"] == 7
        bsky_posts = client.get("/api/social/accounts/did:plc:bob/statuses?protocol=bluesky").get_json()
        assert len(bsky_posts["items"]) == 1
        assert bsky_posts["items"][0]["protocol"] == "bluesky"
        bsky_follow = client.post("/api/social/accounts/did:plc:bob/follow", json={"protocol": "bluesky"}).get_json()
        assert bsky_follow["following"] is True

        masto_following = client.get("/api/social/accounts/42/connections?kind=following&protocol=mastodon").get_json()
        assert masto_following["accounts"][0]["acct"] == "peer@mastodon.social"
        bsky_following = client.get("/api/social/accounts/did:plc:bob/connections?kind=following&protocol=bluesky").get_json()
        assert bsky_following["accounts"][0]["acct"] == "friend.bsky.social"

        # Real BlueskyAdapter links + pronouns normalization & app.bsky.actor.link reconciliation
        from social.adapters.bluesky.adapter import BlueskyAdapter
        bsky_calls = []
        class _FakeBsky(BlueskyAdapter):
            def _xrpc(self, endpoint, *, method="GET", params=None, json_body=None, content=None, headers=None, service_override=None, retry_refresh=True, unauthenticated=False):
                bsky_calls.append((endpoint, method, params, json_body))
                if endpoint == "com.atproto.repo.getRecord":
                    return {"value": {"$type": "app.bsky.actor.profile", "displayName": "Old"}}
                if endpoint == "com.atproto.repo.listRecords":
                    return {"records": [{"uri": "at://did:plc:davy/app.bsky.actor.link/old1", "cid": "c_old", "value": {"url": "https://old.example/", "title": "Old"}}]}
                if endpoint == "com.atproto.repo.createRecord":
                    return {"uri": "at://did:plc:davy/app.bsky.actor.link/new1", "cid": "c_new"}
                if endpoint == "app.bsky.actor.getProfile":
                    return {
                        "did": "did:plc:davy",
                        "handle": "davy.bsky.social",
                        "displayName": "Davy",
                        "links": [{"uri": "at://did:plc:davy/app.bsky.actor.link/new1", "cid": "c_new", "url": "https://institute.coop/", "title": "Institute coop"}],
                        "pronouns": "they/them",
                        "followersCount": 3,
                        "followsCount": 2,
                        "postsCount": 4,
                    }
                return {}
        real_bsky = _FakeBsky(service_url="https://bsky.social", did="did:plc:davy", handle="davy.bsky.social", access_jwt="jwt")
        prof_upd = real_bsky.update_profile(
            display_name="Davy",
            description="Bio text",
            fields=[
                {"name": "Institute coop", "value": "https://institute.coop/"},
                {"name": "Pronouns", "value": "they/them"},
            ],
        )
        assert prof_upd["profile"]["fields"][0]["name"] == "Institute coop"
        assert prof_upd["profile"]["fields"][1]["value"] == "they/them"
        put_calls = [jb for ep, _, _, jb in bsky_calls if ep == "com.atproto.repo.putRecord"]
        assert len(put_calls) == 1
        assert put_calls[0]["record"]["links"][0]["cid"] == "c_new"
        assert put_calls[0]["record"]["pronouns"] == "they/them"
        assert any(ep == "com.atproto.repo.deleteRecord" for ep, _, _, _ in bsky_calls)

        # Public AppView fallback for Bluesky followers when unauthenticated or PDS returns 401
        import httpx
        public_calls = []

        def _bsky_transport_handler(request: httpx.Request) -> httpx.Response:
            public_calls.append((request.url.host, request.url.path, request.headers.get("authorization", "")))
            if request.url.host == "bsky.social":
                return httpx.Response(401, json={"error": "AuthMissing", "message": "Authentication Required"})
            if request.url.host == "public.api.bsky.app" and "getFollowers" in request.url.path:
                assert not request.headers.get("authorization")
                return httpx.Response(
                    200,
                    json={
                        "followers": [
                            {"did": "did:plc:cam", "handle": "camleone.bsky.social", "displayName": "Cam"},
                        ],
                        "cursor": "c_next",
                    },
                )
            if request.url.host == "public.api.bsky.app" and "getPostThread" in request.url.path:
                assert not request.headers.get("authorization")
                return httpx.Response(
                    200,
                    json={
                        "thread": {
                            "post": {
                                "uri": "at://did:plc:yaro/app.bsky.feed.post/p1",
                                "cid": "cid_p1",
                                "author": {"did": "did:plc:yaro", "handle": "strategywoman.bsky.social", "displayName": "Yaroslava"},
                                "record": {"text": "Morning coffee", "createdAt": "2026-11-19T01:00:00Z"},
                                "replyCount": 2,
                            },
                            "parent": {
                                "post": {
                                    "uri": "at://did:plc:root/app.bsky.feed.post/r0",
                                    "cid": "cid_r0",
                                    "author": {"did": "did:plc:root", "handle": "root.bsky.social", "displayName": "Root"},
                                    "record": {"text": "Root post", "createdAt": "2026-11-19T00:50:00Z"},
                                }
                            },
                            "replies": [
                                {
                                    "post": {
                                        "uri": "at://did:plc:a/app.bsky.feed.post/c1",
                                        "cid": "cid_c1",
                                        "author": {"did": "did:plc:a", "handle": "alice.bsky.social", "displayName": "Alice"},
                                        "record": {"text": "Top reply", "createdAt": "2026-11-19T01:05:00Z"},
                                    },
                                    "replies": [
                                        {
                                            "post": {
                                                "uri": "at://did:plc:b/app.bsky.feed.post/c2",
                                                "cid": "cid_c2",
                                                "author": {"did": "did:plc:b", "handle": "bob.bsky.social", "displayName": "Bob"},
                                                "record": {"text": "Nested reply", "createdAt": "2026-11-19T01:06:00Z"},
                                            },
                                            "replies": [],
                                        }
                                    ],
                                }
                            ],
                        }
                    },
                )
            return httpx.Response(404, json={})

        transport = httpx.MockTransport(_bsky_transport_handler)
        anon_bsky = BlueskyAdapter(
            service_url="https://bsky.social",
            did="did:plc:davy",
            handle="davy.bsky.social",
            access_jwt="",
            http_client=httpx.Client(transport=transport),
        )
        anon_page = anon_bsky.list_followers("did:plc:davy")
        assert anon_page["accounts"][0]["acct"] == "camleone.bsky.social"
        assert anon_page["next_cursor"] == "c_next"
        assert all(host == "public.api.bsky.app" for host, _, _ in public_calls)

        public_calls.clear()
        stale_bsky = BlueskyAdapter(
            service_url="https://bsky.social",
            did="did:plc:davy",
            handle="davy.bsky.social",
            access_jwt="stale_jwt",
            http_client=httpx.Client(transport=transport),
        )
        fallback_page = stale_bsky.list_followers("did:plc:davy")
        assert fallback_page["accounts"][0]["acct"] == "camleone.bsky.social"
        assert [host for host, _, _ in public_calls] == ["bsky.social", "public.api.bsky.app"]
        assert public_calls[1][2] == ""

        thread_res = stale_bsky.get_post_thread("at://did:plc:yaro/app.bsky.feed.post/p1")
        assert len(thread_res["ancestors"]) == 1
        assert len(thread_res["descendants"]) == 2
        assert thread_res["descendants"][0]["_threadDepth"] == 0
        assert thread_res["descendants"][1]["_threadDepth"] == 1
        assert thread_res["descendants"][1]["_meta"]["bluesky"]["reply"]["root"]["uri"] == "at://did:plc:root/app.bsky.feed.post/r0"

        orig_get_bsky = engine.get_bluesky_adapter
        engine.get_bluesky_adapter = lambda: stale_bsky
        try:
            ctx_resp = client.get("/api/social/posts/at://did:plc:yaro/app.bsky.feed.post/p1/context?protocol=bluesky")
            assert ctx_resp.status_code == 200
            ctx_json = ctx_resp.get_json()
            assert len(ctx_json["descendants"]) == 2
            assert ctx_json["status"]["content_text"] == "Morning coffee"
        finally:
            engine.get_bluesky_adapter = orig_get_bsky

        # 8. Token-free Mastodon public profile + 3 recent posts snapshot written to sanctuary/variables/user_profiles/
        sync_res = client.post("/api/user_profiles/sync_mastodon", json={
            "username": "Davy_Test",
            "acct": "davy_test@mastodon.social",
            "display_name": "Davy Test",
            "note": "<p>Local worker builder</p>",
            "fields": [{"name": "Web", "value": "https://example.org"}],
            "recent_posts": [
                {"text": "<p>First public note</p>", "created_at": "2026-11-19T08:00:00Z"},
                {"text": "Second thought", "created_at": "2026-11-18T12:00:00Z"},
                {"text": "Third thought", "created_at": "2026-11-17T10:00:00Z"},
                {"text": "Fourth older post should be trimmed"},
            ],
            "access_token": "MUST_NEVER_BE_WRITTEN",
        })
        assert sync_res.status_code == 200
        assert sync_res.get_json()["recent_posts_count"] == 3
        snap_path = Path(tmp_profiles_dir) / "mastodon_davy_test.md"
        posts_path = Path(tmp_profiles_dir) / "mastodon_davy_test_recent_posts.json"
        assert snap_path.exists()
        assert posts_path.exists()
        snap_text = snap_path.read_text(encoding="utf-8")
        posts_text = posts_path.read_text(encoding="utf-8")
        assert "Davy Test (@davy_test@mastodon.social)" in snap_text
        assert "Local worker builder" in snap_text
        assert "MUST_NEVER_BE_WRITTEN" not in snap_text
        assert "SECRET_MASTODON_TOKEN" not in snap_text
        assert "First public note" in posts_text
        assert "<p>" not in posts_text
        assert "Fourth older post" not in posts_text
        assert "MUST_NEVER_BE_WRITTEN" not in posts_text

        # Subsequent metadata-only sync must preserve existing recent_posts snapshot
        client.post("/api/user_profiles/sync_mastodon", json={
            "username": "Davy_Test",
            "acct": "davy_test@mastodon.social",
            "display_name": "Davy Test",
        })
        assert "First public note" in posts_path.read_text(encoding="utf-8")

        # Dynamic runtime context injects USER'S RECENT SOCIAL POSTS while static instructions keep KV prefix stable
        prefix_before = cpc.get_compiled_instructions()
        dyn_ctx = cpc.load_dynamic_runtime_context()
        assert "### USER'S RECENT SOCIAL POSTS" in dyn_ctx
        assert "First public note" in dyn_ctx
        assert "Second thought" in dyn_ctx
        assert "Third thought" in dyn_ctx
        assert "Fourth older post" not in dyn_ctx

        client.post("/api/user_profiles/sync_mastodon", json={
            "username": "Davy_Test",
            "acct": "davy_test@mastodon.social",
            "display_name": "Davy Test",
            "recent_posts": [{"text": "Updated thought right now", "created_at": "2026-11-19T09:00:00Z"}],
        })
        assert cpc.get_compiled_instructions() == prefix_before
        assert "Updated thought right now" in cpc.load_dynamic_runtime_context()

        assert cpc.get_active_user_display_name() == "Davy Test"

        # 9. Verify runners/ and tools/ never import social/
        for py_dir in (SANCTUARY_DIR / "runners", SANCTUARY_DIR / "tools"):
            for py_file in py_dir.rglob("*.py"):
                content = py_file.read_text(encoding="utf-8")
                assert not re.search(r"^\s*(?:from|import)\s+social\b", content, re.MULTILINE), f"Forbidden social import in {py_file}"

        set_social_engine_for_tests(None)
        print("SOCIAL_BRIDGE_BACKEND_VERIFIED")
    finally:
        if orig_profiles_dir is not None:
            import variables.settings as vs
            vs.USER_PROFILES_DIR = orig_profiles_dir
        if orig_cpc_profiles_dir is not None:
            import core.program_config as cpc
            cpc.USER_PROFILES_DIR = orig_cpc_profiles_dir
        if orig_rp_parent is not None:
            import runners.program as rp
            rp.PARENT_DIR = orig_rp_parent
            rp._settings_cache = None
            rp._settings_mtime = 0.0
        if orig_active_user_env is None:
            os.environ.pop("ACTIVE_USER", None)
        else:
            os.environ["ACTIVE_USER"] = orig_active_user_env
        shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    run_tests()
