"""API for encrypted server-side social post drafts."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from utils import social_vault

social_drafts_bp = Blueprint("social_drafts", __name__, url_prefix="/api/social/drafts")


@social_drafts_bp.route("", methods=["GET"])
def list_drafts():
    return jsonify(social_vault.list_social_drafts())


@social_drafts_bp.route("/<draft_id>", methods=["PUT", "DELETE"])
def draft(draft_id: str):
    if request.method == "DELETE":
        try:
            social_vault.delete_social_draft(draft_id)
        except social_vault.InvalidSocialDraft as exc:
            return jsonify({"error": str(exc)}), 400
        return "", 204

    if request.content_length and request.content_length > social_vault.MAX_SOCIAL_DRAFT_BYTES + 1024:
        return jsonify({"error": "Draft exceeds the 48 MiB server limit"}), 413
    data = request.get_json(silent=True) or {}
    try:
        saved = social_vault.save_social_draft(draft_id, data.get("draft"))
    except social_vault.DeletedSocialDraft as exc:
        return jsonify({"error": str(exc)}), 409
    except social_vault.InvalidSocialDraft as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify({"draft": saved})
