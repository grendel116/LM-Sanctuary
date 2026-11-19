import { SocialAdapter } from '../base.js';
import { plainTextToHtml, toUnifiedItem } from '../../core/schema/unifiedItem.js';
import {
  createBskyPost,
  deleteBskyPost,
  getBskyTimeline,
  likeBskyPost,
  listBskyNotifications,
  repostBskyPost,
  uploadBskyBlob,
} from '../../queries/bluesky.js';

export class BlueskyAdapter extends SocialAdapter {
  protocol = 'bluesky';

  constructor({ serviceUrl = 'https://bsky.social', did = '', handle = '', accessJwt = '', refreshJwt = '', onSessionRefreshed, fetchImpl } = {}) {
    super();
    this.serviceUrl = serviceUrl;
    this.did = did;
    this.handle = handle;
    this.accessJwt = accessJwt;
    this.refreshJwt = refreshJwt;
    this.onSessionRefreshed = onSessionRefreshed;
    this.fetchImpl = fetchImpl;
  }

  _authArgs() {
    return {
      serviceUrl: this.serviceUrl,
      accessJwt: this.accessJwt,
      refreshJwt: this.refreshJwt,
      onSessionRefreshed: this.onSessionRefreshed,
      fetchImpl: this.fetchImpl,
    };
  }

  async publish(draft, media = [], options = {}) {
    const uploadedImages = [];
    for (const att of (media || []).slice(0, 4)) {
      const blob = att.blob || att.file;
      if (!blob) continue;
      const uploadedBlob = await uploadBskyBlob({
        ...this._authArgs(),
        blob,
        mimeType: att.mimeType || att.mime_type || blob.type || 'image/jpeg',
      });
      uploadedImages.push({ alt: att.altText || att.alt_text || '', blob: uploadedBlob });
    }
    const created = await createBskyPost({
      ...this._authArgs(),
      repo: this.did,
      text: draft,
      images: uploadedImages,
      reply: options.reply || null,
    });
    const uri = created?.uri || '';
    const cid = created?.cid || '';
    const rkey = uri.split('/').pop() || '';
    return {
      id: `bluesky:${uri || cid}`,
      protocol: 'bluesky',
      url: this.handle && rkey ? `https://bsky.app/profile/${this.handle}/post/${rkey}` : '',
      content_html: plainTextToHtml(draft),
      content_text: String(draft || ''),
      date_published: new Date().toISOString(),
      author: {
        id: this.did,
        name: this.handle,
        handle: this.handle,
        avatar_url: '',
        url: this.handle ? `https://bsky.app/profile/${this.handle}` : '',
      },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: {
        bluesky: {
          uri,
          cid,
          ...(options.reply ? { reply: options.reply } : {}),
        },
      },
    };
  }

  async delete(nativeMeta = {}) {
    const uri = nativeMeta.uri || nativeMeta.blueskyUri;
    if (!uri) return false;
    return deleteBskyPost({ ...this._authArgs(), repo: this.did, uri });
  }

  async reply(targetItem, draft, media = [], options = {}) {
    const item = toUnifiedItem(targetItem);
    const meta = item._meta?.bluesky || {};
    const uri = meta.uri || item.id.replace(/^bluesky:/, '');
    const cid = meta.cid || '';
    const parentRef = { uri, cid };
    const rootCandidate = meta.reply?.root;
    const rootRef = rootCandidate?.uri && rootCandidate?.cid
      ? { uri: rootCandidate.uri, cid: rootCandidate.cid }
      : parentRef;
    return this.publish(draft, media, { ...options, reply: { root: rootRef, parent: parentRef } });
  }

  async like(targetItem, undo = false) {
    const item = toUnifiedItem(targetItem);
    const meta = { ...(item._meta?.bluesky || {}) };
    const res = await likeBskyPost({
      ...this._authArgs(),
      repo: this.did,
      uri: meta.uri,
      cid: meta.cid,
      likeUri: undo ? meta.likeUri : null,
    });
    const nextLikeUri = undo ? null : (res?.uri || 'liked');
    return {
      ...item,
      metrics: {
        ...item.metrics,
        likes: Math.max(0, (item.metrics?.likes || 0) + (undo ? -1 : 1)),
      },
      _meta: { ...item._meta, bluesky: { ...meta, likeUri: nextLikeUri } },
    };
  }

  async repost(targetItem, undo = false) {
    const item = toUnifiedItem(targetItem);
    const meta = { ...(item._meta?.bluesky || {}) };
    const res = await repostBskyPost({
      ...this._authArgs(),
      repo: this.did,
      uri: meta.uri,
      cid: meta.cid,
      repostUri: undo ? meta.repostUri : null,
    });
    const nextRepostUri = undo ? null : (res?.uri || 'reposted');
    return {
      ...item,
      metrics: {
        ...item.metrics,
        reposts: Math.max(0, (item.metrics?.reposts || 0) + (undo ? -1 : 1)),
      },
      _meta: { ...item._meta, bluesky: { ...meta, repostUri: nextRepostUri } },
    };
  }

  async fetchTimeline(cursor = '', limit = 25) {
    const res = await getBskyTimeline({ ...this._authArgs(), cursor, limit });
    return {
      items: res.items.map((it) => toUnifiedItem(it)),
      nextCursor: res.nextCursor,
    };
  }

  async fetchNotifications(cursor = '', limit = 30) {
    const data = await listBskyNotifications({ ...this._authArgs(), cursor, limit });
    const rows = Array.isArray(data?.notifications) ? data.notifications : [];
    const allowReasons = new Set(['reply', 'mention', 'quote', 'like', 'repost', 'follow']);
    return rows
      .filter((r) => allowReasons.has(r.reason))
      .map((r) => {
        const h = r.author?.handle || r.author?.did || '';
        const actor = {
          id: r.author?.did || '',
          name: r.author?.displayName || h,
          handle: h,
          avatar_url: r.author?.avatar || '',
          url: h ? `https://bsky.app/profile/${h}` : '',
        };
        const text = r.record?.text || '';
        const published = r.indexedAt || r.record?.createdAt || new Date().toISOString();
        const rkey = String(r.uri || '').split('/').pop() || '';
        return {
          id: `bluesky:notif:${r.cid || r.uri || published}:${r.reason}`,
          protocol: 'bluesky',
          url: h && rkey ? `https://bsky.app/profile/${h}/post/${rkey}` : actor.url,
          content_html: plainTextToHtml(text),
          content_text: text,
          date_published: published,
          author: actor,
          attachments: [],
          metrics: { replies: 0, reposts: 0, likes: 0 },
          _meta: {
            bluesky: { uri: r.uri || '', cid: r.cid || '' },
            notification: {
              notifId: `bsky:${r.cid || r.uri || published}`,
              type: r.reason,
              actor,
            },
          },
        };
      });
  }
}
