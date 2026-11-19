"""Thread-safe local SQLite WAL persistence for social timelines, links, filters, and cache."""

from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

from social.core.schema.unified_item import canonicalize_actor_handle, parse_iso_ts


class SocialSQLiteStore:
    """Disk-backed SQLite WAL store eliminating IndexedDB on Desktop & LAN hosts."""

    def __init__(self, db_path: str | Path | None = None) -> None:
        env_path = os.getenv("SANCTUARY_SOCIAL_DB", "").strip()
        resolved = Path(db_path) if db_path else (Path(env_path) if env_path else Path(__file__).resolve().parents[1] / "data" / "social.db")
        self.db_path = resolved
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init_schema()

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(str(self.db_path), timeout=15.0, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            with conn:
                yield conn
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._lock, self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS accounts (
                    id TEXT PRIMARY KEY,
                    protocol TEXT NOT NULL,
                    instance_url TEXT NOT NULL DEFAULT '',
                    handle TEXT NOT NULL DEFAULT '',
                    display_name TEXT NOT NULL DEFAULT '',
                    avatar_url TEXT NOT NULL DEFAULT '',
                    is_primary INTEGER NOT NULL DEFAULT 0,
                    meta_json TEXT NOT NULL DEFAULT '{}',
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS oauth_clients (
                    instance_url TEXT PRIMARY KEY,
                    client_id TEXT NOT NULL,
                    redirect_uri TEXT NOT NULL,
                    scopes TEXT NOT NULL,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS unified_items (
                    stream_key TEXT NOT NULL,
                    id TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    published_ts REAL NOT NULL,
                    author_handle TEXT NOT NULL DEFAULT '',
                    canonical_actor TEXT NOT NULL DEFAULT '',
                    item_json TEXT NOT NULL,
                    PRIMARY KEY (stream_key, id)
                );
                CREATE INDEX IF NOT EXISTS idx_unified_items_stream_ts
                    ON unified_items (stream_key, published_ts DESC);

                CREATE TABLE IF NOT EXISTS linked_posts (
                    canonical_id TEXT PRIMARY KEY,
                    mastodon_status_id TEXT DEFAULT '',
                    mastodon_instance TEXT DEFAULT '',
                    bluesky_uri TEXT DEFAULT '',
                    bluesky_cid TEXT DEFAULT '',
                    threads_post_id TEXT DEFAULT '',
                    parent_canonical_id TEXT DEFAULT '',
                    created_at REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_linked_masto ON linked_posts (mastodon_status_id);
                CREATE INDEX IF NOT EXISTS idx_linked_bsky ON linked_posts (bluesky_uri);
                CREATE INDEX IF NOT EXISTS idx_linked_threads ON linked_posts (threads_post_id);

                CREATE TABLE IF NOT EXISTS notifications (
                    id TEXT PRIMARY KEY,
                    protocol TEXT NOT NULL,
                    notif_type TEXT NOT NULL,
                    created_ts REAL NOT NULL,
                    canonical_actor TEXT NOT NULL DEFAULT '',
                    item_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_notifications_ts
                    ON notifications (created_ts DESC);

                CREATE TABLE IF NOT EXISTS filter_rules (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL DEFAULT '',
                    phrase TEXT NOT NULL,
                    context_json TEXT NOT NULL DEFAULT '["home","public","notifications","thread"]',
                    filter_action TEXT NOT NULL DEFAULT 'hide',
                    expires_at TEXT DEFAULT '',
                    mastodon_filter_id TEXT DEFAULT ''
                );

                CREATE TABLE IF NOT EXISTS lists_cache (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    replies_policy TEXT NOT NULL DEFAULT 'list',
                    exclusive INTEGER NOT NULL DEFAULT 0,
                    updated_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS retry_queue (
                    id TEXT PRIMARY KEY,
                    operation TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    payload_json TEXT NOT NULL,
                    last_error TEXT NOT NULL DEFAULT '',
                    attempts INTEGER NOT NULL DEFAULT 0,
                    created_at REAL NOT NULL
                );

                CREATE TABLE IF NOT EXISTS kv_store (
                    store_name TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value_json TEXT NOT NULL,
                    updated_at REAL NOT NULL,
                    PRIMARY KEY (store_name, key)
                );

                CREATE TABLE IF NOT EXISTS moderated_accounts (
                    canonical_actor TEXT PRIMARY KEY,
                    kind TEXT NOT NULL,
                    protocol TEXT NOT NULL,
                    handle TEXT NOT NULL,
                    display_name TEXT NOT NULL DEFAULT '',
                    federated_acct TEXT NOT NULL DEFAULT '',
                    created_ts REAL NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_moderated_kind
                    ON moderated_accounts (kind, created_ts DESC);
                """
            )

    # ── Accounts & OAuth Clients ─────────────────────────────────────────

    def upsert_account(
        self,
        *,
        account_id: str,
        protocol: str,
        instance_url: str = "",
        handle: str = "",
        display_name: str = "",
        avatar_url: str = "",
        is_primary: bool = False,
        meta: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        now = time.time()
        norm_protocol = "mastodon" if protocol == "fediverse" else str(protocol)
        payload = {
            "id": str(account_id),
            "protocol": norm_protocol,
            "instanceUrl": instance_url,
            "handle": handle,
            "displayName": display_name or handle,
            "avatarUrl": avatar_url,
            "isPrimary": bool(is_primary),
            "meta": meta or {},
            "updatedAt": now,
        }
        with self._lock, self._connect() as conn:
            if is_primary:
                conn.execute("UPDATE accounts SET is_primary = 0 WHERE protocol = ?", (norm_protocol,))
            conn.execute(
                """
                INSERT INTO accounts (id, protocol, instance_url, handle, display_name, avatar_url, is_primary, meta_json, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    protocol=excluded.protocol,
                    instance_url=excluded.instance_url,
                    handle=excluded.handle,
                    display_name=excluded.display_name,
                    avatar_url=excluded.avatar_url,
                    is_primary=excluded.is_primary,
                    meta_json=excluded.meta_json,
                    updated_at=excluded.updated_at
                """,
                (
                    payload["id"],
                    norm_protocol,
                    instance_url,
                    handle,
                    payload["displayName"],
                    avatar_url,
                    1 if is_primary else 0,
                    json.dumps(meta or {}, ensure_ascii=False),
                    now,
                ),
            )
        return payload

    def list_accounts(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM accounts ORDER BY is_primary DESC, updated_at DESC"
            ).fetchall()
        out = []
        for r in rows:
            meta = json.loads(r["meta_json"]) if r["meta_json"] else {}
            out.append({
                "id": r["id"],
                "protocol": r["protocol"],
                "instanceUrl": r["instance_url"],
                "handle": r["handle"],
                "displayName": r["display_name"],
                "avatarUrl": r["avatar_url"],
                "isPrimary": bool(r["is_primary"]),
                "meta": meta,
                "updatedAt": r["updated_at"],
            })
        return out

    def get_primary_account(self, protocol: str) -> dict[str, Any] | None:
        norm = "mastodon" if protocol == "fediverse" else protocol
        for acc in self.list_accounts():
            if acc["protocol"] == norm:
                return acc
        return None

    def delete_account(self, account_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM accounts WHERE id = ?", (str(account_id),))
            return cur.rowcount > 0

    def save_oauth_client(self, instance_url: str, client_id: str, redirect_uri: str, scopes: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO oauth_clients (instance_url, client_id, redirect_uri, scopes, created_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(instance_url) DO UPDATE SET
                    client_id=excluded.client_id,
                    redirect_uri=excluded.redirect_uri,
                    scopes=excluded.scopes,
                    created_at=excluded.created_at
                """,
                (instance_url.rstrip("/"), client_id, redirect_uri, scopes, time.time()),
            )

    def get_oauth_client(self, instance_url: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT * FROM oauth_clients WHERE instance_url = ?",
                (instance_url.rstrip("/"),),
            ).fetchone()
        return dict(row) if row else None

    # ── Linked Cross-Post ID Mapping ─────────────────────────────────────

    def save_linked_post(
        self,
        *,
        canonical_id: str,
        mastodon_status_id: str = "",
        mastodon_instance: str = "",
        bluesky_uri: str = "",
        bluesky_cid: str = "",
        threads_post_id: str = "",
        parent_canonical_id: str = "",
        replace: bool = False,
    ) -> dict[str, Any]:
        now = time.time()
        update_sql = (
            """
                ON CONFLICT(canonical_id) DO UPDATE SET
                    mastodon_status_id=excluded.mastodon_status_id,
                    mastodon_instance=COALESCE(NULLIF(excluded.mastodon_instance, ''), linked_posts.mastodon_instance),
                    bluesky_uri=excluded.bluesky_uri,
                    bluesky_cid=excluded.bluesky_cid,
                    threads_post_id=excluded.threads_post_id,
                    parent_canonical_id=excluded.parent_canonical_id
            """
            if replace
            else """
                ON CONFLICT(canonical_id) DO UPDATE SET
                    mastodon_status_id=COALESCE(NULLIF(excluded.mastodon_status_id, ''), linked_posts.mastodon_status_id),
                    mastodon_instance=COALESCE(NULLIF(excluded.mastodon_instance, ''), linked_posts.mastodon_instance),
                    bluesky_uri=COALESCE(NULLIF(excluded.bluesky_uri, ''), linked_posts.bluesky_uri),
                    bluesky_cid=COALESCE(NULLIF(excluded.bluesky_cid, ''), linked_posts.bluesky_cid),
                    threads_post_id=COALESCE(NULLIF(excluded.threads_post_id, ''), linked_posts.threads_post_id),
                    parent_canonical_id=COALESCE(NULLIF(excluded.parent_canonical_id, ''), linked_posts.parent_canonical_id)
            """
        )
        with self._lock, self._connect() as conn:
            conn.execute(
                f"""
                INSERT INTO linked_posts (
                    canonical_id, mastodon_status_id, mastodon_instance,
                    bluesky_uri, bluesky_cid, threads_post_id, parent_canonical_id, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                {update_sql}
                """,
                (
                    canonical_id,
                    mastodon_status_id,
                    mastodon_instance,
                    bluesky_uri,
                    bluesky_cid,
                    threads_post_id,
                    parent_canonical_id,
                    now,
                ),
            )
        return self.find_linked_post(canonical_id) or {}

    def find_linked_post(self, any_id: str) -> dict[str, Any] | None:
        target = str(any_id or "").strip()
        if not target:
            return None
        bare_masto = target.removeprefix("mastodon:")
        bare_bsky = target.removeprefix("bluesky:")
        bare_threads = target.removeprefix("threads:")
        with self._lock, self._connect() as conn:
            row = conn.execute(
                """
                SELECT * FROM linked_posts
                WHERE canonical_id = ?
                   OR mastodon_status_id = ?
                   OR bluesky_uri = ?
                   OR threads_post_id = ?
                LIMIT 1
                """,
                (target, bare_masto, bare_bsky, bare_threads),
            ).fetchone()
        if not row:
            return None
        return self._row_to_linked_dict(row)

    def _row_to_linked_dict(self, row: sqlite3.Row) -> dict[str, Any]:
        return {
            "canonical_id": row["canonical_id"],
            "mastodonStatusId": row["mastodon_status_id"] or None,
            "mastodonInstance": row["mastodon_instance"] or None,
            "blueskyUri": row["bluesky_uri"] or None,
            "blueskyCid": row["bluesky_cid"] or None,
            "threadsPostId": row["threads_post_id"] or None,
            "parentCanonicalId": row["parent_canonical_id"] or None,
        }

    def list_linked_posts(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM linked_posts ORDER BY created_at DESC LIMIT ?",
                (max(1, int(limit)),),
            ).fetchall()
        return [self._row_to_linked_dict(r) for r in rows]

    def find_linked_post_group(self, any_id: str) -> list[dict[str, Any]]:
        """Find the linked record and any child thread replies linked under it."""
        root = self.find_linked_post(any_id)
        if not root:
            return []
        parent_cid = str(root.get("parentCanonicalId") or "").strip()
        if parent_cid and parent_cid != root["canonical_id"]:
            parent_rec = self.find_linked_post(parent_cid)
            if parent_rec:
                root = parent_rec
        with self._lock, self._connect() as conn:
            children = conn.execute(
                "SELECT * FROM linked_posts WHERE parent_canonical_id = ?",
                (root["canonical_id"],),
            ).fetchall()
        return [root] + [self._row_to_linked_dict(r) for r in children if r["canonical_id"] != root["canonical_id"]]

    def delete_linked_children(self, parent_canonical_id: str) -> int:
        clean = str(parent_canonical_id or "").strip()
        if not clean:
            return 0
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM linked_posts WHERE parent_canonical_id = ?", (clean,))
            return cur.rowcount

    def delete_linked_post(self, any_id: str) -> int:
        group = self.find_linked_post_group(any_id)
        if not group:
            return 0
        ids = [g["canonical_id"] for g in group]
        placeholders = ",".join("?" for _ in ids)
        with self._lock, self._connect() as conn:
            cur = conn.execute(f"DELETE FROM linked_posts WHERE canonical_id IN ({placeholders})", ids)
            return cur.rowcount

    def _linked_lookup_map(self, conn: sqlite3.Connection, mastodon_ids: list[str]) -> dict[str, dict[str, Any]]:
        clean = [sid for sid in mastodon_ids if sid]
        if not clean:
            return {}
        placeholders = ",".join("?" for _ in clean)
        rows = conn.execute(
            f"SELECT * FROM linked_posts WHERE mastodon_status_id IN ({placeholders}) OR canonical_id IN ({placeholders})",
            clean + [f"mastodon:{sid}" for sid in clean],
        ).fetchall()
        result: dict[str, dict[str, Any]] = {}
        for row in rows:
            linked = {
                k: v for k, v in {
                    "mastodonStatusId": row["mastodon_status_id"],
                    "blueskyUri": row["bluesky_uri"],
                    "blueskyCid": row["bluesky_cid"],
                    "threadsPostId": row["threads_post_id"],
                }.items() if v
            }
            if row["mastodon_status_id"]:
                result[f"mastodon:{row['mastodon_status_id']}"] = linked
            result[row["canonical_id"]] = linked
        return result

    # ── Unified Timeline & Notification Cache ────────────────────────────

    def save_timeline_items(self, stream_key: str, items: list[dict[str, Any]], replace: bool = False) -> None:
        with self._lock, self._connect() as conn:
            if replace:
                conn.execute("DELETE FROM unified_items WHERE stream_key = ?", (stream_key,))
            for item in items:
                if not item or not item.get("id"):
                    continue
                handle = str(item.get("author", {}).get("handle") or "")
                canon = canonicalize_actor_handle(handle, item.get("protocol", "mastodon"))
                ts = parse_iso_ts(item.get("date_published"))
                conn.execute(
                    """
                    INSERT INTO unified_items (stream_key, id, protocol, published_ts, author_handle, canonical_actor, item_json)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(stream_key, id) DO UPDATE SET
                        published_ts=excluded.published_ts,
                        author_handle=excluded.author_handle,
                        canonical_actor=excluded.canonical_actor,
                        item_json=excluded.item_json
                    """,
                    (
                        stream_key,
                        item["id"],
                        item.get("protocol", "mastodon"),
                        ts,
                        handle,
                        canon,
                        json.dumps(item, ensure_ascii=False),
                    ),
                )

    def get_timeline_items(self, stream_key: str, limit: int = 40) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT item_json FROM unified_items WHERE stream_key = ? ORDER BY published_ts DESC LIMIT ?",
                (stream_key, limit),
            ).fetchall()
            items = [json.loads(r["item_json"]) for r in rows]
            masto_ids = [
                it.get("_meta", {}).get("mastodon", {}).get("statusId", "")
                for it in items
            ]
            linked_map = self._linked_lookup_map(conn, masto_ids)
        for it in items:
            linked = linked_map.get(it.get("id"))
            if linked:
                it.setdefault("_meta", {})["linkedIds"] = linked
        return items

    def update_cached_item(self, item: dict[str, Any]) -> None:
        if not item or not item.get("id"):
            return
        ts = parse_iso_ts(item.get("date_published"))
        encoded = json.dumps(item, ensure_ascii=False)
        with self._lock, self._connect() as conn:
            conn.execute(
                "UPDATE unified_items SET published_ts = ?, item_json = ? WHERE id = ?",
                (ts, encoded, item["id"]),
            )

    def remove_cached_item(self, item_or_status_id: str) -> None:
        raw = str(item_or_status_id or "").strip()
        if not raw:
            return
        candidates = {raw, f"mastodon:{raw}", f"bluesky:{raw}", f"threads:{raw}"}
        placeholders = ",".join("?" for _ in candidates)
        with self._lock, self._connect() as conn:
            conn.execute(f"DELETE FROM unified_items WHERE id IN ({placeholders})", list(candidates))

    def save_notifications(self, items: list[dict[str, Any]], replace: bool = False) -> None:
        with self._lock, self._connect() as conn:
            if replace:
                conn.execute("DELETE FROM notifications")
            for item in items:
                if not item or not item.get("id"):
                    continue
                notif_meta = item.get("_meta", {}).get("notification") or {}
                notif_type = str(notif_meta.get("type") or "mention")
                actor_handle = str((notif_meta.get("actor") or item.get("author") or {}).get("handle") or "")
                canon = canonicalize_actor_handle(actor_handle, item.get("protocol", "mastodon"))
                ts = parse_iso_ts(item.get("date_published"))
                conn.execute(
                    """
                    INSERT INTO notifications (id, protocol, notif_type, created_ts, canonical_actor, item_json)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        notif_type=excluded.notif_type,
                        created_ts=excluded.created_ts,
                        canonical_actor=excluded.canonical_actor,
                        item_json=excluded.item_json
                    """,
                    (
                        item["id"],
                        item.get("protocol", "mastodon"),
                        notif_type,
                        ts,
                        canon,
                        json.dumps(item, ensure_ascii=False),
                    ),
                )

    def get_cached_item_by_id(self, any_id: str) -> dict[str, Any] | None:
        raw = str(any_id or "").strip()
        if not raw:
            return None
        candidates = [raw]
        if not raw.startswith(("mastodon:", "bluesky:", "threads:")):
            candidates.extend([f"mastodon:{raw}", f"bluesky:{raw}", f"threads:{raw}"])
        placeholders = ",".join("?" for _ in candidates)
        with self._lock, self._connect() as conn:
            row = conn.execute(
                f"SELECT item_json FROM unified_items WHERE id IN ({placeholders}) ORDER BY published_ts DESC LIMIT 1",
                candidates,
            ).fetchone()
        return json.loads(row["item_json"]) if row else None

    def get_notifications(self, limit: int = 50) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT item_json FROM notifications ORDER BY created_ts DESC LIMIT ?",
                (limit,),
            ).fetchall()
        return [json.loads(r["item_json"]) for r in rows]

    def delete_notifications(self, notif_ids: list[str] | None = None, *, clear_all: bool = False) -> int:
        with self._lock, self._connect() as conn:
            if clear_all:
                cur = conn.execute("DELETE FROM notifications")
                return cur.rowcount
            clean_ids = [str(nid or "").strip() for nid in (notif_ids or []) if str(nid or "").strip()]
            if not clean_ids:
                return 0
            placeholders = ",".join("?" for _ in clean_ids)
            cur = conn.execute(f"DELETE FROM notifications WHERE id IN ({placeholders})", clean_ids)
            return cur.rowcount

    # ── Keyword Filters & Lists Cache ────────────────────────────────────

    def replace_filters(self, rules: list[dict[str, Any]]) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM filter_rules")
            for r in rules:
                self._insert_filter(conn, r)

    def upsert_filter(self, rule: dict[str, Any]) -> dict[str, Any]:
        with self._lock, self._connect() as conn:
            self._insert_filter(conn, rule)
        return rule

    def _insert_filter(self, conn: sqlite3.Connection, r: dict[str, Any]) -> None:
        conn.execute(
            """
            INSERT INTO filter_rules (id, title, phrase, context_json, filter_action, expires_at, mastodon_filter_id)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                phrase=excluded.phrase,
                context_json=excluded.context_json,
                filter_action=excluded.filter_action,
                expires_at=excluded.expires_at,
                mastodon_filter_id=excluded.mastodon_filter_id
            """,
            (
                str(r["id"]),
                str(r.get("title") or r.get("phrase") or ""),
                str(r["phrase"]),
                json.dumps(r.get("context") or ["home", "public", "notifications", "thread"]),
                str(r.get("filter_action") or "hide"),
                str(r.get("expires_at") or ""),
                str(r.get("mastodon_filter_id") or r["id"]),
            ),
        )

    def list_filters(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT * FROM filter_rules ORDER BY title ASC, phrase ASC").fetchall()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "phrase": r["phrase"],
                "context": json.loads(r["context_json"] or '["home","public"]'),
                "filter_action": r["filter_action"],
                "expires_at": r["expires_at"] or None,
                "mastodon_filter_id": r["mastodon_filter_id"] or r["id"],
            }
            for r in rows
        ]

    def delete_filter(self, filter_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                "DELETE FROM filter_rules WHERE id = ? OR mastodon_filter_id = ?",
                (str(filter_id), str(filter_id)),
            )
            return cur.rowcount > 0

    def replace_lists(self, lists: list[dict[str, Any]]) -> None:
        now = time.time()
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM lists_cache")
            for lst in lists:
                conn.execute(
                    """
                    INSERT INTO lists_cache (id, title, replies_policy, exclusive, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        str(lst["id"]),
                        str(lst.get("title") or "Untitled"),
                        str(lst.get("replies_policy") or "list"),
                        1 if lst.get("exclusive") else 0,
                        now,
                    ),
                )

    def list_lists(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT * FROM lists_cache ORDER BY title ASC").fetchall()
        return [
            {
                "id": r["id"],
                "title": r["title"],
                "replies_policy": r["replies_policy"],
                "exclusive": bool(r["exclusive"]),
            }
            for r in rows
        ]

    # ── Resilient Bridge Retry Queue ─────────────────────────────────────

    def enqueue_retry(
        self,
        *,
        retry_id: str,
        operation: str,
        protocol: str,
        payload: dict[str, Any],
        last_error: str,
    ) -> dict[str, Any]:
        now = time.time()
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO retry_queue (id, operation, protocol, payload_json, last_error, attempts, created_at)
                VALUES (?, ?, ?, ?, ?, 1, ?)
                ON CONFLICT(id) DO UPDATE SET
                    last_error=excluded.last_error,
                    attempts=retry_queue.attempts + 1
                """,
                (retry_id, operation, protocol, json.dumps(payload, ensure_ascii=False), str(last_error), now),
            )
        return self.get_retry(retry_id) or {}

    def get_retry(self, retry_id: str) -> dict[str, Any] | None:
        with self._lock, self._connect() as conn:
            row = conn.execute("SELECT * FROM retry_queue WHERE id = ?", (retry_id,)).fetchone()
        if not row:
            return None
        return {
            "id": row["id"],
            "operation": row["operation"],
            "protocol": row["protocol"],
            "payload": json.loads(row["payload_json"]),
            "lastError": row["last_error"],
            "attempts": row["attempts"],
            "createdAt": row["created_at"],
        }

    def list_retries(self) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute("SELECT * FROM retry_queue ORDER BY created_at DESC").fetchall()
        return [
            {
                "id": r["id"],
                "operation": r["operation"],
                "protocol": r["protocol"],
                "payload": json.loads(r["payload_json"]),
                "lastError": r["last_error"],
                "attempts": r["attempts"],
                "createdAt": r["created_at"],
            }
            for r in rows
        ]

    def delete_retry(self, retry_id: str) -> bool:
        with self._lock, self._connect() as conn:
            cur = conn.execute("DELETE FROM retry_queue WHERE id = ?", (retry_id,))
            return cur.rowcount > 0

    # ── Generic Offline Storage KV (replaces IndexedDB) ──────────────────

    def kv_get(self, store_name: str, key: str) -> Any:
        with self._lock, self._connect() as conn:
            row = conn.execute(
                "SELECT value_json FROM kv_store WHERE store_name = ? AND key = ?",
                (store_name, key),
            ).fetchone()
        if not row:
            return None
        return json.loads(row["value_json"])

    def kv_put(self, store_name: str, key: str, value: Any) -> None:
        with self._lock, self._connect() as conn:
            conn.execute(
                """
                INSERT INTO kv_store (store_name, key, value_json, updated_at)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(store_name, key) DO UPDATE SET
                    value_json=excluded.value_json,
                    updated_at=excluded.updated_at
                """,
                (store_name, key, json.dumps(value, ensure_ascii=False), time.time()),
            )

    def kv_delete(self, store_name: str, key: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM kv_store WHERE store_name = ? AND key = ?", (store_name, key))

    def kv_get_all(self, store_name: str) -> list[dict[str, Any]]:
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT key, value_json FROM kv_store WHERE store_name = ? ORDER BY updated_at ASC",
                (store_name,),
            ).fetchall()
        return [{"key": r["key"], "value": json.loads(r["value_json"])} for r in rows]

    def kv_clear(self, store_name: str) -> None:
        with self._lock, self._connect() as conn:
            conn.execute("DELETE FROM kv_store WHERE store_name = ?", (store_name,))

    # ── Local Cross-Network Moderation (e.g. Threads Archive Blocks/Mutes) ─

    @staticmethod
    def _norm_mod_kind(kind: str) -> str:
        raw = str(kind or "").strip().lower()
        return "mute" if raw in ("mute", "mutes") else "block"

    def upsert_moderated_accounts(self, entries: list[dict[str, Any]]) -> int:
        if not entries:
            return 0
        now_ts = time.time()
        with self._lock, self._connect() as conn:
            count = 0
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                handle = str(entry.get("handle") or "").strip().lstrip("@").lower()
                proto = str(entry.get("protocol") or "threads").strip().lower()
                canon = str(entry.get("canonical_actor") or canonicalize_actor_handle(handle, proto))
                kind = self._norm_mod_kind(entry.get("kind") or "block")
                if not canon or not handle:
                    continue
                conn.execute(
                    """
                    INSERT INTO moderated_accounts
                        (canonical_actor, kind, protocol, handle, display_name, federated_acct, created_ts)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(canonical_actor) DO UPDATE SET
                        kind=excluded.kind,
                        protocol=excluded.protocol,
                        handle=excluded.handle,
                        display_name=excluded.display_name,
                        federated_acct=excluded.federated_acct,
                        created_ts=excluded.created_ts
                    """,
                    (
                        canon,
                        kind,
                        proto,
                        handle,
                        str(entry.get("display_name") or handle),
                        str(entry.get("federated_acct") or handle),
                        float(entry.get("created_ts") or now_ts),
                    ),
                )
                count += 1
            return count

    def list_moderated_accounts(self, kind: str) -> list[dict[str, Any]]:
        clean_kind = self._norm_mod_kind(kind)
        with self._lock, self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM moderated_accounts WHERE kind = ? ORDER BY created_ts DESC",
                (clean_kind,),
            ).fetchall()
        return [
            {
                "id": r["canonical_actor"],
                "protocol": r["protocol"],
                "network": r["protocol"],
                "username": r["handle"],
                "acct": r["federated_acct"] or r["handle"],
                "display_name": r["display_name"] or r["handle"],
                "avatar_url": "",
                "localModeration": True,
            }
            for r in rows
        ]

    def delete_moderated_account(self, kind: str, actor_or_handle: str) -> int:
        clean_kind = self._norm_mod_kind(kind)
        raw = str(actor_or_handle or "").strip()
        clean_h = raw.removeprefix("threads:").removeprefix("bluesky:").removeprefix("mastodon:").lstrip("@").split("@")[0].lower()
        candidates = {raw, raw.lower(), f"threads:{clean_h}", f"bluesky:{clean_h}", clean_h, f"{clean_h}@threads.net"}
        placeholders = ",".join("?" for _ in candidates)
        with self._lock, self._connect() as conn:
            cur = conn.execute(
                f"DELETE FROM moderated_accounts WHERE kind = ? AND (canonical_actor IN ({placeholders}) OR handle IN ({placeholders}) OR federated_acct IN ({placeholders}))",
                [clean_kind, *candidates, *candidates, *candidates],
            )
            return cur.rowcount
