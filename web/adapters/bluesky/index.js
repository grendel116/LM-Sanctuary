import { SocialAdapter } from '../base.js';
import { toUnifiedItem } from '../../core/schema/unifiedItem.js';
import {
  createBskyPost,
  deleteBskyPost,
  getBskyPostsByUris,
  getBskyTimeline,
  likeBskyPost,
  listBskyNotifications,
  renderBskyRichTextToHtml,
  repostBskyPost,
  updateBskyNotificationsSeen,
  uploadBskyBlob,
  uploadBskyVideo,
} from '../../queries/bluesky.js';

function isBskyVideoAttachment(att) {
  const t = String(att?.type || '').toLowerCase();
  const m = String(att?.mimeType || att?.mime_type || att?.file?.type || att?.blob?.type || '').toLowerCase();
  const u = String(att?.url || att?.file?.name || '').split(/[?#]/)[0].toLowerCase();
  return t === 'video' || t === 'gifv' || m.startsWith('video/') || /\.(?:mp4|webm|mov|m4v)$/.test(u);
}

export class BlueskyAdapter extends SocialAdapter {
  protocol = 'bluesky';

  constructor({ serviceUrl = 'https://bsky.social', did = '', handle = '', accessJwt = '', refreshJwt = '', onSessionRefreshed, fetchImpl } = {}) {
    super();
    this.serviceUrl = serviceUrl;
    this.did = did;
    this.handle = handle;
    this.accessJwt = accessJwt;
    this.refreshJwt = refreshJwt;
    this.onSessionRefreshed = refreshJwt
      ? async (tok) => {
          if (tok?.accessJwt) this.accessJwt = tok.accessJwt;
          if (tok?.refreshJwt) this.refreshJwt = tok.refreshJwt;
          if (typeof onSessionRefreshed === 'function') await onSessionRefreshed(tok);
        }
      : onSessionRefreshed;
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
    let uploadedVideo = null;
    const videoAtt = (media || []).find((att) => (att?.blob || att?.file) && isBskyVideoAttachment(att));

    if (videoAtt) {
      const blob = videoAtt.blob || videoAtt.file;
      const mimeType = videoAtt.mimeType || videoAtt.mime_type || blob.type || 'video/mp4';
      const uploadedVideoBlob = await uploadBskyVideo({
        ...this._authArgs(),
        did: this.did,
        blob,
        mimeType,
        name: blob.name || 'video.mp4',
      });
      uploadedVideo = {
        blob: uploadedVideoBlob,
        alt: videoAtt.altText || videoAtt.alt_text || '',
        ...(videoAtt.width > 0 && videoAtt.height > 0
          ? { aspectRatio: { width: videoAtt.width, height: videoAtt.height } }
          : {}),
      };
    } else {
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
    }
    let externalEmbed = null;
    if (!uploadedVideo && uploadedImages.length === 0 && options.externalEmbed?.url) {
      externalEmbed = { ...options.externalEmbed };
      if (!externalEmbed.thumb && typeof externalEmbed.image === 'string' && /^https:\/\//i.test(externalEmbed.image)) {
        try {
          const doFetch = this.fetchImpl || globalThis.fetch;
          if (typeof doFetch === 'function') {
            const imgRes = await doFetch(externalEmbed.image);
            if (imgRes.ok) {
              const ctype = String(imgRes.headers?.get?.('content-type') || 'image/jpeg').split(';')[0].trim().toLowerCase();
              const imgBlob = await imgRes.blob();
              if (ctype.startsWith('image/') && imgBlob.size > 0 && imgBlob.size <= 950_000) {
                const upThumb = await uploadBskyBlob({
                  ...this._authArgs(),
                  blob: imgBlob,
                  mimeType: ctype,
                });
                if (upThumb) externalEmbed.thumb = upThumb;
              }
            }
          }
        } catch {
          // Non-fatal on cross-origin or missing thumbnail fetch
        }
      }
    }
    const created = await createBskyPost({
      ...this._authArgs(),
      repo: this.did,
      text: draft,
      images: uploadedImages,
      video: uploadedVideo,
      externalEmbed,
      reply: options.reply || null,
      sensitive: Boolean(options.sensitive),
    });
    const uri = created?.uri || '';
    const cid = created?.cid || '';
    const rkey = uri.split('/').pop() || '';
    const resolvedFacets = Array.isArray(created?.facets) ? created.facets : [];
    const hasSensitiveMedia = Boolean(options.sensitive && (uploadedImages.length > 0 || uploadedVideo));
    return {
      id: `bluesky:${uri || cid}`,
      protocol: 'bluesky',
      url: this.handle && rkey ? `https://bsky.app/profile/${this.handle}/post/${rkey}` : '',
      content_html: renderBskyRichTextToHtml(draft, resolvedFacets),
      content_text: String(draft || ''),
      ...(hasSensitiveMedia ? { sensitive: true } : {}),
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
          ...(hasSensitiveMedia ? { labels: ['sexual'] } : {}),
          ...(resolvedFacets.length > 0 ? { facets: resolvedFacets } : {}),
          ...(options.reply ? { reply: options.reply } : {}),
        },
        ...(externalEmbed ? { linkCard: options.externalEmbed } : {}),
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
    let cid = meta.cid || '';
    if (uri && !cid) {
      const byUri = await getBskyPostsByUris({ ...this._authArgs(), uris: [uri] }).catch(() => ({}));
      cid = byUri?.[uri]?._meta?.bluesky?.cid || '';
    }
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
    const prevLikes = Number(item._meta?.metricsBreakdown?.bluesky?.likes ?? item.metrics?.likes ?? 0);
    return {
      ...item,
      metrics: {
        ...item.metrics,
        likes: Math.max(0, prevLikes + (undo ? -1 : 1)),
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
    const prevReposts = Number(item._meta?.metricsBreakdown?.bluesky?.reposts ?? item.metrics?.reposts ?? 0);
    return {
      ...item,
      metrics: {
        ...item.metrics,
        reposts: Math.max(0, prevReposts + (undo ? -1 : 1)),
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

  async fetchNotifications(cursor = '', limit = 30, { cache } = {}) {
    const data = await listBskyNotifications({ ...this._authArgs(), cursor, limit, cache });
    const rows = Array.isArray(data?.notifications) ? data.notifications : [];
    const allowReasons = new Set(['reply', 'mention', 'quote', 'like', 'repost', 'follow']);
    const items = rows
      .filter((r) => allowReasons.has(r.reason))
      .map((r) => {
        const h = r.author?.handle || r.author?.did || '';
        const followUri = String(r.author?.viewer?.following || '');
        const actor = {
          id: r.author?.did || '',
          name: r.author?.displayName || h,
          handle: h,
          avatar_url: r.author?.avatar || '',
          url: h ? `https://bsky.app/profile/${h}` : '',
          following: Boolean(followUri),
          ...(followUri ? { followUri } : {}),
        };
        const text = r.record?.text || '';
        const published = r.indexedAt || r.record?.createdAt || new Date().toISOString();
        const rkey = String(r.uri || '').split('/').pop() || '';
        const subjectUri = String(
          r.reasonSubject || r.record?.subject?.uri || r.record?.reply?.parent?.uri || ''
        );
        return {
          id: `bluesky:notif:${r.cid || r.uri || published}:${r.reason}`,
          protocol: 'bluesky',
          url: h && rkey ? `https://bsky.app/profile/${h}/post/${rkey}` : actor.url,
          content_html: renderBskyRichTextToHtml(text, r.record?.facets),
          content_text: text,
          date_published: published,
          author: actor,
          attachments: [],
          metrics: { replies: 0, reposts: 0, likes: 0 },
          _meta: {
            bluesky: {
              uri: r.uri || '',
              cid: r.cid || '',
              ...(subjectUri ? { subjectUri } : {}),
            },
            notification: {
              notifId: `bsky:${r.cid || r.uri || published}`,
              type: r.reason,
              actor,
              ...(subjectUri ? { targetPostUri: subjectUri } : {}),
              ...(r.uri ? { notifRecordUri: r.uri } : {}),
              ...(typeof r.isRead === 'boolean' ? { isRead: r.isRead } : {}),
            },
          },
        };
      });

    const subjectUris = [
      ...new Set(
        items
          .map((it) => it._meta?.bluesky?.subjectUri || '')
          .filter((u) => u.startsWith('at://'))
      ),
    ].slice(0, 50);

    if (subjectUris.length > 0) {
      const postsByUri = await getBskyPostsByUris({ uris: subjectUris, ...this._authArgs() }).catch(() => ({}));
      for (const it of items) {
        const subjUri = it._meta?.bluesky?.subjectUri || '';
        const rawSubj = subjUri ? postsByUri[subjUri] : null;
        if (!rawSubj) continue;
        const subj = toUnifiedItem(rawSubj);
        it._meta.notification.targetPost = {
          id: subj.id,
          uri: subjUri,
          cid: subj._meta?.bluesky?.cid || '',
          text: subj.content_text || '',
          url: subj.url || '',
          attachments: subj.attachments || [],
          metrics: { ...(subj.metrics || { likes: 0, replies: 0, reposts: 0 }) },
        };
        const kind = it._meta.notification.type;
        if (kind === 'like' || kind === 'repost') {
          it.content_text = subj.content_text || '';
          it.content_html = subj.content_html || '';
          it.attachments = subj.attachments || [];
          it.url = subj.url || it.url;
          it.metrics = { ...(subj.metrics || { likes: 0, replies: 0, reposts: 0 }) };
          it._meta.bluesky.uri = subjUri;
          it._meta.bluesky.cid = subj._meta?.bluesky?.cid || it._meta.bluesky.cid;
        } else if (kind === 'reply' || kind === 'quote' || kind === 'mention') {
          it._meta.notification.targetMetrics = { ...(subj.metrics || { likes: 0, replies: 0, reposts: 0 }) };
        }
      }
    }
    return items;
  }

  async updateNotificationsSeen(seenAt = '') {
    await updateBskyNotificationsSeen({
      ...this._authArgs(),
      ...(seenAt ? { seenAt } : {}),
    });
    return true;
  }
}
