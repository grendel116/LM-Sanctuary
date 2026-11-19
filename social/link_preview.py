"""Public link preview & video façade metadata extractor with SSRF protection."""

from __future__ import annotations

import ipaddress
import re
import socket
import threading
import time
from html.parser import HTMLParser
from typing import Any
from urllib.parse import parse_qs, quote, urljoin, urlparse

import httpx

_TAILSCALE_CGNAT = ipaddress.ip_network("100.64.0.0/10")
_HTTPS_URL_RE = re.compile(r"https://[^\s<>\"'`]+")
_YT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_VIMEO_ID_RE = re.compile(r"^[0-9]{5,15}$")

_CACHE_TTL_SEC = 300.0
_CACHE_MAX_ENTRIES = 256
_MAX_HTML_BYTES = 96 * 1024
_MAX_IMAGE_BYTES = 950_000

_cache_lock = threading.Lock()
_preview_cache: dict[str, tuple[float, dict[str, Any] | None]] = {}


def extract_first_https_url(text: str) -> str:
    """Return the first clean https:// URL inside plain text, or ''."""
    for match in _HTTPS_URL_RE.finditer(str(text or "")):
        raw = match.group(0)
        while raw and raw[-1] in ".,!?;:]}'\"":
            raw = raw[:-1]
        while raw.endswith(")") and raw.count(")") > raw.count("("):
            raw = raw[:-1]
        try:
            parsed = urlparse(raw)
        except Exception:
            continue
        if parsed.scheme == "https" and parsed.hostname:
            return parsed.geturl()
    return ""


def parse_video_embed(url: str) -> dict[str, str] | None:
    """Recognize privacy-friendly YouTube and Vimeo embed URLs."""
    try:
        parsed = urlparse(str(url or "").strip())
    except Exception:
        return None
    if parsed.scheme != "https" or not parsed.hostname:
        return None
    host = parsed.hostname.lower().rstrip(".")
    path = parsed.path or ""

    yt_id = ""
    if host == "youtu.be":
        cand = path.strip("/").split("/")[0] if path.strip("/") else ""
        if _YT_ID_RE.match(cand):
            yt_id = cand
    elif host in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "www.youtube-nocookie.com", "youtube-nocookie.com"):
        parts = [p for p in path.split("/") if p]
        if parts and parts[0] == "watch":
            cand = (parse_qs(parsed.query).get("v") or [""])[0]
            if _YT_ID_RE.match(cand):
                yt_id = cand
        elif len(parts) >= 2 and parts[0] in ("shorts", "live", "embed"):
            if _YT_ID_RE.match(parts[1]):
                yt_id = parts[1]

    if yt_id:
        return {
            "provider": "youtube",
            "videoId": yt_id,
            "embedUrl": f"https://www.youtube-nocookie.com/embed/{yt_id}?autoplay=1&rel=0",
            "thumbnailUrl": f"https://i.ytimg.com/vi/{yt_id}/hqdefault.jpg",
            "canonicalUrl": f"https://www.youtube.com/watch?v={yt_id}",
        }

    if host in ("vimeo.com", "www.vimeo.com", "player.vimeo.com"):
        parts = [p for p in path.split("/") if p]
        cand = ""
        if host == "player.vimeo.com" and len(parts) >= 2 and parts[0] == "video":
            cand = parts[1]
        elif parts:
            cand = parts[0]
        if _VIMEO_ID_RE.match(cand):
            return {
                "provider": "vimeo",
                "videoId": cand,
                "embedUrl": f"https://player.vimeo.com/video/{cand}?autoplay=1&dnt=1",
                "thumbnailUrl": "",
                "canonicalUrl": f"https://vimeo.com/{cand}",
            }

    return None


def _is_non_public_ip(ip_obj: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    if (
        ip_obj.is_private
        or ip_obj.is_loopback
        or ip_obj.is_link_local
        or ip_obj.is_multicast
        or ip_obj.is_reserved
        or ip_obj.is_unspecified
    ):
        return True
    if ip_obj.version == 4 and ip_obj in _TAILSCALE_CGNAT:
        return True
    if ip_obj.version == 6 and ip_obj.ipv4_mapped:
        return _is_non_public_ip(ip_obj.ipv4_mapped)
    return False


def assert_safe_public_https_url(raw_url: str, *, allow_unresolvable_mock: bool = False) -> str:
    """Validate an HTTPS public URL and reject loopback, LAN, CGNAT, and private IPs."""
    text = str(raw_url or "").strip()
    if not text:
        raise ValueError("Missing URL")
    parsed = urlparse(text)
    if parsed.scheme != "https" or not parsed.hostname:
        raise ValueError("Only public https:// URLs are supported")

    host = parsed.hostname.strip().lower().rstrip(".")
    if (
        host == "localhost"
        or host.endswith(".localhost")
        or host.endswith(".local")
        or host.endswith(".internal")
        or host.endswith(".ts.net")
    ):
        raise ValueError("Local or private hostnames are not permitted")

    try:
        ip_lit = ipaddress.ip_address(host)
    except ValueError:
        ip_lit = None

    if ip_lit is not None:
        if _is_non_public_ip(ip_lit):
            raise ValueError("Private or loopback IP addresses are not permitted")
        return parsed.geturl()

    try:
        infos = socket.getaddrinfo(host, parsed.port or 443, type=socket.SOCK_STREAM)
    except OSError:
        if allow_unresolvable_mock:
            return parsed.geturl()
        raise ValueError(f"Could not resolve host: {host}")

    for info in infos:
        sockaddr = info[4]
        if not sockaddr:
            continue
        addr_str = str(sockaddr[0]).split("%")[0]
        ip_res = ipaddress.ip_address(addr_str)
        if _is_non_public_ip(ip_res):
            raise ValueError("Target host resolves to a non-public IP address")

    return parsed.geturl()


class _OgHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.in_title = False
        self.title_parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        t = tag.lower()
        if t == "title":
            self.in_title = True
            return
        if t != "meta":
            return
        attr_map = {k.lower(): (v or "") for k, v in attrs if k}
        key = (attr_map.get("property") or attr_map.get("name") or "").strip().lower()
        content = attr_map.get("content", "").strip()
        if key and content and key not in self.meta:
            self.meta[key] = content

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() == "title":
            self.in_title = False

    def handle_data(self, data: str) -> None:
        if self.in_title and len("".join(self.title_parts)) < 400:
            self.title_parts.append(data)


def _oembed_endpoint_for(url: str, video: dict[str, str] | None) -> str:
    if video and video["provider"] == "youtube":
        return f"https://www.youtube.com/oembed?url={quote(video['canonicalUrl'], safe='')}&format=json"
    if video and video["provider"] == "vimeo":
        return f"https://vimeo.com/api/oembed.json?url={quote(video['canonicalUrl'], safe='')}"
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    if host in ("open.spotify.com", "play.spotify.com"):
        return f"https://open.spotify.com/oembed?url={quote(url, safe='')}"
    if host in ("soundcloud.com", "www.soundcloud.com", "m.soundcloud.com"):
        return f"https://soundcloud.com/oembed?format=json&url={quote(url, safe='')}"
    return ""


def _safe_https_image(candidate: str, base_url: str, *, allow_unresolvable_mock: bool) -> str:
    if not candidate:
        return ""
    resolved = urljoin(base_url, str(candidate).strip())
    try:
        return assert_safe_public_https_url(resolved, allow_unresolvable_mock=allow_unresolvable_mock)
    except ValueError:
        return ""


def _read_bounded_html(client: httpx.Client, start_url: str, *, allow_unresolvable_mock: bool) -> tuple[str, str]:
    current = start_url
    headers = {"User-Agent": "LM-Sanctuary/1.0 (+link-preview)", "Accept": "text/html,application/xhtml+xml"}
    for _ in range(4):
        with client.stream("GET", current, headers=headers, follow_redirects=False) as res:
            if res.status_code in (301, 302, 303, 307, 308):
                loc = res.headers.get("location") or ""
                if not loc:
                    break
                nxt = urljoin(current, loc)
                current = assert_safe_public_https_url(nxt, allow_unresolvable_mock=allow_unresolvable_mock)
                continue
            if res.status_code >= 400:
                return "", current
            ctype = (res.headers.get("content-type") or "").lower()
            if ctype and "html" not in ctype and "xhtml" not in ctype:
                return "", current
            chunks: list[bytes] = []
            total = 0
            for chunk in res.iter_bytes():
                chunks.append(chunk)
                total += len(chunk)
                if total >= _MAX_HTML_BYTES:
                    break
            raw_bytes = b"".join(chunks)[:_MAX_HTML_BYTES]
            return raw_bytes.decode("utf-8", errors="replace"), current
    return "", current


def fetch_link_preview(url: str, *, http_client: httpx.Client | None = None) -> dict[str, Any] | None:
    """Resolve OpenGraph / oEmbed / video metadata for a public https:// URL."""
    allow_mock = http_client is not None
    clean_url = assert_safe_public_https_url(url, allow_unresolvable_mock=allow_mock)
    now = time.time()

    if http_client is None:
        with _cache_lock:
            hit = _preview_cache.get(clean_url)
            if hit and hit[0] > now:
                return dict(hit[1]) if hit[1] else None

    video = parse_video_embed(clean_url)
    host = (urlparse(clean_url).hostname or "").removeprefix("www.")
    oembed_url = _oembed_endpoint_for(clean_url, video)

    title = ""
    description = ""
    image = _safe_https_image(video["thumbnailUrl"] if video else "", clean_url, allow_unresolvable_mock=allow_mock)
    site_name = host
    author_name = ""

    own_client = http_client is None
    client = http_client or httpx.Client(timeout=6.0)
    try:
        if oembed_url:
            try:
                assert_safe_public_https_url(oembed_url, allow_unresolvable_mock=allow_mock)
                ores = client.get(oembed_url, follow_redirects=False)
                if ores.status_code < 400:
                    odata = ores.json()
                    if isinstance(odata, dict):
                        title = str(odata.get("title") or "").strip()
                        author_name = str(odata.get("author_name") or "").strip()
                        site_name = str(odata.get("provider_name") or site_name).strip()
                        thumb = str(odata.get("thumbnail_url") or "").strip()
                        safe_thumb = _safe_https_image(thumb, clean_url, allow_unresolvable_mock=allow_mock)
                        if safe_thumb:
                            image = safe_thumb
                        if author_name and not description:
                            description = author_name
            except Exception:
                pass

        if not title:
            try:
                html_text, final_url = _read_bounded_html(client, clean_url, allow_unresolvable_mock=allow_mock)
                if html_text:
                    parser = _OgHtmlParser()
                    parser.feed(html_text)
                    meta = parser.meta
                    title = (
                        meta.get("og:title")
                        or meta.get("twitter:title")
                        or "".join(parser.title_parts).strip()
                    )[:240]
                    description = (
                        meta.get("og:description")
                        or meta.get("twitter:description")
                        or meta.get("description")
                        or ""
                    )[:360]
                    site_name = (meta.get("og:site_name") or site_name)[:80]
                    cand_img = meta.get("og:image") or meta.get("twitter:image") or ""
                    safe_img = _safe_https_image(cand_img, final_url, allow_unresolvable_mock=allow_mock)
                    if safe_img:
                        image = safe_img
            except Exception:
                pass
    finally:
        if own_client:
            client.close()

    if not title and video:
        title = f"{video['provider'].title()} Video"
    if not title:
        title = host or clean_url

    card = {
        "url": clean_url,
        "title": title,
        "description": description,
        "image": image,
        "siteName": site_name,
        "provider": video["provider"] if video else "",
        "embedUrl": video["embedUrl"] if video else "",
    }

    if http_client is None:
        with _cache_lock:
            if len(_preview_cache) >= _CACHE_MAX_ENTRIES:
                _preview_cache.pop(next(iter(_preview_cache)), None)
            _preview_cache[clean_url] = (now + _CACHE_TTL_SEC, card)

    return card


def fetch_public_image_bytes(url: str, *, http_client: httpx.Client | None = None) -> tuple[bytes, str] | None:
    """Safely fetch bounded thumbnail image bytes for external link cards."""
    allow_mock = http_client is not None
    try:
        current = assert_safe_public_https_url(url, allow_unresolvable_mock=allow_mock)
    except ValueError:
        return None

    own_client = http_client is None
    client = http_client or httpx.Client(timeout=6.0)
    try:
        for _ in range(3):
            with client.stream("GET", current, follow_redirects=False) as res:
                if res.status_code in (301, 302, 303, 307, 308):
                    loc = res.headers.get("location") or ""
                    if not loc:
                        return None
                    current = assert_safe_public_https_url(
                        urljoin(current, loc),
                        allow_unresolvable_mock=allow_mock,
                    )
                    continue
                if res.status_code >= 400:
                    return None
                ctype = (res.headers.get("content-type") or "image/jpeg").split(";")[0].strip().lower()
                if not ctype.startswith("image/"):
                    return None
                chunks: list[bytes] = []
                total = 0
                for chunk in res.iter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total > _MAX_IMAGE_BYTES:
                        return None
                raw = b"".join(chunks)
                return (raw, ctype) if raw else None
    except Exception:
        return None
    finally:
        if own_client:
            client.close()
    return None
