"""Flask Blueprint exposing /api/social/* for local SQLite + OS Keychain social & bridge workflows."""

from __future__ import annotations

import json
import os
import queue
import webbrowser
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from flask import Blueprint, Response, jsonify, request

from social.adapters.bluesky.adapter import PUBLIC_BSKY_API, BlueskyAdapter
from social.core.schema.unified_item import deduplicate_unified_items, normalize_instance_url
from social.sync_engine import SocialSyncEngine

social_bp = Blueprint("social", __name__, url_prefix="/api/social")

_engine: SocialSyncEngine | None = None


def get_social_engine() -> SocialSyncEngine:
    global _engine
    if _engine is None:
        enable_stream = os.getenv("SANCTUARY_SKIP_PREWARM", "").lower() != "true"
        _engine = SocialSyncEngine(enable_streaming=enable_stream)
    return _engine


def set_social_engine_for_tests(engine: SocialSyncEngine | None) -> None:
    global _engine
    if _engine is not None:
        _engine.stop_streaming()
    _engine = engine


def _err(exc: Exception, status: int = 400):
    return jsonify({"error": str(exc)}), status


@social_bp.route("/status", methods=["GET"])
def social_status():
    return jsonify(get_social_engine().status())


@social_bp.route("/oauth/mastodon/start", methods=["POST"])
def mastodon_oauth_start():
    data = request.get_json(silent=True) or {}
    try:
        res = get_social_engine().start_mastodon_oauth(
            instance_url=data.get("instanceUrl") or "https://mastodon.social",
            redirect_uri=data.get("redirectUri") or "urn:ietf:wg:oauth:2.0:oob",
        )
        return jsonify(res)
    except Exception as exc:
        return _err(exc)


@social_bp.route("/oauth/mastodon/callback", methods=["POST"])
def mastodon_oauth_callback():
    data = request.get_json(silent=True) or {}
    try:
        res = get_social_engine().finish_mastodon_oauth(
            instance_url=data.get("instanceUrl") or "https://mastodon.social",
            code=data.get("code") or "",
            redirect_uri=data.get("redirectUri") or "",
        )
        return jsonify(res)
    except Exception as exc:
        return _err(exc)


@social_bp.route("/accounts/connect", methods=["POST"])
def social_connect():
    data = request.get_json(silent=True) or {}
    protocol = str(data.get("protocol") or data.get("platform") or "").lower()
    eng = get_social_engine()
    try:
        if protocol in ("mastodon", "fediverse"):
            return jsonify(eng.connect_mastodon_token(data.get("instanceUrl") or "https://mastodon.social", data.get("accessToken") or ""))
        if protocol == "bluesky":
            return jsonify(eng.connect_bluesky(data.get("identifier") or "", data.get("password") or "", service_url=data.get("serviceUrl") or "https://bsky.social"))
        if protocol == "threads":
            return jsonify(eng.connect_threads(data.get("accessToken") or ""))
        return jsonify({"error": f"Unsupported protocol: {protocol}"}), 400
    except Exception as exc:
        return _err(exc)


@social_bp.route("/accounts/<path:account_id>", methods=["DELETE"])
def social_disconnect(account_id: str):
    return jsonify(get_social_engine().disconnect_account(account_id))


def _opt_form_bool(form, key: str) -> bool | None:
    return (form.get(key) == "true") if key in form else None


@social_bp.route("/profile", methods=["GET", "PATCH"])
def social_profile():
    eng = get_social_engine()
    if request.method == "GET":
        masto = eng.get_mastodon_adapter()
        if not masto:
            return jsonify({"profile": eng.status().get("primaryProfile"), "connected": False})
        try:
            prof = masto.verify_credentials()
            eng._on_profile_sync({**prof, "instance_url": masto.instance_url})
            return jsonify({"profile": prof, "connected": True})
        except Exception as exc:
            return _err(exc, 502)

    try:
        if request.content_type and "multipart/form-data" in request.content_type:
            form = request.form
            fields = json.loads(form.get("fields_json")) if form.get("fields_json") else None
            attribution_domains = (
                form.getlist("attribution_domains[]")
                if "attribution_domains[]" in form
                else (json.loads(form.get("attribution_domains_json") or "[]") if "attribution_domains_json" in form else None)
            )
            avatar_f = request.files.get("avatar")
            header_f = request.files.get("header")
            updated = eng.update_mastodon_profile(
                display_name=form.get("display_name"),
                note=form.get("note"),
                locked=_opt_form_bool(form, "locked"),
                bot=_opt_form_bool(form, "bot"),
                discoverable=_opt_form_bool(form, "discoverable"),
                indexable=_opt_form_bool(form, "indexable"),
                hide_collections=_opt_form_bool(form, "hide_collections"),
                default_visibility=form.get("default_visibility"),
                default_sensitive=_opt_form_bool(form, "default_sensitive"),
                default_language=form.get("default_language"),
                fields=fields,
                attribution_domains=attribution_domains,
                avatar_bytes=(avatar_f.filename or "avatar.png", avatar_f.read(), avatar_f.mimetype or "image/png") if avatar_f else None,
                header_bytes=(header_f.filename or "header.png", header_f.read(), header_f.mimetype or "image/png") if header_f else None,
                remove_avatar=form.get("remove_avatar") == "true",
                remove_header=form.get("remove_header") == "true",
            )
        else:
            data = request.get_json(silent=True) or {}
            updated = eng.update_mastodon_profile(
                display_name=data.get("display_name"),
                note=data.get("note"),
                locked=data.get("locked"),
                bot=data.get("bot"),
                discoverable=data.get("discoverable"),
                indexable=data.get("indexable"),
                hide_collections=data.get("hide_collections"),
                default_visibility=data.get("default_visibility"),
                default_sensitive=data.get("default_sensitive"),
                default_language=data.get("default_language"),
                fields=data.get("fields"),
                attribution_domains=data.get("attribution_domains"),
                remove_avatar=bool(data.get("remove_avatar", False)),
                remove_header=bool(data.get("remove_header", False)),
            )
        return jsonify({"profile": updated, "status": eng.status()})
    except Exception as exc:
        return _err(exc)


def _resolve_masto_author_context(eng: SocialSyncEngine, instance: str, account_id: str, acct: str):
    remote_origin = normalize_instance_url(instance or "https://mastodon.social")
    masto = eng.get_mastodon_adapter()
    if masto and (masto.instance_url == remote_origin or not acct):
        return masto, account_id
    if masto and acct:
        resolved = masto.lookup_account(acct)
        if resolved and resolved.get("id"):
            return masto, str(resolved["id"])
    return eng._masto_factory(remote_origin, ""), account_id


@social_bp.route("/accounts/<account_id>/profile", methods=["GET"])
def social_author_profile(account_id: str):
    eng = get_social_engine()
    instance = request.args.get("instanceUrl") or "https://mastodon.social"
    acct = request.args.get("acct") or ""
    protocol = (request.args.get("protocol") or ("bluesky" if account_id.startswith("did:") else "mastodon")).lower()
    try:
        if protocol == "bluesky":
            bsky = eng.get_bluesky_adapter() or BlueskyAdapter(service_url=PUBLIC_BSKY_API)
            return jsonify(bsky.fetch_actor_profile(account_id or acct))
        adapter, target_id = _resolve_masto_author_context(eng, instance, account_id, acct)
        profile = adapter.fetch_account_profile(target_id)
        rels = adapter.get_relationships([target_id]) if adapter.access_token else []
        return jsonify({"profile": profile, "relationship": rels[0] if rels else None, "resolvedInstanceUrl": adapter.instance_url})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/accounts/<account_id>/statuses", methods=["GET"])
def social_account_statuses(account_id: str):
    eng = get_social_engine()
    instance = request.args.get("instanceUrl") or "https://mastodon.social"
    acct = request.args.get("acct") or ""
    tab = request.args.get("tab") or "posts"
    max_id = request.args.get("max_id") or ""
    protocol = (request.args.get("protocol") or ("bluesky" if account_id.startswith("did:") else "mastodon")).lower()
    try:
        if protocol == "bluesky":
            bsky = eng.get_bluesky_adapter() or BlueskyAdapter(service_url=PUBLIC_BSKY_API)
            items = bsky.fetch_author_feed(account_id or acct, tab=tab, cursor=max_id)
            return jsonify({"items": items})
        adapter, target_id = _resolve_masto_author_context(eng, instance, account_id, acct)
        items = adapter.fetch_account_statuses(target_id, tab=tab, max_id=max_id)
        for it in items:
            linked = eng.store.find_linked_post(it["id"])
            if linked:
                it["_meta"]["linkedIds"] = {
                    k: v
                    for k, v in {
                        "mastodonStatusId": linked.get("mastodonStatusId"),
                        "blueskyUri": linked.get("blueskyUri"),
                        "blueskyCid": linked.get("blueskyCid"),
                        "threadsPostId": linked.get("threadsPostId"),
                    }.items()
                    if v
                }
        return jsonify({"items": items})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/accounts/<account_id>/<action>", methods=["POST"])
def social_account_graph_action(account_id: str, action: str):
    eng = get_social_engine()
    body = request.get_json(silent=True) or {}
    protocol = str(body.get("protocol") or ("bluesky" if account_id.startswith("did:") else "mastodon")).lower()
    try:
        if protocol == "bluesky":
            bsky = eng.get_bluesky_adapter()
            if not bsky:
                return jsonify({"error": "Connect Bluesky bridge first"}), 401
            if action in ("follow", "unfollow"):
                return jsonify(bsky.follow_actor(account_id, follow_uri=body.get("followUri"), undo=(action == "unfollow")))
            if action in ("mute", "unmute"):
                return jsonify(bsky.mute_actor(account_id, undo=(action == "unmute")))
            if action in ("block", "unblock"):
                return jsonify(bsky.block_actor(account_id, block_uri=body.get("blockUri"), undo=(action == "unblock")))
            return jsonify({"error": "Unsupported action"}), 400

        masto = eng.get_mastodon_adapter()
        if not masto:
            return jsonify({"error": "Connect Mastodon first"}), 401
        if action == "follow":
            return jsonify(masto.follow_account(account_id, undo=False))
        if action == "unfollow":
            return jsonify(masto.follow_account(account_id, undo=True))
        if action == "mute":
            return jsonify(masto.mute_account(account_id, undo=False))
        if action == "unmute":
            return jsonify(masto.mute_account(account_id, undo=True))
        if action == "block":
            return jsonify(masto.block_account(account_id, undo=False))
        if action == "unblock":
            return jsonify(masto.block_account(account_id, undo=True))
        return jsonify({"error": "Unsupported action"}), 400
    except Exception as exc:
        return _err(exc)


@social_bp.route("/accounts/<account_id>/connections", methods=["GET"])
def social_account_connections(account_id: str):
    eng = get_social_engine()
    kind = (request.args.get("kind") or "following").lower()
    instance = request.args.get("instanceUrl") or "https://mastodon.social"
    acct = request.args.get("acct") or ""
    cursor = request.args.get("cursor") or ""
    protocol = (request.args.get("protocol") or ("bluesky" if account_id.startswith("did:") else "mastodon")).lower()
    try:
        if kind == "requests":
            masto = eng.get_mastodon_adapter()
            if not masto:
                return jsonify({"accounts": [], "next_cursor": None})
            return jsonify({"accounts": masto.list_follow_requests(), "next_cursor": None})
        if protocol == "bluesky":
            bsky = eng.get_bluesky_adapter() or BlueskyAdapter(service_url=PUBLIC_BSKY_API)
            actor = account_id or acct
            if kind == "followers":
                return jsonify(bsky.list_followers(actor, cursor=cursor))
            return jsonify(bsky.list_follows(actor, cursor=cursor))
        adapter, target_id = _resolve_masto_author_context(eng, instance, account_id, acct)
        if kind == "followers":
            return jsonify(adapter.list_followers(target_id, max_id=cursor))
        return jsonify(adapter.list_following(target_id, max_id=cursor))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/accounts/<account_id>/remove-follower", methods=["POST"])
def social_remove_follower(account_id: str):
    masto = get_social_engine().get_mastodon_adapter()
    if not masto:
        return jsonify({"error": "Connect Mastodon first"}), 401
    try:
        return jsonify(masto.remove_follower(account_id))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/follow-requests/<account_id>", methods=["POST"])
def social_respond_follow_request(account_id: str):
    masto = get_social_engine().get_mastodon_adapter()
    if not masto:
        return jsonify({"error": "Connect Mastodon first"}), 401
    data = request.get_json(silent=True) or {}
    accept = bool(data.get("accept", True))
    try:
        return jsonify(masto.respond_follow_request(account_id, accept=accept))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/timelines", methods=["GET"])
def social_timelines():
    stream = request.args.get("stream") or "home"
    cursor = request.args.get("cursor") or ""
    list_id = request.args.get("list_id") or ""
    limit = min(int(request.args.get("limit") or 20), 40)
    try:
        return jsonify(get_social_engine().fetch_timeline(stream=stream, cursor=cursor, list_id=list_id, limit=limit))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/posts", methods=["POST"])
def social_publish_post():
    eng = get_social_engine()
    try:
        media_list: list[dict[str, Any]] = []
        if request.content_type and "multipart/form-data" in request.content_type:
            draft = request.form.get("text") or ""
            visibility = request.form.get("visibility") or "public"
            spoiler_text = request.form.get("spoiler_text") or ""
            language = request.form.get("language") or "en"
            thread_items = json.loads(request.form.get("thread_items") or "[]")
            alts = json.loads(request.form.get("alt_texts") or "[]")
            for idx, f in enumerate(request.files.getlist("media")):
                media_list.append({
                    "filename": f.filename or f"upload_{idx}.png",
                    "mime_type": f.mimetype or "image/png",
                    "bytes": f.read(),
                    "alt_text": alts[idx] if idx < len(alts) else "",
                })
        else:
            data = request.get_json(silent=True) or {}
            draft = data.get("text") or ""
            visibility = data.get("visibility") or "public"
            spoiler_text = data.get("spoiler_text") or ""
            language = data.get("language") or "en"
            thread_items = data.get("thread_items") or []

        return jsonify(
            eng.publish_unified(
                draft=draft,
                thread_items=thread_items,
                media=media_list,
                visibility=visibility,
                spoiler_text=spoiler_text,
                language=language,
            )
        )
    except Exception as exc:
        return _err(exc)


@social_bp.route("/posts/<path:post_id>", methods=["PUT", "DELETE"])
def social_modify_post(post_id: str):
    eng = get_social_engine()
    try:
        if request.method == "DELETE":
            return jsonify(eng.delete_unified(post_id))
        data = request.get_json(silent=True) or {}
        return jsonify({"item": eng.edit_unified(post_id, data.get("text") or "", data.get("spoiler_text") or "")})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/posts/reply", methods=["POST"])
def social_reply_post():
    data = request.get_json(silent=True) or {}
    try:
        item = get_social_engine().reply_unified(
            target_item=data.get("targetItem") or {},
            draft=data.get("text") or "",
            options={"visibility": data.get("visibility") or "public"},
        )
        return jsonify({"item": item})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/posts/<action>", methods=["POST"])
def social_post_interaction(action: str):
    data = request.get_json(silent=True) or {}
    eng = get_social_engine()
    try:
        target = data.get("targetItem") or {}
        undo = bool(data.get("undo", False))
        if action == "like":
            return jsonify({"item": eng.like_unified(target, undo=undo)})
        if action == "repost":
            return jsonify({"item": eng.repost_unified(target, undo=undo)})
        if action == "pin":
            sid = data.get("statusId") or (target.get("_meta", {}).get("mastodon") or {}).get("statusId") or ""
            return jsonify({"item": eng.pin_unified(sid, unpin=undo)})
        return jsonify({"error": "Unknown interaction"}), 400
    except Exception as exc:
        return _err(exc)


@social_bp.route("/posts/<path:status_id>/context", methods=["GET"])
def social_post_context(status_id: str):
    eng = get_social_engine()
    protocol = (request.args.get("protocol") or ("bluesky" if status_id.startswith(("at://", "bluesky:")) else "mastodon")).lower()
    try:
        if protocol == "bluesky":
            bsky = eng.get_bluesky_adapter() or BlueskyAdapter(service_url=PUBLIC_BSKY_API)
            return jsonify(bsky.get_post_thread(status_id))
        instance = request.args.get("instanceUrl") or "https://mastodon.social"
        adapter = eng.get_public_mastodon_adapter(instance)
        return jsonify(adapter.get_status_context(status_id))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/notifications", methods=["GET"])
def social_notifications():
    limit = min(int(request.args.get("limit") or 35), 60)
    try:
        return jsonify(get_social_engine().fetch_merged_notifications(limit=limit))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/lists", methods=["GET", "POST"])
def social_lists():
    eng = get_social_engine()
    masto = eng.get_mastodon_adapter()
    if request.method == "GET":
        if not masto:
            return jsonify({"lists": eng.store.list_lists()})
        try:
            lists = masto.list_lists()
            eng.store.replace_lists(lists)
            return jsonify({"lists": lists})
        except Exception as exc:
            return _err(exc)

    if not masto:
        return jsonify({"error": "Connect Mastodon first"}), 401
    data = request.get_json(silent=True) or {}
    try:
        created = masto.create_list(
            title=data.get("title") or "Untitled",
            replies_policy=data.get("replies_policy") or "list",
            exclusive=bool(data.get("exclusive", False)),
        )
        eng.store.replace_lists(masto.list_lists())
        return jsonify({"list": created})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/lists/<list_id>", methods=["PUT", "DELETE"])
def social_list_item(list_id: str):
    eng = get_social_engine()
    masto = eng.get_mastodon_adapter()
    if not masto:
        return jsonify({"error": "Connect Mastodon first"}), 401
    try:
        if request.method == "DELETE":
            masto.delete_list(list_id)
            eng.store.replace_lists(masto.list_lists())
            return jsonify({"deleted": True})
        data = request.get_json(silent=True) or {}
        updated = masto.update_list(
            list_id,
            title=data.get("title") or "Untitled",
            replies_policy=data.get("replies_policy") or "list",
            exclusive=bool(data.get("exclusive", False)),
        )
        eng.store.replace_lists(masto.list_lists())
        return jsonify({"list": updated})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/lists/<list_id>/accounts", methods=["GET", "POST", "DELETE"])
def social_list_accounts(list_id: str):
    masto = get_social_engine().get_mastodon_adapter()
    if not masto:
        return jsonify({"error": "Connect Mastodon first"}), 401
    try:
        if request.method == "GET":
            return jsonify({"accounts": masto.get_list_accounts(list_id)})
        data = request.get_json(silent=True) or {}
        account_ids = data.get("account_ids") or []
        if request.method == "POST":
            masto.add_accounts_to_list(list_id, account_ids)
        else:
            masto.remove_accounts_from_list(list_id, account_ids)
        return jsonify({"ok": True})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/filters", methods=["GET", "POST"])
def social_filters():
    eng = get_social_engine()
    masto = eng.get_mastodon_adapter()
    if request.method == "GET":
        if not masto:
            return jsonify({"filters": eng.store.list_filters()})
        try:
            rules = masto.list_filters()
            eng.store.replace_filters(rules)
            return jsonify({"filters": rules})
        except Exception:
            return jsonify({"filters": eng.store.list_filters()})

    data = request.get_json(silent=True) or {}
    phrase = str(data.get("phrase") or "").strip()
    if not phrase:
        return jsonify({"error": "Keyword phrase is required"}), 400
    try:
        if masto:
            rule = masto.create_filter(
                title=data.get("title") or phrase,
                phrase=phrase,
                context=data.get("context"),
                filter_action=data.get("filter_action") or "hide",
            )
        else:
            rule = {
                "id": f"local_{os.urandom(4).hex()}",
                "title": data.get("title") or phrase,
                "phrase": phrase,
                "context": data.get("context") or ["home", "public"],
                "filter_action": data.get("filter_action") or "hide",
            }
        eng.store.upsert_filter(rule)
        return jsonify({"filter": rule})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/filters/<filter_id>", methods=["DELETE"])
def social_filter_delete(filter_id: str):
    eng = get_social_engine()
    masto = eng.get_mastodon_adapter()
    if masto and not filter_id.startswith("local_"):
        try:
            masto.delete_filter(filter_id)
        except Exception:
            pass
    eng.store.delete_filter(filter_id)
    return jsonify({"deleted": True})


@social_bp.route("/moderation/<kind>", methods=["GET"])
def social_moderation_list(kind: str):
    masto = get_social_engine().get_mastodon_adapter()
    if not masto:
        return jsonify({"accounts": []})
    try:
        if kind == "mutes":
            return jsonify({"accounts": masto.list_mutes()})
        if kind == "blocks":
            return jsonify({"accounts": masto.list_blocks()})
        return jsonify({"error": "Unknown moderation kind"}), 400
    except Exception as exc:
        return _err(exc)


@social_bp.route("/search", methods=["GET"])
def social_search():
    q = request.args.get("q") or ""
    if not q.strip():
        return jsonify({"accounts": [], "statuses": [], "hashtags": []})
    eng = get_social_engine()
    instance = request.args.get("instanceUrl") or "https://mastodon.social"
    adapter = eng.get_public_mastodon_adapter(instance)
    search_type = request.args.get("type") or ""
    try:
        res = adapter.search(q, search_type=search_type, resolve=bool(adapter.access_token))
        if adapter.access_token and res["accounts"]:
            rels = adapter.get_relationships([a["id"] for a in res["accounts"] if a.get("id")])
            rel_by_id = {str(r.get("id")): r for r in rels}
            for acc in res["accounts"]:
                acc["relationship"] = rel_by_id.get(acc["id"])

        bsky = eng.get_bluesky_adapter()
        if bsky:
            if not search_type or search_type == "accounts":
                try:
                    res["accounts"] = [*res.get("accounts", []), *bsky.search_actors(q, limit=12)]
                except Exception:
                    pass
            if not search_type or search_type == "statuses":
                try:
                    bsky_posts = bsky.search_posts(q, limit=12)
                    res["statuses"] = deduplicate_unified_items([*res.get("statuses", []), *bsky_posts])
                except Exception:
                    pass

        return jsonify(res)
    except Exception as exc:
        return _err(exc)


@social_bp.route("/conversations", methods=["GET"])
def social_conversations():
    masto = get_social_engine().get_mastodon_adapter()
    if not masto:
        return jsonify({"conversations": []})
    try:
        return jsonify({"conversations": masto.fetch_conversations()})
    except Exception as exc:
        return _err(exc)


@social_bp.route("/retries/<retry_id>/run", methods=["POST"])
def social_retry_run(retry_id: str):
    try:
        return jsonify(get_social_engine().run_retry(retry_id))
    except Exception as exc:
        return _err(exc)


@social_bp.route("/retries/<retry_id>", methods=["DELETE"])
def social_retry_dismiss(retry_id: str):
    get_social_engine().store.delete_retry(retry_id)
    return jsonify({"deleted": True, "retryQueue": get_social_engine().store.list_retries()})


@social_bp.route("/events", methods=["GET"])
def social_events_stream():
    eng = get_social_engine()
    sub = eng.subscribe_events()

    def gen():
        try:
            yield f"data: {json.dumps({'type': 'ready', 'data': {'connected': True}})}\n\n"
            while True:
                try:
                    ev = sub.get(timeout=20.0)
                    yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        finally:
            eng.unsubscribe_events(sub)

    return Response(gen(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache"})


# ── Local Storage Endpoints (replacing IndexedDB cleanly) ────────────────

@social_bp.route("/storage/kv", methods=["GET", "PUT", "DELETE"])
def social_storage_kv():
    eng = get_social_engine()
    if request.method == "GET":
        store_name = request.args.get("store") or "kv"
        key = request.args.get("key") or ""
        val = eng.store.kv_get(store_name, key)
        return jsonify({"found": val is not None, "value": val})
    if request.method == "PUT":
        data = request.get_json(silent=True) or {}
        store_name = data.get("storeName") or "kv"
        key = data.get("key") or ""
        val = data.get("value")
        eng.store.kv_put(store_name, key, val)
        if store_name == "kv" and key == "social_accounts_meta" and isinstance(val, list):
            keep_ids = {str(a.get("id")) for a in val if isinstance(a, dict) and a.get("id")}
            for existing in eng.store.list_accounts():
                if existing["id"] not in keep_ids:
                    eng.store.delete_account(existing["id"])
            for a in val:
                if not isinstance(a, dict) or not a.get("id"):
                    continue
                proto = "mastodon" if a.get("platform") in ("fediverse", "mastodon") else str(a.get("platform") or "")
                if proto not in ("mastodon", "bluesky", "threads"):
                    continue
                eng.store.upsert_account(
                    account_id=str(a["id"]),
                    protocol=proto,
                    instance_url=str(a.get("instanceUrl") or a.get("serviceUrl") or ""),
                    handle=str(a.get("acct") or a.get("handle") or ""),
                    display_name=str(a.get("displayName") or a.get("handle") or ""),
                    avatar_url=str(a.get("avatar") or ""),
                    is_primary=True,
                    meta=a,
                )
                if proto == "mastodon":
                    eng._on_profile_sync(a)
                    eng._start_streaming_if_enabled()
        return jsonify({"ok": True})
    store_name = request.args.get("store") or "kv"
    key = request.args.get("key") or ""
    eng.store.kv_delete(store_name, key)
    return jsonify({"ok": True})


@social_bp.route("/storage/kv/all", methods=["GET", "DELETE"])
def social_storage_kv_all():
    eng = get_social_engine()
    store_name = request.args.get("store") or "kv"
    if request.method == "GET":
        return jsonify({"entries": eng.store.kv_get_all(store_name)})
    eng.store.kv_clear(store_name)
    return jsonify({"ok": True})


@social_bp.route("/storage/secret", methods=["GET", "PUT", "DELETE"])
def social_storage_secret():
    eng = get_social_engine()
    if request.method == "GET":
        key = request.args.get("key") or ""
        return jsonify({"secret": eng.keychain.get_secret(key) if key else None})
    if request.method == "PUT":
        data = request.get_json(silent=True) or {}
        eng.keychain.set_secret(data.get("key") or "", data.get("secret") or {})
        return jsonify({"ok": True})
    key = request.args.get("key") or ""
    if key:
        eng.keychain.delete_secret(key)
    return jsonify({"ok": True})


@social_bp.route("/storage/secret/ids", methods=["GET"])
def social_storage_secret_ids():
    return jsonify({"ids": get_social_engine().keychain.list_keys()})


@social_bp.route("/open-external", methods=["POST"])
def social_open_external():
    remote = str(request.remote_addr or "")
    if remote not in ("127.0.0.1", "::1", "::ffff:127.0.0.1"):
        return jsonify({"error": "External launch restricted to local desktop host"}), 403
    data = request.get_json(silent=True) or {}
    raw_url = str(data.get("url") or "").strip()
    if not raw_url:
        return jsonify({"error": "Missing url"}), 400
    scheme = urlparse(raw_url).scheme.lower()
    if scheme not in ("https", "http", "mailto"):
        return jsonify({"error": "Unsupported URL scheme"}), 400
    opened = bool(webbrowser.open(raw_url, new=2))
    return jsonify({"opened": opened})
