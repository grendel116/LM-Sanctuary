import { SocialAdapter } from '../base.js';
import { plainTextToHtml, toUnifiedItem } from '../../core/schema/unifiedItem.js';
import {
  deleteThreadsPost,
  getOwnThreadsPosts,
  getThreadsConversation,
  getThreadsMentions,
  getThreadsPost,
  getThreadsPostInsights,
  getThreadsPostReplies,
  lookupThreadsProfile,
  manageThreadsReply,
  normalizeThreadsPostRecord,
  publishThreadsPost,
  searchThreadsKeyword,
} from '../../queries/threads.js';

export class ThreadsAdapter extends SocialAdapter {
  protocol = 'threads';

  constructor({ userId = '', accessToken = '', username = '', displayName = '', avatarUrl = '', fetchImpl } = {}) {
    super();
    this.userId = userId;
    this.accessToken = accessToken;
    this.username = username;
    this.displayName = displayName || username;
    this.avatarUrl = avatarUrl;
    this.fetchImpl = fetchImpl;
    this._profileCache = new Map();
  }

  async publish(draft, media = [], options = {}) {
    const res = await publishThreadsPost({
      userId: this.userId,
      accessToken: this.accessToken,
      text: draft,
      media,
      mastodonUrls: options.mastodonMediaUrls || [],
      publicMediaBaseUrl: options.publicMediaBaseUrl || '',
      replyToId: options.replyToId || '',
      linkAttachment: options.linkAttachment || '',
      topicTag: options.topicTag || '',
      quotePostId: options.quotePostId || '',
      replyControl: options.replyControl || '',
      pollDelayMs: options.pollDelayMs ?? 1000,
      fetchImpl: this.fetchImpl,
    });
    const postId = String(res?.id || '');
    return {
      id: `threads:${postId}`,
      protocol: 'threads',
      url: this.username && postId ? `https://www.threads.net/@${this.username}/post/${postId}` : '',
      content_html: plainTextToHtml(draft),
      content_text: String(draft || ''),
      date_published: new Date().toISOString(),
      author: {
        id: this.userId,
        name: this.displayName,
        handle: this.username,
        avatar_url: this.avatarUrl,
        url: this.username ? `https://www.threads.net/@${this.username}` : '',
      },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: {
        threads: {
          postId,
          ...(options.replyToId ? { repliedToId: String(options.replyToId) } : {}),
          ...(options.topicTag ? { topicTag: String(options.topicTag) } : {}),
        },
      },
    };
  }

  async delete(nativeMeta = {}) {
    const postId = nativeMeta.postId || nativeMeta.threadsPostId;
    if (!postId) return false;
    await deleteThreadsPost({
      postId,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    });
    return true;
  }

  async manageReply(replyId, { hide = true } = {}) {
    return manageThreadsReply({
      replyId,
      accessToken: this.accessToken,
      hide,
      fetchImpl: this.fetchImpl,
    });
  }

  async reply(targetItem, draft, media = [], options = {}) {
    const item = toUnifiedItem(targetItem);
    const postId = item._meta?.threads?.postId || item.id.replace(/^threads:(?:notif:)?/, '');
    return this.publish(draft, media, { ...options, replyToId: postId });
  }

  async like() {
    throw new Error('Threads Graph API does not expose remote likes');
  }

  async repost() {
    throw new Error('Threads Graph API does not expose remote reposts');
  }

  async getPostInsights(postId) {
    return getThreadsPostInsights({
      postId,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    });
  }

  async fetchOwnPosts(limit = 20) {
    const res = await getOwnThreadsPosts({
      userId: this.userId,
      accessToken: this.accessToken,
      limit,
      fetchImpl: this.fetchImpl,
    });
    const prof = {
      userId: this.userId,
      username: this.username,
      displayName: this.displayName,
      avatar: this.avatarUrl,
    };
    const items = (Array.isArray(res?.data) ? res.data : []).map((raw) => normalizeThreadsPostRecord(raw, prof));
    await Promise.all(
      items.slice(0, 10).map(async (item) => {
        const pid = item._meta?.threads?.postId;
        if (!pid) return;
        const m = await this.getPostInsights(pid);
        if (m) item.metrics = m;
      })
    );
    return items;
  }

  async getPostThread(postIdOrItem) {
    const rawItem = typeof postIdOrItem === 'object' && postIdOrItem ? toUnifiedItem(postIdOrItem) : null;
    const postId = String(
      rawItem?._meta?.threads?.postId
      || (typeof postIdOrItem === 'string' ? postIdOrItem : rawItem?.id || '').replace(/^threads:(?:notif:)?/, '')
    ).trim();
    if (!postId) return { status: rawItem, ancestors: [], descendants: [] };

    const focalRaw = await getThreadsPost({
      postId,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    }).catch(() => null);
    const prof = {
      userId: this.userId,
      username: this.username,
      displayName: this.displayName,
      avatar: this.avatarUrl,
    };
    const focal = focalRaw?.id
      ? normalizeThreadsPostRecord(focalRaw, focalRaw.username === this.username ? prof : {})
      : rawItem;

    const ancestors = [];
    const parentId = String(focal?._meta?.threads?.repliedToId || focal?._meta?.threads?.parentPostId || '').trim();
    if (parentId) {
      const parentRaw = await getThreadsPost({
        postId: parentId,
        accessToken: this.accessToken,
        fetchImpl: this.fetchImpl,
      }).catch(() => null);
      if (parentRaw?.id) {
        ancestors.push(normalizeThreadsPostRecord(parentRaw, parentRaw.username === this.username ? prof : {}));
      }
    }

    const [convRes, insights] = await Promise.all([
      getThreadsConversation({
        postId,
        accessToken: this.accessToken,
        fetchImpl: this.fetchImpl,
      }).catch(async () => getThreadsPostReplies({
        postId,
        accessToken: this.accessToken,
        fetchImpl: this.fetchImpl,
      }).catch(() => ({ data: [] }))),
      this.getPostInsights(postId),
    ]);

    const rawReplies = Array.isArray(convRes?.data) ? convRes.data : [];
    const depthById = new Map([[postId, -1]]);
    const descendants = [];
    for (const r of rawReplies) {
      if (!r?.id || String(r.hide_status || '').toUpperCase() === 'HIDDEN') continue;
      const u = normalizeThreadsPostRecord(r, r.username === this.username ? prof : {});
      const rParent = String(r?.replied_to?.id || postId);
      const depth = depthById.has(rParent) ? Math.min(depthById.get(rParent) + 1, 3) : 0;
      depthById.set(String(r.id), depth);
      descendants.push({ item: u, depth });
    }

    const threadNodes = [focal, ...ancestors, ...descendants.map((d) => d.item)].filter(Boolean);
    const missingHandles = [
      ...new Set(
        threadNodes
          .filter((node) => !node?.author?.avatar_url && node?.author?.handle)
          .map((node) => String(node.author.handle).replace(/^@/, ''))
      ),
    ].slice(0, 8);
    if (missingHandles.length > 0) {
      const profiles = await Promise.all(missingHandles.map((h) => this.lookupProfile(h).catch(() => null)));
      const byHandle = new Map();
      for (const p of profiles) {
        if (p?.username || p?.handle) {
          byHandle.set(String(p.username || p.handle).toLowerCase(), p);
        }
      }
      for (const node of threadNodes) {
        const key = String(node?.author?.handle || '').replace(/^@/, '').toLowerCase();
        const p = byHandle.get(key);
        if (!p) continue;
        node.author = {
          ...node.author,
          name: p.displayName || node.author.name,
          avatar_url: p.avatar || node.author.avatar_url,
          url: p.url || node.author.url,
        };
      }
    }

    if (focal) {
      const base = insights || focal.metrics || { likes: 0, replies: 0, reposts: 0 };
      focal.metrics = {
        likes: Number(base.likes || 0),
        replies: Math.max(Number(base.replies || 0), descendants.length),
        reposts: Number(base.reposts || 0),
      };
    }

    return { status: focal, ancestors, descendants };
  }

  async searchPosts(query, limit = 12) {
    const res = await searchThreadsKeyword({
      query,
      limit,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    }).catch(() => ({ data: [] }));
    return (Array.isArray(res?.data) ? res.data : []).map((raw) => normalizeThreadsPostRecord(raw));
  }

  async lookupProfile(username) {
    const clean = String(username || '').trim().replace(/^@/, '');
    if (!clean || clean.includes(' ')) return null;
    const cacheKey = clean.toLowerCase();
    if (this._profileCache.has(cacheKey)) {
      return this._profileCache.get(cacheKey);
    }
    const raw = await lookupThreadsProfile({
      username: clean,
      accessToken: this.accessToken,
      fetchImpl: this.fetchImpl,
    }).catch(() => null);
    if (!raw?.username) {
      if (this._profileCache.size < 200) this._profileCache.set(cacheKey, null);
      return null;
    }
    const handle = String(raw.username).replace(/^@/, '');
    const mapped = {
      id: handle,
      protocol: 'threads',
      network: 'threads',
      username: handle,
      acct: handle,
      displayName: raw.name || handle,
      avatar: raw.profile_picture_url || '',
      url: `https://www.threads.net/@${handle}`,
      noteText: raw.biography || '',
      followersCount: Number(raw.follower_count ?? 0),
    };
    if (this._profileCache.size < 200) this._profileCache.set(cacheKey, mapped);
    return mapped;
  }

  async fetchNotifications(_cursor = '', limit = 10, { trackedPostIds = [] } = {}) {
    const cleanTrackedIds = [
      ...new Set(
        (Array.isArray(trackedPostIds) ? trackedPostIds : [])
          .map((id) => String(id || '').replace(/^threads:/, '').trim())
          .filter(Boolean)
      ),
    ];
    const trackedSet = new Set(cleanTrackedIds);
    const ownHandle = String(this.username || '').trim().replace(/^@/, '').toLowerCase();

    const mentionsRes = await getThreadsMentions({
      accessToken: this.accessToken,
      limit: Math.min(limit, 15),
      fetchImpl: this.fetchImpl,
    }).catch(() => ({ data: [] }));

    const results = [];
    const seenPostIds = new Set();

    const toNotifItem = (raw, type, parentPostId = '') => {
      const normalized = normalizeThreadsPostRecord(raw);
      const pid = normalized._meta.threads.postId;
      const actorHandle = String(normalized.author?.handle || '').replace(/^@/, '').toLowerCase();
      if (!pid || seenPostIds.has(pid)) return null;
      if (ownHandle && actorHandle && actorHandle === ownHandle) return null;
      if (String(raw?.hide_status || '').toUpperCase() === 'HIDDEN') return null;
      seenPostIds.add(pid);
      if (parentPostId && !normalized._meta.threads.parentPostId) {
        normalized._meta.threads.parentPostId = String(parentPostId);
      }
      normalized.id = `threads:notif:${pid}`;
      normalized._meta.notification = {
        notifId: `threads:${pid}`,
        type,
        actor: normalized.author,
      };
      return normalized;
    };

    for (const m of mentionsRes?.data || []) {
      const parentId = String(m?.replied_to?.id || '').trim();
      const rootId = String(m?.root_post?.id || '').trim();
      if ((parentId || rootId) && !trackedSet.has(parentId) && !trackedSet.has(rootId)) {
        continue;
      }
      const item = toNotifItem(m, 'mention', parentId);
      if (item) results.push(item);
    }

    const replyBatches = await Promise.all(
      cleanTrackedIds.slice(0, 15).map(async (pid) => {
        const repData = await getThreadsPostReplies({
          postId: pid,
          accessToken: this.accessToken,
          fetchImpl: this.fetchImpl,
        }).catch(() => ({ data: [] }));
        return { pid, rows: Array.isArray(repData?.data) ? repData.data : [] };
      })
    );

    for (const { pid, rows } of replyBatches) {
      for (const r of rows) {
        const item = toNotifItem(r, 'reply', String(pid));
        if (item) results.push(item);
      }
    }

    const handlesToEnrich = [
      ...new Set(
        results
          .filter((item) => !item.author?.avatar_url && item.author?.handle)
          .map((item) => String(item.author.handle).replace(/^@/, ''))
      ),
    ].slice(0, 8);
    if (handlesToEnrich.length > 0) {
      const enriched = await Promise.all(handlesToEnrich.map((h) => this.lookupProfile(h).catch(() => null)));
      const byHandle = new Map();
      for (const p of enriched) {
        if (p?.handle || p?.username) {
          byHandle.set(String(p.username || p.handle).toLowerCase(), p);
        }
      }
      for (const item of results) {
        const h = String(item.author?.handle || '').replace(/^@/, '').toLowerCase();
        const prof = byHandle.get(h);
        if (!prof) continue;
        item.author = {
          ...item.author,
          name: prof.displayName || item.author.name,
          avatar_url: prof.avatar || item.author.avatar_url,
          url: prof.url || item.author.url,
        };
        if (item._meta?.notification) {
          item._meta.notification.actor = item.author;
        }
      }
    }

    return results;
  }
}
