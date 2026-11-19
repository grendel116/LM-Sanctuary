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

    def list_mutes(self):
        return [{"id": "m_m1", "protocol": "mastodon", "username": "muted_m", "acct": "muted_m@mastodon.social", "display_name": "Muted Mastodon"}]

    def list_blocks(self):
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

    def list_mutes(self, limit=100):
        return [{"id": "did:plc:m_bsky", "did": "did:plc:m_bsky", "protocol": "bluesky", "username": "m.bsky.social", "acct": "m.bsky.social", "display_name": "Muted Bsky"}]

    def list_blocks(self, limit=100):
        return [{"id": "did:plc:b_bsky", "did": "did:plc:b_bsky", "protocol": "bluesky", "username": "b.bsky.social", "acct": "b.bsky.social", "display_name": "Blocked Bsky", "viewer": {"blocking": "at://did:plc:davy/app.bsky.graph.block/b1"}}]

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

        # 8a. /api/social/moderation/<kind> merges Mastodon and Bluesky muted/blocked accounts
        mutes_resp = client.get("/api/social/moderation/mutes")
        assert mutes_resp.status_code == 200
        mutes_protos = [a.get("protocol") for a in mutes_resp.get_json()["accounts"]]
        assert "mastodon" in mutes_protos and "bluesky" in mutes_protos
        blocks_resp = client.get("/api/social/moderation/blocks")
        assert blocks_resp.status_code == 200
        blocks_json = blocks_resp.get_json()["accounts"]
        assert len(blocks_json) == 1 and blocks_json[0]["id"] == "did:plc:b_bsky"

        # 8b. Bluesky UTF-8 facet linkification & external linkCard extraction
        from social.core.schema.unified_item import normalize_bluesky_post, normalize_mastodon_status

        bsky_text = "Good morning 🌹 🎶 🕊️\n\nyoutu.be/JLjyYDakdXo?..."
        bsky_prefix = "Good morning 🌹 🎶 🕊️\n\n".encode("utf-8")
        bsky_tok = "youtu.be/JLjyYDakdXo?...".encode("utf-8")
        bsky_item = normalize_bluesky_post({
            "post": {
                "uri": "at://did:plc:abc/app.bsky.feed.post/link1",
                "cid": "bafylink1",
                "author": {"did": "did:plc:abc", "handle": "redhead.bsky.social", "displayName": "Redhead"},
                "record": {
                    "text": bsky_text,
                    "createdAt": "2026-11-19T10:00:00Z",
                    "facets": [{
                        "index": {"byteStart": len(bsky_prefix), "byteEnd": len(bsky_prefix) + len(bsky_tok)},
                        "features": [{"$type": "app.bsky.richtext.facet#link", "uri": "https://youtu.be/JLjyYDakdXo?si=test"}],
                    }],
                },
                "embed": {
                    "$type": "app.bsky.embed.external#view",
                    "external": {
                        "uri": "https://youtu.be/JLjyYDakdXo?si=test",
                        "title": "Morning Song",
                        "description": "Live session",
                        "thumb": "https://cdn.bsky.app/img/thumb.jpg",
                    },
                },
            }
        })
        assert 'href="https://youtu.be/JLjyYDakdXo?si=test"' in bsky_item["content_html"]
        assert ">youtu.be/JLjyYDakdXo?...</a>" in bsky_item["content_html"]
        assert bsky_item["_meta"]["linkCard"]["title"] == "Morning Song"

        masto_card_item = normalize_mastodon_status(
            {
                "id": "999",
                "created_at": "2026-11-19T10:00:00Z",
                "content": "<p>Link post</p>",
                "account": {"id": "1", "acct": "alice", "username": "alice"},
                "card": {"url": "https://example.org/story", "title": "Example Story", "description": "Summary"},
            },
            "https://mastodon.social",
        )
        assert masto_card_item["_meta"]["linkCard"]["url"] == "https://example.org/story"

        # 8b. Verify Threads OAuth 2.0 code exchange, 60-day upgrade, carousel normalization, conversation tree, and direct DM skip
        from social.adapters.threads.adapter import ThreadsAdapter
        from social.core.schema.unified_item import normalize_threads_post

        assert ThreadsAdapter.clean_auth_code("https://localhost/?code=TH_CODE_9#_") == "TH_CODE_9"
        auth_url = ThreadsAdapter.build_authorize_url(client_id="app_1", redirect_uri="https://localhost/", state="st1")
        assert auth_url.startswith("https://threads.net/oauth/authorize?")
        assert "threads_basic" in auth_url

        threads_req_log = []

        def _threads_handler(request: httpx.Request) -> httpx.Response:
            threads_req_log.append((request.method, request.url.path, request.content.decode("utf-8", errors="ignore")))
            if request.url.path == "/oauth/access_token":
                return httpx.Response(200, json={"access_token": "short_tok", "user_id": "th_99"})
            if request.url.path == "/access_token":
                return httpx.Response(200, json={"access_token": "long_tok_60d", "expires_in": 5184000})
            if request.url.path == "/refresh_access_token":
                return httpx.Response(200, json={"access_token": "refreshed_tok_60d", "expires_in": 5184000})
            if request.url.path == "/v1.0/th_post_1":
                return httpx.Response(
                    200,
                    json={
                        "id": "th_post_1",
                        "username": "davy",
                        "text": "Album release",
                        "timestamp": "2026-11-19T04:00:00Z",
                        "link_attachment_url": "https://example.org/release",
                        "children": {"data": [{"id": "c1", "media_type": "IMAGE", "media_url": "https://cdn.example.org/a.jpg", "alt_text": "Cover"}]},
                    },
                )
            if request.url.path == "/v1.0/th_post_1/conversation":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {"id": "rep_1", "username": "bob", "text": "Nice!", "timestamp": "2026-11-19T04:01:00Z", "replied_to": {"id": "th_post_1"}},
                            {"id": "rep_2", "username": "carol", "text": "Agreed", "timestamp": "2026-11-19T04:02:00Z", "replied_to": {"id": "rep_1"}},
                        ]
                    },
                )
            return httpx.Response(404, json={})

        th_client = httpx.Client(transport=httpx.MockTransport(_threads_handler))
        short_res = ThreadsAdapter.exchange_oauth_code(
            client_id="app_1",
            client_secret="sec_1",
            redirect_uri="https://localhost/",
            code="https://localhost/?code=TH_CODE_9#_",
            http_client=th_client,
        )
        assert short_res["access_token"] == "short_tok"
        long_res = ThreadsAdapter.exchange_long_lived_token(client_secret="sec_1", access_token="short_tok", http_client=th_client)
        assert long_res["access_token"] == "long_tok_60d"
        ref_res = ThreadsAdapter.refresh_long_lived_token(access_token="long_tok_60d", http_client=th_client)
        assert ref_res["access_token"] == "refreshed_tok_60d"

        real_th = ThreadsAdapter(user_id="th_99", access_token="long_tok_60d", username="davy", http_client=th_client)
        th_thread = real_th.get_post_thread("threads:th_post_1")
        assert len(th_thread["status"]["attachments"]) == 1
        assert th_thread["status"]["_meta"]["linkCard"]["url"] == "https://example.org/release"
        assert [d["_threadDepth"] for d in th_thread["descendants"]] == [0, 1]

        norm_car = normalize_threads_post({"id": "x1", "link_attachment_url": "https://example.org/item", "topic_tag": "IndieDev"})
        assert norm_car["_meta"]["threads"]["topicTag"] == "IndieDev"

        masto.calls.clear()
        threads.calls.clear()
        bsky.calls.clear()
        engine.publish_unified(draft="Direct Mastodon message only", visibility="direct")
        assert len(masto.calls) == 1
        assert len(threads.calls) == 0
        assert len(bsky.calls) == 0

        # 9. Verify semantic feed concept scoring & normalized sensitivity/label fields
        from social.semantic_scorer import reset_semantic_scorer_cache, score_items_for_concepts

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

        from social.core.schema.unified_item import normalize_bluesky_post, normalize_mastodon_status

        m_sens = normalize_mastodon_status(
            {"id": "s_sens", "content": "<p>CW test</p>", "sensitive": True, "spoiler_text": "18+ NSFW", "account": {"id": "a1", "acct": "a1"}},
            "https://mastodon.social",
        )
        assert m_sens["_meta"]["mastodon"]["sensitive"] is True
        b_lbl = normalize_bluesky_post(
            {
                "post": {
                    "uri": "at://did:plc:x/app.bsky.feed.post/9",
                    "cid": "cid9",
                    "author": {"did": "did:plc:x", "handle": "x.bsky.social"},
                    "record": {"text": "Artwork", "createdAt": "2026-11-19T00:00:00Z"},
                    "labels": [{"val": "nudity"}],
                },
                "reason": {"by": {"did": "did:plc:rep", "handle": "rep.bsky.social", "displayName": "Rep"}},
            }
        )
        assert b_lbl["_meta"]["bluesky"]["labels"] == ["nudity"]
        assert b_lbl["_meta"]["bluesky"]["rebloggedBy"]["acct"] == "rep.bsky.social"

        # 9b. Scoped Threads notifications, cross-platform metrics aggregation, Threads profile routing, and replace_bridges edit
        from social.adapters.bluesky.adapter import BlueskyAdapter

        agg_calls = []

        def _agg_threads_handler(request: httpx.Request) -> httpx.Response:
            agg_calls.append(("threads", request.method, request.url.path))
            path = request.url.path
            if path == "/v1.0/th_linked_1/replies":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {"id": "tr_ext", "username": "shinybags.plus", "text": "well its fascism", "timestamp": "2026-11-19T12:00:00Z"},
                            {"id": "tr_self", "username": "davyrhodes_", "text": "Self reply ignore", "timestamp": "2026-11-19T12:01:00Z"},
                        ]
                    },
                )
            if path == "/v1.0/me/mentions":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {"id": "tm_untracked", "username": "random_user", "text": "Untracked reply", "replied_to": {"id": "th_foreign_999"}, "timestamp": "2026-11-19T12:02:00Z"},
                            {"id": "tm_top", "username": "friend_top", "text": "Top level @davyrhodes_ ping", "timestamp": "2026-11-19T12:03:00Z"},
                        ]
                    },
                )
            if path == "/v1.0/th_linked_1/insights":
                return httpx.Response(
                    200,
                    json={
                        "data": [
                            {"name": "likes", "values": [{"value": 4}]},
                            {"name": "replies", "values": [{"value": 1}]},
                            {"name": "reposts", "values": [{"value": 2}]},
                            {"name": "quotes", "values": [{"value": 1}]},
                        ]
                    },
                )
            if path == "/v1.0/29797930329813883/threads":
                if request.method == "GET":
                    return httpx.Response(200, json={"data": [{"id": "own_th_9", "username": "davyrhodes_", "text": "Own native post", "timestamp": "2026-11-19T10:00:00Z"}]})
                return httpx.Response(200, json={"id": "th_c_new"})
            if path == "/v1.0/29797930329813883/threads_publish":
                return httpx.Response(200, json={"id": "th_replaced_1"})
            if path == "/v1.0/th_linked_1" and request.method == "DELETE":
                return httpx.Response(200, json={"success": True})
            if path == "/v1.0/profile_lookup":
                return httpx.Response(400, json={"error": {"message": "Missing scope"}})
            return httpx.Response(200, json={})

        def _agg_bsky_handler(request: httpx.Request) -> httpx.Response:
            agg_calls.append(("bluesky", request.method, request.url.path))
            if request.url.path == "/xrpc/app.bsky.feed.getPosts":
                return httpx.Response(
                    200,
                    json={
                        "posts": [
                            {"uri": "at://did:plc:davy/app.bsky.feed.post/agg1", "likeCount": 5, "replyCount": 2, "repostCount": 1, "quoteCount": 1}
                        ]
                    },
                )
            if request.url.path == "/xrpc/com.atproto.repo.deleteRecord":
                return httpx.Response(200, json={})
            if request.url.path == "/xrpc/com.atproto.repo.createRecord":
                return httpx.Response(200, json={"uri": "at://did:plc:davy/app.bsky.feed.post/replaced1", "cid": "cid_rep_1"})
            return httpx.Response(200, json={})

        agg_th = ThreadsAdapter(
            user_id="29797930329813883",
            access_token="t_tok",
            username="davyrhodes_",
            http_client=httpx.Client(transport=httpx.MockTransport(_agg_threads_handler)),
        )
        agg_bsky = BlueskyAdapter(
            service_url="https://bsky.social",
            did="did:plc:davy",
            handle="davy.bsky.social",
            access_jwt="b_jwt",
            http_client=httpx.Client(transport=httpx.MockTransport(_agg_bsky_handler)),
        )
        # Verify Threads notifications strictly exclude self-replies, untracked thread mentions, and unlinked timeline polling
        scoped_notifs = agg_th.fetch_notifications(limit=10, tracked_post_ids=["th_linked_1"])
        notif_texts = [n["content_text"] for n in scoped_notifs]
        assert "well its fascism" in notif_texts
        assert "Top level @davyrhodes_ ping" in notif_texts
        assert "Self reply ignore" not in notif_texts
        assert "Untracked reply" not in notif_texts
        assert all(p != "/v1.0/29797930329813883/threads" for (_, m, p) in agg_calls if m == "GET")

        # Verify Insights + Bluesky getPosts metrics parsing
        ins = agg_th.get_post_insights("th_linked_1")
        assert ins == {"likes": 4, "replies": 1, "reposts": 3}
        bm = agg_bsky.get_posts_metrics(["at://did:plc:davy/app.bsky.feed.post/agg1"])
        assert bm["at://did:plc:davy/app.bsky.feed.post/agg1"] == {"likes": 5, "replies": 2, "reposts": 2}

        class _EditMastoFake(FakeMastodonAdapter):
            def edit_status(self, status_id, draft, spoiler_text=""):
                self.calls.append(("edit", status_id, draft))
                item = self.publish(draft)
                item["id"] = f"mastodon:{status_id}"
                item["_meta"]["mastodon"]["statusId"] = str(status_id)
                return item

            def fetch_account_profile(self, account_id):
                raise RuntimeError(f"Mastodon 404 called for {account_id}")

        agg_store = SocialSQLiteStore(str(Path(tmpdir) / "agg_social.db"))
        agg_store.save_linked_post(
            canonical_id="mastodon:m_agg_99",
            mastodon_status_id="m_agg_99",
            mastodon_instance="https://mastodon.social",
            bluesky_uri="at://did:plc:davy/app.bsky.feed.post/agg1",
            bluesky_cid="cid_old",
            threads_post_id="th_linked_1",
        )
        agg_masto = _EditMastoFake()
        agg_engine = SocialSyncEngine(store=agg_store, keychain=engine.keychain)
        agg_engine.get_mastodon_adapter = lambda *a, **kw: agg_masto
        agg_engine.get_public_mastodon_adapter = lambda *a, **kw: agg_masto
        agg_engine.get_bluesky_adapter = lambda *a, **kw: agg_bsky
        agg_engine.get_threads_adapter = lambda *a, **kw: agg_th
        set_social_engine_for_tests(agg_engine)

        enrich_resp = client.post("/api/social/posts/enrich-metrics", json={
            "items": [{
                "id": "mastodon:m_agg_99",
                "protocol": "mastodon",
                "metrics": {"likes": 3, "replies": 1, "reposts": 2},
                "_meta": {"mastodon": {"statusId": "m_agg_99"}},
            }]
        })
        assert enrich_resp.status_code == 200
        enriched_item = enrich_resp.get_json()["items"][0]
        assert enriched_item["metrics"] == {"likes": 12, "replies": 4, "reposts": 7}
        assert enriched_item["_meta"]["metricsBreakdown"]["threads"]["likes"] == 4
        # Second call does not double count
        twice = agg_engine.enrich_linked_metrics([enriched_item])[0]
        assert twice["metrics"] == {"likes": 12, "replies": 4, "reposts": 7}

        # Foreign Threads profile & statuses routes never hit Mastodon or leak own Threads timeline
        prof_resp = client.get("/api/social/accounts/shinybags.plus/profile?protocol=threads")
        assert prof_resp.status_code == 200
        prof_json = prof_resp.get_json()["profile"]
        assert prof_json["protocol"] == "threads"
        assert prof_json["url"] == "https://www.threads.net/@shinybags.plus"
        assert prof_json["threadsLimited"] is True

        foreign_st = client.get("/api/social/accounts/shinybags.plus/statuses?protocol=threads")
        assert foreign_st.status_code == 200
        assert foreign_st.get_json()["items"] == []

        own_st = client.get("/api/social/accounts/29797930329813883/statuses?protocol=threads&acct=davyrhodes_")
        assert own_st.status_code == 200
        assert len(own_st.get_json()["items"]) == 1

        # PUT /api/social/posts/<id> with replace_bridges replaces Bluesky & Threads copies
        agg_calls.clear()
        edit_resp = client.put("/api/social/posts/m_agg_99", json={"text": "Updated across all", "replace_bridges": True})
        assert edit_resp.status_code == 200
        edited_json = edit_resp.get_json()["item"]
        assert edited_json["_meta"]["linkedIds"]["threadsPostId"] == "th_replaced_1"
        assert edited_json["_meta"]["linkedIds"]["blueskyUri"] == "at://did:plc:davy/app.bsky.feed.post/replaced1"
        assert ("threads", "DELETE", "/v1.0/th_linked_1") in agg_calls
        assert ("threads", "POST", "/v1.0/29797930329813883/threads_publish") in agg_calls
        assert ("bluesky", "POST", "/xrpc/com.atproto.repo.deleteRecord") in agg_calls
        assert ("bluesky", "POST", "/xrpc/com.atproto.repo.createRecord") in agg_calls

        # 9c. Link previews, SSRF rejection, outbound embeds, and Threads export archive importer
        import io
        import json
        import zipfile
        from social.link_preview import extract_first_https_url, fetch_link_preview, parse_video_embed
        from social.threads_import import build_mastodon_csv, decode_meta_mojibake, parse_threads_export_zip

        assert extract_first_https_url("Check https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB!") == "https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB"
        v_info = parse_video_embed("https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB")
        assert v_info and v_info["provider"] == "youtube" and v_info["videoId"] == "j_wrosWPRTc"

        for bad_ssrf in ("https://127.0.0.1/secret", "https://10.0.0.5/internal", "http://localhost:5000/api", "https://node.local/x"):
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
                    json={"title": "Workers Anthem", "author_name": "Solidarity", "provider_name": "YouTube", "thumbnail_url": "https://i.ytimg.com/vi/j_wrosWPRTc/hqdefault.jpg"},
                )
            if request.url.host == "article.example":
                return httpx.Response(
                    200,
                    headers={"content-type": "text/html; charset=utf-8"},
                    text='<html><head><meta property="og:title" content="Deep Dive"><meta property="og:description" content="Analysis"><meta property="og:image" content="/thumb.png"></head></html>',
                )
            return httpx.Response(404, json={})

        pv_client = httpx.Client(transport=httpx.MockTransport(_preview_handler))
        yt_card = fetch_link_preview("https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB", http_client=pv_client)
        assert yt_card and yt_card["title"] == "Workers Anthem" and yt_card["embedUrl"].startswith("https://www.youtube-nocookie.com/embed/j_wrosWPRTc")
        art_card = fetch_link_preview("https://article.example/post", http_client=pv_client)
        assert art_card and art_card["title"] == "Deep Dive" and art_card["image"] == "https://article.example/thumb.png"

        def _embed_bsky_handler(request: httpx.Request) -> httpx.Response:
            if request.url.host == "i.ytimg.com":
                return httpx.Response(200, headers={"content-type": "image/jpeg"}, content=b"JPGDATA")
            if request.url.path == "/xrpc/com.atproto.repo.uploadBlob":
                return httpx.Response(200, json={"blob": {"$type": "blob", "ref": {"$link": "bafkthumb"}}})
            if request.url.path == "/xrpc/com.atproto.repo.createRecord":
                body = json.loads(request.content.decode("utf-8"))
                agg_calls.append(("bsky_record", body["record"].get("embed")))
                return httpx.Response(200, json={"uri": "at://did:plc:davy/app.bsky.feed.post/emb1", "cid": "cid_emb1"})
            return httpx.Response(200, json={})

        def _embed_threads_handler(request: httpx.Request) -> httpx.Response:
            raw_body = request.content.decode("utf-8", errors="ignore")
            if request.url.path.endswith("/threads"):
                agg_calls.append(("threads_create", raw_body))
                return httpx.Response(200, json={"id": "th_c_emb"})
            if request.url.path.endswith("/threads_publish"):
                return httpx.Response(200, json={"id": "th_pub_emb"})
            return httpx.Response(200, json={})

        agg_engine.get_bluesky_adapter = lambda *a, **kw: BlueskyAdapter(
            service_url="https://bsky.social",
            did="did:plc:davy",
            handle="davy.bsky.social",
            access_jwt="b_jwt",
            http_client=httpx.Client(transport=httpx.MockTransport(_embed_bsky_handler)),
        )
        agg_engine.get_threads_adapter = lambda *a, **kw: ThreadsAdapter(
            user_id="29797930329813883",
            access_token="t_tok",
            username="davyrhodes_",
            http_client=httpx.Client(transport=httpx.MockTransport(_embed_threads_handler)),
        )
        agg_calls.clear()
        pub_emb = agg_engine.publish_unified(draft="Watch this", link_card=yt_card)
        assert pub_emb["items"][0]["_meta"]["linkCard"]["title"] == "Workers Anthem"
        bsky_embeds = [c[1] for c in agg_calls if c[0] == "bsky_record"]
        assert len(bsky_embeds) == 1 and bsky_embeds[0]["$type"] == "app.bsky.embed.external"
        assert bsky_embeds[0]["external"]["thumb"]["ref"]["$link"] == "bafkthumb"
        th_forms = [c[1] for c in agg_calls if c[0] == "threads_create"]
        assert any("link_attachment=" in f for f in th_forms)

        # Bluesky native video + quote post normalization
        from social.core.schema.unified_item import normalize_bluesky_post
        bsky_vid_item = normalize_bluesky_post({
            "post": {
                "uri": "at://did:plc:lzsxyxqebfmpx6jia6wjqgtx/app.bsky.feed.post/vid1",
                "cid": "bafy_vid",
                "author": {"did": "did:plc:lzsxyxqebfmpx6jia6wjqgtx", "handle": "jonathanslater.bsky.social", "displayName": "Jonathan Slater"},
                "record": {"text": "These two are awesome", "createdAt": "2026-11-19T13:05:50Z"},
                "embed": {
                    "$type": "app.bsky.embed.recordWithMedia#view",
                    "media": {
                        "$type": "app.bsky.embed.video#view",
                        "cid": "bafk_vid_cid",
                        "playlist": "https://video.bsky.app/watch/did%3Aplc%3Alzs/bafk_vid_cid/playlist.m3u8",
                        "thumbnail": "https://video.bsky.app/watch/did%3Aplc%3Alzs/bafk_vid_cid/thumbnail.jpg",
                        "aspectRatio": {"width": 576, "height": 1024},
                        "presentation": "default",
                    },
                    "record": {
                        "record": {
                            "$type": "app.bsky.embed.record#viewRecord",
                            "uri": "at://did:plc:orig/app.bsky.feed.post/q1",
                            "cid": "bafy_q1",
                            "author": {"did": "did:plc:orig", "handle": "orig.bsky.social", "displayName": "Orig"},
                            "value": {"text": "Quoted text", "createdAt": "2026-11-19T12:00:00Z"},
                        }
                    },
                },
            }
        })
        assert len(bsky_vid_item["attachments"]) == 1
        assert bsky_vid_item["attachments"][0]["type"] == "video"
        assert bsky_vid_item["attachments"][0]["width"] == 576 and bsky_vid_item["attachments"][0]["height"] == 1024
        assert "cid=bafk_vid_cid" in bsky_vid_item["attachments"][0]["url"]
        assert bsky_vid_item["_meta"]["quotePost"]["authorHandle"] == "orig.bsky.social"
        assert bsky_vid_item["_meta"]["quotePost"]["text"] == "Quoted text"

        # Build test Threads export ZIP covering mojibake, _-prefixed handles, mutuals, blocks, mutes
        zip_buf = io.BytesIO()
        with zipfile.ZipFile(zip_buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("threads/followers.json", json.dumps({
                "text_post_app_text_post_app_followers": [
                    {"title": "Jos\u00c3\u00a9", "string_list_data": [{"value": "_jaoga_", "timestamp": 100}]},
                    {"title": "Mutual Peer", "string_list_data": [{"value": "mutual_peer", "timestamp": 101}]},
                ]
            }))
            zf.writestr("threads/following.json", json.dumps({
                "text_post_app_text_post_app_following": [
                    {"title": "", "string_list_data": [{"value": "mutual_peer", "timestamp": 102}]},
                    {"title": "", "string_list_data": [{"value": "only_following", "timestamp": 103}]},
                ]
            }))
            zf.writestr("threads/blocked_profiles.json", json.dumps([
                {"timestamp": 200, "label_values": [{"label": "Name", "value": "Bad Bot"}, {"label": "Username", "value": "bad_troll"}]}
            ]))
            zf.writestr("threads/restricted_profiles.json", json.dumps([
                {"timestamp": 201, "label_values": [{"label": "Name", "value": "Noisy"}, {"label": "Username", "value": "noisy_acct"}]}
            ]))

        assert decode_meta_mojibake("Jos\u00c3\u00a9") == "José"
        parsed_zip = parse_threads_export_zip(zip_buf.getvalue(), source_name="unit.zip")
        assert parsed_zip["counts"] == {"mutuals": 1, "following": 2}
        assert parsed_zip["mutuals"][0]["displayName"] == "Mutual Peer"
        csv_m = build_mastodon_csv("mutuals", parsed_zip["mutuals"])
        assert "Account address,Show boosts,Notify on new posts,Languages" in csv_m
        assert "mutual_peer@threads.net,true,false," in csv_m

        parse_resp = client.post(
            "/api/social/threads/import-parse",
            data={"file": (io.BytesIO(zip_buf.getvalue()), "threads-export.zip")},
            content_type="multipart/form-data",
        )
        assert parse_resp.status_code == 200
        assert parse_resp.get_json()["counts"] == {"mutuals": 1, "following": 2}

        mod_blocks = client.get("/api/social/moderation/blocks")
        assert mod_blocks.status_code == 200
        assert not any(a.get("username") == "bad_troll" and a.get("protocol") == "threads" for a in mod_blocks.get_json()["accounts"])

        csv_resp = client.get("/api/social/threads/import-csv/following")
        assert csv_resp.status_code == 200
        assert "only_following@threads.net,true,false," in csv_resp.get_data(as_text=True)
        assert client.get("/api/social/threads/import-csv/blocks").status_code == 400

        class _ImportMastoFake(FakeMastodonAdapter):
            def lookup_account(self, acct):
                if acct == "mutual_peer@threads.net":
                    return {"id": "fed_mp_1", "username": "mutual_peer", "acct": "mutual_peer@threads.net"}
                if acct == "only_following@threads.net":
                    return {"id": "fed_local_wrong", "username": "only_following", "acct": "only_following@other.example"}
                return None

            def follow_account(self, aid, undo=False):
                self.calls.append(("follow", aid, undo))
                return {"id": aid, "following": not undo}

        imp_masto = _ImportMastoFake()
        agg_engine.get_mastodon_adapter = lambda *a, **kw: imp_masto
        sync_resp = client.post(
            "/api/social/threads/import-sync",
            json={"followScope": "following", "delaySec": 0},
        )
        assert sync_resp.status_code == 200
        import time as _time
        for _ in range(40):
            st = client.get("/api/social/threads/import-state").get_json()["job"]
            if st["status"] != "running":
                break
            _time.sleep(0.02)
        assert st["status"] == "completed"
        assert st["followed"] == 1 and st["notFederated"] == 1
        assert ("follow", "fed_mp_1", False) in imp_masto.calls

        # 9c. Aggregated notifications, Threads insights watermarks, dismiss, clear & seen endpoints
        class _ActMastoFake(FakeMastodonAdapter):
            def __init__(self):
                super().__init__()
                self.dismissed_ids = []
                self.cleared = 0

            def fetch_notifications(self, cursor="", limit=30):
                return [
                    {
                        "id": "mastodon:notif:act_m1",
                        "protocol": "mastodon",
                        "url": "https://mastodon.social/@davy/m_act_py",
                        "content_html": "<p>Unified crosspost</p>",
                        "content_text": "Unified crosspost",
                        "date_published": "2026-11-19T10:00:00Z",
                        "author": {"id": "a1", "name": "Fan1", "handle": "fan1@mastodon.social", "avatar_url": ""},
                        "attachments": [],
                        "metrics": {"likes": 2, "reposts": 1, "replies": 1},
                        "_meta": {
                            "mastodon": {"statusId": "m_act_py", "instanceUrl": "https://mastodon.social"},
                            "notification": {
                                "notifId": "act_m1",
                                "type": "like",
                                "actor": {"id": "a1", "name": "Fan1", "handle": "fan1@mastodon.social"},
                            },
                        },
                    }
                ]

            def dismiss_notification(self, notif_id):
                self.dismissed_ids.append(notif_id)
                return True

            def clear_notifications(self):
                self.cleared += 1
                return True

        class _ActBskyFake(FakeBlueskyAdapter):
            def __init__(self):
                super().__init__()
                self.seen_calls = 0

            def fetch_notifications(self, cursor="", limit=30):
                return [
                    {
                        "id": "bluesky:notif:act_b1:like",
                        "protocol": "bluesky",
                        "url": "https://bsky.app/profile/davy/post/b_act_py",
                        "content_html": "<p>Unified crosspost</p>",
                        "content_text": "Unified crosspost",
                        "date_published": "2026-11-19T10:01:00Z",
                        "author": {"id": "did:plc:fanb", "name": "FanB", "handle": "fanb.bsky.social", "avatar_url": ""},
                        "attachments": [],
                        "metrics": {"likes": 3, "reposts": 1, "replies": 0},
                        "_meta": {
                            "bluesky": {"uri": "at://did:plc:me/app.bsky.feed.post/b_act_py", "subjectUri": "at://did:plc:me/app.bsky.feed.post/b_act_py"},
                            "notification": {
                                "notifId": "bsky:act_b1",
                                "type": "like",
                                "targetPostUri": "at://did:plc:me/app.bsky.feed.post/b_act_py",
                                "targetMetrics": {"likes": 3, "reposts": 1, "replies": 0},
                                "actor": {"id": "did:plc:fanb", "name": "FanB", "handle": "fanb.bsky.social"},
                            },
                        },
                    }
                ]

            def get_posts_metrics(self, uris):
                return {"at://did:plc:me/app.bsky.feed.post/b_act_py": {"likes": 3, "reposts": 1, "replies": 0}}

            def update_notifications_seen(self, seen_at=""):
                self.seen_calls += 1
                return True

        class _ActThreadsFake:
            def __init__(self):
                self.likes = 4

            def fetch_notifications(self, cursor="", limit=20, tracked_post_ids=None):
                return []

            def get_post_insights(self, post_id):
                if post_id == "th_act_py":
                    return {"likes": self.likes, "reposts": 1, "replies": 2}
                return {"likes": 0, "reposts": 0, "replies": 0}

        act_masto = _ActMastoFake()
        act_bsky = _ActBskyFake()
        act_thr = _ActThreadsFake()
        act_store = SocialSQLiteStore(Path(tmpdir) / "activity_test.db")
        act_store.save_linked_post(
            canonical_id="mastodon:m_act_py",
            mastodon_status_id="m_act_py",
            mastodon_instance="https://mastodon.social",
            bluesky_uri="at://did:plc:me/app.bsky.feed.post/b_act_py",
            bluesky_cid="cid_act_py",
            threads_post_id="th_act_py",
        )
        act_engine = SocialSyncEngine(store=act_store, keychain=agg_engine.keychain, enable_streaming=False)
        act_engine.get_mastodon_adapter = lambda *a, **kw: act_masto
        act_engine.get_bluesky_adapter = lambda *a, **kw: act_bsky
        act_engine.get_threads_adapter = lambda *a, **kw: act_thr
        set_social_engine_for_tests(act_engine)

        n_resp = client.get("/api/social/notifications")
        assert n_resp.status_code == 200
        n_items = n_resp.get_json()["items"]
        assert len(n_items) == 4  # Mastodon like, Bluesky like, Threads insights like (4), Threads insights repost (1)
        m_like = next(i for i in n_items if i["id"] == "mastodon:notif:act_m1")
        assert m_like["metrics"]["likes"] == 9  # 2 Masto + 3 Bsky + 4 Threads
        assert m_like["_meta"]["notification"]["canonicalPostKey"] == "mastodon:m_act_py"

        d_resp = client.post(
            "/api/social/notifications/dismiss",
            json={
                "ids": ["mastodon:notif:act_m1", "bluesky:notif:act_b1:like", "threads:notif:likes:th_act_py"],
                "mastodonNotifIds": ["act_m1"],
                "threadsWatermarks": {"th_act_py": {"likes": 4}},
            },
        )
        assert d_resp.status_code == 200
        assert act_masto.dismissed_ids == ["act_m1"]

        after_dismiss = client.get("/api/social/notifications").get_json()["items"]
        assert [i["id"] for i in after_dismiss] == ["threads:notif:reposts:th_act_py"]

        act_thr.likes = 6
        after_bump = client.get("/api/social/notifications").get_json()["items"]
        bump_likes = next(i for i in after_bump if i["id"] == "threads:notif:likes:th_act_py")
        assert bump_likes["_meta"]["notification"]["aggregateCount"] == 2

        s_resp = client.post("/api/social/notifications/seen", json={})
        assert s_resp.status_code == 200 and act_bsky.seen_calls == 1

        c_resp = client.post("/api/social/notifications/clear", json={"threadsWatermarks": {"th_act_py": {"likes": 6, "reposts": 1}}})
        assert c_resp.status_code == 200 and act_masto.cleared == 1
        assert client.get("/api/social/notifications").get_json()["items"] == []

        # 9d. Threads delete error precision (403 vs 400 subcode 33), overflow split linking, edit_unified & auto-drain
        def _del_handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/v1.0/th_perm_403") and request.method == "DELETE":
                return httpx.Response(403, json={"error": {"message": "No perm", "code": 10}})
            if request.url.path.endswith("/v1.0/th_gone_33") and request.method == "DELETE":
                return httpx.Response(400, json={"error": {"message": "Missing", "code": 100, "error_subcode": 33}})
            if request.url.path.endswith("/v1.0/th_gone_33") and request.method == "GET":
                return httpx.Response(404, json={"error": {"message": "Not found"}})
            if request.url.path.endswith("/v1.0/th_live_33") and request.method == "DELETE":
                return httpx.Response(400, json={"error": {"message": "Missing perm", "code": 100, "error_subcode": 33}})
            if request.url.path.endswith("/v1.0/th_live_33") and request.method == "GET":
                return httpx.Response(200, json={"id": "th_live_33"})
            if request.url.path == "/v1.0/me":
                return httpx.Response(200, json={"id": "th_drain_u", "username": "drain_u"})
            return httpx.Response(404, json={})

        del_th = ThreadsAdapter(user_id="th_u", access_token="tok", http_client=httpx.Client(transport=httpx.MockTransport(_del_handler)))
        try:
            del_th.delete({"postId": "th_perm_403"})
            raise AssertionError("Expected threads_delete error on 403")
        except RuntimeError as exc:
            assert "threads_delete" in str(exc)
        assert del_th.delete({"postId": "th_gone_33"}) is True
        try:
            del_th.delete({"postId": "th_live_33"})
            raise AssertionError("Expected threads_delete error when object still exists")
        except RuntimeError as exc:
            assert "threads_delete" in str(exc)

        class _BrMasto(FakeMastodonAdapter):
            def edit_status(self, status_id, draft, spoiler_text=""):
                return {
                    "id": f"mastodon:{status_id}",
                    "protocol": "mastodon",
                    "url": f"https://mastodon.social/@davy/{status_id}",
                    "content_text": draft,
                    "content_html": f"<p>{draft}</p>",
                    "date_published": "2026-11-19T12:00:00Z",
                    "author": {"id": "42", "name": "Davy", "handle": "davy@mastodon.social"},
                    "attachments": [],
                    "metrics": {"replies": 0, "reposts": 0, "likes": 0},
                    "_meta": {"mastodon": {"statusId": status_id, "visibility": "public"}},
                }

        class _BrThreads(FailingThreadsAdapter):
            def __init__(self):
                super().__init__(fail_publish=False)
                self.fail_delete = False
                self.pub_n = 0

            def publish(self, draft, media=None, options=None):
                self.pub_n += 1
                self.calls.append(("publish", draft, options))
                return {
                    "id": f"threads:th_r_{self.pub_n}",
                    "protocol": "threads",
                    "content_text": draft,
                    "content_html": f"<p>{draft}</p>",
                    "date_published": "2026-11-19T12:00:02Z",
                    "author": {"id": "th_drain_u", "name": "drain_u", "handle": "drain_u"},
                    "attachments": [],
                    "metrics": {"replies": 0, "reposts": 0, "likes": 0},
                    "_meta": {"threads": {"postId": f"th_r_{self.pub_n}"}},
                }

            def delete(self, native_meta):
                if self.fail_delete:
                    raise RuntimeError("Threads token lacks 'threads_delete' permission")
                return super().delete(native_meta)

        br_store = SocialSQLiteStore(Path(tmpdir) / "bridge_audit.db")
        br_masto = _BrMasto()
        br_bsky = FakeBlueskyAdapter()
        br_thr = _BrThreads()
        br_engine = SocialSyncEngine(
            store=br_store,
            keychain=agg_engine.keychain,
            mastodon_adapter_factory=lambda inst, tok: br_masto,
            bluesky_adapter_factory=lambda **kw: br_bsky,
            threads_adapter_factory=lambda **kw: br_thr,
            on_profile_sync=lambda p: None,
            enable_streaming=False,
        )
        br_store.upsert_account(account_id="mastodon:davy", protocol="mastodon", instance_url="https://mastodon.social", handle="davy", is_primary=True, meta={"userId": "42"})
        agg_engine.keychain.set_secret("mastodon:davy", {"accessToken": "m_tok"})
        br_store.upsert_account(account_id="bluesky:did:plc:davy", protocol="bluesky", instance_url="https://bsky.social", handle="davy.bsky.social", is_primary=True, meta={"did": "did:plc:davy"})
        agg_engine.keychain.set_secret("bluesky:did:plc:davy", {"accessJwt": "b_j", "refreshJwt": "b_r"})
        br_store.upsert_account(account_id="threads:th_drain_u", protocol="threads", handle="drain_u", is_primary=True, meta={"userId": "th_drain_u"})
        agg_engine.keychain.set_secret("threads:th_drain_u", {"accessToken": "t_tok"})

        long_draft = ("word " * 72).strip() + " fin"
        pub_split = br_engine.publish_unified(draft=long_draft)
        split_grp = br_store.find_linked_post_group(pub_split["items"][0]["id"])
        assert len(split_grp) == 2  # Root + overflow :part:1 child

        br_thr.fail_delete = True
        br_bsky.calls.clear()
        edited = br_engine.edit_unified(pub_split["items"][0]["id"], "Edited https://example.org/post", replace_bridges=True)
        assert any("threads_delete" in w for w in (edited["_meta"].get("bridgeWarnings") or []))
        assert edited["_meta"]["linkedIds"]["threadsPostId"] == "th_r_1"
        assert len([c for c in br_bsky.calls if c[0] == "delete"]) == 2  # Both split chunks deleted before republish!

        del_res = br_engine.delete_unified(pub_split["items"][0]["id"])
        assert any("threads_delete" in w for w in del_res["warnings"])
        assert len([r for r in br_store.list_retries() if r["protocol"] == "threads"]) == 1

        br_thr.fail_delete = False
        orig_verify = ThreadsAdapter.verify_credentials
        try:
            ThreadsAdapter.verify_credentials = staticmethod(lambda tok: {"id": "th_drain_u", "username": "drain_u", "name": "Drain"})
            drained_status = br_engine.connect_threads("fresh_tok_with_delete")
            assert len([r for r in drained_status["retryQueue"] if r["protocol"] == "threads"]) == 0
        finally:
            ThreadsAdapter.verify_credentials = orig_verify

        set_social_engine_for_tests(agg_engine)

        # 10. Verify runners/ and tools/ never import social/
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
