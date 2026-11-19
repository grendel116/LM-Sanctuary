"""Bluesky AT Protocol SocialAdapter supporting session refresh, UTF-8 facets, blobs, and notifications."""

from __future__ import annotations

import html
import re
import time
from datetime import datetime, timezone
from typing import Any, Callable
from urllib.parse import urlparse

import httpx

from social.adapters.base import SocialAdapter
from social.core.schema.unified_item import (
    normalize_bluesky_notification,
    normalize_bluesky_post,
    normalize_instance_url,
    plain_text_to_html,
)

DEFAULT_BSKY_SERVICE = "https://bsky.social"
PUBLIC_BSKY_API = "https://public.api.bsky.app"

_URL_RE = re.compile(r"(?:^|[\s(])(https?://[^\s<>()\[\]{}\"']+)")
_MENTION_RE = re.compile(
    r"(?:^|[^\w.])(@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+))(?![a-zA-Z0-9.-])"
)
_TAG_RE = re.compile(r"(?:^|[\s(])(#([^\s#.,!?;:()\[\]{}\"']+))")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _rkey_from_uri(uri: str) -> str:
    return str(uri or "").rsplit("/", 1)[-1]


def extract_utf8_byte_facets(text: str) -> list[dict[str, Any]]:
    """Compute exact UTF-8 byte offsets for links, @mentions, and #hashtags."""
    source = str(text or "")
    if not source:
        return []

    def byte_range(char_start: int, token: str) -> dict[str, int]:
        b_start = len(source[:char_start].encode("utf-8"))
        b_end = b_start + len(token.encode("utf-8"))
        return {"byteStart": b_start, "byteEnd": b_end}

    candidates: list[dict[str, Any]] = []

    for m in _URL_RE.finditer(source):
        raw_url = m.group(1).rstrip(".,!?;:")
        if not raw_url:
            continue
        parsed = urlparse(raw_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            continue
        c_start = m.start() + m.group(0).index(m.group(1))
        candidates.append({
            "index": byte_range(c_start, raw_url),
            "features": [{"$type": "app.bsky.richtext.facet#link", "uri": raw_url}],
        })

    for m in _MENTION_RE.finditer(source):
        full_mention = m.group(1)
        handle = m.group(2)
        c_start = m.start() + m.group(0).index(full_mention)
        candidates.append({
            "index": byte_range(c_start, full_mention),
            "features": [{"$type": "app.bsky.richtext.facet#mention", "did": ""}],
            "_handle": handle.lower(),
        })

    for m in _TAG_RE.finditer(source):
        full_tag = m.group(1)
        tag_val = m.group(2).rstrip(".,!?;:")
        if not tag_val or tag_val.isdigit() or len(tag_val.encode("utf-8")) > 64:
            continue
        clean_token = f"#{tag_val}"
        c_start = m.start() + m.group(0).index(full_tag)
        candidates.append({
            "index": byte_range(c_start, clean_token),
            "features": [{"$type": "app.bsky.richtext.facet#tag", "tag": tag_val}],
        })

    candidates.sort(key=lambda item: item["index"]["byteStart"])
    filtered: list[dict[str, Any]] = []
    last_end = 0
    for facet in candidates:
        if facet["index"]["byteStart"] < last_end:
            continue
        filtered.append(facet)
        last_end = facet["index"]["byteEnd"]
    return filtered


_HREF_RE = re.compile(r"""<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')""", re.IGNORECASE)


def _extract_http_url(raw_value: str | None) -> str:
    text = str(raw_value or "").strip()
    if not text:
        return ""
    m = _HREF_RE.search(text)
    candidate = (m.group(1) or m.group(2)) if m else text
    decoded = html.unescape(candidate).strip()
    if not decoded:
        return ""
    parsed = urlparse(decoded)
    if parsed.scheme in ("http", "https") and parsed.netloc:
        return decoded
    return ""


def _host_label(url: str) -> str:
    host = (urlparse(url).netloc or "").lower()
    return host[4:] if host.startswith("www.") else (host or url)


class BlueskyAdapter(SocialAdapter):
    """Symmetric AT Protocol SocialAdapter for automatic background bridging."""

    protocol = "bluesky"

    def __init__(
        self,
        *,
        service_url: str = DEFAULT_BSKY_SERVICE,
        did: str = "",
        handle: str = "",
        access_jwt: str = "",
        refresh_jwt: str = "",
        on_session_refreshed: Callable[[dict[str, Any]], None] | None = None,
        http_client: httpx.Client | None = None,
    ) -> None:
        self.service_url = normalize_instance_url(service_url or DEFAULT_BSKY_SERVICE, default=DEFAULT_BSKY_SERVICE)
        self.did = str(did or "")
        self.handle = str(handle or "")
        self.access_jwt = str(access_jwt or "")
        self.refresh_jwt = str(refresh_jwt or "")
        self.on_session_refreshed = on_session_refreshed
        self._client = http_client or httpx.Client(timeout=20.0)
        self._metrics_cache: dict[str, tuple[float, dict[str, int]]] = {}

    def _xrpc(
        self,
        endpoint: str,
        *,
        method: str = "GET",
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        content: bytes | None = None,
        headers: dict[str, str] | None = None,
        service_override: str | None = None,
        retry_refresh: bool = True,
        unauthenticated: bool = False,
    ) -> dict[str, Any]:
        origin = normalize_instance_url(service_override or self.service_url, default=DEFAULT_BSKY_SERVICE)
        url = f"{origin}/xrpc/{endpoint}"

        def send(token: str) -> httpx.Response:
            hdrs = dict(headers or {})
            if token:
                hdrs["Authorization"] = f"Bearer {token}"
            return self._client.request(method.upper(), url, params=params, json=json_body, content=content, headers=hdrs)

        res = send("" if unauthenticated else self.access_jwt)
        is_expired = res.status_code == 401
        if not is_expired and res.status_code == 400:
            try:
                is_expired = res.json().get("error") == "ExpiredToken"
            except Exception:
                is_expired = False

        if is_expired and retry_refresh and not unauthenticated and self.refresh_jwt:
            ref_res = self._client.post(
                f"{self.service_url}/xrpc/com.atproto.server.refreshSession",
                headers={"Authorization": f"Bearer {self.refresh_jwt}"},
            )
            if ref_res.status_code < 400:
                ref_data = ref_res.json()
                self.access_jwt = str(ref_data.get("accessJwt") or self.access_jwt)
                self.refresh_jwt = str(ref_data.get("refreshJwt") or self.refresh_jwt)
                if self.on_session_refreshed:
                    self.on_session_refreshed(ref_data)
                res = send(self.access_jwt)

        if res.status_code >= 400:
            detail = res.text[:300]
            try:
                err_json = res.json()
                detail = err_json.get("message") or err_json.get("error") or detail
            except Exception:
                pass
            raise RuntimeError(f"Bluesky API {res.status_code} ({endpoint}): {detail}")
        return res.json() if res.content else {}

    def _xrpc_public_read(self, endpoint: str, *, params: dict[str, Any] | None = None) -> dict[str, Any]:
        service = normalize_instance_url(
            self.service_url if self.access_jwt else PUBLIC_BSKY_API,
            default=DEFAULT_BSKY_SERVICE,
        )
        public_origin = normalize_instance_url(PUBLIC_BSKY_API, default=PUBLIC_BSKY_API)
        try:
            return self._xrpc(
                endpoint,
                params=params,
                service_override=service,
                unauthenticated=not bool(self.access_jwt),
            )
        except RuntimeError as exc:
            msg = str(exc)
            if service != public_origin and any(f"Bluesky API {code} " in msg for code in (400, 401, 403)):
                return self._xrpc(
                    endpoint,
                    params=params,
                    service_override=public_origin,
                    retry_refresh=False,
                    unauthenticated=True,
                )
            raise

    @classmethod
    def create_session(
        cls,
        identifier: str,
        password: str,
        *,
        service_url: str = DEFAULT_BSKY_SERVICE,
        http_client: httpx.Client | None = None,
    ) -> dict[str, Any]:
        origin = normalize_instance_url(service_url or DEFAULT_BSKY_SERVICE, default=DEFAULT_BSKY_SERVICE)
        client = http_client or httpx.Client(timeout=20.0)
        res = client.post(
            f"{origin}/xrpc/com.atproto.server.createSession",
            json={"identifier": identifier, "password": password},
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Bluesky login failed ({res.status_code}): {res.text[:250]}")
        session = res.json()
        prof_res = client.get(
            f"{origin}/xrpc/app.bsky.actor.getProfile",
            params={"actor": session.get("did") or identifier},
            headers={"Authorization": f"Bearer {session.get('accessJwt', '')}"},
        )
        profile = prof_res.json() if prof_res.status_code < 400 else {}
        return {
            "service_url": origin,
            "did": session.get("did") or "",
            "handle": session.get("handle") or identifier,
            "accessJwt": session.get("accessJwt") or "",
            "refreshJwt": session.get("refreshJwt") or "",
            "displayName": profile.get("displayName") or session.get("handle") or identifier,
            "avatar": profile.get("avatar") or "",
        }

    def _resolve_mentions(self, raw_facets: list[dict[str, Any]]) -> list[dict[str, Any]]:
        resolved = []
        for f in raw_facets:
            handle = f.get("_handle")
            if not handle:
                resolved.append(f)
                continue
            try:
                data = self._xrpc(
                    "com.atproto.identity.resolveHandle",
                    params={"handle": handle},
                    service_override=self.service_url or PUBLIC_BSKY_API,
                )
                if data.get("did"):
                    resolved.append({
                        "index": f["index"],
                        "features": [{"$type": "app.bsky.richtext.facet#mention", "did": data["did"]}],
                    })
            except Exception:
                continue
        return resolved

    def upload_blob(self, raw_bytes: bytes, mime_type: str = "image/jpeg") -> dict[str, Any]:
        data = self._xrpc(
            "com.atproto.repo.uploadBlob",
            method="POST",
            content=raw_bytes,
            headers={"Content-Type": mime_type},
        )
        return data.get("blob") or {}

    def publish(
        self,
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        text = str(draft or "")
        facets = self._resolve_mentions(extract_utf8_byte_facets(text)) if opts.get("resolve_mentions", True) else [
            f for f in extract_utf8_byte_facets(text) if not f.get("_handle")
        ]

        record: dict[str, Any] = {
            "$type": "app.bsky.feed.post",
            "text": text,
            "createdAt": _now_iso(),
            "langs": opts.get("langs") or ["en"],
        }
        if facets:
            record["facets"] = facets
        if opts.get("reply"):
            record["reply"] = opts["reply"]

        images_embed = []
        for att in (media or [])[:4]:
            raw_bytes = att.get("bytes")
            mime = str(att.get("mime_type") or "image/jpeg")
            if raw_bytes and mime.startswith("image/"):
                blob = self.upload_blob(raw_bytes, mime)
                if blob:
                    images_embed.append({"alt": str(att.get("alt_text") or ""), "image": blob})
        resolved_ext_card: dict[str, Any] | None = None
        if images_embed:
            record["embed"] = {"$type": "app.bsky.embed.images", "images": images_embed}
        elif isinstance(opts.get("external_embed"), dict):
            ext = opts["external_embed"]
            ext_url = str(ext.get("url") or "").strip()
            if ext_url.startswith("https://"):
                ext_payload: dict[str, Any] = {
                    "uri": ext_url,
                    "title": str(ext.get("title") or ext_url)[:300],
                    "description": str(ext.get("description") or "")[:1000],
                }
                img_url = str(ext.get("image") or "").strip()
                if img_url.startswith("https://"):
                    try:
                        from social.link_preview import fetch_public_image_bytes

                        fetched = fetch_public_image_bytes(img_url, http_client=self._client)
                        if fetched:
                            thumb_blob = self.upload_blob(fetched[0], fetched[1])
                            if thumb_blob:
                                ext_payload["thumb"] = thumb_blob
                    except Exception:
                        pass
                record["embed"] = {"$type": "app.bsky.embed.external", "external": ext_payload}
                resolved_ext_card = dict(ext)

        created = self._xrpc(
            "com.atproto.repo.createRecord",
            method="POST",
            json_body={"repo": self.did, "collection": "app.bsky.feed.post", "record": record},
        )
        uri = str(created.get("uri") or "")
        cid = str(created.get("cid") or "")
        rkey = _rkey_from_uri(uri)
        out_meta: dict[str, Any] = {"bluesky": {"uri": uri, "cid": cid}}
        if resolved_ext_card:
            out_meta["linkCard"] = resolved_ext_card
        return {
            "id": f"bluesky:{uri or cid}",
            "protocol": "bluesky",
            "url": f"https://bsky.app/profile/{self.handle}/post/{rkey}" if self.handle and rkey else "",
            "content_html": plain_text_to_html(text),
            "content_text": text,
            "date_published": record["createdAt"],
            "author": {
                "id": self.did,
                "name": self.handle,
                "handle": self.handle,
                "avatar_url": "",
                "url": f"https://bsky.app/profile/{self.handle}" if self.handle else "",
            },
            "attachments": [],
            "metrics": {"replies": 0, "reposts": 0, "likes": 0},
            "_meta": out_meta,
        }

    def delete(self, native_meta: dict[str, Any]) -> bool:
        uri = str(native_meta.get("uri") or native_meta.get("blueskyUri") or "")
        rkey = _rkey_from_uri(uri)
        if not rkey:
            return False
        try:
            self._xrpc(
                "com.atproto.repo.deleteRecord",
                method="POST",
                json_body={"repo": self.did, "collection": "app.bsky.feed.post", "rkey": rkey},
            )
        except RuntimeError as exc:
            msg = str(exc)
            if "404" in msg or "RecordNotFound" in msg or "Could not locate record" in msg:
                return True
            raise
        return True

    def reply(
        self,
        target_item: dict[str, Any],
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        bsky_meta = target_item.get("_meta", {}).get("bluesky") or {}
        uri = str(bsky_meta.get("uri") or target_item.get("id", "").removeprefix("bluesky:"))
        cid = str(bsky_meta.get("cid") or "")
        if uri and not cid:
            try:
                data = self._xrpc_public_read("app.bsky.feed.getPosts", params={"uris": [uri]})
                posts = data.get("posts") or []
                if posts and isinstance(posts[0], dict):
                    cid = str(posts[0].get("cid") or "")
            except Exception:
                cid = ""
        if not uri or not cid:
            raise ValueError("Target item missing Bluesky uri and cid")
        parent_ref = {"uri": uri, "cid": cid}
        root_ref = (bsky_meta.get("reply") or {}).get("root") or parent_ref
        merged_opts = {**(options or {}), "reply": {"root": root_ref, "parent": parent_ref}}
        return self.publish(draft, media=media, options=merged_opts)

    def like(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        bsky_meta = dict(target_item.get("_meta", {}).get("bluesky") or {})
        uri = str(bsky_meta.get("uri") or "")
        cid = str(bsky_meta.get("cid") or "")
        like_uri = bsky_meta.get("likeUri")
        delta = 0
        if (undo or like_uri) and like_uri:
            self._xrpc(
                "com.atproto.repo.deleteRecord",
                method="POST",
                json_body={"repo": self.did, "collection": "app.bsky.feed.like", "rkey": _rkey_from_uri(like_uri)},
            )
            bsky_meta["likeUri"] = None
            delta = -1
        elif not undo:
            res = self._xrpc(
                "com.atproto.repo.createRecord",
                method="POST",
                json_body={
                    "repo": self.did,
                    "collection": "app.bsky.feed.like",
                    "record": {"$type": "app.bsky.feed.like", "subject": {"uri": uri, "cid": cid}, "createdAt": _now_iso()},
                },
            )
            bsky_meta["likeUri"] = res.get("uri")
            delta = 1

        metrics = dict(target_item.get("metrics") or {})
        metrics["likes"] = max(0, int(metrics.get("likes") or 0) + delta)
        return {**target_item, "metrics": metrics, "_meta": {**target_item.get("_meta", {}), "bluesky": bsky_meta}}

    def repost(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        bsky_meta = dict(target_item.get("_meta", {}).get("bluesky") or {})
        uri = str(bsky_meta.get("uri") or "")
        cid = str(bsky_meta.get("cid") or "")
        repost_uri = bsky_meta.get("repostUri")
        delta = 0
        if (undo or repost_uri) and repost_uri:
            self._xrpc(
                "com.atproto.repo.deleteRecord",
                method="POST",
                json_body={"repo": self.did, "collection": "app.bsky.feed.repost", "rkey": _rkey_from_uri(repost_uri)},
            )
            bsky_meta["repostUri"] = None
            delta = -1
        elif not undo:
            res = self._xrpc(
                "com.atproto.repo.createRecord",
                method="POST",
                json_body={
                    "repo": self.did,
                    "collection": "app.bsky.feed.repost",
                    "record": {"$type": "app.bsky.feed.repost", "subject": {"uri": uri, "cid": cid}, "createdAt": _now_iso()},
                },
            )
            bsky_meta["repostUri"] = res.get("uri")
            delta = 1

        metrics = dict(target_item.get("metrics") or {})
        metrics["reposts"] = max(0, int(metrics.get("reposts") or 0) + delta)
        return {**target_item, "metrics": metrics, "_meta": {**target_item.get("_meta", {}), "bluesky": bsky_meta}}

    def fetch_timeline(self, stream: str = "home", cursor: str = "", limit: int = 25, **kwargs: Any) -> dict[str, Any]:
        params = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        data = self._xrpc("app.bsky.feed.getTimeline", params=params)
        items = [normalize_bluesky_post(it) for it in data.get("feed", [])]
        return {"items": items, "next_cursor": data.get("cursor")}

    def fetch_notifications(self, cursor: str = "", limit: int = 30) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["cursor"] = cursor
        data = self._xrpc("app.bsky.notification.listNotifications", params=params)
        items = [
            normalize_bluesky_notification(row)
            for row in data.get("notifications", [])
            if row.get("reason") in ("reply", "mention", "quote", "like", "repost", "follow")
        ]
        subject_uris = list(
            dict.fromkeys(
                u
                for it in items
                for u in [str(((it.get("_meta") or {}).get("bluesky") or {}).get("subjectUri") or "")]
                if u.startswith("at://")
            )
        )[:25]
        if subject_uris:
            try:
                posts_res = self._xrpc_public_read("app.bsky.feed.getPosts", params={"uris": subject_uris})
                posts_by_uri: dict[str, dict[str, Any]] = {}
                for raw_post in posts_res.get("posts") or []:
                    if isinstance(raw_post, dict) and raw_post.get("uri"):
                        posts_by_uri[str(raw_post["uri"])] = normalize_bluesky_post({"post": raw_post})
                for it in items:
                    meta = it.setdefault("_meta", {})
                    bsky_meta = meta.setdefault("bluesky", {})
                    notif_meta = meta.setdefault("notification", {})
                    subj_uri = str(bsky_meta.get("subjectUri") or "")
                    subj = posts_by_uri.get(subj_uri)
                    if not subj:
                        continue
                    notif_meta["targetPost"] = {
                        "id": subj.get("id") or "",
                        "uri": subj_uri,
                        "cid": str((subj.get("_meta", {}).get("bluesky") or {}).get("cid") or ""),
                        "text": subj.get("content_text") or "",
                        "url": subj.get("url") or "",
                        "attachments": subj.get("attachments") or [],
                        "metrics": dict(subj.get("metrics") or {}),
                    }
                    kind = str(notif_meta.get("type") or "")
                    if kind in ("like", "repost"):
                        it["content_text"] = subj.get("content_text") or ""
                        it["content_html"] = subj.get("content_html") or ""
                        it["attachments"] = subj.get("attachments") or []
                        it["url"] = subj.get("url") or it.get("url") or ""
                        it["metrics"] = dict(subj.get("metrics") or {})
                        bsky_meta["uri"] = subj_uri
                        bsky_meta["cid"] = str((subj.get("_meta", {}).get("bluesky") or {}).get("cid") or bsky_meta.get("cid") or "")
                    elif kind in ("reply", "quote", "mention"):
                        notif_meta["targetMetrics"] = dict(subj.get("metrics") or {})
            except Exception:
                pass
        return items

    def update_notifications_seen(self, seen_at: str = "") -> bool:
        """Mark Bluesky notifications as seen up to seen_at."""
        self._xrpc(
            "app.bsky.notification.updateSeen",
            method="POST",
            json_body={"seenAt": seen_at or _now_iso()},
        )
        return True

    @staticmethod
    def _build_rel(viewer: dict[str, Any] | None) -> dict[str, Any]:
        v = viewer if isinstance(viewer, dict) else {}
        return {
            "following": bool(v.get("following")),
            "followUri": v.get("following") or None,
            "followed_by": bool(v.get("followedBy")),
            "muting": bool(v.get("muted")),
            "blocking": bool(v.get("blocking")),
            "blockUri": v.get("blocking") or None,
        }

    def _normalize_actor_summary(self, raw: dict[str, Any]) -> dict[str, Any]:
        did = str(raw.get("did") or "")
        handle = str(raw.get("handle") or did)
        viewer = raw.get("viewer") if isinstance(raw.get("viewer"), dict) else {}
        return {
            "id": did,
            "did": did,
            "protocol": "bluesky",
            "network": "bluesky",
            "username": handle,
            "acct": handle,
            "display_name": str(raw.get("displayName") or handle),
            "avatar_url": str(raw.get("avatar") or ""),
            "url": f"https://bsky.app/profile/{handle}" if handle else "",
            "note_text": str(raw.get("description") or ""),
            "viewer": viewer,
            "relationship": self._build_rel(viewer),
        }

    def fetch_actor_profile(self, actor: str) -> dict[str, Any]:
        raw = self._xrpc_public_read(
            "app.bsky.actor.getProfile",
            params={"actor": str(actor or "")},
        )
        did = str(raw.get("did") or "")
        handle = str(raw.get("handle") or did)
        description = str(raw.get("description") or "")
        viewer = raw.get("viewer") if isinstance(raw.get("viewer"), dict) else {}
        fields: list[dict[str, Any]] = []
        for item in (raw.get("links") or [])[:4]:
            if not isinstance(item, dict):
                continue
            url = _extract_http_url(item.get("url"))
            if not url:
                continue
            title = str(item.get("title") or "").strip() or _host_label(url)
            fields.append({
                "name": title,
                "value": url,
                "uri": str(item.get("uri") or ""),
                "cid": str(item.get("cid") or ""),
            })
        pronouns = str(raw.get("pronouns") or "").strip()
        if pronouns:
            fields.append({"name": "Pronouns", "value": pronouns})
        return {
            "profile": {
                "id": did,
                "did": did,
                "protocol": "bluesky",
                "username": handle,
                "acct": handle,
                "display_name": str(raw.get("displayName") or handle),
                "avatar_url": str(raw.get("avatar") or ""),
                "header_url": str(raw.get("banner") or ""),
                "url": f"https://bsky.app/profile/{handle}" if handle else "",
                "note_html": plain_text_to_html(description) if description else "",
                "note_text": description,
                "fields": fields[:4],
                "followers_count": int(raw.get("followersCount") or 0),
                "following_count": int(raw.get("followsCount") or 0),
                "statuses_count": int(raw.get("postsCount") or 0),
            },
            "relationship": self._build_rel(viewer),
        }

    def _fetch_graph_page(self, endpoint: str, list_key: str, actor: str, cursor: str = "", limit: int = 40) -> dict[str, Any]:
        params: dict[str, Any] = {"actor": str(actor or ""), "limit": min(max(int(limit), 1), 100)}
        if cursor:
            params["cursor"] = cursor
        data = self._xrpc_public_read(
            endpoint,
            params=params,
        )
        accounts = [self._normalize_actor_summary(a) for a in (data.get(list_key) or []) if isinstance(a, dict)]
        return {"accounts": accounts, "next_cursor": data.get("cursor") or None}

    def list_follows(self, actor: str, *, cursor: str = "", limit: int = 40) -> dict[str, Any]:
        return self._fetch_graph_page("app.bsky.graph.getFollows", "follows", actor, cursor=cursor, limit=limit)

    def list_followers(self, actor: str, *, cursor: str = "", limit: int = 40) -> dict[str, Any]:
        return self._fetch_graph_page("app.bsky.graph.getFollowers", "followers", actor, cursor=cursor, limit=limit)

    def list_mutes(self, limit: int = 100) -> list[dict[str, Any]]:
        data = self._xrpc("app.bsky.graph.getMutes", params={"limit": min(max(int(limit), 1), 100)})
        return [self._normalize_actor_summary(a) for a in (data.get("mutes") or []) if isinstance(a, dict)]

    def list_blocks(self, limit: int = 100) -> list[dict[str, Any]]:
        data = self._xrpc("app.bsky.graph.getBlocks", params={"limit": min(max(int(limit), 1), 100)})
        return [self._normalize_actor_summary(a) for a in (data.get("blocks") or []) if isinstance(a, dict)]

    def search_actors(self, query: str, *, limit: int = 15) -> list[dict[str, Any]]:
        data = self._xrpc_public_read(
            "app.bsky.actor.searchActors",
            params={"q": str(query or ""), "limit": min(max(int(limit), 1), 25)},
        )
        return [self._normalize_actor_summary(a) for a in (data.get("actors") or []) if isinstance(a, dict)]

    def search_posts(self, query: str, *, limit: int = 15) -> list[dict[str, Any]]:
        data = self._xrpc_public_read(
            "app.bsky.feed.searchPosts",
            params={"q": str(query or ""), "limit": min(max(int(limit), 1), 25)},
        )
        return [normalize_bluesky_post({"post": p}) for p in (data.get("posts") or []) if isinstance(p, dict)]

    def update_profile(
        self,
        *,
        display_name: str | None = None,
        description: str | None = None,
        fields: list[dict[str, Any]] | None = None,
        avatar_bytes: tuple[str, bytes, str] | None = None,
        header_bytes: tuple[str, bytes, str] | None = None,
        remove_avatar: bool = False,
        remove_header: bool = False,
    ) -> dict[str, Any]:
        try:
            existing_res = self._xrpc(
                "com.atproto.repo.getRecord",
                params={"repo": self.did, "collection": "app.bsky.actor.profile", "rkey": "self"},
            )
            existing_value = existing_res.get("value") if isinstance(existing_res.get("value"), dict) else {}
        except Exception:
            existing_value = {}

        try:
            existing_links_res = self._xrpc(
                "com.atproto.repo.listRecords",
                params={"repo": self.did, "collection": "app.bsky.actor.link", "limit": 50},
            )
            existing_links = existing_links_res.get("records") or []
        except Exception:
            existing_links = []

        record: dict[str, Any] = {
            **existing_value,
            "$type": "app.bsky.actor.profile",
            "createdAt": existing_value.get("createdAt") or _now_iso(),
        }
        if display_name is not None:
            record["displayName"] = str(display_name).strip()[:64]
        if description is not None:
            record["description"] = str(description).strip()[:256]

        if fields is not None:
            desired_links: list[dict[str, str]] = []
            desired_pronouns = ""
            for f in fields[:4]:
                if not isinstance(f, dict):
                    continue
                name = str(f.get("name") or "").strip()
                val = str(f.get("value") or "").strip()
                href = _extract_http_url(val)
                if href:
                    title = (name if name and not name.lower().startswith(("http://", "https://")) else _host_label(href))[:100]
                    desired_links.append({"url": href, "title": title})
                elif name.lower() == "pronouns":
                    desired_pronouns = val[:64]

            used_uris: set[str] = set()
            strong_refs: list[dict[str, str]] = []
            for desired in desired_links:
                match = next(
                    (
                        rec
                        for rec in existing_links
                        if rec.get("uri")
                        and rec.get("uri") not in used_uris
                        and rec.get("cid")
                        and (rec.get("value") or {}).get("url") == desired["url"]
                        and str((rec.get("value") or {}).get("title") or "") == desired["title"]
                    ),
                    None,
                )
                if match:
                    used_uris.add(match["uri"])
                    strong_refs.append({"uri": match["uri"], "cid": match["cid"]})
                else:
                    created = self._xrpc(
                        "com.atproto.repo.createRecord",
                        method="POST",
                        json_body={
                            "repo": self.did,
                            "collection": "app.bsky.actor.link",
                            "record": {
                                "$type": "app.bsky.actor.link",
                                "url": desired["url"],
                                "title": desired["title"],
                                "createdAt": _now_iso(),
                            },
                        },
                    )
                    if created.get("uri") and created.get("cid"):
                        used_uris.add(created["uri"])
                        strong_refs.append({"uri": created["uri"], "cid": created["cid"]})

            for stale in existing_links:
                stale_uri = str(stale.get("uri") or "")
                if stale_uri and stale_uri not in used_uris:
                    rkey = _rkey_from_uri(stale_uri)
                    if rkey:
                        try:
                            self._xrpc(
                                "com.atproto.repo.deleteRecord",
                                method="POST",
                                json_body={"repo": self.did, "collection": "app.bsky.actor.link", "rkey": rkey},
                            )
                        except Exception:
                            pass

            if strong_refs:
                record["links"] = strong_refs
            else:
                record.pop("links", None)
            if desired_pronouns:
                record["pronouns"] = desired_pronouns
            else:
                record.pop("pronouns", None)

        if avatar_bytes:
            blob = self.upload_blob(avatar_bytes[1], avatar_bytes[2] or "image/jpeg")
            if blob:
                record["avatar"] = blob
        elif remove_avatar:
            record.pop("avatar", None)

        if header_bytes:
            blob = self.upload_blob(header_bytes[1], header_bytes[2] or "image/jpeg")
            if blob:
                record["banner"] = blob
        elif remove_header:
            record.pop("banner", None)

        self._xrpc(
            "com.atproto.repo.putRecord",
            method="POST",
            json_body={
                "repo": self.did,
                "collection": "app.bsky.actor.profile",
                "rkey": "self",
                "record": record,
            },
        )
        return self.fetch_actor_profile(self.did)

    def fetch_author_feed(self, actor: str, *, tab: str = "posts", cursor: str = "", limit: int = 15) -> list[dict[str, Any]]:
        feed_filter = "posts_with_media" if tab == "media" else ("posts_with_replies" if tab == "replies" else "posts_no_replies")
        params: dict[str, Any] = {"actor": str(actor or ""), "limit": limit, "filter": feed_filter}
        if cursor:
            params["cursor"] = cursor
        data = self._xrpc_public_read(
            "app.bsky.feed.getAuthorFeed",
            params=params,
        )
        return [normalize_bluesky_post(it) for it in data.get("feed", [])]

    def get_posts_metrics(self, uris: list[str]) -> dict[str, dict[str, int]]:
        """Batch-fetch engagement counts (likes, replies, reposts + quotes) via app.bsky.feed.getPosts."""
        clean_uris: list[str] = []
        seen: set[str] = set()
        for raw in uris or []:
            u = str(raw or "").removeprefix("bluesky:").strip()
            if u.startswith("at://") and u not in seen:
                seen.add(u)
                clean_uris.append(u)
        if not clean_uris:
            return {}

        now = time.time()
        out: dict[str, dict[str, int]] = {}
        to_fetch: list[str] = []
        for u in clean_uris:
            cached = self._metrics_cache.get(u)
            if cached and cached[0] > now:
                out[u] = dict(cached[1])
            else:
                to_fetch.append(u)

        for start in range(0, len(to_fetch), 25):
            chunk = to_fetch[start : start + 25]
            try:
                data = self._xrpc_public_read("app.bsky.feed.getPosts", params={"uris": chunk})
                for post in data.get("posts") or []:
                    if not isinstance(post, dict) or not post.get("uri"):
                        continue
                    uri_val = str(post["uri"])
                    m = {
                        "likes": int(post.get("likeCount") or 0),
                        "replies": int(post.get("replyCount") or 0),
                        "reposts": int(post.get("repostCount") or 0) + int(post.get("quoteCount") or 0),
                    }
                    out[uri_val] = m
                    self._metrics_cache[uri_val] = (now + 60.0, dict(m))
            except Exception:
                continue
        return out

    def get_post_thread(self, uri: str, *, depth: int = 6, parent_height: int = 20) -> dict[str, Any]:
        clean_uri = str(uri or "").strip()
        if clean_uri.startswith("bluesky:"):
            clean_uri = clean_uri[len("bluesky:"):]
        if not clean_uri:
            return {"status": None, "ancestors": [], "descendants": []}

        data = self._xrpc_public_read(
            "app.bsky.feed.getPostThread",
            params={"uri": clean_uri, "depth": depth, "parentHeight": parent_height},
        )
        thread = data.get("thread") if isinstance(data.get("thread"), dict) else {}

        ancestors: list[dict[str, Any]] = []
        seen_ancestors: set[str] = set()
        parent_node = thread.get("parent")
        while isinstance(parent_node, dict):
            p_post = parent_node.get("post")
            if not isinstance(p_post, dict) or not p_post.get("uri"):
                break
            p_uri = str(p_post["uri"])
            if p_uri in seen_ancestors:
                break
            seen_ancestors.add(p_uri)
            ancestors.append(normalize_bluesky_post({"post": p_post}))
            parent_node = parent_node.get("parent")
        ancestors.reverse()

        focal_post = thread.get("post") if isinstance(thread.get("post"), dict) else None
        focal = normalize_bluesky_post({"post": focal_post}) if focal_post and focal_post.get("uri") else None

        root_ref: dict[str, str] | None = None
        if ancestors:
            a0_meta = (ancestors[0].get("_meta") or {}).get("bluesky") or {}
            if a0_meta.get("uri") and a0_meta.get("cid"):
                root_ref = {"uri": a0_meta["uri"], "cid": a0_meta["cid"]}
        elif focal:
            f_meta = (focal.get("_meta") or {}).get("bluesky") or {}
            f_reply_root = (f_meta.get("reply") or {}).get("root") or {}
            if f_reply_root.get("uri") and f_reply_root.get("cid"):
                root_ref = {"uri": f_reply_root["uri"], "cid": f_reply_root["cid"]}
            elif f_meta.get("uri") and f_meta.get("cid"):
                root_ref = {"uri": f_meta["uri"], "cid": f_meta["cid"]}

        descendants: list[dict[str, Any]] = []
        seen_replies: set[str] = set()

        def walk(nodes: Any, cur_depth: int, parent_did: str, parent_ref: dict[str, str] | None) -> None:
            if not isinstance(nodes, list):
                return
            valid = [
                n for n in nodes
                if isinstance(n, dict)
                and isinstance(n.get("post"), dict)
                and n["post"].get("uri")
                and str(n["post"]["uri"]) not in seen_replies
            ]

            def sort_key(n: dict[str, Any]) -> tuple[int, str]:
                post_obj = n.get("post") or {}
                author_did = str((post_obj.get("author") or {}).get("did") or "")
                is_self = 0 if parent_did and author_did == parent_did else 1
                rec = post_obj.get("record") if isinstance(post_obj.get("record"), dict) else {}
                ts = str(rec.get("createdAt") or post_obj.get("indexedAt") or "")
                return (is_self, ts)

            valid.sort(key=sort_key)
            for node in valid:
                r_post = node["post"]
                r_uri = str(r_post["uri"])
                seen_replies.add(r_uri)
                norm = normalize_bluesky_post({"post": r_post})
                bsky_meta = norm.setdefault("_meta", {}).setdefault("bluesky", {})
                existing_reply = bsky_meta.get("reply")
                if not isinstance(existing_reply, dict) and root_ref and parent_ref:
                    bsky_meta["reply"] = {"root": root_ref, "parent": parent_ref}
                elif isinstance(existing_reply, dict) and root_ref and not existing_reply.get("root"):
                    bsky_meta["reply"] = {**existing_reply, "root": root_ref}
                norm["_threadDepth"] = cur_depth
                descendants.append(norm)
                walk(
                    node.get("replies"),
                    cur_depth + 1,
                    str((r_post.get("author") or {}).get("did") or ""),
                    {"uri": bsky_meta.get("uri") or r_uri, "cid": str(bsky_meta.get("cid") or "")},
                )

        if focal:
            f_meta = (focal.get("_meta") or {}).get("bluesky") or {}
            walk(
                thread.get("replies"),
                0,
                str((focal_post or {}).get("author", {}).get("did") or ""),
                {"uri": str(f_meta.get("uri") or clean_uri), "cid": str(f_meta.get("cid") or "")},
            )

        return {"status": focal, "ancestors": ancestors, "descendants": descendants}

    def _toggle_graph_record(self, collection: str, target_did: str, record_uri: str | None, undo: bool) -> tuple[bool, str | None]:
        if undo:
            resolved_uri = record_uri
            if not resolved_uri and target_did:
                try:
                    listed = self._xrpc(
                        "com.atproto.repo.listRecords",
                        params={"repo": self.did, "collection": collection, "limit": 100},
                    )
                    for rec in listed.get("records") or []:
                        if isinstance(rec, dict) and (rec.get("value") or {}).get("subject") == target_did and rec.get("uri"):
                            resolved_uri = str(rec["uri"])
                            break
                except Exception:
                    resolved_uri = None
            if resolved_uri:
                self._xrpc(
                    "com.atproto.repo.deleteRecord",
                    method="POST",
                    json_body={"repo": self.did, "collection": collection, "rkey": _rkey_from_uri(resolved_uri)},
                )
            return False, None
        res = self._xrpc(
            "com.atproto.repo.createRecord",
            method="POST",
            json_body={
                "repo": self.did,
                "collection": collection,
                "record": {"$type": collection, "subject": target_did, "createdAt": _now_iso()},
            },
        )
        return True, res.get("uri") or None

    def follow_actor(self, target_did: str, *, follow_uri: str | None = None, undo: bool = False) -> dict[str, Any]:
        active, uri = self._toggle_graph_record("app.bsky.graph.follow", target_did, follow_uri, undo)
        return {"following": active, "followUri": (uri or "followed") if active else None}

    def mute_actor(self, actor: str, *, undo: bool = False) -> dict[str, Any]:
        endpoint = "app.bsky.graph.unmuteActor" if undo else "app.bsky.graph.muteActor"
        self._xrpc(endpoint, method="POST", json_body={"actor": actor})
        return {"muting": not undo}

    def block_actor(self, target_did: str, *, block_uri: str | None = None, undo: bool = False) -> dict[str, Any]:
        active, uri = self._toggle_graph_record("app.bsky.graph.block", target_did, block_uri, undo)
        return {"blocking": active, "blockUri": (uri or "blocked") if active else None}
