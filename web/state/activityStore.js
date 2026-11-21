import { applyKeywordFilters, canonicalizeActorHandle } from '../core/schema/unifiedItem.js';
import {
  clearUnifiedNotifications,
  dismissUnifiedNotifications,
  fetchUnifiedNotifications,
  markUnifiedNotificationsSeen,
} from '../queries/socialClient.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
import { authStore } from './authStore.js';
import { feedStore, hydrateCachedModeration } from './feedStore.js';
import { createStore } from './store.js';

const LAST_SEEN_TS_KEY = 'activity_last_seen_ts_v1';
const SEEN_THREADS_METRICS_KEY = 'activity_seen_threads_metrics_v1';

const KIND_NORMALIZE = {
  favourite: 'like',
  like: 'like',
  reblog: 'repost',
  repost: 'repost',
  reply: 'reply',
  mention: 'mention',
  quote: 'quote',
  follow: 'follow',
  follow_request: 'follow',
  poll: 'poll',
  status: 'status',
};

const PROTO_PRIORITY = {
  mastodon: 0,
  bluesky: 1,
  threads: 2,
};

function createInitialActivityState() {
  return {
    items: [],
    warnings: [],
    loading: false,
    error: null,
    hydrated: false,
    lastFetchedAt: 0,
    lastSeenTs: 0,
    seenThreadsMetrics: {},
    hasUnread: false,
  };
}

export const activityStore = createStore(createInitialActivityState());

export function resetActivityStoreForTests() {
  activityStore.set(createInitialActivityState());
}

export function normalizeNotificationKind(rawType) {
  return KIND_NORMALIZE[String(rawType || '').toLowerCase()] || String(rawType || 'mention').toLowerCase();
}

export function resolveCanonicalNotificationPostKey(item) {
  if (!item || typeof item !== 'object') return '';
  const meta = item._meta || {};
  const nm = meta.notification || {};
  if (nm.canonicalPostKey) return String(nm.canonicalPostKey);

  const linked = nm.linkedIds || meta.linkedIds || {};
  if (linked.mastodonStatusId) return `mastodon:${linked.mastodonStatusId}`;
  if (linked.blueskyUri) return `bluesky:${linked.blueskyUri}`;
  if (linked.threadsPostId) return `threads:${linked.threadsPostId}`;

  const kind = normalizeNotificationKind(nm.type || item.type);
  if (item.protocol === 'mastodon' && meta.mastodon?.statusId) {
    if (kind === 'like' || kind === 'repost') return `mastodon:${meta.mastodon.statusId}`;
    if (meta.mastodon?.inReplyToId) return `mastodon:${meta.mastodon.inReplyToId}`;
    return `mastodon:${meta.mastodon.statusId}`;
  }
  if (item.protocol === 'bluesky') {
    const targetUri = nm.targetPostUri || meta.bluesky?.subjectUri || '';
    if (targetUri) return `bluesky:${targetUri}`;
    if (meta.bluesky?.uri) return `bluesky:${meta.bluesky.uri}`;
  }
  if (item.protocol === 'threads') {
    const tid = nm.threadsPostId || meta.threads?.parentPostId || meta.threads?.repliedToId || meta.threads?.postId || '';
    if (tid) return `threads:${tid}`;
  }
  return '';
}

function isSyntheticThreadsInsightItem(item) {
  const id = String(item?.id || '');
  return id.startsWith('threads:notif:likes:') || id.startsWith('threads:notif:reposts:');
}

function parseItemTimeMs(item) {
  const ms = Date.parse(item?.date_published || item?.createdAt || '');
  return Number.isFinite(ms) ? ms : 0;
}

function mergeBreakdowns(target, incoming) {
  if (!incoming || typeof incoming !== 'object') return;
  for (const [proto, vals] of Object.entries(incoming)) {
    if (!vals || typeof vals !== 'object') continue;
    const prev = target[proto];
    const next = {
      likes: Number(vals.likes || 0),
      replies: Number(vals.replies || 0),
      reposts: Number(vals.reposts || 0),
    };
    if (!prev) {
      target[proto] = next;
    } else {
      target[proto] = {
        likes: Math.max(prev.likes, next.likes),
        replies: Math.max(prev.replies, next.replies),
        reposts: Math.max(prev.reposts, next.reposts),
      };
    }
  }
}

function collectThreadsSeenSnapshot(items = []) {
  const snapshot = {};
  for (const it of items) {
    if (!isSyntheticThreadsInsightItem(it)) continue;
    const nm = it?._meta?.notification || {};
    const tid = String(nm.threadsPostId || it?._meta?.threads?.postId || '').trim();
    if (!tid) continue;
    const prev = snapshot[tid] && typeof snapshot[tid] === 'object' ? { ...snapshot[tid] } : {};
    const kind = normalizeNotificationKind(nm.type);
    const rawTotal = Number(nm.rawInsightsTotal ?? nm.aggregateCount ?? 0) || 0;
    if (kind === 'like') prev.likes = Math.max(Number(prev.likes || 0), rawTotal);
    else if (kind === 'repost') prev.reposts = Math.max(Number(prev.reposts || 0), rawTotal);
    snapshot[tid] = prev;
  }
  return snapshot;
}

export function computeUnreadFromItems(items = [], lastSeenTs = 0, seenThreadsMetrics = {}) {
  if (!Array.isArray(items) || items.length === 0) return false;
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (isSyntheticThreadsInsightItem(it)) {
      const nm = it._meta?.notification || {};
      const tid = String(nm.threadsPostId || it._meta?.threads?.postId || '').trim();
      const kind = normalizeNotificationKind(nm.type);
      const rawTotal = Number(nm.rawInsightsTotal ?? nm.aggregateCount ?? 0) || 0;
      const seenVal = Number(seenThreadsMetrics?.[tid]?.[kind === 'like' ? 'likes' : 'reposts'] || 0);
      if (rawTotal > seenVal) return true;
      continue;
    }
    const ts = parseItemTimeMs(it);
    if (lastSeenTs === 0 || (ts > 0 && ts > lastSeenTs)) return true;
    if (it._meta?.notification?.isRead === false && lastSeenTs <= 0) return true;
  }
  return false;
}

function pickPrimaryGroupItem(items, kind) {
  return [...items].sort((a, b) => {
    const aSyn = isSyntheticThreadsInsightItem(a) ? 1 : 0;
    const bSyn = isSyntheticThreadsInsightItem(b) ? 1 : 0;
    if (aSyn !== bSyn) return aSyn - bSyn;
    const aHasText = a.content_text?.trim() ? 0 : 1;
    const bHasText = b.content_text?.trim() ? 0 : 1;
    if (aHasText !== bHasText) return aHasText - bHasText;
    const aAtt = (a.attachments?.length || 0) > 0 ? 0 : 1;
    const bAtt = (b.attachments?.length || 0) > 0 ? 0 : 1;
    if (aAtt !== bAtt) return aAtt - bAtt;
    const pa = PROTO_PRIORITY[a.protocol] ?? 9;
    const pb = PROTO_PRIORITY[b.protocol] ?? 9;
    if (kind === 'like' || kind === 'repost') {
      if (pa !== pb) return pa - pb;
    }
    return parseItemTimeMs(b) - parseItemTimeMs(a);
  })[0];
}

function findCachedPostByCanonicalOrMasto(canonKey, mastoId) {
  const streams = feedStore.get()?.streams || {};
  const targetCanon = String(canonKey || '');
  const targetSid = String(mastoId || '');
  for (const bucket of Object.values(streams)) {
    for (const post of bucket?.items || []) {
      const pSid = String(post?._meta?.mastodon?.statusId || '');
      if ((targetCanon && post?.id === targetCanon) || (targetSid && pSid === targetSid)) {
        return post;
      }
    }
  }
  return null;
}

function buildThreadTargetItem(primaryItem, kind) {
  if (!primaryItem) return null;
  const nm = primaryItem._meta?.notification || {};
  const linked = nm.linkedIds || primaryItem._meta?.linkedIds || null;
  const canonKey = String(nm.canonicalPostKey || '');
  const linkedMastoId = String(
    linked?.mastodonStatusId
    || (canonKey.startsWith('mastodon:') ? canonKey.slice('mastodon:'.length) : '')
    || ''
  );

  if (linkedMastoId) {
    const cached = findCachedPostByCanonicalOrMasto(canonKey || `mastodon:${linkedMastoId}`, linkedMastoId);
    const focusMeta = (kind === 'reply' || kind === 'mention' || kind === 'quote')
      ? { focusReplyId: primaryItem.id }
      : {};
    if (cached) {
      return {
        ...cached,
        _meta: {
          ...(cached._meta || {}),
          linkedIds: linked || cached._meta?.linkedIds,
          mastodon: {
            ...(cached._meta?.mastodon || {}),
            statusId: linkedMastoId,
          },
          ...focusMeta,
        },
      };
    }
    return {
      ...primaryItem,
      id: canonKey || `mastodon:${linkedMastoId}`,
      protocol: 'mastodon',
      ...(kind === 'reply' || kind === 'mention' || kind === 'quote'
        ? {
            content_text: nm.targetPost?.text || '',
            content_html: '',
            author: { id: '', name: 'Post', handle: '' },
            attachments: [],
          }
        : {}),
      _meta: {
        ...primaryItem._meta,
        linkedIds: linked || primaryItem._meta?.linkedIds,
        mastodon: {
          ...(primaryItem._meta?.mastodon || {}),
          statusId: linkedMastoId,
        },
        ...focusMeta,
      },
    };
  }

  if (primaryItem.protocol === 'threads' && primaryItem._meta?.threads?.parentPostId) {
    const parentPid = String(primaryItem._meta.threads.parentPostId);
    return {
      id: `threads:${parentPid}`,
      protocol: 'threads',
      url: `https://www.threads.net/post/${parentPid}`,
      content_text: '',
      content_html: '',
      date_published: primaryItem.date_published || '',
      author: { id: '', name: 'Post', handle: '' },
      attachments: [],
      metrics: { likes: 0, replies: 0, reposts: 0 },
      _meta: {
        threads: { postId: parentPid },
        focusReplyId: primaryItem.id,
      },
    };
  }

  if (kind === 'reply' || kind === 'mention' || kind === 'quote') {
    return primaryItem;
  }
  return nm.targetPost || primaryItem;
}

function extractThumbUrl(item) {
  const firstAtt = Array.isArray(item?.attachments) ? item.attachments[0] : null;
  if (firstAtt) {
    const url = firstAtt.previewUrl || firstAtt.preview_url || (String(firstAtt.mime_type || '').startsWith('image/') ? firstAtt.url : '');
    if (url) return url;
  }
  const tpAtt = Array.isArray(item?._meta?.notification?.targetPost?.attachments)
    ? item._meta.notification.targetPost.attachments[0]
    : null;
  if (tpAtt) {
    const url = tpAtt.previewUrl || tpAtt.preview_url || tpAtt.url || '';
    if (url) return url;
  }
  return item?._meta?.linkCard?.image || item?._meta?.quotePost?.thumbUrl || '';
}

/**
 * Group like and repost notifications targeting the same canonical/linked post across Mastodon, Bluesky, and Threads,
 * while keeping replies, mentions, quotes, and follows individually actionable.
 */
export function groupActivityNotifications(items = []) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const buckets = new Map();
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const nm = it._meta?.notification || {};
    const kind = normalizeNotificationKind(nm.type || it.type);
    const postKey = resolveCanonicalNotificationPostKey(it);
    const canGroup = (kind === 'like' || kind === 'repost') && Boolean(postKey);
    const groupKey = canGroup ? `${kind}:${postKey}` : String(it.id || `${kind}:${parseItemTimeMs(it)}:${buckets.size}`);
    if (!buckets.has(groupKey)) {
      buckets.set(groupKey, { groupKey, kind, postKey, items: [] });
    }
    buckets.get(groupKey).items.push(it);
  }

  const groups = [];
  for (const bucket of buckets.values()) {
    const sortedItems = [...bucket.items].sort((a, b) => parseItemTimeMs(b) - parseItemTimeMs(a));
    const primaryItem = pickPrimaryGroupItem(sortedItems, bucket.kind);
    const threadTargetItem = buildThreadTargetItem(primaryItem, bucket.kind);

    const actors = [];
    const seenActors = new Set();
    let aggregateExtraCount = 0;
    const protocols = new Set();
    const notificationIds = [];
    const mastodonNotifIds = [];
    const threadsWatermarks = {};
    const breakdown = {};

    let maxReportedLikes = 0;
    let maxReportedReposts = 0;
    let maxReportedReplies = 0;
    let latestMs = 0;
    let latestDate = '';
    let latestTimeSourceItem = sortedItems[0];

    for (const it of sortedItems) {
      const ts = parseItemTimeMs(it);
      if (ts >= latestMs) {
        latestMs = ts;
        latestDate = it.date_published || '';
        latestTimeSourceItem = it;
      }
      if (it.protocol) protocols.add(String(it.protocol));
      if (it.id) notificationIds.push(String(it.id));

      const nm = it._meta?.notification || {};
      if (nm.notifId) notificationIds.push(String(nm.notifId));
      if (it.protocol === 'mastodon' && (nm.notifId || String(it.id || '').startsWith('mastodon:notif:'))) {
        const rawMid = String(nm.notifId || it.id).replace(/^mastodon:(?:notif:)?/, '');
        if (rawMid) mastodonNotifIds.push(rawMid);
      }

      if (isSyntheticThreadsInsightItem(it)) {
        const agg = Math.max(1, Number(nm.aggregateCount || 1));
        aggregateExtraCount += agg;
        const tid = String(nm.threadsPostId || it._meta?.threads?.postId || '').trim();
        if (tid) {
          const insKey = bucket.kind === 'repost' ? 'reposts' : 'likes';
          const prev = threadsWatermarks[tid] || {};
          threadsWatermarks[tid] = {
            ...prev,
            [insKey]: Math.max(Number(prev[insKey] || 0), Number(nm.rawInsightsTotal ?? agg)),
          };
        }
      } else {
        const actor = nm.actor || it.author || {};
        const actorKey = String(actor.id || actor.handle || actor.name || '').toLowerCase();
        if (actorKey && !seenActors.has(actorKey)) {
          seenActors.add(actorKey);
          actors.push({ ...actor, protocol: actor.protocol || it.protocol || 'mastodon' });
        }
      }

      mergeBreakdowns(breakdown, nm.postMetricsBreakdown || it._meta?.metricsBreakdown);
      const pm = nm.postMetrics || (bucket.kind === 'like' || bucket.kind === 'repost' ? it.metrics : nm.targetMetrics || nm.targetPost?.metrics) || it.metrics || {};
      maxReportedLikes = Math.max(maxReportedLikes, Number(pm.likes || 0));
      maxReportedReposts = Math.max(maxReportedReposts, Number(pm.reposts || 0));
      maxReportedReplies = Math.max(maxReportedReplies, Number(pm.replies || 0));
    }

    const totalActorCount = actors.length + aggregateExtraCount;
    let bdLikes = 0;
    let bdReposts = 0;
    let bdReplies = 0;
    for (const vals of Object.values(breakdown)) {
      bdLikes += Number(vals.likes || 0);
      bdReposts += Number(vals.reposts || 0);
      bdReplies += Number(vals.replies || 0);
    }

    const postMetrics = {
      likes: Math.max(maxReportedLikes, bdLikes, bucket.kind === 'like' ? totalActorCount : 0),
      reposts: Math.max(maxReportedReposts, bdReposts, bucket.kind === 'repost' ? totalActorCount : 0),
      replies: Math.max(maxReportedReplies, bdReplies),
    };

    const primaryActor = actors[0] || (primaryItem?._meta?.notification?.actor || primaryItem?.author || {});
    const isSyntheticOnly = actors.length === 0 && aggregateExtraCount > 0;
    const snippetText = String(
      primaryItem?.content_text
      || primaryItem?._meta?.notification?.targetPost?.text
      || ''
    ).trim();

    groups.push({
      groupKey: bucket.groupKey,
      kind: bucket.kind,
      postKey: bucket.postKey,
      actors,
      primaryActor,
      isSyntheticOnly,
      aggregateExtraCount,
      totalActorCount: Math.max(1, totalActorCount),
      protocols: [...protocols],
      latestDate: latestDate || latestTimeSourceItem?.date_published || '',
      latestMs,
      primaryItem,
      threadTargetItem,
      snippetText,
      thumbUrl: extractThumbUrl(primaryItem),
      postMetrics,
      metricsBreakdown: Object.keys(breakdown).length > 0 ? breakdown : null,
      notificationIds: [...new Set(notificationIds)],
      mastodonNotifIds: [...new Set(mastodonNotifIds)],
      threadsWatermarks,
      items: sortedItems,
    });
  }

  return groups.sort((a, b) => b.latestMs - a.latestMs);
}

/**
 * Compute aggregate totals (likes, reposts, comments, follows) across all connected platforms without double-counting posts.
 */
export function computeActivityTotals(items = []) {
  if (!Array.isArray(items) || items.length === 0) {
    return {
      likes: 0,
      reposts: 0,
      comments: 0,
      follows: 0,
      byPlatform: {
        mastodon: { likes: 0, reposts: 0, comments: 0 },
        bluesky: { likes: 0, reposts: 0, comments: 0 },
        threads: { likes: 0, reposts: 0, comments: 0 },
      },
    };
  }

  const byPost = new Map();
  let unlinkedLikes = 0;
  let unlinkedReposts = 0;
  let unlinkedComments = 0;
  let follows = 0;
  const byPlatform = {
    mastodon: { likes: 0, reposts: 0, comments: 0 },
    bluesky: { likes: 0, reposts: 0, comments: 0 },
    threads: { likes: 0, reposts: 0, comments: 0 },
  };
  const postBreakdowns = new Map();

  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    const nm = it._meta?.notification || {};
    const kind = normalizeNotificationKind(nm.type || it.type);
    if (kind === 'follow') {
      follows += 1;
      continue;
    }

    const postKey = resolveCanonicalNotificationPostKey(it);
    const deltaCount = isSyntheticThreadsInsightItem(it) ? Math.max(1, Number(nm.aggregateCount || 1)) : 1;

    if (!postKey) {
      const proto = byPlatform[it.protocol] ? it.protocol : 'mastodon';
      if (kind === 'like') {
        unlinkedLikes += deltaCount;
        byPlatform[proto].likes += deltaCount;
      } else if (kind === 'repost') {
        unlinkedReposts += deltaCount;
        byPlatform[proto].reposts += deltaCount;
      } else if (kind === 'reply' || kind === 'mention' || kind === 'quote') {
        unlinkedComments += deltaCount;
        byPlatform[proto].comments += deltaCount;
      }
      continue;
    }

    if (!byPost.has(postKey)) {
      byPost.set(postKey, {
        notifLikes: 0,
        notifReposts: 0,
        notifComments: 0,
        reportedLikes: 0,
        reportedReposts: 0,
        reportedReplies: 0,
      });
    }
    const bucket = byPost.get(postKey);
    if (kind === 'like') bucket.notifLikes += deltaCount;
    else if (kind === 'repost') bucket.notifReposts += deltaCount;
    else if (kind === 'reply' || kind === 'mention' || kind === 'quote') bucket.notifComments += deltaCount;

    const pm = nm.postMetrics || (kind === 'like' || kind === 'repost' ? it.metrics : nm.targetMetrics || nm.targetPost?.metrics);
    if (pm && typeof pm === 'object') {
      bucket.reportedLikes = Math.max(bucket.reportedLikes, Number(pm.likes || 0));
      bucket.reportedReposts = Math.max(bucket.reportedReposts, Number(pm.reposts || 0));
      bucket.reportedReplies = Math.max(bucket.reportedReplies, Number(pm.replies || 0));
    }

    const bd = nm.postMetricsBreakdown || it._meta?.metricsBreakdown;
    if (bd && typeof bd === 'object') {
      if (!postBreakdowns.has(postKey)) postBreakdowns.set(postKey, {});
      mergeBreakdowns(postBreakdowns.get(postKey), bd);
    } else if ((kind === 'like' || kind === 'repost') && it.metrics && it.protocol) {
      if (!postBreakdowns.has(postKey)) postBreakdowns.set(postKey, {});
      mergeBreakdowns(postBreakdowns.get(postKey), { [it.protocol]: it.metrics });
    }
  }

  let likes = unlinkedLikes;
  let reposts = unlinkedReposts;
  let comments = unlinkedComments;

  for (const [postKey, b] of byPost.entries()) {
    const bd = postBreakdowns.get(postKey);
    let bdL = 0;
    let bdR = 0;
    let bdC = 0;
    if (bd) {
      for (const [proto, vals] of Object.entries(bd)) {
        bdL += Number(vals.likes || 0);
        bdR += Number(vals.reposts || 0);
        bdC += Number(vals.replies || 0);
        if (byPlatform[proto]) {
          byPlatform[proto].likes += Number(vals.likes || 0);
          byPlatform[proto].reposts += Number(vals.reposts || 0);
          byPlatform[proto].comments += Number(vals.replies || 0);
        }
      }
    }
    likes += Math.max(b.reportedLikes, bdL, b.notifLikes);
    reposts += Math.max(b.reportedReposts, bdR, b.notifReposts);
    comments += Math.max(b.reportedReplies, bdC, b.notifComments);
  }

  return { likes, reposts, comments, follows, byPlatform };
}

export async function hydrateActivityStore() {
  const [lastSeenRaw, seenThreadsRaw] = await Promise.all([
    kvGet(LAST_SEEN_TS_KEY, 0).catch(() => 0),
    kvGet(SEEN_THREADS_METRICS_KEY, {}).catch(() => ({})),
  ]);
  const lastSeenTs = Number(lastSeenRaw || 0) || 0;
  const seenThreadsMetrics = seenThreadsRaw && typeof seenThreadsRaw === 'object' ? seenThreadsRaw : {};
  const cur = activityStore.get();
  activityStore.set({
    hydrated: true,
    lastSeenTs,
    seenThreadsMetrics,
    hasUnread: computeUnreadFromItems(cur.items, lastSeenTs, seenThreadsMetrics),
  });
}

export async function markActivitySeen() {
  const cur = activityStore.get();
  let newestMs = Date.now();
  for (const it of cur.items) {
    if (isSyntheticThreadsInsightItem(it)) continue;
    const ms = parseItemTimeMs(it);
    if (ms > newestMs) newestMs = ms;
  }
  const snapshot = collectThreadsSeenSnapshot(cur.items);
  const nextSeenThreads = { ...(cur.seenThreadsMetrics || {}) };
  for (const [tid, counts] of Object.entries(snapshot)) {
    const prev = nextSeenThreads[tid] || {};
    nextSeenThreads[tid] = {
      likes: Math.max(Number(prev.likes || 0), Number(counts.likes || 0)),
      reposts: Math.max(Number(prev.reposts || 0), Number(counts.reposts || 0)),
    };
  }
  activityStore.set({
    lastSeenTs: newestMs,
    seenThreadsMetrics: nextSeenThreads,
    hasUnread: false,
  });
  await Promise.allSettled([
    kvSet(LAST_SEEN_TS_KEY, newestMs),
    kvSet(SEEN_THREADS_METRICS_KEY, nextSeenThreads),
    markUnifiedNotificationsSeen(),
  ]);
}

export async function refreshActivityNotifications({ limit = 40, markSeen = false, background = false } = {}) {
  const cur = activityStore.get();
  if (!cur.hydrated) {
    await hydrateActivityStore();
  }
  const hasAccounts = (authStore.get().accounts || []).length > 0;
  if (!hasAccounts) {
    activityStore.set({ items: [], warnings: [], loading: false, error: null, hasUnread: false });
    return { items: [], warnings: [] };
  }

  if (!background) {
    activityStore.set({ loading: true, error: null });
  }
  try {
    await hydrateCachedModeration().catch(() => {});
    const { items: rawItems = [], warnings = [] } = await fetchUnifiedNotifications({ limit });
    const filtered = applyKeywordFilters(rawItems, [], feedStore.get().moderatedActors || []);
    const state = activityStore.get();
    if (markSeen) {
      activityStore.set({
        items: filtered,
        warnings,
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
      });
      await markActivitySeen();
    } else {
      activityStore.set({
        items: filtered,
        warnings,
        loading: false,
        error: null,
        lastFetchedAt: Date.now(),
        hasUnread: computeUnreadFromItems(filtered, state.lastSeenTs, state.seenThreadsMetrics),
      });
    }
    return { items: filtered, warnings };
  } catch (err) {
    activityStore.set({
      loading: false,
      ...(background ? {} : { error: err?.message || 'Unable to load activity.' }),
    });
    if (!background) throw err;
    return { items: activityStore.get().items, warnings: [] };
  }
}

export async function dismissActivityGroup(group) {
  if (!group) return;
  const idSet = new Set(group.notificationIds || []);
  const cur = activityStore.get();
  const nextItems = cur.items.filter((it) => {
    const nid = it?._meta?.notification?.notifId;
    return !(idSet.has(it?.id) || (nid && idSet.has(nid)));
  });
  activityStore.set({
    items: nextItems,
    hasUnread: computeUnreadFromItems(nextItems, cur.lastSeenTs, cur.seenThreadsMetrics),
  });
  await dismissUnifiedNotifications({
    ids: group.notificationIds || [],
    mastodonNotifIds: group.mastodonNotifIds || [],
    threadsWatermarks: group.threadsWatermarks || {},
  });
}

export function removeActivityByActor(actor, protocol = 'threads') {
  const handle = String(actor?.handle || actor?.acct || actor?.username || '').trim().replace(/^@/, '').toLowerCase();
  const aid = String(actor?.id || '').trim().toLowerCase();
  const canon = handle ? canonicalizeActorHandle(handle, protocol) : '';
  if (!handle && !aid && !canon) return;
  const cur = activityStore.get();
  const nextItems = (cur.items || []).filter((it) => {
    const itActor = it?._meta?.notification?.actor || it?.author || {};
    const itProto = String(it?.protocol || 'mastodon').toLowerCase();
    const itHandle = String(itActor.handle || '').trim().replace(/^@/, '').toLowerCase();
    const itId = String(itActor.id || '').trim().toLowerCase();
    const itCanon = itHandle ? canonicalizeActorHandle(itHandle, itProto) : '';
    if (canon && itCanon && canon === itCanon) return false;
    if (handle && itHandle && handle === itHandle) return false;
    if (aid && itId && aid === itId) return false;
    return true;
  });
  activityStore.set({
    items: nextItems,
    hasUnread: computeUnreadFromItems(nextItems, cur.lastSeenTs, cur.seenThreadsMetrics),
  });
}

export async function clearAllActivity() {
  const cur = activityStore.get();
  const threadsWatermarks = collectThreadsSeenSnapshot(cur.items);
  const nowMs = Math.max(Date.now(), cur.lastSeenTs || 0);
  activityStore.set({
    items: [],
    hasUnread: false,
    lastSeenTs: nowMs,
  });
  await Promise.allSettled([
    kvSet(LAST_SEEN_TS_KEY, nowMs),
    clearUnifiedNotifications({ threadsWatermarks }),
  ]);
}
