import { toUnifiedItem } from '../core/schema/unifiedItem.js';
import { storeGet, storePut } from '../storage/nativeStore.js';
import { createStore } from './store.js';

function createEmptyStreamBucket() {
  return {
    items: [],
    nextCursor: null,
    updatedAt: 0,
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
  const deduped = mergeChronologicalPosts([], items);
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: deduped,
        nextCursor,
        updatedAt: Date.now(),
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
      const updated = toUnifiedItem(updater(item));
      if (updated !== item) bucketChanged = true;
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
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: cached.items.map((it) => toUnifiedItem(it)),
        nextCursor: cached.nextCursor || null,
        updatedAt: cached.updatedAt || 0,
      },
    },
  });
  return cached;
}

export function resetFeedStoreForTests() {
  feedStore.set(createInitialFeedState());
}
