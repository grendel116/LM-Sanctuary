"""API for encrypted server-side cross-post ID mappings."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from utils import social_vault

social_linked_posts_bp = Blueprint(
    "social_linked_posts",
    __name__,
    url_prefix="/api/social/linked-posts",
)


@social_linked_posts_bp.errorhandler(social_vault.VaultLockedError)
def _handle_vault_locked(exc):
    return jsonify({"error": str(exc), "locked": True, "vault": "keepassxc"}), 503


@social_linked_posts_bp.route("", methods=["GET"])
def list_linked_posts():
    return jsonify(social_vault.list_social_linked_posts())


@social_linked_posts_bp.route("/<canonical_id>", methods=["PUT", "DELETE"])
def linked_post(canonical_id: str):
    if request.method == "DELETE":
        try:
            social_vault.delete_social_linked_post(canonical_id)
        except social_vault.InvalidSocialLinkedPost as exc:
            return jsonify({"error": str(exc)}), 400
        return "", 204

    if request.content_length and request.content_length > social_vault.MAX_SOCIAL_LINKED_POST_BYTES + 1024:
        return jsonify({"error": "Linked-post record exceeds the 64 KiB limit"}), 413
    data = request.get_json(silent=True) or {}
    record = data.get("record") if isinstance(data, dict) else None
    if not isinstance(record, dict) or str(record.get("canonicalId") or "").strip() != canonical_id:
        return jsonify({"error": "Canonical ID must match the requested ID"}), 400
    try:
        saved = social_vault.save_social_linked_post(record)
    except social_vault.DeletedSocialLinkedPost as exc:
        return jsonify({"error": str(exc)}), 409
    except social_vault.InvalidSocialLinkedPost as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"record": saved})
