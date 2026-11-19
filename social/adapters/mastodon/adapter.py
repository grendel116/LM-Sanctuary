"""Mastodon REST API adapter covering OAuth2, timelines, native profile/graph/moderation, and streaming."""

from __future__ import annotations

import time
from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse

import httpx

from social.adapters.base import SocialAdapter
from social.core.schema.unified_item import (
    normalize_instance_url,
    normalize_mastodon_account,
    normalize_mastodon_notification,
    normalize_mastodon_status,
)


class MastodonAdapter(SocialAdapter):
    """Primary Mastodon REST API adapter outputting canonical UnifiedItem structures."""

    protocol = "mastodon"

    def __init__(
        self,
        instance_url: str = "https://mastodon.social",
        access_token: str = "",
        http_client: httpx.Client | None = None,
    ) -> None:
        self.instance_url = normalize_instance_url(instance_url or "https://mastodon.social")
        self.access_token = str(access_token or "").strip()
        self._owns_client = http_client is None
        self._client = http_client or httpx.Client(timeout=20.0)

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.access_token:
            headers["Authorization"] = f"Bearer {self.access_token}"
        if extra:
            headers.update(extra)
        return headers

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any = None,
        data: Any = None,
        files: Any = None,
        extra_headers: dict[str, str] | None = None,
    ) -> httpx.Response:
        url = f"{self.instance_url}{path}"
        res = self._client.request(
            method.upper(),
            url,
            params=params,
            json=json_body,
            data=data,
            files=files,
            headers=self._headers(extra_headers),
        )
        if res.status_code >= 400:
            detail = res.text[:300]
            try:
                err_json = res.json()
                detail = err_json.get("error_description") or err_json.get("error") or detail
            except Exception:
                pass
            raise RuntimeError(f"Mastodon API {res.status_code} ({path}): {detail}")
        return res

    # ── OAuth2 & Account Verification ────────────────────────────────────

    def register_oauth_app(
        self,
        redirect_uri: str,
        client_name: str = "LM-Sanctuary",
        scopes: str = "read write follow push",
        website: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "client_name": client_name,
            "redirect_uris": redirect_uri,
            "scopes": scopes,
        }
        if website:
            payload["website"] = website
        return self._request("POST", "/api/v1/apps", json_body=payload).json()

    def build_authorize_url(
        self,
        client_id: str,
        redirect_uri: str,
        scope: str = "read write follow push",
        state: str = "",
    ) -> str:
        qs = {
            "response_type": "code",
            "client_id": client_id,
            "redirect_uri": redirect_uri,
            "scope": scope,
        }
        if state:
            qs["state"] = state
        return f"{self.instance_url}/oauth/authorize?{urlencode(qs)}"

    def exchange_oauth_code(
        self,
        *,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
        code: str,
        scope: str = "read write follow push",
    ) -> dict[str, Any]:
        return self._request(
            "POST",
            "/oauth/token",
            json_body={
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
                "code": code,
                "scope": scope,
            },
        ).json()

    def verify_credentials(self) -> dict[str, Any]:
        raw = self._request("GET", "/api/v1/accounts/verify_credentials").json()
        return normalize_mastodon_account(raw, self.instance_url)

    def update_credentials(
        self,
        *,
        display_name: str | None = None,
        note: str | None = None,
        locked: bool | None = None,
        bot: bool | None = None,
        discoverable: bool | None = None,
        indexable: bool | None = None,
        hide_collections: bool | None = None,
        default_visibility: str | None = None,
        default_sensitive: bool | None = None,
        default_language: str | None = None,
        fields: list[dict[str, str]] | None = None,
        attribution_domains: list[str] | None = None,
        avatar_bytes: tuple[str, bytes, str] | None = None,
        header_bytes: tuple[str, bytes, str] | None = None,
        remove_avatar: bool = False,
        remove_header: bool = False,
    ) -> dict[str, Any]:
        if remove_avatar and not avatar_bytes:
            self._request("DELETE", "/api/v1/profile/avatar")
        if remove_header and not header_bytes:
            self._request("DELETE", "/api/v1/profile/header")

        form: dict[str, Any] = {}
        if display_name is not None:
            form["display_name"] = display_name
        if note is not None:
            form["note"] = note
        if locked is not None:
            form["locked"] = "true" if locked else "false"
        if bot is not None:
            form["bot"] = "true" if bot else "false"
        if discoverable is not None:
            form["discoverable"] = "true" if discoverable else "false"
        if indexable is not None:
            val = "true" if indexable else "false"
            form["indexable"] = val
            form["source[indexable]"] = val
        if hide_collections is not None:
            form["hide_collections"] = "true" if hide_collections else "false"
        if default_visibility is not None:
            form["source[privacy]"] = default_visibility
        if default_sensitive is not None:
            form["source[sensitive]"] = "true" if default_sensitive else "false"
        if default_language is not None:
            form["source[language]"] = default_language
        if attribution_domains is not None:
            form["attribution_domains[]"] = [str(d).strip() for d in attribution_domains if str(d).strip()] or [""]
        if fields is not None:
            for idx in range(4):
                row = fields[idx] if idx < len(fields) else {"name": "", "value": ""}
                form[f"fields_attributes[{idx}][name]"] = str(row.get("name") or "")
                form[f"fields_attributes[{idx}][value]"] = str(row.get("value") or "")

        files = {}
        if avatar_bytes:
            files["avatar"] = avatar_bytes
        if header_bytes:
            files["header"] = header_bytes

        raw = self._request(
            "PATCH",
            "/api/v1/accounts/update_credentials",
            data=form,
            files=files or None,
        ).json()
        return normalize_mastodon_account(raw, self.instance_url)

    # ── Media, Publish, Reply, Edit, Delete, Pin, Like, Repost ───────────

    def upload_media(self, file_bytes: bytes, filename: str = "upload.png", mime_type: str = "image/png", description: str = "") -> dict[str, Any]:
        data = {"description": description} if description else {}
        res = self._request(
            "POST",
            "/api/v2/media",
            data=data,
            files={"file": (filename, file_bytes, mime_type)},
        )
        media = res.json()
        if (res.status_code == 202 or not media.get("url")) and media.get("id"):
            for _ in range(10):
                time.sleep(0.4)
                chk = self._client.get(f"{self.instance_url}/api/v1/media/{media['id']}", headers=self._headers())
                if chk.status_code == 200:
                    media = chk.json()
                    if media.get("url"):
                        break
        return {
            "id": str(media.get("id") or ""),
            "url": str(media.get("url") or ""),
            "preview_url": str(media.get("preview_url") or media.get("url") or ""),
            "mime_type": mime_type,
            "alt_text": str(media.get("description") or description),
        }

    def publish(
        self,
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        opts = options or {}
        media_ids: list[str] = list(opts.get("media_ids") or [])
        for att in media or []:
            if att.get("id"):
                media_ids.append(str(att["id"]))
            elif att.get("bytes"):
                uploaded = self.upload_media(
                    att["bytes"],
                    filename=att.get("filename") or "media.bin",
                    mime_type=att.get("mime_type") or "image/png",
                    description=att.get("alt_text") or "",
                )
                if uploaded["id"]:
                    media_ids.append(uploaded["id"])

        payload: dict[str, Any] = {
            "status": str(draft or ""),
            "visibility": str(opts.get("visibility") or "public"),
        }
        if opts.get("spoiler_text"):
            payload["spoiler_text"] = str(opts["spoiler_text"])
        if media_ids:
            payload["media_ids"] = media_ids
        if opts.get("in_reply_to_id"):
            payload["in_reply_to_id"] = str(opts["in_reply_to_id"])
        if opts.get("language"):
            payload["language"] = str(opts["language"])

        headers = {}
        if opts.get("idempotency_key"):
            headers["Idempotency-Key"] = str(opts["idempotency_key"])

        created = self._request("POST", "/api/v1/statuses", json_body=payload, extra_headers=headers).json()
        return normalize_mastodon_status(created, self.instance_url)

    def edit_status(self, status_id: str, draft: str, spoiler_text: str = "") -> dict[str, Any]:
        payload: dict[str, Any] = {"status": str(draft or "")}
        if spoiler_text:
            payload["spoiler_text"] = spoiler_text
        updated = self._request("PUT", f"/api/v1/statuses/{status_id}", json_body=payload).json()
        return normalize_mastodon_status(updated, self.instance_url)

    def pin_status(self, status_id: str, unpin: bool = False) -> dict[str, Any]:
        action = "unpin" if unpin else "pin"
        updated = self._request("POST", f"/api/v1/statuses/{status_id}/{action}").json()
        return normalize_mastodon_status(updated, self.instance_url)

    def delete(self, native_meta: dict[str, Any]) -> bool:
        status_id = str(native_meta.get("statusId") or native_meta.get("mastodonStatusId") or "")
        if not status_id:
            return False
        self._request("DELETE", f"/api/v1/statuses/{status_id}")
        return True

    def reply(
        self,
        target_item: dict[str, Any],
        draft: str,
        media: list[dict[str, Any]] | None = None,
        options: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        masto_meta = target_item.get("_meta", {}).get("mastodon") or {}
        status_id = str(masto_meta.get("statusId") or target_item.get("id", "").removeprefix("mastodon:"))
        if not status_id:
            raise ValueError("Target item missing Mastodon statusId")
        merged_opts = {"visibility": masto_meta.get("visibility") or "public", **(options or {}), "in_reply_to_id": status_id}
        return self.publish(draft, media=media, options=merged_opts)

    def like(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        status_id = str((target_item.get("_meta", {}).get("mastodon") or {}).get("statusId") or "")
        action = "unfavourite" if undo else "favourite"
        updated = self._request("POST", f"/api/v1/statuses/{status_id}/{action}").json()
        return normalize_mastodon_status(updated, self.instance_url)

    def repost(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        status_id = str((target_item.get("_meta", {}).get("mastodon") or {}).get("statusId") or "")
        action = "unreblog" if undo else "reblog"
        updated = self._request("POST", f"/api/v1/statuses/{status_id}/{action}").json()
        return normalize_mastodon_status(updated, self.instance_url)

    # ── Timelines, Profile Statuses, Context, Notifications ──────────────

    def fetch_timeline(self, stream: str = "home", cursor: str = "", limit: int = 20, **kwargs: Any) -> dict[str, Any]:
        path = "/api/v1/timelines/home"
        params: dict[str, Any] = {"limit": limit}
        if stream == "local":
            path = "/api/v1/timelines/public"
            params["local"] = "true"
        elif stream == "federated":
            path = "/api/v1/timelines/public"
        elif stream == "list":
            list_id = str(kwargs.get("list_id") or "")
            if not list_id:
                raise ValueError("list_id is required for list stream")
            path = f"/api/v1/timelines/list/{list_id}"
        elif stream == "bookmarks":
            path = "/api/v1/bookmarks"
        elif stream == "trending":
            path = "/api/v1/trends/statuses"
            if cursor:
                params["offset"] = cursor

        if cursor and stream != "trending":
            params["max_id"] = cursor

        res = self._request("GET", path, params=params)
        rows = res.json()
        items = [normalize_mastodon_status(r, self.instance_url) for r in (rows if isinstance(rows, list) else [])]
        next_cursor = None
        if len(items) >= limit:
            if stream == "trending":
                next_cursor = str((int(cursor or 0) + len(items)))
            else:
                next_cursor = str(rows[-1].get("id") or "")
        return {"items": items, "next_cursor": next_cursor}

    def fetch_account_profile(self, account_id: str) -> dict[str, Any]:
        raw = self._request("GET", f"/api/v1/accounts/{account_id}").json()
        return normalize_mastodon_account(raw, self.instance_url)

    def lookup_account(self, acct: str) -> dict[str, Any] | None:
        clean = str(acct or "").strip().lstrip("@")
        if not clean:
            return None
        try:
            raw = self._request("GET", "/api/v1/accounts/lookup", params={"acct": clean}).json()
            if isinstance(raw, dict) and raw.get("id"):
                return normalize_mastodon_account(raw, self.instance_url)
        except Exception:
            found = self.search(clean, search_type="accounts", resolve=bool(self.access_token), limit=1)
            accounts = found.get("accounts") or []
            if accounts:
                return accounts[0]
        return None

    def fetch_account_statuses(
        self,
        account_id: str,
        *,
        tab: str = "posts",
        max_id: str = "",
        limit: int = 20,
    ) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if max_id:
            params["max_id"] = max_id
        if tab == "posts":
            params["exclude_replies"] = "true"
        elif tab == "media":
            params["only_media"] = "true"
        elif tab == "pinned":
            params["pinned"] = "true"
        rows = self._request("GET", f"/api/v1/accounts/{account_id}/statuses", params=params).json()
        return [normalize_mastodon_status(r, self.instance_url) for r in (rows if isinstance(rows, list) else [])]

    def get_status_context(self, status_id: str) -> dict[str, Any]:
        status_raw = self._request("GET", f"/api/v1/statuses/{status_id}").json()
        ctx_raw = self._request("GET", f"/api/v1/statuses/{status_id}/context").json()
        return {
            "status": normalize_mastodon_status(status_raw, self.instance_url),
            "ancestors": [normalize_mastodon_status(a, self.instance_url) for a in ctx_raw.get("ancestors", [])],
            "descendants": [normalize_mastodon_status(d, self.instance_url) for d in ctx_raw.get("descendants", [])],
        }

    def fetch_notifications(self, cursor: str = "", limit: int = 30) -> list[dict[str, Any]]:
        params: dict[str, Any] = {"limit": limit}
        if cursor:
            params["max_id"] = cursor
        rows = self._request("GET", "/api/v1/notifications", params=params).json()
        return [
            normalize_mastodon_notification(r, self.instance_url)
            for r in (rows if isinstance(rows, list) else [])
        ]

    # ── Native Social Graph, Lists, Filters, Mutes/Blocks, Search ────────

    def list_lists(self) -> list[dict[str, Any]]:
        return self._request("GET", "/api/v1/lists").json()

    def create_list(self, title: str, replies_policy: str = "list", exclusive: bool = False) -> dict[str, Any]:
        return self._request(
            "POST",
            "/api/v1/lists",
            json_body={"title": title, "replies_policy": replies_policy, "exclusive": exclusive},
        ).json()

    def update_list(self, list_id: str, title: str, replies_policy: str = "list", exclusive: bool = False) -> dict[str, Any]:
        return self._request(
            "PUT",
            f"/api/v1/lists/{list_id}",
            json_body={"title": title, "replies_policy": replies_policy, "exclusive": exclusive},
        ).json()

    def delete_list(self, list_id: str) -> bool:
        self._request("DELETE", f"/api/v1/lists/{list_id}")
        return True

    def get_list_accounts(self, list_id: str) -> list[dict[str, Any]]:
        rows = self._request("GET", f"/api/v1/lists/{list_id}/accounts", params={"limit": 50}).json()
        return [normalize_mastodon_account(a, self.instance_url) for a in (rows if isinstance(rows, list) else [])]

    def add_accounts_to_list(self, list_id: str, account_ids: list[str]) -> bool:
        self._request("POST", f"/api/v1/lists/{list_id}/accounts", json_body={"account_ids": account_ids})
        return True

    def remove_accounts_from_list(self, list_id: str, account_ids: list[str]) -> bool:
        self._request("DELETE", f"/api/v1/lists/{list_id}/accounts", json_body={"account_ids": account_ids})
        return True

    def list_filters(self) -> list[dict[str, Any]]:
        try:
            rows = self._request("GET", "/api/v2/filters").json()
            out = []
            for f in rows if isinstance(rows, list) else []:
                kws = f.get("keywords") or []
                phrase = kws[0].get("keyword", "") if kws else ""
                out.append({
                    "id": str(f.get("id")),
                    "title": f.get("title") or phrase,
                    "phrase": phrase,
                    "context": f.get("context") or ["home", "public", "notifications"],
                    "filter_action": f.get("filter_action") or "hide",
                    "expires_at": f.get("expires_at"),
                    "mastodon_filter_id": str(f.get("id")),
                })
            return out
        except Exception:
            rows = self._request("GET", "/api/v1/filters").json()
            return [
                {
                    "id": str(f.get("id")),
                    "title": f.get("phrase") or "",
                    "phrase": f.get("phrase") or "",
                    "context": f.get("context") or ["home", "public"],
                    "filter_action": "hide",
                    "expires_at": f.get("expires_at"),
                    "mastodon_filter_id": str(f.get("id")),
                }
                for f in (rows if isinstance(rows, list) else [])
            ]

    def create_filter(
        self,
        *,
        title: str,
        phrase: str,
        context: list[str] | None = None,
        filter_action: str = "hide",
    ) -> dict[str, Any]:
        ctx = context or ["home", "public", "notifications", "thread"]
        try:
            f = self._request(
                "POST",
                "/api/v2/filters",
                json_body={
                    "title": title or phrase,
                    "context": ctx,
                    "filter_action": filter_action,
                    "keywords_attributes": [{"keyword": phrase, "whole_word": False}],
                },
            ).json()
            return {
                "id": str(f.get("id")),
                "title": f.get("title") or title or phrase,
                "phrase": phrase,
                "context": f.get("context") or ctx,
                "filter_action": f.get("filter_action") or filter_action,
                "mastodon_filter_id": str(f.get("id")),
            }
        except Exception:
            f = self._request(
                "POST",
                "/api/v1/filters",
                json_body={"phrase": phrase, "context": ctx, "irreversible": filter_action == "hide"},
            ).json()
            return {
                "id": str(f.get("id")),
                "title": title or phrase,
                "phrase": f.get("phrase") or phrase,
                "context": f.get("context") or ctx,
                "filter_action": filter_action,
                "mastodon_filter_id": str(f.get("id")),
            }

    def delete_filter(self, filter_id: str) -> bool:
        try:
            self._request("DELETE", f"/api/v2/filters/{filter_id}")
        except Exception:
            self._request("DELETE", f"/api/v1/filters/{filter_id}")
        return True

    def list_mutes(self) -> list[dict[str, Any]]:
        rows = self._request("GET", "/api/v1/mutes").json()
        return [normalize_mastodon_account(a, self.instance_url) for a in (rows if isinstance(rows, list) else [])]

    def list_blocks(self) -> list[dict[str, Any]]:
        rows = self._request("GET", "/api/v1/blocks").json()
        return [normalize_mastodon_account(a, self.instance_url) for a in (rows if isinstance(rows, list) else [])]

    def get_relationships(self, account_ids: list[str]) -> list[dict[str, Any]]:
        if not account_ids:
            return []
        params = [("id[]", aid) for aid in account_ids]
        url = f"{self.instance_url}/api/v1/accounts/relationships"
        res = self._client.get(url, params=params, headers=self._headers())
        if res.status_code >= 400:
            return []
        return res.json()

    def follow_account(self, account_id: str, undo: bool = False) -> dict[str, Any]:
        action = "unfollow" if undo else "follow"
        return self._request("POST", f"/api/v1/accounts/{account_id}/{action}").json()

    def mute_account(self, account_id: str, undo: bool = False) -> dict[str, Any]:
        action = "unmute" if undo else "mute"
        return self._request("POST", f"/api/v1/accounts/{account_id}/{action}").json()

    def block_account(self, account_id: str, undo: bool = False) -> dict[str, Any]:
        action = "unblock" if undo else "block"
        return self._request("POST", f"/api/v1/accounts/{account_id}/{action}").json()

    @staticmethod
    def _extract_next_max_id(link_header: str | None) -> str | None:
        header = str(link_header or "")
        if not header:
            return None
        for part in header.split(","):
            if 'rel="next"' not in part and "rel='next'" not in part:
                continue
            start = part.find("<")
            end = part.find(">", start + 1) if start >= 0 else -1
            if start >= 0 and end > start:
                parsed = urlparse(part[start + 1 : end])
                vals = parse_qs(parsed.query).get("max_id")
                if vals and vals[0]:
                    return str(vals[0])
        return None

    def _fetch_account_graph_page(
        self,
        account_id: str,
        edge: str,
        *,
        max_id: str = "",
        limit: int = 40,
    ) -> dict[str, Any]:
        params: dict[str, Any] = {"limit": min(max(int(limit), 1), 80)}
        if max_id:
            params["max_id"] = max_id
        res = self._request("GET", f"/api/v1/accounts/{account_id}/{edge}", params=params)
        rows = res.json()
        accounts = [
            normalize_mastodon_account(a, self.instance_url)
            for a in (rows if isinstance(rows, list) else [])
        ]
        if self.access_token and accounts:
            rels = self.get_relationships([a["id"] for a in accounts if a.get("id")])
            by_id = {str(r.get("id")): r for r in rels if r.get("id")}
            for acc in accounts:
                acc["relationship"] = by_id.get(acc["id"])
        return {
            "accounts": accounts,
            "next_cursor": self._extract_next_max_id(res.headers.get("link")),
        }

    def list_following(self, account_id: str, max_id: str = "", limit: int = 40) -> dict[str, Any]:
        return self._fetch_account_graph_page(account_id, "following", max_id=max_id, limit=limit)

    def list_followers(self, account_id: str, max_id: str = "", limit: int = 40) -> dict[str, Any]:
        return self._fetch_account_graph_page(account_id, "followers", max_id=max_id, limit=limit)

    def remove_follower(self, account_id: str) -> dict[str, Any]:
        return self._request("POST", f"/api/v1/accounts/{account_id}/remove_from_followers").json()

    def list_follow_requests(self, limit: int = 40) -> list[dict[str, Any]]:
        rows = self._request("GET", "/api/v1/follow_requests", params={"limit": min(max(int(limit), 1), 80)}).json()
        return [
            normalize_mastodon_account(a, self.instance_url)
            for a in (rows if isinstance(rows, list) else [])
        ]

    def respond_follow_request(self, account_id: str, accept: bool = True) -> dict[str, Any]:
        action = "authorize" if accept else "reject"
        return self._request("POST", f"/api/v1/follow_requests/{account_id}/{action}").json()

    def search(self, query: str, search_type: str = "", resolve: bool = True, limit: int = 20) -> dict[str, Any]:
        params: dict[str, Any] = {"q": query, "resolve": "true" if resolve else "false", "limit": limit}
        if search_type:
            params["type"] = search_type
        raw = self._request("GET", "/api/v2/search", params=params).json()
        return {
            "accounts": [normalize_mastodon_account(a, self.instance_url) for a in raw.get("accounts", [])],
            "statuses": [normalize_mastodon_status(s, self.instance_url) for s in raw.get("statuses", [])],
            "hashtags": raw.get("hashtags", []),
        }

    def fetch_conversations(self, limit: int = 20) -> list[dict[str, Any]]:
        rows = self._request("GET", "/api/v1/conversations", params={"limit": limit}).json()
        out = []
        for convo in rows if isinstance(rows, list) else []:
            out.append({
                "id": str(convo.get("id")),
                "protocol": "mastodon",
                "unread": bool(convo.get("unread")),
                "accounts": [normalize_mastodon_account(a, self.instance_url) for a in convo.get("accounts", [])],
                "last_status": normalize_mastodon_status(convo["last_status"], self.instance_url) if convo.get("last_status") else None,
            })
        return out
