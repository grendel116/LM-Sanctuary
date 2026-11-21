"""API for the server-side encrypted social-account vault."""

from __future__ import annotations

from flask import Blueprint, jsonify, request

from utils.social_vault import InvalidSocialAccount
from utils import social_vault

social_accounts_bp = Blueprint("social_accounts", __name__, url_prefix="/api/social/accounts")


@social_accounts_bp.route("", methods=["GET"])
def list_accounts():
    return jsonify({"accounts": social_vault.list_social_accounts()})


@social_accounts_bp.route("/<account_id>", methods=["PUT", "DELETE"])
def account(account_id: str):
    if request.method == "DELETE":
        social_vault.delete_social_account(account_id)
        return "", 204

    data = request.get_json(silent=True) or {}
    try:
        saved = social_vault.save_social_account(
            account_id,
            data.get("meta"),
            data.get("secrets"),
        )
    except InvalidSocialAccount as exc:
        return jsonify({"error": str(exc)}), 400
    return jsonify(saved)
