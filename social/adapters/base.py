"""Abstract SocialAdapter contract shared across Mastodon, Bluesky, and Threads."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class SocialAdapter(ABC):
    """Symmetric protocol adapter producing canonical UnifiedItem payloads."""

    protocol: str = ""

    @abstractmethod
    def publish(self, draft: str, media: list[dict[str, Any]] | None = None, options: dict[str, Any] | None = None) -> dict[str, Any]:
        """Publish a post and return a UnifiedItem."""

    @abstractmethod
    def delete(self, native_meta: dict[str, Any]) -> bool:
        """Delete a post identified by native protocol metadata."""

    @abstractmethod
    def reply(self, target_item: dict[str, Any], draft: str, media: list[dict[str, Any]] | None = None, options: dict[str, Any] | None = None) -> dict[str, Any]:
        """Publish a reply to target_item and return the new UnifiedItem."""

    @abstractmethod
    def like(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        """Favourite/like or unlike target_item and return the updated UnifiedItem."""

    @abstractmethod
    def repost(self, target_item: dict[str, Any], undo: bool = False) -> dict[str, Any]:
        """Boost/repost or undo repost on target_item and return the updated UnifiedItem."""

    @abstractmethod
    def fetch_timeline(self, stream: str = "home", cursor: str = "", limit: int = 20, **kwargs: Any) -> dict[str, Any]:
        """Fetch timeline items as { 'items': UnifiedItem[], 'next_cursor': str | None }."""

    @abstractmethod
    def fetch_notifications(self, cursor: str = "", limit: int = 30) -> list[dict[str, Any]]:
        """Fetch notifications normalized to UnifiedItem[]."""
