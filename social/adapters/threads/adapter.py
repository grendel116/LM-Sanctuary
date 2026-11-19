"""Threads Graph API SocialAdapter with OAuth 2.0, 60-day token lifecycle, conversation trees, search, and mention sync."""

from __future__ import annotations

import re
import time
from concurrent.futures import ThreadPoolExecutor
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from social.adapters.base import SocialAdapter
from social.core.schema.unified_item import (
    is_allowed_social_url,
    normalize_threads_post,
    normalize_threads_reply_notification,
)

THREADS_GRAPH_BASE = "https://graph.threads.net/v1.0"
THREADS_TOKEN_BASE = "https://graph.threads.net"
THREADS_OAUTH_AUTHORIZE_URL = "https://threads.net/oauth/authorize"
DEFAULT_THREADS_SCOPES = (
    "threads_basic,threads_content_publish,threads_delete,"
    "threads_read_replies,threads_manage_replies,threads_manage_insights"
)
THREADS_POST_FIELDS = (
    "id,media_product_type,media_type,media_url,thumbnail_url,permalink,"
    "username,text,timestamp,shortcode,is_quote_post,alt_text,"
    "link_attachment_url,topic_tag,replied_to,root_post,"
    "children{id,media_type,media_url,thumbnail_url,alt_text}"
)
THREADS_REPLY_FIELDS = (
    "id,text,username,timestamp,permalink,media_type,media_url,"
    "thumbnail_url,alt_text,replied_to,root_post,hide_status"
)
_THREADS_DELETE_PERM_MSG = (
    "Threads token lacks 'threads_delete' permission. "
    "Enable threads_delete under Use Cases → Permissions in your Meta App and update your token."
)

_URL_RE = re.compile(r"(?:^|(?<=[\s(]))(https?://[^\s<>()\[\]{}\"']+)")


def _sanitize_topic_tag(tag: str) -> str:
    return re.sub(r"[.&]", "", str(tag or "").lstrip("#")).strip()[:50]


def _extract_link_attachment(text: str, explicit_url: str = "") -> str:
    if explicit_url and is_allowed_social_url(explicit_url):
        return explicit_url.strip()
    source = str(text or "")
    if not source:
        return ""
    unique: list[str] = []
    seen: set[str] = set()
    for m in _URL_RE.finditer(source):
        clean = m.group(1).rstrip(".,!?;:")
        while clean.endswith(")") and clean.count(")") > clean.count("("):
            clean = clean[:-1].rstrip(".,!?;:")
        if not clean or not is_allowed_social_url(clean):
            continue
        if clean not in seen:
            seen.add(clean)
            unique.append(clean)
    return unique[0] if 1 <= len(unique) <= 5 else ""


class ThreadsAdapter(SocialAdapter):
    """Symmetric Threads Graph API adapter (no algorithmic feed ingestion)."""

    protocol = "threads"

    def __init__(
        self,
        *,
        user_id: str,
        access_token: str,
        username: str = "",
        display_name: str = "",
        avatar_url: str = "",
        http_client: httpx.Client | None = None,
    ) -> None:
        self.user_id = str(user_id or "")
        self.access_token = str(access_token or "")
        self.username = str(username or "")
        self.display_name = str(display_name or username or "")
        self.avatar_url = str(avatar_url or "")
        self._client = http_client or httpx.Client(timeout=20.0)
        self._profile_cache: dict[str, dict[str, Any] | None] = {}
        self._insights_cache: dict[str, tuple[float, dict[str, int] | None]] = {}

    @classmethod
    def clean_auth_code(cls, raw_code_or_url: str) -> str:
        raw = str(raw_code_or_url or "").strip()
        if not raw:
            return ""
        qs: dict[str, list[str]] | None = None
        if raw.lower().startswith(("http://", "https://")):
            qs = parse_qs(urlparse(raw).query)
        elif "code=" in raw or "error=" in raw:
            qs = parse_qs(raw.lstrip("?#").rstrip("#_"))
        if qs is not None:
            err = (qs.get("error_description") or qs.get("error") or [None])[0]
            if err:
                raise RuntimeError(str(err))
            code = (qs.get("code") or [""])[0]
            return str(code).removesuffix("#_").strip()
        return raw.removesuffix("#_").strip()

    @classmethod
    def build_authorize_url(
        cls,
        *,
        client_id: str,
        redirect_uri: str,
        scope: str = DEFAULT_THREADS_SCOPES,
        state: str = "",
    ) -> str:
        params: dict[str, str] = {
            "client_id": str(client_id or "").strip(),
            "redirect_uri": str(redirect_uri or "").strip(),
            "scope": str(scope or DEFAULT_THREADS_SCOPES).strip(),
            "response_type": "code",
        }
        if state:
            params["state"] = str(state)
        return f"{THREADS_OAUTH_AUTHORIZE_URL}?{urlencode(params)}"

    @classmethod
    def exchange_oauth_code(
        cls,
        *,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        code: str,
        http_client: httpx.Client | None = None,
    ) -> dict[str, Any]:
        cleaned_code = cls.clean_auth_code(code)
        if not cleaned_code:
            raise ValueError("Threads authorization code is required")
        client = http_client or httpx.Client(timeout=20.0)
        res = client.post(
            f"{THREADS_TOKEN_BASE}/oauth/access_token",
            data={
                "client_id": str(client_id or "").strip(),
                "client_secret": str(client_secret or "").strip(),
                "grant_type": "authorization_code",
                "redirect_uri": str(redirect_uri or "").strip(),
                "code": cleaned_code,
            },
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads OAuth code exchange failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    @classmethod
    def exchange_long_lived_token(
        cls,
        *,
        client_secret: str,
        access_token: str,
        http_client: httpx.Client | None = None,
    ) -> dict[str, Any]:
        client = http_client or httpx.Client(timeout=20.0)
        res = client.get(
            f"{THREADS_TOKEN_BASE}/access_token",
            params={
                "grant_type": "th_exchange_token",
                "client_secret": str(client_secret or "").strip(),
                "access_token": str(access_token or "").strip(),
            },
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads long-lived token exchange failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    @classmethod
    def refresh_long_lived_token(
        cls,
        *,
        access_token: str,
        http_client: httpx.Client | None = None,
    ) -> dict[str, Any]:
        client = http_client or httpx.Client(timeout=20.0)
        res = client.get(
            f"{THREADS_TOKEN_BASE}/refresh_access_token",
            params={
                "grant_type": "th_refresh_token",
                "access_token": str(access_token or "").strip(),
            },
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads token refresh failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    @classmethod
    def verify_credentials(cls, access_token: str, http_client: httpx.Client | None = None) -> dict[str, Any]:
        client = http_client or httpx.Client(timeout=20.0)
        res = client.get(
            f"{THREADS_GRAPH_BASE}/me",
            params={
                "fields": "id,username,name,threads_profile_picture_url,threads_biography,is_verified",
                "access_token": access_token,
            },
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads auth failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    def _create_container(
        self,
        *,
        media_type: str = "TEXT",
        text: str = "",
        image_url: str = "",
        video_url: str = "",
        alt_text: str = "",
        children: list[str] | None = None,
        is_carousel_item: bool = False,
        reply_to_id: str = "",
        link_attachment: str = "",
        topic_tag: str = "",
        quote_post_id: str = "",
        reply_control: str = "",
    ) -> dict[str, Any]:
        form: dict[str, Any] = {"media_type": media_type, "access_token": self.access_token}
        if text and not is_carousel_item:
            form["text"] = text
        if image_url:
            form["image_url"] = image_url
        if video_url:
            form["video_url"] = video_url
        if alt_text:
            form["alt_text"] = alt_text
        if is_carousel_item:
            form["is_carousel_item"] = "true"
        if reply_to_id:
            form["reply_to_id"] = reply_to_id
        if not is_carousel_item:
            if media_type == "TEXT":
                resolved_link = _extract_link_attachment(text, link_attachment)
                if resolved_link:
                    form["link_attachment"] = resolved_link
            elif link_attachment and is_allowed_social_url(link_attachment):
                form["link_attachment"] = link_attachment
            clean_tag = _sanitize_topic_tag(topic_tag)
            if clean_tag:
                form["topic_tag"] = clean_tag
            if quote_post_id:
                form["quote_post_id"] = str(quote_post_id)
            if reply_control:
                form["reply_control"] = str(reply_control)
        if children:
            form["children"] = ",".join(children)

        res = self._client.post(f"{THREADS_GRAPH_BASE}/{self.user_id}/threads", data=form)
        if res.status_code >= 400:
            raise RuntimeError(f"Threads container creation failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    def _wait_container_ready(self, container_id: str, max_polls: int = 20, delay_sec: float = 0.5) -> None:
        for _ in range(max_polls):
            res = self._client.get(
                f"{THREADS_GRAPH_BASE}/{container_id}",
                params={"fields": "id,status,error_message", "access_token": self.access_token},
            )
            if res.status_code >= 400:
                return
            info = res.json()
            status = info.get("status")
            if not status or status in ("FINISHED", "PUBLISHED"):
                return
            if status in ("ERROR", "EXPIRED"):
                raise RuntimeError(info.get("error_message") or f"Threads container failed ({status})")
            time.sleep(delay_sec)

    def _publish_container(self, creation_id: str) -> dict[str, Any]:
        res = self._client.post(
            f"{THREADS_GRAPH_BASE}/{self.user_id}/threads_publish",
            data={"creation_id": creation_id, "access_token": self.access_token},
        )
        if res.status_code >= 400:
            lower = res.text.lower()
            if any(tok in lower for tok in ("2207027", "4279009", "not ready", "processing")):
                self._wait_container_ready(creation_id, max_polls=10, delay_sec=0.5)
                res = self._client.post(
                    f"{THREADS_GRAPH_BASE}/{self.user_id}/threads_publish",
                    data={"creation_id": creation_id, "access_token": self.access_token},
                )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads publish failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    def publish(
        self,
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        reply_to_id = str(opts.get("reply_to_id") or "")
        link_attachment = str(opts.get("link_attachment") or "")
        topic_tag = str(opts.get("topic_tag") or "")
        quote_post_id = str(opts.get("quote_post_id") or "")
        reply_control = str(opts.get("reply_control") or "")
        mastodon_urls = [str(u) for u in (opts.get("mastodon_media_urls") or []) if is_allowed_social_url(str(u))]
        raw_media = media or []

        media_entries: list[dict[str, str]] = []
        for idx, att in enumerate(raw_media[:10]):
            url = mastodon_urls[idx] if idx < len(mastodon_urls) else str(att.get("url") or "")
            if is_allowed_social_url(url):
                mime = str(att.get("mime_type") or "image/jpeg")
                media_entries.append({
                    "url": url,
                    "is_video": "1" if mime.startswith("video/") else "",
                    "alt": str(att.get("alt_text") or ""),
                })

        if not media_entries:
            created = self._create_container(
                media_type="TEXT",
                text=str(draft or ""),
                reply_to_id=reply_to_id,
                link_attachment=link_attachment,
                topic_tag=topic_tag,
                quote_post_id=quote_post_id,
                reply_control=reply_control,
            )
            pub = self._publish_container(created["id"])
        elif len(media_entries) == 1:
            m = media_entries[0]
            created = self._create_container(
                media_type="VIDEO" if m["is_video"] else "IMAGE",
                text=str(draft or ""),
                video_url=m["url"] if m["is_video"] else "",
                image_url="" if m["is_video"] else m["url"],
                alt_text=m["alt"],
                reply_to_id=reply_to_id,
                topic_tag=topic_tag,
                quote_post_id=quote_post_id,
                reply_control=reply_control,
            )
            self._wait_container_ready(created["id"])
            pub = self._publish_container(created["id"])
        else:
            child_ids: list[str] = []
            for m in media_entries:
                child = self._create_container(
                    media_type="VIDEO" if m["is_video"] else "IMAGE",
                    video_url=m["url"] if m["is_video"] else "",
                    image_url="" if m["is_video"] else m["url"],
                    alt_text=m["alt"],
                    is_carousel_item=True,
                )
                self._wait_container_ready(child["id"])
                child_ids.append(child["id"])
            carousel = self._create_container(
                media_type="CAROUSEL",
                text=str(draft or ""),
                children=child_ids,
                reply_to_id=reply_to_id,
                topic_tag=topic_tag,
                quote_post_id=quote_post_id,
                reply_control=reply_control,
            )
            pub = self._publish_container(carousel["id"])

        return normalize_threads_post(
            {
                "id": str(pub.get("id") or ""),
                "text": str(draft or ""),
                "username": self.username,
                **({"topic_tag": _sanitize_topic_tag(topic_tag)} if _sanitize_topic_tag(topic_tag) else {}),
            },
            author_profile={
                "id": self.user_id,
                "username": self.username,
                "name": self.display_name,
                "threads_profile_picture_url": self.avatar_url,
            },
        )

    def delete(self, native_meta: dict[str, Any]) -> bool:
        post_id = (
            str(native_meta.get("postId") or native_meta.get("threadsPostId") or "")
            .removeprefix("threads:notif:")
            .removeprefix("threads:")
            .strip()
        )
        if not post_id:
            return False
        res = self._client.delete(
            f"{THREADS_GRAPH_BASE}/{post_id}",
            params={"access_token": self.access_token},
        )
        if res.status_code < 400 or res.status_code == 404:
            return True

        err_obj: dict[str, Any] = {}
        try:
            parsed = res.json()
            if isinstance(parsed, dict) and isinstance(parsed.get("error"), dict):
                err_obj = parsed["error"]
        except Exception:
            err_obj = {}

        code = err_obj.get("code")
        subcode = err_obj.get("error_subcode")
        if res.status_code == 403 or code == 10:
            raise RuntimeError(_THREADS_DELETE_PERM_MSG)

        if res.status_code == 400 and code == 100 and subcode == 33:
            chk = self._client.get(
                f"{THREADS_GRAPH_BASE}/{post_id}",
                params={"fields": "id", "access_token": self.access_token},
            )
            if chk.status_code >= 400:
                return True
            raise RuntimeError(_THREADS_DELETE_PERM_MSG)

        raise RuntimeError(f"Threads delete failed ({res.status_code}): {res.text[:250]}")

    def reply(
        self,
        target_item: dict[str, Any],
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        post_id = str(
            (target_item.get("_meta", {}).get("threads") or {}).get("postId")
            or target_item.get("id", "").removeprefix("threads:notif:").removeprefix("threads:")
        )
        if not post_id:
            raise ValueError("Target item missing Threads postId")
        return self.publish(draft, media=media, options={**(options or {}), "reply_to_id": post_id})

    def like(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        raise RuntimeError("Threads Graph API does not expose remote post likes")

    def repost(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        raise RuntimeError("Threads Graph API does not expose remote reposts")

    def get_post_insights(self, post_id: str) -> dict[str, int] | None:
        """Fetch likes/replies/reposts+quotes for a Threads post via /{media-id}/insights."""
        clean_id = str(post_id or "").removeprefix("threads:notif:").removeprefix("threads:").strip()
        if not clean_id or not self.access_token:
            return None
        now = time.time()
        cached = self._insights_cache.get(clean_id)
        if cached and cached[0] > now:
            return dict(cached[1]) if cached[1] is not None else None
        try:
            res = self._client.get(
                f"{THREADS_GRAPH_BASE}/{clean_id}/insights",
                params={
                    "metric": "likes,replies,reposts,quotes",
                    "access_token": self.access_token,
                },
            )
            if res.status_code >= 400:
                self._insights_cache[clean_id] = (now + 300.0, None)
                return None
            likes = 0
            replies = 0
            reposts = 0
            quotes = 0
            for row in res.json().get("data") or []:
                if not isinstance(row, dict):
                    continue
                name = str(row.get("name") or "").lower()
                vals = row.get("values") if isinstance(row.get("values"), list) else []
                total_v = row.get("total_value") if isinstance(row.get("total_value"), dict) else {}
                val = int(total_v.get("value") if total_v.get("value") is not None else ((vals[0] or {}).get("value") if vals and isinstance(vals[0], dict) else 0) or 0)
                if name == "likes":
                    likes = val
                elif name == "replies":
                    replies = val
                elif name == "reposts":
                    reposts = val
                elif name == "quotes":
                    quotes = val
            metrics = {"likes": likes, "replies": replies, "reposts": reposts + quotes}
            self._insights_cache[clean_id] = (now + 60.0, dict(metrics))
            return metrics
        except Exception:
            self._insights_cache[clean_id] = (now + 300.0, None)
            return None

    def fetch_timeline(self, stream: str = "own", cursor: str = "", limit: int = 20, **kwargs: Any) -> dict[str, Any]:
        params: dict[str, Any] = {
            "fields": THREADS_POST_FIELDS,
            "limit": limit,
            "access_token": self.access_token,
        }
        if cursor:
            params["after"] = cursor
        res = self._client.get(f"{THREADS_GRAPH_BASE}/{self.user_id}/threads", params=params)
        if res.status_code >= 400:
            raise RuntimeError(f"Threads timeline failed ({res.status_code}): {res.text[:250]}")
        body = res.json()
        rows = body.get("data", [])
        prof = {
            "id": self.user_id,
            "username": self.username,
            "name": self.display_name,
            "threads_profile_picture_url": self.avatar_url,
        }
        items = [normalize_threads_post(r, prof) for r in rows]
        enrich_targets = [(idx, (it.get("_meta", {}).get("threads") or {}).get("postId")) for idx, it in enumerate(items[:10])]
        enrich_targets = [(idx, pid) for idx, pid in enrich_targets if pid]
        if enrich_targets:
            with ThreadPoolExecutor(max_workers=4) as pool:
                futs = [(idx, pool.submit(self.get_post_insights, pid)) for idx, pid in enrich_targets]
                for idx, fut in futs:
                    try:
                        m = fut.result()
                        if m:
                            items[idx]["metrics"] = m
                    except Exception:
                        pass
        next_cursor = ((body.get("paging") or {}).get("cursors") or {}).get("after")
        return {"items": items, "next_cursor": next_cursor}

    def get_post_thread(self, post_id: str) -> dict[str, Any]:
        clean_id = str(post_id or "").removeprefix("threads:notif:").removeprefix("threads:").strip()
        if not clean_id:
            return {"status": None, "ancestors": [], "descendants": []}
        own_prof = {
            "id": self.user_id,
            "username": self.username,
            "name": self.display_name,
            "threads_profile_picture_url": self.avatar_url,
        }
        res = self._client.get(
            f"{THREADS_GRAPH_BASE}/{clean_id}",
            params={"fields": THREADS_POST_FIELDS, "access_token": self.access_token},
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads post fetch failed ({res.status_code}): {res.text[:250]}")
        raw_focal = res.json()
        focal = normalize_threads_post(raw_focal, own_prof if raw_focal.get("username") == self.username else None)

        ancestors: list[dict[str, Any]] = []
        parent_id = str((raw_focal.get("replied_to") or {}).get("id") or "")
        if parent_id:
            try:
                pres = self._client.get(
                    f"{THREADS_GRAPH_BASE}/{parent_id}",
                    params={"fields": THREADS_POST_FIELDS, "access_token": self.access_token},
                )
                if pres.status_code < 400:
                    raw_parent = pres.json()
                    ancestors.append(
                        normalize_threads_post(raw_parent, own_prof if raw_parent.get("username") == self.username else None)
                    )
            except Exception:
                pass

        raw_replies: list[dict[str, Any]] = []
        try:
            cres = self._client.get(
                f"{THREADS_GRAPH_BASE}/{clean_id}/conversation",
                params={"fields": THREADS_REPLY_FIELDS, "reverse": "false", "access_token": self.access_token},
            )
            if cres.status_code < 400:
                raw_replies = cres.json().get("data", [])
            else:
                raise RuntimeError("conversation unavailable")
        except Exception:
            try:
                rres = self._client.get(
                    f"{THREADS_GRAPH_BASE}/{clean_id}/replies",
                    params={"fields": THREADS_REPLY_FIELDS, "access_token": self.access_token},
                )
                if rres.status_code < 400:
                    raw_replies = rres.json().get("data", [])
            except Exception:
                raw_replies = []

        depth_by_id: dict[str, int] = {clean_id: -1}
        descendants: list[dict[str, Any]] = []
        for r in raw_replies:
            rid = str(r.get("id") or "")
            if not rid or str(r.get("hide_status") or "").upper() == "HIDDEN":
                continue
            item = normalize_threads_post(r, own_prof if r.get("username") == self.username else None)
            parent_ref = str((r.get("replied_to") or {}).get("id") or clean_id)
            depth = min(depth_by_id[parent_ref] + 1, 3) if parent_ref in depth_by_id else 0
            depth_by_id[rid] = depth
            item["_threadDepth"] = depth
            descendants.append(item)

        insights = self.get_post_insights(clean_id)
        base_m = insights or focal.get("metrics") or {"likes": 0, "replies": 0, "reposts": 0}
        focal["metrics"] = {
            "likes": int(base_m.get("likes") or 0),
            "replies": max(int(base_m.get("replies") or 0), len(descendants)),
            "reposts": int(base_m.get("reposts") or 0),
        }

        return {"status": focal, "ancestors": ancestors, "descendants": descendants}

    def search_posts(self, query: str, limit: int = 12) -> list[dict[str, Any]]:
        clean_q = str(query or "").strip()
        if not clean_q:
            return []
        try:
            res = self._client.get(
                f"{THREADS_GRAPH_BASE}/keyword_search",
                params={
                    "q": clean_q,
                    "search_type": "TOP",
                    "search_mode": "KEYWORD",
                    "fields": THREADS_POST_FIELDS,
                    "limit": limit,
                    "access_token": self.access_token,
                },
            )
            if res.status_code >= 400:
                return []
            return [normalize_threads_post(r) for r in res.json().get("data", [])]
        except Exception:
            return []

    def lookup_profile(self, username: str) -> dict[str, Any] | None:
        clean = str(username or "").strip().lstrip("@")
        if not clean or " " in clean:
            return None
        cache_key = clean.lower()
        if cache_key in self._profile_cache:
            return self._profile_cache[cache_key]
        try:
            res = self._client.get(
                f"{THREADS_GRAPH_BASE}/profile_lookup",
                params={
                    "username": clean,
                    "fields": "username,name,profile_picture_url,biography,follower_count,is_verified",
                    "access_token": self.access_token,
                },
            )
            if res.status_code >= 400:
                if len(self._profile_cache) < 200:
                    self._profile_cache[cache_key] = None
                return None
            raw = res.json()
            handle = str(raw.get("username") or "").lstrip("@")
            if not handle:
                if len(self._profile_cache) < 200:
                    self._profile_cache[cache_key] = None
                return None
            mapped = {
                "id": handle,
                "protocol": "threads",
                "network": "threads",
                "username": handle,
                "acct": handle,
                "display_name": str(raw.get("name") or handle),
                "avatar_url": str(raw.get("profile_picture_url") or ""),
                "url": f"https://www.threads.net/@{handle}",
                "note_text": str(raw.get("biography") or ""),
                "followers_count": int(raw.get("follower_count") or 0),
            }
            if len(self._profile_cache) < 200:
                self._profile_cache[cache_key] = mapped
            return mapped
        except Exception:
            return None

    def fetch_notifications(
        self,
        cursor: str = "",
        limit: int = 20,
        *,
        tracked_post_ids: list[str] | None = None,
    ) -> list[dict[str, Any]]:
        """Poll mentions (top-level or in tracked threads) and replies on unified linked_posts only."""
        out: list[dict[str, Any]] = []
        seen_ids: set[str] = set()
        own_handle = self.username.strip().lstrip("@").lower()
        tracked_ids = list(
            dict.fromkeys(
                str(x or "").removeprefix("threads:").strip()
                for x in (tracked_post_ids or [])
                if str(x or "").removeprefix("threads:").strip()
            )
        )
        tracked_set = set(tracked_ids)

        def accept_item(raw_obj: dict[str, Any], kind: str, parent_id: str = "") -> dict[str, Any] | None:
            pid = str(raw_obj.get("id") or "")
            if not pid or pid in seen_ids:
                return None
            if str(raw_obj.get("hide_status") or "").upper() == "HIDDEN":
                return None
            actor_handle = str(raw_obj.get("username") or "").strip().lstrip("@").lower()
            if own_handle and actor_handle and actor_handle == own_handle:
                return None
            seen_ids.add(pid)
            return normalize_threads_reply_notification(raw_obj, parent_post_id=parent_id, notif_type=kind)

        try:
            mres = self._client.get(
                f"{THREADS_GRAPH_BASE}/me/mentions",
                params={
                    "fields": THREADS_POST_FIELDS,
                    "limit": min(limit, 15),
                    "access_token": self.access_token,
                },
            )
            if mres.status_code < 400:
                for m in mres.json().get("data", []):
                    parent_id = str((m.get("replied_to") or {}).get("id") or "")
                    root_id = str((m.get("root_post") or {}).get("id") or "")
                    if (parent_id or root_id) and parent_id not in tracked_set and root_id not in tracked_set:
                        continue
                    item = accept_item(m, "mention", parent_id)
                    if item:
                        out.append(item)
        except Exception:
            pass

        for pid in tracked_ids[:15]:
            try:
                res = self._client.get(
                    f"{THREADS_GRAPH_BASE}/{pid}/replies",
                    params={
                        "fields": THREADS_REPLY_FIELDS,
                        "access_token": self.access_token,
                    },
                )
                if res.status_code >= 400:
                    continue
                for r in res.json().get("data", []):
                    item = accept_item(r, "reply", pid)
                    if item:
                        out.append(item)
            except Exception:
                continue

        missing_handles = list(
            dict.fromkeys(
                str(it.get("author", {}).get("handle") or "").lstrip("@")
                for it in out
                if not it.get("author", {}).get("avatar_url") and it.get("author", {}).get("handle")
            )
        )[:8]
        for h in missing_handles:
            prof = self.lookup_profile(h)
            if not prof:
                continue
            for it in out:
                if str(it.get("author", {}).get("handle") or "").lstrip("@").lower() == h.lower():
                    it["author"]["name"] = prof.get("display_name") or it["author"]["name"]
                    it["author"]["avatar_url"] = prof.get("avatar_url") or it["author"]["avatar_url"]
                    it["author"]["url"] = prof.get("url") or it["author"]["url"]
                    if isinstance(it.get("_meta", {}).get("notification"), dict):
                        it["_meta"]["notification"]["actor"] = it["author"]

        return out
