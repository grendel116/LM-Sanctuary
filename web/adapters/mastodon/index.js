import { SocialAdapter } from '../base.js';
import { normalizeInstanceUrl } from '../../constants/endpoints.js';
import { plainTextToHtml, toUnifiedItem } from '../../core/schema/unifiedItem.js';
import {
  clearMastodonNotifications,
  deleteStatus,
  dismissMastodonNotification,
  editStatus,
  getNotifications,
  getRelationships,
  getTimeline,
  pinStatus,
  publishStatus,
  searchFediverse,
  toggleFavourite,
  toggleReblog,
  uploadMedia,
} from '../../queries/fediverse.js';

export class MastodonAdapter extends SocialAdapter {
  protocol = 'mastodon';

  constructor({ instanceUrl = 'https://mastodon.social', accessToken = '', fetchImpl } = {}) {
    super();
    this.instanceUrl = instanceUrl;
    this.accessToken = accessToken;
    this.fetchImpl = fetchImpl;
  }

  async publish(draft, media = [], options = {}) {
    const mediaIds = Array.isArray(options.mediaIds) ? [...options.mediaIds] : [];
    const uploadedUrls = [];
    for (const att of media) {
      if (att.id) {
        mediaIds.push(att.id);
        if (att.url) uploadedUrls.push(att.url);
      } else if (att.blob || att.file) {
        const up = await uploadMedia({
          instanceUrl: this.instanceUrl,
          accessToken: this.accessToken,
          file: att.file || att.blob,
          description: att.altText || '',
          fetchImpl: this.fetchImpl,
        });
        if (up.id) mediaIds.push(up.id);
        if (up.url) uploadedUrls.push(up.url);
      }
    }

    const res = await publishStatus({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      status: draft,
      spoilerText: options.spoilerText || '',
      sensitive: Boolean(options.sensitive),
      visibility: options.visibility || 'public',
      mediaIds,
      inReplyToId: options.inReplyToId || null,
      language: options.language || '',
      idempotencyKey: options.idempotencyKey || '',
      fetchImpl: this.fetchImpl,
    });
    const item = toUnifiedItem(res);
    item._uploadedMediaUrls = uploadedUrls;
    return item;
  }

  async delete(nativeMeta = {}) {
    const statusId = nativeMeta.statusId || nativeMeta.mastodonStatusId;
    if (!statusId) return false;
    return deleteStatus({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      statusId,
      fetchImpl: this.fetchImpl,
    });
  }

  async _resolveLocalStatusId(item) {
    let statusId = item._meta?.mastodon?.statusId || String(item.id || '').replace(/^mastodon:/, '');
    const homeOrigin = normalizeInstanceUrl(this.instanceUrl);
    const itemOrigin = item._meta?.mastodon?.instanceUrl
      ? normalizeInstanceUrl(item._meta.mastodon.instanceUrl)
      : homeOrigin;
    if (itemOrigin !== homeOrigin && item.url) {
      const searchRes = await searchFediverse({
        instanceUrl: homeOrigin,
        accessToken: this.accessToken,
        query: item.url,
        type: 'statuses',
        resolve: true,
        limit: 1,
        fetchImpl: this.fetchImpl,
      }).catch(() => null);
      if (searchRes?.statuses?.[0]?.id) {
        statusId = searchRes.statuses[0].id;
      }
    }
    return statusId;
  }

  _preservePostIdentity(item, updated, fallbackStatusId = '') {
    const normalized = toUnifiedItem(updated);
    const prevMasto = item._meta?.mastodon || {};
    const { metricsBreakdown: _omitBd, ...restPrevMeta } = item._meta || {};
    const nextMasto = {
      ...(normalized._meta?.mastodon || {}),
      statusId: prevMasto.statusId || normalized._meta?.mastodon?.statusId || fallbackStatusId,
      instanceUrl: prevMasto.instanceUrl || normalized._meta?.mastodon?.instanceUrl || this.instanceUrl,
      ...(prevMasto.wrapperId ? { wrapperId: prevMasto.wrapperId } : {}),
    };
    if (prevMasto.rebloggedBy) {
      nextMasto.rebloggedBy = prevMasto.rebloggedBy;
    } else {
      delete nextMasto.rebloggedBy;
    }
    return {
      ...normalized,
      id: item.id || normalized.id,
      date_published: item.date_published || normalized.date_published,
      _meta: {
        ...restPrevMeta,
        ...(normalized._meta || {}),
        mastodon: nextMasto,
      },
    };
  }

  async reply(targetItem, draft, media = [], options = {}) {
    const item = toUnifiedItem(targetItem);
    const statusId = await this._resolveLocalStatusId(item);
    return this.publish(draft, media, {
      visibility: item._meta?.mastodon?.visibility || 'public',
      ...options,
      inReplyToId: statusId,
    });
  }

  async like(targetItem, undo = false) {
    const item = toUnifiedItem(targetItem);
    const prevLikes = Number(item._meta?.metricsBreakdown?.mastodon?.likes ?? item.metrics?.likes ?? 0);
    const wasLiked = Boolean(item._meta?.mastodon?.favourited);
    const statusId = await this._resolveLocalStatusId(item);
    const updated = await toggleFavourite({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      statusId,
      favourited: undo,
      fetchImpl: this.fetchImpl,
    });
    const preserved = this._preservePostIdentity(item, updated, statusId);
    const serverLikes = Number(preserved.metrics?.likes || 0);
    const nextLikes = undo
      ? (wasLiked ? Math.max(0, prevLikes - 1) : prevLikes)
      : Math.max(1, wasLiked ? prevLikes : prevLikes + 1, serverLikes);
    return {
      ...preserved,
      metrics: { ...preserved.metrics, likes: nextLikes },
    };
  }

  async repost(targetItem, undo = false) {
    const item = toUnifiedItem(targetItem);
    const prevReposts = Number(item._meta?.metricsBreakdown?.mastodon?.reposts ?? item.metrics?.reposts ?? 0);
    const wasReposted = Boolean(item._meta?.mastodon?.reblogged);
    const statusId = await this._resolveLocalStatusId(item);
    const updated = await toggleReblog({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      statusId,
      reblogged: undo,
      fetchImpl: this.fetchImpl,
    });
    const preserved = this._preservePostIdentity(item, updated, statusId);
    const serverReposts = Number(preserved.metrics?.reposts || 0);
    const nextReposts = undo
      ? (wasReposted ? Math.max(0, prevReposts - 1) : prevReposts)
      : Math.max(1, wasReposted ? prevReposts : prevReposts + 1, serverReposts);
    return {
      ...preserved,
      metrics: { ...preserved.metrics, reposts: nextReposts },
    };
  }

  async edit(statusId, draft, spoilerText = '') {
    const updated = await editStatus({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      statusId,
      status: draft,
      spoilerText,
      fetchImpl: this.fetchImpl,
    });
    return toUnifiedItem(updated);
  }

  async pin(statusId, undo = false) {
    const updated = await pinStatus({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      statusId,
      pinned: undo,
      fetchImpl: this.fetchImpl,
    });
    return toUnifiedItem(updated);
  }

  async fetchTimeline(stream = 'home', cursor = '', limit = 20, { listId = '' } = {}) {
    const res = await getTimeline({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      stream,
      listId,
      maxId: cursor,
      limit,
      fetchImpl: this.fetchImpl,
    });
    return {
      items: res.items.map((it) => toUnifiedItem(it)),
      nextCursor: res.nextCursor,
    };
  }

  async fetchNotifications(cursor = '', limit = 30, { cache } = {}) {
    const rows = await getNotifications({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      maxId: cursor,
      limit,
      cache,
      fetchImpl: this.fetchImpl,
    });
    const followAccountIds = [
      ...new Set(
        rows
          .filter((n) => (n.type === 'follow' || n.type === 'follow_request') && n.account?.id)
          .map((n) => String(n.account.id))
      ),
    ];
    const relById = new Map();
    if (followAccountIds.length > 0 && this.accessToken) {
      const rels = await getRelationships({
        instanceUrl: this.instanceUrl,
        accessToken: this.accessToken,
        accountIds: followAccountIds,
        fetchImpl: this.fetchImpl,
      }).catch(() => []);
      for (const rel of Array.isArray(rels) ? rels : []) {
        if (rel?.id !== undefined) relById.set(String(rel.id), rel);
      }
    }

    const mapType = {
      mention: 'mention',
      reply: 'reply',
      reblog: 'repost',
      favourite: 'like',
      follow: 'follow',
      follow_request: 'follow',
      quote: 'quote',
    };
    return rows.map((n) => {
      const rel = n.account?.id ? relById.get(String(n.account.id)) : null;
      const actor = {
        id: n.account?.id || '',
        name: n.account?.displayName || n.account?.acct || '',
        handle: n.account?.acct || '',
        avatar_url: n.account?.avatar || '',
        url: n.account?.url || '',
        ...(rel ? { following: Boolean(rel.following), requested: Boolean(rel.requested) } : {}),
      };
      if (n.status) {
        const base = toUnifiedItem(n.status);
        return {
          ...base,
          id: `mastodon:notif:${n.id}`,
          date_published: n.createdAt || base.date_published,
          _meta: {
            ...base._meta,
            notification: { notifId: n.id, type: mapType[n.type] || 'mention', actor },
          },
        };
      }
      return {
        id: `mastodon:notif:${n.id}`,
        protocol: 'mastodon',
        url: actor.url,
        content_html: plainTextToHtml(''),
        content_text: '',
        date_published: n.createdAt || new Date().toISOString(),
        author: actor,
        attachments: [],
        metrics: { replies: 0, reposts: 0, likes: 0 },
        _meta: {
          mastodon: { statusId: '', uri: '', visibility: 'public', instanceUrl: this.instanceUrl },
          notification: { notifId: n.id, type: mapType[n.type] || 'mention', actor },
        },
      };
    });
  }

  async dismissNotification(notifId) {
    return dismissMastodonNotification({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      notifId,
      fetchImpl: this.fetchImpl,
    });
  }

  async clearNotifications() {
    return clearMastodonNotifications({
      instanceUrl: this.instanceUrl,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }
}
