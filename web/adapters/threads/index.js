import { SocialAdapter } from '../base.js';
import { plainTextToHtml, toUnifiedItem } from '../../core/schema/unifiedItem.js';
import {
  deleteThreadsPost,
  getOwnThreadsPosts,
  getThreadsPostReplies,
  publishThreadsPost,
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
      _meta: { threads: { postId } },
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

  async reply(targetItem, draft, media = [], options = {}) {
    const item = toUnifiedItem(targetItem);
    const postId = item._meta?.threads?.postId || item.id.replace(/^threads:/, '');
    return this.publish(draft, media, { ...options, replyToId: postId });
  }

  async like() {
    throw new Error('Threads Graph API does not expose remote likes');
  }

  async repost() {
    throw new Error('Threads Graph API does not expose remote reposts');
  }

  async fetchNotifications(_cursor = '', limit = 10) {
    const own = await getOwnThreadsPosts({
      userId: this.userId,
      accessToken: this.accessToken,
      limit: Math.min(limit, 8),
      fetchImpl: this.fetchImpl,
    }).catch(() => ({ data: [] }));

    const posts = Array.isArray(own?.data) ? own.data : [];
    const results = [];
    for (const p of posts) {
      if (!p?.id) continue;
      const repData = await getThreadsPostReplies({
        postId: p.id,
        accessToken: this.accessToken,
        fetchImpl: this.fetchImpl,
      }).catch(() => ({ data: [] }));
      for (const r of repData?.data || []) {
        const u = String(r.username || 'threads.user').replace(/^@/, '');
        const text = String(r.text || '');
        const actor = {
          id: u,
          name: u,
          handle: u,
          avatar_url: '',
          url: `https://www.threads.net/@${u}`,
        };
        results.push({
          id: `threads:notif:${r.id}`,
          protocol: 'threads',
          url: r.permalink || `https://www.threads.net/@${u}/post/${r.id}`,
          content_html: plainTextToHtml(text),
          content_text: text,
          date_published: r.timestamp || new Date().toISOString(),
          author: actor,
          attachments: [],
          metrics: { replies: 0, reposts: 0, likes: 0 },
          _meta: {
            threads: { postId: String(r.id), parentPostId: String(p.id) },
            notification: { notifId: `threads:${r.id}`, type: 'reply', actor },
          },
        });
      }
    }
    return results;
  }
}
