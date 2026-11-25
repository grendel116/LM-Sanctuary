import {
  normalizeFeedTuning,
  normalizeRankingManifest,
} from '../core/feedRanker.js';
import {
  actorMatchesOwnAccountSet,
  buildOwnAccountKeySet,
  canonicalizeActorHandle,
  deduplicateAppendItems,
  deduplicateUnifiedItems,
  mergeViewerActivityMeta,
  normalizeNativeUri,
  reconcileViewerMetricFloors,
  sumMetricsBreakdown,
  toUnifiedItem,
} from '../core/schema/unifiedItem.js';
import {
  applyKnownMetrics,
  hydrateMetricsLedger,
  recordItemMetrics,
} from './metricsLedger.js';
import { fetchSanctuaryFeedProfile, saveSanctuaryFeedProfile } from '../queries/sanctuary.js';
import { getLocalModeratedAccounts, storeDelete, storeGet, storePut } from '../storage/nativeStore.js';
import { authStore } from './authStore.js';
import { connectionStore, onSanctuaryEvent } from './sanctuary/connection.js';
import { createStore } from './store.js';

const FEED_TUNING_KV_KEY = 'feed_tuning_profile';
const FEED_RECIPROCITY_KV_KEY = 'feed_interacted_authors';
const FEED_TASTE_MEMORY_KV_KEY = 'feed_taste_memory_v1';
const FEED_DISMISSED_POSTS_KV_KEY = 'feed_dismissed_posts';
const FEED_VIEWER_INTERACTIONS_KV_KEY = 'feed_viewer_interactions_v1';
const RANKING_MANIFEST_KV_KEY = 'sanctuary_ranking_manifest_v1';
export const HARVESTER_CACHE_VERSION = 14;
const STREAM_CACHE_TTL_MS = 24 * 3600_000;
const ROLLING_DISCOVERY_STREAMS = new Set(['feed', 'photos', 'video', 'visual']);
let sanctuarySyncBound = false;
let tasteMutationEpoch = 0;

function createEmptyStreamBucket() {
  return {
    items: [],
    nextCursor: null,
    updatedAt: 0,
    generation: 0,
    shuffleSeed: '',
    deprioritizeIds: [],
  };
}

function createInitialFeedState() {
  return {
    activeStream: 'feed',
    streams: {
      feed: createEmptyStreamBucket(),
      following: createEmptyStreamBucket(),
      photos: createEmptyStreamBucket(),
      video: createEmptyStreamBucket(),
      visual: createEmptyStreamBucket(),
      home: createEmptyStreamBucket(),
      local: createEmptyStreamBucket(),
      federated: createEmptyStreamBucket(),
      list: createEmptyStreamBucket(),
      bookmarks: createEmptyStreamBucket(),
      notifications: createEmptyStreamBucket(),
    },
    lists: [],
    activeListId: null,
    filters: [],
    moderatedActors: [],
    dismissedPostIds: [],
    tuning: normalizeFeedTuning(null),
    rankingManifest: normalizeRankingManifest(null),
    interactedAuthors: {},
    viewerInteractions: {},
    semanticScores: {},
    tasteScores: {},
    tasteMemory: { positive: [], negative: [] },
    userTuningEpoch: 0,
    loading: false,
    error: null,
  };
}

export const feedStore = createStore(createInitialFeedState());

function getPostIdentityKey(item) {
  if (!item) return '';
  if (item.id && (item.protocol || item._meta)) return String(item.id);
  if (item.key) return String(item.key);
  return `${item.network || 'mastodon'}:${item.uri || item.id}`;
}

function parseTimestampMs(item) {
  if (typeof item?.createdAtMs === 'number') return item.createdAtMs;
  const parsed = Date.parse(item?.date_published || item?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function getViewerInteractionKeys(rawItem) {
  const u = toUnifiedItem(rawItem);
  const keys = [];
  if (u.id) keys.push(String(u.id));
  const mUri = normalizeNativeUri(u._meta?.mastodon?.uri || '');
  if (mUri) keys.push(mUri);
  const bUri = String(u._meta?.bluesky?.uri || '').trim();
  if (bUri) keys.push(bUri);
  const normUrl = normalizeNativeUri(u.url || '');
  if (normUrl) keys.push(normUrl);
  return [...new Set(keys)];
}

export function applyViewerInteractionsToItem(rawItem, ledger = feedStore.get().viewerInteractions) {
  if (!rawItem || typeof rawItem !== 'object') return rawItem;
  const u = toUnifiedItem(rawItem);
  if (!ledger || typeof ledger !== 'object') return u;
  const keys = getViewerInteractionKeys(u);
  let entry = null;
  for (const k of keys) {
    if (ledger[k] && typeof ledger[k] === 'object') {
      entry = ledger[k];
      break;
    }
  }
  if (!entry) return u;

  const nextMeta = { ...(u._meta || {}) };
  let changed = false;

  if (u.protocol === 'mastodon' || u._meta?.mastodon) {
    const pm = u._meta?.mastodon || {};
    const nextM = { ...pm };
    if (typeof entry.favourited === 'boolean' && Boolean(pm.favourited) !== entry.favourited) {
      nextM.favourited = entry.favourited;
      changed = true;
    }
    if (typeof entry.reblogged === 'boolean' && Boolean(pm.reblogged) !== entry.reblogged) {
      nextM.reblogged = entry.reblogged;
      changed = true;
    }
    if (typeof entry.bookmarked === 'boolean' && Boolean(pm.bookmarked) !== entry.bookmarked) {
      nextM.bookmarked = entry.bookmarked;
      changed = true;
    }
    if (entry.replied && !pm.replied) {
      nextM.replied = true;
      changed = true;
    }
    if (changed) nextMeta.mastodon = nextM;
  }

  if (u.protocol === 'bluesky' || u._meta?.bluesky) {
    const pb = u._meta?.bluesky || {};
    const nextB = { ...pb };
    let bChanged = false;
    if (entry.likeUri !== undefined && (pb.likeUri || null) !== (entry.likeUri || null)) {
      nextB.likeUri = entry.likeUri || null;
      bChanged = true;
    }
    if (entry.repostUri !== undefined && (pb.repostUri || null) !== (entry.repostUri || null)) {
      nextB.repostUri = entry.repostUri || null;
      bChanged = true;
    }
    if (entry.replied && !pb.replied) {
      nextB.replied = true;
      bChanged = true;
    }
    if (bChanged) {
      nextMeta.bluesky = nextB;
      changed = true;
    }
  }

  if (entry.replied && !u._meta?.viewerReplied) {
    nextMeta.viewerReplied = true;
    changed = true;
  }

  if (entry.feedFeedback && u._meta?.feedFeedback !== entry.feedFeedback) {
    nextMeta.feedFeedback = entry.feedFeedback;
    changed = true;
  }

  const base = changed ? { ...u, _meta: nextMeta } : u;
  const isNowLiked = Boolean(base._meta?.mastodon?.favourited || base._meta?.bluesky?.likeUri);
  const isNowReposted = Boolean(base._meta?.mastodon?.reblogged || base._meta?.bluesky?.repostUri);
  const floorLikes = isNowLiked ? Math.max(1, Number(entry.minLikes || 1)) : 0;
  const floorReposts = isNowReposted ? Math.max(1, Number(entry.minReposts || 1)) : 0;
  const curLikes = Number(base.metrics?.likes || 0);
  const curReposts = Number(base.metrics?.reposts || 0);
  if (floorLikes > curLikes || floorReposts > curReposts) {
    return reconcileViewerMetricFloors({
      ...base,
      metrics: {
        ...(base.metrics || { replies: 0, reposts: 0, likes: 0 }),
        likes: Math.max(curLikes, floorLikes),
        reposts: Math.max(curReposts, floorReposts),
      },
    });
  }
  return reconcileViewerMetricFloors(base);
}

export function recordViewerInteraction(rawItem) {
  if (!rawItem || typeof rawItem !== 'object') return;
  const u = toUnifiedItem(rawItem);
  const keys = getViewerInteractionKeys(u);
  if (keys.length === 0) return;

  const entry = { ts: Date.now() };
  if (u.protocol === 'mastodon' || u._meta?.mastodon) {
    const m = u._meta?.mastodon || {};
    entry.favourited = Boolean(m.favourited);
    entry.reblogged = Boolean(m.reblogged);
    entry.bookmarked = Boolean(m.bookmarked);
    if (m.replied || u._meta?.viewerReplied) entry.replied = true;
  }
  if (u.protocol === 'bluesky' || u._meta?.bluesky) {
    const b = u._meta?.bluesky || {};
    entry.likeUri = b.likeUri || null;
    entry.repostUri = b.repostUri || null;
    if (b.replied || u._meta?.viewerReplied) entry.replied = true;
  }
  if (u._meta?.viewerReplied) {
    entry.replied = true;
  }
  if (u._meta?.feedFeedback) {
    entry.feedFeedback = u._meta.feedFeedback;
  }
  const hasLiked = Boolean(entry.favourited || entry.likeUri);
  const hasReposted = Boolean(entry.reblogged || entry.repostUri);
  if (hasLiked) {
    entry.minLikes = Math.max(1, Number(u.metrics?.likes || 0));
  }
  if (hasReposted) {
    entry.minReposts = Math.max(1, Number(u.metrics?.reposts || 0));
  }

  const prev = feedStore.get().viewerInteractions || {};
  const next = { ...prev };
  for (const k of keys) {
    next[k] = entry;
  }
  const allKeys = Object.keys(next);
  if (allKeys.length > 500) {
    allKeys
      .sort((a, b) => Number(next[a]?.ts || 0) - Number(next[b]?.ts || 0))
      .slice(0, allKeys.length - 500)
      .forEach((dropKey) => delete next[dropKey]);
  }
  feedStore.set({ viewerInteractions: next });
  void storePut('kv', FEED_VIEWER_INTERACTIONS_KV_KEY, next).catch(() => {});
}

export function mergeDiscoveredViewerInteractions(entries = []) {
  const list = Array.isArray(entries) ? entries : [];
  if (list.length === 0) return;
  const prevState = feedStore.get();
  const prevLedger = prevState.viewerInteractions || {};
  const nextLedger = { ...prevLedger };
  const now = Date.now();
  let ledgerChanged = false;

  for (const raw of list) {
    const keys = (Array.isArray(raw?.keys) ? raw.keys : []).map((k) => String(k || '').trim()).filter(Boolean);
    if (keys.length === 0) continue;
    for (const k of keys) {
      const cur = nextLedger[k] && typeof nextLedger[k] === 'object' ? nextLedger[k] : {};
      const merged = { ...cur, ts: Math.max(Number(cur.ts || 0), now) };
      let entryChanged = false;
      if (raw.favourited && !cur.favourited) {
        merged.favourited = true;
        entryChanged = true;
      }
      if (raw.reblogged && !cur.reblogged) {
        merged.reblogged = true;
        entryChanged = true;
      }
      if (raw.bookmarked && !cur.bookmarked) {
        merged.bookmarked = true;
        entryChanged = true;
      }
      if (raw.replied && !cur.replied) {
        merged.replied = true;
        entryChanged = true;
      }
      if (raw.likeUri && !cur.likeUri) {
        merged.likeUri = raw.likeUri;
        entryChanged = true;
      }
      if (raw.repostUri && !cur.repostUri) {
        merged.repostUri = raw.repostUri;
        entryChanged = true;
      }
      const nextMinLikes = Math.max(Number(cur.minLikes || 0), Number(raw.minLikes || 0));
      if (nextMinLikes > Number(cur.minLikes || 0)) {
        merged.minLikes = nextMinLikes;
        entryChanged = true;
      }
      const nextMinReposts = Math.max(Number(cur.minReposts || 0), Number(raw.minReposts || 0));
      if (nextMinReposts > Number(cur.minReposts || 0)) {
        merged.minReposts = nextMinReposts;
        entryChanged = true;
      }
      if (entryChanged) {
        nextLedger[k] = merged;
        ledgerChanged = true;
      }
    }
  }

  if (!ledgerChanged) return;
  const allKeys = Object.keys(nextLedger);
  if (allKeys.length > 500) {
    allKeys
      .sort((a, b) => Number(nextLedger[a]?.ts || 0) - Number(nextLedger[b]?.ts || 0))
      .slice(0, allKeys.length - 500)
      .forEach((dropKey) => delete nextLedger[dropKey]);
  }

  let anyStreamChanged = false;
  const nextStreams = {};
  for (const [name, bucket] of Object.entries(prevState.streams || {})) {
    let bucketChanged = false;
    const nextItems = (bucket.items || []).map((item) => {
      const updated = applyViewerInteractionsToItem(item, nextLedger);
      if (updated !== item) {
        bucketChanged = true;
      }
      return updated;
    });
    if (bucketChanged) {
      anyStreamChanged = true;
      nextStreams[name] = { ...bucket, items: nextItems };
    } else {
      nextStreams[name] = bucket;
    }
  }

  feedStore.set({
    viewerInteractions: nextLedger,
    ...(anyStreamChanged ? { streams: nextStreams } : {}),
  });
  void storePut('kv', FEED_VIEWER_INTERACTIONS_KV_KEY, nextLedger).catch(() => {});
}

/**
 * Merge and deduplicate timeline UnifiedItems in newest-first chronological order.
 * @param {Array<object>} [existing]
 * @param {Array<object>} [incoming]
 * @returns {Array<object>}
 */
export function mergeChronologicalPosts(existing = [], incoming = []) {
  const byKey = new Map();
  const ledger = feedStore.get().viewerInteractions;
  for (const item of existing) {
    const unified = applyViewerInteractionsToItem(item, ledger);
    const key = getPostIdentityKey(unified);
    if (key) byKey.set(key, unified);
  }
  for (const item of incoming) {
    const unified = applyViewerInteractionsToItem(item, ledger);
    const key = getPostIdentityKey(unified);
    if (!key) continue;
    const prev = byKey.get(key);
    byKey.set(key, prev ? mergePostMutation(prev, unified) : unified);
  }
  const ownAccounts = authStore.get().accounts || [];
  return deduplicateUnifiedItems([...byKey.values()], 120_000, { ownAccounts })
    .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a));
}

export function setActiveStream(streamName, activeListId = null) {
  feedStore.set({
    activeStream: streamName,
    ...(streamName === 'list' && activeListId !== null ? { activeListId } : {}),
  });
}

export function setStreamLoading(loading, error = null) {
  feedStore.set({ loading: Boolean(loading), error });
}

export function setStreamItems(streamName, items, nextCursor = null, options = {}) {
  const prev = feedStore.get();
  const prevGen = prev.streams[streamName]?.generation || 0;
  const deduped = mergeChronologicalPosts([], items).map((it) => applyKnownMetrics(it));
  const shuffleSeed = typeof options?.shuffleSeed === 'string' || typeof options?.shuffleSeed === 'number'
    ? String(options.shuffleSeed)
    : '';
  const deprioritizeIds = Array.isArray(options?.deprioritizeIds)
    ? options.deprioritizeIds.map((id) => String(id || '')).filter(Boolean)
    : [];
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: deduped,
        nextCursor,
        updatedAt: Date.now(),
        generation: prevGen + 1,
        shuffleSeed,
        deprioritizeIds,
      },
    },
    loading: false,
    error: null,
  });
}

export function appendStreamItems(streamName, items, nextCursor = null) {
  const prev = feedStore.get();
  const bucket = prev.streams[streamName] || createEmptyStreamBucket();
  const ledger = prev.viewerInteractions;
  const existingUnified = (bucket.items || []).map((it) => toUnifiedItem(it));
  const incomingUnified = (Array.isArray(items) ? items : []).map((it) =>
    applyKnownMetrics(applyViewerInteractionsToItem(it, ledger))
  );
  const ownAccounts = authStore.get().accounts || [];
  const { nextExisting, appended } = deduplicateAppendItems(existingUnified, incomingUnified, { ownAccounts });
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: [...nextExisting, ...appended],
        nextCursor,
        updatedAt: Date.now(),
        generation: bucket.generation || 0,
        shuffleSeed: bucket.shuffleSeed || '',
        deprioritizeIds: Array.isArray(bucket.deprioritizeIds) ? bucket.deprioritizeIds : [],
      },
    },
    loading: false,
    error: null,
  });
}

export function prependStreamItem(streamName, item) {
  const prev = feedStore.get();
  const bucket = prev.streams[streamName] || createEmptyStreamBucket();
  const unified = applyViewerInteractionsToItem(item, prev.viewerInteractions);
  const key = getPostIdentityKey(unified);
  if (!key) return;
  const existingUnified = (bucket.items || [])
    .map((it) => toUnifiedItem(it))
    .filter((it) => getPostIdentityKey(it) !== key);
  const ownAccounts = authStore.get().accounts || [];
  const { nextExisting, appended } = deduplicateAppendItems([unified], existingUnified, { ownAccounts });
  const head = nextExisting[0] || unified;
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: [head, ...appended],
        nextCursor: bucket.nextCursor || null,
        updatedAt: Date.now(),
        generation: bucket.generation || 0,
      },
    },
    loading: false,
    error: null,
  });
}

export function setUserLists(lists) {
  feedStore.set({ lists: Array.isArray(lists) ? lists : [] });
}

export function setFilterRules(filters) {
  feedStore.set({ filters: Array.isArray(filters) ? filters : [] });
}

/**
 * Merge a post update into an existing UnifiedItem while preserving stream identity,
 * Mastodon boost banners (`rebloggedBy`), bridged IDs, and cross-protocol metric breakdowns.
 */
export function mergePostMutation(prevItem, nextItem) {
  const prev = toUnifiedItem(prevItem);
  if (!nextItem || typeof nextItem !== 'object') return prev;
  const next = toUnifiedItem(nextItem);
  const mergedMeta = { ...(prev._meta || {}), ...(next._meta || {}) };

  if (prev._meta?.mastodon || next._meta?.mastodon) {
    const pm = prev._meta?.mastodon || {};
    const nm = next._meta?.mastodon || {};
    const mergedMasto = {
      ...pm,
      ...nm,
      statusId: pm.statusId || nm.statusId || '',
      instanceUrl: pm.instanceUrl || nm.instanceUrl || 'https://mastodon.social',
      wrapperId: pm.wrapperId || nm.wrapperId || '',
    };
    if (pm.rebloggedBy) mergedMasto.rebloggedBy = pm.rebloggedBy;
    else delete mergedMasto.rebloggedBy;
    mergedMeta.mastodon = mergedMasto;
  }

  if (prev._meta?.bluesky || next._meta?.bluesky) {
    const pb = prev._meta?.bluesky || {};
    const nb = next._meta?.bluesky || {};
    const mergedBsky = { ...pb, ...nb };
    if (pb.rebloggedBy) mergedBsky.rebloggedBy = pb.rebloggedBy;
    else delete mergedBsky.rebloggedBy;
    mergedMeta.bluesky = mergedBsky;
  }

  if (next._meta?.linkCard || prev._meta?.linkCard) {
    mergedMeta.linkCard = next._meta?.linkCard || prev._meta?.linkCard;
  }
  if (next._meta?.linkedIds || prev._meta?.linkedIds) {
    mergedMeta.linkedIds = {
      ...(prev._meta?.linkedIds || {}),
      ...(next._meta?.linkedIds || {}),
    };
  }

  let mergedMetrics = next.metrics || prev.metrics || { replies: 0, reposts: 0, likes: 0 };
  if (
    nextItem?._meta?.metricsBreakdown &&
    typeof nextItem._meta.metricsBreakdown === 'object' &&
    nextItem._meta.metricsBreakdown !== prev._meta?.metricsBreakdown
  ) {
    mergedMeta.metricsBreakdown = nextItem._meta.metricsBreakdown;
    mergedMetrics = sumMetricsBreakdown(mergedMeta.metricsBreakdown);
  } else if (
    prev._meta?.metricsBreakdown &&
    typeof prev._meta.metricsBreakdown === 'object' &&
    prev._meta.metricsBreakdown[prev.protocol] &&
    typeof prev._meta.metricsBreakdown[prev.protocol] === 'object'
  ) {
    const prevProto = prev._meta.metricsBreakdown[prev.protocol];
    const nextLikes = Number(next.metrics?.likes ?? prevProto.likes ?? 0);
    const nextReplies = Number(next.metrics?.replies ?? prevProto.replies ?? 0);
    const nextReposts = Number(next.metrics?.reposts ?? prevProto.reposts ?? 0);
    mergedMeta.metricsBreakdown = {
      ...prev._meta.metricsBreakdown,
      [prev.protocol]: {
        ...prevProto,
        likes: nextLikes,
        replies: nextReplies,
        reposts: nextReposts,
      },
    };
    mergedMetrics = sumMetricsBreakdown(mergedMeta.metricsBreakdown);
  }

  const explicitAttachments =
    Array.isArray(nextItem?.attachments) ||
    Array.isArray(nextItem?.media) ||
    Array.isArray(nextItem?.media_attachments);
  const nextAtts = Array.isArray(next.attachments) ? next.attachments : [];
  const prevAtts = Array.isArray(prev.attachments) ? prev.attachments : [];
  const useNextAttachments =
    Boolean(nextItem?._clearAttachments) ||
    (explicitAttachments && (nextAtts.length > 0 || prevAtts.length === 0));

  return {
    ...prev,
    ...next,
    id: prev.id || next.id,
    protocol: prev.protocol || next.protocol,
    url: next.url || prev.url || '',
    content_html: next.content_html || prev.content_html || '',
    date_published: prev.date_published || next.date_published,
    author: next.author?.id || next.author?.handle ? { ...prev.author, ...next.author } : prev.author,
    attachments: useNextAttachments ? nextAtts : prevAtts,
    metrics: mergedMetrics,
    _meta: mergedMeta,
  };
}

export function mutatePostAcrossStreams(predicateOrKey, updater) {
  const match = typeof predicateOrKey === 'function'
    ? predicateOrKey
    : (item) => getPostIdentityKey(item) === predicateOrKey || item._meta?.mastodon?.statusId === predicateOrKey;

  const prev = feedStore.get();
  let anyStreamChanged = false;
  let lastUpdated = null;
  const nextStreams = {};

  for (const [name, bucket] of Object.entries(prev.streams)) {
    let bucketChanged = false;
    const nextItems = bucket.items.map((item) => {
      if (!match(item)) return item;
      const candidate = updater(item);
      if (!candidate || candidate === item) return item;
      const updated = mergePostMutation(item, candidate);
      lastUpdated = updated;
      bucketChanged = true;
      return updated;
    });
    if (bucketChanged) {
      anyStreamChanged = true;
      nextStreams[name] = { ...bucket, items: nextItems };
    } else {
      nextStreams[name] = bucket;
    }
  }

  if (anyStreamChanged) {
    feedStore.set({ streams: nextStreams });
    if (lastUpdated) {
      recordViewerInteraction(lastUpdated);
      recordItemMetrics(lastUpdated);
    }
  }
}

export function reconcileEnrichedStreamItems(enrichedItems = []) {
  const enrichedList = Array.isArray(enrichedItems) ? enrichedItems.filter((it) => it?.id) : [];
  if (enrichedList.length === 0) return;
  for (const item of enrichedList) {
    recordItemMetrics(item);
  }
  const byId = new Map(enrichedList.map((it) => [String(it.id), it]));
  const ownAccounts = authStore.get().accounts || [];

  const prev = feedStore.get();
  let anyStreamChanged = false;
  const nextStreams = {};

  for (const [name, bucket] of Object.entries(prev.streams)) {
    let bucketChanged = false;
    let nextItems = (bucket.items || []).map((item) => {
      const enriched = item?.id ? byId.get(String(item.id)) : null;
      if (!enriched || enriched === item) return item;
      const nextLinked = enriched._meta?.linkedIds || null;
      const prevLinked = item._meta?.linkedIds || null;
      const linkedChanged =
        Boolean(nextLinked) && JSON.stringify(nextLinked) !== JSON.stringify(prevLinked);
      if (
        enriched.metrics?.likes !== item.metrics?.likes ||
        enriched.metrics?.replies !== item.metrics?.replies ||
        enriched.metrics?.reposts !== item.metrics?.reposts ||
        Boolean(enriched._meta?.metricsBreakdown) !== Boolean(item._meta?.metricsBreakdown) ||
        linkedChanged
      ) {
        bucketChanged = true;
        const merged = mergePostMutation(item, enriched);
        return {
          ...merged,
          _meta: mergeViewerActivityMeta(merged._meta, item._meta),
        };
      }
      return item;
    });

    const hasAnyLinks = nextItems.some((it) => {
      const l = it?._meta?.linkedIds;
      return Boolean(l && typeof l === 'object' && Object.values(l).some(Boolean));
    });
    if (hasAnyLinks && nextItems.length > 1) {
      const linkTokensOf = (it) => {
        const out = [];
        const l = it?._meta?.linkedIds;
        if (l && typeof l === 'object') {
          if (l.mastodonStatusId) out.push(`masto:${String(l.mastodonStatusId)}`);
          if (l.blueskyUri) out.push(`bsky:${String(l.blueskyUri)}`);
          if (l.threadsPostId) out.push(`threads:${String(l.threadsPostId)}`);
        }
        if (it?.protocol === 'mastodon' && it?._meta?.mastodon?.statusId) {
          out.push(`masto:${String(it._meta.mastodon.statusId)}`);
        } else if (it?.protocol === 'bluesky' && it?._meta?.bluesky?.uri) {
          out.push(`bsky:${String(it._meta.bluesky.uri)}`);
        } else if (it?.protocol === 'threads' && it?._meta?.threads?.postId) {
          out.push(`threads:${String(it._meta.threads.postId)}`);
        }
        return out;
      };
      const hasLinkedIdsObj = (it) => {
        const l = it?._meta?.linkedIds;
        return Boolean(l && typeof l === 'object' && Object.values(l).some(Boolean));
      };

      const tokenOwner = new Map();
      const keptSlots = [];
      for (const cur of nextItems) {
        const tokens = linkTokensOf(cur);
        const curHasLinks = hasLinkedIdsObj(cur);
        let matchedSlotIdx = -1;
        for (const tok of tokens) {
          if (!tokenOwner.has(tok)) continue;
          const candidateSlot = tokenOwner.get(tok);
          if (curHasLinks || hasLinkedIdsObj(keptSlots[candidateSlot])) {
            matchedSlotIdx = candidateSlot;
            break;
          }
        }
        if (matchedSlotIdx >= 0) {
          bucketChanged = true;
          const existing = keptSlots[matchedSlotIdx];
          const mergedPair = deduplicateUnifiedItems([existing, cur], 120_000, { ownAccounts });
          const survivor = mergedPair[0] || mergePostMutation(existing, cur);
          keptSlots[matchedSlotIdx] = survivor;
          for (const tok of linkTokensOf(survivor)) {
            tokenOwner.set(tok, matchedSlotIdx);
          }
        } else {
          const slotIdx = keptSlots.length;
          keptSlots.push(cur);
          for (const tok of tokens) {
            tokenOwner.set(tok, slotIdx);
          }
        }
      }
      if (keptSlots.length < nextItems.length) {
        nextItems = keptSlots;
      }
    }

    if (bucketChanged) {
      anyStreamChanged = true;
      nextStreams[name] = { ...bucket, items: nextItems };
    } else {
      nextStreams[name] = bucket;
    }
  }

  if (anyStreamChanged) {
    feedStore.set({ streams: nextStreams });
  }
}

export function removePostAcrossStreams(predicateOrKey) {
  const match = typeof predicateOrKey === 'function'
    ? predicateOrKey
    : (item) =>
        getPostIdentityKey(item) === predicateOrKey ||
        item._meta?.mastodon?.statusId === String(predicateOrKey).replace(/^mastodon:/, '');

  const prev = feedStore.get();
  let anyChanged = false;
  const nextStreams = {};
  for (const [name, bucket] of Object.entries(prev.streams)) {
    const filtered = bucket.items.filter((item) => !match(item));
    if (filtered.length !== bucket.items.length) {
      anyChanged = true;
      nextStreams[name] = { ...bucket, items: filtered };
    } else {
      nextStreams[name] = bucket;
    }
  }
  if (anyChanged) {
    feedStore.set({ streams: nextStreams });
  }
}

export async function persistStreamCache(streamName) {
  const bucket = feedStore.get().streams[streamName];
  if (!bucket) return;
  const isDiscovery = ROLLING_DISCOVERY_STREAMS.has(streamName);
  const now = Date.now();
  let items = Array.isArray(bucket.items) ? bucket.items : [];
  if (isDiscovery) {
    items = items
      .filter((it) => it && (now - Number(it._cachedAt || now)) <= STREAM_CACHE_TTL_MS)
      .map((it) => (it._cachedAt ? it : { ...it, _cachedAt: now }))
      .slice(0, 350);
  }
  const payload = isDiscovery
    ? { ...bucket, items, harvesterVersion: HARVESTER_CACHE_VERSION, cachedAt: now }
    : bucket;
  await storePut('timeline_cache', streamName, payload);
}

export async function hydrateCachedStream(streamName) {
  await hydrateMetricsLedger();
  const cached = await storeGet('timeline_cache', streamName);
  if (!cached || !Array.isArray(cached.items)) return null;
  const isDiscovery = ROLLING_DISCOVERY_STREAMS.has(streamName);
  if (isDiscovery) {
    if (Number(cached.harvesterVersion || 0) < HARVESTER_CACHE_VERSION) return null;
    const now = Date.now();
    if (cached.cachedAt && now - Number(cached.cachedAt) > STREAM_CACHE_TTL_MS) {
      return null;
    }
  }
  const now = Date.now();
  const validItems = isDiscovery
    ? cached.items.filter((it) => it && (now - Number(it._cachedAt || cached.cachedAt || cached.updatedAt || now)) <= STREAM_CACHE_TTL_MS)
    : cached.items;
  if (isDiscovery && validItems.length === 0) return null;
  const prev = feedStore.get();
  const prevGen = prev.streams[streamName]?.generation || 0;
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: mergeChronologicalPosts([], validItems).map((it) => applyKnownMetrics(it)),
        nextCursor: cached.nextCursor || null,
        updatedAt: cached.updatedAt || 0,
        generation: prevGen + 1,
      },
    },
  });
  return cached;
}

const CACHED_FILTERS_KV_KEY = 'cached_keyword_filters';

export async function persistCachedFilters(filters) {
  await storePut('kv', CACHED_FILTERS_KV_KEY, Array.isArray(filters) ? filters : []);
}

export async function hydrateCachedFilters() {
  const cached = await storeGet('kv', CACHED_FILTERS_KV_KEY);
  if (!Array.isArray(cached) || cached.length === 0) return null;
  if ((feedStore.get().filters?.length || 0) === 0) {
    setFilterRules(cached);
  }
  return cached;
}

export function setModeratedActors(actors = []) {
  const clean = [
    ...new Set(
      (Array.isArray(actors) ? actors : [])
        .map((a) => String(a || '').trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
  feedStore.set({ moderatedActors: clean });
  return clean;
}

export async function hydrateCachedModeration() {
  const { blocks = [], mutes = [] } = await getLocalModeratedAccounts().catch(() => ({ blocks: [], mutes: [] }));
  const actors = [];
  for (const row of [...blocks, ...mutes]) {
    if (!row) continue;
    const rawProto = String(row.protocol || 'threads').trim().toLowerCase();
    const proto = rawProto === 'fediverse' ? 'mastodon' : rawProto;
    if (row.canonicalActor) {
      actors.push(String(row.canonicalActor).trim().toLowerCase());
    }
    const handleVal = String(row.acct || row.username || row.handle || '').trim().replace(/^@/, '').toLowerCase();
    if (handleVal) {
      const canon = canonicalizeActorHandle(handleVal, proto);
      if (canon && canon !== `${proto}:`) actors.push(canon);
    }
    const idVal = String(row.id || row.did || '').trim().toLowerCase();
    if (idVal) {
      actors.push(idVal.includes(':') && !idVal.startsWith('did:') ? idVal : `${proto}:${idVal}`);
      if (idVal.startsWith('did:')) actors.push(idVal);
    }
  }
  return setModeratedActors(actors);
}

export async function purgeModeratedAuthorAffinity(actorKeys = []) {
  const keySet = new Set(
    (Array.isArray(actorKeys) ? actorKeys : [])
      .map((k) => String(k || '').trim().toLowerCase())
      .filter(Boolean)
  );
  if (keySet.size === 0) return;
  const cur = feedStore.get();
  const prevInteracted = cur.interactedAuthors || {};
  let changedInt = false;
  const nextInteracted = {};
  for (const [k, v] of Object.entries(prevInteracted)) {
    if (keySet.has(k.toLowerCase())) {
      changedInt = true;
    } else {
      nextInteracted[k] = v;
    }
  }
  if (changedInt) {
    feedStore.set({ interactedAuthors: nextInteracted });
    await storePut('kv', FEED_RECIPROCITY_KV_KEY, nextInteracted).catch(() => {});
  }
}

export function setSemanticScores(scoresMap = {}) {
  const clean = scoresMap && typeof scoresMap === 'object' ? scoresMap : {};
  feedStore.set({ semanticScores: { ...clean } });
}

export function setTasteScores(scoresMap = {}) {
  const clean = scoresMap && typeof scoresMap === 'object' ? scoresMap : {};
  feedStore.set({ tasteScores: { ...clean } });
}

function trimScoreCache(mapObj, maxEntries = 600) {
  const keys = Object.keys(mapObj);
  if (keys.length <= maxEntries) return mapObj;
  const trimmed = {};
  for (const k of keys.slice(keys.length - maxEntries)) {
    trimmed[k] = mapObj[k];
  }
  return trimmed;
}

export function mergeSemanticFeedScores({ scores = {}, axisScores = {}, tasteScores = {}, replaceTaste = false } = {}) {
  const st = feedStore.get();
  const nextSemantic = { ...(st.semanticScores || {}) };
  let semChanged = false;

  if (axisScores && typeof axisScores === 'object') {
    for (const [id, axes] of Object.entries(axisScores)) {
      if (!id || !axes || typeof axes !== 'object') continue;
      nextSemantic[id] = { ...(typeof nextSemantic[id] === 'object' && nextSemantic[id] ? nextSemantic[id] : {}), ...axes };
      semChanged = true;
    }
  }
  if (scores && typeof scores === 'object') {
    for (const [id, val] of Object.entries(scores)) {
      const num = Number(val);
      if (!id || !Number.isFinite(num)) continue;
      const prev = typeof nextSemantic[id] === 'object' && nextSemantic[id] ? nextSemantic[id] : {};
      nextSemantic[id] = { ...prev, channelMatch: num };
      semChanged = true;
    }
  }

  let nextTaste = replaceTaste ? {} : { ...(st.tasteScores || {}) };
  let tasteChanged = Boolean(replaceTaste && Object.keys(st.tasteScores || {}).length > 0);
  if (tasteScores && typeof tasteScores === 'object') {
    for (const [id, val] of Object.entries(tasteScores)) {
      const num = Number(val);
      if (!id || !Number.isFinite(num)) continue;
      nextTaste[id] = num;
      tasteChanged = true;
    }
  }

  const patch = {};
  if (semChanged) patch.semanticScores = trimScoreCache(nextSemantic, 600);
  if (tasteChanged) patch.tasteScores = trimScoreCache(nextTaste, 600);
  if (Object.keys(patch).length > 0) {
    feedStore.set(patch);
  }
}

function resolveAffinityAuthorKey(itemOrAuthor, protocol = 'mastodon') {
  const authorObj = itemOrAuthor?.author || itemOrAuthor;
  if (!authorObj || typeof authorObj !== 'object') return '';
  const proto = itemOrAuthor?.protocol || protocol || 'mastodon';
  const rawHandle = authorObj.handle || authorObj.acct || authorObj.username || '';
  let key = canonicalizeActorHandle(rawHandle, proto);
  if (!key || key === `${proto}:`) {
    key = authorObj.id ? `${proto}:${authorObj.id}` : '';
  }
  return key;
}

function updateBoundedAffinityMap(prevMap, authorKey, delta, { min = -20, max = 40 } = {}) {
  const next = { ...(prevMap && typeof prevMap === 'object' ? prevMap : {}) };
  const clamped = Number(Math.max(min, Math.min(max, Number(next[authorKey] || 0) + delta)).toFixed(2));
  if (clamped === 0) {
    delete next[authorKey];
  } else {
    next[authorKey] = clamped;
  }
  const keys = Object.keys(next);
  if (keys.length > 250) {
    keys
      .sort((a, b) => Math.abs(Number(next[a] || 0)) - Math.abs(Number(next[b] || 0)))
      .slice(0, keys.length - 250)
      .forEach((dropKey) => delete next[dropKey]);
  }
  return next;
}

export async function recordAuthorInteraction(itemOrAuthor, protocol = 'mastodon', weight = 1) {
  const ownAccountKeys = buildOwnAccountKeySet(authStore.get().accounts || []);
  const authorObj = itemOrAuthor?.author || itemOrAuthor;
  const proto = itemOrAuthor?.protocol || protocol || 'mastodon';
  const instUrl = itemOrAuthor?._meta?.mastodon?.instanceUrl || '';
  if (actorMatchesOwnAccountSet(authorObj, proto, instUrl, ownAccountKeys)) return;
  const key = resolveAffinityAuthorKey(itemOrAuthor, protocol);
  if (!key) return;
  const numWeight = Number(weight);
  const delta = Number.isFinite(numWeight) && numWeight !== 0 ? numWeight : 1;
  const next = updateBoundedAffinityMap(feedStore.get().interactedAuthors, key, delta, { min: -20, max: 12 });
  feedStore.set({ interactedAuthors: next });
  await storePut('kv', FEED_RECIPROCITY_KV_KEY, next).catch(() => {});
}

const BEHAVIORAL_SIGNAL_CONFIG = Object.freeze({
  like: { polarity: 'positive', exemplarWeight: 1.5 },
  repost: { polarity: 'positive', exemplarWeight: 1.8 },
  bookmark: { polarity: 'positive', exemplarWeight: 1.6 },
  reply: { polarity: 'positive', exemplarWeight: 2.0 },
  share_sanctuary: { polarity: 'positive', exemplarWeight: 1.6 },
  interested: { polarity: 'positive', exemplarWeight: 3.5 },
  not_interested: { polarity: 'negative', exemplarWeight: 4.0 },
});

function buildTasteSnippet(u) {
  return [
    u?.content_text || u?.text || '',
    u?._meta?.linkCard?.title || '',
    u?._meta?.quotePost?.text || '',
  ]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 420);
}

/**
 * Sample recent original posts from the user's `following` stream as soft content-style anchors
 * (lighter weight than explicit interactions) so discovery ranking reflects who they follow
 * without injecting those authors' direct posts into Feed.
 */
export function buildFollowingStyleAnchors(followingItems = [], { maxAnchors = 14, excludeIds = [] } = {}) {
  const list = Array.isArray(followingItems) ? followingItems : [];
  if (list.length === 0 || maxAnchors <= 0) return [];
  const excluded = new Set((Array.isArray(excludeIds) ? excludeIds : []).map((id) => String(id || '')));
  const ownAccountKeys = buildOwnAccountKeySet(authStore.get().accounts || []);
  const perAuthorCounts = new Map();
  const anchors = [];

  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const u = toUnifiedItem(raw);
    const isBoost = Boolean(
      u?._meta?.mastodon?.rebloggedBy
      || u?._meta?.bluesky?.rebloggedBy
      || u?._meta?.bluesky?.repostedBy
      || u?._meta?.threads?.isRepost
    );
    if (isBoost) continue;
    if (actorMatchesOwnAccountSet(u.author, u.protocol, u._meta?.mastodon?.instanceUrl || '', ownAccountKeys)) continue;
    const postKey = getPostIdentityKey(u);
    if (!postKey || excluded.has(postKey)) continue;
    const snippet = buildTasteSnippet(u);
    if (snippet.length < 25) continue;
    const authorKey = resolveAffinityAuthorKey(u, u.protocol) || 'unknown';
    const seenByAuthor = perAuthorCounts.get(authorKey) || 0;
    if (seenByAuthor >= 2) continue;
    perAuthorCounts.set(authorKey, seenByAuthor + 1);
    excluded.add(postKey);
    anchors.push({
      id: postKey,
      text: snippet,
      weight: 0.35,
      ts: Date.parse(u?.date_published || '') || 0,
      source: 'following_style',
    });
    if (anchors.length >= maxAnchors) break;
  }
  return anchors;
}

export function mergeTasteMemoryWithFollowing(tasteMemory, followingItems = [], maxPositive = 40) {
  const basePos = Array.isArray(tasteMemory?.positive) ? tasteMemory.positive : [];
  const baseNeg = Array.isArray(tasteMemory?.negative) ? tasteMemory.negative : [];
  const remainingSlots = Math.max(0, maxPositive - basePos.length);
  const softCap = Math.min(14, Math.max(6, remainingSlots));
  const excludeIds = basePos.map((e) => e?.id).filter(Boolean);
  const anchors = buildFollowingStyleAnchors(followingItems, { maxAnchors: softCap, excludeIds });
  return {
    positive: [...basePos, ...anchors].slice(0, maxPositive),
    negative: baseNeg,
  };
}

/**
 * Record explicit behavioral signals (like, repost, bookmark, reply, share_sanctuary,
 * interested, not_interested) locally in feedStore. Passive scroll/dwell signals are ignored.
 */
export async function recordBehavioralSignal(rawItem, signal = 'like') {
  const cfg = BEHAVIORAL_SIGNAL_CONFIG[signal];
  if (!cfg || !rawItem || typeof rawItem !== 'object') return;
  const u = toUnifiedItem(rawItem);
  const ownAccountKeys = buildOwnAccountKeySet(authStore.get().accounts || []);
  if (actorMatchesOwnAccountSet(u.author, u.protocol, u._meta?.mastodon?.instanceUrl || '', ownAccountKeys)) return;
  tasteMutationEpoch += 1;
  let saveTaste = null;

  const snippet = buildTasteSnippet(u);
  const postKey = getPostIdentityKey(u);
  if (cfg.polarity && postKey && snippet.length >= 20) {
    const curTaste = feedStore.get().tasteMemory || { positive: [], negative: [] };
    const prevPos = Array.isArray(curTaste.positive) ? curTaste.positive : [];
    const prevNeg = Array.isArray(curTaste.negative) ? curTaste.negative : [];
    const now = Date.now();
    if (cfg.polarity === 'positive') {
      const existing = prevPos.find((e) => e?.id === postKey);
      const entry = {
        id: postKey,
        text: snippet,
        weight: Number(Math.max(Number(existing?.weight || 0), cfg.exemplarWeight).toFixed(2)),
        ts: now,
      };
      saveTaste = {
        positive: [entry, ...prevPos.filter((e) => e?.id !== postKey)].slice(0, 40),
        negative: prevNeg.filter((e) => e?.id !== postKey),
      };
    } else {
      const existing = prevNeg.find((e) => e?.id === postKey);
      const entry = {
        id: postKey,
        text: snippet,
        weight: Number(Math.max(Number(existing?.weight || 0), cfg.exemplarWeight).toFixed(2)),
        ts: now,
      };
      saveTaste = {
        positive: prevPos.filter((e) => e?.id !== postKey),
        negative: [entry, ...prevNeg.filter((e) => e?.id !== postKey)].slice(0, 25),
      };
    }
    feedStore.set({ tasteMemory: saveTaste });
    await storePut('kv', FEED_TASTE_MEMORY_KV_KEY, saveTaste).catch(() => {});
  }
}

export async function clearLearnedTasteMemory() {
  tasteMutationEpoch += 1;
  const emptyTaste = { positive: [], negative: [] };
  feedStore.set({
    tasteScores: {},
    tasteMemory: emptyTaste,
  });
  globalThis.dispatchEvent?.(new Event('sanctuary:taste-reset'));
  try {
    await storeDelete('kv', FEED_TASTE_MEMORY_KV_KEY);
    await storePut('kv', FEED_TASTE_MEMORY_KV_KEY, emptyTaste);
  } catch (err) {
    console.warn('[feedStore] Failed to persist cleared taste memory:', err);
  }
}

/**
 * Clear custom discovery sources, explicit author affinity & taste memory, and cached Feed stream.
 */
export async function resetFeedBlankSlate() {
  tasteMutationEpoch += 1;
  const emptyTaste = { positive: [], negative: [] };
  const prev = feedStore.get();
  feedStore.set({
    interactedAuthors: {},
    viewerInteractions: {},
    semanticScores: {},
    tasteScores: {},
    tasteMemory: emptyTaste,
    streams: {
      ...prev.streams,
      feed: createEmptyStreamBucket(),
      photos: createEmptyStreamBucket(),
      video: createEmptyStreamBucket(),
      visual: createEmptyStreamBucket(),
    },
  });
  globalThis.dispatchEvent?.(new Event('sanctuary:taste-reset'));
  await storePut('kv', FEED_TASTE_MEMORY_KV_KEY, emptyTaste).catch(() => {});
  await storePut('kv', FEED_RECIPROCITY_KV_KEY, {}).catch(() => {});
  await storePut('kv', FEED_VIEWER_INTERACTIONS_KV_KEY, {}).catch(() => {});
  const updated = await updateFeedTuning(
    {
      discoveryChannels: [],
      discoveryInstances: [],
    },
    { updatedBy: 'default' }
  );
  globalThis.dispatchEvent?.(new Event('sanctuary:feed-reset'));
  return updated;
}

/**
 * Record explicit "Interested" / "Not Interested" feedback: updates author affinity,
 * taste memory, and dismisses disliked posts.
 * @param {object} rawPost
 * @param {'interested' | 'not_interested'} [direction]
 * @returns {Promise<object | null>}
 */
export async function applyPostInterestFeedback(rawPost, direction = 'interested') {
  const u = toUnifiedItem(rawPost);
  const postKey = getPostIdentityKey(u);
  const isDislike = direction === 'not_interested';
  await recordAuthorInteraction(u, u.protocol, isDislike ? -4.5 : 3.5);
  await recordBehavioralSignal(u, isDislike ? 'not_interested' : 'interested');

  if (isDislike) {
    if (postKey) {
      const prevDismissed = feedStore.get().dismissedPostIds || [];
      const nextDismissed = [...new Set([...prevDismissed, postKey])].slice(-500);
      feedStore.set({ dismissedPostIds: nextDismissed });
      await storePut('kv', FEED_DISMISSED_POSTS_KV_KEY, nextDismissed).catch(() => {});
      removePostAcrossStreams(postKey);
    }
    return null;
  }

  const updatedItem = {
    ...u,
    _meta: {
      ...(u._meta || {}),
      feedFeedback: 'interested',
    },
  };
  if (postKey) {
    mutatePostAcrossStreams(postKey, () => updatedItem);
  }
  return updatedItem;
}

function preserveLocalSourcesIfOmitted(remoteProfile, localProfile) {
  const base = remoteProfile && typeof remoteProfile === 'object' ? { ...remoteProfile } : {};
  if (!Object.hasOwn(base, 'discoveryChannels')) {
    base.discoveryChannels = Array.isArray(localProfile?.discoveryChannels) ? localProfile.discoveryChannels : [];
  }
  if (!Object.hasOwn(base, 'discoveryInstances')) {
    base.discoveryInstances = Array.isArray(localProfile?.discoveryInstances) ? localProfile.discoveryInstances : [];
  }
  return normalizeFeedTuning(base);
}

export async function updateFeedTuning(patchOrProfile, { syncRemote = true, updatedBy = 'user' } = {}) {
  const cur = feedStore.get().tuning || normalizeFeedTuning(null);
  const candidate = patchOrProfile && typeof patchOrProfile === 'object' ? patchOrProfile : {};
  const effectiveUpdatedBy = candidate.updatedBy || updatedBy || 'user';
  const merged = normalizeFeedTuning({
    version: 2,
    updatedBy: effectiveUpdatedBy,
    updatedAt: Math.max(Date.now(), (Number(cur.updatedAt) || 0) + 1),
    discoveryChannels: candidate.discoveryChannels !== undefined ? candidate.discoveryChannels : cur.discoveryChannels,
    discoveryInstances: candidate.discoveryInstances !== undefined ? candidate.discoveryInstances : cur.discoveryInstances,
  });

  const channelsChanged = JSON.stringify(merged.discoveryChannels || []) !== JSON.stringify(cur.discoveryChannels || []);
  let nextSemanticScores = feedStore.get().semanticScores || {};
  if (channelsChanged && Object.keys(nextSemanticScores).length > 0) {
    const stripped = {};
    for (const [id, entry] of Object.entries(nextSemanticScores)) {
      if (entry && typeof entry === 'object') {
        const { channelMatch: _drop, ...rest } = entry;
        if (Object.keys(rest).length > 0) stripped[id] = rest;
      }
    }
    nextSemanticScores = stripped;
  }

  const bumpUserEpoch = effectiveUpdatedBy !== 'feedback' && effectiveUpdatedBy !== 'remote_sync';
  const nextUserEpoch = bumpUserEpoch
    ? (Number(feedStore.get().userTuningEpoch) || 0) + 1
    : (Number(feedStore.get().userTuningEpoch) || 0);
  feedStore.set({ tuning: merged, semanticScores: nextSemanticScores, userTuningEpoch: nextUserEpoch });
  await storePut('kv', FEED_TUNING_KV_KEY, merged).catch(() => {});

  if (syncRemote && connectionStore.get().mode === 'online' && connectionStore.get().nodeUrl) {
    try {
      const saved = await saveSanctuaryFeedProfile(merged);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        const normalizedRemote = preserveLocalSourcesIfOmitted(saved, merged);
        feedStore.set({ tuning: normalizedRemote });
        await storePut('kv', FEED_TUNING_KV_KEY, normalizedRemote).catch(() => {});
        return normalizedRemote;
      }
    } catch {
      // Offline / desktop node unavailable; keep local SQLite profile
    }
  }
  return merged;
}

export async function syncFeedTuningFromSanctuary() {
  const conn = connectionStore.get();
  if (!conn?.nodeUrl || conn.mode !== 'online') return feedStore.get().tuning;
  try {
    const remote = await fetchSanctuaryFeedProfile();
    if (!remote || typeof remote !== 'object' || Array.isArray(remote)) return feedStore.get().tuning;
    const localCur = feedStore.get().tuning || normalizeFeedTuning(null);
    const normalizedRemote = preserveLocalSourcesIfOmitted(remote, localCur);
    if (normalizedRemote.updatedAt >= (Number(localCur.updatedAt) || 0)) {
      feedStore.set({ tuning: normalizedRemote });
      await storePut('kv', FEED_TUNING_KV_KEY, normalizedRemote).catch(() => {});
      return normalizedRemote;
    }
  } catch {
    // Keep existing local tuning profile when remote endpoint is unavailable
  }
  return feedStore.get().tuning;
}

export function bindSanctuaryFeedSync() {
  if (sanctuarySyncBound) return;
  sanctuarySyncBound = true;
  onSanctuaryEvent('sanctuary:health', (ev) => {
    const remoteTs = Number(ev?.detail?.feed_profile_updated_at || 0);
    const localTs = Number(feedStore.get().tuning?.updatedAt || 0);
    if (remoteTs > localTs && connectionStore.get().mode === 'online') {
      void syncFeedTuningFromSanctuary();
    }
  });
  onSanctuaryEvent('sanctuary:online', (ev) => {
    const remoteTs = Number(ev?.detail?.feed_profile_updated_at || 0);
    const localProfile = feedStore.get().tuning || normalizeFeedTuning(null);
    const localTs = Number(localProfile.updatedAt || 0);
    if (remoteTs > localTs) {
      void syncFeedTuningFromSanctuary();
    } else if (localTs > remoteTs && connectionStore.get().nodeUrl) {
      void saveSanctuaryFeedProfile(localProfile).catch(() => {});
    }
  });
}

export async function hydrateRankingManifest() {
  const cached = await storeGet('kv', RANKING_MANIFEST_KV_KEY).catch(() => null);
  if (cached && typeof cached === 'object' && !Array.isArray(cached)) {
    const normalized = normalizeRankingManifest(cached);
    feedStore.set({ rankingManifest: normalized });
    return normalized;
  }
  return feedStore.get().rankingManifest;
}

export function exportRankingManifest({ pretty = true } = {}) {
  const current = normalizeRankingManifest(feedStore.get().rankingManifest);
  return JSON.stringify(current, null, pretty ? 2 : 0);
}

export async function importRankingManifest(jsonOrObject) {
  const parsed = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : jsonOrObject;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Ranking manifest must be a JSON object.');
  }
  const normalized = normalizeRankingManifest(parsed);
  feedStore.set({
    rankingManifest: normalized,
    userTuningEpoch: (Number(feedStore.get().userTuningEpoch) || 0) + 1,
  });
  await storePut('kv', RANKING_MANIFEST_KV_KEY, normalized).catch(() => {});
  globalThis.dispatchEvent?.(new Event('sanctuary:manifest-updated'));
  return normalized;
}

export async function resetRankingManifest() {
  const fresh = normalizeRankingManifest(null);
  feedStore.set({
    rankingManifest: fresh,
    userTuningEpoch: (Number(feedStore.get().userTuningEpoch) || 0) + 1,
  });
  await storePut('kv', RANKING_MANIFEST_KV_KEY, fresh).catch(() => {});
  globalThis.dispatchEvent?.(new Event('sanctuary:manifest-updated'));
  return fresh;
}

export async function hydrateFeedTuning() {
  bindSanctuaryFeedSync();
  const tasteEpochAtStart = tasteMutationEpoch;
  const [cachedTuning, cachedAuthors, cachedTaste, cachedDismissed, cachedManifest, cachedInteractions] = await Promise.all([
    storeGet('kv', FEED_TUNING_KV_KEY).catch(() => null),
    storeGet('kv', FEED_RECIPROCITY_KV_KEY).catch(() => null),
    storeGet('kv', FEED_TASTE_MEMORY_KV_KEY).catch(() => null),
    storeGet('kv', FEED_DISMISSED_POSTS_KV_KEY).catch(() => null),
    storeGet('kv', RANKING_MANIFEST_KV_KEY).catch(() => null),
    storeGet('kv', FEED_VIEWER_INTERACTIONS_KV_KEY).catch(() => null),
  ]);
  const patch = {};
  if (cachedManifest && typeof cachedManifest === 'object' && !Array.isArray(cachedManifest)) {
    patch.rankingManifest = normalizeRankingManifest(cachedManifest);
  }
  if (cachedTuning && typeof cachedTuning === 'object') {
    const cur = feedStore.get().tuning;
    const norm = normalizeFeedTuning(cachedTuning);
    if (!cur?.updatedAt || norm.updatedAt >= cur.updatedAt) {
      patch.tuning = norm;
    }
  }
  if (cachedAuthors && typeof cachedAuthors === 'object' && !Array.isArray(cachedAuthors)) {
    patch.interactedAuthors = { ...(feedStore.get().interactedAuthors || {}), ...cachedAuthors };
  }
  if (cachedInteractions && typeof cachedInteractions === 'object' && !Array.isArray(cachedInteractions)) {
    patch.viewerInteractions = { ...(feedStore.get().viewerInteractions || {}), ...cachedInteractions };
  }
  if (tasteEpochAtStart === tasteMutationEpoch) {
    if (cachedTaste && typeof cachedTaste === 'object' && !Array.isArray(cachedTaste)) {
      patch.tasteMemory = {
        positive: Array.isArray(cachedTaste.positive) ? cachedTaste.positive.slice(0, 40) : [],
        negative: Array.isArray(cachedTaste.negative) ? cachedTaste.negative.slice(0, 25) : [],
      };
    }
  }
  if (Array.isArray(cachedDismissed)) {
    patch.dismissedPostIds = cachedDismissed.map(String).filter(Boolean).slice(-500);
  }
  if (Object.keys(patch).length > 0) {
    feedStore.set(patch);
  }
  if (connectionStore.get().mode === 'online') {
    await syncFeedTuningFromSanctuary();
  }
  return feedStore.get().tuning;
}

export function resetFeedStoreForTests() {
  tasteMutationEpoch = 0;
  feedStore.set(createInitialFeedState());
}
