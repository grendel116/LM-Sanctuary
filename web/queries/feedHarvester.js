import { isAllowedSocialUrl } from '../constants/endpoints.js';
import {
  extractLearnedTasteTopics,
  getCanonicalAuthorKey,
  getCanonicalBoosterKey,
  hasPostExternalLink,
  hasVisualMediaAttachment,
  isAutomatedSyndicationOrBotItem,
  normalizeFeedTuning,
  normalizeRankingManifest,
  scoreCommercialSignal,
  scoreLinkAndSubstackSignal,
} from '../core/feedRanker.js';
import {
  actorMatchesOwnAccountSet,
  addActorToKeySet,
  applyKeywordFilters,
  buildFollowedActorKeySet,
  buildOwnAccountKeySet,
  canonicalizeActorHandle,
  deduplicateUnifiedItems,
  isOwnOrSelfBoostedUnifiedItem,
  isReplyUnifiedItem,
  isUnifiedItemModerated,
  mergeViewerActivityMeta,
  normalizeNativeUri,
  reconcileViewerMetricFloors,
  resolveContextualStreamItems,
  toUnifiedItem,
} from '../core/schema/unifiedItem.js';
import { updateAccountTokens } from '../state/authStore.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
import {
  getBskyActorLikes,
  getBskyAuthorFeed,
  getBskyCustomFeed,
  getBskyFollows,
  getBskyPostLikes,
  getBskySavedFeedUris,
  getBskyTimeline,
  harvestBlueskyJetstreamBurst,
  searchBskyFeedGenerators,
  searchBskyPosts,
} from './bluesky.js';
import {
  clearFediverseDiscoveryCacheForTests,
  getAccountStatuses,
  getFavouritedStatuses,
  getFollowedTags,
  getLemmyLocalPosts,
  getStatus,
  getStatusBoostersAndLikers,
  getTagTimeline,
  getTimeline,
  getTrendingStatuses,
  getUserLists,
  isLemmyInstanceHost,
  isPublicDiscoveryOptOut,
  lookupAccountByAcct,
} from './fediverse.js';
import { normalizeThreadsPostRecord, searchThreadsKeyword } from './threads.js';

const DEFAULT_PUBLIC_MASTO_HOST = 'https://mastodon.world';

export const DEFAULT_SANCTUARY_CHANNELS = Object.freeze([]);
export const DEFAULT_SANCTUARY_INSTANCES = Object.freeze([]);

const CONCEPT_HASHTAG_MAP = Object.freeze({
  'mutual aid': 'mutualaid',
  'worker cooperatives': 'cooperatives',
  'worker cooperative': 'cooperatives',
  'worker councils': 'workerscouncils',
  'workers councils': 'workerscouncils',
  'class struggle': 'classstruggle',
  'proletarian struggle': 'classstruggle',
  'decentralized infrastructure': 'selfhosted',
  'open source': 'opensource',
  'small web': 'indieweb',
  'everyday life': 'everydaylife',
  'slice of life': 'sliceoflife',
  'today i learned': 'til',
});

const REJECTED_GENERATOR_RE = /\b(furry|yiff|nsfw|foxhole)\b/i;
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
  clearFediverseDiscoveryCacheForTests();
}

function getBskyReadOpts(bskyAuth, fetchImpl) {
  const base = bskyAuth?.secrets?.accessJwt
    ? {
        serviceUrl: bskyAuth.meta?.serviceUrl,
        accessJwt: bskyAuth.secrets.accessJwt,
        refreshJwt: bskyAuth.secrets.refreshJwt,
        ...(bskyAuth.meta?.id
          ? { onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok).catch(() => {}) }
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

function isAcceptableFeedGenerator(gen, query) {
  const uri = String(gen?.uri || '').trim();
  if (!uri.startsWith('at://')) {
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
    if (!clean.startsWith('at://')) return;
    if (seen.has(clean)) return;
    seen.add(clean);
    uris.push(clean);
  };

  const toLookup = [];
  for (const ch of channels) {
    const clean = String(ch || '').trim();
    if (!clean) continue;
    if (clean.toLowerCase().startsWith('at://')) {
      addUri(clean);
    } else {
      toLookup.push(clean.replace(/^#+/, ''));
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
  const activeChannels = channelOut.length > 0 ? channelOut : [];

  const activeInstances = [...tuning.discoveryInstances];
  const fediHost = normalizeHostName(fediAuth?.meta?.instanceUrl || '');
  if (fediHost && !activeInstances.includes(fediHost)) {
    activeInstances.unshift(fediHost);
  }

  const tagList = [];
  const seenTags = new Set();
  for (const ch of activeChannels) {
    const tag = conceptToHashtag(ch);
    if (!tag || seenTags.has(tag)) continue;
    seenTags.add(tag);
    tagList.push(tag);
  }

  const searchQueries = activeChannels.filter((c) => !c.toLowerCase().startsWith('at://'));
  const hasCustomChannels = channelOut.length > 0;
  const hasCustomInstances = activeInstances.length > 0;

  return {
    tuning,
    activeChannels,
    hasCustomChannels,
    hasCustomInstances,
    tagList,
    activeInstances,
    searchQueries,
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

function sourcePriority(item) {
  const src = item?._meta?.feedSource || '';
  if (src === 'following') return 0;
  if (src === 'second_degree') return 1;
  return 2;
}

function hasAttachmentMatchingMode(item, discoveryMode = 'default') {
  const atts = Array.isArray(item?.attachments) ? item.attachments : [];
  if (atts.length === 0) return false;
  const isVideoAtt = (att) => {
    const t = String(att?.type || '').toLowerCase();
    const mime = String(att?.mime_type || att?.mimeType || '').toLowerCase();
    return t === 'video' || t === 'gifv' || mime.startsWith('video/') || Boolean(att?.hlsUrl);
  };
  if (discoveryMode === 'video') {
    return atts.some(isVideoAtt);
  }
  if (discoveryMode === 'photos') {
    const allStaticImages = atts.every(
      (att) =>
        !isVideoAtt(att)
        && String(att?.type || 'image').toLowerCase() === 'image'
        && String(att?.mimeType || att?.mime_type || '').toLowerCase() !== 'image/gif'
    );
    if (!allStaticImages) return false;
    return atts.every((att) => {
      const w = Number.parseInt(att?.width, 10) || 0;
      const h = Number.parseInt(att?.height, 10) || 0;
      if (w > 0 && h > 0) {
        const ratio = w / h;
        return ratio >= 0.75 && ratio <= 1.35;
      }
      return true;
    });
  }
  if (discoveryMode === 'visual') {
    return atts.some((att) => isVideoAtt(att) || String(att?.type || 'image').toLowerCase() === 'image');
  }
  return true;
}

/**
 * Filter upstream candidates at the admission boundary using the user's local RankingManifest
 * caps, unfollowed-voice enforcement, privacy opt-outs, and discoveryMode requirements.
 */
export function sieveSovereignCandidates(
  items = [],
  rawTuning = null,
  {
    maxPerAuthor = null,
    ownAccounts = [],
    followedActors = null,
    moderatedActors = [],
    filterRules = [],
    discoveryMode = 'default',
    manifest: rawManifest = null,
  } = {}
) {
  normalizeFeedTuning(rawTuning);
  const manifest = normalizeRankingManifest(rawManifest);
  const caps = manifest.caps;
  const filterBots = caps.filterDiscoveryBotsByDefault !== false;
  const capDiscoveryLinks = discoveryMode === 'default';
  const explicitMax = maxPerAuthor !== null && maxPerAuthor !== undefined ? Number(maxPerAuthor) : null;
  const isMediaMode = discoveryMode === 'visual' || discoveryMode === 'photos' || discoveryMode === 'video';

  const modSet = moderatedActors instanceof Set
    ? moderatedActors
    : new Set((Array.isArray(moderatedActors) ? moderatedActors : []).map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
  const followedSet = followedActors instanceof Set
    ? followedActors
    : buildFollowedActorKeySet(Array.isArray(followedActors) ? followedActors : []);

  const contextualized = resolveContextualStreamItems(
    Array.isArray(items) ? items : [],
    { streamMode: 'feed' }
  );
  const keywordSafe = applyKeywordFilters(
    contextualized,
    Array.isArray(filterRules) ? filterRules : [],
    modSet
  );

  const ownAccountKeys = buildOwnAccountKeySet(ownAccounts);
  const passed = [];
  for (const u of keywordSafe) {
    if (!u || typeof u !== 'object') continue;
    if (isUnifiedItemModerated(u, modSet)) continue;
    if (isOwnOrSelfBoostedUnifiedItem(u, ownAccountKeys)) continue;
    if (ownAccountKeys.size > 0 && Boolean(u._meta?.mastodon?.reblogged || u._meta?.bluesky?.repostUri)) continue;
    if (followedSet.size > 0 && actorMatchesOwnAccountSet(u.author, u.protocol, u._meta?.mastodon?.instanceUrl || '', followedSet)) {
      continue;
    }
    const feedSource = u._meta?.feedSource || '';
    if (feedSource !== 'following' && isPublicDiscoveryOptOut(u)) continue;
    if (isReplyUnifiedItem(u)) continue;
    if (isMediaMode && !hasAttachmentMatchingMode(u, discoveryMode)) continue;
    if ((discoveryMode === 'photos' || discoveryMode === 'video') && (hasPostExternalLink(u) || u._meta?.quotePost || u.quotePost)) {
      continue;
    }
    if (discoveryMode === 'default' && hasVisualMediaAttachment(u)) {
      continue;
    }
    if (filterBots && feedSource !== 'following' && isAutomatedSyndicationOrBotItem(u, manifest)) continue;
    const hasExtLink = hasPostExternalLink(u);
    if (capDiscoveryLinks && feedSource !== 'following' && hasExtLink) {
      const proseLen = String(u.content_text || '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/#[\p{L}\p{N}_]+/gu, '')
        .trim().length;
      const m = u.metrics || {};
      const totalEng = Number(m.likes || 0) + Number(m.replies || 0) + Number(m.reposts || 0);
      if ((!u.attachments?.length && proseLen < caps.minUnfollowedLinkProseChars) || (totalEng === 0 && scoreLinkAndSubstackSignal(u) >= 0.7)) {
        continue;
      }
    }
    if (scoreCommercialSignal(u) >= 0.75) continue;
    passed.push(u);
  }

  passed.sort((a, b) => sourcePriority(a) - sourcePriority(b));
  const deduped = deduplicateUnifiedItems(passed, 120_000, { ownAccounts });

  const discoveryTotals = new Map();
  const discoveryLinkTotals = new Map();
  let nonLinkTotal = 0;
  for (const u of deduped) {
    const ak = getCanonicalAuthorKey(u) || String(u.id || '');
    const hasExt = hasPostExternalLink(u);
    if (!hasExt) nonLinkTotal += 1;
    if (u._meta?.feedSource !== 'following') {
      discoveryTotals.set(ak, (discoveryTotals.get(ak) || 0) + 1);
      if (hasExt) discoveryLinkTotals.set(ak, (discoveryLinkTotals.get(ak) || 0) + 1);
    }
  }

  const maxDiscoveryLinkTotal = Math.max(caps.minDiscoveryLinkBudget, Math.ceil(nonLinkTotal * caps.maxDiscoveryLinkShare));
  let discoveryLinkCount = 0;
  const authorCounts = new Map();
  const boosterCounts = new Map();
  const discoveryAuthorLinkCounts = new Map();
  const maxBoostsPerBooster = explicitMax !== null ? explicitMax : (caps.maxBoostsPerBooster || 2);
  const capped = [];
  for (const u of deduped) {
    const authorKey = getCanonicalAuthorKey(u) || String(u.id || '');
    const boosterKey = getCanonicalBoosterKey(u);
    const isFollowing = u._meta?.feedSource === 'following';
    if (
      !isFollowing
      && discoveryMode === 'default'
      && (discoveryTotals.get(authorKey) || 0) >= caps.linkSyndicatorBurstThreshold
      && (discoveryLinkTotals.get(authorKey) || 0) === (discoveryTotals.get(authorKey) || 0)
    ) {
      continue;
    }
    const count = authorCounts.get(authorKey) || 0;
    const discoveryCap = explicitMax !== null ? explicitMax : caps.maxDiscoveryPerAuthor;
    const cap = isFollowing ? (explicitMax !== null ? explicitMax : Math.max(discoveryCap, caps.maxFollowingPerAuthor)) : discoveryCap;
    if (count >= cap) continue;
    if (boosterKey && (boosterCounts.get(boosterKey) || 0) >= maxBoostsPerBooster) continue;
    if (!isFollowing && capDiscoveryLinks && hasPostExternalLink(u)) {
      const aLinks = discoveryAuthorLinkCounts.get(authorKey) || 0;
      if (aLinks >= caps.maxDiscoveryLinksPerAuthor || discoveryLinkCount >= maxDiscoveryLinkTotal) continue;
      discoveryAuthorLinkCounts.set(authorKey, aLinks + 1);
      discoveryLinkCount += 1;
    }
    authorCounts.set(authorKey, count + 1);
    if (boosterKey) boosterCounts.set(boosterKey, (boosterCounts.get(boosterKey) || 0) + 1);
    capped.push(u);
  }
  return capped;
}

function topAffinityActors(affinities = {}, proto = 'bluesky', limit = 3, ownAccountKeys = null) {
  const prefix = `${proto}:`;
  const canonProto = proto === 'fediverse' ? 'mastodon' : proto;
  return Object.entries(affinities && typeof affinities === 'object' ? affinities : {})
    .filter(([key, weight]) => key.startsWith(prefix) && Number(weight || 0) > 0)
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .map(([key]) => canonicalizeActorHandle(key, proto).replace(new RegExp(`^${proto}:`), ''))
    .filter((handle) => (proto === 'bluesky' ? Boolean(handle) && handle.includes('.') : Boolean(handle) && handle.includes('@')))
    .filter((handle) => !(ownAccountKeys?.size > 0 && ownAccountKeys.has(canonicalizeActorHandle(handle, canonProto))))
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
 * Fetch trending/community statuses from a Mastodon-compatible or Lemmy v3 instance.
 */
export async function fetchDiscoveryInstanceTimeline({
  host,
  maxId = '',
  limit = 40,
  accessToken = '',
  stream = 'federated',
  onlyMedia = false,
  cache,
  timeoutMs,
  fetchImpl,
}) {
  const instanceUrl = `https://${host}`;
  if (isLemmyInstanceHost(host)) {
    return getLemmyLocalPosts({
      instanceUrl,
      pageCursor: maxId,
      limit,
      ...(cache !== undefined ? { cache } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      fetchImpl,
    });
  }
  if (stream === 'trends') {
    try {
      const res = await getTrendingStatuses({
        instanceUrl,
        accessToken,
        limit,
        offset: Number(maxId) || 0,
        ...(cache !== undefined ? { cache } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        fetchImpl,
      });
      return {
        items: res.items,
        nextCursor: res.nextOffset ? String(res.nextOffset) : null,
      };
    } catch (err) {
      if (err?.status === 404) {
        return getLemmyLocalPosts({
          instanceUrl,
          pageCursor: maxId,
          limit,
          ...(cache !== undefined ? { cache } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
          fetchImpl,
        });
      }
      throw err;
    }
  }
  try {
    return await getTimeline({
      instanceUrl,
      accessToken,
      stream,
      onlyMedia,
      maxId,
      limit,
      ...(cache !== undefined ? { cache } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      fetchImpl,
    });
  } catch (err) {
    if (err?.status === 404) {
      return getLemmyLocalPosts({
        instanceUrl,
        pageCursor: maxId,
        limit,
        ...(cache !== undefined ? { cache } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        fetchImpl,
      });
    }
    if (err?.status === 401 || err?.status === 403 || err?.status === 422) {
      const numOffset = Number(maxId);
      if (maxId && (!Number.isFinite(numOffset) || numOffset < 0 || numOffset > 40)) {
        return { items: [], nextCursor: null };
      }
      const safeOffset = maxId ? numOffset : 0;
      const res = await getTrendingStatuses({
        instanceUrl,
        ...(accessToken ? { accessToken } : {}),
        limit,
        offset: safeOffset,
        ...(cache !== undefined ? { cache } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        fetchImpl,
      });
      const nextOff = Number(res.nextOffset || 0);
      return {
        items: res.items,
        nextCursor: nextOff > 0 && nextOff <= 40 ? String(nextOff) : null,
      };
    }
    throw err;
  }
}

function buildJetstreamRecordMatcher(topicTerms = []) {
  const topicTokens = (Array.isArray(topicTerms) ? topicTerms : [])
    .flatMap((c) => String(c || '').toLowerCase().split(/[^a-z0-9\p{L}]+/u))
    .filter((t) => t.length >= 3);

  return (record) => {
    const text = String(record?.text || '');
    const hashCount = (text.match(/#[\p{L}\p{N}_]+/gu) || []).length;
    if (hashCount > 5) return 'skip';
    if (/\b(#ad|#sponsored|#affiliate|promo\s+code|shop\s+now|buy\s+now)\b/i.test(text)) {
      return 'skip';
    }
    if (topicTokens.length > 0) {
      const tagStr = Array.isArray(record?.tags) ? record.tags.join(' ') : '';
      const hay = `${text} ${tagStr}`.toLowerCase();
      return topicTokens.some((tok) => hay.includes(tok)) ? 'prefer' : 'skip';
    }
    const embedType = String(record?.embed?.$type || '');
    if (embedType === 'app.bsky.embed.external' || embedType.startsWith('app.bsky.embed.record')) return 'accept';
    return text.length >= 25 && text.length <= 360 ? 'prefer' : 'accept';
  };
}

const repliedParentKeysCache = new Map();

function buildItemLookupKeys(raw) {
  const u = toUnifiedItem(raw);
  const keys = [];
  if (u.id) keys.push(String(u.id));
  const mUri = normalizeNativeUri(u._meta?.mastodon?.uri || '');
  if (mUri) keys.push(mUri);
  const bUri = String(u._meta?.bluesky?.uri || '').trim();
  if (bUri) keys.push(bUri);
  const normUrl = normalizeNativeUri(u.url || '');
  if (normUrl) keys.push(normUrl);
  return { u, keys: [...new Set(keys)] };
}

/**
 * Fetch the signed-in user's recent Mastodon & Bluesky likes, boosts, and replies
 * (resolving remote Mastodon reply targets to canonical URIs/URLs) so feed cards
 * accurately show viewer activity even on posts harvested from remote servers.
 */
export async function syncOwnViewerActivity({
  fediAuth = null,
  bskyAuth = null,
  prefetchedFediFavs = null,
  prefetchedBskyLikes = null,
  timeoutMs = 5500,
  fetchImpl,
} = {}) {
  const entries = [];
  const tasks = [];

  const fediToken = fediAuth?.secrets?.accessToken || '';
  const fediOrigin = fediAuth?.meta?.instanceUrl || '';
  if (fediToken && fediOrigin && isAllowedSocialUrl(fediOrigin)) {
    tasks.push((async () => {
      let accountId = String(fediAuth?.meta?.userId || '').trim();
      if (!accountId) {
        const acct = String(fediAuth?.meta?.acct || fediAuth?.meta?.handle || '').trim();
        if (acct) {
          const prof = await lookupAccountByAcct({
            instanceUrl: fediOrigin,
            accessToken: fediToken,
            acct,
            ...(timeoutMs ? { timeoutMs } : {}),
            fetchImpl,
          }).catch(() => null);
          if (prof?.id) accountId = String(prof.id);
        }
      }

      const [favs, ownStatuses] = await Promise.all([
        Array.isArray(prefetchedFediFavs)
          ? Promise.resolve(prefetchedFediFavs)
          : (prefetchedFediFavs && typeof prefetchedFediFavs.then === 'function'
              ? prefetchedFediFavs
              : getFavouritedStatuses({
                  instanceUrl: fediOrigin,
                  accessToken: fediToken,
                  limit: 30,
                  ...(timeoutMs ? { timeoutMs } : {}),
                  fetchImpl,
                }).catch(() => [])),
        accountId
          ? getAccountStatuses({
              instanceUrl: fediOrigin,
              accessToken: fediToken,
              accountId,
              excludeReplies: false,
              excludeReblogs: false,
              limit: 40,
              ...(timeoutMs ? { timeoutMs } : {}),
              fetchImpl,
            }).catch(() => [])
          : Promise.resolve([]),
      ]);

      for (const fav of Array.isArray(favs) ? favs : []) {
        const { u, keys } = buildItemLookupKeys(fav);
        if (keys.length > 0) {
          entries.push({
            keys,
            favourited: true,
            minLikes: Math.max(1, Number(u.metrics?.likes || 0)),
          });
        }
      }

      const missingParentIds = [];
      for (const st of Array.isArray(ownStatuses) ? ownStatuses : []) {
        if (!st || typeof st !== 'object') continue;
        if (st.rebloggedBy || st.raw?.reblog) {
          const { keys } = buildItemLookupKeys(st);
          if (keys.length > 0) entries.push({ keys, reblogged: true });
        }
        const pid = String(st.inReplyToId || st._meta?.mastodon?.inReplyToId || '').trim();
        if (pid) {
          const cacheKey = `${fediOrigin}:${pid}`;
          const cached = repliedParentKeysCache.get(cacheKey);
          if (cached) {
            entries.push({ keys: cached, replied: true });
          } else {
            entries.push({ keys: [`mastodon:${pid}`], replied: true });
            if (!missingParentIds.includes(pid)) missingParentIds.push(pid);
          }
        }
      }

      if (missingParentIds.length > 0) {
        await Promise.allSettled(
          missingParentIds.slice(0, 12).map(async (pid) => {
            const parent = await getStatus({
              instanceUrl: fediOrigin,
              accessToken: fediToken,
              statusId: pid,
              fetchImpl,
            }).catch(() => null);
            if (!parent?.id) return;
            const { u, keys } = buildItemLookupKeys(parent);
            if (keys.length === 0) return;
            const cacheKey = `${fediOrigin}:${pid}`;
            repliedParentKeysCache.set(cacheKey, keys);
            entries.push({
              keys,
              replied: true,
              ...(u._meta?.mastodon?.favourited ? { favourited: true } : {}),
              ...(u._meta?.mastodon?.reblogged ? { reblogged: true } : {}),
              ...(u._meta?.mastodon?.bookmarked ? { bookmarked: true } : {}),
            });
          })
        );
      }
    })());
  }

  const bskyJwt = bskyAuth?.secrets?.accessJwt || '';
  const bskyActor = bskyAuth?.meta?.did || bskyAuth?.meta?.handle || bskyAuth?.meta?.acct || '';
  if (bskyJwt && bskyActor) {
    const bskyOpts = {
      ...getBskyReadOpts(bskyAuth, fetchImpl),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    tasks.push((async () => {
      const [likesRes, feedRes] = await Promise.all([
        Array.isArray(prefetchedBskyLikes?.items)
          ? Promise.resolve(prefetchedBskyLikes)
          : (prefetchedBskyLikes && typeof prefetchedBskyLikes.then === 'function'
              ? prefetchedBskyLikes
              : getBskyActorLikes({ actor: bskyActor, limit: 30, ...bskyOpts }).catch(() => ({ items: [] }))),
        getBskyAuthorFeed({ actor: bskyActor, filter: 'posts_with_replies', limit: 40, ...bskyOpts }).catch(() => ({ items: [] })),
      ]);
      for (const item of Array.isArray(likesRes?.items) ? likesRes.items : []) {
        const { u, keys } = buildItemLookupKeys(item);
        if (keys.length > 0) {
          entries.push({
            keys,
            likeUri: u._meta?.bluesky?.likeUri || 'liked',
            minLikes: Math.max(1, Number(u.metrics?.likes || 0)),
          });
        }
      }
      for (const item of Array.isArray(feedRes?.items) ? feedRes.items : []) {
        if (!item || typeof item !== 'object') continue;
        if (item.rebloggedBy) {
          const { u, keys } = buildItemLookupKeys(item);
          if (keys.length > 0) {
            entries.push({ keys, repostUri: u._meta?.bluesky?.repostUri || item.rebloggedBy?.uri || 'reposted' });
          }
        }
        const parentUri = String(item.reply?.parent?.uri || item._meta?.bluesky?.reply?.parent?.uri || '').trim();
        if (parentUri) {
          entries.push({ keys: [`bluesky:${parentUri}`, parentUri], replied: true });
        }
      }
    })());
  }

  if (tasks.length > 0) {
    await Promise.allSettled(tasks);
  }
  return entries;
}

/**
 * Harvest Discovery (`Feed`) candidates from 2-hop peer activity (Home boosts, co-likers /
 * taste twins, peer likes), auto-synced subscriptions, explicit taste `top` searches,
 * trusted server `/api/v1/trends/statuses`, and minimal gated Jetstream serendipity.
 */
export async function harvestSanctuaryFeed({
  fediAuth = null,
  bskyAuth = null,
  threadsAuth = null,
  tuning: rawTuning = null,
  manifest: rawManifest = null,
  discoveryMode = 'default',
  interactedAuthors = {},
  tasteMemory = null,
  moderatedActors = [],
  filterRules = [],
  cursor = null,
  append = false,
  forceRefresh = false,
  WebSocketImpl,
  fetchImpl,
} = {}) {
  const page = append ? Math.max(0, Number(cursor?.page || 0)) : 0;
  const cursorState = append && cursor && typeof cursor === 'object' ? cursor : {};
  const manifest = normalizeRankingManifest(rawManifest);
  const isMediaMode = discoveryMode === 'visual' || discoveryMode === 'photos' || discoveryMode === 'video';
  const {
    tuning,
    activeChannels,
    hasCustomChannels,
    tagList,
    activeInstances,
    searchQueries,
  } = resolveDiscoverySources(rawTuning, fediAuth);

  const learnedTopics = extractLearnedTasteTopics(tasteMemory, 4);
  const fediHost = normalizeHostName(fediAuth?.meta?.instanceUrl || '');
  const tagHomeOrigin = fediAuth?.meta?.instanceUrl && isAllowedSocialUrl(fediAuth.meta.instanceUrl)
    ? fediAuth.meta.instanceUrl
    : (activeInstances[0] ? `https://${activeInstances[0]}` : DEFAULT_PUBLIC_MASTO_HOST);
  const tagToken = fediAuth?.secrets?.accessToken || '';
  const legTimeoutMs = typeof fetchImpl === 'function' ? undefined : 6500;
  const reqCache = forceRefresh && !append ? 'no-store' : undefined;
  const bskyReadOpts = {
    ...getBskyReadOpts(bskyAuth, fetchImpl),
    ...(reqCache ? { cache: reqCache } : {}),
    ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
  };
  const hasBskyToken = Boolean(bskyAuth?.secrets?.accessJwt);
  const hasFediToken = Boolean(fediAuth?.secrets?.accessToken);
  const ownAccounts = [fediAuth?.meta, bskyAuth?.meta, threadsAuth?.meta].filter(Boolean);
  const ownAccountKeys = buildOwnAccountKeySet(ownAccounts);

  // Page 0 pre-fetch: auto-synced Mastodon followed tags/lists & Bluesky saved feeds/follows
  let syncedFollowedTags = Array.isArray(cursorState.syncedFollowedTags) ? cursorState.syncedFollowedTags : [];
  let syncedSavedBskyFeeds = Array.isArray(cursorState.syncedSavedBskyFeeds) ? cursorState.syncedSavedBskyFeeds : [];
  let fediLists = [];
  const followedActorKeys = new Set();

  if (page === 0) {
    const preTasks = [];
    if (hasFediToken) {
      preTasks.push(
        getFollowedTags({
          instanceUrl: tagHomeOrigin,
          accessToken: tagToken,
          limit: 30,
          ...(reqCache ? { cache: reqCache } : {}),
          ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
          fetchImpl,
        }).then((tags) => { syncedFollowedTags = tags; }).catch(() => {})
      );
      preTasks.push(
        getUserLists({
          instanceUrl: tagHomeOrigin,
          accessToken: tagToken,
          fetchImpl,
        }).then((lists) => { fediLists = Array.isArray(lists) ? lists : []; }).catch(() => {})
      );
    }
    if (hasBskyToken) {
      preTasks.push(
        getBskySavedFeedUris(bskyReadOpts)
          .then((uris) => { syncedSavedBskyFeeds = uris; })
          .catch(() => {})
      );
      const bskyActor = bskyAuth?.meta?.did || bskyAuth?.meta?.handle || '';
      if (bskyActor) {
        preTasks.push(
          getBskyFollows({ actor: bskyActor, limit: 100, ...bskyReadOpts })
            .then((res) => {
              for (const actor of Array.isArray(res?.follows) ? res.follows : []) {
                addActorToKeySet(actor, 'bluesky', '', followedActorKeys);
              }
            })
            .catch(() => {})
        );
      }
    }
    if (preTasks.length > 0) {
      await Promise.allSettled(preTasks);
    }
  }

  const effectiveTags = [...tagList];
  const seenEffTags = new Set(effectiveTags);
  const modeDefaultTags = discoveryMode === 'photos'
    ? ['pixelfed', 'fediphoto', 'photography', 'illustration']
    : (discoveryMode === 'video' ? ['loops'] : []);
  for (const t of [...modeDefaultTags, ...syncedFollowedTags, ...learnedTopics.map((q) => conceptToHashtag(q))]) {
    if (!t || seenEffTags.has(t)) continue;
    seenEffTags.add(t);
    effectiveTags.push(t);
    if (effectiveTags.length >= 8) break;
  }

  const effectiveSearchQueries = [];
  const seenQueries = new Set();
  const modeDefaultQueries = discoveryMode === 'photos' ? ['photography', 'digital art', 'illustration'] : [];
  for (const q of [...learnedTopics, ...searchQueries, ...modeDefaultQueries]) {
    const clean = String(q || '').trim();
    const low = clean.toLowerCase();
    if (!clean || seenQueries.has(low)) continue;
    seenQueries.add(low);
    effectiveSearchQueries.push(clean);
    if (effectiveSearchQueries.length >= 6) break;
  }

  const bskyFeedCandidates = [...activeChannels, ...learnedTopics, ...syncedSavedBskyFeeds];
  const bskyFeedUris = Array.isArray(cursorState.bskyFeedUris) && cursorState.bskyFeedUris.length > 0
    ? cursorState.bskyFeedUris
    : (bskyFeedCandidates.length > 0
        ? await resolveCommunityBskyGenerators(bskyFeedCandidates, bskyAuth, fetchImpl, 6)
        : []);

  const hasTagSource = hasFediToken || activeInstances.length > 0 || hasCustomChannels || effectiveTags.length > 0;
  const tagBatch = hasTagSource ? buildKeyedBatch(effectiveTags, cursorState.tagCursors, page, 4) : [];
  const defaultPublicMastoHost = normalizeHostName(DEFAULT_PUBLIC_MASTO_HOST);
  const effectiveInstances = isMediaMode
    ? [...new Set([...activeInstances, defaultPublicMastoHost])]
    : activeInstances;
  const instanceBatch = effectiveInstances.length > 0
    ? buildKeyedBatch(effectiveInstances, cursorState.instanceCursors, page, 4)
    : [];
  const bskyFeedBatch = bskyFeedUris.length > 0
    ? buildKeyedBatch(bskyFeedUris, cursorState.bskyFeedCursors, page, 4)
    : [];
  const bskySearchBatch = effectiveSearchQueries.length > 0
    ? buildKeyedBatch(effectiveSearchQueries, cursorState.bskySearchCursors, page, 3)
    : [];

  const tasks = [];

  // 1. Home Timelines: collect followed authors AND extract Home boosts of unfollowed authors (2-hop)
  if (hasFediToken && discoveryMode === 'default' && (!append || cursorState.fediHomeCursor)) {
    tasks.push(
      getTimeline({
        instanceUrl: tagHomeOrigin,
        accessToken: tagToken,
        stream: 'home',
        onlyMedia: isMediaMode,
        maxId: append ? (cursorState.fediHomeCursor || '') : '',
        limit: 40,
        ...(reqCache ? { cache: reqCache } : {}),
        ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
        fetchImpl,
      }).then((res) => {
        const homeBoosts = [];
        for (const raw of res.items || []) {
          const u = toUnifiedItem(raw);
          const reblogger = u._meta?.mastodon?.rebloggedBy;
          if (reblogger) {
            addActorToKeySet(reblogger, 'mastodon', tagHomeOrigin, followedActorKeys);
            homeBoosts.push(u);
          } else {
            addActorToKeySet(u.author, 'mastodon', u._meta?.mastodon?.instanceUrl || tagHomeOrigin, followedActorKeys);
          }
        }
        return {
          kind: 'fediHome',
          key: 'home',
          items: tagFeedSource(homeBoosts, 'second_degree'),
          nextCursor: res.nextCursor || null,
        };
      })
    );
  }

  if (hasBskyToken && discoveryMode === 'default' && (!append || cursorState.bskyHomeCursor)) {
    tasks.push(
      getBskyTimeline({
        ...bskyReadOpts,
        cursor: append ? (cursorState.bskyHomeCursor || '') : '',
        limit: 40,
      }).then((res) => {
        const homeBoosts = [];
        for (const raw of res.items || []) {
          const u = toUnifiedItem(raw);
          const reblogger = u._meta?.bluesky?.rebloggedBy;
          if (reblogger) {
            addActorToKeySet(reblogger, 'bluesky', '', followedActorKeys);
            homeBoosts.push(u);
          } else {
            addActorToKeySet(u.author, 'bluesky', '', followedActorKeys);
          }
        }
        return {
          kind: 'bskyHome',
          key: 'home',
          items: tagFeedSource(homeBoosts, 'second_degree'),
          nextCursor: res.nextCursor || null,
        };
      })
    );
  }

  // 2. Mastodon List Timelines (page 0, up to 3 lists — unfollowed voices surface; followed are sieved out)
  if (page === 0 && hasFediToken && fediLists.length > 0) {
    for (const list of fediLists.slice(0, 3)) {
      if (!list?.id) continue;
      tasks.push(
        getTimeline({
          instanceUrl: tagHomeOrigin,
          accessToken: tagToken,
          stream: 'list',
          listId: list.id,
          onlyMedia: isMediaMode,
          limit: 20,
          ...(reqCache ? { cache: reqCache } : {}),
          ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
          fetchImpl,
        })
          .then((res) => ({
            kind: 'fediList',
            key: String(list.id),
            items: tagFeedSource(res.items || [], 'second_degree'),
            nextCursor: null,
          }))
          .catch(() => ({ kind: 'fediList', key: String(list.id), items: [], nextCursor: null }))
      );
    }
  }

  // 3. Trusted Server /api/v1/trends/statuses (strictly connected home + manual discoveryInstances)
  for (const { key: host, cursor: maxId } of instanceBatch) {
    tasks.push(
      fetchDiscoveryInstanceTimeline({
        host,
        maxId,
        limit: isMediaMode ? 40 : 30,
        stream: isMediaMode ? 'federated' : 'trends',
        onlyMedia: isMediaMode,
        accessToken: host === fediHost ? tagToken : '',
        ...(reqCache ? { cache: reqCache } : {}),
        ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
        fetchImpl,
      })
        .then((res) => ({
          kind: 'instance',
          key: host,
          items: tagFeedSource(res.items || [], 'discovery'),
          nextCursor: res.nextCursor || null,
        }))
        .catch(() => ({ kind: 'instance', key: host, items: [], nextCursor: null }))
    );
  }

  // 4. Bluesky Custom Feeds, Mastodon Hashtags, & Taste-Topic `top` Search
  for (const { key: feedUri, cursor: bskyCursor } of bskyFeedBatch) {
    tasks.push(
      getBskyCustomFeed({
        feed: feedUri,
        cursor: bskyCursor,
        limit: 35,
        ...bskyReadOpts,
      })
        .then((res) => ({
          kind: 'bskyFeed',
          key: feedUri,
          items: tagFeedSource(res.items || [], 'discovery'),
          nextCursor: res.nextCursor || null,
        }))
        .catch(() => ({ kind: 'bskyFeed', key: feedUri, items: [], nextCursor: null }))
    );
  }

  for (const { key: tag, cursor: maxId } of tagBatch) {
    tasks.push(
      getTagTimeline({
        instanceUrl: tagHomeOrigin,
        accessToken: hasFediToken ? tagToken : '',
        tag,
        maxId,
        limit: isMediaMode ? 40 : 25,
        onlyMedia: isMediaMode,
        ...(reqCache ? { cache: reqCache } : {}),
        ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
        fetchImpl,
      })
        .then((res) => ({
          kind: 'tag',
          key: tag,
          items: tagFeedSource(res.items || [], 'discovery'),
          nextCursor: res.nextCursor || null,
        }))
        .catch(async () => {
          if (normalizeHostName(tagHomeOrigin) !== defaultPublicMastoHost) {
            try {
              const fb = await getTagTimeline({
                instanceUrl: DEFAULT_PUBLIC_MASTO_HOST,
                accessToken: '',
                tag,
                maxId,
                limit: isMediaMode ? 40 : 25,
                onlyMedia: isMediaMode,
                ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
                fetchImpl,
              });
              return {
                kind: 'tag',
                key: tag,
                items: tagFeedSource(fb.items || [], 'discovery'),
                nextCursor: fb.nextCursor || null,
              };
            } catch {
              // Fall through to empty tag result
            }
          }
          return { kind: 'tag', key: tag, items: [], nextCursor: null };
        })
    );
  }

  for (const { key: query, cursor: searchCursor } of bskySearchBatch) {
    tasks.push(
      searchBskyPosts({
        query,
        sort: isMediaMode ? 'latest' : 'top',
        cursor: searchCursor,
        limit: isMediaMode ? 30 : 25,
        ...bskyReadOpts,
      })
        .then((res) => ({
          kind: 'bskySearch',
          key: query,
          items: tagFeedSource(res.items || [], 'discovery'),
          nextCursor: res.nextCursor || null,
        }))
        .catch(() => ({ kind: 'bskySearch', key: query, items: [], nextCursor: null }))
    );
  }

  // 5. 2-Hop Peer Likes & Co-Likers ("Taste Twins") + shared viewer activity fetch
  const ownBskyActor = bskyAuth?.meta?.did || bskyAuth?.meta?.handle || '';
  const sharedBskyLikesPromise =
    page === 0 && hasBskyToken && ownBskyActor
      ? getBskyActorLikes({ actor: ownBskyActor, limit: 30, ...bskyReadOpts }).catch(() => ({ items: [] }))
      : null;
  const sharedFediFavsPromise =
    page === 0 && hasFediToken
      ? getFavouritedStatuses({
          instanceUrl: tagHomeOrigin,
          accessToken: tagToken,
          limit: 30,
          ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
          fetchImpl,
        }).catch(() => [])
      : null;

  if (page === 0 && discoveryMode === 'default') {
    for (const actor of topAffinityActors(interactedAuthors, 'bluesky', 3, ownAccountKeys)) {
      tasks.push(
        getBskyActorLikes({ actor, limit: 8, ...bskyReadOpts })
          .then((res) => ({
            kind: 'secondDegree',
            key: `likes:${actor}`,
            items: tagFeedSource(res.items || [], 'second_degree', actor),
            nextCursor: null,
          }))
          .catch(() => ({ kind: 'secondDegree', key: `likes:${actor}`, items: [], nextCursor: null }))
      );
    }

    if (sharedBskyLikesPromise) {
      tasks.push(
        (async () => {
          const ownLikes = await sharedBskyLikesPromise;
          const likedUris = (ownLikes.items || []).map((it) => it?.uri).filter(Boolean).slice(0, 4);
          if (likedUris.length === 0) return { kind: 'coLikersBsky', key: 'twins', items: [], nextCursor: null };

          const likeLists = await Promise.all(
            likedUris.map((uri) => getBskyPostLikes({ uri, limit: 25, ...bskyReadOpts }).catch(() => ({ likes: [] })))
          );
          const twinCounts = new Map();
          const twinHandles = new Map();
          for (const res of likeLists) {
            for (const actor of res.likes || []) {
              const handle = String(actor?.handle || actor?.did || '').trim();
              if (!handle) continue;
              if (actorMatchesOwnAccountSet(actor, 'bluesky', '', ownAccountKeys)) continue;
              const key = String(actor?.did || handle).toLowerCase();
              twinCounts.set(key, (twinCounts.get(key) || 0) + 1);
              twinHandles.set(key, actor?.handle || actor?.did);
            }
          }
          const topTwins = [...twinCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 4)
            .map(([k]) => twinHandles.get(k))
            .filter(Boolean);
          const twinFeeds = await Promise.all(
            topTwins.map((twin) =>
              getBskyActorLikes({ actor: twin, limit: 8, ...bskyReadOpts })
                .then((r) => tagFeedSource(r.items || [], 'second_degree', twin))
                .catch(() => [])
            )
          );
          return { kind: 'coLikersBsky', key: 'twins', items: twinFeeds.flat(), ownLikedItems: ownLikes.items || [], nextCursor: null };
        })()
      );
    }

    if (hasFediToken) {
      for (const acct of topAffinityActors(interactedAuthors, 'mastodon', 3, ownAccountKeys)) {
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
                  excludeReplies: true,
                  limit: 6,
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

      if (sharedFediFavsPromise) {
        tasks.push(
          (async () => {
            const favs = (await sharedFediFavsPromise).slice(0, 8);
          const topIds = favs.map((s) => s?.id).filter(Boolean).slice(0, 3);
          if (topIds.length === 0) return { kind: 'coLikersMasto', key: 'twins', items: [], nextCursor: null };

          const peerLists = await Promise.all(
            topIds.map((statusId) =>
              getStatusBoostersAndLikers({
                instanceUrl: tagHomeOrigin,
                accessToken: tagToken,
                statusId,
                limit: 15,
                ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
                fetchImpl,
              }).catch(() => [])
            )
          );
          const twinCounts = new Map();
          const twinMeta = new Map();
          for (const peers of peerLists) {
            for (const peer of peers) {
              if (!peer?.id) continue;
              if (actorMatchesOwnAccountSet(peer, 'mastodon', tagHomeOrigin, ownAccountKeys)) continue;
              const k = String(peer.id);
              twinCounts.set(k, (twinCounts.get(k) || 0) + 1);
              twinMeta.set(k, peer.acct || peer.username || k);
            }
          }
          const topTwins = [...twinCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([id]) => id);
          const twinFeeds = await Promise.all(
            topTwins.map((accountId) =>
              getAccountStatuses({
                instanceUrl: tagHomeOrigin,
                accessToken: tagToken,
                accountId,
                excludeReblogs: false,
                excludeReplies: true,
                limit: 6,
                ...(legTimeoutMs ? { timeoutMs: legTimeoutMs } : {}),
                fetchImpl,
              })
                .then((list) => tagFeedSource(list || [], 'second_degree', twinMeta.get(accountId) || ''))
                .catch(() => [])
            )
          );
          return { kind: 'coLikersMasto', key: 'twins', items: twinFeeds.flat(), ownFavItems: favs || [], nextCursor: null };
        })()
      );
      }
    }
  }

  // 6. Minimal Gated Bluesky Jetstream Serendipity (capped to 10 items)
  const jetstreamMediaFilter = discoveryMode === 'photos'
    ? 'images'
    : (discoveryMode === 'video' ? 'video' : (discoveryMode === 'visual' ? 'media' : 'text'));
  const recordMatcher = buildJetstreamRecordMatcher([...searchQueries, ...learnedTopics]);
  tasks.push(
    harvestBlueskyJetstreamBurst({
      targetCount: isMediaMode ? 28 : 10,
      maxDurationMs: isMediaMode ? 2200 : 1800,
      cursorRewindMs: 45_000 + page * 180_000,
      mediaOnly: isMediaMode,
      mediaFilter: jetstreamMediaFilter,
      blockedSelfLabels: manifest.sensitiveContentTriggers.jetstreamBlockedSelfLabels,
      recordMatcher,
      timeoutMs: legTimeoutMs || 3500,
      ...(WebSocketImpl ? { WebSocketImpl } : {}),
      fetchImpl,
      ...bskyReadOpts,
    })
      .then((resItems) => ({
        kind: 'jetstream',
        key: discoveryMode,
        items: tagFeedSource(resItems || [], 'discovery'),
        nextCursor: null,
      }))
      .catch(() => ({ kind: 'jetstream', key: discoveryMode, items: [], nextCursor: null }))
  );

  if (page === 0 && hasCustomChannels && threadsAuth?.secrets?.accessToken && effectiveSearchQueries.length > 0) {
    for (const q of effectiveSearchQueries.slice(0, 2)) {
      tasks.push(
        searchThreadsKeyword({
          query: q,
          searchType: 'RECENT',
          limit: 20,
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

  if (page === 0) {
    tasks.push(
      syncOwnViewerActivity({
        fediAuth,
        bskyAuth,
        prefetchedFediFavs: sharedFediFavsPromise,
        prefetchedBskyLikes: sharedBskyLikesPromise,
        timeoutMs: legTimeoutMs || 5500,
        fetchImpl,
      })
        .then((viewerEntries) => ({ kind: 'viewerActivity', key: 'own', items: [], viewerEntries, nextCursor: null }))
        .catch(() => ({ kind: 'viewerActivity', key: 'own', items: [], viewerEntries: [], nextCursor: null }))
    );
  }

  if (tasks.length === 0) {
    return { items: [], nextCursor: null };
  }

  const settled = await Promise.allSettled(tasks);
  const rawCollected = [];
  const ownInteractedItems = [];
  const nextTagCursors = {};
  const nextInstanceCursors = {};
  const nextBskyFeedCursors = {};
  const nextBskySearchCursors = {};
  let nextFediHomeCursor = '';
  let nextBskyHomeCursor = '';
  let anySucceeded = false;
  let firstError = '';

  const optionalKinds = new Set([
    'fediList',
    'threadsSearch',
    'secondDegree',
    'secondDegreeMasto',
    'coLikersBsky',
    'coLikersMasto',
    'jetstream',
    'viewerActivity',
  ]);
  let hadPoolResponse = false;
  let hadJetstreamItems = false;
  const discoveredViewerEntries = [];
  for (const entry of settled) {
    if (entry.status !== 'fulfilled') {
      if (!firstError) firstError = entry.reason?.message || 'Unable to load Sanctuary feed.';
      continue;
    }
    const { kind, key, items, nextCursor, ownLikedItems, ownFavItems, viewerEntries } = entry.value;
    if (kind === 'jetstream') {
      hadPoolResponse = true;
      if (Array.isArray(items) && items.length > 0) hadJetstreamItems = true;
    }
    if (!optionalKinds.has(kind) || items.length > 0) {
      anySucceeded = true;
    }
    rawCollected.push(...(items || []));
    if (Array.isArray(ownLikedItems) && ownLikedItems.length > 0) ownInteractedItems.push(...ownLikedItems);
    if (Array.isArray(ownFavItems) && ownFavItems.length > 0) ownInteractedItems.push(...ownFavItems);
    if (Array.isArray(viewerEntries) && viewerEntries.length > 0) discoveredViewerEntries.push(...viewerEntries);
    if (kind === 'fediHome' && nextCursor) nextFediHomeCursor = nextCursor;
    else if (kind === 'bskyHome' && nextCursor) nextBskyHomeCursor = nextCursor;
    else if (kind === 'tag' && nextCursor) nextTagCursors[key] = nextCursor;
    else if (kind === 'instance' && nextCursor) nextInstanceCursors[key] = nextCursor;
    else if (kind === 'bskyFeed' && nextCursor) nextBskyFeedCursors[key] = nextCursor;
    else if (kind === 'bskySearch' && nextCursor) nextBskySearchCursors[key] = nextCursor;
  }

  if (!anySucceeded && !hadPoolResponse) {
    throw new Error(firstError || 'Unable to load Sanctuary feed.');
  }

  if ((ownInteractedItems.length > 0 || discoveredViewerEntries.length > 0) && rawCollected.length > 0) {
    const interactedByKey = new Map();
    const minCountsByKey = new Map();
    const recordPatch = (key, patch, minLikes = 0, minReposts = 0) => {
      if (!key) return;
      const cur = interactedByKey.get(key) || {};
      interactedByKey.set(key, mergeViewerActivityMeta(cur, patch));
      const prevMin = minCountsByKey.get(key) || { likes: 0, reposts: 0 };
      minCountsByKey.set(key, {
        likes: Math.max(prevMin.likes, Number(minLikes || 0)),
        reposts: Math.max(prevMin.reposts, Number(minReposts || 0)),
      });
    };
    for (const raw of ownInteractedItems) {
      const { u, keys } = buildItemLookupKeys(raw);
      for (const k of keys) recordPatch(k, u._meta, u.metrics?.likes, u.metrics?.reposts);
    }
    for (const ent of discoveredViewerEntries) {
      const patch = {
        ...(ent.replied ? { viewerReplied: true } : {}),
        ...(ent.favourited || ent.reblogged || ent.bookmarked || ent.replied
          ? {
              mastodon: {
                ...(ent.favourited ? { favourited: true } : {}),
                ...(ent.reblogged ? { reblogged: true } : {}),
                ...(ent.bookmarked ? { bookmarked: true } : {}),
                ...(ent.replied ? { replied: true } : {}),
              },
            }
          : {}),
        ...(ent.likeUri || ent.repostUri || ent.replied
          ? {
              bluesky: {
                ...(ent.likeUri ? { likeUri: ent.likeUri } : {}),
                ...(ent.repostUri ? { repostUri: ent.repostUri } : {}),
                ...(ent.replied ? { replied: true } : {}),
              },
            }
          : {}),
      };
      for (const k of Array.isArray(ent.keys) ? ent.keys : []) {
        recordPatch(k, patch, ent.minLikes, ent.minReposts);
      }
    }
    for (let i = 0; i < rawCollected.length; i += 1) {
      const { u, keys } = buildItemLookupKeys(rawCollected[i]);
      let matchedMeta = null;
      let floorLikes = 0;
      let floorReposts = 0;
      for (const k of keys) {
        const hit = interactedByKey.get(k);
        if (hit) matchedMeta = matchedMeta ? mergeViewerActivityMeta(matchedMeta, hit) : hit;
        const mc = minCountsByKey.get(k);
        if (mc) {
          floorLikes = Math.max(floorLikes, mc.likes);
          floorReposts = Math.max(floorReposts, mc.reposts);
        }
      }
      if (matchedMeta) {
        rawCollected[i] = reconcileViewerMetricFloors({
          ...u,
          metrics: {
            ...(u.metrics || { replies: 0, reposts: 0, likes: 0 }),
            likes: Math.max(Number(u.metrics?.likes || 0), floorLikes),
            reposts: Math.max(Number(u.metrics?.reposts || 0), floorReposts),
          },
          _meta: mergeViewerActivityMeta(u._meta, matchedMeta),
        });
      }
    }
  }

  const items = sieveSovereignCandidates(rawCollected, tuning, {
    ownAccounts,
    followedActors: followedActorKeys,
    moderatedActors,
    filterRules,
    discoveryMode,
    manifest,
  });
  const nextPage = page + 1;
  const hasMoreSlices =
    nextPage < 6
    && (
      (hasTagSource && nextPage * 4 < effectiveTags.length)
      || (effectiveInstances.length > 0 && nextPage * 4 < effectiveInstances.length)
      || (bskyFeedUris.length > 0 && nextPage * 4 < bskyFeedUris.length)
      || (bskySearchBatch.length > 0 && nextPage * 3 < effectiveSearchQueries.length)
    );
  const hasUpstreamCursors =
    nextPage < 12
    && (
      Boolean(nextFediHomeCursor)
      || Boolean(nextBskyHomeCursor)
      || (isMediaMode && hadJetstreamItems)
      || Object.keys(nextTagCursors).length > 0
      || Object.keys(nextInstanceCursors).length > 0
      || Object.keys(nextBskyFeedCursors).length > 0
      || Object.keys(nextBskySearchCursors).length > 0
    );

  const nextCursor = (hasMoreSlices || hasUpstreamCursors)
    ? {
        page: nextPage,
        bskyFeedUris,
        syncedFollowedTags,
        syncedSavedBskyFeeds,
        ...(nextFediHomeCursor ? { fediHomeCursor: nextFediHomeCursor } : {}),
        ...(nextBskyHomeCursor ? { bskyHomeCursor: nextBskyHomeCursor } : {}),
        tagCursors: nextTagCursors,
        instanceCursors: nextInstanceCursors,
        bskyFeedCursors: nextBskyFeedCursors,
        bskySearchCursors: nextBskySearchCursors,
      }
    : null;

  return { items, nextCursor, viewerEntries: discoveredViewerEntries };
}
