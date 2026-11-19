"""Unified social item schema, HTML sanitization, and bridged actor deduplication."""

from .unified_item import (
    ORIGIN_PROTOCOLS,
    canonicalize_actor_handle,
    deduplicate_unified_items,
    is_allowed_social_url,
    normalize_bluesky_notification,
    normalize_bluesky_post,
    normalize_instance_url,
    normalize_mastodon_account,
    normalize_mastodon_notification,
    normalize_mastodon_status,
    normalize_threads_post,
    normalize_threads_reply_notification,
    parse_iso_ts,
    plain_text_to_html,
    sanitize_social_html,
    strip_html_to_text,
)

__all__ = [
    "ORIGIN_PROTOCOLS",
    "canonicalize_actor_handle",
    "deduplicate_unified_items",
    "is_allowed_social_url",
    "normalize_bluesky_notification",
    "normalize_bluesky_post",
    "normalize_instance_url",
    "normalize_mastodon_account",
    "normalize_mastodon_notification",
    "normalize_mastodon_status",
    "normalize_threads_post",
    "normalize_threads_reply_notification",
    "parse_iso_ts",
    "plain_text_to_html",
    "sanitize_social_html",
    "strip_html_to_text",
]
