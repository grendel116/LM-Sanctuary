"""Sync engine coordinating Mastodon primary actions, automatic bridges, SQLite cache, and SSE updates."""

from __future__ import annotations

import queue
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

from social.adapters.bluesky.adapter import BlueskyAdapter, DEFAULT_BSKY_SERVICE
from social.adapters.mastodon.adapter import MastodonAdapter
from social.adapters.mastodon.streaming import MastodonStreamWorker
from social.adapters.threads.adapter import ThreadsAdapter
from social.core.schema.unified_item import (
    ORIGIN_PROTOCOLS,
    deduplicate_unified_items,
    normalize_instance_url,
    parse_iso_ts,
)
from social.storage.keychain import KeychainStore
from social.storage.sqlite_store import SocialSQLiteStore


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
        self.publish_event("auth_update", self.status())
        return self.status()

    def connect_threads(self, access_token: str) -> dict[str, Any]:
        me = ThreadsAdapter.verify_credentials(access_token)
        uid = str(me.get("id") or "")
        username = str(me.get("username") or uid)
        account_id = f"threads:{uid}"
        self.keychain.set_secret(account_id, {"accessToken": access_token})
        self.store.upsert_account(
            account_id=account_id,
            protocol="threads",
            instance_url="https://graph.threads.net",
            handle=username,
            display_name=me.get("name") or username,
            avatar_url=me.get("threads_profile_picture_url") or "",
            is_primary=True,
            meta={"userId": uid},
        )
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

        root_masto_id = masto_results[0]["_meta"]["mastodon"]["statusId"]
        root_canonical = masto_results[0]["id"]
        linked_bsky: list[dict[str, str]] = []
        linked_threads: list[str] = []
        warnings: list[str] = []

        # 3. Concurrent non-blocking fan-out to connected Bluesky & Threads adapters
        def run_bsky_leg() -> list[dict[str, str]]:
            assert bsky is not None
            out_refs: list[dict[str, str]] = []
            segments = []
            for p in raw_parts:
                segments.extend(split_text_for_limit(p, 300) or [""])
            root_ref = None
            parent_ref = None
            for idx, seg in enumerate(segments):
                opts = {"reply": {"root": root_ref, "parent": parent_ref}} if parent_ref else {}
                created = bsky.publish(seg, media=raw_media if idx == 0 else None, options=opts)
                bmeta = created["_meta"]["bluesky"]
                ref = {"uri": bmeta["uri"], "cid": bmeta["cid"]}
                out_refs.append(ref)
                if idx == 0:
                    root_ref = ref
                parent_ref = ref
            return out_refs

        def run_threads_leg() -> list[str]:
            assert threads is not None
            out_ids: list[str] = []
            segments = []
            for p in raw_parts:
                segments.extend(split_text_for_limit(p, 500) or [""])
            parent_tid = ""
            for idx, seg in enumerate(segments):
                opts: dict[str, Any] = {}
                if parent_tid:
                    opts["reply_to_id"] = parent_tid
                if idx == 0 and masto_media_urls:
                    opts["mastodon_media_urls"] = masto_media_urls
                created = threads.publish(seg, media=raw_media if idx == 0 else None, options=opts)
                tid = created["_meta"]["threads"]["postId"]
                out_ids.append(tid)
                parent_tid = tid
            return out_ids

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

        # 4. Save linkedIds in SQLite immediately
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
            m_item["_meta"]["linkedIds"] = {
                k: v
                for k, v in {
                    "mastodonStatusId": linked.get("mastodonStatusId"),
                    "blueskyUri": linked.get("blueskyUri"),
                    "blueskyCid": linked.get("blueskyCid"),
                    "threadsPostId": linked.get("threadsPostId"),
                }.items()
                if v
            }

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
                    targets_masto.append(rec["mastodonStatusId"])
                if rec.get("blueskyUri"):
                    targets_bsky.append(rec["blueskyUri"])
                if rec.get("threadsPostId"):
                    targets_threads.append(rec["threadsPostId"])
        else:
            if (item_meta.get("mastodon") or {}).get("statusId"):
                targets_masto.append(item_meta["mastodon"]["statusId"])
            elif raw_id.startswith("mastodon:") or ":" not in raw_id:
                targets_masto.append(raw_id.removeprefix("mastodon:"))
            if (item_meta.get("bluesky") or {}).get("uri"):
                targets_bsky.append(item_meta["bluesky"]["uri"])
            elif raw_id.startswith("bluesky:"):
                targets_bsky.append(raw_id.removeprefix("bluesky:"))
            if (item_meta.get("threads") or {}).get("postId"):
                targets_threads.append(item_meta["threads"]["postId"])
            elif raw_id.startswith("threads:"):
                targets_threads.append(raw_id.removeprefix("threads:"))

        masto = self.get_mastodon_adapter()
        bsky = self.get_bluesky_adapter()
        threads = self.get_threads_adapter()

        warnings: list[str] = []
        futures = []

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
                except Exception as exc:
                    if proto == "mastodon":
                        raise
                    err = str(exc)
                    warnings.append(f"{proto.title()} delete queued for retry: {err}")
                    self.store.enqueue_retry(
                        retry_id=f"retry_del_{proto}_{uuid.uuid4().hex[:8]}",
                        operation="delete",
                        protocol=proto,
                        payload={"nativeId": target_id},
                        last_error=err,
                    )

        self.store.delete_linked_post(raw_id)
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

    def edit_unified(self, status_id: str, draft: str, spoiler_text: str = "") -> dict[str, Any]:
        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Mastodon account is disconnected")
        updated = masto.edit_status(status_id.removeprefix("mastodon:"), draft, spoiler_text)
        linked = self.store.find_linked_post(updated["id"])
        if linked:
            updated["_meta"]["linkedIds"] = {
                k: v
                for k, v in {
                    "mastodonStatusId": linked.get("mastodonStatusId"),
                    "blueskyUri": linked.get("blueskyUri"),
                    "blueskyCid": linked.get("blueskyCid"),
                    "threadsPostId": linked.get("threadsPostId"),
                }.items()
                if v
            }
        self.store.update_cached_item(updated)
        return updated

    def pin_unified(self, status_id: str, unpin: bool = False) -> dict[str, Any]:
        masto = self.get_mastodon_adapter()
        if not masto:
            raise RuntimeError("Mastodon account is disconnected")
        updated = masto.pin_status(status_id.removeprefix("mastodon:"), unpin=unpin)
        self.store.update_cached_item(updated)
        return updated

    # ── Timelines & Unified Notification Stream ──────────────────────────

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
        cache_key = f"list:{list_id}" if target_stream == "list" else target_stream
        if not cursor:
            self.store.save_timeline_items(cache_key, res["items"], replace=True)
        else:
            self.store.save_timeline_items(cache_key, res["items"], replace=False)

        items = res["items"]
        for it in items:
            linked = self.store.find_linked_post(it["id"])
            if linked:
                it["_meta"]["linkedIds"] = {
                    k: v
                    for k, v in {
                        "mastodonStatusId": linked.get("mastodonStatusId"),
                        "blueskyUri": linked.get("blueskyUri"),
                        "blueskyCid": linked.get("blueskyCid"),
                        "threadsPostId": linked.get("threadsPostId"),
                    }.items()
                    if v
                }
        return {"items": items, "next_cursor": res["next_cursor"], "fromCache": False}

    def fetch_merged_notifications(self, limit: int = 35) -> dict[str, Any]:
        """Concurrently fetch Mastodon, Bluesky, and Threads notifications into one deduplicated timeline."""
        masto = self.get_mastodon_adapter()
        bsky = self.get_bluesky_adapter()
        threads = self.get_threads_adapter()

        all_items: list[dict[str, Any]] = []
        warnings: list[str] = []

        with ThreadPoolExecutor(max_workers=3) as pool:
            tasks: list[tuple[str, Any]] = []
            if masto:
                tasks.append(("mastodon", pool.submit(masto.fetch_notifications, "", limit)))
            if bsky:
                tasks.append(("bluesky", pool.submit(bsky.fetch_notifications, "", limit)))
            if threads:
                tasks.append(("threads", pool.submit(threads.fetch_notifications, "", limit)))

            for proto, fut in tasks:
                try:
                    all_items.extend(fut.result() or [])
                except Exception as exc:
                    warnings.append(f"{proto.title()} notifications delayed: {exc}")

        if not all_items:
            return {"items": self.store.get_notifications(limit=limit), "warnings": warnings}

        merged = deduplicate_unified_items(all_items)
        self.store.save_notifications(merged, replace=True)
        return {"items": merged[:limit], "warnings": warnings}

    # ── Retries ──────────────────────────────────────────────────────────

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
                created = threads.publish(parts[0], options={"mastodon_media_urls": payload.get("mastodonMediaUrls") or []})
                self.store.save_linked_post(
                    canonical_id=payload.get("canonicalId") or f"mastodon:{payload.get('mastodonStatusId', '')}",
                    mastodon_status_id=payload.get("mastodonStatusId", ""),
                    threads_post_id=created["_meta"]["threads"]["postId"],
                )
            elif op == "delete":
                threads.delete({"postId": payload.get("nativeId", "")})

        self.store.delete_retry(retry_id)
        return {"resolved": retry_id, "retryQueue": self.store.list_retries()}
