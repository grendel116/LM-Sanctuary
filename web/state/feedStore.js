import { normalizeFeedTuning } from '../core/feedRanker.js';
import { canonicalizeActorHandle, toUnifiedItem } from '../core/schema/unifiedItem.js';
import { fetchSanctuaryFeedProfile, saveSanctuaryFeedProfile } from '../queries/sanctuary.js';
import { getLocalModeratedAccounts, storeGet, storePut } from '../storage/nativeStore.js';
import { connectionStore, onSanctuaryEvent } from './sanctuary/connection.js';
import { createStore } from './store.js';

const FEED_TUNING_KV_KEY = 'feed_tuning_profile';
const FEED_RECIPROCITY_KV_KEY = 'feed_interacted_authors';
let sanctuarySyncBound = false;

function createEmptyStreamBucket() {
  return {
    items: [],
    nextCursor: null,
    updatedAt: 0,
    generation: 0,
  };
}

function createInitialFeedState() {
  return {
    activeStream: 'feed',
    streams: {
      feed: createEmptyStreamBucket(),
      following: createEmptyStreamBucket(),
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
    tuning: normalizeFeedTuning(null),
    interactedAuthors: {},
    semanticScores: {},
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

/**
 * Merge and deduplicate timeline UnifiedItems in newest-first chronological order.
 * @param {Array<object>} [existing]
 * @param {Array<object>} [incoming]
 * @returns {Array<object>}
 */
export function mergeChronologicalPosts(existing = [], incoming = []) {
  const byKey = new Map();
  for (const item of existing) {
    const unified = toUnifiedItem(item);
    const key = getPostIdentityKey(unified);
    if (key) byKey.set(key, unified);
  }
  for (const item of incoming) {
    const unified = toUnifiedItem(item);
    const key = getPostIdentityKey(unified);
    if (key) byKey.set(key, unified);
  }
  return [...byKey.values()].sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a));
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

export function setStreamItems(streamName, items, nextCursor = null) {
  const prev = feedStore.get();
  const prevGen = prev.streams[streamName]?.generation || 0;
  const deduped = mergeChronologicalPosts([], items);
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: deduped,
        nextCursor,
        updatedAt: Date.now(),
        generation: prevGen + 1,
      },
    },
    loading: false,
    error: null,
  });
}

export function appendStreamItems(streamName, items, nextCursor = null) {
  const prev = feedStore.get();
  const bucket = prev.streams[streamName] || createEmptyStreamBucket();
  const existingUnified = (bucket.items || []).map((it) => toUnifiedItem(it));
  const seenKeys = new Set(existingUnified.map(getPostIdentityKey).filter(Boolean));
  const orderedIncoming = mergeChronologicalPosts([], items);
  const appended = orderedIncoming.filter((u) => {
    const key = getPostIdentityKey(u);
    if (!key || seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: [...existingUnified, ...appended],
        nextCursor,
        updatedAt: Date.now(),
        generation: bucket.generation || 0,
      },
    },
    loading: false,
    error: null,
  });
}

export function prependStreamItem(streamName, item) {
  const prev = feedStore.get();
  const bucket = prev.streams[streamName] || createEmptyStreamBucket();
  const unified = toUnifiedItem(item);
  const key = getPostIdentityKey(unified);
  if (!key) return;
  const existingUnified = (bucket.items || [])
    .map((it) => toUnifiedItem(it))
    .filter((it) => getPostIdentityKey(it) !== key);
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: [unified, ...existingUnified],
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
    const dLikes = nextLikes - Number(prevProto.likes ?? 0);
    const dReplies = nextReplies - Number(prevProto.replies ?? 0);
    const dReposts = nextReposts - Number(prevProto.reposts ?? 0);
    mergedMeta.metricsBreakdown = {
      ...prev._meta.metricsBreakdown,
      [prev.protocol]: {
        ...prevProto,
        likes: nextLikes,
        replies: nextReplies,
        reposts: nextReposts,
      },
    };
    mergedMetrics = {
      likes: Math.max(0, Number(prev.metrics?.likes || 0) + dLikes),
      replies: Math.max(0, Number(prev.metrics?.replies || 0) + dReplies),
      reposts: Math.max(0, Number(prev.metrics?.reposts || 0) + dReposts),
    };
  }

  const hasNextAttachments =
    Array.isArray(nextItem?.attachments) ||
    Array.isArray(nextItem?.media) ||
    Array.isArray(nextItem?.media_attachments);

  return {
    ...prev,
    ...next,
    id: prev.id || next.id,
    protocol: prev.protocol || next.protocol,
    url: next.url || prev.url || '',
    content_html: next.content_html || prev.content_html || '',
    date_published: prev.date_published || next.date_published,
    author: next.author?.id || next.author?.handle ? { ...prev.author, ...next.author } : prev.author,
    attachments: hasNextAttachments ? next.attachments : prev.attachments,
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
  const nextStreams = {};

  for (const [name, bucket] of Object.entries(prev.streams)) {
    let bucketChanged = false;
    const nextItems = bucket.items.map((item) => {
      if (!match(item)) return item;
      const candidate = updater(item);
      if (!candidate || candidate === item) return item;
      const updated = mergePostMutation(item, candidate);
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
  await storePut('timeline_cache', streamName, bucket);
}

export async function hydrateCachedStream(streamName) {
  const cached = await storeGet('timeline_cache', streamName);
  if (!cached || !Array.isArray(cached.items)) return null;
  const prev = feedStore.get();
  const prevGen = prev.streams[streamName]?.generation || 0;
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: cached.items.map((it) => toUnifiedItem(it)),
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
    const proto = String(row.protocol || 'threads').toLowerCase();
    const u = String(row.username || row.handle || '').trim().replace(/^@/, '').toLowerCase();
    const canon = row.canonicalActor || (u ? canonicalizeActorHandle(u, proto) : '');
    if (canon) actors.push(canon);
  }
  return setModeratedActors(actors);
}

export function setSemanticScores(scoresMap = {}) {
  const clean = scoresMap && typeof scoresMap === 'object' ? scoresMap : {};
  feedStore.set({ semanticScores: { ...clean } });
}

export async function recordAuthorInteraction(itemOrAuthor, protocol = 'mastodon', weight = 1) {
  const authorObj = itemOrAuthor?.author || itemOrAuthor;
  if (!authorObj || typeof authorObj !== 'object') return;
  const proto = itemOrAuthor?.protocol || protocol || 'mastodon';
  const rawHandle = authorObj.handle || authorObj.acct || authorObj.username || '';
  let key = canonicalizeActorHandle(rawHandle, proto);
  if (!key || key === `${proto}:`) {
    key = authorObj.id ? `${proto}:${authorObj.id}` : '';
  }
  if (!key) return;

  const delta = Math.max(0.25, Number(weight) || 1);
  const prev = feedStore.get().interactedAuthors || {};
  const next = { ...prev, [key]: Number((Number(prev[key] || 0) + delta).toFixed(2)) };
  const keys = Object.keys(next);
  if (keys.length > 250) {
    keys
      .sort((a, b) => Number(next[a] || 0) - Number(next[b] || 0))
      .slice(0, keys.length - 250)
      .forEach((dropKey) => delete next[dropKey]);
  }
  feedStore.set({ interactedAuthors: next });
  await storePut('kv', FEED_RECIPROCITY_KV_KEY, next).catch(() => {});
}

export async function updateFeedTuning(patchOrProfile, { syncRemote = true, updatedBy = 'user' } = {}) {
  const cur = feedStore.get().tuning || normalizeFeedTuning(null);
  const candidate = patchOrProfile && typeof patchOrProfile === 'object' ? patchOrProfile : {};
  const merged = normalizeFeedTuning({
    version: 1,
    updatedBy: candidate.updatedBy || updatedBy || 'user',
    updatedAt: Math.max(Date.now(), (Number(cur.updatedAt) || 0) + 1),
    sliders: {
      ...(cur.sliders || {}),
      ...(candidate.sliders && typeof candidate.sliders === 'object' ? candidate.sliders : {}),
    },
    boostConcepts: candidate.boostConcepts !== undefined ? candidate.boostConcepts : cur.boostConcepts,
    dampenConcepts: candidate.dampenConcepts !== undefined ? candidate.dampenConcepts : cur.dampenConcepts,
  });

  feedStore.set({
    tuning: merged,
    ...(merged.boostConcepts.length === 0 && merged.dampenConcepts.length === 0 ? { semanticScores: {} } : {}),
  });
  await storePut('kv', FEED_TUNING_KV_KEY, merged).catch(() => {});

  if (syncRemote && connectionStore.get().mode === 'online' && connectionStore.get().nodeUrl) {
    try {
      const saved = await saveSanctuaryFeedProfile(merged);
      if (saved && saved.sliders) {
        const normalizedRemote = normalizeFeedTuning(saved);
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
    if (!remote || !remote.sliders) return feedStore.get().tuning;
    const normalizedRemote = normalizeFeedTuning(remote);
    const localCur = feedStore.get().tuning || normalizeFeedTuning(null);
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

export async function hydrateFeedTuning() {
  bindSanctuaryFeedSync();
  const [cachedTuning, cachedAuthors] = await Promise.all([
    storeGet('kv', FEED_TUNING_KV_KEY).catch(() => null),
    storeGet('kv', FEED_RECIPROCITY_KV_KEY).catch(() => null),
  ]);
  const patch = {};
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
  if (Object.keys(patch).length > 0) {
    feedStore.set(patch);
  }
  if (connectionStore.get().mode === 'online') {
    await syncFeedTuningFromSanctuary();
  }
  return feedStore.get().tuning;
}

export function resetFeedStoreForTests() {
  feedStore.set(createInitialFeedState());
}
