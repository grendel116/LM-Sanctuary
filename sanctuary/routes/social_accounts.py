"""API for the server-side encrypted social-account vault."""

from __future__ import annotations

import json
import os
import threading

from flask import Blueprint, jsonify, request

import variables.settings as vs
from utils.social_vault import InvalidSocialAccount
from utils import social_vault

social_accounts_bp = Blueprint("social_accounts", __name__, url_prefix="/api/social/accounts")
_FILTER_LOCK = threading.RLock()


def _keyword_filters_path() -> str:
    return os.path.join(vs.VARIABLES_DIR, "keyword_filters.json")


def _normalize_filter_entries(raw_items) -> list[dict]:
    if not isinstance(raw_items, list):
        return []
    cleaned: list[dict] = []
    seen: set[str] = set()
    for raw in raw_items[:200]:
        if not isinstance(raw, dict):
            continue
        raw_kws = raw.get("keywords")
        kws = [
            str(k if isinstance(k, str) else (k.get("keyword") if isinstance(k, dict) else "")).strip()[:120]
            for k in (raw_kws if isinstance(raw_kws, list) else [])
        ]
        kws = [k for k in kws if k]
        phrase = str(raw.get("phrase") or (kws[0] if kws else "") or raw.get("title") or "").strip()[:120]
        if not phrase and not kws:
            continue
        title = str(raw.get("title") or phrase or (kws[0] if kws else "")).strip()[:120]
        action = "warn" if str(raw.get("filter_action") or "").strip().lower() == "warn" else "hide"
        fid = str(raw.get("id") or f"local_{phrase or title}").strip()[:120]
        dedupe_terms = "|".join(sorted({k.lower() for k in kws})) if len(kws) > 1 else phrase.lower()
        dedupe_key = f"{dedupe_terms}:{action}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)
        entry = {
            "id": fid,
            "title": title,
            "phrase": phrase,
            "filter_action": action,
        }
        if kws:
            entry["keywords"] = kws
        if raw.get("mastodon_filter_id"):
            entry["mastodon_filter_id"] = str(raw["mastodon_filter_id"]).strip()[:120]
        cleaned.append(entry)
    return cleaned


def _load_keyword_filters() -> list[dict]:
    path = _keyword_filters_path()
    with _FILTER_LOCK:
        if not os.path.exists(path):
            return []
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return _normalize_filter_entries(data)
        except Exception:
            return []


def _save_keyword_filters(raw_items) -> list[dict]:
    path = _keyword_filters_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cleaned = _normalize_filter_entries(raw_items)
    with _FILTER_LOCK:
        tmp_path = f"{path}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(cleaned, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
    return cleaned


@social_accounts_bp.route("", methods=["GET"])
def list_accounts():
    return jsonify({"accounts": social_vault.list_social_accounts()})


@social_accounts_bp.route("/filters", methods=["GET", "PUT"])
def keyword_filters():
    if request.method == "GET":
        return jsonify({"filters": _load_keyword_filters()})
    data = request.get_json(silent=True) or {}
    raw_filters = data.get("filters") if isinstance(data, dict) else None
    if not isinstance(raw_filters, list):
        return jsonify({"error": "filters list is required"}), 400
    saved = _save_keyword_filters(raw_filters)
    return jsonify({"filters": saved})


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
