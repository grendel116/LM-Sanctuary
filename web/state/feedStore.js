import { computeFeedbackSliderNudge, normalizeFeedTuning } from '../core/feedRanker.js';
import {
  canonicalizeActorHandle,
  deduplicateAppendItems,
  deduplicateUnifiedItems,
  toUnifiedItem,
} from '../core/schema/unifiedItem.js';
import { fetchSanctuaryFeedProfile, saveSanctuaryFeedProfile } from '../queries/sanctuary.js';
import { getLocalModeratedAccounts, storeGet, storePut } from '../storage/nativeStore.js';
import { authStore } from './authStore.js';
import { connectionStore, onSanctuaryEvent } from './sanctuary/connection.js';
import { createStore } from './store.js';

const FEED_TUNING_KV_KEY = 'feed_tuning_profile';
const FEED_RECIPROCITY_KV_KEY = 'feed_interacted_authors';
const FEED_IMPLICIT_AUTHORS_KV_KEY = 'feed_implicit_authors_v1';
const FEED_TASTE_MEMORY_KV_KEY = 'feed_taste_memory_v1';
const FEED_DISMISSED_POSTS_KV_KEY = 'feed_dismissed_posts';
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
    dismissedPostIds: [],
    tuning: normalizeFeedTuning(null),
    interactedAuthors: {},
    implicitAuthors: {},
    semanticScores: {},
    tasteScores: {},
    tasteMemory: { positive: [], negative: [] },
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
  const ownAccounts = authStore.get().accounts || [];
  const { nextExisting, appended } = deduplicateAppendItems(existingUnified, items, { ownAccounts });
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: [...nextExisting, ...appended],
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

export function reconcileEnrichedStreamItems(enrichedItems = []) {
  const enrichedList = Array.isArray(enrichedItems) ? enrichedItems.filter((it) => it?.id) : [];
  if (enrichedList.length === 0) return;
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
        return mergePostMutation(item, enriched);
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
  const payload = streamName === 'feed' ? { ...bucket, harvesterVersion: 4 } : bucket;
  await storePut('timeline_cache', streamName, payload);
}

export async function hydrateCachedStream(streamName) {
  const cached = await storeGet('timeline_cache', streamName);
  if (!cached || !Array.isArray(cached.items)) return null;
  if (streamName === 'feed' && Number(cached.harvesterVersion || 0) < 4) return null;
  const prev = feedStore.get();
  const prevGen = prev.streams[streamName]?.generation || 0;
  feedStore.set({
    streams: {
      ...prev.streams,
      [streamName]: {
        items: mergeChronologicalPosts([], cached.items),
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
  const prevImplicit = cur.implicitAuthors || {};
  let changedInt = false;
  let changedImp = false;
  const nextInteracted = {};
  for (const [k, v] of Object.entries(prevInteracted)) {
    if (keySet.has(k.toLowerCase())) {
      changedInt = true;
    } else {
      nextInteracted[k] = v;
    }
  }
  const nextImplicit = {};
  for (const [k, v] of Object.entries(prevImplicit)) {
    if (keySet.has(k.toLowerCase())) {
      changedImp = true;
    } else {
      nextImplicit[k] = v;
    }
  }
  const patch = {};
  if (changedInt) patch.interactedAuthors = nextInteracted;
  if (changedImp) patch.implicitAuthors = nextImplicit;
  if (Object.keys(patch).length > 0) {
    feedStore.set(patch);
  }
  await Promise.all([
    changedInt ? storePut('kv', FEED_RECIPROCITY_KV_KEY, nextInteracted).catch(() => {}) : Promise.resolve(),
    changedImp ? storePut('kv', FEED_IMPLICIT_AUTHORS_KV_KEY, nextImplicit).catch(() => {}) : Promise.resolve(),
  ]);
}

export function setSemanticScores(scoresMap = {}) {
  const clean = scoresMap && typeof scoresMap === 'object' ? scoresMap : {};
  feedStore.set({ semanticScores: { ...clean } });
}

export function setTasteScores(scoresMap = {}) {
  const clean = scoresMap && typeof scoresMap === 'object' ? scoresMap : {};
  feedStore.set({ tasteScores: { ...clean } });
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
  const key = resolveAffinityAuthorKey(itemOrAuthor, protocol);
  if (!key) return;
  const numWeight = Number(weight);
  const delta = Number.isFinite(numWeight) && numWeight !== 0 ? numWeight : 1;
  const next = updateBoundedAffinityMap(feedStore.get().interactedAuthors, key, delta, { min: -20, max: 40 });
  feedStore.set({ interactedAuthors: next });
  await storePut('kv', FEED_RECIPROCITY_KV_KEY, next).catch(() => {});
}

const BEHAVIORAL_SIGNAL_CONFIG = Object.freeze({
  dwell: { implicitDelta: 0.35, polarity: 'positive', exemplarWeight: 0.65 },
  open_thread: { implicitDelta: 0.65, polarity: 'positive', exemplarWeight: 0.9 },
  profile_click: { implicitDelta: 0.5, polarity: null, exemplarWeight: 0 },
  scroll_past: { implicitDelta: -0.18, polarity: 'negative', exemplarWeight: 0.35 },
  like: { implicitDelta: 0, polarity: 'positive', exemplarWeight: 1.5 },
  repost: { implicitDelta: 0, polarity: 'positive', exemplarWeight: 1.8 },
  bookmark: { implicitDelta: 0, polarity: 'positive', exemplarWeight: 1.6 },
  reply: { implicitDelta: 0, polarity: 'positive', exemplarWeight: 2.0 },
  share_sanctuary: { implicitDelta: 0, polarity: 'positive', exemplarWeight: 1.6 },
  interested: { implicitDelta: 0, polarity: 'positive', exemplarWeight: 2.2 },
  not_interested: { implicitDelta: 0, polarity: 'negative', exemplarWeight: 2.2 },
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
 * Record implicit or explicit behavioral signals (dwell, scroll_past, open_thread,
 * profile_click, like, reply, repost, interested, not_interested) locally in feedStore.
 */
export async function recordBehavioralSignal(rawItem, signal = 'dwell') {
  const cfg = BEHAVIORAL_SIGNAL_CONFIG[signal];
  if (!cfg || !rawItem || typeof rawItem !== 'object') return;
  const u = toUnifiedItem(rawItem);
  const patch = {};
  let saveImplicit = null;
  let saveTaste = null;

  if (cfg.implicitDelta !== 0) {
    const authorKey = resolveAffinityAuthorKey(u, u.protocol);
    if (authorKey) {
      saveImplicit = updateBoundedAffinityMap(
        feedStore.get().implicitAuthors,
        authorKey,
        cfg.implicitDelta,
        { min: -1.8, max: 2.5 }
      );
      patch.implicitAuthors = saveImplicit;
    }
  }

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
    patch.tasteMemory = saveTaste;
  }

  if (Object.keys(patch).length > 0) {
    feedStore.set(patch);
  }
  await Promise.all([
    saveImplicit ? storePut('kv', FEED_IMPLICIT_AUTHORS_KV_KEY, saveImplicit).catch(() => {}) : Promise.resolve(),
    saveTaste ? storePut('kv', FEED_TASTE_MEMORY_KV_KEY, saveTaste).catch(() => {}) : Promise.resolve(),
  ]);
}

export async function clearLearnedTasteMemory() {
  const emptyTaste = { positive: [], negative: [] };
  feedStore.set({
    implicitAuthors: {},
    tasteScores: {},
    tasteMemory: emptyTaste,
  });
  await Promise.all([
    storePut('kv', FEED_IMPLICIT_AUTHORS_KV_KEY, {}).catch(() => {}),
    storePut('kv', FEED_TASTE_MEMORY_KV_KEY, emptyTaste).catch(() => {}),
  ]);
}

/**
 * Record explicit "Interested" / "Not Interested" feedback: updates author affinity,
 * nudges matching algorithm sliders slightly, and dismisses disliked posts.
 * @param {object} rawPost
 * @param {'interested' | 'not_interested'} [direction]
 * @returns {Promise<object | null>}
 */
export async function applyPostInterestFeedback(rawPost, direction = 'interested') {
  const u = toUnifiedItem(rawPost);
  const postKey = getPostIdentityKey(u);
  const isDislike = direction === 'not_interested';
  await recordAuthorInteraction(u, u.protocol, isDislike ? -3 : 2.5);
  await recordBehavioralSignal(u, isDislike ? 'not_interested' : 'interested');

  const curTuning = feedStore.get().tuning || normalizeFeedTuning(null);
  const nextSliders = computeFeedbackSliderNudge(curTuning.sliders, u, isDislike ? 'not_interested' : 'interested');
  await updateFeedTuning({ sliders: nextSliders }, { updatedBy: 'feedback' });

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
    discoveryChannels: candidate.discoveryChannels !== undefined ? candidate.discoveryChannels : cur.discoveryChannels,
    discoveryInstances: candidate.discoveryInstances !== undefined ? candidate.discoveryInstances : cur.discoveryInstances,
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
    if (!remote || !remote.sliders) return feedStore.get().tuning;
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

export async function hydrateFeedTuning() {
  bindSanctuaryFeedSync();
  const [cachedTuning, cachedAuthors, cachedImplicit, cachedTaste, cachedDismissed] = await Promise.all([
    storeGet('kv', FEED_TUNING_KV_KEY).catch(() => null),
    storeGet('kv', FEED_RECIPROCITY_KV_KEY).catch(() => null),
    storeGet('kv', FEED_IMPLICIT_AUTHORS_KV_KEY).catch(() => null),
    storeGet('kv', FEED_TASTE_MEMORY_KV_KEY).catch(() => null),
    storeGet('kv', FEED_DISMISSED_POSTS_KV_KEY).catch(() => null),
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
  if (cachedImplicit && typeof cachedImplicit === 'object' && !Array.isArray(cachedImplicit)) {
    patch.implicitAuthors = { ...(feedStore.get().implicitAuthors || {}), ...cachedImplicit };
  }
  if (cachedTaste && typeof cachedTaste === 'object' && !Array.isArray(cachedTaste)) {
    patch.tasteMemory = {
      positive: Array.isArray(cachedTaste.positive) ? cachedTaste.positive.slice(0, 40) : [],
      negative: Array.isArray(cachedTaste.negative) ? cachedTaste.negative.slice(0, 25) : [],
    };
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
  feedStore.set(createInitialFeedState());
}
