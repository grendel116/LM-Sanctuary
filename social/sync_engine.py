"""Sync engine coordinating Mastodon primary actions, automatic bridges, SQLite cache, and SSE updates."""

from __future__ import annotations

import queue
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from social.adapters.bluesky.adapter import BlueskyAdapter, DEFAULT_BSKY_SERVICE
from social.adapters.mastodon.adapter import MastodonAdapter
from social.adapters.mastodon.streaming import MastodonStreamWorker
from social.adapters.threads.adapter import DEFAULT_THREADS_SCOPES, ThreadsAdapter
from social.core.schema.unified_item import (
    ORIGIN_PROTOCOLS,
    deduplicate_unified_items,
    is_allowed_social_url,
    normalize_instance_url,
    parse_iso_ts,
    plain_text_to_html,
)
from social.link_preview import extract_first_https_url, fetch_link_preview, fetch_public_image_bytes
from social.storage.keychain import KeychainStore
from social.storage.sqlite_store import SocialSQLiteStore
from social.threads_import import ThreadsImportJobRunner


def _default_sanctuary_profile_sync(profile: dict[str, Any]) -> None:
    """Sync token-free public Mastodon profile snapshot into sanctuary/variables/user_profiles/."""
    try:
        from routes.programs import sync_mastodon_profile_markdown
        sync_mastodon_profile_markdown(profile)
    except Exception:
        # Allowed to no-op when social/ runs isolated from Flask sanctuary routes
        pass


def split_text_for_limit(text: str, max_len: int) -> list[str]:
    """Split text cleanly at word/newline boundaries so bridges respect tight character limits."""
    raw = str(text or "").strip()
    if not raw or len(raw) <= max_len:
        return [raw] if raw else []
    chunks: list[str] = []
    remaining = raw
    while len(remaining) > max_len:
        window = remaining[: max_len + 1]
        cut = max(window.rfind("\n"), window.rfind(" "))
        if cut < int(max_len * 0.45):
            cut = max_len
        chunks.append(remaining[:cut].rstrip())
        remaining = remaining[cut:].lstrip()
    if remaining:
        chunks.append(remaining)
    return chunks


class SocialSyncEngine:
    """Local Mastodon-first coordinator with concurrent automatic Bluesky & Threads bridging."""

    def __init__(
        self,
        *,
        store: SocialSQLiteStore | None = None,
        keychain: KeychainStore | None = None,
        mastodon_adapter_factory: Callable[[str, str], MastodonAdapter] | None = None,
        bluesky_adapter_factory: Callable[..., BlueskyAdapter] | None = None,
        threads_adapter_factory: Callable[..., ThreadsAdapter] | None = None,
        on_profile_sync: Callable[[dict[str, Any]], None] | None = None,
        enable_streaming: bool = True,
    ) -> None:
        self.store = store or SocialSQLiteStore()
        self.keychain = keychain or KeychainStore()
        self._masto_factory = mastodon_adapter_factory or (lambda inst, tok: MastodonAdapter(inst, tok))
        self._bsky_factory = bluesky_adapter_factory or (lambda **kw: BlueskyAdapter(**kw))
        self._threads_factory = threads_adapter_factory or (lambda **kw: ThreadsAdapter(**kw))
        self._on_profile_sync = on_profile_sync or _default_sanctuary_profile_sync
        self._enable_streaming = enable_streaming

        self._stream_worker: MastodonStreamWorker | None = None
        self._sse_lock = threading.Lock()
        self._sse_subscribers: list[queue.Queue[dict[str, Any]]] = []
        self.threads_import_runner = ThreadsImportJobRunner()

    # ── SSE Event Hub ────────────────────────────────────────────────────

    def subscribe_events(self) -> queue.Queue[dict[str, Any]]:
        q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=64)
        with self._sse_lock:
            self._sse_subscribers.append(q)
        return q

    def unsubscribe_events(self, q: queue.Queue[dict[str, Any]]) -> None:
        with self._sse_lock:
            self._sse_subscribers = [sub for sub in self._sse_subscribers if sub is not q]

    def publish_event(self, event_type: str, data: Any) -> None:
        payload = {"type": event_type, "data": data}
        with self._sse_lock:
            for sub in list(self._sse_subscribers):
                try:
                    sub.put_nowait(payload)
                except queue.Full:
                    pass

    # ── Connection State & Adapters ──────────────────────────────────────

    def status(self) -> dict[str, Any]:
        accounts = self.store.list_accounts()
        primary_masto = self.store.get_primary_account("mastodon")
        has_bsky = any(a["protocol"] == "bluesky" for a in accounts)
        has_threads = any(a["protocol"] == "threads" for a in accounts)
        return {
            "accounts": accounts,
            "isMastodonConnected": bool(primary_masto),
            "isBlueskyConnected": has_bsky,
            "isThreadsConnected": has_threads,
            "tightestCharLimit": 300 if has_bsky else 500,
            "primaryProfile": (primary_masto or {}).get("meta"),
            "retryQueue": self.store.list_retries(),
            "keychainBackend": self.keychain.backend,
        }

    def get_mastodon_adapter(self, public_instance: str = "https://mastodon.social") -> MastodonAdapter | None:
        acc = self.store.get_primary_account("mastodon")
        if not acc:
            return None
        secret = self.keychain.get_secret(acc["id"]) or {}
        token = str(secret.get("accessToken") or "")
        if not token:
            return None
        return self._masto_factory(acc.get("instanceUrl") or public_instance, token)

    def get_public_mastodon_adapter(self, instance_url: str = "https://mastodon.social") -> MastodonAdapter:
        masto = self.get_mastodon_adapter()
        if masto:
            return masto
        return self._masto_factory(normalize_instance_url(instance_url or "https://mastodon.social"), "")

    def get_bluesky_adapter(self) -> BlueskyAdapter | None:
        acc = self.store.get_primary_account("bluesky")
        if not acc:
            return None
        secret = self.keychain.get_secret(acc["id"]) or {}
        access_jwt = str(secret.get("accessJwt") or "")
        refresh_jwt = str(secret.get("refreshJwt") or "")
        if not access_jwt:
            return None

        def on_refresh(tokens: dict[str, Any]) -> None:
            merged = {**secret, **{k: v for k, v in tokens.items() if k in ("accessJwt", "refreshJwt") and v}}
            self.keychain.set_secret(acc["id"], merged)

        return self._bsky_factory(
            service_url=acc.get("instanceUrl") or DEFAULT_BSKY_SERVICE,
            did=(acc.get("meta") or {}).get("did") or acc["id"].removeprefix("bluesky:"),
            handle=acc.get("handle") or "",
            access_jwt=access_jwt,
            refresh_jwt=refresh_jwt,
            on_session_refreshed=on_refresh,
        )

    def get_threads_adapter(self) -> ThreadsAdapter | None:
        acc = self.store.get_primary_account("threads")
        if not acc:
            return None
        secret = self.keychain.get_secret(acc["id"]) or {}
        token = str(secret.get("accessToken") or "")
        uid = str((acc.get("meta") or {}).get("userId") or acc["id"].removeprefix("threads:"))
        if not token or not uid:
            return None

        issued_at = float(secret.get("issuedAt") or 0)
        expires_at = float(secret.get("expiresAt") or 0)
        now = time.time()
        if (
            issued_at > 0
            and expires_at > 0
            and (now - issued_at) >= 86400
            and (now >= expires_at - 45 * 86400 or (now - issued_at) >= 7 * 86400)
        ):
            try:
                refreshed = ThreadsAdapter.refresh_long_lived_token(access_token=token)
                new_token = str(refreshed.get("access_token") or "")
                new_exp = int(refreshed.get("expires_in") or 5184000)
                if new_token:
                    token = new_token
                    self.keychain.set_secret(
                        acc["id"],
                        {**secret, "accessToken": new_token, "issuedAt": now, "expiresAt": now + new_exp},
                    )
            except Exception:
                pass

        return self._threads_factory(
            user_id=uid,
            access_token=token,
            username=acc.get("handle") or "",
            display_name=acc.get("displayName") or "",
            avatar_url=acc.get("avatarUrl") or "",
        )

    def _start_streaming_if_enabled(self) -> None:
        if not self._enable_streaming:
            return
        acc = self.store.get_primary_account("mastodon")
        if not acc:
            return
        secret = self.keychain.get_secret(acc["id"]) or {}
        token = str(secret.get("accessToken") or "")
        if not token:
            return
        self.stop_streaming()

        def handle_update(item: dict[str, Any]) -> None:
            self.store.save_timeline_items("home", [item], replace=False)
            self.publish_event("update", item)

        def handle_delete(status_id: str) -> None:
            self.store.remove_cached_item(status_id)
            self.publish_event("delete", {"id": f"mastodon:{status_id}", "statusId": status_id})

        def handle_notif(notif: dict[str, Any]) -> None:
            self.store.save_notifications([notif], replace=False)
            self.publish_event("notification", notif)

        self._stream_worker = MastodonStreamWorker(
            instance_url=acc.get("instanceUrl") or "https://mastodon.social",
            access_token=token,
            on_update=handle_update,
            on_delete=handle_delete,
            on_notification=handle_notif,
        )
        self._stream_worker.start()

    def stop_streaming(self) -> None:
        if self._stream_worker is not None:
            self._stream_worker.stop()
            self._stream_worker = None

    # ── Authentication & Profile Updates ─────────────────────────────────

    def _collect_recent_own_posts(
        self,
        masto: Any,
        account_id_num: str = "",
        fresh_items: list[dict[str, Any]] | None = None,
    ) -> list[dict[str, str]]:
        """Collect up to 3 recent non-boost own Mastodon posts (plain text + timestamp)."""
        candidates: list[dict[str, Any]] = list(fresh_items or [])
        if masto and account_id_num and hasattr(masto, "fetch_account_statuses"):
            try:
                fetched = masto.fetch_account_statuses(account_id_num, tab="posts", limit=6)
                if isinstance(fetched, list):
                    candidates.extend(fetched)
            except Exception:
                pass

        posts: list[dict[str, str]] = []
        seen_texts: set[str] = set()
        for item in candidates:
            if not isinstance(item, dict):
                continue
            masto_meta = (item.get("_meta") or {}).get("mastodon") or {}
            if masto_meta.get("rebloggedBy") or item.get("reblog"):
                continue
            text = str(item.get("content_text") or "").strip()
            if not text or text in seen_texts:
                continue
            seen_texts.add(text)
            created_at = str(item.get("date_published") or "").strip()
            posts.append({"text": text, "created_at": created_at})
            if len(posts) >= 3:
                break
        return posts

    def _sync_sanctuary_profile_snapshot(
        self,
        masto: Any = None,
        profile: dict[str, Any] | None = None,
        *,
        fresh_items: list[dict[str, Any]] | None = None,
    ) -> None:
        acc = self.store.get_primary_account("mastodon")
        prof = dict(profile or (acc or {}).get("meta") or {})
        if not prof:
            return
        instance_url = getattr(masto, "instance_url", "") or (acc or {}).get("instanceUrl") or ""
        if instance_url:
            prof["instance_url"] = instance_url
        if masto is not None or fresh_items is not None:
            prof["recent_posts"] = self._collect_recent_own_posts(
                masto,
                str(prof.get("id") or ""),
                fresh_items=fresh_items,
            )
        self._on_profile_sync(prof)

    def start_mastodon_oauth(
        self,
        instance_url: str = "https://mastodon.social",
        redirect_uri: str = "urn:ietf:wg:oauth:2.0:oob",
    ) -> dict[str, Any]:
        origin = normalize_instance_url(instance_url or "https://mastodon.social")
        cached = self.store.get_oauth_client(origin)
        client_secret_rec = self.keychain.get_secret(f"oauth:{origin}") if cached else None
        adapter = self._masto_factory(origin, "")
        if not cached or not client_secret_rec or cached.get("redirect_uri") != redirect_uri:
            app_info = adapter.register_oauth_app(redirect_uri=redirect_uri, scopes="read write follow push")
            client_id = str(app_info.get("client_id") or "")
            client_secret = str(app_info.get("client_secret") or "")
            self.store.save_oauth_client(origin, client_id, redirect_uri, "read write follow push")
            self.keychain.set_secret(f"oauth:{origin}", {"clientSecret": client_secret})
        else:
            client_id = cached["client_id"]
        auth_url = adapter.build_authorize_url(client_id=client_id, redirect_uri=redirect_uri, scope="read write follow push")
        return {"instanceUrl": origin, "clientId": client_id, "redirectUri": redirect_uri, "authorizeUrl": auth_url}

    def finish_mastodon_oauth(self, instance_url: str, code: str, redirect_uri: str = "") -> dict[str, Any]:
        origin = normalize_instance_url(instance_url or "https://mastodon.social")
        cached = self.store.get_oauth_client(origin)
        secret_rec = self.keychain.get_secret(f"oauth:{origin}") or {}
        if not cached or not secret_rec.get("clientSecret"):
            raise RuntimeError(f"OAuth app not registered for {origin}")
        adapter = self._masto_factory(origin, "")
        tok = adapter.exchange_oauth_code(
            client_id=cached["client_id"],
            client_secret=secret_rec["clientSecret"],
            redirect_uri=redirect_uri or cached["redirect_uri"],
            code=code,
        )
        return self.connect_mastodon_token(origin, tok.get("access_token") or "")

    def connect_mastodon_token(self, instance_url: str, access_token: str) -> dict[str, Any]:
        origin = normalize_instance_url(instance_url or "https://mastodon.social")
        adapter = self._masto_factory(origin, access_token)
        profile = adapter.verify_credentials()
        account_id = f"mastodon:{profile['acct']}"
        self.keychain.set_secret(account_id, {"accessToken": access_token})
        self.store.upsert_account(
            account_id=account_id,
            protocol="mastodon",
            instance_url=origin,
            handle=profile["acct"],
            display_name=profile["display_name"],
            avatar_url=profile["avatar_url"],
            is_primary=True,
            meta=profile,
        )
        self._sync_sanctuary_profile_snapshot(adapter, profile)
        self._start_streaming_if_enabled()
        self.publish_event("auth_update", self.status())
        return self.status()

    def connect_bluesky(self, identifier: str, password: str, service_url: str = DEFAULT_BSKY_SERVICE) -> dict[str, Any]:
        sess = BlueskyAdapter.create_session(identifier, password, service_url=service_url)
        account_id = f"bluesky:{sess['did']}"
        self.keychain.set_secret(account_id, {"accessJwt": sess["accessJwt"], "refreshJwt": sess["refreshJwt"]})
        self.store.upsert_account(
            account_id=account_id,
            protocol="bluesky",
            instance_url=sess["service_url"],
            handle=sess["handle"],
            display_name=sess["displayName"],
            avatar_url=sess["avatar"],
            is_primary=True,
            meta={"did": sess["did"]},
        )
        self._drain_protocol_retries("bluesky")
        self.publish_event("auth_update", self.status())
        return self.status()

    def start_threads_oauth(
        self,
        *,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        scope: str = DEFAULT_THREADS_SCOPES,
        state: str = "",
    ) -> dict[str, Any]:
        cid = str(client_id or "").strip()
        csec = str(client_secret or "").strip()
        ruri = str(redirect_uri or "").strip()
        if not cid or not csec or not ruri:
            raise ValueError("Threads App ID, App Secret, and Redirect URI are required")
        self.store.save_oauth_client("https://threads.net", cid, ruri, scope or DEFAULT_THREADS_SCOPES)
        self.keychain.set_secret("oauth:threads", {"clientId": cid, "clientSecret": csec})
        authorize_url = ThreadsAdapter.build_authorize_url(
            client_id=cid,
            redirect_uri=ruri,
            scope=scope or DEFAULT_THREADS_SCOPES,
            state=state,
        )
        return {"clientId": cid, "redirectUri": ruri, "authorizeUrl": authorize_url}

    def finish_threads_oauth(
        self,
        *,
        code: str,
        redirect_uri: str = "",
        client_id: str = "",
        client_secret: str = "",
    ) -> dict[str, Any]:
        cached = self.store.get_oauth_client("https://threads.net") or {}
        secret_rec = self.keychain.get_secret("oauth:threads") or {}
        cid = str(client_id or cached.get("client_id") or secret_rec.get("clientId") or "").strip()
        csec = str(client_secret or secret_rec.get("clientSecret") or "").strip()
        ruri = str(redirect_uri or cached.get("redirect_uri") or "").strip()
        if not cid or not csec or not ruri:
            raise RuntimeError("Threads OAuth App ID, App Secret, and Redirect URI must be configured")
        short_tok = ThreadsAdapter.exchange_oauth_code(
            client_id=cid,
            client_secret=csec,
            redirect_uri=ruri,
            code=code,
        )
        raw_token = str(short_tok.get("access_token") or "")
        if not raw_token:
            raise RuntimeError("Threads OAuth did not return an access_token")
        return self.connect_threads(raw_token, client_secret=csec, expires_in=0)

    def refresh_threads_token(self) -> dict[str, Any]:
        acc = self.store.get_primary_account("threads")
        if not acc:
            raise RuntimeError("Connect Threads bridge first")
        secret = self.keychain.get_secret(acc["id"]) or {}
        token = str(secret.get("accessToken") or "")
        if not token:
            raise RuntimeError("Stored Threads access token is missing")
        refreshed = ThreadsAdapter.refresh_long_lived_token(access_token=token)
        new_token = str(refreshed.get("access_token") or token)
        exp_in = int(refreshed.get("expires_in") or 5184000)
        now = time.time()
        self.keychain.set_secret(
            acc["id"],
            {**secret, "accessToken": new_token, "issuedAt": now, "expiresAt": now + exp_in},
        )
        meta = dict(acc.get("meta") or {})
        meta["expiresAt"] = int((now + exp_in) * 1000)
        self.store.upsert_account(
            account_id=acc["id"],
            protocol="threads",
            instance_url=acc.get("instanceUrl") or "https://graph.threads.net",
            handle=acc.get("handle") or "",
            display_name=acc.get("displayName") or "",
            avatar_url=acc.get("avatarUrl") or "",
            is_primary=True,
            meta=meta,
        )
        self._drain_protocol_retries("threads")
        self.publish_event("auth_update", self.status())
        return {"status": self.status(), "expiresIn": exp_in}

    def connect_threads(
        self,
        access_token: str,
        *,
        client_secret: str = "",
        expires_in: int = 0,
    ) -> dict[str, Any]:
        final_token = str(access_token or "").strip()
        resolved_exp = int(expires_in or 0)
        if client_secret and resolved_exp <= 0:
            try:
                long_tok = ThreadsAdapter.exchange_long_lived_token(
                    client_secret=client_secret,
                    access_token=final_token,
                )
                if long_tok.get("access_token"):
                    final_token = str(long_tok["access_token"])
                    resolved_exp = int(long_tok.get("expires_in") or 5184000)
            except Exception:
                # Token may already be a 60-day User Token Generator token
                pass

        me = ThreadsAdapter.verify_credentials(final_token)
        uid = str(me.get("id") or "")
        username = str(me.get("username") or uid)
        account_id = f"threads:{uid}"
        now = time.time()
        secret_rec: dict[str, Any] = {"accessToken": final_token, "issuedAt": now}
        if resolved_exp > 0:
            secret_rec["expiresAt"] = now + resolved_exp
        self.keychain.set_secret(account_id, secret_rec)
        meta: dict[str, Any] = {
            "userId": uid,
            "noteText": str(me.get("threads_biography") or ""),
            "isVerified": bool(me.get("is_verified")),
        }
        if resolved_exp > 0:
            meta["expiresAt"] = int((now + resolved_exp) * 1000)
        self.store.upsert_account(
            account_id=account_id,
            protocol="threads",
            instance_url="https://graph.threads.net",
            handle=username,
            display_name=me.get("name") or username,
            avatar_url=me.get("threads_profile_picture_url") or "",
            is_primary=True,
            meta=meta,
        )
        self._drain_protocol_retries("threads")
        self.publish_event("auth_update", self.status())
        return self.status()

    def disconnect_account(self, account_id: str) -> dict[str, Any]:
        norm_id = account_id.replace("fediverse:", "mastodon:", 1) if account_id.startswith("fediverse:") else account_id
        self.keychain.delete_secret(norm_id)
        self.keychain.delete_secret(account_id)
        self.store.delete_account(norm_id)
        self.store.delete_account(account_id)
        if not self.store.get_primary_account("mastodon"):
            self.stop_streaming()
        self.publish_event("auth_update", self.status())
        return self.status()

    def update_mastodon_profile(self, **kwargs: Any) -> dict[str, Any]:
        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Connect a primary Mastodon account first")
        updated = masto.update_credentials(**kwargs)
        acc = self.store.get_primary_account("mastodon")
        if acc:
            self.store.upsert_account(
                account_id=acc["id"],
                protocol="mastodon",
                instance_url=acc["instanceUrl"],
                handle=updated["acct"],
                display_name=updated["display_name"],
                avatar_url=updated["avatar_url"],
                is_primary=True,
                meta=updated,
            )
        self._sync_sanctuary_profile_snapshot(masto, updated)

        bsky = self.get_bluesky_adapter()
        if bsky:
            try:
                bsky_res = bsky.update_profile(
                    display_name=kwargs.get("display_name"),
                    description=kwargs.get("note"),
                    fields=kwargs.get("fields"),
                    avatar_bytes=kwargs.get("avatar_bytes"),
                    header_bytes=kwargs.get("header_bytes"),
                    remove_avatar=bool(kwargs.get("remove_avatar", False)),
                    remove_header=bool(kwargs.get("remove_header", False)),
                )
                bsky_prof = (bsky_res or {}).get("profile") or {}
                if bsky_prof.get("did"):
                    bsky_acc = self.store.get_primary_account("bluesky")
                    self.store.upsert_account(
                        account_id=(bsky_acc or {}).get("id") or f"bluesky:{bsky_prof['did']}",
                        protocol="bluesky",
                        instance_url=bsky.service_url,
                        handle=bsky_prof.get("acct") or bsky.handle,
                        display_name=bsky_prof.get("display_name") or bsky.handle,
                        avatar_url=bsky_prof.get("avatar_url") or "",
                        is_primary=False,
                        meta={**bsky_prof, "did": bsky_prof["did"], "serviceUrl": bsky.service_url},
                    )
            except Exception as exc:
                updated["_blueskySyncWarning"] = str(exc)

        return updated

    # ── Resilient Concurrent Fan-Out & Synchronized Actions ──────────────

    def publish_unified(
        self,
        *,
        draft: str,
        thread_items: list[str] | None = None,
        media: list[dict[str, Any]] | None = None,
        visibility: str = "public",
        spoiler_text: str = "",
        language: str = "en",
        link_card: dict[str, Any] | None = None,
        dismiss_link_card: bool = False,
    ) -> dict[str, Any]:
        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Mastodon account is required as the primary home")

        bsky = self.get_bluesky_adapter()
        threads = self.get_threads_adapter()

        raw_parts = [str(draft or "").strip()] + [str(t or "").strip() for t in (thread_items or []) if str(t or "").strip()]
        if not raw_parts[0] and not (media or []):
            raise ValueError("Post text or media attachment is required")

        # 1. Upload media to Mastodon once so CDN URLs can also feed Threads if needed
        masto_media_ids: list[str] = []
        masto_media_urls: list[str] = []
        raw_media = media or []
        for att in raw_media:
            if att.get("bytes"):
                up = masto.upload_media(
                    att["bytes"],
                    filename=att.get("filename") or "upload.png",
                    mime_type=att.get("mime_type") or "image/png",
                    description=att.get("alt_text") or "",
                )
                if up["id"]:
                    masto_media_ids.append(up["id"])
                if up["url"]:
                    masto_media_urls.append(up["url"])

        resolved_card: dict[str, Any] | None = None
        if not raw_media and not dismiss_link_card:
            if isinstance(link_card, dict) and str(link_card.get("url") or "").startswith("https://"):
                resolved_card = dict(link_card)
            else:
                first_url = extract_first_https_url(raw_parts[0])
                if first_url:
                    try:
                        resolved_card = fetch_link_preview(first_url)
                    except Exception:
                        resolved_card = None

        # 2. Publish primary post / thread on Mastodon first (blocking primary guarantee)
        masto_results: list[dict[str, Any]] = []
        parent_masto_id: str | None = None
        for idx, part_text in enumerate(raw_parts):
            item = masto.publish(
                part_text,
                options={
                    "visibility": visibility or "public",
                    "spoiler_text": spoiler_text if idx == 0 else "",
                    "media_ids": masto_media_ids if idx == 0 else [],
                    "in_reply_to_id": parent_masto_id,
                    "language": language,
                },
            )
            masto_results.append(item)
            parent_masto_id = item["_meta"]["mastodon"]["statusId"]

        if resolved_card and masto_results and not masto_results[0].get("_meta", {}).get("linkCard"):
            masto_results[0].setdefault("_meta", {})["linkCard"] = resolved_card

        root_masto_id = masto_results[0]["_meta"]["mastodon"]["statusId"]
        root_canonical = masto_results[0]["id"]
        linked_bsky: list[dict[str, str]] = []
        linked_threads: list[str] = []
        warnings: list[str] = []

        # 3. Concurrent non-blocking fan-out to connected Bluesky & Threads adapters
        def run_bsky_leg() -> list[dict[str, str]]:
            assert bsky is not None
            return self._publish_bluesky_segments(
                bsky,
                raw_parts,
                media=raw_media,
                resolved_card=resolved_card,
            )

        def run_threads_leg() -> list[str]:
            assert threads is not None
            return self._publish_threads_segments(
                threads,
                raw_parts,
                media=raw_media,
                masto_media_urls=masto_media_urls,
                resolved_card=resolved_card,
                visibility=visibility,
            )

        is_direct_dm = str(visibility or "public").lower() == "direct"
        if not is_direct_dm:
            with ThreadPoolExecutor(max_workers=2) as pool:
                bsky_future = pool.submit(run_bsky_leg) if bsky else None
                threads_future = pool.submit(run_threads_leg) if threads else None

                if bsky_future:
                    try:
                        linked_bsky = bsky_future.result()
                    except Exception as exc:
                        err = str(exc)
                        warnings.append(f"Bluesky bridge queued for retry: {err}")
                        self.store.enqueue_retry(
                            retry_id=f"retry_bsky_{uuid.uuid4().hex[:10]}",
                            operation="publish",
                            protocol="bluesky",
                            payload={
                                "canonicalId": root_canonical,
                                "mastodonStatusId": root_masto_id,
                                "textParts": raw_parts,
                            },
                            last_error=err,
                        )

                if threads_future:
                    try:
                        linked_threads = threads_future.result()
                    except Exception as exc:
                        err = str(exc)
                        warnings.append(f"Threads bridge queued for retry: {err}")
                        self.store.enqueue_retry(
                            retry_id=f"retry_threads_{uuid.uuid4().hex[:10]}",
                            operation="publish",
                            protocol="threads",
                            payload={
                                "canonicalId": root_canonical,
                                "mastodonStatusId": root_masto_id,
                                "textParts": raw_parts,
                                "mastodonMediaUrls": masto_media_urls,
                            },
                            last_error=err,
                        )

        # 4. Save linkedIds in SQLite immediately (including overflow split chunks)
        for idx, m_item in enumerate(masto_results):
            m_sid = m_item["_meta"]["mastodon"]["statusId"]
            bsky_ref = linked_bsky[idx] if idx < len(linked_bsky) else {}
            thr_id = linked_threads[idx] if idx < len(linked_threads) else ""
            linked = self.store.save_linked_post(
                canonical_id=m_item["id"],
                mastodon_status_id=m_sid,
                mastodon_instance=masto.instance_url,
                bluesky_uri=bsky_ref.get("uri", ""),
                bluesky_cid=bsky_ref.get("cid", ""),
                threads_post_id=thr_id,
                parent_canonical_id="" if idx == 0 else root_canonical,
            )
            m_item["_meta"]["linkedIds"] = self._clean_linked_dict(linked)

        extra_max = max(len(linked_bsky), len(linked_threads))
        for extra_idx in range(len(masto_results), extra_max):
            bsky_ref = linked_bsky[extra_idx] if extra_idx < len(linked_bsky) else {}
            thr_id = linked_threads[extra_idx] if extra_idx < len(linked_threads) else ""
            if bsky_ref.get("uri") or thr_id:
                self.store.save_linked_post(
                    canonical_id=f"{root_canonical}:part:{extra_idx}",
                    mastodon_status_id="",
                    mastodon_instance=masto.instance_url,
                    bluesky_uri=bsky_ref.get("uri", ""),
                    bluesky_cid=bsky_ref.get("cid", ""),
                    threads_post_id=thr_id,
                    parent_canonical_id=root_canonical,
                )

        self.store.save_timeline_items("home", masto_results, replace=False)
        for item in masto_results:
            self.publish_event("update", item)
        self._sync_sanctuary_profile_snapshot(masto, fresh_items=masto_results)
        return {
            "items": masto_results,
            "linkedIds": masto_results[0]["_meta"].get("linkedIds", {}),
            "warnings": warnings,
            "retryQueue": self.store.list_retries(),
        }

    def _publish_bluesky_segments(
        self,
        bsky: BlueskyAdapter,
        text_parts: list[str],
        *,
        media: list[dict[str, Any]] | None = None,
        resolved_card: dict[str, Any] | None = None,
    ) -> list[dict[str, str]]:
        raw_media = media or []
        segments: list[str] = []
        for p in text_parts:
            segments.extend(split_text_for_limit(p, 300) or [])
        if not segments and raw_media:
            segments = [""]
        if not segments:
            return []
        out_refs: list[dict[str, str]] = []
        root_ref = None
        parent_ref = None
        for idx, seg in enumerate(segments):
            opts: dict[str, Any] = {"reply": {"root": root_ref, "parent": parent_ref}} if parent_ref else {}
            if idx == 0 and not raw_media and resolved_card:
                opts["external_embed"] = resolved_card
            created = bsky.publish(seg, media=raw_media if idx == 0 else None, options=opts)
            bmeta = (created.get("_meta") or {}).get("bluesky") or {}
            ref = {"uri": str(bmeta.get("uri") or ""), "cid": str(bmeta.get("cid") or "")}
            if ref["uri"]:
                out_refs.append(ref)
                if idx == 0:
                    root_ref = ref
                parent_ref = ref
        return out_refs

    def _publish_threads_segments(
        self,
        threads: ThreadsAdapter,
        text_parts: list[str],
        *,
        media: list[dict[str, Any]] | None = None,
        masto_media_urls: list[str] | None = None,
        resolved_card: dict[str, Any] | None = None,
        visibility: str = "public",
    ) -> list[str]:
        raw_media = media or []
        urls = [u for u in (masto_media_urls or []) if u]
        segments: list[str] = []
        for p in text_parts:
            segments.extend(split_text_for_limit(p, 500) or [])
        if not segments and (raw_media or urls):
            segments = [""]
        if not segments:
            return []
        out_ids: list[str] = []
        parent_tid = ""
        for idx, seg in enumerate(segments):
            opts: dict[str, Any] = {}
            if parent_tid:
                opts["reply_to_id"] = parent_tid
            elif visibility == "private":
                opts["reply_control"] = "accounts_you_follow"
            if idx == 0 and urls:
                opts["mastodon_media_urls"] = urls
            elif idx == 0 and not raw_media and not urls and resolved_card and resolved_card.get("url"):
                opts["link_attachment"] = resolved_card["url"]
            created = threads.publish(seg, media=raw_media if idx == 0 else None, options=opts)
            tid = str(((created.get("_meta") or {}).get("threads") or {}).get("postId") or "")
            if tid:
                out_ids.append(tid)
                parent_tid = tid
        return out_ids

    def delete_unified(self, item_or_id: str | dict[str, Any]) -> dict[str, Any]:
        """Synchronized deletion across Mastodon, Bluesky, and Threads via linked_posts."""
        raw_id = item_or_id.get("id", "") if isinstance(item_or_id, dict) else str(item_or_id)
        item_meta = item_or_id.get("_meta", {}) if isinstance(item_or_id, dict) else {}
        group = self.store.find_linked_post_group(raw_id)

        targets_masto: list[str] = []
        targets_bsky: list[str] = []
        targets_threads: list[str] = []

        if group:
            for rec in group:
                if rec.get("mastodonStatusId"):
                    targets_masto.append(str(rec["mastodonStatusId"]))
                if rec.get("blueskyUri"):
                    targets_bsky.append(str(rec["blueskyUri"]))
                if rec.get("threadsPostId"):
                    targets_threads.append(str(rec["threadsPostId"]))
        else:
            if (item_meta.get("mastodon") or {}).get("statusId"):
                targets_masto.append(str(item_meta["mastodon"]["statusId"]))
            elif raw_id.startswith("mastodon:") or ":" not in raw_id:
                targets_masto.append(raw_id.removeprefix("mastodon:"))
            if (item_meta.get("bluesky") or {}).get("uri"):
                targets_bsky.append(str(item_meta["bluesky"]["uri"]))
            elif raw_id.startswith("bluesky:"):
                targets_bsky.append(raw_id.removeprefix("bluesky:"))
            if (item_meta.get("threads") or {}).get("postId"):
                targets_threads.append(str(item_meta["threads"]["postId"]))
            elif raw_id.startswith("threads:"):
                targets_threads.append(raw_id.removeprefix("threads:"))

        targets_masto = list(dict.fromkeys(t for t in targets_masto if t))
        targets_bsky = list(dict.fromkeys(t for t in targets_bsky if t))
        targets_threads = list(dict.fromkeys(t for t in targets_threads if t))

        masto = self.get_mastodon_adapter()
        bsky = self.get_bluesky_adapter()
        threads = self.get_threads_adapter()

        warnings: list[str] = []
        futures = []
        succeeded_count = 0
        failed_bsky: set[str] = set()
        failed_threads: set[str] = set()
        standalone_errors: list[Exception] = []

        with ThreadPoolExecutor(max_workers=4) as pool:
            for sid in targets_masto:
                if masto:
                    futures.append(("mastodon", sid, pool.submit(masto.delete, {"statusId": sid})))
            for uri in targets_bsky:
                if bsky:
                    futures.append(("bluesky", uri, pool.submit(bsky.delete, {"uri": uri})))
            for tid in targets_threads:
                if threads:
                    futures.append(("threads", tid, pool.submit(threads.delete, {"postId": tid})))

            for proto, target_id, fut in futures:
                try:
                    fut.result()
                    succeeded_count += 1
                except Exception as exc:
                    if proto == "mastodon":
                        raise
                    err = str(exc)
                    standalone_errors.append(exc)
                    if proto == "bluesky":
                        failed_bsky.add(target_id)
                    elif proto == "threads":
                        failed_threads.add(target_id)
                    warnings.append(f"{proto.title()}: {err}")
                    self.store.enqueue_retry(
                        retry_id=f"retry_del_{proto}_{uuid.uuid4().hex[:8]}",
                        operation="delete",
                        protocol=proto,
                        payload={"nativeId": target_id},
                        last_error=err,
                    )

        if not targets_masto and succeeded_count == 0 and standalone_errors:
            raise standalone_errors[0]

        if not failed_bsky and not failed_threads:
            self.store.delete_linked_post(raw_id)
        elif group:
            root_rec = group[0]
            for child in group[1:]:
                rem_b = child.get("blueskyUri") if child.get("blueskyUri") in failed_bsky else ""
                rem_t = child.get("threadsPostId") if child.get("threadsPostId") in failed_threads else ""
                if not rem_b and not rem_t:
                    self.store.delete_linked_post(child["canonical_id"])
                else:
                    self.store.save_linked_post(
                        canonical_id=child["canonical_id"],
                        mastodon_status_id="",
                        mastodon_instance=child.get("mastodonInstance") or "",
                        bluesky_uri=rem_b or "",
                        bluesky_cid=(child.get("blueskyCid") or "") if rem_b else "",
                        threads_post_id=rem_t or "",
                        parent_canonical_id=child.get("parentCanonicalId") or root_rec["canonical_id"],
                        replace=True,
                    )
            rem_rb = root_rec.get("blueskyUri") if root_rec.get("blueskyUri") in failed_bsky else ""
            rem_rt = root_rec.get("threadsPostId") if root_rec.get("threadsPostId") in failed_threads else ""
            if not rem_rb and failed_bsky and len(group) == 1:
                rem_rb = next(iter(failed_bsky))
            if not rem_rt and failed_threads and len(group) == 1:
                rem_rt = next(iter(failed_threads))
            self.store.save_linked_post(
                canonical_id=root_rec["canonical_id"],
                mastodon_status_id="",
                mastodon_instance=root_rec.get("mastodonInstance") or "",
                bluesky_uri=rem_rb or "",
                bluesky_cid=(root_rec.get("blueskyCid") or "") if rem_rb else "",
                threads_post_id=rem_rt or "",
                parent_canonical_id="",
                replace=True,
            )

        self.store.remove_cached_item(raw_id)
        self.publish_event("delete", {"id": raw_id})
        if masto:
            self._sync_sanctuary_profile_snapshot(masto)
        return {"deleted": True, "warnings": warnings, "retryQueue": self.store.list_retries()}

    def reply_unified(
        self,
        *,
        target_item: dict[str, Any],
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Route reply transparently through the matching origin _meta protocol adapter."""
        meta = target_item.get("_meta") or {}
        protocol = target_item.get("protocol") or ""
        if meta.get("bluesky") and protocol == "bluesky":
            bsky = self.get_bluesky_adapter()
            if not bsky:
                raise RuntimeError("Bluesky bridge is disconnected")
            return bsky.reply(target_item, draft, media=media, options=options)
        if meta.get("threads") and protocol == "threads":
            threads = self.get_threads_adapter()
            if not threads:
                raise RuntimeError("Threads bridge is disconnected")
            return threads.reply(target_item, draft, media=media, options=options)

        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Mastodon account is disconnected")
        item = masto.reply(target_item, draft, media=media, options=options)
        self.store.save_timeline_items("home", [item], replace=False)
        return item

    def like_unified(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        proto = target_item.get("protocol") or "mastodon"
        if proto == "bluesky":
            bsky = self.get_bluesky_adapter()
            if not bsky:
                raise RuntimeError("Bluesky bridge is disconnected")
            updated = bsky.like(target_item, undo=undo)
        else:
            masto = self.get_mastodon_adapter()
            if not masto:
                raise RuntimeError("Mastodon account is disconnected")
            updated = masto.like(target_item, undo=undo)
        self.store.update_cached_item(updated)
        return updated

    def repost_unified(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        proto = target_item.get("protocol") or "mastodon"
        if proto == "bluesky":
            bsky = self.get_bluesky_adapter()
            if not bsky:
                raise RuntimeError("Bluesky bridge is disconnected")
            updated = bsky.repost(target_item, undo=undo)
        else:
            masto = self.get_mastodon_adapter()
            if not masto:
                raise RuntimeError("Mastodon account is disconnected")
            updated = masto.repost(target_item, undo=undo)
        self.store.update_cached_item(updated)
        return updated

    def edit_unified(
        self,
        status_id: str,
        draft: str,
        spoiler_text: str = "",
        *,
        replace_bridges: bool = False,
    ) -> dict[str, Any]:
        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Mastodon account is disconnected")
        updated = masto.edit_status(status_id.removeprefix("mastodon:"), draft, spoiler_text)
        canon_id = updated["id"]
        masto_sid = updated["_meta"]["mastodon"]["statusId"]
        group = self.store.find_linked_post_group(canon_id)
        root_linked = group[0] if group else None
        warnings: list[str] = []
        visibility = str((updated.get("_meta", {}).get("mastodon") or {}).get("visibility") or "public").lower()

        if replace_bridges and visibility != "direct":
            old_bsky_uris = list(dict.fromkeys(str(r["blueskyUri"]) for r in group if r.get("blueskyUri")))
            old_bsky_cid = str((root_linked or {}).get("blueskyCid") or "")
            old_threads_ids = list(dict.fromkeys(str(r["threadsPostId"]) for r in group if r.get("threadsPostId")))

            attachments = list(updated.get("attachments") or [])
            masto_media_urls = [
                str(att.get("url") or "")
                for att in attachments
                if att.get("url") and is_allowed_social_url(str(att.get("url")))
            ]
            threads_media = [
                {
                    "url": str(att["url"]),
                    "mime_type": str(att.get("mime_type") or "image/jpeg"),
                    "alt_text": str(att.get("alt_text") or ""),
                }
                for att in attachments
                if att.get("url") and is_allowed_social_url(str(att.get("url")))
            ]

            resolved_card: dict[str, Any] | None = None
            if not attachments:
                existing_card = (updated.get("_meta") or {}).get("linkCard")
                if isinstance(existing_card, dict) and str(existing_card.get("url") or "").startswith("https://"):
                    resolved_card = dict(existing_card)
                else:
                    first_url = extract_first_https_url(draft)
                    if first_url:
                        try:
                            resolved_card = fetch_link_preview(first_url)
                        except Exception:
                            resolved_card = None

            new_bsky_refs: list[dict[str, str]] = []
            preserved_bsky_uri = ""
            preserved_bsky_cid = ""
            bsky = self.get_bluesky_adapter()
            if bsky:
                undeleted_bsky: list[str] = []
                for uri in old_bsky_uris:
                    try:
                        bsky.delete({"uri": uri})
                    except Exception as exc:
                        undeleted_bsky.append(uri)
                        if f"Bluesky: {exc}" not in warnings:
                            warnings.append(f"Bluesky: {exc}")
                if undeleted_bsky:
                    preserved_bsky_uri = undeleted_bsky[0]
                    preserved_bsky_cid = old_bsky_cid if preserved_bsky_uri == (old_bsky_uris[0] if old_bsky_uris else "") else ""
                else:
                    bsky_media: list[dict[str, Any]] = []
                    for att in attachments[:4]:
                        mime = str(att.get("mime_type") or "")
                        url = str(att.get("url") or "")
                        if url and mime.startswith("image/"):
                            fetched = fetch_public_image_bytes(url)
                            if fetched:
                                bsky_media.append({
                                    "bytes": fetched[0],
                                    "mime_type": fetched[1],
                                    "alt_text": str(att.get("alt_text") or ""),
                                })
                    try:
                        new_bsky_refs = self._publish_bluesky_segments(
                            bsky,
                            [draft],
                            media=bsky_media,
                            resolved_card=resolved_card if not attachments else None,
                        )
                    except Exception as exc:
                        warnings.append(f"Bluesky: {exc}")
            elif old_bsky_uris:
                preserved_bsky_uri = old_bsky_uris[0]
                preserved_bsky_cid = old_bsky_cid

            new_threads_ids: list[str] = []
            preserved_threads_id = ""
            threads = self.get_threads_adapter()
            if threads:
                undeleted_threads: list[str] = []
                for tid in old_threads_ids:
                    try:
                        threads.delete({"postId": tid})
                    except Exception as exc:
                        undeleted_threads.append(tid)
                        if f"Threads: {exc}" not in warnings:
                            warnings.append(f"Threads: {exc}")
                if undeleted_threads:
                    preserved_threads_id = undeleted_threads[0]
                else:
                    try:
                        new_threads_ids = self._publish_threads_segments(
                            threads,
                            [draft],
                            media=threads_media,
                            masto_media_urls=masto_media_urls,
                            resolved_card=resolved_card if not attachments else None,
                            visibility=visibility,
                        )
                    except Exception as exc:
                        warnings.append(f"Threads: {exc}")
            elif old_threads_ids:
                preserved_threads_id = old_threads_ids[0]

            self.store.delete_linked_children(canon_id)
            root_bsky_uri = new_bsky_refs[0]["uri"] if new_bsky_refs else preserved_bsky_uri
            root_bsky_cid = new_bsky_refs[0]["cid"] if new_bsky_refs else preserved_bsky_cid
            root_thr_id = new_threads_ids[0] if new_threads_ids else preserved_threads_id

            root_linked = self.store.save_linked_post(
                canonical_id=canon_id,
                mastodon_status_id=masto_sid,
                mastodon_instance=masto.instance_url,
                bluesky_uri=root_bsky_uri,
                bluesky_cid=root_bsky_cid,
                threads_post_id=root_thr_id,
                parent_canonical_id="",
                replace=True,
            )
            extra_max = max(len(new_bsky_refs), len(new_threads_ids))
            for extra_idx in range(1, extra_max):
                bref = new_bsky_refs[extra_idx] if extra_idx < len(new_bsky_refs) else {}
                tid = new_threads_ids[extra_idx] if extra_idx < len(new_threads_ids) else ""
                if bref.get("uri") or tid:
                    self.store.save_linked_post(
                        canonical_id=f"{canon_id}:part:{extra_idx}",
                        mastodon_status_id="",
                        mastodon_instance=masto.instance_url,
                        bluesky_uri=bref.get("uri", ""),
                        bluesky_cid=bref.get("cid", ""),
                        threads_post_id=tid,
                        parent_canonical_id=canon_id,
                        replace=True,
                    )

        clean_linked = self._clean_linked_dict(root_linked)
        if clean_linked:
            updated.setdefault("_meta", {})["linkedIds"] = clean_linked
        elif isinstance(updated.get("_meta"), dict):
            updated["_meta"].pop("linkedIds", None)
        if warnings:
            updated.setdefault("_meta", {})["bridgeWarnings"] = warnings
        self.store.update_cached_item(updated)
        self._sync_sanctuary_profile_snapshot(masto)
        return updated

    def pin_unified(self, status_id: str, unpin: bool = False) -> dict[str, Any]:
        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Mastodon account is disconnected")
        updated = masto.pin_status(status_id.removeprefix("mastodon:"), unpin=unpin)
        self.store.update_cached_item(updated)
        return updated

    # ── Timelines, Aggregated Metrics & Unified Notifications ────────────

    def enrich_linked_metrics(self, items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Aggregate likes, replies, and reposts across linked Mastodon, Bluesky, and Threads copies."""
        if not isinstance(items, list) or not items:
            return []

        bsky_uris: list[str] = []
        threads_ids: list[str] = []
        for it in items:
            if not isinstance(it, dict):
                continue
            meta = it.setdefault("_meta", {})
            linked = meta.get("linkedIds")
            if not isinstance(linked, dict) and it.get("id"):
                found = self.store.find_linked_post(it["id"])
                if found:
                    linked = {
                        k: v
                        for k, v in {
                            "mastodonStatusId": found.get("mastodonStatusId"),
                            "blueskyUri": found.get("blueskyUri"),
                            "blueskyCid": found.get("blueskyCid"),
                            "threadsPostId": found.get("threadsPostId"),
                        }.items()
                        if v
                    }
                    if linked:
                        meta["linkedIds"] = linked
            if isinstance(linked, dict):
                if linked.get("blueskyUri"):
                    bsky_uris.append(str(linked["blueskyUri"]))
                if linked.get("threadsPostId"):
                    threads_ids.append(str(linked["threadsPostId"]))

        if not bsky_uris and not threads_ids:
            return items

        bsky_metrics: dict[str, dict[str, int]] = {}
        if bsky_uris:
            try:
                bsky = self.get_bluesky_adapter() or BlueskyAdapter(service_url="https://public.api.bsky.app")
                bsky_metrics = bsky.get_posts_metrics(bsky_uris)
            except Exception:
                bsky_metrics = {}

        threads_metrics: dict[str, dict[str, int]] = {}
        unique_tids = list(dict.fromkeys(threads_ids))[:12]
        if unique_tids:
            threads = self.get_threads_adapter()
            if threads and hasattr(threads, "get_post_insights"):
                with ThreadPoolExecutor(max_workers=4) as pool:
                    futs = [(tid, pool.submit(threads.get_post_insights, tid)) for tid in unique_tids]
                    for tid, fut in futs:
                        try:
                            m = fut.result()
                            if isinstance(m, dict):
                                threads_metrics[tid] = m
                        except Exception:
                            pass

        for it in items:
            if not isinstance(it, dict):
                continue
            meta = it.get("_meta") or {}
            linked = meta.get("linkedIds") or {}
            if not linked:
                continue
            proto = it.get("protocol") or "mastodon"
            prev_bd = meta.get("metricsBreakdown") or {}
            base = prev_bd.get(proto) or it.get("metrics") or {"likes": 0, "replies": 0, "reposts": 0}
            breakdown: dict[str, dict[str, int]] = {
                proto: {
                    "likes": int(base.get("likes") or 0),
                    "replies": int(base.get("replies") or 0),
                    "reposts": int(base.get("reposts") or 0),
                }
            }
            if linked.get("blueskyUri") and linked["blueskyUri"] in bsky_metrics and "bluesky" not in breakdown:
                bm = bsky_metrics[linked["blueskyUri"]]
                breakdown["bluesky"] = {
                    "likes": int(bm.get("likes") or 0),
                    "replies": int(bm.get("replies") or 0),
                    "reposts": int(bm.get("reposts") or 0),
                }
            if linked.get("threadsPostId") and linked["threadsPostId"] in threads_metrics and "threads" not in breakdown:
                tm = threads_metrics[linked["threadsPostId"]]
                breakdown["threads"] = {
                    "likes": int(tm.get("likes") or 0),
                    "replies": int(tm.get("replies") or 0),
                    "reposts": int(tm.get("reposts") or 0),
                }

            it["metrics"] = {
                "likes": sum(v["likes"] for v in breakdown.values()),
                "replies": sum(v["replies"] for v in breakdown.values()),
                "reposts": sum(v["reposts"] for v in breakdown.values()),
            }
            meta["metricsBreakdown"] = breakdown
            it["_meta"] = meta
        return items

    def fetch_timeline(self, stream: str = "home", cursor: str = "", list_id: str = "", limit: int = 20) -> dict[str, Any]:
        adapter = self.get_mastodon_adapter()
        if not adapter:
            if stream in ("home", "list", "bookmarks"):
                cached = self.store.get_timeline_items(stream, limit=limit)
                return {"items": cached, "next_cursor": None, "fromCache": True}
            pub = self.get_public_mastodon_adapter()
            res = pub.fetch_timeline(stream="trending", cursor=cursor, limit=limit)
            return {"items": res["items"], "next_cursor": res["next_cursor"], "fromCache": False}

        target_stream = stream if stream in ("home", "local", "federated", "list", "bookmarks", "trending") else "home"
        res = adapter.fetch_timeline(stream=target_stream, cursor=cursor, limit=limit, list_id=list_id)
        items = self.enrich_linked_metrics(res["items"])
        cache_key = f"list:{list_id}" if target_stream == "list" else target_stream
        if not cursor:
            self.store.save_timeline_items(cache_key, items, replace=True)
        else:
            self.store.save_timeline_items(cache_key, items, replace=False)
        return {"items": items, "next_cursor": res["next_cursor"], "fromCache": False}

    _DISMISSED_KV_STORE = "social_activity"
    _DISMISSED_KV_KEY = "dismissed_v1"

    def _get_dismissed_activity_state(self) -> dict[str, Any]:
        raw = self.store.kv_get(self._DISMISSED_KV_STORE, self._DISMISSED_KV_KEY)
        data = raw if isinstance(raw, dict) else {}
        ids = [str(x) for x in (data.get("ids") or []) if x]
        twm = data.get("threads_watermarks")
        stamps = data.get("threads_stamps")
        return {
            "ids": ids[-600:],
            "cleared_before_ts": float(data.get("cleared_before_ts") or 0.0),
            "threads_watermarks": dict(twm) if isinstance(twm, dict) else {},
            "threads_stamps": dict(stamps) if isinstance(stamps, dict) else {},
            "last_seen_ts": float(data.get("last_seen_ts") or 0.0),
        }

    def _save_dismissed_activity_state(self, state: dict[str, Any]) -> None:
        ids = [str(x) for x in dict.fromkeys(state.get("ids") or []) if x][-600:]
        payload = {
            "ids": ids,
            "cleared_before_ts": float(state.get("cleared_before_ts") or 0.0),
            "threads_watermarks": dict(state.get("threads_watermarks") or {}),
            "threads_stamps": dict(state.get("threads_stamps") or {}),
            "last_seen_ts": float(state.get("last_seen_ts") or 0.0),
        }
        self.store.kv_put(self._DISMISSED_KV_STORE, self._DISMISSED_KV_KEY, payload)

    @staticmethod
    def _merge_threads_watermarks(existing: dict[str, Any], incoming: dict[str, Any] | None) -> dict[str, Any]:
        merged = {str(k): dict(v) for k, v in (existing or {}).items() if isinstance(v, dict)}
        for tid, counts in (incoming or {}).items():
            clean_tid = str(tid or "").strip()
            if not clean_tid or not isinstance(counts, dict):
                continue
            cur = merged.get(clean_tid) or {}
            if "likes" in counts:
                cur["likes"] = max(int(cur.get("likes") or 0), int(counts.get("likes") or 0))
            if "reposts" in counts:
                cur["reposts"] = max(int(cur.get("reposts") or 0), int(counts.get("reposts") or 0))
            merged[clean_tid] = cur
        return merged

    def dismiss_notifications(
        self,
        *,
        ids: list[str] | None = None,
        mastodon_notif_ids: list[str] | None = None,
        threads_watermarks: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        clean_ids = [str(x or "").strip() for x in (ids or []) if str(x or "").strip()]
        persist_ids = [
            x
            for x in clean_ids
            if not x.startswith(("threads:notif:likes:", "threads:notif:reposts:", "threads:likes:", "threads:reposts:"))
        ]
        state = self._get_dismissed_activity_state()
        state["ids"] = [*state["ids"], *persist_ids]
        state["threads_watermarks"] = self._merge_threads_watermarks(state["threads_watermarks"], threads_watermarks)
        self._save_dismissed_activity_state(state)
        self.store.delete_notifications(clean_ids)

        masto = self.get_mastodon_adapter()
        clean_masto_ids = [
            str(mid or "").removeprefix("mastodon:notif:").removeprefix("mastodon:").strip()
            for mid in (mastodon_notif_ids or [])
            if str(mid or "").strip()
        ]
        if masto and clean_masto_ids and hasattr(masto, "dismiss_notification"):
            with ThreadPoolExecutor(max_workers=4) as pool:
                futs = [pool.submit(masto.dismiss_notification, mid) for mid in dict.fromkeys(clean_masto_ids)]
                for fut in futs:
                    try:
                        fut.result()
                    except Exception:
                        pass
        return {"dismissed": len(clean_ids)}

    def clear_all_notifications(self, *, threads_watermarks: dict[str, Any] | None = None) -> dict[str, Any]:
        now = time.time()
        state = self._get_dismissed_activity_state()
        state["cleared_before_ts"] = max(state["cleared_before_ts"], now)
        state["last_seen_ts"] = max(state["last_seen_ts"], now)
        state["threads_watermarks"] = self._merge_threads_watermarks(state["threads_watermarks"], threads_watermarks)
        self._save_dismissed_activity_state(state)
        self.store.delete_notifications(clear_all=True)

        masto = self.get_mastodon_adapter()
        if masto and hasattr(masto, "clear_notifications"):
            try:
                masto.clear_notifications()
            except Exception:
                pass
        bsky = self.get_bluesky_adapter()
        if bsky and hasattr(bsky, "update_notifications_seen"):
            try:
                bsky.update_notifications_seen()
            except Exception:
                pass
        return {"cleared": True, "clearedBeforeTs": state["cleared_before_ts"]}

    def mark_notifications_seen(self, *, seen_ts: float | None = None) -> dict[str, Any]:
        now = float(seen_ts) if seen_ts is not None else time.time()
        state = self._get_dismissed_activity_state()
        state["last_seen_ts"] = max(state["last_seen_ts"], now)
        self._save_dismissed_activity_state(state)
        bsky = self.get_bluesky_adapter()
        if bsky and hasattr(bsky, "update_notifications_seen"):
            try:
                bsky.update_notifications_seen()
            except Exception:
                pass
        return {"seen": True, "lastSeenTs": state["last_seen_ts"]}

    @staticmethod
    def _notif_is_dismissed(item: dict[str, Any], dismissed_ids: set[str], cleared_before_ts: float) -> bool:
        item_id = str(item.get("id") or "")
        notif_meta = (item.get("_meta") or {}).get("notification") or {}
        notif_id = str(notif_meta.get("notifId") or "")
        if item_id in dismissed_ids or (notif_id and notif_id in dismissed_ids):
            return True
        if cleared_before_ts > 0:
            ts = parse_iso_ts(item.get("date_published"))
            if ts > 0 and ts <= cleared_before_ts:
                return True
        return False

    @staticmethod
    def _clean_linked_dict(row: dict[str, Any] | None) -> dict[str, Any]:
        if not isinstance(row, dict):
            return {}
        return {
            k: v
            for k, v in {
                "mastodonStatusId": row.get("mastodonStatusId"),
                "blueskyUri": row.get("blueskyUri"),
                "blueskyCid": row.get("blueskyCid"),
                "threadsPostId": row.get("threadsPostId"),
            }.items()
            if v
        }

    def fetch_merged_notifications(self, limit: int = 35) -> dict[str, Any]:
        """Concurrently fetch Mastodon, Bluesky, and Threads notifications into one deduplicated timeline."""
        masto = self.get_mastodon_adapter()
        bsky = self.get_bluesky_adapter()
        threads = self.get_threads_adapter()

        linked_rows = self.store.list_linked_posts(limit=40)
        by_canonical: dict[str, dict[str, Any]] = {}
        by_masto: dict[str, dict[str, Any]] = {}
        by_bsky: dict[str, dict[str, Any]] = {}
        by_threads: dict[str, dict[str, Any]] = {}
        for row in linked_rows:
            cid = str(row.get("canonical_id") or "")
            if cid:
                by_canonical[cid] = row
            if row.get("mastodonStatusId"):
                by_masto[str(row["mastodonStatusId"])] = row
            if row.get("blueskyUri"):
                by_bsky[str(row["blueskyUri"])] = row
            if row.get("threadsPostId"):
                by_threads[str(row["threadsPostId"])] = row

        tracked_threads_ids = [
            str(r["threadsPostId"])
            for r in linked_rows
            if r.get("threadsPostId")
        ]

        all_items: list[dict[str, Any]] = []
        warnings: list[str] = []

        def run_threads_notifs() -> list[dict[str, Any]]:
            assert threads is not None
            try:
                return threads.fetch_notifications("", limit, tracked_post_ids=tracked_threads_ids)
            except TypeError:
                return threads.fetch_notifications("", limit)

        with ThreadPoolExecutor(max_workers=3) as pool:
            tasks: list[tuple[str, Any]] = []
            if masto:
                tasks.append(("mastodon", pool.submit(masto.fetch_notifications, "", limit)))
            if bsky:
                tasks.append(("bluesky", pool.submit(bsky.fetch_notifications, "", limit)))
            if threads:
                tasks.append(("threads", pool.submit(run_threads_notifs)))

            for proto, fut in tasks:
                try:
                    all_items.extend(fut.result() or [])
                except Exception as exc:
                    warnings.append(f"{proto.title()} notifications delayed: {exc}")

        dismissed_state = self._get_dismissed_activity_state()
        dismissed_ids = set(dismissed_state["ids"])
        cleared_before_ts = float(dismissed_state["cleared_before_ts"] or 0.0)
        threads_watermarks = dismissed_state["threads_watermarks"]
        threads_stamps = dict(dismissed_state["threads_stamps"])

        # Fetch Threads insights concurrently when Threads is connected and we track cross-posted Threads posts
        threads_insights: dict[str, dict[str, int]] = {}
        unique_tids = list(dict.fromkeys(tracked_threads_ids))[:12]
        if unique_tids and threads and hasattr(threads, "get_post_insights"):
            with ThreadPoolExecutor(max_workers=4) as pool:
                futs = [(tid, pool.submit(threads.get_post_insights, tid)) for tid in unique_tids]
                for tid, fut in futs:
                    try:
                        res_ins = fut.result()
                        if isinstance(res_ins, dict):
                            threads_insights[tid] = res_ins
                    except Exception:
                        pass

        # Resolve linkedIds + canonicalPostKey on fetched items BEFORE synthesizing or enriching
        def link_notification_item(it: dict[str, Any]) -> None:
            meta = it.setdefault("_meta", {})
            notif_meta = meta.setdefault("notification", {})
            kind = str(notif_meta.get("type") or "mention")
            m_meta = meta.get("mastodon") or {}
            b_meta = meta.get("bluesky") or {}
            t_meta = meta.get("threads") or {}
            reply_root = ((b_meta.get("reply") or {}).get("root") or {}).get("uri") if isinstance(b_meta.get("reply"), dict) else ""

            matched_row = (
                by_masto.get(str(m_meta.get("statusId") or ""))
                or by_masto.get(str(m_meta.get("inReplyToId") or ""))
                or by_bsky.get(str(notif_meta.get("targetPostUri") or b_meta.get("subjectUri") or ""))
                or by_bsky.get(str(b_meta.get("uri") or ""))
                or by_bsky.get(str(reply_root or ""))
                or by_threads.get(str(t_meta.get("parentPostId") or t_meta.get("repliedToId") or t_meta.get("rootPostId") or ""))
                or by_threads.get(str(t_meta.get("postId") or ""))
            )
            if not matched_row:
                return
            clean_linked = self._clean_linked_dict(matched_row)
            notif_meta["canonicalPostKey"] = matched_row["canonical_id"]
            if clean_linked:
                notif_meta["linkedIds"] = clean_linked
            is_direct = kind in ("like", "repost") or (
                str(m_meta.get("statusId") or "") == str(matched_row.get("mastodonStatusId") or "")
                and bool(m_meta.get("statusId"))
            ) or (
                str(b_meta.get("uri") or "") == str(matched_row.get("blueskyUri") or "")
                and bool(b_meta.get("uri"))
            ) or (
                str(t_meta.get("postId") or "") == str(matched_row.get("threadsPostId") or "")
                and bool(t_meta.get("postId"))
            )
            if is_direct and clean_linked:
                meta["linkedIds"] = clean_linked

        for it in all_items:
            link_notification_item(it)

        # Synthesize Threads aggregate like/repost notifications when Threads insights exceed dismissal watermarks
        stamps_dirty = False
        now_iso = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
        for tid, ins in threads_insights.items():
            matched_row = by_threads.get(tid)
            if not matched_row:
                continue
            wm = threads_watermarks.get(tid) or {}
            clean_linked = self._clean_linked_dict(matched_row)
            cached_parent = self.store.get_cached_item_by_id(matched_row["canonical_id"])
            snippet_text = str((cached_parent or {}).get("content_text") or "")
            snippet_html = str((cached_parent or {}).get("content_html") or (plain_text_to_html(snippet_text) if snippet_text else ""))
            parent_atts = list((cached_parent or {}).get("attachments") or [])
            parent_url = str((cached_parent or {}).get("url") or f"https://www.threads.net/post/{tid}")

            for syn_kind, ins_key in (("like", "likes"), ("repost", "reposts")):
                raw_total = int(ins.get(ins_key) or 0)
                active_count = max(0, raw_total - int(wm.get(ins_key) or 0))
                if active_count <= 0:
                    continue
                stamp_key = f"{tid}:{ins_key}"
                prev_stamp = threads_stamps.get(stamp_key) if isinstance(threads_stamps.get(stamp_key), dict) else None
                if prev_stamp and int(prev_stamp.get("count") or 0) == raw_total and prev_stamp.get("iso"):
                    syn_iso = str(prev_stamp["iso"])
                else:
                    syn_iso = now_iso
                    threads_stamps[stamp_key] = {"count": raw_total, "iso": syn_iso}
                    stamps_dirty = True

                label_who = "1 person on Threads" if active_count == 1 else f"{active_count} people on Threads"
                syn_actor = {
                    "id": f"threads:insights:{tid}",
                    "name": label_who,
                    "handle": "threads.net",
                    "avatar_url": "",
                    "protocol": "threads",
                }
                all_items.append({
                    "id": f"threads:notif:{ins_key}:{tid}",
                    "protocol": "threads",
                    "url": parent_url,
                    "content_html": snippet_html,
                    "content_text": snippet_text,
                    "date_published": syn_iso,
                    "author": syn_actor,
                    "attachments": parent_atts,
                    "metrics": {
                        "likes": int(ins.get("likes") or 0),
                        "replies": int(ins.get("replies") or 0),
                        "reposts": int(ins.get("reposts") or 0),
                    },
                    "_meta": {
                        "threads": {"postId": tid},
                        "linkedIds": clean_linked,
                        "notification": {
                            "notifId": f"threads:{ins_key}:{tid}",
                            "type": syn_kind,
                            "actor": syn_actor,
                            "aggregateCount": active_count,
                            "rawInsightsTotal": raw_total,
                            "canonicalPostKey": matched_row["canonical_id"],
                            "threadsPostId": tid,
                            "linkedIds": clean_linked,
                        },
                    },
                })

        if stamps_dirty:
            dismissed_state["threads_stamps"] = threads_stamps
            self._save_dismissed_activity_state(dismissed_state)

        filtered_items = [
            it
            for it in all_items
            if not self._notif_is_dismissed(it, dismissed_ids, cleared_before_ts)
        ]

        if not all_items:
            cached = [
                it
                for it in self.store.get_notifications(limit=limit)
                if not self._notif_is_dismissed(it, dismissed_ids, cleared_before_ts)
            ]
            return {"items": cached, "warnings": warnings}

        if not filtered_items:
            self.store.save_notifications([], replace=True)
            return {"items": [], "warnings": warnings}

        merged = deduplicate_unified_items(filtered_items)

        # Build cross-platform total metrics per referenced canonical linked post
        direct_enrich_targets = [
            it
            for it in merged
            if isinstance((it.get("_meta") or {}).get("linkedIds"), dict)
            and str(((it.get("_meta") or {}).get("notification") or {}).get("type") or "") in ("like", "repost")
        ]
        if direct_enrich_targets:
            self.enrich_linked_metrics(direct_enrich_targets)

        linked_totals: dict[str, dict[str, Any]] = {}
        canon_ids_seen = {
            str(((it.get("_meta") or {}).get("notification") or {}).get("canonicalPostKey") or "")
            for it in merged
            if ((it.get("_meta") or {}).get("notification") or {}).get("canonicalPostKey")
        }
        for cid in canon_ids_seen:
            row = by_canonical.get(cid)
            if not row:
                continue
            breakdown: dict[str, dict[str, int]] = {}
            cached_post = self.store.get_cached_item_by_id(cid)
            if cached_post and isinstance((cached_post.get("_meta") or {}).get("metricsBreakdown"), dict):
                for p_name, p_vals in cached_post["_meta"]["metricsBreakdown"].items():
                    if isinstance(p_vals, dict):
                        breakdown[str(p_name)] = {
                            "likes": int(p_vals.get("likes") or 0),
                            "replies": int(p_vals.get("replies") or 0),
                            "reposts": int(p_vals.get("reposts") or 0),
                        }
            for it in merged:
                if str(((it.get("_meta") or {}).get("notification") or {}).get("canonicalPostKey") or "") != cid:
                    continue
                if isinstance((it.get("_meta") or {}).get("metricsBreakdown"), dict):
                    for p_name, p_vals in it["_meta"]["metricsBreakdown"].items():
                        if isinstance(p_vals, dict):
                            breakdown[str(p_name)] = {
                                "likes": int(p_vals.get("likes") or 0),
                                "replies": int(p_vals.get("replies") or 0),
                                "reposts": int(p_vals.get("reposts") or 0),
                            }
                elif it.get("protocol") == "mastodon" and str(((it.get("_meta") or {}).get("notification") or {}).get("type") or "") in ("like", "repost"):
                    m_cnt = it.get("metrics") or {}
                    breakdown.setdefault("mastodon", {
                        "likes": int(m_cnt.get("likes") or 0),
                        "replies": int(m_cnt.get("replies") or 0),
                        "reposts": int(m_cnt.get("reposts") or 0),
                    })
            if row.get("blueskyUri") and "bluesky" not in breakdown:
                for it in merged:
                    nm = (it.get("_meta") or {}).get("notification") or {}
                    if str(nm.get("canonicalPostKey") or "") == cid:
                        tm = nm.get("targetMetrics") or (nm.get("targetPost") or {}).get("metrics")
                        if isinstance(tm, dict):
                            breakdown["bluesky"] = {
                                "likes": int(tm.get("likes") or 0),
                                "replies": int(tm.get("replies") or 0),
                                "reposts": int(tm.get("reposts") or 0),
                            }
                            break
            if row.get("threadsPostId") and str(row["threadsPostId"]) in threads_insights and "threads" not in breakdown:
                ti = threads_insights[str(row["threadsPostId"])]
                breakdown["threads"] = {
                    "likes": int(ti.get("likes") or 0),
                    "replies": int(ti.get("replies") or 0),
                    "reposts": int(ti.get("reposts") or 0),
                }
            if breakdown:
                total_m = {
                    "likes": sum(v["likes"] for v in breakdown.values()),
                    "replies": sum(v["replies"] for v in breakdown.values()),
                    "reposts": sum(v["reposts"] for v in breakdown.values()),
                }
                linked_totals[cid] = {"metrics": total_m, "breakdown": breakdown, "cached": cached_post}

        for it in merged:
            meta = it.setdefault("_meta", {})
            nm = meta.setdefault("notification", {})
            cid = str(nm.get("canonicalPostKey") or "")
            if cid and cid in linked_totals:
                lt = linked_totals[cid]
                nm["postMetrics"] = lt["metrics"]
                nm["postMetricsBreakdown"] = lt["breakdown"]
                if str(nm.get("type") or "") in ("like", "repost"):
                    it["metrics"] = dict(lt["metrics"])
                    meta["metricsBreakdown"] = lt["breakdown"]
                    if not it.get("content_text") and lt.get("cached"):
                        it["content_text"] = lt["cached"].get("content_text") or ""
                        it["content_html"] = lt["cached"].get("content_html") or it.get("content_html") or ""
                    if not it.get("attachments") and lt.get("cached"):
                        it["attachments"] = list(lt["cached"].get("attachments") or [])

        self.store.save_notifications(merged, replace=True)
        return {"items": merged[:limit], "warnings": warnings}

    # ── Retries ──────────────────────────────────────────────────────────

    def _drain_protocol_retries(self, protocol: str) -> None:
        clean_proto = str(protocol or "").strip().lower()
        for entry in list(self.store.list_retries()):
            if str(entry.get("protocol") or "").lower() != clean_proto:
                continue
            try:
                self.run_retry(entry["id"])
            except Exception:
                pass

    def run_retry(self, retry_id: str) -> dict[str, Any]:
        entry = self.store.get_retry(retry_id)
        if not entry:
            raise ValueError(f"Retry item '{retry_id}' not found")
        proto = entry["protocol"]
        op = entry["operation"]
        payload = entry["payload"]

        if proto == "bluesky":
            bsky = self.get_bluesky_adapter()
            if not bsky:
                raise RuntimeError("Bluesky bridge is not connected")
            if op == "publish":
                parts = payload.get("textParts") or [""]
                created = bsky.publish(parts[0])
                bmeta = created["_meta"]["bluesky"]
                self.store.save_linked_post(
                    canonical_id=payload.get("canonicalId") or f"mastodon:{payload.get('mastodonStatusId', '')}",
                    mastodon_status_id=payload.get("mastodonStatusId", ""),
                    bluesky_uri=bmeta["uri"],
                    bluesky_cid=bmeta["cid"],
                )
            elif op == "delete":
                bsky.delete({"uri": payload.get("nativeId", "")})
        elif proto == "threads":
            threads = self.get_threads_adapter()
            if not threads:
                raise RuntimeError("Threads bridge is not connected")
            if op == "publish":
                parts = payload.get("textParts") or [""]
                media_urls = [u for u in (payload.get("mastodonMediaUrls") or []) if u]
                segments = []
                for p in parts:
                    segments.extend(split_text_for_limit(p, 500) or [""])
                parent_tid = ""
                root_tid = ""
                for idx, seg in enumerate(segments):
                    opts: dict[str, Any] = {}
                    if parent_tid:
                        opts["reply_to_id"] = parent_tid
                    media_payload = None
                    if idx == 0 and media_urls:
                        opts["mastodon_media_urls"] = media_urls
                        media_payload = [{"url": u} for u in media_urls]
                    created = threads.publish(seg, media=media_payload, options=opts)
                    parent_tid = created["_meta"]["threads"]["postId"]
                    if idx == 0:
                        root_tid = parent_tid
                if root_tid:
                    self.store.save_linked_post(
                        canonical_id=payload.get("canonicalId") or f"mastodon:{payload.get('mastodonStatusId', '')}",
                        mastodon_status_id=payload.get("mastodonStatusId", ""),
                        threads_post_id=root_tid,
                    )
            elif op == "delete":
                threads.delete({"postId": payload.get("nativeId", "")})

        self.store.delete_retry(retry_id)
        return {"resolved": retry_id, "retryQueue": self.store.list_retries()}
