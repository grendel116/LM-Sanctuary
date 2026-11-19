"""Threads Graph API SocialAdapter for seamless outbound bridging and reply sync."""

from __future__ import annotations

import time
from typing import Any

import httpx

from social.adapters.base import SocialAdapter
from social.core.schema.unified_item import (
    is_allowed_social_url,
    normalize_threads_post,
    normalize_threads_reply_notification,
)

THREADS_GRAPH_BASE = "https://graph.threads.net/v1.0"


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

    @classmethod
    def verify_credentials(cls, access_token: str, http_client: httpx.Client | None = None) -> dict[str, Any]:
        client = http_client or httpx.Client(timeout=20.0)
        res = client.get(
            f"{THREADS_GRAPH_BASE}/me",
            params={
                "fields": "id,username,name,threads_profile_picture_url",
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
        if children:
            form["children"] = ",".join(children)

        res = self._client.post(f"{THREADS_GRAPH_BASE}/{self.user_id}/threads", data=form)
        if res.status_code >= 400:
            raise RuntimeError(f"Threads container creation failed ({res.status_code}): {res.text[:250]}")
        return res.json()

    def _wait_container_ready(self, container_id: str, max_polls: int = 8, delay_sec: float = 0.5) -> None:
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
            created = self._create_container(media_type="TEXT", text=str(draft or ""), reply_to_id=reply_to_id)
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
            )
            pub = self._publish_container(carousel["id"])

        return normalize_threads_post(
            {"id": str(pub.get("id") or ""), "text": str(draft or ""), "username": self.username},
            author_profile={
                "id": self.user_id,
                "username": self.username,
                "name": self.display_name,
                "threads_profile_picture_url": self.avatar_url,
            },
        )

    def delete(self, native_meta: dict[str, Any]) -> bool:
        post_id = str(native_meta.get("postId") or native_meta.get("threadsPostId") or "")
        if not post_id:
            return False
        res = self._client.delete(
            f"{THREADS_GRAPH_BASE}/{post_id}",
            params={"access_token": self.access_token},
        )
        if res.status_code >= 400 and res.status_code != 404:
            raise RuntimeError(f"Threads delete failed ({res.status_code}): {res.text[:250]}")
        return True

    def reply(
        self,
        target_item: dict[str, Any],
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        post_id = str(
            (target_item.get("_meta", {}).get("threads") or {}).get("postId")
            or target_item.get("id", "").removeprefix("threads:")
        )
        if not post_id:
            raise ValueError("Target item missing Threads postId")
        return self.publish(draft, media=media, options={**(options or {}), "reply_to_id": post_id})

    def like(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        raise RuntimeError("Threads Graph API does not expose remote post likes")

    def repost(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        raise RuntimeError("Threads Graph API does not expose remote reposts")

    def fetch_timeline(self, stream: str = "own", cursor: str = "", limit: int = 20, **kwargs: Any) -> dict[str, Any]:
        res = self._client.get(
            f"{THREADS_GRAPH_BASE}/{self.user_id}/threads",
            params={
                "fields": "id,text,media_type,media_url,permalink,timestamp",
                "limit": limit,
                "access_token": self.access_token,
            },
        )
        if res.status_code >= 400:
            raise RuntimeError(f"Threads timeline failed ({res.status_code}): {res.text[:250]}")
        rows = res.json().get("data", [])
        prof = {"id": self.user_id, "username": self.username, "name": self.display_name, "threads_profile_picture_url": self.avatar_url}
        return {"items": [normalize_threads_post(r, prof) for r in rows], "next_cursor": None}

    def fetch_notifications(self, cursor: str = "", limit: int = 20) -> list[dict[str, Any]]:
        """Poll replies on recent own Threads posts into UnifiedItem notifications."""
        out: list[dict[str, Any]] = []
        try:
            own = self.fetch_timeline(limit=min(limit, 8))
        except Exception:
            return []

        for post in own["items"]:
            pid = (post.get("_meta", {}).get("threads") or {}).get("postId")
            if not pid:
                continue
            try:
                res = self._client.get(
                    f"{THREADS_GRAPH_BASE}/{pid}/replies",
                    params={
                        "fields": "id,text,username,timestamp,permalink",
                        "access_token": self.access_token,
                    },
                )
                if res.status_code >= 400:
                    continue
                for r in res.json().get("data", []):
                    out.append(normalize_threads_reply_notification(r, parent_post_id=pid))
            except Exception:
                continue
        return out
