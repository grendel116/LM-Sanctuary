import { isAllowedSocialUrl } from '../constants/endpoints.js';
import {
  extractLearnedTasteTopics,
  getCanonicalAuthorKey,
  isLowEffortRageDunk,
  normalizeFeedTuning,
  scoreBourgeoisPoliticsSignal,
  scoreCommercialSignal,
} from '../core/feedRanker.js';
import {
  canonicalizeActorHandle,
  deduplicateUnifiedItems,
  isUnifiedItemModerated,
  toUnifiedItem,
} from '../core/schema/unifiedItem.js';
import { updateAccountTokens } from '../state/authStore.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
import {
  getBskyActorLikes,
  getBskyAuthorFeed,
  getBskyCustomFeed,
  getBskyTimeline,
  searchBskyFeedGenerators,
  searchBskyPosts,
} from './bluesky.js';
import {
  getAccountStatuses,
  getLemmyLocalPosts,
  getTagTimeline,
  getTimeline,
  getTrendingStatuses,
  isLemmyInstanceHost,
  lookupAccountByAcct,
} from './fediverse.js';
import { normalizeThreadsPostRecord, searchThreadsKeyword } from './threads.js';

export const BSKY_WHATS_HOT_URI = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
const DEFAULT_PUBLIC_MASTO_HOST = 'https://mastodon.social';

export const DEFAULT_SANCTUARY_CHANNELS = Object.freeze([
  'news',
  'technology',
  'science',
  'culture',
  'music',
]);

export const DEFAULT_SANCTUARY_INSTANCES = Object.freeze([
  'mastodon.social',
  'mastodon.online',
  'mstdn.social',
  'mas.to',
  'infosec.exchange',
  'lemmy.world',
  'lemmy.ml',
]);

const MEGA_FIREHOSE_HOSTS = new Set(['mastodon.social', 'mastodon.online', 'mas.to']);

const CONCEPT_HASHTAG_MAP = Object.freeze({
  'mutual aid': 'mutualaid',
  'worker cooperatives': 'cooperatives',
  'worker cooperative': 'cooperatives',
  'worker councils': 'workerscouncils',
  'workers councils': 'workerscouncils',
  'class struggle': 'classstruggle',
  'proletarian struggle': 'classstruggle',
  'decentralized infrastructure': 'selfhosted',
  'use-value': 'marxism',
  'use value': 'marxism',
  'open source': 'opensource',
  'small web': 'indieweb',
  anarchist: 'anarchism',
});

const CURATED_BSKY_GENERATORS = Object.freeze([
  [['marxism', 'marxist', 'use-value', 'use value', 'dialectical', 'historical materialism'], 'at://did:plc:3oezhi4yroqopcpgvjmrzmjx/app.bsky.feed.generator/aaanvoqwgmkns'],
  [['communism', 'communist', 'council communism', 'left communism', 'pannekoek', 'class struggle', 'proletarian', 'proletariat'], 'at://did:plc:ktbwe4wwzftcrvirivplbztw/app.bsky.feed.generator/aaagd5qfrout4'],
  [['socialism', 'socialist', 'anarchist', 'anarchism', 'cooperative', 'cooperatives', 'workers councils', 'worker councils', 'worker', 'labor', 'union'], 'at://did:plc:b3463o3pz3pdiyh355p6a7a6/app.bsky.feed.generator/aaaemd3r3s236'],
  [['mutual aid'], 'at://did:plc:yupjodsb265htel3yennasoq/app.bsky.feed.generator/aaagjqttv5lhi'],
  [['seattle'], 'at://did:plc:ge4ydexhvt6tsaayyjq6cqag/app.bsky.feed.generator/aaapihpt7x2fo'],
  [['linux', 'foss', 'open source', 'decentralized', 'self-hosted', 'selfhosted'], 'at://did:plc:6yoy2i3u62ijc5dsuhdc3rwo/app.bsky.feed.generator/aaanf5hmpcpvs'],
  [['indieweb', 'small web', 'solarpunk'], 'at://did:plc:kn4dz4f67maytvsbcnbry36k/app.bsky.feed.generator/aaact2ln2gffk'],
  [['philosophy'], 'at://did:plc:3bybp6nqszlhuan2ch2cmv66/app.bsky.feed.generator/philsky'],
  [['science', 'physics', 'biology', 'mathematics'], 'at://did:plc:jfhpnnst6flqway4eaeqzj2a/app.bsky.feed.generator/for-science'],
]);

const REJECTED_GENERATOR_RE = /\b(whats-hot|what's\s+hot|furry|yiff|nsfw|foxhole|politics\s+trending|breaking\s+news|democrat(?:s|ic)|republican|gop|maga)\b/i;
const GENERATOR_CACHE_KV_KEY = 'sanctuary_bsky_gen_cache_v1';
const GENERATOR_CACHE_TTL_MS = 30 * 60_000;
const bskyGeneratorCache = new Map();
let generatorCacheHydrated = false;

function shouldPersistHarvesterCache(fetchImpl) {
  const isNode = typeof globalThis.process?.versions?.node === 'string';
  return typeof fetchImpl !== 'function' && !isNode;
}

async function ensureGeneratorCacheHydrated(fetchImpl) {
  if (generatorCacheHydrated || !shouldPersistHarvesterCache(fetchImpl)) return;
  generatorCacheHydrated = true;
  const saved = await kvGet(GENERATOR_CACHE_KV_KEY, null).catch(() => null);
  if (!saved || typeof saved !== 'object') return;
  const now = Date.now();
  for (const [key, entry] of Object.entries(saved)) {
    if (entry && typeof entry === 'object' && Number(entry.expiresAt || 0) > now) {
      bskyGeneratorCache.set(key, { uri: String(entry.uri || ''), expiresAt: Number(entry.expiresAt) });
    }
  }
}

function persistGeneratorCache(fetchImpl) {
  if (!shouldPersistHarvesterCache(fetchImpl)) return;
  const now = Date.now();
  const snapshot = {};
  for (const [k, v] of bskyGeneratorCache.entries()) {
    if (v && v.expiresAt > now) snapshot[k] = v;
  }
  void kvSet(GENERATOR_CACHE_KV_KEY, snapshot).catch(() => {});
}

export function clearHarvesterCacheForTests() {
  bskyGeneratorCache.clear();
  generatorCacheHydrated = false;
}

function getBskyReadOpts(bskyAuth, fetchImpl) {
  const base = bskyAuth?.secrets?.accessJwt
    ? {
        serviceUrl: bskyAuth.meta?.serviceUrl,
        accessJwt: bskyAuth.secrets.accessJwt,
        refreshJwt: bskyAuth.secrets.refreshJwt,
        ...(bskyAuth.meta?.id
          ? { onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok) }
          : {}),
      }
    : {};
  return fetchImpl ? { ...base, fetchImpl } : base;
}

function normalizeHostName(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .split(/[/?#]/)[0]
    .replace(/\.$/, '');
}

export function conceptToHashtag(raw) {
  const clean = String(raw || '').trim().replace(/^#+/, '').toLowerCase();
  if (!clean || clean.startsWith('at://')) return '';
  if (CONCEPT_HASHTAG_MAP[clean]) return CONCEPT_HASHTAG_MAP[clean];
  const collapsed = clean.replace(/[^a-z0-9\p{L}]+/gu, '');
  return collapsed.length >= 2 && collapsed.length <= 40 ? collapsed : '';
}

function findCuratedBskyGenerator(channel) {
  const low = String(channel || '').trim().toLowerCase();
  if (!low) return '';
  if (low.startsWith('at://')) {
    return low === BSKY_WHATS_HOT_URI.toLowerCase() ? '' : String(channel).trim();
  }
  for (const [keywords, uri] of CURATED_BSKY_GENERATORS) {
    if (keywords.some((kw) => low === kw || low.includes(kw))) {
      return uri;
    }
  }
  return '';
}

function isAcceptableFeedGenerator(gen, query) {
  const uri = String(gen?.uri || '').trim();
  if (!uri.startsWith('at://') || uri.toLowerCase() === BSKY_WHATS_HOT_URI.toLowerCase()) {
    return false;
  }
  const combined = `${gen?.displayName || ''} ${gen?.description || ''}`;
  if (REJECTED_GENERATOR_RE.test(combined)) return false;

  const cleanTokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9\p{L}]+/u)
    .filter((t) => t.length >= 3);
  if (cleanTokens.length === 0) return false;
  const hay = combined.toLowerCase();
  return cleanTokens.some((tok) => hay.includes(tok));
}

async function resolveCommunityBskyGenerators(channels, bskyAuth, fetchImpl, maxGenerators = 5) {
  await ensureGeneratorCacheHydrated(fetchImpl);
  const uris = [];
  const seen = new Set();
  const addUri = (uri) => {
    const clean = String(uri || '').trim();
    if (!clean.startsWith('at://') || clean.toLowerCase() === BSKY_WHATS_HOT_URI.toLowerCase()) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    uris.push(clean);
  };

  const toLookup = [];
  for (const ch of channels) {
    const curated = findCuratedBskyGenerator(ch);
    if (curated) {
      addUri(curated);
    } else if (!String(ch).trim().toLowerCase().startsWith('at://')) {
      toLookup.push(String(ch).trim());
    }
  }

  const now = Date.now();
  const readOpts = getBskyReadOpts(bskyAuth, fetchImpl);
  const pendingQueries = [];
  for (const query of toLookup.slice(0, 4)) {
    if (uris.length >= maxGenerators) break;
    const cacheKey = query.toLowerCase();
    const cached = bskyGeneratorCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      if (cached.uri) addUri(cached.uri);
      continue;
    }
    pendingQueries.push(query);
  }

  if (pendingQueries.length > 0 && uris.length < maxGenerators) {
    const lookupTimeoutMs = typeof fetchImpl === 'function' ? undefined : 4000;
    const results = await Promise.all(
      pendingQueries.map(async (query) => {
        const found = await searchBskyFeedGenerators({
          query,
          limit: 6,
          ...readOpts,
          ...(lookupTimeoutMs ? { timeoutMs: lookupTimeoutMs } : {}),
        }).catch(() => []);
        const picked = found.find((g) => isAcceptableFeedGenerator(g, query));
        return { query, cacheKey: query.toLowerCase(), uri: picked?.uri || '' };
      })
    );
    let cacheMutated = false;
    for (const { cacheKey, uri } of results) {
      if (typeof fetchImpl !== 'function') {
        bskyGeneratorCache.set(cacheKey, { uri, expiresAt: now + GENERATOR_CACHE_TTL_MS });
        cacheMutated = true;
      }
      if (uri) addUri(uri);
    }
    if (cacheMutated) persistGeneratorCache(fetchImpl);
  }

  return uris.slice(0, maxGenerators);
}

export function resolveDiscoverySources(rawTuning, fediAuth = null) {
  const tuning = normalizeFeedTuning(rawTuning);
  const channelOut = [];
  const seenCh = new Set();
  for (const entry of tuning.discoveryChannels) {
    const clean = String(entry || '').trim();
    const low = clean.toLowerCase();
    if (!clean || seenCh.has(low)) continue;
    seenCh.add(low);
    channelOut.push(clean);
  }
  const activeChannels = channelOut.length > 0 ? channelOut : [...DEFAULT_SANCTUARY_CHANNELS];

  const baseInstances = tuning.discoveryInstances.length > 0
    ? [...tuning.discoveryInstances]
    : [...DEFAULT_SANCTUARY_INSTANCES];
  const fediHost = normalizeHostName(fediAuth?.meta?.instanceUrl || '');
  if (fediHost && !MEGA_FIREHOSE_HOSTS.has(fediHost) && !baseInstances.includes(fediHost)) {
    baseInstances.unshift(fediHost);
  }

  const tagList = [];
  const seenTags = new Set();
  for (const ch of activeChannels) {
    const tag = conceptToHashtag(ch);
    if (!tag || seenTags.has(tag)) continue;
    seenTags.add(tag);
    tagList.push(tag);
  }
  if (tagList.length === 0) {
    for (const defCh of DEFAULT_SANCTUARY_CHANNELS) {
      const t = conceptToHashtag(defCh);
      if (t && !seenTags.has(t)) {
        seenTags.add(t);
        tagList.push(t);
      }
    }
  }

  const searchQueries = activeChannels.filter((c) => !c.toLowerCase().startsWith('at://'));

  return {
    tuning,
    activeChannels,
    tagList,
    activeInstances: baseInstances,
    searchQueries: searchQueries.length > 0 ? searchQueries : [...DEFAULT_SANCTUARY_CHANNELS],
  };
}

function tagFeedSource(rawItems = [], defaultSource = 'discovery', endorsedBy = '') {
  const out = [];
  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    if (!raw || typeof raw !== 'object') continue;
    const u = toUnifiedItem(raw);
    const hasRepost = Boolean(u._meta?.mastodon?.rebloggedBy || u._meta?.bluesky?.rebloggedBy);
    const source = defaultSource === 'following' && hasRepost ? 'second_degree' : defaultSource;
    const endorser = endorsedBy
      || u._meta?.mastodon?.rebloggedBy?.handle
      || u._meta?.bluesky?.rebloggedBy?.handle
      || '';
    u._meta = {
      ...(u._meta || {}),
      feedSource: u._meta?.feedSource || source,
      ...(endorser && !u._meta?.endorsedBy ? { endorsedBy: String(endorser) } : {}),
    };
    out.push(u);
  }
  return out;
}

function isSubstantiveConversationalItem(item) {
  if (!item || typeof item !== 'object') return false;
  const m = item._meta?.mastodon || {};
  const b = item._meta?.bluesky || {};
  const t = item._meta?.threads || {};
  const isReply = Boolean(m.inReplyToId || b.reply || t.repliedToId);
  if (!isReply) return true;

  const authorId = String(item.author?.id || '');
  const isMastoSelfThread = Boolean(m.inReplyToAccountId && authorId && String(m.inReplyToAccountId) === authorId);
  const parentUri = String(b.reply?.parent?.uri || '');
  const isBskySelfThread = Boolean(authorId && parentUri && parentUri.includes(`/${authorId}/`));
  if (isMastoSelfThread || isBskySelfThread) return true;

  const source = item._meta?.feedSource || '';
  if (source === 'following' || source === 'second_degree') {
    const textLen = String(item.content_text || '').trim().length;
    const metrics = item.metrics || {};
    const engagement = Number(metrics.likes || 0) + Number(metrics.replies || 0);
    if (textLen >= 90 && engagement >= 2) return true;
  }
  return false;
}

function sourcePriority(item) {
  const src = item?._meta?.feedSource || '';
  if (src === 'following') return 0;
  if (src === 'second_degree') return 1;
  return 2;
}

/**
 * Filter upstream candidates at the admission boundary and cap per-author flooding.
 */
export function sieveSovereignCandidates(
  items = [],
  rawTuning = null,
  { maxPerAuthor = 2, ownAccounts = [], moderatedActors = [] } = {}
) {
  const tuning = normalizeFeedTuning(rawTuning);
  const allowCommercial = Number(tuning.sliders?.commercial || 0) > 0;
  const allowPolitics = Number(tuning.sliders?.bourgeoisPolitics || 0) > 0;
  const modSet = moderatedActors instanceof Set
    ? moderatedActors
    : new Set((Array.isArray(moderatedActors) ? moderatedActors : []).map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));

  const passed = [];
  for (const raw of Array.isArray(items) ? items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const u = toUnifiedItem(raw);
    if (isUnifiedItemModerated(u, modSet)) continue;
    if (!isSubstantiveConversationalItem(u)) continue;
    if (!allowCommercial && scoreCommercialSignal(u) >= 0.5) continue;
    if (!allowPolitics && scoreBourgeoisPoliticsSignal(u) >= 0.35) continue;
    if (isLowEffortRageDunk(u)) continue;
    passed.push(u);
  }

  passed.sort((a, b) => sourcePriority(a) - sourcePriority(b));
  const deduped = deduplicateUnifiedItems(passed, 120_000, { ownAccounts });
  const authorCounts = new Map();
  const capped = [];
  for (const u of deduped) {
    const authorKey = getCanonicalAuthorKey(u) || String(u.id || '');
    const count = authorCounts.get(authorKey) || 0;
    const cap = u._meta?.feedSource === 'following' ? Math.max(maxPerAuthor, 3) : maxPerAuthor;
    if (count >= cap) continue;
    authorCounts.set(authorKey, count + 1);
    capped.push(u);
  }
  return capped;
}

function mergeAffinityMaps(explicitMap = {}, implicitMap = {}) {
  const merged = {};
  for (const [k, v] of Object.entries(explicitMap && typeof explicitMap === 'object' ? explicitMap : {})) {
    merged[k] = Number(v || 0);
  }
  for (const [k, v] of Object.entries(implicitMap && typeof implicitMap === 'object' ? implicitMap : {})) {
    merged[k] = (merged[k] || 0) + Number(v || 0) * 0.65;
  }
  return merged;
}

function topAffinityActors(mergedAffinities = {}, proto = 'bluesky', limit = 2) {
  const prefix = `${proto}:`;
  return Object.entries(mergedAffinities)
    .filter(([key, weight]) => key.startsWith(prefix) && Number(weight || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .map(([key]) => canonicalizeActorHandle(key, proto).replace(new RegExp(`^${proto}:`), ''))
    .filter((handle) => (proto === 'bluesky' ? Boolean(handle) && handle.includes('.') : Boolean(handle) && handle.includes('@')))
    .slice(0, limit);
}

function buildKeyedBatch(keys, prevCursorMap, page, windowSize) {
  const prev = prevCursorMap && typeof prevCursorMap === 'object' ? prevCursorMap : {};
  const batch = [];
  const start = page * windowSize;
  for (const key of keys.slice(start, start + windowSize)) {
    batch.push({ key, cursor: prev[key] || '' });
  }
  for (const [key, cursorVal] of Object.entries(prev)) {
    if (cursorVal && !batch.some((entry) => entry.key === key)) {
      batch.push({ key, cursor: cursorVal });
    }
  }
  return batch.slice(0, windowSize);
}

/**
 * Fetch local posts from a Mastodon-compatible, auth-gated trends fallback, or Lemmy v3 instance.
 */
export async function fetchDiscoveryInstanceTimeline({
  host,
  maxId = '',
  limit = 12,
  timeoutMs,
  fetchImpl,
}) {
  const instanceUrl = `https://${host}`;
  if (isLemmyInstanceHost(host)) {
    return getLemmyLocalPosts({
      instanceUrl,
      pageCursor: maxId,
      limit,
      ...(timeoutMs ? { timeoutMs } : {}),
      fetchImpl,
    });
  }
  try {
    return await getTimeline({
      instanceUrl,
      stream: 'local',
      maxId,
      limit,
      ...(timeoutMs ? { timeoutMs } : {}),
      fetchImpl,
    });
  } catch (err) {
    if (err?.status === 404) {
      return getLemmyLocalPosts({
        instanceUrl,
        pageCursor: maxId,
        limit,
        ...(timeoutMs ? { timeoutMs } : {}),
        fetchImpl,
      });
    }
    if (err?.status === 401 || err?.status === 403 || err?.status === 422) {
      const res = await getTrendingStatuses({
        instanceUrl,
        limit,
        offset: Number(maxId) || 0,
        ...(timeoutMs ? { timeoutMs } : {}),
        fetchImpl,
      });
      return {
        items: res.items,
        nextCursor: res.nextOffset ? String(res.nextOffset) : null,
      };
    }
    throw err;
  }
}

/**
 * Harvest sovereign candidates from connected Following timelines, 2nd-degree peer likes/boosts,
 * Fediverse hashtags, independent instances, community ATProto generators, and learned-taste queries.
 */
export async function harvestSanctuaryFeed({
  fediAuth = null,
  bskyAuth = null,
  threadsAuth = null,
  tuning: rawTuning = null,
  interactedAuthors = {},
  implicitAuthors = {},
  tasteMemory = null,
  moderatedActors = [],
  cursor = null,
  append = false,
  fetchImpl,
} = {}) {
  const page = append ? Math.max(0, Number(cursor?.page || 0)) : 0;
  const cursorState = append && cursor && typeof cursor === 'object' ? cursor : {};
  const { tuning, activeChannels, tagList, activeInstances, searchQueries } = resolveDiscoverySources(rawTuning, fediAuth);

  const learnedTopics = extractLearnedTasteTopics(tasteMemory, 2);
  const seenQueries = new Set();
  const effectiveSearchQueries = [];
  for (const q of [...learnedTopics, ...searchQueries]) {
    const clean = String(q || '').trim();
    const low = clean.toLowerCase();
    if (!clean || seenQueries.has(low)) continue;
    seenQueries.add(low);
    effectiveSearchQueries.push(clean);
  }

  const tagHomeOrigin = fediAuth?.meta?.instanceUrl && isAllowedSocialUrl(fediAuth.meta.instanceUrl)
    ? fediAuth.meta.instanceUrl
    : DEFAULT_PUBLIC_MASTO_HOST;
  const tagToken = fediAuth?.secrets?.accessToken || '';
  const legTimeoutMs = typeof fetchImpl === 'function' ? undefined : 5500;
  const bskyReadOpts = {
    ...getBskyReadOpts(bskyAuth, fetchImpl),
    ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
  };
  const hasBskyToken = Boolean(bskyAuth?.secrets?.accessJwt);
  const hasFediToken = Boolean(fediAuth?.secrets?.accessToken);

  const bskyFeedUris = Array.isArray(cursorState.bskyFeedUris) && cursorState.bskyFeedUris.length > 0
    ? cursorState.bskyFeedUris
    : await resolveCommunityBskyGenerators(activeChannels, bskyAuth, fetchImpl, 5);

  const tagBatch = buildKeyedBatch(tagList, cursorState.tagCursors, page, 3);
  const instanceBatch = buildKeyedBatch(activeInstances, cursorState.instanceCursors, page, 2);
  const bskyFeedBatch = buildKeyedBatch(bskyFeedUris, cursorState.bskyFeedCursors, page, 3);
  const bskySearchBatch = hasBskyToken
    ? buildKeyedBatch(effectiveSearchQueries, cursorState.bskySearchCursors, page, 2)
    : [];

  const mergedAffinities = mergeAffinityMaps(interactedAuthors, implicitAuthors);
  const tasks = [];

  // 1. Connected Following timelines (Inventory Step 1)
  if (hasFediToken && (!append || cursorState.fediHomeCursor)) {
    tasks.push(
      getTimeline({
        instanceUrl: tagHomeOrigin,
        accessToken: tagToken,
        stream: 'home',
        maxId: append ? (cursorState.fediHomeCursor || '') : '',
        limit: 18,
        ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
        fetchImpl,
      }).then((res) => ({
        kind: 'fediHome',
        key: 'home',
        items: tagFeedSource(res.items || [], 'following'),
        nextCursor: res.nextCursor || null,
      }))
    );
  }

  if (hasBskyToken && (!append || cursorState.bskyHomeCursor)) {
    tasks.push(
      getBskyTimeline({
        ...bskyReadOpts,
        cursor: append ? (cursorState.bskyHomeCursor || '') : '',
        limit: 20,
      }).then((res) => ({
        kind: 'bskyHome',
        key: 'home',
        items: tagFeedSource(res.items || [], 'following'),
        nextCursor: res.nextCursor || null,
      }))
    );
  }

  // 2. Discovery channels: hashtags, community instances, ATProto generators, search
  for (const { key: tag, cursor: maxId } of tagBatch) {
    tasks.push(
      getTagTimeline({
        instanceUrl: tagHomeOrigin,
        accessToken: tagToken,
        tag,
        maxId,
        limit: 12,
        ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
        fetchImpl,
      }).then((res) => ({
        kind: 'tag',
        key: tag,
        items: tagFeedSource(res.items || [], 'discovery'),
        nextCursor: res.nextCursor || null,
      }))
    );
  }

  for (const { key: host, cursor: maxId } of instanceBatch) {
    tasks.push(
      fetchDiscoveryInstanceTimeline({
        host,
        maxId,
        limit: 12,
        ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
        fetchImpl,
      }).then((res) => ({
        kind: 'instance',
        key: host,
        items: tagFeedSource(res.items || [], 'discovery'),
        nextCursor: res.nextCursor || null,
      }))
    );
  }

  for (const { key: feedUri, cursor: bskyCursor } of bskyFeedBatch) {
    tasks.push(
      getBskyCustomFeed({
        feed: feedUri,
        cursor: bskyCursor,
        limit: 15,
        ...bskyReadOpts,
      }).then((res) => ({
        kind: 'bskyFeed',
        key: feedUri,
        items: tagFeedSource(res.items || [], 'discovery'),
        nextCursor: res.nextCursor || null,
      }))
    );
  }

  for (const { key: query, cursor: searchCursor } of bskySearchBatch) {
    tasks.push(
      searchBskyPosts({
        query,
        sort: 'latest',
        cursor: searchCursor,
        limit: 15,
        ...bskyReadOpts,
      }).then((res) => ({
        kind: 'bskySearch',
        key: query,
        items: tagFeedSource(res.items || [], 'discovery'),
        nextCursor: res.nextCursor || null,
      }))
    );
  }

  // 3. 2nd-Degree Graph Expansion: likes, boosts, and recent notes from high-affinity peers
  if (page === 0 && hasBskyToken) {
    for (const actor of topAffinityActors(mergedAffinities, 'bluesky', 2)) {
      tasks.push(
        getBskyAuthorFeed({
          actor,
          limit: 8,
          filter: 'posts_with_replies',
          ...bskyReadOpts,
        }).then((res) => ({
          kind: 'reciprocity',
          key: actor,
          items: tagFeedSource(res.items || [], 'following', actor),
          nextCursor: null,
        }))
      );
      tasks.push(
        getBskyActorLikes({
          actor,
          limit: 8,
          ...bskyReadOpts,
        })
          .then((res) => ({
            kind: 'secondDegree',
            key: `likes:${actor}`,
            items: tagFeedSource(res.items || [], 'second_degree', actor),
            nextCursor: null,
          }))
          .catch(() => ({ kind: 'secondDegree', key: `likes:${actor}`, items: [], nextCursor: null }))
      );
    }
  }

  if (page === 0 && hasFediToken) {
    for (const acct of topAffinityActors(mergedAffinities, 'mastodon', 2)) {
      tasks.push(
        lookupAccountByAcct({
          instanceUrl: tagHomeOrigin,
          accessToken: tagToken,
          acct,
          ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
          fetchImpl,
        })
          .then((prof) => (prof?.id
            ? getAccountStatuses({
                instanceUrl: tagHomeOrigin,
                accessToken: tagToken,
                accountId: prof.id,
                excludeReblogs: false,
                excludeReplies: false,
                limit: 8,
                ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
                fetchImpl,
              })
            : []))
          .then((list) => ({
            kind: 'secondDegreeMasto',
            key: acct,
            items: tagFeedSource(list || [], 'second_degree', acct),
            nextCursor: null,
          }))
          .catch(() => ({ kind: 'secondDegreeMasto', key: acct, items: [], nextCursor: null }))
      );
    }
  }

  if (page === 0 && threadsAuth?.secrets?.accessToken && effectiveSearchQueries.length > 0) {
    for (const q of effectiveSearchQueries.slice(0, 2)) {
      tasks.push(
        searchThreadsKeyword({
          query: q,
          searchType: 'RECENT',
          limit: 10,
          accessToken: threadsAuth.secrets.accessToken,
          ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
          fetchImpl,
        })
          .then((res) => ({
            kind: 'threadsSearch',
            key: q,
            items: tagFeedSource(
              (Array.isArray(res?.data) ? res.data : []).map((raw) => normalizeThreadsPostRecord(raw)),
              'discovery'
            ),
            nextCursor: null,
          }))
          .catch(() => ({ kind: 'threadsSearch', key: q, items: [], nextCursor: null }))
      );
    }
  }

  if (tasks.length === 0) {
    return { items: [], nextCursor: null };
  }

  const settled = await Promise.allSettled(tasks);
  const rawCollected = [];
  const nextTagCursors = {};
  const nextInstanceCursors = {};
  const nextBskyFeedCursors = {};
  const nextBskySearchCursors = {};
  let nextFediHomeCursor = '';
  let nextBskyHomeCursor = '';
  let anySucceeded = false;
  let firstError = '';

  const optionalKinds = new Set(['threadsSearch', 'secondDegree', 'secondDegreeMasto']);
  for (const entry of settled) {
    if (entry.status !== 'fulfilled') {
      if (!firstError) firstError = entry.reason?.message || 'Unable to load Sanctuary feed.';
      continue;
    }
    const { kind, key, items, nextCursor } = entry.value;
    if (!optionalKinds.has(kind) || items.length > 0) {
      anySucceeded = true;
    }
    rawCollected.push(...(items || []));
    if (kind === 'fediHome' && nextCursor) nextFediHomeCursor = nextCursor;
    else if (kind === 'bskyHome' && nextCursor) nextBskyHomeCursor = nextCursor;
    else if (kind === 'tag' && nextCursor) nextTagCursors[key] = nextCursor;
    else if (kind === 'instance' && nextCursor) nextInstanceCursors[key] = nextCursor;
    else if (kind === 'bskyFeed' && nextCursor) nextBskyFeedCursors[key] = nextCursor;
    else if (kind === 'bskySearch' && nextCursor) nextBskySearchCursors[key] = nextCursor;
  }

  if (!anySucceeded) {
    throw new Error(firstError || 'Unable to load Sanctuary feed.');
  }

  const ownAccounts = [fediAuth?.meta, bskyAuth?.meta, threadsAuth?.meta].filter(Boolean);
  const items = sieveSovereignCandidates(rawCollected, tuning, {
    maxPerAuthor: 2,
    ownAccounts,
    moderatedActors,
  });
  const nextPage = page + 1;
  const hasMoreSlices =
    nextPage < 6
    && (
      nextPage * 3 < tagList.length
      || nextPage * 2 < activeInstances.length
      || nextPage * 3 < bskyFeedUris.length
      || (hasBskyToken && nextPage * 2 < effectiveSearchQueries.length)
    );
  const hasUpstreamCursors =
    nextPage < 8
    && (
      Boolean(nextFediHomeCursor)
      || Boolean(nextBskyHomeCursor)
      || Object.keys(nextTagCursors).length > 0
      || Object.keys(nextInstanceCursors).length > 0
      || Object.keys(nextBskyFeedCursors).length > 0
      || Object.keys(nextBskySearchCursors).length > 0
    );

  const nextCursor = (hasMoreSlices || hasUpstreamCursors)
    ? {
        page: nextPage,
        bskyFeedUris,
        ...(nextFediHomeCursor ? { fediHomeCursor: nextFediHomeCursor } : {}),
        ...(nextBskyHomeCursor ? { bskyHomeCursor: nextBskyHomeCursor } : {}),
        tagCursors: nextTagCursors,
        instanceCursors: nextInstanceCursors,
        bskyFeedCursors: nextBskyFeedCursors,
        bskySearchCursors: nextBskySearchCursors,
      }
    : null;

  return { items, nextCursor };
}
