"""Canonical UnifiedItem & notification normalization across Mastodon, Bluesky, and Threads."""

from __future__ import annotations

import html
import ipaddress
import re
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any
from urllib.parse import quote, urlparse

ORIGIN_PROTOCOLS = ("mastodon", "bluesky", "threads")

_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_DROP_CONTENT_TAGS = frozenset({
    "script", "style", "iframe", "object", "embed",
    "svg", "math", "noscript", "template", "form",
})
_ALLOWED_TAGS = frozenset({
    "p", "br", "a", "span", "strong", "b", "em", "i",
    "u", "del", "s", "code", "pre", "blockquote", "ul", "ol", "li",
})
_VOID_TAGS = frozenset({"br", "img"})
_NOTIF_TYPE_MAP = {
    "mention": "mention",
    "reply": "reply",
    "reblog": "repost",
    "repost": "repost",
    "favourite": "like",
    "like": "like",
    "follow": "follow",
    "follow_request": "follow",
    "quote": "quote",
}


def _is_local_host(hostname: str) -> bool:
    host = (hostname or "").strip().lower().rstrip(".")
    if not host:
        return False
    if host == "localhost" or host.endswith(".local") or host.endswith(".ts.net"):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return False
    return bool(ip.is_loopback or ip.is_private or (ip.version == 4 and ip in _TAILSCALE_CGNAT))


def is_allowed_social_url(raw_url: str) -> bool:
    """Require HTTPS for public hosts; permit HTTP only on loopback, LAN, .local, or .ts.net."""
    text = str(raw_url or "").strip()
    if not text:
        return False
    try:
        parsed = urlparse(text)
    except Exception:
        return False
    if not parsed.hostname:
        return False
    if parsed.scheme == "https":
        return True
    if parsed.scheme == "http":
        return _is_local_host(parsed.hostname)
    return False


def normalize_instance_url(raw_url: str, default: str = "https://mastodon.social") -> str:
    """Normalize an ActivityPub or ATProto origin into https://host[:port]."""
    clean = str(raw_url or "").strip() or default
    if "@" in clean and "://" not in clean:
        clean = clean.split("@")[-1].strip()
    if "://" not in clean:
        scheme = "http://" if _is_local_host(clean.split("/")[0].split(":")[0]) else "https://"
        clean = f"{scheme}{clean}"
    parsed = urlparse(clean)
    if not parsed.hostname:
        raise ValueError(f"Invalid instance URL: {raw_url!r}")
    origin = f"{parsed.scheme.lower()}://{parsed.netloc}"
    if not is_allowed_social_url(origin):
        raise ValueError(f"Social endpoints must use HTTPS (got {origin})")
    return origin.rstrip("/")


def parse_iso_ts(date_str: str | None) -> float:
    """Convert an ISO-8601 timestamp string to Unix epoch seconds."""
    raw = str(date_str or "").strip()
    if not raw:
        return 0.0
    if raw.endswith("Z"):
        raw = f"{raw[:-1]}+00:00"
    try:
        dt = datetime.fromisoformat(raw)
    except ValueError:
        return 0.0
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.timestamp()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_href(raw_href: str) -> str | None:
    decoded = html.unescape(str(raw_href or ""))
    cleaned = re.sub(r"[\u0000-\u0020]+", "", decoded).strip()
    if not cleaned:
        return None
    parsed = urlparse(cleaned)
    if parsed.scheme in ("http", "https", "mailto") and (parsed.scheme == "mailto" or parsed.netloc):
        return parsed.geturl()
    return None


def _safe_class(raw_cls: str) -> str:
    tokens = [tok for tok in html.unescape(str(raw_cls or "")).split() if re.fullmatch(r"[a-zA-Z0-9_-]+", tok)]
    return " ".join(tokens)


def _format_text_with_emojis(text: str, emoji_map: dict[str, str]) -> str:
    if not emoji_map:
        return html.escape(text, quote=False)

    def _sub(match: re.Match[str]) -> str:
        code = match.group(1)
        url = emoji_map.get(code)
        if not url:
            return html.escape(match.group(0), quote=False)
        label = html.escape(f":{code}:", quote=True)
        src = html.escape(url, quote=True)
        return f'<img class="custom-emoji" src="{src}" alt="{label}" title="{label}" loading="lazy">'

    return re.sub(r":([a-zA-Z0-9_]+):", _sub, html.unescape(text))


class _SanitizingHTMLParser(HTMLParser):
    def __init__(self, emoji_map: dict[str, str]):
        super().__init__(convert_charrefs=False)
        self.emoji_map = emoji_map
        self.emoji_urls = set(emoji_map.values())
        self.out: list[str] = []
        self.drop_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        name = tag.lower()
        if name in _DROP_CONTENT_TAGS:
            self.drop_depth += 1
            return
        if self.drop_depth > 0:
            return

        attr_map = {k.lower(): (v or "") for k, v in attrs if k}
        if name == "img":
            src = html.unescape(attr_map.get("src", "")).strip()
            safe_cls = _safe_class(attr_map.get("class", ""))
            if is_allowed_social_url(src) and (src in self.emoji_urls or "custom-emoji" in safe_cls.split()):
                alt = html.escape(html.unescape(attr_map.get("alt", "")), quote=True)
                title = html.escape(html.unescape(attr_map.get("title", "") or alt), quote=True)
                self.out.append(
                    f'<img class="custom-emoji" src="{html.escape(src, quote=True)}" '
                    f'alt="{alt}" title="{title}" loading="lazy">'
                )
            return

        if name not in _ALLOWED_TAGS:
            return

        parts: list[str] = []
        if name == "a":
            href = _safe_href(attr_map.get("href", ""))
            if href:
                parts.append(f'href="{html.escape(href, quote=True)}"')
                parts.append('rel="noopener noreferrer"')
                parts.append('target="_blank"')
            cls = _safe_class(attr_map.get("class", ""))
            if cls:
                parts.append(f'class="{html.escape(cls, quote=True)}"')
        elif name == "span":
            cls = _safe_class(attr_map.get("class", ""))
            if cls:
                parts.append(f'class="{html.escape(cls, quote=True)}"')

        if "title" in attr_map and attr_map["title"]:
            parts.append(f'title="{html.escape(html.unescape(attr_map["title"]), quote=True)}"')

        attr_str = f" {' '.join(parts)}" if parts else ""
        self.out.append(f"<{name}{attr_str}>")

    def handle_endtag(self, tag: str) -> None:
        name = tag.lower()
        if name in _DROP_CONTENT_TAGS:
            if self.drop_depth > 0:
                self.drop_depth -= 1
            return
        if self.drop_depth > 0 or name not in _ALLOWED_TAGS or name in _VOID_TAGS:
            return
        self.out.append(f"</{name}>")

    def handle_data(self, data: str) -> None:
        if self.drop_depth == 0:
            self.out.append(_format_text_with_emojis(data, self.emoji_map))

    def handle_entityref(self, name: str) -> None:
        if self.drop_depth == 0:
            self.out.append(_format_text_with_emojis(html.unescape(f"&{name};"), self.emoji_map))

    def handle_charref(self, name: str) -> None:
        if self.drop_depth == 0:
            self.out.append(_format_text_with_emojis(html.unescape(f"&#{name};"), self.emoji_map))


def sanitize_social_html(raw_html: str, custom_emojis: list[dict[str, Any]] | None = None) -> str:
    """Allowlist tokenizer sanitizer matching web/queries/fediverse.js semantics."""
    source = str(raw_html or "")
    if not source:
        return ""
    emoji_map: dict[str, str] = {}
    for item in custom_emojis or []:
        code = str(item.get("shortcode") or "").strip()
        url = str(item.get("url") or item.get("static_url") or "").strip()
        if re.fullmatch(r"[a-zA-Z0-9_]+", code) and is_allowed_social_url(url):
            emoji_map[code] = url

    parser = _SanitizingHTMLParser(emoji_map)
    parser.feed(source)
    parser.close()
    return "".join(parser.out)


def strip_html_to_text(raw_html: str) -> str:
    """Extract clean plain text from sanitized social HTML."""
    clean = sanitize_social_html(raw_html)
    if not clean:
        return ""
    text = re.sub(r"<br\s*/?>", "\n", clean, flags=re.IGNORECASE)
    text = re.sub(r"</p\s*>", "\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


_URL_TEXT_RE = re.compile(r"(?:^|(?<=[\s(]))(https?://[^\s<>()\[\]{}\"']+)")


def _linkify_line_fragment(fragment: str) -> str:
    text = str(fragment or "")
    if not text:
        return ""
    parts: list[str] = []
    cursor = 0
    for m in _URL_TEXT_RE.finditer(text):
        token = m.group(1)
        clean = token.rstrip(".,!?;:")
        while clean.endswith(")") and clean.count(")") > clean.count("("):
            clean = clean[:-1].rstrip(".,!?;:")
        safe_url = _safe_href(clean) if clean else None
        if not safe_url:
            continue
        if m.start(1) > cursor:
            parts.append(html.escape(text[cursor:m.start(1)], quote=False))
        parts.append(
            f'<a href="{html.escape(safe_url, quote=True)}" rel="noopener noreferrer" target="_blank">'
            f'{html.escape(clean, quote=False)}</a>'
        )
        suffix = token[len(clean):]
        if suffix:
            parts.append(html.escape(suffix, quote=False))
        cursor = m.end(1)
    if cursor < len(text):
        parts.append(html.escape(text[cursor:], quote=False))
    return "".join(parts)


def plain_text_to_html(text: str) -> str:
    """Convert plain-text social posts into paragraph-wrapped sanitized HTML with clickable URLs."""
    raw = str(text or "").replace("\r\n", "\n").strip()
    if not raw:
        return ""
    blocks = re.split(r"\n{2,}", raw)
    return "".join(
        f"<p>{'<br>'.join(_linkify_line_fragment(line) for line in block.split(chr(10)))}</p>"
        for block in blocks
        if block
    )


def _render_bsky_facet_anchor(label: str, features: list[dict[str, Any]]) -> str:
    for feat in features:
        if not isinstance(feat, dict):
            continue
        ftype = str(feat.get("$type") or "")
        if (ftype == "app.bsky.richtext.facet#link" or (not ftype and feat.get("uri"))) and feat.get("uri"):
            safe_url = _safe_href(str(feat["uri"]))
            if safe_url:
                return (
                    f'<a href="{html.escape(safe_url, quote=True)}" rel="noopener noreferrer" target="_blank">'
                    f'{html.escape(label, quote=False)}</a>'
                )
        elif ftype == "app.bsky.richtext.facet#mention" and feat.get("did"):
            href = f"https://bsky.app/profile/{quote(str(feat['did']), safe='')}"
            return (
                f'<a href="{html.escape(href, quote=True)}" class="mention" rel="noopener noreferrer" target="_blank">'
                f'{html.escape(label, quote=False)}</a>'
            )
        elif ftype == "app.bsky.richtext.facet#tag" and feat.get("tag"):
            href = f"https://bsky.app/hashtag/{quote(str(feat['tag']), safe='')}"
            return (
                f'<a href="{html.escape(href, quote=True)}" class="hashtag" rel="noopener noreferrer" target="_blank">'
                f'{html.escape(label, quote=False)}</a>'
            )
    return _linkify_line_fragment(label)


def bluesky_richtext_to_html(text: str, facets: list[dict[str, Any]] | None = None) -> str:
    """Convert AT Protocol plain text + UTF-8 byte-indexed facets into paragraph-wrapped HTML."""
    source = str(text or "")
    if not source:
        return ""
    raw_bytes = source.encode("utf-8")
    valid_facets = [
        f for f in (facets or [])
        if isinstance(f, dict)
        and isinstance(f.get("index"), dict)
        and isinstance(f["index"].get("byteStart"), int)
        and isinstance(f["index"].get("byteEnd"), int)
        and 0 <= f["index"]["byteStart"] < f["index"]["byteEnd"] <= len(raw_bytes)
    ]
    valid_facets.sort(key=lambda item: item["index"]["byteStart"])

    inline_parts: list[str] = []
    cursor = 0
    for facet in valid_facets:
        b_start = facet["index"]["byteStart"]
        b_end = facet["index"]["byteEnd"]
        if b_start < cursor:
            continue
        if b_start > cursor:
            inline_parts.append(_linkify_line_fragment(raw_bytes[cursor:b_start].decode("utf-8", errors="replace")))
        label = raw_bytes[b_start:b_end].decode("utf-8", errors="replace")
        feats = facet.get("features") if isinstance(facet.get("features"), list) else []
        inline_parts.append(_render_bsky_facet_anchor(label, feats))
        cursor = b_end

    if cursor < len(raw_bytes):
        inline_parts.append(_linkify_line_fragment(raw_bytes[cursor:].decode("utf-8", errors="replace")))

    assembled = "".join(inline_parts).replace("\r\n", "\n")
    blocks = [b for b in re.split(r"\n{2,}", assembled) if b]
    return "".join(f"<p>{b.replace(chr(10), '<br>')}</p>" for b in blocks)


def _normalize_link_card(url_raw: Any, title_raw: Any = "", desc_raw: Any = "", image_raw: Any = "") -> dict[str, str] | None:
    safe_url = _safe_href(str(url_raw or ""))
    if not safe_url:
        return None
    return {
        "url": safe_url,
        "title": html.unescape(str(title_raw or "")),
        "description": html.unescape(str(desc_raw or "")),
        "image": str(image_raw or ""),
    }


def canonicalize_actor_handle(handle: str, protocol: str = "mastodon") -> str:
    """Deduplicate ActivityPub-bridged handles (@u@bsky.brid.gy, @u@threads.net) across protocols."""
    clean = str(handle or "").strip().lstrip("@").lower()
    if not clean:
        return ""
    if protocol == "bluesky" or clean.endswith("@bsky.brid.gy"):
        base = clean[: -len("@bsky.brid.gy")] if clean.endswith("@bsky.brid.gy") else clean
        return f"bluesky:{base}"
    if protocol == "threads" or clean.endswith("@threads.net"):
        base = clean[: -len("@threads.net")] if clean.endswith("@threads.net") else clean
        return f"threads:{base}"
    return f"{protocol}:{clean}"


def _derive_mime_type(att: dict[str, Any]) -> str:
    explicit = str(att.get("mime_type") or "").strip().lower()
    if explicit:
        return explicit
    media_type = str(att.get("type") or "image").strip().lower()
    if media_type in ("video", "gifv"):
        return "video/mp4"
    if media_type == "audio":
        return "audio/mpeg"
    return "image/jpeg"


def _clean_media_url(url: str | None) -> str:
    clean = str(url or "").strip()
    if not clean or clean.lower().endswith("/missing.png"):
        return ""
    return clean


def normalize_mastodon_account(raw_account: dict[str, Any] | None, instance_url: str) -> dict[str, Any]:
    """Normalize a Mastodon Account payload preserving public profile & metadata fields."""
    raw = raw_account or {}
    origin = normalize_instance_url(instance_url)
    host = urlparse(origin).netloc
    raw_acct = str(raw.get("acct") or raw.get("username") or "").strip().lstrip("@")
    full_acct = raw_acct if "@" in raw_acct or not raw_acct else f"{raw_acct}@{host}"
    raw_note = str(raw.get("note") or "")
    emojis = raw.get("emojis") if isinstance(raw.get("emojis"), list) else []
    source = raw.get("source") if isinstance(raw.get("source"), dict) else {}
    raw_fields = source.get("fields") if isinstance(source.get("fields"), list) else raw.get("fields")
    fields = []
    if isinstance(raw_fields, list):
        for f in raw_fields[:4]:
            if not isinstance(f, dict):
                continue
            val_html = str(f.get("value") or "")
            fields.append({
                "name": html.unescape(str(f.get("name") or "")).strip(),
                "value": strip_html_to_text(val_html) if "<" in val_html else html.unescape(val_html).strip(),
                "value_html": sanitize_social_html(val_html) if "<" in val_html else html.escape(val_html),
                "verified_at": f.get("verified_at") or None,
            })

    raw_display = html.unescape(str(raw.get("display_name") or "")).strip()
    local_username = str(raw.get("username") or raw_acct.split("@", 1)[0] or raw_acct)

    return {
        "id": str(raw.get("id") or ""),
        "username": local_username,
        "acct": full_acct,
        "display_name": raw_display or local_username,
        "avatar_url": _clean_media_url(raw.get("avatar") or raw.get("avatar_static")),
        "header_url": _clean_media_url(raw.get("header") or raw.get("header_static")),
        "url": str(raw.get("url") or ""),
        "note_html": sanitize_social_html(raw_note, emojis),
        "note_text": str(source.get("note") or strip_html_to_text(raw_note)),
        "fields": fields,
        "followers_count": int(raw.get("followers_count") or 0),
        "following_count": int(raw.get("following_count") or 0),
        "statuses_count": int(raw.get("statuses_count") or 0),
        "locked": bool(raw.get("locked", False)),
        "bot": bool(raw.get("bot", False)),
        "discoverable": bool(raw.get("discoverable", True)),
        "indexable": bool(source["indexable"]) if "indexable" in source else bool(raw.get("indexable", True)),
        "hide_collections": bool(source["hide_collections"]) if "hide_collections" in source else bool(raw.get("hide_collections", False)),
        "default_visibility": str(source.get("privacy") or "public"),
        "default_sensitive": bool(source.get("sensitive", False)),
        "default_language": str(source.get("language") or "en"),
        "attribution_domains": list(source.get("attribution_domains") or raw.get("attribution_domains") or []),
        "emojis": emojis,
    }


def normalize_mastodon_status(
    raw: dict[str, Any],
    instance_url: str,
    linked_ids: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize a Mastodon Status payload into the canonical UnifiedItem schema."""
    origin = normalize_instance_url(instance_url)
    reblog = raw.get("reblog") if isinstance(raw.get("reblog"), dict) else None
    post = reblog or raw
    emojis = post.get("emojis") if isinstance(post.get("emojis"), list) else []
    status_id = str(post.get("id") or "")
    account = normalize_mastodon_account(post.get("account") if isinstance(post.get("account"), dict) else {}, origin)
    raw_html = str(post.get("content") or "")
    content_html = sanitize_social_html(raw_html, emojis)
    content_text = strip_html_to_text(raw_html)
    published = str(post.get("created_at") or raw.get("created_at") or _now_iso())

    attachments = []
    for att in post.get("media_attachments") or []:
        if not isinstance(att, dict):
            continue
        url = str(att.get("url") or att.get("remote_url") or att.get("preview_url") or "")
        if not url:
            continue
        orig_meta = (att.get("meta") or {}).get("original") if isinstance(att.get("meta"), dict) else {}
        mapped_att: dict[str, Any] = {
            "url": url,
            "mime_type": _derive_mime_type(att),
            "alt_text": str(att.get("description") or ""),
        }
        if att.get("type"):
            mapped_att["type"] = str(att["type"])
        if att.get("preview_url"):
            mapped_att["previewUrl"] = str(att["preview_url"])
        if isinstance(orig_meta, dict):
            if orig_meta.get("width"):
                mapped_att["width"] = int(orig_meta["width"])
            if orig_meta.get("height"):
                mapped_att["height"] = int(orig_meta["height"])
        attachments.append(mapped_att)

    mastodon_meta: dict[str, Any] = {
        "statusId": status_id,
        "uri": str(post.get("uri") or post.get("url") or ""),
        "visibility": str(post.get("visibility") or "public"),
        "sensitive": bool(post.get("sensitive", False)),
        "favourited": bool(post.get("favourited", False)),
        "reblogged": bool(post.get("reblogged", False)),
        "bookmarked": bool(post.get("bookmarked", False)),
        "pinned": bool(post.get("pinned", False)),
        "spoilerText": str(post.get("spoiler_text") or ""),
        "inReplyToId": str(post["in_reply_to_id"]) if post.get("in_reply_to_id") else None,
        "instanceUrl": origin,
        "wrapperId": str(raw.get("id") or status_id),
        "emojis": emojis,
    }
    if reblog and isinstance(raw.get("account"), dict):
        booster = normalize_mastodon_account(raw["account"], origin)
        mastodon_meta["rebloggedBy"] = {
            "id": booster["id"],
            "name": booster["display_name"],
            "handle": booster["acct"],
            "avatar_url": booster["avatar_url"],
        }

    meta: dict[str, Any] = {"mastodon": mastodon_meta}
    raw_card = post.get("card") if isinstance(post.get("card"), dict) else None
    if raw_card:
        card = _normalize_link_card(
            raw_card.get("url"),
            raw_card.get("title"),
            raw_card.get("description"),
            raw_card.get("image"),
        )
        if card:
            meta["linkCard"] = card
    raw_quote = (post.get("quote") or {}).get("quoted_status") if isinstance(post.get("quote"), dict) else None
    if not raw_quote and isinstance(post.get("quote"), dict) and (post["quote"].get("id") or post["quote"].get("content")):
        raw_quote = post["quote"]
    if isinstance(raw_quote, dict) and isinstance(raw_quote.get("account"), dict):
        q_acc = normalize_mastodon_account(raw_quote["account"], origin)
        q_media = raw_quote.get("media_attachments") or []
        q_thumb = str(q_media[0].get("preview_url") or q_media[0].get("url") or "") if q_media and isinstance(q_media[0], dict) else ""
        meta["quotePost"] = {
            "id": f"mastodon:{raw_quote.get('id') or ''}",
            "protocol": "mastodon",
            "statusId": str(raw_quote.get("id") or ""),
            "instanceUrl": origin,
            "url": str(raw_quote.get("url") or raw_quote.get("uri") or ""),
            "authorName": q_acc["display_name"],
            "authorHandle": q_acc["acct"],
            "authorAvatar": q_acc["avatar_url"],
            "text": strip_html_to_text(str(raw_quote.get("content") or "")),
            "createdAt": str(raw_quote.get("created_at") or ""),
            **({"thumbUrl": q_thumb} if q_thumb else {}),
        }
    if linked_ids:
        meta["linkedIds"] = {k: v for k, v in linked_ids.items() if v}

    return {
        "id": f"mastodon:{status_id}",
        "protocol": "mastodon",
        "url": str(post.get("url") or post.get("uri") or ""),
        "content_html": content_html,
        "content_text": content_text,
        "date_published": published,
        "author": {
            "id": account["id"],
            "name": account["display_name"],
            "handle": account["acct"],
            "avatar_url": account["avatar_url"],
            "url": account["url"],
        },
        "attachments": attachments,
        "metrics": {
            "replies": int(post.get("replies_count") or 0),
            "reposts": int(post.get("reblogs_count") or 0),
            "likes": int(post.get("favourites_count") or 0),
        },
        "_meta": meta,
    }


def _is_bsky_gif_external(url: str) -> bool:
    try:
        parsed = urlparse(str(url or "").strip())
        host = (parsed.hostname or "").lower()
        return (
            parsed.scheme == "https"
            and (host == "tenor.com" or host.endswith(".tenor.com") or host == "giphy.com" or host.endswith(".giphy.com"))
            and parsed.path.lower().endswith(".gif")
        )
    except Exception:
        return False


def _extract_bsky_quote_post(embed: dict[str, Any]) -> dict[str, Any] | None:
    if not isinstance(embed, dict):
        return None
    emb_type = str(embed.get("$type") or "")
    raw_rec = (embed.get("record") or {}).get("record") if emb_type.startswith("app.bsky.embed.recordWithMedia") else embed.get("record")
    if not isinstance(raw_rec, dict):
        return None
    rec_type = str(raw_rec.get("$type") or "")
    if "viewNotFound" in rec_type or "viewBlocked" in rec_type or "viewDetached" in rec_type or raw_rec.get("notFound") or raw_rec.get("blocked") or raw_rec.get("detached"):
        return {
            "unavailable": True,
            "reason": "Quoted post from blocked account" if raw_rec.get("blocked") else "Quoted post unavailable",
        }
    if "viewRecord" not in rec_type and not (raw_rec.get("value") and raw_rec.get("author")):
        return None
    q_uri = str(raw_rec.get("uri") or "")
    q_cid = str(raw_rec.get("cid") or "")
    q_rkey = q_uri.rsplit("/", 1)[-1] if "/" in q_uri else q_uri
    q_author = raw_rec.get("author") if isinstance(raw_rec.get("author"), dict) else {}
    q_handle = str(q_author.get("handle") or q_author.get("did") or "")
    q_val = raw_rec.get("value") if isinstance(raw_rec.get("value"), dict) else {}
    first_emb = (raw_rec.get("embeds") or [None])[0] if isinstance(raw_rec.get("embeds"), list) and raw_rec.get("embeds") else None
    thumb_url = ""
    if isinstance(first_emb, dict):
        imgs = first_emb.get("images") or (first_emb.get("media") or {}).get("images") or []
        if imgs and isinstance(imgs[0], dict):
            thumb_url = str(imgs[0].get("thumb") or imgs[0].get("fullsize") or "")
        elif first_emb.get("thumbnail"):
            thumb_url = str(first_emb["thumbnail"])
        elif isinstance(first_emb.get("media"), dict) and first_emb["media"].get("thumbnail"):
            thumb_url = str(first_emb["media"]["thumbnail"])
        elif isinstance(first_emb.get("external"), dict) and first_emb["external"].get("thumb"):
            thumb_url = str(first_emb["external"]["thumb"])
    return {
        "id": f"bluesky:{q_uri or q_cid}",
        "protocol": "bluesky",
        "uri": q_uri,
        "cid": q_cid,
        "authorName": str(q_author.get("displayName") or q_handle),
        "authorHandle": q_handle,
        "authorDid": str(q_author.get("did") or ""),
        "authorAvatar": str(q_author.get("avatar") or ""),
        "text": str(q_val.get("text") or ""),
        "createdAt": str(q_val.get("createdAt") or raw_rec.get("indexedAt") or ""),
        "url": f"https://bsky.app/profile/{q_handle}/post/{q_rkey}" if q_handle and q_rkey else "",
        **({"thumbUrl": thumb_url} if thumb_url else {}),
    }


def normalize_bluesky_post(
    feed_item: dict[str, Any],
    linked_ids: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize an AT Protocol FeedViewPost or PostView into UnifiedItem."""
    post = feed_item.get("post") if isinstance(feed_item.get("post"), dict) else feed_item
    record = post.get("record") if isinstance(post.get("record"), dict) else {}
    author_raw = post.get("author") if isinstance(post.get("author"), dict) else {}
    uri = str(post.get("uri") or feed_item.get("uri") or "")
    cid = str(post.get("cid") or feed_item.get("cid") or "")
    rkey = uri.rsplit("/", 1)[-1] if "/" in uri else uri
    handle = str(author_raw.get("handle") or author_raw.get("did") or "")
    did = str(author_raw.get("did") or "")
    text = str(record.get("text") or "")
    published = str(record.get("createdAt") or post.get("indexedAt") or _now_iso())

    attachments = []
    embed = post.get("embed") if isinstance(post.get("embed"), dict) else {}
    emb_type = str(embed.get("$type") or "")
    embed_media = embed.get("media") if emb_type.startswith("app.bsky.embed.recordWithMedia") and isinstance(embed.get("media"), dict) else embed
    rec_embed = record.get("embed") if isinstance(record.get("embed"), dict) else {}
    rec_media = rec_embed.get("media") if str(rec_embed.get("$type") or "").startswith("app.bsky.embed.recordWithMedia") and isinstance(rec_embed.get("media"), dict) else rec_embed

    embed_images = embed_media.get("images") if isinstance(embed_media.get("images"), list) else []
    for img in embed_images:
        if not isinstance(img, dict):
            continue
        url = str(img.get("fullsize") or img.get("thumb") or "")
        if url:
            att_item: dict[str, Any] = {
                "url": url,
                "type": "image",
                "mime_type": "image/jpeg",
                "alt_text": str(img.get("alt") or ""),
            }
            ar = img.get("aspectRatio") if isinstance(img.get("aspectRatio"), dict) else {}
            if ar.get("width"):
                att_item["width"] = int(ar["width"])
            if ar.get("height"):
                att_item["height"] = int(ar["height"])
            attachments.append(att_item)

    vid_type = str(embed_media.get("$type") or "")
    if vid_type.startswith("app.bsky.embed.video") or embed_media.get("playlist") or rec_media.get("video"):
        v_cid = str(embed_media.get("cid") or ((rec_media.get("video") or {}).get("ref") or {}).get("$link") or "")
        mp4_url = f"https://bsky.social/xrpc/com.atproto.sync.getBlob?did={quote(did, safe='')}&cid={quote(v_cid, safe='')}" if did and v_cid else ""
        hls_url = str(embed_media.get("playlist") or "")
        if mp4_url or hls_url:
            ar = embed_media.get("aspectRatio") if isinstance(embed_media.get("aspectRatio"), dict) else (rec_media.get("aspectRatio") if isinstance(rec_media.get("aspectRatio"), dict) else {})
            v_att: dict[str, Any] = {
                "url": mp4_url or hls_url,
                "type": "gifv" if embed_media.get("presentation") == "gif" else "video",
                "mime_type": str((rec_media.get("video") or {}).get("mimeType") or ("video/mp4" if mp4_url else "application/vnd.apple.mpegurl")),
                "alt_text": str(embed_media.get("alt") or rec_media.get("alt") or ""),
                "width": int(ar.get("width") or 640),
                "height": int(ar.get("height") or 360),
                "did": did,
                "cid": v_cid,
            }
            if hls_url:
                v_att["hlsUrl"] = hls_url
            if embed_media.get("thumbnail"):
                v_att["previewUrl"] = str(embed_media["thumbnail"])
            attachments.append(v_att)

    ext_card = embed_media.get("external") if isinstance(embed_media.get("external"), dict) else None
    is_gif_external = bool(ext_card and _is_bsky_gif_external(str(ext_card.get("uri") or "")))
    if is_gif_external and ext_card:
        attachments.append({
            "url": str(ext_card["uri"]),
            "type": "image",
            "mime_type": "image/gif",
            "alt_text": str(ext_card.get("description") or ext_card.get("title") or ""),
            **({"previewUrl": str(ext_card["thumb"])} if ext_card.get("thumb") else {}),
        })

    viewer = post.get("viewer") if isinstance(post.get("viewer"), dict) else {}
    reply_ref = record.get("reply") if isinstance(record.get("reply"), dict) else {}
    facets = record.get("facets") if isinstance(record.get("facets"), list) else []
    reason = feed_item.get("reason") if isinstance(feed_item.get("reason"), dict) else {}
    reason_by = reason.get("by") if isinstance(reason.get("by"), dict) else None
    raw_labels: list[str] = []
    for lbl in (post.get("labels") or []):
        if isinstance(lbl, dict) and lbl.get("val"):
            raw_labels.append(str(lbl["val"]).strip().lower())
    rec_labels = (record.get("labels") or {}).get("values") if isinstance(record.get("labels"), dict) else []
    for lbl in (rec_labels or []):
        if isinstance(lbl, dict) and lbl.get("val"):
            raw_labels.append(str(lbl["val"]).strip().lower())
    labels = list(dict.fromkeys(v for v in raw_labels if v))

    bsky_meta: dict[str, Any] = {
        "uri": uri,
        "cid": cid,
        "likeUri": viewer.get("like") or None,
        "repostUri": viewer.get("repost") or None,
    }
    if facets:
        bsky_meta["facets"] = facets
    if reply_ref:
        bsky_meta["reply"] = reply_ref
    if labels:
        bsky_meta["labels"] = labels
    if reason_by:
        rb_handle = str(reason_by.get("handle") or reason_by.get("did") or "")
        bsky_meta["rebloggedBy"] = {
            "id": str(reason_by.get("did") or ""),
            "acct": rb_handle,
            "displayName": str(reason_by.get("displayName") or rb_handle),
            "avatar": str(reason_by.get("avatar") or ""),
        }

    meta: dict[str, Any] = {"bluesky": bsky_meta}
    if ext_card and not is_gif_external:
        card = _normalize_link_card(
            ext_card.get("uri"),
            ext_card.get("title"),
            ext_card.get("description"),
            ext_card.get("thumb"),
        )
        if card:
            meta["linkCard"] = card
    quote_post = _extract_bsky_quote_post(embed)
    if quote_post:
        meta["quotePost"] = quote_post
    if linked_ids:
        meta["linkedIds"] = {k: v for k, v in linked_ids.items() if v}

    return {
        "id": f"bluesky:{uri or cid}",
        "protocol": "bluesky",
        "url": f"https://bsky.app/profile/{handle}/post/{rkey}" if handle and rkey else "",
        "content_html": bluesky_richtext_to_html(text, facets),
        "content_text": text,
        "date_published": published,
        "author": {
            "id": str(author_raw.get("did") or ""),
            "name": str(author_raw.get("displayName") or handle),
            "handle": handle,
            "avatar_url": str(author_raw.get("avatar") or ""),
            "url": f"https://bsky.app/profile/{handle}" if handle else "",
        },
        "attachments": attachments,
        "metrics": {
            "replies": int(post.get("replyCount") or 0),
            "reposts": int(post.get("repostCount") or 0),
            "likes": int(post.get("likeCount") or 0),
        },
        "_meta": meta,
    }


def _map_threads_attachment(node: dict[str, Any], fallback_alt: str = "") -> dict[str, Any] | None:
    media_url = str(node.get("media_url") or "").strip()
    if not media_url:
        return None
    media_type = str(node.get("media_type") or "").upper()
    mime_type = "video/mp4" if media_type == "VIDEO" else ("audio/mpeg" if media_type == "AUDIO" else "image/jpeg")
    att: dict[str, Any] = {
        "url": media_url,
        "mime_type": mime_type,
        "alt_text": str(node.get("alt_text") or fallback_alt or ""),
    }
    if node.get("thumbnail_url"):
        att["preview_url"] = str(node["thumbnail_url"])
    return att


def normalize_threads_post(
    raw: dict[str, Any],
    author_profile: dict[str, Any] | None = None,
    linked_ids: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Normalize a Meta Threads Graph API post object into UnifiedItem."""
    post_id = str(raw.get("id") or "")
    text = str(raw.get("text") or "")
    prof = author_profile or {}
    username = str(raw.get("username") or prof.get("username") or "").lstrip("@")
    published = str(raw.get("timestamp") or _now_iso())

    child_rows = raw.get("children", {}).get("data") if isinstance(raw.get("children"), dict) else None
    attachments: list[dict[str, Any]] = []
    if isinstance(child_rows, list) and child_rows:
        fallback_alt = str(raw.get("alt_text") or "")
        for child in child_rows:
            if isinstance(child, dict):
                mapped = _map_threads_attachment(child, fallback_alt)
                if mapped:
                    attachments.append(mapped)
    else:
        mapped = _map_threads_attachment(raw)
        if mapped:
            attachments.append(mapped)

    threads_meta: dict[str, Any] = {"postId": post_id}
    if raw.get("shortcode"):
        threads_meta["shortcode"] = str(raw["shortcode"])
    if raw.get("topic_tag"):
        threads_meta["topicTag"] = str(raw["topic_tag"])
    if raw.get("is_quote_post"):
        threads_meta["isQuotePost"] = True
    if isinstance(raw.get("replied_to"), dict) and raw["replied_to"].get("id"):
        rid = str(raw["replied_to"]["id"])
        threads_meta["repliedToId"] = rid
        threads_meta["parentPostId"] = rid
    if isinstance(raw.get("root_post"), dict) and raw["root_post"].get("id"):
        threads_meta["rootPostId"] = str(raw["root_post"]["id"])
    if raw.get("hide_status"):
        threads_meta["hideStatus"] = str(raw["hide_status"])

    meta: dict[str, Any] = {"threads": threads_meta}
    link_url = str(raw.get("link_attachment_url") or "").strip()
    if link_url and is_allowed_social_url(link_url):
        parsed_link = urlparse(link_url)
        meta["linkCard"] = {
            "url": link_url,
            "title": parsed_link.hostname or "",
            "description": "",
            "image": "",
        }
    if linked_ids:
        meta["linkedIds"] = {k: v for k, v in linked_ids.items() if v}

    return {
        "id": f"threads:{post_id}",
        "protocol": "threads",
        "url": str(raw.get("permalink") or (f"https://www.threads.net/@{username}/post/{post_id}" if username and post_id else "")),
        "content_html": plain_text_to_html(text),
        "content_text": text,
        "date_published": published,
        "author": {
            "id": str(prof.get("id") or username or post_id),
            "name": str(prof.get("name") or username),
            "handle": username,
            "avatar_url": str(prof.get("threads_profile_picture_url") or ""),
            "url": f"https://www.threads.net/@{username}" if username else "",
        },
        "attachments": attachments,
        "metrics": {"replies": 0, "reposts": 0, "likes": 0},
        "_meta": meta,
    }


def normalize_mastodon_notification(
    raw: dict[str, Any],
    instance_url: str,
) -> dict[str, Any]:
    """Normalize a Mastodon notification into UnifiedItem with _meta.notification."""
    origin = normalize_instance_url(instance_url)
    notif_id = str(raw.get("id") or "")
    raw_type = str(raw.get("type") or "mention")
    notif_type = _NOTIF_TYPE_MAP.get(raw_type, "mention")
    actor_acc = normalize_mastodon_account(raw.get("account") if isinstance(raw.get("account"), dict) else {}, origin)
    actor = {
        "id": actor_acc["id"],
        "name": actor_acc["display_name"],
        "handle": actor_acc["acct"],
        "avatar_url": actor_acc["avatar_url"],
        "url": actor_acc["url"],
    }
    status_item = (
        normalize_mastodon_status(raw["status"], origin)
        if isinstance(raw.get("status"), dict)
        else None
    )
    created_at = str(raw.get("created_at") or (status_item or {}).get("date_published") or _now_iso())

    if status_item:
        meta = dict(status_item["_meta"])
        meta["notification"] = {"notifId": notif_id, "type": notif_type, "actor": actor}
        status_item["id"] = f"mastodon:notif:{notif_id}"
        status_item["date_published"] = created_at
        status_item["_meta"] = meta
        return status_item

    return {
        "id": f"mastodon:notif:{notif_id}",
        "protocol": "mastodon",
        "url": actor["url"],
        "content_html": "",
        "content_text": "",
        "date_published": created_at,
        "author": actor,
        "attachments": [],
        "metrics": {"replies": 0, "reposts": 0, "likes": 0},
        "_meta": {
            "mastodon": {"statusId": "", "uri": "", "visibility": "public", "instanceUrl": origin},
            "notification": {"notifId": notif_id, "type": notif_type, "actor": actor},
        },
    }


def normalize_bluesky_notification(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize an app.bsky.notification.listNotifications entry into UnifiedItem."""
    author_raw = raw.get("author") if isinstance(raw.get("author"), dict) else {}
    handle = str(author_raw.get("handle") or author_raw.get("did") or "")
    actor = {
        "id": str(author_raw.get("did") or ""),
        "name": str(author_raw.get("displayName") or handle),
        "handle": handle,
        "avatar_url": str(author_raw.get("avatar") or ""),
        "url": f"https://bsky.app/profile/{handle}" if handle else "",
    }
    record = raw.get("record") if isinstance(raw.get("record"), dict) else {}
    uri = str(raw.get("uri") or "")
    cid = str(raw.get("cid") or "")
    reason = str(raw.get("reason") or "mention")
    notif_type = _NOTIF_TYPE_MAP.get(reason, "mention")
    reply_parent = ((record.get("reply") or {}).get("parent") or {}).get("uri") if isinstance(record.get("reply"), dict) else ""
    subject_obj = record.get("subject") if isinstance(record.get("subject"), dict) else {}
    subject_uri = str(raw.get("reasonSubject") or subject_obj.get("uri") or reply_parent or "")
    is_read = raw.get("isRead")
    text = str(record.get("text") or "")
    published = str(raw.get("indexedAt") or record.get("createdAt") or _now_iso())
    rkey = uri.rsplit("/", 1)[-1] if "/" in uri else uri
    post_url = f"https://bsky.app/profile/{handle}/post/{rkey}" if handle and rkey else actor["url"]

    bsky_meta: dict[str, Any] = {"uri": uri, "cid": cid}
    if subject_uri:
        bsky_meta["subjectUri"] = subject_uri

    notif_meta: dict[str, Any] = {
        "notifId": f"bsky:{cid or uri}",
        "type": notif_type,
        "actor": actor,
    }
    if subject_uri:
        notif_meta["targetPostUri"] = subject_uri
    if uri:
        notif_meta["notifRecordUri"] = uri
    if isinstance(is_read, bool):
        notif_meta["isRead"] = bool(is_read)

    return {
        "id": f"bluesky:notif:{cid or uri or published}:{reason}",
        "protocol": "bluesky",
        "url": post_url,
        "content_html": bluesky_richtext_to_html(text, record.get("facets") if isinstance(record.get("facets"), list) else None),
        "content_text": text,
        "date_published": published,
        "author": actor,
        "attachments": [],
        "metrics": {"replies": 0, "reposts": 0, "likes": 0},
        "_meta": {
            "bluesky": bsky_meta,
            "notification": notif_meta,
        },
    }


def normalize_threads_reply_notification(
    raw: dict[str, Any],
    parent_post_id: str = "",
    notif_type: str = "reply",
) -> dict[str, Any]:
    """Normalize a Threads reply or mention object into a UnifiedItem notification."""
    item = normalize_threads_post(raw)
    reply_id = item["_meta"]["threads"]["postId"]
    if parent_post_id and not item["_meta"]["threads"].get("parentPostId"):
        item["_meta"]["threads"]["parentPostId"] = str(parent_post_id)
    item["id"] = f"threads:notif:{reply_id}"
    item["_meta"]["notification"] = {
        "notifId": f"threads:{reply_id}",
        "type": notif_type,
        "actor": item["author"],
    }
    return item


def _dedupe_signature(item: dict[str, Any]) -> tuple[str, str, str]:
    notif = item.get("_meta", {}).get("notification")
    if isinstance(notif, dict):
        actor_handle = (notif.get("actor") or {}).get("handle") or item.get("author", {}).get("handle", "")
        kind = f"notif:{notif.get('type', 'mention')}"
    else:
        actor_handle = item.get("author", {}).get("handle", "")
        kind = "post"
    canon_actor = canonicalize_actor_handle(actor_handle, item.get("protocol", "mastodon"))
    snippet = re.sub(r"\s+", " ", str(item.get("content_text") or "")).strip().lower()[:100]
    return canon_actor, kind, snippet


def deduplicate_unified_items(
    items: list[dict[str, Any]],
    time_window_sec: float = 120.0,
) -> list[dict[str, Any]]:
    """Merge duplicate and ActivityPub-bridged items chronologically (Mastodon primary)."""
    by_id: dict[str, dict[str, Any]] = {}
    for item in items:
        if not item or not item.get("id"):
            continue
        existing = by_id.get(item["id"])
        if existing is None:
            by_id[item["id"]] = item
        else:
            merged_meta = {**existing.get("_meta", {}), **item.get("_meta", {})}
            by_id[item["id"]] = {**existing, **item, "_meta": merged_meta}

    # Prefer mastodon entries first at equal timestamps so ActivityPub primary absorbs bridged duplicates.
    priority = {"mastodon": 0, "bluesky": 1, "threads": 2}
    ordered = sorted(
        by_id.values(),
        key=lambda x: (-parse_iso_ts(x.get("date_published")), priority.get(x.get("protocol", "mastodon"), 9)),
    )

    kept: list[dict[str, Any]] = []
    for cand in ordered:
        sig = _dedupe_signature(cand)
        cand_ts = parse_iso_ts(cand.get("date_published"))
        absorbed = False
        if sig[0]:
            for existing in kept:
                if _dedupe_signature(existing) != sig:
                    continue
                if abs(parse_iso_ts(existing.get("date_published")) - cand_ts) <= time_window_sec:
                    for key in ("mastodon", "bluesky", "threads", "linkedIds", "metricsBreakdown"):
                        if key in cand.get("_meta", {}) and key not in existing.get("_meta", {}):
                            existing.setdefault("_meta", {})[key] = cand["_meta"][key]
                    absorbed = True
                    break
        if not absorbed:
            kept.append(cand)

    return sorted(kept, key=lambda x: -parse_iso_ts(x.get("date_published")))
