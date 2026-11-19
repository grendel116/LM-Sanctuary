"""Background Mastodon WebSocket streaming client (wss://<instance>/api/v1/streaming)."""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any, Callable
from urllib.parse import urlparse

import aiohttp

from social.core.schema.unified_item import (
    normalize_instance_url,
    normalize_mastodon_notification,
    normalize_mastodon_status,
)


class MastodonStreamWorker:
    """Connects to wss://<instance>/api/v1/streaming?stream=user and emits normalized events."""

    def __init__(
        self,
        *,
        instance_url: str,
        access_token: str,
        on_update: Callable[[dict[str, Any]], None],
        on_delete: Callable[[str], None],
        on_notification: Callable[[dict[str, Any]], None],
    ) -> None:
        self.instance_url = normalize_instance_url(instance_url)
        self.access_token = access_token
        self.on_update = on_update
        self.on_delete = on_delete
        self.on_notification = on_notification
        self._stop_event = threading.Event()
        self._thread: threading.Thread | None = None

    def _ws_url(self) -> str:
        parsed = urlparse(self.instance_url)
        scheme = "wss" if parsed.scheme == "https" else "ws"
        return f"{scheme}://{parsed.netloc}/api/v1/streaming?stream=user"

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run_loop, name="MastodonStreamWorker", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop_event.set()

    def _dispatch_message(self, raw_text: str) -> None:
        msg = json.loads(raw_text)
        event = msg.get("event")
        payload_raw = msg.get("payload")
        if event in ("update", "status.update") and payload_raw:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
            self.on_update(normalize_mastodon_status(payload, self.instance_url))
        elif event == "notification" and payload_raw:
            payload = json.loads(payload_raw) if isinstance(payload_raw, str) else payload_raw
            self.on_notification(normalize_mastodon_notification(payload, self.instance_url))
        elif event == "delete" and payload_raw is not None:
            self.on_delete(str(payload_raw))

    async def _connect_once(self) -> None:
        url = self._ws_url()
        headers = {"Authorization": f"Bearer {self.access_token}"}
        async with aiohttp.ClientSession(headers=headers) as session:
            async with session.ws_connect(url, heartbeat=30.0) as ws:
                while not self._stop_event.is_set():
                    try:
                        msg = await asyncio.wait_for(ws.receive(), timeout=5.0)
                    except asyncio.TimeoutError:
                        continue
                    if msg.type == aiohttp.WSMsgType.TEXT:
                        try:
                            self._dispatch_message(msg.data)
                        except Exception:
                            pass
                    elif msg.type in (aiohttp.WSMsgType.CLOSED, aiohttp.WSMsgType.ERROR):
                        break

    def _run_loop(self) -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        backoff = 2.0
        try:
            while not self._stop_event.is_set():
                try:
                    loop.run_until_complete(self._connect_once())
                    backoff = 2.0
                except Exception:
                    backoff = min(backoff * 2.0, 60.0)
                if self._stop_event.wait(backoff):
                    break
        finally:
            loop.close()
