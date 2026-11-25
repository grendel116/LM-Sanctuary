import { BlueskyAdapter } from '../adapters/bluesky/index.js';
import { MastodonAdapter } from '../adapters/mastodon/index.js';
import { ThreadsAdapter } from '../adapters/threads/index.js';
import { DEFAULT_THREADS_SCOPES, PUBLIC_BSKY_API, isAllowedSocialUrl, normalizeInstanceUrl } from '../constants/endpoints.js';
import {
  buildSynthesizedReplyContext,
  canonicalizeActorHandle,
  deduplicateUnifiedItems,
  enrichUnlinkedMentionsInHtml,
  hasRenderablePostContent,
  isRepostUnifiedItem,
  isUnifiedItemModerated,
  mergeUnifiedPostMetadata,
  plainTextToHtml,
  toUnifiedItem,
} from '../core/schema/unifiedItem.js';
import {
  getNetworkMetrics,
  hydrateMetricsLedger,
  recordItemMetrics,
} from '../state/metricsLedger.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';
import { extractFirstHttpsUrl, fetchLinkPreview } from './linkPreview.js';
import {
  buildThreadsAuthorizeUrl,
  exchangeThreadsLongLivedToken,
  exchangeThreadsOAuthCode,
  getThreadsPostInsights,
  getThreadsPostsInsightsBatch,
  manageThreadsReply,
  refreshThreadsLongLivedToken,
  verifyThreadsCredentials,
} from './threads.js';
import {
  blockBskyActor,
  followBskyActor,
  getBskyAuthorFeed,
  getBskyBlocks,
  getBskyFollowers,
  getBskyFollows,
  getBskyMutes,
  getBskyMutedWords,
  getBskyPostThread,
  getBskyPostsByUris,
  getBskyPostsMetrics,
  getBskyProfile,
  hideBskyReply,
  muteBskyActor,
  normalizeBskyActorProfile,
  normalizeBskyActorSummary,
  searchBskyActors,
  searchBskyPosts,
  syncBskyMutedWord,
  updateBskyNotificationsSeen,
  updateBskyProfile,
} from './bluesky.js';
import {
  addAccountsToList,
  blockAccount,
  cleanMastodonMediaUrl,
  clearMastodonNotifications,
  createFilterRule,
  createUserList,
  decodeHtmlEntities,
  deleteFilterRule,
  deleteUserList,
  dismissMastodonNotification,
  followAccount,
  getAccountFollowers,
  getAccountFollowing,
  getAccountProfile,
  getAccountStatuses,
  getBlocks,
  getFilters,
  getFollowRequests,
  getListAccounts,
  getMutes,
  getRelationships,
  getStatus,
  getStatusContext,
  getTimeline,
  getUserLists,
  lookupAccountByAcct,
  muteAccount,
  removeAccountsFromList,
  removeFollower,
  respondFollowRequest,
  sanitizeFediverseHtmlToString,
  searchFediverse,
  translateMastodonStatus,
  updateCredentials,
} from './fediverse.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens, upsertSocialAccount } from '../state/authStore.js';
import {
  feedStore,
  hydrateCachedModeration,
  mutatePostAcrossStreams,
  persistCachedFilters,
  purgeModeratedAuthorAffinity,
  recordViewerInteraction,
  setFilterRules,
  setModeratedActors,
} from '../state/feedStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import {
  deleteSanctuaryLinkedPost,
  fetchSanctuaryKeywordFilters,
  fetchSanctuaryLinkedPosts,
  requestSocialBridge,
  saveSanctuaryKeywordFilters,
  saveSanctuaryLinkedPost,
  syncMastodonUserProfileToSanctuary,
} from './sanctuary.js';
import {
  deleteLocalFilterRule,
  deleteLocalLinkedChildren as deleteLocalLinkedChildrenOnDevice,
  deleteLocalLinkedPost as deleteLocalLinkedPostOnDevice,
  deleteLocalRetry,
  enqueueLocalRetry,
  findLocalLinkedPost,
  findLocalLinkedPostGroup,
  getLocalModeratedAccounts,
  kvGet,
  kvSet,
  listLocalFilterRules,
  listLocalLinkedPosts,
  listLocalRetries,
  removeLocalModeratedAccount,
  saveLocalFilterRule,
  saveLocalLinkedPost as saveLocalLinkedPostOnDevice,
  saveLocalModeratedAccounts,
} from '../storage/nativeStore.js';

const IS_NODE_RUNTIME = typeof globalThis.process?.versions?.node === 'string';
const LINKED_POST_DELETIONS_KEY = 'social_linked_post_deletions_v1';
const LINKED_POST_FIELDS = [
  'mastodonStatusId',
  'mastodonInstance',
  'blueskyUri',
  'blueskyCid',
  'threadsPostId',
  'parentCanonicalId',
];
const CROSSPOST_RECOVERY_KEY = 'crosspost_recovery_v1';
const CROSSPOST_MATCH_WINDOW_MS = 10 * 60 * 1000;
let linkedPostSyncPromise = null;
let crossPostRecoveryPromise = null;

function mergeLinkedPostRecords(local = {}, remote = {}) {
  const localIsNewer = Number(local.updatedAt || 0) >= Number(remote.updatedAt || 0);
  const preferred = localIsNewer ? local : remote;
  const secondary = localIsNewer ? remote : local;
  const merged = { ...secondary, ...preferred };
  for (const field of LINKED_POST_FIELDS) {
    merged[field] = String(preferred[field] || secondary[field] || '');
    if (!merged[field]) delete merged[field];
  }
  merged.canonicalId = String(local.canonicalId || remote.canonicalId || '');
  return merged;
}

function sameLinkedPostFields(a = {}, b = {}) {
  return LINKED_POST_FIELDS.every((field) => String(a[field] || '') === String(b[field] || ''));
}

async function queueLinkedPostDeletions(canonicalIds) {
  const pending = await kvGet(LINKED_POST_DELETIONS_KEY, []);
  const next = new Set(Array.isArray(pending) ? pending.map(String) : []);
  for (const canonicalId of canonicalIds) {
    if (canonicalId) next.add(String(canonicalId));
  }
  await kvSet(LINKED_POST_DELETIONS_KEY, [...next]);
}

export async function saveLocalLinkedPost(record) {
  if (!record?.canonicalId) return;
  const saved = {
    ...record,
    updatedAt: Math.max(Date.now(), Number(record.updatedAt || 0)),
  };
  await saveLocalLinkedPostOnDevice(saved);
  const nodeUrl = connectionStore.get().nodeUrl;
  if (nodeUrl) {
    void saveSanctuaryLinkedPost(saved.canonicalId, saved, { nodeUrl }).catch((err) => {
      console.error('[social links] Could not sync a cross-post mapping:', err);
    });
  }
}

export async function deleteLocalLinkedPost(anyId) {
  const group = await findLocalLinkedPostGroup(anyId);
  const record = group[0] || await findLocalLinkedPost(anyId);
  const canonicalIds = [...new Set(
    [...group, ...(record ? [record] : [])]
      .map((item) => String(item?.canonicalId || item?.canonical_id || ''))
      .filter(Boolean)
  )];
  await deleteLocalLinkedPostOnDevice(anyId);
  if (canonicalIds.length > 0) {
    await queueLinkedPostDeletions(canonicalIds);
    void syncLinkedPostsWithSanctuary().catch((err) => {
      console.error('[social links] Could not sync cross-post deletion:', err);
    });
  }
}

export async function deleteLocalLinkedChildren(parentCanonicalId) {
  const group = await findLocalLinkedPostGroup(parentCanonicalId);
  const childIds = group
    .filter((record) => String(record.parentCanonicalId || '') === String(parentCanonicalId))
    .map((record) => String(record.canonicalId || record.canonical_id || ''))
    .filter(Boolean);
  await deleteLocalLinkedChildrenOnDevice(parentCanonicalId);
  if (childIds.length > 0) {
    await queueLinkedPostDeletions(childIds);
    void syncLinkedPostsWithSanctuary().catch((err) => {
      console.error('[social links] Could not sync cross-post deletion:', err);
    });
  }
}

export async function syncLinkedPostsWithSanctuary() {
  if (linkedPostSyncPromise) return linkedPostSyncPromise;
  const nodeUrl = connectionStore.get().nodeUrl;
  if (!nodeUrl) return false;

  linkedPostSyncPromise = (async () => {
    const pending = await kvGet(LINKED_POST_DELETIONS_KEY, []);
    for (const canonicalId of Array.isArray(pending) ? pending : []) {
      await deleteSanctuaryLinkedPost(String(canonicalId), { nodeUrl });
    }
    await kvSet(LINKED_POST_DELETIONS_KEY, []);

    const response = await fetchSanctuaryLinkedPosts({ nodeUrl });
    const remoteRecords = Array.isArray(response?.records) ? response.records : [];
    const deletedIds = new Set(
      Array.isArray(response?.deletedIds) ? response.deletedIds.map(String) : []
    );
    for (const canonicalId of deletedIds) {
      await deleteLocalLinkedPostOnDevice(canonicalId);
    }

    const localRecords = await listLocalLinkedPosts(100000);
    const remoteById = new Map(
      remoteRecords
        .filter((record) => record?.canonicalId)
        .map((record) => [String(record.canonicalId), record])
    );
    const localById = new Map(
      localRecords
        .filter((record) => record?.canonicalId || record?.canonical_id)
        .map((record) => [String(record.canonicalId || record.canonical_id), record])
    );

    for (const [canonicalId, local] of localById) {
      if (deletedIds.has(canonicalId)) continue;
      const remote = remoteById.get(canonicalId);
      if (!remote) {
        await saveSanctuaryLinkedPost(canonicalId, local, { nodeUrl });
        continue;
      }
      const merged = mergeLinkedPostRecords(local, remote);
      if (!sameLinkedPostFields(merged, local)) {
        await saveLocalLinkedPostOnDevice(merged);
      }
      if (!sameLinkedPostFields(merged, remote)) {
        await saveSanctuaryLinkedPost(canonicalId, merged, { nodeUrl });
      }
    }

    for (const [canonicalId, remote] of remoteById) {
      if (!deletedIds.has(canonicalId) && !localById.has(canonicalId)) {
        await saveLocalLinkedPostOnDevice(remote);
      }
    }
    return true;
  })().finally(() => {
    linkedPostSyncPromise = null;
  });
  return linkedPostSyncPromise;
}

function crossPostText(item) {
  return String(item?.content_text || item?.text || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

function crossPostTimestamp(item) {
  return Date.parse(item?.date_published || item?.createdAt || '');
}

export function findUniqueCrossPostMatches(primaryItems, secondaryItems) {
  const secondariesByText = new Map();
  for (const item of secondaryItems || []) {
    const text = crossPostText(item);
    const timestamp = crossPostTimestamp(item);
    if (text.length < 3 || !Number.isFinite(timestamp) || !item?.id) continue;
    const bucket = secondariesByText.get(text) || [];
    bucket.push({ item, timestamp });
    secondariesByText.set(text, bucket);
  }

  const primariesByText = new Map();
  const primaryRows = [];
  for (const item of primaryItems || []) {
    const text = crossPostText(item);
    const timestamp = crossPostTimestamp(item);
    if (text.length < 3 || !Number.isFinite(timestamp) || !item?.id) continue;
    const row = { item, text, timestamp };
    primaryRows.push(row);
    const bucket = primariesByText.get(text) || [];
    bucket.push(row);
    primariesByText.set(text, bucket);
  }

  const matches = new Map();
  for (const primary of primaryRows) {
    const candidates = (secondariesByText.get(primary.text) || [])
      .filter((secondary) => Math.abs(secondary.timestamp - primary.timestamp) <= CROSSPOST_MATCH_WINDOW_MS);
    if (candidates.length !== 1) continue;
    const candidate = candidates[0];
    const competingPrimaries = (primariesByText.get(primary.text) || [])
      .filter((other) => Math.abs(other.timestamp - candidate.timestamp) <= CROSSPOST_MATCH_WINDOW_MS);
    if (competingPrimaries.length === 1) {
      matches.set(String(primary.item.id), candidate.item);
    }
  }
  return matches;
}

async function fetchMastodonRecoveryPosts(account) {
  const posts = [];
  let maxId = '';
  for (let page = 0; page < 8; page += 1) {
    const rows = await getAccountStatuses({
      instanceUrl: account.meta.instanceUrl || 'https://mastodon.social',
      accessToken: account.secrets.accessToken,
      accountId: account.meta.userId || account.meta.acct || account.meta.handle,
      maxId,
      excludeReblogs: true,
      limit: 40,
    });
    if (rows.length === 0) break;
    const items = rows.map((row) => toUnifiedItem(row));
    posts.push(...items);
    const last = items[items.length - 1];
    const nextId = String(last?._meta?.mastodon?.statusId || '').trim();
    if (!nextId || nextId === maxId) break;
    maxId = nextId;
    if (posts.length >= 320) break;
  }
  return posts;
}

async function fetchBlueskyRecoveryPosts(account) {
  const actor = account.meta.did || account.meta.handle || account.meta.acct;
  if (!actor) return [];
  const posts = [];
  let cursor = '';
  for (let page = 0; page < 5; page += 1) {
    const response = await getBskyAuthorFeed({
      actor,
      cursor,
      limit: 100,
      filter: 'posts_with_replies',
      ...getBskyReadOpts(account),
    });
    const items = (response.items || [])
      .map((item) => toUnifiedItem(item))
      .filter((item) => item.author?.id === actor || item.author?.handle === account.meta.handle);
    posts.push(...items);
    if (!response.nextCursor || response.nextCursor === cursor || items.length === 0) break;
    cursor = response.nextCursor;
  }
  return posts;
}

async function fetchThreadsRecoveryPosts(limit = 100) {
  const { threads } = await getClientAdapters();
  if (!threads) return [];
  const items = await threads.fetchOwnPosts(limit, { includeInsights: false });
  return (Array.isArray(items) ? items : []).filter((it) => hasRenderablePostContent(it) && !isRepostUnifiedItem(it));
}

const CROSSPOST_RECOVERY_REFRESH_MS = 6 * 60 * 60 * 1000;

export async function recoverUniqueCrossPostLinks() {
  if (crossPostRecoveryPromise) return crossPostRecoveryPromise;
  crossPostRecoveryPromise = (async () => {
    const mastodon = await getAuthenticatedAccount('fediverse');
    const bluesky = await getAuthenticatedAccount('bluesky');
    const threads = await getAuthenticatedAccount('threads');
    if (!mastodon || (!bluesky && !threads)) return { recovered: 0, skipped: true };

    const platformSig = ['mastodon', bluesky ? 'bluesky' : '', threads ? 'threads' : ''].filter(Boolean).join('+');
    const prevState = await kvGet(CROSSPOST_RECOVERY_KEY, null);
    const now = Date.now();
    const sameSig = prevState === true || (prevState && typeof prevState === 'object' && prevState.sig === platformSig);
    const lastRunAt = prevState && typeof prevState === 'object' ? Number(prevState.lastRunAt || 0) : 0;
    if (sameSig && (prevState === true || (lastRunAt > 0 && now - lastRunAt < CROSSPOST_RECOVERY_REFRESH_MS))) {
      return { recovered: 0, skipped: true };
    }
    const recentOnly = Boolean(sameSig && lastRunAt > 0);

    const requests = [
      (recentOnly
        ? getAccountStatuses({
            instanceUrl: mastodon.meta.instanceUrl || 'https://mastodon.social',
            accessToken: mastodon.secrets.accessToken,
            accountId: mastodon.meta.userId || mastodon.meta.acct || mastodon.meta.handle,
            excludeReblogs: true,
            limit: 40,
          }).then((rows) => rows.map((row) => toUnifiedItem(row)))
        : fetchMastodonRecoveryPosts(mastodon)
      ).then((items) => ['mastodon', items]),
      ...(bluesky
        ? [(recentOnly
            ? getBskyAuthorFeed({
                actor: bluesky.meta.did || bluesky.meta.handle || bluesky.meta.acct,
                limit: 40,
                filter: 'posts_with_replies',
                ...getBskyReadOpts(bluesky),
              }).then((r) => (r.items || []).map((it) => toUnifiedItem(it)))
            : fetchBlueskyRecoveryPosts(bluesky)
          ).then((items) => ['bluesky', items])]
        : []),
      ...(threads
        ? [fetchThreadsRecoveryPosts(recentOnly ? 40 : 100).then((items) => ['threads', items])]
        : []),
    ];
    const settled = await Promise.allSettled(requests);
    const results = new Map();
    const errors = [];
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.set(result.value[0], result.value[1]);
      } else {
        errors.push(result.reason);
      }
    }
    const mastodonPosts = results.get('mastodon');
    if (!mastodonPosts || (!results.has('bluesky') && !results.has('threads'))) {
      throw errors[0] || new Error('Could not load enough connected post histories to recover cross-post links.');
    }

    const bskyMatches = results.has('bluesky')
      ? findUniqueCrossPostMatches(mastodonPosts, results.get('bluesky'))
      : new Map();
    const threadsMatches = results.has('threads')
      ? findUniqueCrossPostMatches(mastodonPosts, results.get('threads'))
      : new Map();
    const existing = await listLocalLinkedPosts(100000);
    const existingById = new Map(
      existing.map((record) => [String(record.canonicalId || record.canonical_id || ''), record])
    );
    let recovered = 0;
    for (const post of mastodonPosts) {
      const canonicalId = String(post.id || '');
      const statusId = String(post._meta?.mastodon?.statusId || '');
      if (!canonicalId || !statusId) continue;
      const previous = existingById.get(canonicalId) || {};
      const bskyPost = bskyMatches.get(canonicalId);
      const threadsPost = threadsMatches.get(canonicalId);
      const record = {
        ...previous,
        canonicalId,
        mastodonStatusId: statusId,
        mastodonInstance: String(post._meta?.mastodon?.instanceUrl || mastodon.meta.instanceUrl || ''),
        ...(bskyPost?._meta?.bluesky?.uri
          ? {
              blueskyUri: String(bskyPost._meta.bluesky.uri),
              blueskyCid: String(bskyPost._meta.bluesky.cid || ''),
            }
          : {}),
        ...(threadsPost?._meta?.threads?.postId
          ? { threadsPostId: String(threadsPost._meta.threads.postId) }
          : {}),
      };
      const hasCrossPost = Boolean(record.blueskyUri || record.threadsPostId);
      const changed =
        String(previous.blueskyUri || '') !== String(record.blueskyUri || '')
        || String(previous.threadsPostId || '') !== String(record.threadsPostId || '');
      if (hasCrossPost && changed) {
        await saveLocalLinkedPostOnDevice(record);
        recovered += 1;
      }
    }
    if (errors.length === 0) {
      await kvSet(CROSSPOST_RECOVERY_KEY, { sig: platformSig, lastRunAt: Date.now() });
    }
    let serverSynced = false;
    try {
      serverSynced = await syncLinkedPostsWithSanctuary();
    } catch (err) {
      console.error('[social links] Could not sync recovered mappings with Sanctuary:', err);
    }
    return { recovered, skipped: false, serverSynced };
  })().finally(() => {
    crossPostRecoveryPromise = null;
  });
  return crossPostRecoveryPromise;
}

function getItemLinkKey(item) {
  return String(
    item?.id ||
      (item?._meta?.mastodon?.statusId ? `mastodon:${item._meta.mastodon.statusId}` : '') ||
      (item?._meta?.bluesky?.uri ? `bluesky:${item._meta.bluesky.uri}` : '') ||
      (item?._meta?.threads?.postId ? `threads:${item._meta.threads.postId}` : '')
  );
}

function resolveLinkedRecordFromItem(item, stored) {
  const existing = item?._meta?.linkedIds || {};
  const mastoId = String(
    stored?.mastodonStatusId ||
      existing.mastodonStatusId ||
      item?._meta?.mastodon?.statusId ||
      (item?.protocol === 'mastodon' ? String(item?.id || '').replace(/^mastodon:/, '') : '')
  );
  const bskyUri = String(
    existing.blueskyUri ||
      stored?.blueskyUri ||
      item?._meta?.bluesky?.uri ||
      ''
  );
  const bskyCid = String(
    existing.blueskyCid ||
      stored?.blueskyCid ||
      item?._meta?.bluesky?.cid ||
      ''
  );
  const threadsPostId = String(
    existing.threadsPostId ||
      stored?.threadsPostId ||
      item?._meta?.threads?.postId ||
      ''
  );
  return {
    ...(mastoId ? { mastodonStatusId: mastoId } : {}),
    ...(bskyUri ? { blueskyUri: bskyUri, ...(bskyCid ? { blueskyCid: bskyCid } : {}) } : {}),
    ...(threadsPostId ? { threadsPostId } : {}),
  };
}

/**
 * Resolve linked cross-post records and aggregate likes/replies/reposts across
 * Mastodon, Bluesky, and Meta Threads with per-network breakdown metadata.
 */
export async function enrichUnifiedItemsMetrics(items = []) {
  if (!Array.isArray(items) || items.length === 0) return Array.isArray(items) ? items : [];
  await hydrateMetricsLedger();

  const allStored = await listLocalLinkedPosts(1000).catch((err) => {
    console.warn('[socialClient] listLocalLinkedPosts failed:', err);
    return [];
  });
  const storedIndex = new Map();
  for (const rec of Array.isArray(allStored) ? allStored : []) {
    if (!rec || typeof rec !== 'object') continue;
    const cid = String(rec.canonicalId || rec.canonical_id || '').trim();
    if (cid) storedIndex.set(cid, rec);
    if (rec.mastodonStatusId) storedIndex.set(`mastodon:${String(rec.mastodonStatusId)}`, rec);
    if (rec.blueskyUri) storedIndex.set(`bluesky:${String(rec.blueskyUri)}`, rec);
    if (rec.threadsPostId) storedIndex.set(`threads:${String(rec.threadsPostId)}`, rec);
  }

  const storedByKey = new Map();
  for (const item of items) {
    const key = getItemLinkKey(item);
    if (!key) continue;
    const stored = storedIndex.get(key)
      || (item?._meta?.mastodon?.statusId ? storedIndex.get(`mastodon:${item._meta.mastodon.statusId}`) : null)
      || null;
    if (stored) storedByKey.set(key, stored);
  }

  const bskyUris = new Set();
  const threadsIds = new Set();
  const resolvedLinks = items.map((item) => {
    const stored = storedByKey.get(getItemLinkKey(item)) || null;
    const link = resolveLinkedRecordFromItem(item, stored);
    const legCount = Number(Boolean(link.mastodonStatusId)) + Number(Boolean(link.blueskyUri)) + Number(Boolean(link.threadsPostId));
    const isLinked = legCount >= 2;
    if (link.blueskyUri && (isLinked || item?.protocol !== 'bluesky')) {
      bskyUris.add(link.blueskyUri);
    }
    if (link.threadsPostId && (isLinked || item?.protocol === 'threads')) {
      threadsIds.add(link.threadsPostId);
    }
    return { link, hasStored: Boolean(stored) };
  });

  if (bskyUris.size === 0 && threadsIds.size === 0 && storedByKey.size === 0) {
    return items;
  }

  const [bskyAuth, threadsAuth] = await Promise.all([
    bskyUris.size > 0 ? getAuthenticatedAccount('bluesky') : null,
    threadsIds.size > 0 ? getAuthenticatedAccount('threads') : null,
  ]);

  let bskyMetrics = {};
  if (bskyUris.size > 0) {
    bskyMetrics = await getBskyPostsMetrics({
      uris: [...bskyUris],
      ...getBskyReadOpts(bskyAuth),
    }).catch((err) => {
      console.warn('[socialClient] getBskyPostsMetrics failed:', err);
      return {};
    });
  }

  const threadsMetrics = {};
  const threadsToken = threadsAuth?.secrets?.accessToken || '';
  if (threadsIds.size > 0 && threadsToken) {
    const tids = [...threadsIds].slice(0, 25);
    const batchRes = await getThreadsPostsInsightsBatch({ postIds: tids, accessToken: threadsToken }).catch((err) => {
      console.warn('[socialClient] getThreadsPostsInsightsBatch failed:', err);
      return {};
    });
    if (batchRes && typeof batchRes === 'object') {
      Object.assign(threadsMetrics, batchRes);
    }
  }

  return items.map((item, idx) => {
    const { link, hasStored } = resolvedLinks[idx] || { link: {}, hasStored: false };
    const hasCrossLink = Number(Boolean(link.mastodonStatusId)) + Number(Boolean(link.blueskyUri)) + Number(Boolean(link.threadsPostId)) >= 2;
    if (!hasCrossLink && !hasStored && !threadsMetrics[link.threadsPostId || ''] && !bskyMetrics[link.blueskyUri || '']) {
      return item;
    }

    const baseProto = String(item?.protocol || 'mastodon');
    const prevBd = item?._meta?.metricsBreakdown;
    const baseMetrics = prevBd?.[baseProto] || {
      likes: Number(item?.metrics?.likes || 0),
      replies: Number(item?.metrics?.replies || 0),
      reposts: Number(item?.metrics?.reposts || 0),
    };
    const breakdown = {
      [baseProto]: {
        likes: Number(baseMetrics.likes || 0),
        replies: Number(baseMetrics.replies || 0),
        reposts: Number(baseMetrics.reposts || 0),
      },
    };
    const bM = link.blueskyUri
      ? (bskyMetrics[link.blueskyUri] || prevBd?.bluesky || getNetworkMetrics(`bluesky:${link.blueskyUri}`))
      : null;
    if (bM) {
      breakdown.bluesky = { ...bM };
    }
    const tM = link.threadsPostId
      ? (threadsMetrics[link.threadsPostId] || prevBd?.threads || getNetworkMetrics(`threads:${link.threadsPostId}`))
      : null;
    if (tM) {
      breakdown.threads = { ...tM };
    }

    const keys = Object.keys(breakdown);
    const total = { likes: 0, replies: 0, reposts: 0 };
    for (const m of Object.values(breakdown)) {
      total.likes += Number(m.likes || 0);
      total.replies += Number(m.replies || 0);
      total.reposts += Number(m.reposts || 0);
    }

    const enrichedItem = {
      ...item,
      metrics: keys.length >= 2
        ? total
        : {
            likes: Number(breakdown[baseProto].likes || 0),
            replies: Number(breakdown[baseProto].replies || 0),
            reposts: Number(breakdown[baseProto].reposts || 0),
          },
      _meta: {
        ...(item?._meta || {}),
        ...(Object.keys(link).length > 0 ? { linkedIds: { ...(item?._meta?.linkedIds || {}), ...link } } : {}),
        ...(keys.length >= 2 ? { metricsBreakdown: breakdown } : {}),
      },
    };
    recordItemMetrics(enrichedItem);
    return enrichedItem;
  });
}

function getBskyReadOpts(bskyAuth) {
  return bskyAuth
    ? {
        serviceUrl: bskyAuth.meta.serviceUrl,
        accessJwt: bskyAuth.secrets.accessJwt,
        refreshJwt: bskyAuth.secrets.refreshJwt,
        onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
      }
    : { serviceUrl: PUBLIC_BSKY_API };
}

function splitTextClean(rawText, limit) {
  const text = String(rawText || '').trim();
  const chars = [...text];
  if (chars.length <= limit) return text ? [text] : [];
  const chunks = [];
  let rest = text;
  while ([...rest].length > limit) {
    const slice = [...rest].slice(0, limit + 1).join('');
    let cut = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    if (cut < Math.floor(slice.length * 0.45)) cut = [...rest].slice(0, limit).join('').length;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export async function connectThreadsToken({ accessToken, clientSecret = '', expiresIn = 0 } = {}) {
  const cleanTok = String(accessToken || '').trim();
  if (!cleanTok) throw new Error('Threads access token is required.');

  let finalToken = cleanTok;
  let resolvedExp = Number(expiresIn || 0);
  if (clientSecret && resolvedExp <= 0) {
    try {
      const longRes = await exchangeThreadsLongLivedToken({
        clientSecret: String(clientSecret).trim(),
        accessToken: finalToken,
      });
      if (longRes?.access_token) {
        finalToken = String(longRes.access_token);
        resolvedExp = Number(longRes.expires_in || 5184000);
      }
    } catch {
      // Token may already be long-lived from Meta User Token Generator
    }
  }

  const me = await verifyThreadsCredentials({ accessToken: finalToken });
  const uid = String(me?.id || '').trim();
  if (!uid) {
    throw new Error('Could not resolve Threads profile from token.');
  }
  const username = String(me.username || uid).replace(/^@/, '');
  const issuedAt = Date.now();
  const expiresAt = resolvedExp > 0 ? issuedAt + resolvedExp * 1000 : 0;
  return upsertSocialAccount(
    {
      id: `threads:${uid}`,
      platform: 'threads',
      userId: uid,
      handle: username,
      acct: username,
      displayName: me.name || username,
      avatar: me.threads_profile_picture_url || '',
      noteText: me.threads_biography || '',
      isVerified: Boolean(me.is_verified),
      ...(expiresAt > 0 ? { expiresAt } : {}),
    },
    {
      accessToken: finalToken,
      issuedAt,
      ...(expiresAt > 0 ? { expiresAt } : {}),
    }
  );
}

export async function startThreadsOAuthFlow({
  clientId,
  clientSecret,
  redirectUri,
  scope = DEFAULT_THREADS_SCOPES,
  state = '',
} = {}) {
  const cid = String(clientId || '').trim();
  const csec = String(clientSecret || '').trim();
  const ruri = String(redirectUri || '').trim();
  if (!cid || !csec || !ruri) {
    throw new Error('Threads App ID, App Secret, and Redirect URI are required.');
  }
  return {
    clientId: cid,
    redirectUri: ruri,
    authorizeUrl: buildThreadsAuthorizeUrl({ clientId: cid, redirectUri: ruri, scope, state }),
  };
}

export async function completeThreadsOAuthFlow({
  code,
  redirectUri = '',
  clientId = '',
  clientSecret = '',
} = {}) {
  const shortTok = await exchangeThreadsOAuthCode({
    clientId,
    clientSecret,
    redirectUri,
    code,
  });
  const rawToken = String(shortTok?.access_token || '').trim();
  if (!rawToken) {
    throw new Error('Threads OAuth did not return an access_token.');
  }
  const longTok = await exchangeThreadsLongLivedToken({
    clientSecret,
    accessToken: rawToken,
  }).catch(() => null);
  const finalToken = String(longTok?.access_token || rawToken);
  const expiresIn = Number(longTok?.expires_in || 3600);
  return connectThreadsToken({ accessToken: finalToken, expiresIn });
}

export async function refreshConnectedThreadsToken() {
  const threadsAuth = await getAuthenticatedAccount('threads');
  if (!threadsAuth?.secrets?.accessToken) {
    throw new Error('Connect Threads bridge first.');
  }
  const refreshed = await refreshThreadsLongLivedToken({
    accessToken: threadsAuth.secrets.accessToken,
  });
  const newToken = String(refreshed?.access_token || threadsAuth.secrets.accessToken);
  const expiresIn = Number(refreshed?.expires_in || 5184000);
  const issuedAt = Date.now();
  const expiresAt = issuedAt + expiresIn * 1000;
  await updateAccountTokens(threadsAuth.meta.id, {
    accessToken: newToken,
    issuedAt,
    expiresAt,
  });
  await upsertSocialAccount({ ...threadsAuth.meta, expiresAt });
  return { expiresIn, expiresAt };
}

async function getClientAdapters() {
  const [mastoAuth, bskyAuth, threadsAuth] = await Promise.all([
    getAuthenticatedAccount('fediverse'),
    getAuthenticatedAccount('bluesky'),
    getAuthenticatedAccount('threads'),
  ]);

  if (threadsAuth?.secrets?.accessToken && threadsAuth.secrets.expiresAt && threadsAuth.secrets.issuedAt) {
    const now = Date.now();
    const ageMs = now - Number(threadsAuth.secrets.issuedAt);
    const expMs = Number(threadsAuth.secrets.expiresAt);
    if (ageMs >= 86_400_000 && (now >= expMs - 45 * 86_400_000 || ageMs >= 7 * 86_400_000)) {
      try {
        const refreshed = await refreshThreadsLongLivedToken({
          accessToken: threadsAuth.secrets.accessToken,
        });
        if (refreshed?.access_token) {
          const newExp = now + Number(refreshed.expires_in || 5184000) * 1000;
          threadsAuth.secrets = await updateAccountTokens(threadsAuth.meta.id, {
            accessToken: String(refreshed.access_token),
            issuedAt: now,
            expiresAt: newExp,
          });
          await upsertSocialAccount({ ...threadsAuth.meta, expiresAt: newExp });
        }
      } catch {
        // Keep current token on transient refresh errors
      }
    }
  }

  const masto = mastoAuth
    ? new MastodonAdapter({
        instanceUrl: mastoAuth.meta.instanceUrl,
        accessToken: mastoAuth.secrets.accessToken,
      })
    : null;
  const bsky = bskyAuth
    ? new BlueskyAdapter({
        serviceUrl: bskyAuth.meta.serviceUrl,
        did: bskyAuth.meta.did,
        handle: bskyAuth.meta.handle,
        accessJwt: bskyAuth.secrets.accessJwt,
        refreshJwt: bskyAuth.secrets.refreshJwt,
        onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
      })
    : null;
  const threads = threadsAuth
    ? new ThreadsAdapter({
        userId: threadsAuth.meta.userId,
        accessToken: threadsAuth.secrets.accessToken,
        username: threadsAuth.meta.handle || threadsAuth.meta.acct || '',
        displayName: threadsAuth.meta.displayName || '',
        avatarUrl: threadsAuth.meta.avatar || '',
      })
    : null;

  return { mastoAuth, bskyAuth, threadsAuth, masto, bsky, threads };
}

function cleanLinkedIdsSummary(row) {
  if (!row || typeof row !== 'object') return {};
  return {
    ...(row.mastodonStatusId ? { mastodonStatusId: row.mastodonStatusId } : {}),
    ...(row.blueskyUri ? { blueskyUri: row.blueskyUri, ...(row.blueskyCid ? { blueskyCid: row.blueskyCid } : {}) } : {}),
    ...(row.threadsPostId ? { threadsPostId: row.threadsPostId } : {}),
  };
}

class PartialBridgePublishError extends Error {
  constructor(message, { published = [], items = [], remainingSegments = [], lastParent = null } = {}) {
    super(message);
    this.published = published;
    this.items = items;
    this.remainingSegments = remainingSegments;
    this.lastParent = lastParent;
  }
}

async function publishBskySegments({
  bsky,
  textParts,
  media = [],
  resolvedCard = null,
  rootRef = null,
  parentRef = null,
}) {
  const rawMedia = Array.isArray(media) ? media : [];
  const chunks = (Array.isArray(textParts) ? textParts : []).flatMap((p) => splitTextClean(p, 300));
  if (chunks.length === 0 && rawMedia.length > 0) chunks.push('');
  const refs = [];
  const publishedItems = [];
  let curRoot = rootRef;
  let curParent = parentRef;
  for (let i = 0; i < chunks.length; i += 1) {
    const isRootStart = i === 0 && !curParent;
    let res;
    try {
      res = await bsky.publish(chunks[i], isRootStart ? rawMedia : [], {
        reply: curParent ? { root: curRoot || curParent, parent: curParent } : null,
        ...(isRootStart && rawMedia.length === 0 && resolvedCard ? { externalEmbed: resolvedCard } : {}),
      });
    } catch (err) {
      if (refs.length > 0) {
        throw new PartialBridgePublishError(err?.message || 'Bluesky segment publish failed', {
          published: refs,
          items: publishedItems,
          remainingSegments: chunks.slice(i),
          lastParent: curParent,
        });
      }
      throw err;
    }
    publishedItems.push(res);
    const ref = { uri: res._meta?.bluesky?.uri || '', cid: res._meta?.bluesky?.cid || '' };
    refs.push(ref);
    if (!curRoot) curRoot = ref;
    curParent = ref;
  }
  return { protocol: 'bluesky', refs, items: publishedItems };
}

async function publishThreadsSegments({
  threads,
  textParts,
  media = [],
  uploadedUrls = [],
  resolvedCard = null,
  visibility = 'public',
  parentTid = '',
}) {
  const rawMedia = Array.isArray(media) ? media : [];
  const chunks = (Array.isArray(textParts) ? textParts : []).flatMap((p) => splitTextClean(p, 500));
  if (chunks.length === 0 && (rawMedia.length > 0 || uploadedUrls.length > 0)) chunks.push('');
  const ids = [];
  const publishedItems = [];
  let curParentTid = String(parentTid || '');
  for (let i = 0; i < chunks.length; i += 1) {
    const isRootStart = i === 0 && !curParentTid;
    let res;
    try {
      res = await threads.publish(chunks[i], isRootStart ? rawMedia : [], {
        ...(isRootStart && uploadedUrls.length > 0 ? { mastodonMediaUrls: uploadedUrls } : {}),
        publicMediaBaseUrl: authStore.get().publicMediaBaseUrl || '',
        replyToId: curParentTid,
        replyControl: !curParentTid && visibility === 'private' ? 'accounts_you_follow' : '',
        ...(isRootStart && rawMedia.length === 0 && uploadedUrls.length === 0 && resolvedCard?.url
          ? { linkAttachment: resolvedCard.url }
          : {}),
      });
    } catch (err) {
      if (ids.length > 0) {
        throw new PartialBridgePublishError(err?.message || 'Threads segment publish failed', {
          published: ids,
          items: publishedItems,
          remainingSegments: chunks.slice(i),
          lastParent: curParentTid,
        });
      }
      throw err;
    }
    publishedItems.push(res);
    const pid = res._meta?.threads?.postId || '';
    ids.push(pid);
    curParentTid = pid;
  }
  return { protocol: 'threads', ids, items: publishedItems };
}

/**
 * Automatic outbound fan-out: Mastodon primary + concurrent non-blocking Promise.allSettled
 * fan-out to Bluesky and Threads with retry queuing and linkedIds local mapping.
 */
export async function publishUnified({
  text = '',
  mediaAttachments = [],
  threadItems = [],
  visibility = 'public',
  spoilerText = '',
  language = 'en',
  linkCard = null,
  dismissLinkCard = false,
} = {}) {
  const cleanText = String(text || '').trim();
  const extraParts = Array.isArray(threadItems)
    ? threadItems.map((it) => String(it?.text ?? it ?? '').trim()).filter(Boolean)
    : [];
  const rawParts = [cleanText, ...extraParts].filter((p, idx) => idx === 0 || Boolean(p));

  const { masto, bsky, threads } = await getClientAdapters();
  if (!masto) {
    throw new Error('Connect Mastodon under Profile -> Accounts & Bridges.');
  }

  const normalizedMedia = (mediaAttachments || []).map((att) => ({
    blob: att.blob || att.file || null,
    url: att.url || '',
    mimeType: att.mimeType || att.mime_type || att.file?.type || 'image/jpeg',
    altText: att.altText || att.alt_text || '',
  }));

  let resolvedCard = null;
  if (normalizedMedia.length === 0 && !dismissLinkCard) {
    if (linkCard?.url && String(linkCard.url).startsWith('https://')) {
      resolvedCard = { ...linkCard };
    } else {
      const firstUrl = extractFirstHttpsUrl(rawParts[0] || '');
      if (firstUrl) {
        resolvedCard = await fetchLinkPreview(firstUrl).catch(() => null);
      }
    }
  }

  const mastoResults = [];
  let parentMastoId = null;
  let uploadedUrls = [];

  for (let i = 0; i < rawParts.length; i += 1) {
    const published = await masto.publish(rawParts[i], i === 0 ? normalizedMedia : [], {
      visibility,
      spoilerText: i === 0 ? spoilerText : '',
      inReplyToId: parentMastoId,
      language,
    });
    if (i === 0 && Array.isArray(published._uploadedMediaUrls)) {
      uploadedUrls = published._uploadedMediaUrls;
    }
    delete published._uploadedMediaUrls;
    if (i === 0 && resolvedCard && !published._meta?.linkCard) {
      published._meta = { ...(published._meta || {}), linkCard: resolvedCard };
    }
    mastoResults.push(published);
    parentMastoId = published._meta.mastodon.statusId;
  }

  const rootCanonical = mastoResults[0].id;
  const rootMastoId = mastoResults[0]._meta.mastodon.statusId;
  const warnings = [];
  let bskyRefs = [];
  let bskyItems = [];
  let threadsIds = [];
  let threadsItems = [];

  const isDirectDm = String(visibility || 'public').toLowerCase() === 'direct';
  const bridgeJobs = [];
  const bridgeProtocols = [];
  if (!isDirectDm && bsky) {
    bridgeProtocols.push('bluesky');
    bridgeJobs.push(
      publishBskySegments({ bsky, textParts: rawParts, media: normalizedMedia, resolvedCard })
    );
  }
  if (!isDirectDm && threads) {
    bridgeProtocols.push('threads');
    bridgeJobs.push(
      publishThreadsSegments({
        threads,
        textParts: rawParts,
        media: normalizedMedia,
        uploadedUrls,
        resolvedCard,
        visibility,
      })
    );
  }

  const settled = await Promise.allSettled(bridgeJobs);
  for (let i = 0; i < settled.length; i += 1) {
    const s = settled[i];
    if (s.status === 'fulfilled') {
      if (s.value.protocol === 'bluesky') {
        bskyRefs = s.value.refs;
        bskyItems = s.value.items || [];
      }
      if (s.value.protocol === 'threads') {
        threadsIds = s.value.ids;
        threadsItems = s.value.items || [];
      }
    } else {
      const proto = bridgeProtocols[i] || 'threads';
      const partial = s.reason instanceof PartialBridgePublishError ? s.reason : null;
      if (partial) {
        if (proto === 'bluesky') {
          bskyRefs = partial.published;
          bskyItems = partial.items;
        } else {
          threadsIds = partial.published;
          threadsItems = partial.items;
        }
      }
      const errMsg = s.reason?.message || 'Bridge publish failed';
      warnings.push(`${proto}: ${errMsg}`);
      await enqueueLocalRetry({
        id: `retry_${proto}_${Date.now()}`,
        operation: 'publish',
        protocol: proto,
        payload: {
          canonicalId: rootCanonical,
          mastodonStatusId: rootMastoId,
          textParts: partial ? partial.remainingSegments : rawParts,
          ...(partial ? { segmentOffset: partial.published.length } : {}),
          ...(partial && proto === 'bluesky' ? { replyRoot: partial.published[0] || null, replyParent: partial.lastParent } : {}),
          ...(partial && proto === 'threads' ? { replyToThreadsId: String(partial.lastParent || '') } : {}),
          mastodonMediaUrls: partial ? [] : uploadedUrls,
        },
        lastError: errMsg,
      });
    }
  }

  const handleToDid = new Map();
  const utf8Dec = new TextDecoder();
  const utf8Enc = new TextEncoder();
  for (const bItem of bskyItems) {
    const bFacets = bItem?._meta?.bluesky?.facets;
    const bText = String(bItem?.content_text || '');
    if (!Array.isArray(bFacets) || !bText) continue;
    const textBytes = utf8Enc.encode(bText);
    for (const f of bFacets) {
      const mentionFeat = (f?.features || []).find((ft) => ft?.$type === 'app.bsky.richtext.facet#mention' && ft?.did);
      if (!mentionFeat) continue;
      const slice = utf8Dec.decode(textBytes.subarray(f.index.byteStart, f.index.byteEnd)).trim();
      if (slice.startsWith('@') && slice.length > 1) {
        handleToDid.set(slice.slice(1).toLowerCase(), String(mentionFeat.did));
      }
    }
  }

  for (let i = 0; i < mastoResults.length; i += 1) {
    const m = mastoResults[i];
    if (m.content_html && m.content_html.includes('@')) {
      m.content_html = enrichUnlinkedMentionsInHtml(m.content_html, handleToDid);
    }
    const bRef = bskyRefs[i] || {};
    const tId = threadsIds[i] || '';
    const linkedIds = {
      mastodonStatusId: m._meta.mastodon.statusId,
      ...(bRef.uri ? { blueskyUri: bRef.uri, blueskyCid: bRef.cid } : {}),
      ...(tId ? { threadsPostId: tId } : {}),
    };
    m._meta.linkedIds = linkedIds;
    await saveLocalLinkedPost({
      canonicalId: m.id,
      mastodonStatusId: linkedIds.mastodonStatusId,
      mastodonInstance: masto.instanceUrl,
      blueskyUri: linkedIds.blueskyUri || '',
      blueskyCid: linkedIds.blueskyCid || '',
      threadsPostId: linkedIds.threadsPostId || '',
      parentCanonicalId: i === 0 ? '' : rootCanonical,
    });
  }

  const extraMax = Math.max(bskyRefs.length, threadsIds.length);
  for (let extraIdx = mastoResults.length; extraIdx < extraMax; extraIdx += 1) {
    const bRef = bskyRefs[extraIdx] || {};
    const tId = threadsIds[extraIdx] || '';
    if (bRef.uri || tId) {
      await saveLocalLinkedPost({
        canonicalId: `${rootCanonical}:part:${extraIdx}`,
        mastodonStatusId: '',
        mastodonInstance: masto.instanceUrl,
        blueskyUri: bRef.uri || '',
        blueskyCid: bRef.cid || '',
        threadsPostId: tId,
        parentCanonicalId: rootCanonical,
      });
    }
  }

  const retries = await listLocalRetries();
  authStore.set({ retryQueue: retries });
  return {
    canonicalId: rootCanonical,
    items: mastoResults,
    results: [...mastoResults, ...bskyItems, ...threadsItems],
    linkedIds: mastoResults[0]._meta.linkedIds,
    warnings,
    retryQueue: retries,
  };
}

/**
 * Route a reply through the target UnifiedItem's originating protocol adapter.
 */
export async function replyUnified({ targetItem, text, mediaAttachments = [], visibility = 'public' }) {
  const item = toUnifiedItem(targetItem);
  const { masto, bsky, threads } = await getClientAdapters();
  if (item.protocol === 'bluesky') {
    if (!bsky) throw new Error('Connect Bluesky bridge to reply to Bluesky posts.');
    return bsky.reply(item, text, mediaAttachments);
  }
  if (item.protocol === 'threads') {
    if (!threads) throw new Error('Connect Threads bridge to reply to Threads posts.');
    return threads.reply(item, text, mediaAttachments);
  }
  if (!masto) throw new Error('Connect Mastodon to reply.');
  return masto.reply(item, text, mediaAttachments, { visibility });
}

/**
 * Synchronized delete across Mastodon and all linked Bluesky / Threads records via Promise.allSettled.
 */
export async function deleteUnified(itemOrId) {
  const item = typeof itemOrId === 'string' ? { id: itemOrId, protocol: 'mastodon', _meta: {} } : toUnifiedItem(itemOrId);

  const group = await findLocalLinkedPostGroup(item.id);
  const storedLink = group[0] || (await findLocalLinkedPost(item.id));
  const linked = item._meta?.linkedIds || {};

  const mastoTargets = [];
  const bskyTargets = [];
  const threadsTargets = [];
  if (group.length > 0) {
    for (const rec of group) {
      if (rec.mastodonStatusId) mastoTargets.push(rec.mastodonStatusId);
      if (rec.blueskyUri) bskyTargets.push(rec.blueskyUri);
      if (rec.threadsPostId) threadsTargets.push(rec.threadsPostId);
    }
  } else {
    const mId = linked.mastodonStatusId || item._meta?.mastodon?.statusId || (item.protocol === 'mastodon' ? item.id.replace(/^mastodon:/, '') : '');
    const bUri = linked.blueskyUri || storedLink?.blueskyUri || item._meta?.bluesky?.uri || '';
    const tId = linked.threadsPostId || storedLink?.threadsPostId || item._meta?.threads?.postId || '';
    if (mId) mastoTargets.push(mId);
    if (bUri) bskyTargets.push(bUri);
    if (tId) threadsTargets.push(tId);
  }
  if (linked.blueskyUri && !bskyTargets.includes(linked.blueskyUri)) bskyTargets.push(linked.blueskyUri);
  if (linked.threadsPostId && !threadsTargets.includes(linked.threadsPostId)) threadsTargets.push(linked.threadsPostId);

  const uniqueMasto = [...new Set(mastoTargets.filter(Boolean))];
  const uniqueBsky = [...new Set(bskyTargets.filter(Boolean))];
  const uniqueThreads = [...new Set(threadsTargets.filter(Boolean))];

  const { masto, bsky, threads } = await getClientAdapters();
  const tasks = [];
  const taskMeta = [];
  for (const sid of uniqueMasto) {
    if (masto) {
      taskMeta.push({ protocol: 'mastodon', nativeId: sid });
      tasks.push(masto.delete({ statusId: sid }));
    }
  }
  for (const uri of uniqueBsky) {
    if (bsky) {
      taskMeta.push({ protocol: 'bluesky', nativeId: uri });
      tasks.push(bsky.delete({ uri }));
    }
  }
  for (const tid of uniqueThreads) {
    if (threads) {
      taskMeta.push({ protocol: 'threads', nativeId: tid });
      tasks.push(threads.delete({ postId: tid }));
    }
  }

  const settled = await Promise.allSettled(tasks);
  const warnings = [];
  const failedBsky = new Set();
  const failedThreads = new Set();
  let succeededCount = 0;
  let firstStandaloneErr = null;

  for (let i = 0; i < settled.length; i += 1) {
    const res = settled[i];
    const meta = taskMeta[i];
    if (res.status === 'fulfilled') {
      succeededCount += 1;
      continue;
    }
    const errMsg = res.reason?.message || 'Delete failed';
    if (meta.protocol === 'mastodon') {
      throw res.reason instanceof Error ? res.reason : new Error(errMsg);
    }
    if (!firstStandaloneErr) firstStandaloneErr = res.reason instanceof Error ? res.reason : new Error(errMsg);
    if (meta.protocol === 'bluesky') failedBsky.add(meta.nativeId);
    if (meta.protocol === 'threads') failedThreads.add(meta.nativeId);
    const label = meta.protocol === 'threads' ? 'Threads' : 'Bluesky';
    warnings.push(`${label}: ${errMsg}`);
    await enqueueLocalRetry({
      id: `retry_del_${meta.protocol}_${Date.now()}_${i}`,
      operation: 'delete',
      protocol: meta.protocol,
      payload: { nativeId: meta.nativeId },
      lastError: errMsg,
    });
  }

  if (uniqueMasto.length === 0 && succeededCount === 0 && firstStandaloneErr) {
    throw firstStandaloneErr;
  }

  if (failedBsky.size === 0 && failedThreads.size === 0) {
    await deleteLocalLinkedPost(item.id);
  } else if (group.length > 0) {
    const rootRec = group[0];
    const rootCanon = rootRec.canonicalId || rootRec.canonical_id;
    for (const child of group.slice(1)) {
      const childCanon = child.canonicalId || child.canonical_id;
      const remB = child.blueskyUri && failedBsky.has(child.blueskyUri) ? child.blueskyUri : '';
      const remT = child.threadsPostId && failedThreads.has(child.threadsPostId) ? child.threadsPostId : '';
      if (!remB && !remT && childCanon) {
        await deleteLocalLinkedPost(childCanon);
      } else if (childCanon) {
        await saveLocalLinkedPost({
          canonicalId: childCanon,
          mastodonStatusId: '',
          mastodonInstance: child.mastodonInstance || '',
          blueskyUri: remB,
          blueskyCid: remB ? (child.blueskyCid || '') : '',
          threadsPostId: remT,
          parentCanonicalId: child.parentCanonicalId || rootCanon,
        });
      }
    }
    if (rootCanon) {
      const remRb = rootRec.blueskyUri && failedBsky.has(rootRec.blueskyUri)
        ? rootRec.blueskyUri
        : (group.length === 1 && failedBsky.size > 0 ? [...failedBsky][0] : '');
      const remRt = rootRec.threadsPostId && failedThreads.has(rootRec.threadsPostId)
        ? rootRec.threadsPostId
        : (group.length === 1 && failedThreads.size > 0 ? [...failedThreads][0] : '');
      await saveLocalLinkedPost({
        canonicalId: rootCanon,
        mastodonStatusId: '',
        mastodonInstance: rootRec.mastodonInstance || '',
        blueskyUri: remRb,
        blueskyCid: remRb ? (rootRec.blueskyCid || '') : '',
        threadsPostId: remRt,
        parentCanonicalId: '',
      });
    }
  }

  const retries = await listLocalRetries();
  authStore.set({ retryQueue: retries });
  return { deleted: true, warnings, retryQueue: retries };
}

async function collectBskyMediaFromAttachments(attachments = []) {
  const bskyMedia = [];
  for (const att of (Array.isArray(attachments) ? attachments : []).slice(0, 4)) {
    const mime = String(att?.mime_type || att?.mimeType || '');
    const srcUrl = att?.url || att?.fullsize || att?.thumb || '';
    if (srcUrl && (!mime || mime.startsWith('image/')) && isAllowedSocialUrl(srcUrl)) {
      try {
        const res = await fetch(srcUrl);
        const ctype = String(res.headers?.get?.('content-type') || mime || 'image/jpeg').toLowerCase();
        if (res.ok && ctype.startsWith('image/')) {
          const blob = await res.blob();
          if (blob && blob.size > 0) {
            bskyMedia.push({ blob, mimeType: blob.type || mime || 'image/jpeg', altText: att.alt_text || att.altText || '' });
          }
        }
      } catch {
        // Skip unreachable image bytes and still republish edited text
      }
    }
  }
  return bskyMedia;
}

export async function editUnified(
  itemOrId,
  draft,
  spoilerText = '',
  { replaceBridges = true, replaceBluesky = undefined, replaceThreads = undefined } = {}
) {
  const item = typeof itemOrId === 'object' && itemOrId !== null ? toUnifiedItem(itemOrId) : null;
  const rawId = typeof itemOrId === 'string' ? itemOrId : (item?.id || '');
  const isBskyStandalone =
    item?.protocol === 'bluesky'
    || rawId.startsWith('bluesky:')
    || rawId.startsWith('at://');

  const { masto, bsky, threads } = await getClientAdapters();

  if (isBskyStandalone) {
    if (!bsky) throw new Error('Connect Bluesky to edit Bluesky posts.');
    const bskyUri = String(item?._meta?.bluesky?.uri || item?.uri || rawId.replace(/^bluesky:/, '')).trim();
    if (!bskyUri) throw new Error('Missing Bluesky post URI.');

    const attachments = Array.isArray(item?.attachments) ? item.attachments : [];
    const bskyMedia = await collectBskyMediaFromAttachments(attachments);
    let resolvedCard = null;
    if (bskyMedia.length === 0) {
      const existingCard = item?._meta?.linkCard;
      if (existingCard?.url && String(existingCard.url).startsWith('https://')) {
        resolvedCard = { ...existingCard };
      } else {
        const firstUrl = extractFirstHttpsUrl(draft);
        if (firstUrl) {
          resolvedCard = await fetchLinkPreview(firstUrl).catch(() => null);
        }
      }
    }

    await bsky.delete({ uri: bskyUri });
    const bRes = await publishBskySegments({
      bsky,
      textParts: [draft],
      media: bskyMedia,
      resolvedCard: bskyMedia.length === 0 ? resolvedCard : null,
    });
    const firstRef = bRes.refs?.[0] || {};
    const firstItem = bRes.items?.[0]
      ? toUnifiedItem(bRes.items[0])
      : toUnifiedItem({
          id: firstRef.uri ? `bluesky:${firstRef.uri}` : `bluesky:${bskyUri}`,
          protocol: 'bluesky',
          content_text: draft,
          author: item?.author || {},
          attachments,
          created_at: new Date().toISOString(),
          _meta: {
            bluesky: { uri: firstRef.uri || bskyUri, cid: firstRef.cid || '' },
            linkedIds: { blueskyUri: firstRef.uri || bskyUri, blueskyCid: firstRef.cid || '' },
          },
        });
    firstItem._replacedId = rawId || `bluesky:${bskyUri}`;
    return firstItem;
  }

  const cleanId = String(item?._meta?.mastodon?.statusId || rawId || '').replace(/^mastodon:/, '');
  const doBsky = replaceBluesky !== undefined ? Boolean(replaceBluesky) : Boolean(replaceBridges);
  const doThreads = replaceThreads !== undefined ? Boolean(replaceThreads) : Boolean(replaceBridges);

  if (!masto) throw new Error('Connect Mastodon to edit posts.');
  const updated = await masto.edit(cleanId, draft, spoilerText);

  const canonId = updated.id || `mastodon:${cleanId}`;
  const group = await findLocalLinkedPostGroup(canonId);
  const rootLink = group[0] || (await findLocalLinkedPost(`mastodon:${cleanId}`)) || null;
  const itemLinked = item?._meta?.linkedIds || {};
  const warnings = [];
  const visibility = String(updated._meta?.mastodon?.visibility || 'public').toLowerCase();

  let bskyUri = rootLink?.blueskyUri || itemLinked.blueskyUri || '';
  let bskyCid = rootLink?.blueskyCid || itemLinked.blueskyCid || '';
  let threadsPostId = rootLink?.threadsPostId || itemLinked.threadsPostId || '';

  const oldBskyUris = [...new Set([bskyUri, ...group.map((g) => g.blueskyUri)].filter(Boolean))];
  const oldBskyCid = bskyCid;
  const oldThreadsIds = [...new Set([threadsPostId, ...group.map((g) => g.threadsPostId)].filter(Boolean))];

  const shouldReplaceBsky = doBsky && Boolean(bsky) && visibility !== 'direct' && oldBskyUris.length > 0;
  const shouldReplaceThreads = doThreads && Boolean(threads) && visibility !== 'direct' && oldThreadsIds.length > 0;

  if (shouldReplaceBsky || shouldReplaceThreads) {
    const attachments = Array.isArray(updated.attachments) ? updated.attachments : [];
    const mastoMediaUrls = attachments.map((att) => att?.url).filter((u) => u && isAllowedSocialUrl(u));
    const threadsMedia = attachments
      .filter((att) => att?.url && isAllowedSocialUrl(att.url))
      .map((att) => ({
        url: att.url,
        mimeType: att.mime_type || att.mimeType || 'image/jpeg',
        altText: att.alt_text || att.altText || '',
      }));

    let resolvedCard = null;
    if (attachments.length === 0) {
      const existingCard = updated._meta?.linkCard;
      if (existingCard?.url && String(existingCard.url).startsWith('https://')) {
        resolvedCard = { ...existingCard };
      } else {
        const firstUrl = extractFirstHttpsUrl(draft);
        if (firstUrl) {
          resolvedCard = await fetchLinkPreview(firstUrl).catch(() => null);
        }
      }
    }

    let finalBskyRefs = oldBskyUris.map((uri, i) => ({ uri, cid: i === 0 ? oldBskyCid : '' }));
    let finalThreadsIds = [...oldThreadsIds];
    let enqueuedRetry = false;

    const replaceBskyTask = async () => {
      if (!shouldReplaceBsky) return;
      const undeletedBsky = [];
      for (const uri of oldBskyUris) {
        try {
          await bsky.delete({ uri });
        } catch (err) {
          undeletedBsky.push(uri);
          const msg = `Bluesky: ${err?.message || 'Delete failed'}`;
          if (!warnings.includes(msg)) warnings.push(msg);
          await enqueueLocalRetry({
            id: `retry_delete_bluesky_${Date.now()}`,
            operation: 'delete',
            protocol: 'bluesky',
            payload: { uri },
            lastError: err?.message || 'Delete failed',
          }).catch(() => {});
          enqueuedRetry = true;
        }
      }
      if (undeletedBsky.length > 0) {
        finalBskyRefs = [{ uri: undeletedBsky[0], cid: undeletedBsky[0] === oldBskyUris[0] ? oldBskyCid : '' }];
        return;
      }
      finalBskyRefs = [];
      const bskyMedia = await collectBskyMediaFromAttachments(attachments);
      try {
        const bRes = await publishBskySegments({
          bsky,
          textParts: [draft],
          media: bskyMedia,
          resolvedCard: attachments.length === 0 ? resolvedCard : null,
        });
        finalBskyRefs = bRes.refs || [];
      } catch (err) {
        if (err instanceof PartialBridgePublishError) {
          finalBskyRefs = err.published;
        }
        warnings.push(`Bluesky: ${err?.message || 'Republish failed'}`);
      }
    };

    const replaceThreadsTask = async () => {
      if (!shouldReplaceThreads) return;
      const undeletedThreads = [];
      for (const tid of oldThreadsIds) {
        try {
          await threads.delete({ postId: tid });
        } catch (err) {
          undeletedThreads.push(tid);
          const msg = `Threads: ${err?.message || 'Delete failed'}`;
          if (!warnings.includes(msg)) warnings.push(msg);
          await enqueueLocalRetry({
            id: `retry_delete_threads_${Date.now()}`,
            operation: 'delete',
            protocol: 'threads',
            payload: { postId: tid },
            lastError: err?.message || 'Delete failed',
          }).catch(() => {});
          enqueuedRetry = true;
        }
      }
      if (undeletedThreads.length > 0) {
        finalThreadsIds = [undeletedThreads[0]];
        return;
      }
      finalThreadsIds = [];
      try {
        const tRes = await publishThreadsSegments({
          threads,
          textParts: [draft],
          media: threadsMedia,
          uploadedUrls: mastoMediaUrls,
          resolvedCard: attachments.length === 0 ? resolvedCard : null,
          visibility,
        });
        finalThreadsIds = tRes.ids || [];
      } catch (err) {
        if (err instanceof PartialBridgePublishError) {
          finalThreadsIds = err.published;
        }
        warnings.push(`Threads: ${err?.message || 'Republish failed'}`);
      }
    };

    await Promise.all([replaceBskyTask(), replaceThreadsTask()]);

    if (enqueuedRetry) {
      const retries = await listLocalRetries().catch(() => []);
      authStore.set({ retryQueue: retries });
    }

    bskyUri = finalBskyRefs[0]?.uri || '';
    bskyCid = finalBskyRefs[0]?.cid || '';
    threadsPostId = finalThreadsIds[0] || '';

    await deleteLocalLinkedChildren(canonId);
    if (rootLink || bskyUri || threadsPostId || oldBskyUris.length > 0 || oldThreadsIds.length > 0) {
      await saveLocalLinkedPost({
        canonicalId: canonId,
        mastodonStatusId: cleanId,
        mastodonInstance: rootLink?.mastodonInstance || masto.instanceUrl,
        blueskyUri: bskyUri,
        blueskyCid: bskyCid,
        threadsPostId,
        parentCanonicalId: '',
      });
      const extraMax = Math.max(finalBskyRefs.length, finalThreadsIds.length);
      for (let extraIdx = 1; extraIdx < extraMax; extraIdx += 1) {
        const bRef = finalBskyRefs[extraIdx] || {};
        const tId = finalThreadsIds[extraIdx] || '';
        if (bRef.uri || tId) {
          await saveLocalLinkedPost({
            canonicalId: `${canonId}:part:${extraIdx}`,
            mastodonStatusId: '',
            mastodonInstance: rootLink?.mastodonInstance || masto.instanceUrl,
            blueskyUri: bRef.uri || '',
            blueskyCid: bRef.cid || '',
            threadsPostId: tId,
            parentCanonicalId: canonId,
          });
        }
      }
    }
  }

  const nextLinkedIds = cleanLinkedIdsSummary({
    mastodonStatusId: cleanId,
    blueskyUri: bskyUri,
    blueskyCid: bskyCid,
    threadsPostId,
  });
  updated._meta = {
    ...(updated._meta || {}),
    linkedIds: nextLinkedIds,
    ...(warnings.length > 0 ? { bridgeWarnings: warnings } : {}),
  };
  if (warnings.length > 0) {
    updated._bridgeWarnings = warnings;
  }
  return updated;
}

export async function pinUnified(itemOrId, unpin = false) {
  const item = typeof itemOrId === 'string' ? { id: itemOrId, _meta: { mastodon: { statusId: itemOrId } } } : toUnifiedItem(itemOrId);
  const sid = item._meta?.mastodon?.statusId || item.id.replace(/^mastodon:/, '');

  const { masto } = await getClientAdapters();
  if (!masto) throw new Error('Connect Mastodon to pin posts.');
  return masto.pin(sid, unpin);
}

export async function likeUnified(targetItem, unlike = undefined) {
  const item = toUnifiedItem(targetItem);
  if (item.protocol === 'threads') {
    throw new Error('Likes are not supported by the Threads API.');
  }
  const currentlyLiked = Boolean(item._meta?.mastodon?.favourited || item._meta?.bluesky?.likeUri);
  const undo = unlike !== undefined ? Boolean(unlike) : currentlyLiked;

  const { masto, bsky } = await getClientAdapters();
  let updated = null;
  if (item.protocol === 'bluesky') {
    if (!bsky) throw new Error('Connect Bluesky bridge to like Bluesky posts.');
    updated = await bsky.like(item, undo);
  } else {
    if (!masto) throw new Error('Connect Mastodon to favourite posts.');
    updated = await masto.like(item, undo);
  }
  if (updated) {
    mutatePostAcrossStreams(updated.id || item.id, () => updated);
    recordViewerInteraction(updated);
  }
  return updated;
}

export async function repostUnified(targetItem, unrepost = undefined) {
  const item = toUnifiedItem(targetItem);
  if (item.protocol === 'threads') {
    throw new Error('Boosts are not supported by the Threads API.');
  }
  const currentlyReposted = Boolean(item._meta?.mastodon?.reblogged || item._meta?.bluesky?.repostUri);
  const undo = unrepost !== undefined ? Boolean(unrepost) : currentlyReposted;

  const { masto, bsky } = await getClientAdapters();
  let updated = null;
  if (item.protocol === 'bluesky') {
    if (!bsky) throw new Error('Connect Bluesky bridge to repost Bluesky posts.');
    updated = await bsky.repost(item, undo);
  } else {
    if (!masto) throw new Error('Connect Mastodon to boost posts.');
    updated = await masto.repost(item, undo);
  }
  if (updated) {
    mutatePostAcrossStreams(updated.id || item.id, () => updated);
    recordViewerInteraction(updated);
  }
  return updated;
}

const ACTIVITY_DISMISSED_KV_KEY = 'activity_dismissed_v1';
const HIDDEN_REPLIES_KV_KEY = 'hidden_replies_v1';

async function getHiddenReplyIds() {
  const raw = await kvGet(HIDDEN_REPLIES_KV_KEY, []).catch(() => []);
  return new Set((Array.isArray(raw) ? raw : []).map((x) => String(x || '').trim()).filter(Boolean));
}

async function addHiddenReplyIds(ids = []) {
  const cur = await getHiddenReplyIds();
  const next = [...new Set([...cur, ...(Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean)])].slice(-1000);
  await kvSet(HIDDEN_REPLIES_KV_KEY, next).catch(() => {});
  return new Set(next);
}

async function getClientModeratedActorSet() {
  const keys = new Set((feedStore.get()?.moderatedActors || []).map((x) => String(x || '').toLowerCase()).filter(Boolean));
  const localMod = await getLocalModeratedAccounts().catch(() => ({ blocks: [], mutes: [] }));
  for (const bucket of [localMod.blocks || [], localMod.mutes || []]) {
    for (const row of bucket) {
      const proto = row?.protocol === 'fediverse' ? 'mastodon' : String(row?.protocol || 'threads').toLowerCase();
      for (const raw of [row?.canonicalActor, row?.acct, row?.username]) {
        const val = String(raw || '').trim().replace(/^@/, '').toLowerCase();
        if (!val) continue;
        keys.add(val);
        const canon = canonicalizeActorHandle(val, proto);
        if (canon && canon !== `${proto}:`) keys.add(canon);
      }
      const rid = String(row?.id || row?.did || '').trim().toLowerCase();
      if (rid) {
        keys.add(rid);
        keys.add(rid.includes(':') && !rid.startsWith('did:') ? rid : `${proto}:${rid}`);
      }
    }
  }
  return keys;
}

function isItemHiddenOrModeratedClient(item, hiddenSet, modSet) {
  if (!item || typeof item !== 'object') return false;
  const meta = item._meta || {};
  const nm = meta.notification || {};
  if (hiddenSet?.size > 0) {
    const mSid = String(meta.mastodon?.statusId || '');
    const bUri = String(meta.bluesky?.uri || '');
    const tPid = String(meta.threads?.postId || '');
    const candidates = [
      String(item.id || ''),
      String(nm.notifId || ''),
      mSid ? `mastodon:${mSid}` : '',
      bUri ? `bluesky:${bUri}` : '',
      tPid ? `threads:${tPid}` : '',
      tPid ? `threads:notif:${tPid}` : '',
    ];
    if (candidates.some((c) => c && hiddenSet.has(c))) return true;
  }
  return isUnifiedItemModerated(item, modSet);
}

export async function hideReplyUnified(replyItem, { rootItem = null } = {}) {
  const item = typeof replyItem === 'string'
    ? { id: replyItem, protocol: replyItem.startsWith('threads:') ? 'threads' : (replyItem.startsWith('bluesky:') || replyItem.startsWith('at://') ? 'bluesky' : 'mastodon'), _meta: {} }
    : toUnifiedItem(replyItem);
  const meta = item._meta || {};
  const tPid = String(meta.threads?.postId || (item.protocol === 'threads' ? String(item.id || '').replace(/^threads:(?:notif:)?/, '') : '')).trim();
  const bUri = String(meta.bluesky?.uri || (item.protocol === 'bluesky' ? String(item.id || '').replace(/^bluesky:/, '') : '')).trim();
  const mSid = String(meta.mastodon?.statusId || (item.protocol === 'mastodon' ? String(item.id || '').replace(/^mastodon:/, '') : '')).trim();

  const aliases = [...new Set([
    String(item.id || '').trim(),
    tPid ? `threads:${tPid}` : '',
    tPid ? `threads:notif:${tPid}` : '',
    bUri ? `bluesky:${bUri}` : '',
    mSid ? `mastodon:${mSid}` : '',
  ].filter(Boolean))];

  await addHiddenReplyIds(aliases);
  const dismissIds = [...aliases, ...(tPid ? [`threads:${tPid}`] : [])];
  if (meta.notification?.notifId) dismissIds.push(String(meta.notification.notifId));
  await dismissUnifiedNotifications({ ids: [...new Set(dismissIds)] }).catch(() => {});

  const warnings = [];
  if (item.protocol === 'threads' && tPid) {
    const { threads } = await getClientAdapters();
    if (threads) {
      const ownHandle = String(threads.username || '').trim().replace(/^@/, '').toLowerCase();
      const authorHandle = String(item.author?.handle || '').trim().replace(/^@/, '').toLowerCase();
      const isOwnReply = Boolean(
        (ownHandle && authorHandle && authorHandle === ownHandle)
        || (threads.userId && String(item.author?.id || '') === String(threads.userId))
      );
      try {
        if (isOwnReply) {
          await threads.delete({ postId: tPid });
        } else {
          await threads.manageReply(tPid, { hide: true });
        }
      } catch (err) {
        warnings.push(err?.message || 'Unable to hide comment on Threads');
      }
    }
  } else if (item.protocol === 'bluesky' && bUri) {
    const bskyAuth = await getAuthenticatedAccount('bluesky').catch(() => null);
    if (bskyAuth) {
      const bskyOpts = getBskyGraphAuth(bskyAuth);
      const rootMeta = rootItem?._meta || {};
      const rootUri = String(
        rootMeta.bluesky?.uri
        || rootMeta.linkedIds?.blueskyUri
        || meta.bluesky?.reply?.root?.uri
        || ''
      ).replace(/^bluesky:/, '').trim();
      try {
        if (bUri.startsWith(`at://${bskyOpts.repo}/`)) {
          const { bsky } = await getClientAdapters();
          if (bsky) await bsky.delete({ uri: bUri });
        } else if (rootUri && rootUri.startsWith(`at://${bskyOpts.repo}/`)) {
          await hideBskyReply({ ...bskyOpts, rootUri, replyUri: bUri });
        }
      } catch (err) {
        warnings.push(err?.message || 'Unable to hide comment on Bluesky');
      }
    }
  }

  return { hidden: true, ids: aliases, warnings };
}

async function getActivityDismissedState() {
  const raw = await kvGet(ACTIVITY_DISMISSED_KV_KEY, null).catch(() => null);
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    ids: Array.isArray(data.ids) ? data.ids.map((x) => String(x || '')).filter(Boolean).slice(-600) : [],
    clearedBeforeMs: Number(data.clearedBeforeMs || 0) || 0,
    threadsWatermarks:
      data.threadsWatermarks && typeof data.threadsWatermarks === 'object'
        ? { ...data.threadsWatermarks }
        : {},
    threadsStamps:
      data.threadsStamps && typeof data.threadsStamps === 'object'
        ? { ...data.threadsStamps }
        : {},
  };
}

function mergeThreadsWatermarksLocal(existing, incoming) {
  const next = { ...(existing || {}) };
  for (const [tid, counts] of Object.entries(incoming || {})) {
    const cleanTid = String(tid || '').trim();
    if (!cleanTid || !counts || typeof counts !== 'object') continue;
    const prev = next[cleanTid] && typeof next[cleanTid] === 'object' ? { ...next[cleanTid] } : {};
    if (counts.likes !== undefined) prev.likes = Math.max(Number(prev.likes || 0), Number(counts.likes || 0));
    if (counts.reposts !== undefined) prev.reposts = Math.max(Number(prev.reposts || 0), Number(counts.reposts || 0));
    next[cleanTid] = prev;
  }
  return next;
}

function isNotificationLocallyDismissed(item, dismissedIdSet, clearedBeforeMs) {
  const id = String(item?.id || '');
  const notifId = String(item?._meta?.notification?.notifId || '');
  if ((id && dismissedIdSet.has(id)) || (notifId && dismissedIdSet.has(notifId))) return true;
  if (clearedBeforeMs > 0) {
    const ts = Date.parse(item?.date_published || '');
    if (Number.isFinite(ts) && ts > 0 && ts <= clearedBeforeMs) return true;
  }
  return false;
}

function findCachedFeedItemForLink(linkedRow) {
  const streams = feedStore.get()?.streams || {};
  const targetCanon = String(linkedRow?.canonicalId || '');
  const targetMasto = String(linkedRow?.mastodonStatusId || '');
  const targetBsky = String(linkedRow?.blueskyUri || '');
  const targetThr = String(linkedRow?.threadsPostId || '');
  for (const bucket of Object.values(streams)) {
    for (const post of bucket?.items || []) {
      const mId = String(post?._meta?.mastodon?.statusId || '');
      const bUri = String(post?._meta?.bluesky?.uri || '');
      const tId = String(post?._meta?.threads?.postId || '');
      if (
        (targetCanon && post?.id === targetCanon)
        || (targetMasto && mId === targetMasto)
        || (targetBsky && bUri === targetBsky)
        || (targetThr && tId === targetThr)
      ) {
        return post;
      }
    }
  }
  return null;
}

function cleanLinkedIdsObject(row) {
  if (!row || typeof row !== 'object') return {};
  return {
    ...(row.mastodonStatusId ? { mastodonStatusId: String(row.mastodonStatusId) } : {}),
    ...(row.blueskyUri ? { blueskyUri: String(row.blueskyUri) } : {}),
    ...(row.blueskyCid ? { blueskyCid: String(row.blueskyCid) } : {}),
    ...(row.threadsPostId ? { threadsPostId: String(row.threadsPostId) } : {}),
  };
}

export async function fetchUnifiedNotifications({ limit = 60, forceRefresh = false } = {}) {
  const { masto, bsky, threads, threadsAuth } = await getClientAdapters();
  const linkedRows = await listLocalLinkedPosts(80).catch(() => []);
  const byCanonical = new Map();
  const byMasto = new Map();
  const byBsky = new Map();
  const byThreads = new Map();
  for (const row of linkedRows) {
    if (row?.canonicalId) byCanonical.set(String(row.canonicalId), row);
    if (row?.mastodonStatusId) byMasto.set(String(row.mastodonStatusId), row);
    if (row?.blueskyUri) byBsky.set(String(row.blueskyUri), row);
    if (row?.threadsPostId) byThreads.set(String(row.threadsPostId), row);
  }
  const trackedPostIds = linkedRows.map((r) => r?.threadsPostId).filter(Boolean);

  const notifFetchOpts = forceRefresh ? { cache: 'no-store' } : {};
  const tasks = [];
  if (masto) tasks.push(masto.fetchNotifications('', Math.min(limit, 80), notifFetchOpts));
  if (bsky) tasks.push(bsky.fetchNotifications('', Math.min(limit, 100), notifFetchOpts));
  if (threads) tasks.push(threads.fetchNotifications('', Math.min(limit, 30), { trackedPostIds }));

  const settled = await Promise.allSettled(tasks);
  const collected = [];
  const warnings = [];
  for (const res of settled) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      collected.push(...res.value);
    } else if (res.status === 'rejected') {
      warnings.push(res.reason?.message || 'Bridge notification fetch failed');
    }
  }

  const dismissedState = await getActivityDismissedState();
  const dismissedSet = new Set(dismissedState.ids);
  const threadsWatermarks = dismissedState.threadsWatermarks;
  const threadsStamps = { ...dismissedState.threadsStamps };

  // Fetch Threads insights for tracked cross-posts when Threads token exists
  const threadsInsights = {};
  const threadsToken = threadsAuth?.secrets?.accessToken || '';
  if (threadsToken && trackedPostIds.length > 0) {
    const tids = [...new Set(trackedPostIds)].slice(0, 25);
    const batchRes = await getThreadsPostsInsightsBatch({ postIds: tids, accessToken: threadsToken, forceRefresh }).catch(() => ({}));
    if (batchRes && typeof batchRes === 'object') {
      Object.assign(threadsInsights, batchRes);
    }
  }

  for (const it of collected) {
    if (!it || typeof it !== 'object') continue;
    const meta = (it._meta = it._meta || {});
    const nm = (meta.notification = meta.notification || {});
    const kind = String(nm.type || 'mention');
    const mId = String(meta.mastodon?.statusId || '');
    const mReplyId = String(meta.mastodon?.inReplyToId || '');
    const bSubj = String(nm.targetPostUri || meta.bluesky?.subjectUri || '');
    const bUri = String(meta.bluesky?.uri || '');
    const tParent = String(meta.threads?.parentPostId || meta.threads?.repliedToId || meta.threads?.rootPostId || '');
    const tId = String(meta.threads?.postId || '');
    const matched =
      byMasto.get(mId)
      || byMasto.get(mReplyId)
      || byBsky.get(bSubj)
      || byBsky.get(bUri)
      || byThreads.get(tParent)
      || byThreads.get(tId)
      || null;
    if (!matched) continue;
    const cleanLinked = cleanLinkedIdsObject(matched);
    nm.canonicalPostKey = matched.canonicalId;
    if (Object.keys(cleanLinked).length > 0) nm.linkedIds = cleanLinked;
    const isDirect =
      kind === 'like'
      || kind === 'repost'
      || (mId && mId === String(matched.mastodonStatusId || ''))
      || (bUri && bUri === String(matched.blueskyUri || ''))
      || (tId && tId === String(matched.threadsPostId || ''));
    if (isDirect && Object.keys(cleanLinked).length > 0) {
      meta.linkedIds = cleanLinked;
    }
  }

  let stampsDirty = false;
  const nowIso = new Date().toISOString();
  for (const [tid, ins] of Object.entries(threadsInsights)) {
    const matched = byThreads.get(tid);
    if (!matched) continue;
    const wm = threadsWatermarks[tid] || {};
    const cleanLinked = cleanLinkedIdsObject(matched);
    const cachedParent = findCachedFeedItemForLink(matched);
    const snippetText = String(cachedParent?.content_text || '');
    const snippetHtml = String(cachedParent?.content_html || (snippetText ? plainTextToHtml(snippetText) : ''));
    const parentAtts = Array.isArray(cachedParent?.attachments) ? cachedParent.attachments : [];
    const parentUrl = String(cachedParent?.url || `https://www.threads.net/post/${tid}`);

    for (const [synKind, insKey] of [['like', 'likes'], ['repost', 'reposts']]) {
      const rawTotal = Number(ins[insKey] || 0);
      const activeCount = Math.max(0, rawTotal - Number(wm[insKey] || 0));
      if (activeCount <= 0) continue;
      const stampKey = `${tid}:${insKey}`;
      const prevStamp = threadsStamps[stampKey];
      let synIso;
      if (prevStamp && Number(prevStamp.count || 0) === rawTotal && prevStamp.iso) {
        synIso = String(prevStamp.iso);
      } else {
        synIso = nowIso;
        threadsStamps[stampKey] = { count: rawTotal, iso: synIso };
        stampsDirty = true;
      }
      const whoLabel = activeCount === 1 ? '1 person on Threads' : `${activeCount} people on Threads`;
      const synActor = {
        id: `threads:insights:${tid}`,
        name: whoLabel,
        handle: 'threads.net',
        avatar_url: '',
        protocol: 'threads',
      };
      collected.push({
        id: `threads:notif:${insKey}:${tid}`,
        protocol: 'threads',
        url: parentUrl,
        content_html: snippetHtml,
        content_text: snippetText,
        date_published: synIso,
        author: synActor,
        attachments: parentAtts,
        metrics: {
          likes: Number(ins.likes || 0),
          replies: Number(ins.replies || 0),
          reposts: Number(ins.reposts || 0),
        },
        _meta: {
          threads: { postId: tid },
          linkedIds: cleanLinked,
          notification: {
            notifId: `threads:${insKey}:${tid}`,
            type: synKind,
            actor: synActor,
            aggregateCount: activeCount,
            rawInsightsTotal: rawTotal,
            canonicalPostKey: matched.canonicalId,
            threadsPostId: tid,
            linkedIds: cleanLinked,
          },
        },
      });
    }
  }

  if (stampsDirty) {
    await kvSet(ACTIVITY_DISMISSED_KV_KEY, {
      ...dismissedState,
      threadsStamps,
    }).catch(() => {});
  }

  const [hiddenSet, modSet] = await Promise.all([
    getHiddenReplyIds(),
    getClientModeratedActorSet(),
  ]);
  const filtered = collected.filter(
    (it) =>
      !isNotificationLocallyDismissed(it, dismissedSet, dismissedState.clearedBeforeMs)
      && !isItemHiddenOrModeratedClient(it, hiddenSet, modSet)
  );
  const deduped = deduplicateUnifiedItems(filtered);

  // Enrich direct like/repost notifications via batch metrics helper
  const directTargets = [];
  const directIdxs = [];
  deduped.forEach((it, idx) => {
    const kind = String(it?._meta?.notification?.type || '');
    if (it?._meta?.linkedIds && (kind === 'like' || kind === 'repost')) {
      directTargets.push(it);
      directIdxs.push(idx);
    }
  });
  if (directTargets.length > 0) {
    const enrichedDirect = await enrichUnifiedItemsMetrics(directTargets).catch(() => directTargets);
    directIdxs.forEach((origIdx, i) => {
      if (enrichedDirect[i]) deduped[origIdx] = enrichedDirect[i];
    });
  }

  // Merge complete cross-platform breakdown across Mastodon + Bluesky + Threads onto every linked notification
  const canonKeys = new Set(
    deduped.map((it) => it?._meta?.notification?.canonicalPostKey).filter(Boolean)
  );
  const linkedTotals = new Map();
  for (const cid of canonKeys) {
    const row = byCanonical.get(String(cid));
    if (!row) continue;
    const cached = findCachedFeedItemForLink(row);
    const breakdown = {};
    if (cached?._meta?.metricsBreakdown) {
      for (const [p, vals] of Object.entries(cached._meta.metricsBreakdown)) {
        if (vals && typeof vals === 'object') {
          breakdown[p] = {
            likes: Number(vals.likes || 0),
            replies: Number(vals.replies || 0),
            reposts: Number(vals.reposts || 0),
          };
        }
      }
    }
    for (const it of deduped) {
      if (it?._meta?.notification?.canonicalPostKey !== cid) continue;
      if (it?._meta?.metricsBreakdown) {
        for (const [p, vals] of Object.entries(it._meta.metricsBreakdown)) {
          if (vals && typeof vals === 'object') {
            breakdown[p] = {
              likes: Number(vals.likes || 0),
              replies: Number(vals.replies || 0),
              reposts: Number(vals.reposts || 0),
            };
          }
        }
      } else if (
        it?.protocol === 'mastodon'
        && ['like', 'repost'].includes(String(it?._meta?.notification?.type || ''))
      ) {
        breakdown.mastodon = breakdown.mastodon || {
          likes: Number(it.metrics?.likes || 0),
          replies: Number(it.metrics?.replies || 0),
          reposts: Number(it.metrics?.reposts || 0),
        };
      }
      const tm = it?._meta?.notification?.targetMetrics || it?._meta?.notification?.targetPost?.metrics;
      if (tm && row.blueskyUri && !breakdown.bluesky) {
        breakdown.bluesky = {
          likes: Number(tm.likes || 0),
          replies: Number(tm.replies || 0),
          reposts: Number(tm.reposts || 0),
        };
      }
    }
    if (row.threadsPostId && threadsInsights[String(row.threadsPostId)] && !breakdown.threads) {
      const ti = threadsInsights[String(row.threadsPostId)];
      breakdown.threads = {
        likes: Number(ti.likes || 0),
        replies: Number(ti.replies || 0),
        reposts: Number(ti.reposts || 0),
      };
    }
    if (Object.keys(breakdown).length > 0) {
      const total = { likes: 0, replies: 0, reposts: 0 };
      for (const v of Object.values(breakdown)) {
        total.likes += Number(v.likes || 0);
        total.replies += Number(v.replies || 0);
        total.reposts += Number(v.reposts || 0);
      }
      linkedTotals.set(String(cid), { metrics: total, breakdown, cached });
    }
  }

  for (const it of deduped) {
    const cid = it?._meta?.notification?.canonicalPostKey;
    if (!cid || !linkedTotals.has(String(cid))) continue;
    const lt = linkedTotals.get(String(cid));
    it._meta.notification.postMetrics = { ...lt.metrics };
    it._meta.notification.postMetricsBreakdown = { ...lt.breakdown };
    const kind = String(it._meta.notification.type || '');
    if (kind === 'like' || kind === 'repost') {
      it.metrics = { ...lt.metrics };
      it._meta.metricsBreakdown = { ...lt.breakdown };
      if (!it.content_text && lt.cached?.content_text) {
        it.content_text = lt.cached.content_text;
        it.content_html = lt.cached.content_html || it.content_html || '';
      }
      if ((!it.attachments || it.attachments.length === 0) && Array.isArray(lt.cached?.attachments) && lt.cached.attachments.length > 0) {
        it.attachments = [...lt.cached.attachments];
      }
    }
  }

  return { items: deduped.slice(0, limit), warnings };
}

export async function dismissUnifiedNotifications({
  ids = [],
  mastodonNotifIds = [],
  threadsWatermarks = {},
} = {}) {
  const cleanIds = (Array.isArray(ids) ? ids : []).map((x) => String(x || '').trim()).filter(Boolean);
  const persistIds = cleanIds.filter(
    (x) => !/^threads:(?:notif:)?(?:likes|reposts):/.test(x)
  );
  const prev = await getActivityDismissedState();
  await kvSet(ACTIVITY_DISMISSED_KV_KEY, {
    ...prev,
    ids: [...new Set([...prev.ids, ...persistIds])].slice(-600),
    threadsWatermarks: mergeThreadsWatermarksLocal(prev.threadsWatermarks, threadsWatermarks),
  }).catch(() => {});

  const { masto } = await getClientAdapters();
  const cleanMasto = [...new Set((Array.isArray(mastodonNotifIds) ? mastodonNotifIds : []).map(String).filter(Boolean))];
  if (masto && cleanMasto.length > 0) {
    await Promise.allSettled(cleanMasto.map((mid) => masto.dismissNotification(mid)));
  }
  return { dismissed: cleanIds.length };
}

export async function clearUnifiedNotifications({ threadsWatermarks = {} } = {}) {
  const now = Date.now();
  const prev = await getActivityDismissedState();
  await kvSet(ACTIVITY_DISMISSED_KV_KEY, {
    ...prev,
    clearedBeforeMs: Math.max(prev.clearedBeforeMs || 0, now),
    threadsWatermarks: mergeThreadsWatermarksLocal(prev.threadsWatermarks, threadsWatermarks),
  }).catch(() => {});

  const { masto, bsky } = await getClientAdapters();
  const ops = [];
  if (masto) ops.push(masto.clearNotifications().catch(() => {}));
  if (bsky) ops.push(bsky.updateNotificationsSeen().catch(() => {}));
  await Promise.allSettled(ops);
  return { cleared: true, clearedBeforeMs: now };
}

export async function markUnifiedNotificationsSeen() {
  const bskyAuth = await getAuthenticatedAccount('bluesky');
  if (bskyAuth) {
    await updateBskyNotificationsSeen(getBskyGraphAuth(bskyAuth)).catch(() => {});
  }
  return { seen: true };
}

export async function updateMastodonProfileCredentials(patch = {}) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return updateCredentials({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
    ...patch,
  });
}

export async function syncConnectedBlueskyProfile(patch = {}) {
  const bskyAuth = await getAuthenticatedAccount('bluesky');
  if (!bskyAuth) return null;
  const repo = bskyAuth.meta.did || bskyAuth.meta.userId || bskyAuth.meta.id.replace(/^bluesky:/, '');
  const updated = await updateBskyProfile({
    serviceUrl: bskyAuth.meta.serviceUrl,
    repo,
    accessJwt: bskyAuth.secrets.accessJwt,
    refreshJwt: bskyAuth.secrets.refreshJwt,
    onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
    displayName: patch.displayName,
    description: patch.note,
    fields: patch.fields,
    publicVisible: typeof patch.publicVisible === 'boolean' ? patch.publicVisible : undefined,
    avatarBlob: patch.avatarFile || null,
    bannerBlob: patch.headerFile || null,
    removeAvatar: Boolean(patch.removeAvatar),
    removeHeader: Boolean(patch.removeHeader),
  });
  const prof = updated?.profile;
  if (prof) {
    await upsertSocialAccount({
      ...bskyAuth.meta,
      id: bskyAuth.meta.id,
      platform: 'bluesky',
      serviceUrl: bskyAuth.meta.serviceUrl,
      handle: prof.acct || bskyAuth.meta.handle,
      acct: prof.acct || bskyAuth.meta.acct,
      displayName: prof.displayName,
      avatar: prof.avatar,
      header: prof.header,
      url: prof.url,
      note: prof.note,
      noteText: prof.noteText,
      fields: prof.fields,
      publicVisible: prof.publicVisible !== false,
      followersCount: prof.followersCount,
      followingCount: prof.followingCount,
      statusesCount: prof.statusesCount,
      did: prof.did || repo,
    });
  }
  return { synced: true, profile: prof || null };
}

export function isUnifiedPublicDiscoveryEnabled(accounts = []) {
  const list = Array.isArray(accounts) ? accounts : [];
  const fedi = list.filter((a) => a && (a.platform === 'fediverse' || a.platform === 'mastodon'));
  const bsky = list.filter((a) => a && a.platform === 'bluesky');
  if (fedi.length === 0 && bsky.length === 0) return false;
  return (
    fedi.every(
      (a) =>
        a.discoverable !== false
        && a.indexable !== false
        && !a.locked
        && String(a.defaultVisibility || 'public').toLowerCase() === 'public'
    )
    && bsky.every((a) => a.publicVisible !== false)
  );
}

export async function setUnifiedPublicDiscovery(enabled) {
  const makePublic = Boolean(enabled);
  const [mastoAuth, bskyAuth] = await Promise.all([
    getAuthenticatedAccount('fediverse'),
    getAuthenticatedAccount('bluesky'),
  ]);
  if (!mastoAuth && !bskyAuth) {
    throw new Error('Connect Mastodon or Bluesky first.');
  }
  const tasks = [];
  if (mastoAuth) {
    tasks.push(
      updateCredentials({
        instanceUrl: mastoAuth.meta.instanceUrl,
        accessToken: mastoAuth.secrets.accessToken,
        discoverable: makePublic,
        indexable: makePublic,
        ...(makePublic ? { locked: false, defaultVisibility: 'public' } : {}),
      }).then((updated) =>
        upsertSocialAccount({
          ...mastoAuth.meta,
          id: mastoAuth.meta.id,
          platform: 'fediverse',
          discoverable: updated.discoverable,
          indexable: updated.indexable,
          locked: updated.locked,
          defaultVisibility: updated.defaultVisibility,
        })
      )
    );
  }
  if (bskyAuth) {
    tasks.push(syncConnectedBlueskyProfile({ publicVisible: makePublic }));
  }
  await Promise.all(tasks);
  return {
    enabled: makePublic,
    updatedMastodon: Boolean(mastoAuth),
    updatedBluesky: Boolean(bskyAuth),
  };
}

async function resolveMastoClientTarget(accountId, instanceUrl = 'https://mastodon.social', acct = '') {
  const { mastoAuth } = await getClientAdapters();
  const remoteOrigin = normalizeInstanceUrl(instanceUrl || 'https://mastodon.social');
  const homeOrigin = mastoAuth?.meta?.instanceUrl ? normalizeInstanceUrl(mastoAuth.meta.instanceUrl) : '';
  const useHome = Boolean(mastoAuth && (!homeOrigin || homeOrigin === remoteOrigin));
  let targetId = accountId;
  let targetOrigin = useHome ? homeOrigin : remoteOrigin;
  let token = useHome ? (mastoAuth?.secrets?.accessToken || '') : '';

  if (mastoAuth && homeOrigin && acct && (!accountId || homeOrigin !== remoteOrigin)) {
    try {
      const localProfile = await lookupAccountByAcct({
        instanceUrl: homeOrigin,
        accessToken: mastoAuth.secrets.accessToken,
        acct,
      });
      if (localProfile?.id) {
        targetId = localProfile.id;
        targetOrigin = homeOrigin;
        token = mastoAuth.secrets.accessToken;
      }
    } catch {
      // Keep remote public instance if home lookup fails
    }
  }
  return { targetId, targetOrigin, token };
}

function isBoostUnifiedItem(item) {
  return Boolean(item?._meta?.mastodon?.rebloggedBy || item?._meta?.bluesky?.rebloggedBy);
}

function isReplyUnifiedItem(item) {
  return Boolean(item?._meta?.mastodon?.inReplyToId || item?._meta?.bluesky?.reply);
}

function hydrateOwnBskyRepostUri(item, ownDid = '') {
  const rb = item?._meta?.bluesky?.rebloggedBy;
  if (!item?._meta?.bluesky || item._meta.bluesky.repostUri || !rb?.uri) return item;
  if (ownDid && rb.id && String(rb.id) !== String(ownDid)) return item;
  return {
    ...item,
    _meta: {
      ...item._meta,
      bluesky: { ...item._meta.bluesky, repostUri: String(rb.uri) },
    },
  };
}

function getBoostSortMs(item) {
  const ts = item?._meta?.mastodon?.rebloggedAt || item?._meta?.bluesky?.rebloggedAt || item?.date_published || '';
  return Date.parse(ts) || 0;
}

function mergePinnedAndPosts(pinnedItems = [], postItems = []) {
  const seen = new Set();
  const out = [];
  for (const it of [...pinnedItems, ...postItems]) {
    const id = String(it?.id || '');
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    out.push(it);
  }
  return out;
}

const replyParentContextCache = new Map();

function hasPopulatedReplyContext(item) {
  const ctx = item?._meta?.replyContext;
  return Boolean(ctx && (ctx.text || ctx.authorHandle || ctx.authorName));
}

async function hydrateReplyContexts(
  items = [],
  { candidatePool = [], mastoOrigin = '', mastoToken = '', bskyAuth = null } = {}
) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return list;

  const byKey = new Map();
  const indexItem = (raw) => {
    if (!raw || typeof raw !== 'object') return;
    const u = raw._meta ? raw : toUnifiedItem(raw);
    if (u.id) byKey.set(String(u.id), u);
    if (u._meta?.mastodon?.statusId) byKey.set(`mastodon:${String(u._meta.mastodon.statusId)}`, u);
    if (u._meta?.bluesky?.uri) byKey.set(`bluesky:${String(u._meta.bluesky.uri)}`, u);
  };
  for (const row of candidatePool) indexItem(row);
  for (const it of list) indexItem(it);

  const missingMastoIds = new Set();
  const missingBskyUris = new Set();

  for (const it of list) {
    if (hasPopulatedReplyContext(it)) continue;
    if (it.protocol === 'mastodon') {
      const pid = String(it._meta?.mastodon?.inReplyToId || '').trim();
      if (pid) {
        const key = `mastodon:${pid}`;
        if (!byKey.has(key) && !replyParentContextCache.has(key)) {
          missingMastoIds.add(pid);
        }
      }
    } else if (it.protocol === 'bluesky') {
      const parentUri = String(it._meta?.bluesky?.reply?.parent?.uri || '').trim();
      if (parentUri) {
        const key = `bluesky:${parentUri}`;
        if (!byKey.has(key) && !replyParentContextCache.has(key)) {
          missingBskyUris.add(parentUri);
        }
      }
    }
  }

  const fetches = [];
  if (missingMastoIds.size > 0 && mastoOrigin) {
    for (const pid of [...missingMastoIds].slice(0, 20)) {
      fetches.push(
        getStatus({
          instanceUrl: mastoOrigin,
          accessToken: mastoToken,
          statusId: pid,
        })
          .then((status) => {
            if (!status?.id || !(status.contentHtml || status.sanitizedHtml || status.author?.username)) {
              return;
            }
            const ctx = buildSynthesizedReplyContext(toUnifiedItem(status));
            replyParentContextCache.set(`mastodon:${pid}`, ctx);
          })
          .catch(() => {})
      );
    }
  }

  if (missingBskyUris.size > 0) {
    const authOpts = bskyAuth ? getBskyReadOpts(bskyAuth) : {};
    fetches.push(
      getBskyPostsByUris({
        uris: [...missingBskyUris].slice(0, 25),
        ...authOpts,
      })
        .then((postsByUri) => {
          for (const [uri, post] of Object.entries(postsByUri || {})) {
            if (!post?.uri || !(post.text || post.author?.handle)) continue;
            replyParentContextCache.set(`bluesky:${uri}`, buildSynthesizedReplyContext(toUnifiedItem(post)));
          }
        })
        .catch(() => {})
    );
  }

  if (fetches.length > 0) {
    await Promise.allSettled(fetches);
  }

  return list.map((it) => {
    if (hasPopulatedReplyContext(it)) return it;
    let ctx = null;
    if (it.protocol === 'mastodon') {
      const pid = String(it._meta?.mastodon?.inReplyToId || '').trim();
      if (pid) {
        const key = `mastodon:${pid}`;
        ctx = replyParentContextCache.get(key) || (byKey.has(key) ? buildSynthesizedReplyContext(byKey.get(key)) : null);
      }
    } else if (it.protocol === 'bluesky') {
      const parentUri = String(it._meta?.bluesky?.reply?.parent?.uri || '').trim();
      if (parentUri) {
        const key = `bluesky:${parentUri}`;
        ctx = replyParentContextCache.get(key) || (byKey.has(key) ? buildSynthesizedReplyContext(byKey.get(key)) : null);
      }
    }
    if (!ctx) return it;
    return {
      ...it,
      _meta: {
        ...(it._meta || {}),
        replyContext: ctx,
      },
    };
  });
}

async function fetchBridgeBlueskyTabItems(bskyAuth, tab, cursor = '') {
  const actor = bskyAuth?.meta?.did || bskyAuth?.meta?.handle || bskyAuth?.meta?.acct || '';
  if (!actor) return { items: [], nextCursor: '' };
  const filter = tab === 'media'
    ? 'posts_with_media'
    : (tab === 'boosts' || tab === 'replies' ? 'posts_with_replies' : 'posts_no_replies');
  const limit = tab === 'boosts' ? 40 : (tab === 'replies' ? 30 : 20);
  const res = await getBskyAuthorFeed({
    actor,
    limit,
    filter,
    ...(cursor ? { cursor } : {}),
    ...getBskyReadOpts(bskyAuth),
  }).catch(() => ({ items: [], nextCursor: '' }));
  const nextCursor = String(res?.nextCursor || '');
  const unified = (res.items || []).map((r) => toUnifiedItem(r));
  let filtered = [];
  if (tab === 'boosts') {
    const ownDid = bskyAuth?.meta?.did || '';
    filtered = unified.filter(isBoostUnifiedItem).map((it) => hydrateOwnBskyRepostUri(it, ownDid));
  } else if (tab === 'replies') {
    const repliesOnly = unified.filter((it) => !isBoostUnifiedItem(it) && isReplyUnifiedItem(it));
    filtered = await hydrateReplyContexts(repliesOnly, { candidatePool: unified, bskyAuth });
  } else if (tab === 'media') {
    filtered = unified.filter((it) => !isBoostUnifiedItem(it) && !isReplyUnifiedItem(it) && (it.attachments?.length || 0) > 0);
  } else if (tab === 'posts') {
    filtered = unified.filter((it) => !isBoostUnifiedItem(it) && !isReplyUnifiedItem(it));
  }
  return {
    items: filtered,
    nextCursor: nextCursor && nextCursor !== cursor ? nextCursor : '',
  };
}

async function fetchBridgeThreadsTabItems(tab) {
  if (tab !== 'posts' && tab !== 'media') return [];
  try {
    const { threads } = await getClientAdapters();
    if (!threads) return [];
    const own = await threads.fetchOwnPosts(20, { includeInsights: false }).catch(() => []);
    const unified = (Array.isArray(own) ? own : [])
      .map((r) => toUnifiedItem(r))
      .filter((it) => hasRenderablePostContent(it) && !isRepostUnifiedItem(it) && !isReplyUnifiedItem(it));
    if (tab === 'media') {
      return unified.filter((it) => (it.attachments?.length || 0) > 0);
    }
    return unified;
  } catch {
    return [];
  }
}

function linkAndMergeOwnCrossPosts(mastoItems = [], bskyItems = [], threadsItems = [], instanceUrl = '', storedLinks = []) {
  const bskyMatches = bskyItems.length > 0 ? findUniqueCrossPostMatches(mastoItems, bskyItems) : new Map();
  const threadsMatches = threadsItems.length > 0 ? findUniqueCrossPostMatches(mastoItems, threadsItems) : new Map();
  const consumedBsky = new Set();
  const consumedThreads = new Set();
  const bskyByUri = new Map();
  for (const it of bskyItems) {
    const uri = String(it?._meta?.bluesky?.uri || '');
    if (uri) bskyByUri.set(uri, it);
  }
  const threadsById = new Map();
  for (const it of threadsItems) {
    const pid = String(it?._meta?.threads?.postId || '');
    if (pid) threadsById.set(pid, it);
  }
  const storedByMastoId = new Map();
  for (const rec of storedLinks || []) {
    if (rec?.mastodonStatusId) storedByMastoId.set(String(rec.mastodonStatusId), rec);
    if (rec?.canonicalId) storedByMastoId.set(String(rec.canonicalId), rec);
  }

  const mergedMasto = mastoItems.map((m) => {
    const mid = String(m?.id || '');
    const mSid = String(m?._meta?.mastodon?.statusId || mid.replace(/^mastodon:/, ''));
    const stored = storedByMastoId.get(mSid) || storedByMastoId.get(mid) || null;
    const bMatch = (stored?.blueskyUri ? bskyByUri.get(String(stored.blueskyUri)) : null) || bskyMatches.get(mid) || null;
    const tMatch = (stored?.threadsPostId ? threadsById.get(String(stored.threadsPostId)) : null) || threadsMatches.get(mid) || null;
    if (!bMatch && !tMatch && !stored) return m;

    const prevLinked = m?._meta?.linkedIds || {};
    const bUri = bMatch?._meta?.bluesky?.uri || stored?.blueskyUri || prevLinked.blueskyUri || '';
    const bCid = bMatch?._meta?.bluesky?.cid || stored?.blueskyCid || prevLinked.blueskyCid || '';
    const tPid = tMatch?._meta?.threads?.postId || stored?.threadsPostId || prevLinked.threadsPostId || '';
    if (bMatch?.id) consumedBsky.add(String(bMatch.id));
    if (tMatch?.id) consumedThreads.add(String(tMatch.id));

    let nextItem = m;
    if (bMatch) nextItem = mergeUnifiedPostMetadata(nextItem, bMatch);
    if (tMatch) nextItem = mergeUnifiedPostMetadata(nextItem, tMatch);

    const nextLinked = {
      ...(nextItem?._meta?.linkedIds || {}),
      ...prevLinked,
      ...(mSid ? { mastodonStatusId: mSid } : {}),
      ...(bUri ? { blueskyUri: bUri, ...(bCid ? { blueskyCid: bCid } : {}) } : {}),
      ...(tPid ? { threadsPostId: tPid } : {}),
    };
    const isNewlyDiscovered = Boolean((bMatch || tMatch) && (
      String(stored?.blueskyUri || '') !== String(bUri || '')
      || String(stored?.threadsPostId || '') !== String(tPid || '')
    ));
    if (mid && mSid && isNewlyDiscovered && (bUri || tPid)) {
      void saveLocalLinkedPostOnDevice({
        canonicalId: mid,
        mastodonStatusId: mSid,
        mastodonInstance: String(m?._meta?.mastodon?.instanceUrl || instanceUrl || ''),
        blueskyUri: bUri,
        blueskyCid: bCid,
        threadsPostId: tPid,
      }).catch(() => {});
    }
    return {
      ...nextItem,
      _meta: {
        ...(nextItem._meta || {}),
        linkedIds: nextLinked,
      },
    };
  });

  const standaloneBsky = bskyItems.filter((it) => !consumedBsky.has(String(it?.id || '')));
  const standaloneThreads = threadsItems.filter((it) => !consumedThreads.has(String(it?.id || '')));
  return { mergedMasto, standaloneBsky, standaloneThreads };
}

function sortTabStatuses(items = [], tab = 'posts') {
  if (tab === 'boosts') {
    return [...items].sort((a, b) => getBoostSortMs(b) - getBoostSortMs(a));
  }
  if (tab === 'replies' || tab === 'posts' || tab === 'media') {
    return [...items].sort((a, b) => (Date.parse(b?.date_published || '') || 0) - (Date.parse(a?.date_published || '') || 0));
  }
  return items;
}

export async function fetchOwnStatuses(
  accountId,
  {
    tab = 'posts',
    instanceUrl = 'https://mastodon.social',
    maxId = '',
    bskyCursor = '',
    mastoDone = false,
    protocol = 'mastodon',
    acct = '',
    federatedMastodonId = '',
    includeBridges = false,
    skipMetricsEnrichment = false,
    returnPageMeta = false,
  } = {}
) {
  const wrapPageResult = (finalItems, nextCursor = null) => (
    returnPageMeta ? { items: finalItems, nextCursor: nextCursor || null } : finalItems
  );
  const isThreads = protocol === 'threads' || String(accountId || '').startsWith('threads:') || String(instanceUrl || '').includes('threads.net');
  const isBsky = !isThreads && (protocol === 'bluesky' || String(accountId || '').startsWith('did:'));

  if (isThreads) {
    const cleanHandle = String(acct || accountId || '')
      .trim()
      .replace(/^threads:/i, '')
      .replace(/^@/, '')
      .replace(/@threads\.net$/i, '')
      .toLowerCase();
    const cleanRawId = String(accountId || '').replace(/^threads:/i, '');
    const { threads, threadsAuth } = await getClientAdapters();
    const ownUid = String(threads?.userId || threadsAuth?.meta?.userId || '');
    const ownHandle = String(threads?.username || threadsAuth?.meta?.handle || threadsAuth?.meta?.acct || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    const isOwnThreads = Boolean(
      threads
      && (
        (ownUid && cleanRawId && cleanRawId === ownUid)
        || (ownHandle && cleanHandle && cleanHandle === ownHandle)
      )
    );
    if (isOwnThreads) {
      const own = await threads.fetchOwnPosts(20);
      return wrapPageResult(await enrichUnifiedItemsMetrics(own), null);
    }
    if (federatedMastodonId) {
      const { targetId, targetOrigin, token } = await resolveMastoClientTarget(
        federatedMastodonId,
        instanceUrl,
        cleanHandle ? `${cleanHandle}@threads.net` : ''
      );
      const rows = await getAccountStatuses({
        instanceUrl: targetOrigin,
        accessToken: token,
        accountId: targetId,
        excludeReplies: tab === 'posts',
        excludeReblogs: tab === 'posts' || tab === 'replies' || tab === 'media',
        onlyMedia: tab === 'media',
        pinned: tab === 'pinned',
        limit: tab === 'boosts' || tab === 'replies' ? 40 : 20,
        maxId,
      });
      const rawNextMaxId = rows.length > 0 ? String(rows[rows.length - 1]?.id || '') : '';
      const nextCursor = rawNextMaxId && rawNextMaxId !== maxId
        ? { maxId: rawNextMaxId, bskyCursor: '', mastoDone: false }
        : null;
      let unifiedRows = rows.map((r) => toUnifiedItem(r));
      if (tab === 'boosts') unifiedRows = unifiedRows.filter(isBoostUnifiedItem);
      else if (tab === 'replies') {
        unifiedRows = await hydrateReplyContexts(
          unifiedRows.filter((it) => !isBoostUnifiedItem(it) && isReplyUnifiedItem(it)),
          { candidatePool: rows, mastoOrigin: targetOrigin, mastoToken: token }
        );
      }
      else if (tab === 'posts' || tab === 'media') unifiedRows = unifiedRows.filter((it) => !isBoostUnifiedItem(it));
      return wrapPageResult(await enrichUnifiedItemsMetrics(unifiedRows), nextCursor);
    }
    return wrapPageResult([], null);
  }

  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    const ownDid = bskyAuth?.meta?.did || '';
    const filter = tab === 'media'
      ? 'posts_with_media'
      : (tab === 'replies' || tab === 'boosts' ? 'posts_with_replies' : 'posts_no_replies');
    const res = await getBskyAuthorFeed({
      actor: accountId || acct,
      cursor: maxId,
      limit: tab === 'boosts' ? 40 : (tab === 'replies' ? 30 : 15),
      filter,
      ...getBskyReadOpts(bskyAuth),
    });
    const rawNextBsky = String(res?.nextCursor || '');
    const nextCursor = rawNextBsky && rawNextBsky !== maxId
      ? { maxId: rawNextBsky, bskyCursor: '', mastoDone: true }
      : null;
    const unified = (res.items || []).map((r) => toUnifiedItem(r));
    if (tab === 'boosts') {
      return wrapPageResult(
        sortTabStatuses(
          unified.filter(isBoostUnifiedItem).map((it) => hydrateOwnBskyRepostUri(it, ownDid)),
          'boosts'
        ),
        nextCursor
      );
    }
    if (tab === 'replies') {
      return wrapPageResult(
        await hydrateReplyContexts(
          unified.filter((it) => !isBoostUnifiedItem(it) && isReplyUnifiedItem(it)),
          { candidatePool: unified, bskyAuth }
        ),
        nextCursor
      );
    }
    return wrapPageResult(unified.filter((it) => !isBoostUnifiedItem(it)), nextCursor);
  }

  const shouldFetchBskyBridge = includeBridges
    && (!maxId || Boolean(bskyCursor))
    && (tab === 'posts' || tab === 'media' || tab === 'boosts' || tab === 'replies');
  const [{ targetId, targetOrigin, token }, bskyAuth] = await Promise.all([
    resolveMastoClientTarget(accountId, instanceUrl, acct),
    shouldFetchBskyBridge
      ? getAuthenticatedAccount('bluesky')
      : Promise.resolve(null),
  ]);
  const fetchMastoPage = async (cursorMaxId) => getAccountStatuses({
    instanceUrl: targetOrigin,
    accessToken: token,
    accountId: targetId,
    excludeReplies: tab === 'posts',
    excludeReblogs: tab === 'posts' || tab === 'replies' || tab === 'media',
    onlyMedia: tab === 'media',
    pinned: tab === 'pinned',
    limit: tab === 'boosts' || tab === 'replies' ? 40 : 20,
    maxId: cursorMaxId,
  });

  const [initialRows, pinnedRows, bskyRes, threadsItems, storedLinks] = await Promise.all([
    mastoDone ? Promise.resolve([]) : fetchMastoPage(maxId),
    tab === 'posts' && !maxId
      ? getAccountStatuses({
          instanceUrl: targetOrigin,
          accessToken: token,
          accountId: targetId,
          pinned: true,
          limit: 20,
        }).catch(() => [])
      : Promise.resolve([]),
    bskyAuth ? fetchBridgeBlueskyTabItems(bskyAuth, tab, bskyCursor) : Promise.resolve({ items: [], nextCursor: '' }),
    includeBridges && !maxId && (tab === 'posts' || tab === 'media')
      ? fetchBridgeThreadsTabItems(tab)
      : Promise.resolve([]),
    includeBridges && (tab === 'posts' || tab === 'media')
      ? listLocalLinkedPosts(300).catch(() => [])
      : Promise.resolve([]),
  ]);

  let rows = Array.isArray(initialRows) ? initialRows : [];
  let activeMastoCursor = maxId;
  if (returnPageMeta && !mastoDone && (tab === 'replies' || tab === 'boosts')) {
    const hasMatch = (list) => list.some((r) => {
      const u = toUnifiedItem(r);
      return tab === 'boosts' ? isBoostUnifiedItem(u) : (!isBoostUnifiedItem(u) && isReplyUnifiedItem(u));
    });
    for (let extra = 0; extra < 2 && rows.length > 0 && !hasMatch(rows); extra += 1) {
      const candMax = String(rows[rows.length - 1]?.id || '');
      if (!candMax || candMax === activeMastoCursor) break;
      activeMastoCursor = candMax;
      const moreRows = await fetchMastoPage(activeMastoCursor).catch(() => []);
      if (!Array.isArray(moreRows) || moreRows.length === 0) {
        rows = [];
        break;
      }
      rows = moreRows;
    }
  }

  const bskyItems = Array.isArray(bskyRes?.items) ? bskyRes.items : [];
  const rawNextBsky = String(bskyRes?.nextCursor || '');
  const nextBskyCursor = rawNextBsky && rawNextBsky !== bskyCursor ? rawNextBsky : '';
  const rawNextMaxId = rows.length > 0 ? String(rows[rows.length - 1]?.id || '') : '';
  const nextMaxId = rawNextMaxId && rawNextMaxId !== activeMastoCursor ? rawNextMaxId : '';
  const nextMastoDone = Boolean(mastoDone || !nextMaxId);
  const nextCursor = (!nextMastoDone || nextBskyCursor)
    ? { maxId: nextMaxId, bskyCursor: nextBskyCursor, mastoDone: nextMastoDone }
    : null;

  let items = rows.map((r) => toUnifiedItem(r));
  if (tab === 'posts') {
    const pinnedItems = pinnedRows
      .map((r) => toUnifiedItem(r))
      .filter((it) => Boolean(it?._meta?.mastodon?.pinned) && !isBoostUnifiedItem(it));
    const basePosts = items.filter((it) => !isBoostUnifiedItem(it) && !isReplyUnifiedItem(it));
    const { mergedMasto: mergedPinned } = linkAndMergeOwnCrossPosts(pinnedItems, bskyItems, threadsItems, targetOrigin, storedLinks);
    const { mergedMasto, standaloneBsky } = linkAndMergeOwnCrossPosts(basePosts, bskyItems, threadsItems, targetOrigin, storedLinks);
    const nonPinnedCombined = sortTabStatuses(
      deduplicateUnifiedItems([...mergedMasto, ...standaloneBsky]),
      'posts'
    );
    items = mergePinnedAndPosts(mergedPinned, nonPinnedCombined);
  } else if (tab === 'media') {
    const mediaBase = items.filter((it) => !isBoostUnifiedItem(it));
    const { mergedMasto, standaloneBsky } = linkAndMergeOwnCrossPosts(mediaBase, bskyItems, threadsItems, targetOrigin, storedLinks);
    items = sortTabStatuses(
      deduplicateUnifiedItems([...mergedMasto, ...standaloneBsky]),
      'media'
    );
  } else if (tab === 'replies') {
    items = await hydrateReplyContexts(
      items.filter((it) => !isBoostUnifiedItem(it) && isReplyUnifiedItem(it)),
      { candidatePool: rows, mastoOrigin: targetOrigin, mastoToken: token, bskyAuth }
    );
    if (bskyItems.length > 0) {
      items = sortTabStatuses(deduplicateUnifiedItems([...items, ...bskyItems]), 'replies');
    }
  } else if (tab === 'boosts') {
    items = items.filter(isBoostUnifiedItem);
    if (bskyItems.length > 0) {
      items = deduplicateUnifiedItems([...items, ...bskyItems]);
    }
    items = sortTabStatuses(items, 'boosts');
  }

  const finalItems = skipMetricsEnrichment ? items : await enrichUnifiedItemsMetrics(items);
  return wrapPageResult(finalItems, nextCursor);
}

export async function fetchLists() {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return getUserLists({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken });
}

export async function createMastodonList(title, repliesPolicy = 'list') {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return createUserList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, title, repliesPolicy });
}

export async function deleteMastodonList(listId) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return deleteUserList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId });
}

/**
 * Normalize snake_case or camelCase account metadata into one uniform shape.
 * @param {object} raw
 */
export function normalizeAccountRecord(raw) {
  const acct = String(raw?.acct || raw?.handle || raw?.username || '').trim().replace(/^@/, '');
  const username = String(raw?.username || acct.split('@')[0] || '').trim();
  const displayName = decodeHtmlEntities(String(raw?.displayName || raw?.display_name || '')).trim() || username || acct;
  const protocol = raw?.protocol || (
    raw?.network === 'bluesky' || String(raw?.id || raw?.did || '').startsWith('did:')
      ? 'bluesky'
      : raw?.network === 'threads'
        ? 'threads'
        : 'mastodon'
  );
  return {
    id: String(raw?.id || raw?.did || ''),
    did: String(raw?.did || ''),
    protocol,
    network: raw?.network || (protocol === 'bluesky' ? 'bluesky' : (protocol === 'threads' ? 'threads' : 'fediverse')),
    username,
    acct,
    displayName,
    avatar: cleanMastodonMediaUrl(raw?.avatar || raw?.avatar_url),
    header: cleanMastodonMediaUrl(raw?.header || raw?.header_url),
    url: String(raw?.url || ''),
    note: String(raw?.note || raw?.note_html || ''),
    noteText: String(raw?.noteText || raw?.note_text || ''),
    fields: Array.isArray(raw?.fields) ? raw.fields : [],
    emojis: Array.isArray(raw?.emojis) ? raw.emojis : [],
    locked: Boolean(raw?.locked),
    bot: Boolean(raw?.bot),
    discoverable: raw?.discoverable !== false,
    indexable: raw?.indexable !== false,
    hideCollections: Boolean(raw?.hideCollections ?? raw?.hide_collections),
    defaultVisibility: raw?.defaultVisibility || raw?.default_visibility || 'public',
    defaultSensitive: Boolean(raw?.defaultSensitive ?? raw?.default_sensitive),
    defaultLanguage: raw?.defaultLanguage || raw?.default_language || 'en',
    attributionDomains: Array.isArray(raw?.attributionDomains)
      ? raw.attributionDomains
      : (Array.isArray(raw?.attribution_domains) ? raw.attribution_domains : []),
    followersCount: Number(raw?.followersCount ?? raw?.followers_count ?? 0),
    followingCount: Number(raw?.followingCount ?? raw?.following_count ?? 0),
    statusesCount: Number(raw?.statusesCount ?? raw?.statuses_count ?? 0),
    threadsLimited: Boolean(raw?.threadsLimited ?? raw?.threads_limited),
    federatedMastodonId: String(raw?.federatedMastodonId ?? raw?.federated_mastodon_id ?? ''),
    localModeration: Boolean(raw?.localModeration),
    viewer: raw?.viewer || null,
    relationship: raw?.relationship || null,
  };
}

export async function fetchListAccounts(listId) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return getListAccounts({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId });
}

export async function addAccountToMastodonList(listId, accountId) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return addAccountsToList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId, accountIds: [accountId] });
}

export async function removeAccountFromMastodonList(listId, accountId) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return removeAccountsFromList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId, accountIds: [accountId] });
}

function filterRuleDedupeKey(norm) {
  const kws = Array.isArray(norm?.keywords) ? norm.keywords : [];
  const termsKey = kws.length > 1
    ? kws.map((k) => String(k || '').trim().toLowerCase()).filter(Boolean).sort().join('|')
    : String(norm?.phrase || kws[0] || norm?.title || '').trim().toLowerCase();
  return `${termsKey}:${norm?.filter_action || 'hide'}`;
}

function normalizeFilterRuleRecord(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const kws = Array.isArray(rule.keywords)
    ? rule.keywords.map((k) => String(typeof k === 'string' ? k : k?.keyword || '').trim()).filter(Boolean)
    : [];
  const phrase = String(rule.phrase || kws[0] || rule.title || '').trim();
  if (!phrase && kws.length === 0) return null;
  return {
    ...rule,
    id: String(rule.id || `local_${phrase}`),
    title: String(rule.title || phrase),
    phrase,
    ...(kws.length > 0 ? { keywords: kws } : {}),
    filter_action: String(rule.filter_action || 'hide').toLowerCase(),
  };
}

function syncStoreFilters(rules) {
  const normalized = (Array.isArray(rules) ? rules : []).map(normalizeFilterRuleRecord).filter(Boolean);
  setFilterRules(normalized);
  void persistCachedFilters(normalized).catch(() => {});
  return normalized;
}

export async function fetchKeywordFilters() {
  const conn = connectionStore.get();
  const nodeUrl = conn.mode === 'online' ? conn.nodeUrl : '';
  const [{ mastoAuth, bskyAuth }, localRules, serverRules] = await Promise.all([
    getClientAdapters(),
    listLocalFilterRules().catch(() => []),
    nodeUrl ? fetchSanctuaryKeywordFilters({ nodeUrl }).catch(() => []) : Promise.resolve([]),
  ]);

  const remoteTasks = [];
  if (mastoAuth?.secrets?.accessToken) {
    remoteTasks.push(
      getFilters({
        instanceUrl: mastoAuth.meta.instanceUrl,
        accessToken: mastoAuth.secrets.accessToken,
      }).catch(() => [])
    );
  }
  if (bskyAuth?.secrets?.accessJwt) {
    remoteTasks.push(
      getBskyMutedWords(getBskyReadOpts(bskyAuth)).catch(() => [])
    );
  }
  const remoteRules = remoteTasks.length > 0 ? (await Promise.all(remoteTasks)).flat() : [];

  const combined = [];
  const seen = new Set();
  for (const r of [...remoteRules, ...serverRules, ...localRules]) {
    const norm = normalizeFilterRuleRecord(r);
    if (!norm) continue;
    const key = filterRuleDedupeKey(norm);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(norm);
  }

  // Do not overwrite hydrated KV filter rules with empty state before social auth finishes loading.
  const existingFilters = feedStore.get().filters || [];
  if (!mastoAuth && !bskyAuth && combined.length === 0 && existingFilters.length > 0) {
    return existingFilters;
  }

  const synced = syncStoreFilters(combined);
  if (nodeUrl && synced.length > serverRules.length) {
    void saveSanctuaryKeywordFilters(synced, { nodeUrl }).catch(() => {});
  }
  return synced;
}

export async function addKeywordFilter({ title, phrase, filterAction = 'hide' }) {
  let remoteCreated = null;
  const { mastoAuth, bskyAuth } = await getClientAdapters();
  if (mastoAuth) {
    try {
      remoteCreated = await createFilterRule({
        instanceUrl: mastoAuth.meta.instanceUrl,
        accessToken: mastoAuth.secrets.accessToken,
        title: title || phrase,
        phrase,
        filterAction,
      });
    } catch {
      remoteCreated = null;
    }
  }
  if (bskyAuth?.secrets?.accessJwt && String(filterAction || 'hide').toLowerCase() === 'hide') {
    void syncBskyMutedWord({
      ...getBskyReadOpts(bskyAuth),
      phrase,
      remove: false,
    }).catch(() => {});
  }
  const localRecord = {
    id: remoteCreated?.id ? String(remoteCreated.id) : `local_${Date.now()}`,
    ...(remoteCreated?.mastodon_filter_id ? { mastodon_filter_id: String(remoteCreated.mastodon_filter_id) } : {}),
    title: remoteCreated?.title || title || phrase,
    phrase: remoteCreated?.phrase || phrase,
    filter_action: remoteCreated?.filter_action || filterAction,
  };
  await saveLocalFilterRule(localRecord).catch(() => {});
  const norm = normalizeFilterRuleRecord(localRecord);
  if (norm) {
    const key = filterRuleDedupeKey(norm);
    const next = [
      ...(feedStore.get().filters || []).filter(
        (f) => String(f.id) !== String(norm.id) && filterRuleDedupeKey(f) !== key
      ),
      norm,
    ];
    const synced = syncStoreFilters(next);
    if (connectionStore.get().mode === 'online') {
      void saveSanctuaryKeywordFilters(synced, { nodeUrl: connectionStore.get().nodeUrl }).catch(() => {});
    }
  }
  return norm || localRecord;
}

export async function removeKeywordFilter(filterId) {
  const idStr = String(filterId || '');
  const existing = (feedStore.get().filters || []).find((f) => String(f.id) === idStr);
  const { mastoAuth, bskyAuth } = await getClientAdapters();
  if (mastoAuth && !idStr.startsWith('local_') && !idStr.startsWith('bsky_mw_')) {
    await deleteFilterRule({
      instanceUrl: mastoAuth.meta.instanceUrl,
      accessToken: mastoAuth.secrets.accessToken,
      filterId: existing?.mastodon_filter_id || idStr,
    }).catch(() => {});
  }
  if (bskyAuth?.secrets?.accessJwt && existing) {
    const termsToRemove = Array.isArray(existing.keywords) && existing.keywords.length > 0
      ? existing.keywords
      : [existing.phrase || existing.title].filter(Boolean);
    for (const term of termsToRemove) {
      void syncBskyMutedWord({
        ...getBskyReadOpts(bskyAuth),
        phrase: term,
        remove: true,
      }).catch(() => {});
    }
  }
  await deleteLocalFilterRule(idStr).catch(() => {});
  if (existing?.mastodon_filter_id && String(existing.mastodon_filter_id) !== idStr) {
    await deleteLocalFilterRule(String(existing.mastodon_filter_id)).catch(() => {});
  }
  const localRows = await listLocalFilterRules().catch(() => []);
  const normPhrase = String(existing?.phrase || existing?.title || '').trim().toLowerCase();
  for (const row of localRows) {
    const rId = String(row?.id || '');
    const rMasto = String(row?.mastodon_filter_id || '');
    const rPhrase = String(row?.phrase || row?.title || '').trim().toLowerCase();
    if (rId === idStr || (rMasto && rMasto === idStr) || (normPhrase && rPhrase === normPhrase)) {
      await deleteLocalFilterRule(rId).catch(() => {});
    }
  }
  const next = (feedStore.get().filters || []).filter((f) => String(f.id) !== idStr);
  const synced = syncStoreFilters(next);
  if (connectionStore.get().mode === 'online') {
    void saveSanctuaryKeywordFilters(synced, { nodeUrl: connectionStore.get().nodeUrl }).catch(() => {});
  }
  return true;
}

const moderationAccountsCache = new Map();

function getModerationCacheKey(kind) {
  const accSig = (authStore.get().accounts || []).map((a) => a.id).filter(Boolean).sort().join('|');
  return `${accSig}:${kind}`;
}

export function peekCachedModerationAccounts(kind = 'mutes') {
  if (IS_NODE_RUNTIME || (kind !== 'mutes' && kind !== 'blocks')) return null;
  const cached = moderationAccountsCache.get(getModerationCacheKey(kind));
  return Array.isArray(cached) ? [...cached] : null;
}

export function resetModerationCacheForTests() {
  moderationAccountsCache.clear();
}

function updateModerationCacheEntry(kind, { removeId = '', removeCanon = '', invalidate = false } = {}) {
  if (kind !== 'mutes' && kind !== 'blocks') return;
  const key = getModerationCacheKey(kind);
  if (invalidate) {
    moderationAccountsCache.delete(key);
    return;
  }
  const existing = moderationAccountsCache.get(key);
  if (!Array.isArray(existing)) return;
  const filtered = existing.filter((acc) => {
    if (removeId && String(acc?.id || '') === String(removeId)) return false;
    if (removeCanon) {
      const c = canonicalizeActorHandle(acc?.acct || acc?.username || acc?.id, acc?.protocol || 'mastodon');
      if (c && c === removeCanon) return false;
    }
    return true;
  });
  moderationAccountsCache.set(key, filtered);
}

export async function fetchModerationAccounts(kind = 'mutes') {
  if (kind !== 'mutes' && kind !== 'blocks') return [];
  const [{ mastoAuth, bskyAuth }, localMod] = await Promise.all([
    getClientAdapters(),
    getLocalModeratedAccounts().catch(() => ({ blocks: [], mutes: [] })),
  ]);

  const tasks = [];
  if (mastoAuth?.secrets?.accessToken) {
    tasks.push(
      (kind === 'blocks'
        ? getBlocks({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken })
        : getMutes({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken })
      )
        .then((list) => (list || []).map((a) => normalizeAccountRecord({ ...a, protocol: 'mastodon' })))
        .catch(() => [])
    );
  }
  if (bskyAuth?.secrets?.accessJwt) {
    const bskyOpts = getBskyGraphAuth(bskyAuth);
    tasks.push(
      (kind === 'blocks' ? getBskyBlocks(bskyOpts) : getBskyMutes(bskyOpts))
        .then((res) => (res?.accounts || []).map(normalizeAccountRecord))
        .catch(() => [])
    );
  }

  const localEntries = (localMod[kind] || []).map((row) => {
    const proto = row?.protocol === 'fediverse' ? 'mastodon' : String(row?.protocol || 'threads').toLowerCase();
    const fallbackAcct = proto === 'threads'
      ? (row?.username ? `${row.username}@threads.net` : '')
      : (row?.username || row?.id || '');
    const rowId = String(row?.id || row?.did || row?.canonicalActor || `${proto}:${row?.username || ''}`);
    return {
      ...normalizeAccountRecord({
        id: rowId,
        did: proto === 'bluesky' ? (row?.did || (rowId.startsWith('did:') ? rowId : '')) : '',
        protocol: proto,
        network: proto,
        username: row?.username || '',
        acct: row?.acct || fallbackAcct,
        displayName: row?.displayName || row?.acct || row?.username || rowId,
        localModeration: true,
      }),
      canonicalActor: row?.canonicalActor || '',
      localModeration: true,
    };
  });

  const extra = tasks.length > 0 ? (await Promise.all(tasks)).flat() : [];
  const seen = new Set();
  const out = [];
  for (const acc of [...extra, ...localEntries]) {
    if (!acc?.id) continue;
    const proto = acc.protocol || 'mastodon';
    const key = canonicalizeActorHandle(acc.acct || acc.username || acc.id, proto) || `${proto}:${acc.id}`;
    const idKey = acc.id ? `${proto}:${String(acc.id).toLowerCase()}` : '';
    if (seen.has(key) || (idKey && seen.has(idKey))) continue;
    seen.add(key);
    if (idKey) seen.add(idKey);
    out.push(acc);
  }
  if (out.length > 0) {
    const syncKeys = [];
    for (const acc of out) {
      const proto = acc.protocol || 'mastodon';
      const ck = canonicalizeActorHandle(acc.acct || acc.username, proto);
      if (ck && ck !== `${proto}:`) syncKeys.push(ck);
      const rid = String(acc.did || acc.id || '').trim().toLowerCase();
      if (rid) {
        syncKeys.push(rid.includes(':') && !rid.startsWith('did:') ? rid : `${proto}:${rid}`);
        if (rid.startsWith('did:')) syncKeys.push(rid);
      }
    }
    if (syncKeys.length > 0) {
      setModeratedActors([...(feedStore.get().moderatedActors || []), ...syncKeys]);
    }
  }
  if (!IS_NODE_RUNTIME) {
    moderationAccountsCache.set(getModerationCacheKey(kind), [...out]);
  }
  return out;
}

export async function removeModeratedAccount(kind, account) {
  if (kind !== 'mutes' && kind !== 'blocks') return { ok: false };
  const targetId = String(account?.id || account?.canonicalActor || account?.username || account?.acct || '');
  await removeLocalModeratedAccount(kind, account || targetId).catch(() => {});
  const curActors = feedStore.get().moderatedActors || [];
  const proto = account?.protocol === 'fediverse' ? 'mastodon' : String(account?.protocol || 'threads').toLowerCase();
  const canon = canonicalizeActorHandle(account?.acct || account?.username || targetId, proto);
  const dropSet = new Set(
    [
      canon,
      String(account?.canonicalActor || '').toLowerCase(),
      targetId.toLowerCase(),
      targetId ? `${proto}:${targetId.toLowerCase()}` : '',
    ].filter(Boolean)
  );
  if (dropSet.size > 0) {
    setModeratedActors(curActors.filter((a) => !dropSet.has(String(a || '').toLowerCase())));
  }
  updateModerationCacheEntry(kind, { removeId: targetId, removeCanon: canon });
  await hydrateCachedModeration().catch(() => {});
  return { ok: true };
}

export async function fetchAuthorWithRelationship(
  accountId,
  instanceUrl = 'https://mastodon.social',
  { protocol = 'mastodon', acct = '' } = {}
) {
  const isThreads = protocol === 'threads'
    || String(accountId || '').startsWith('threads:')
    || String(instanceUrl || '').includes('threads.net');
  const isBsky = !isThreads && (protocol === 'bluesky' || String(accountId || '').startsWith('did:'));

  if (isThreads) {
    const cleanRawId = String(accountId || '').replace(/^threads:/i, '').trim();
    const cleanHandle = String(acct || (/^\d+$/.test(cleanRawId) ? '' : cleanRawId))
      .trim()
      .replace(/^threads:/i, '')
      .replace(/^@/, '')
      .replace(/@threads\.net$/i, '')
      .toLowerCase();
    const { mastoAuth, threads, threadsAuth } = await getClientAdapters();
    const ownUid = String(threads?.userId || threadsAuth?.meta?.userId || '');
    const ownHandle = String(threads?.username || threadsAuth?.meta?.handle || threadsAuth?.meta?.acct || '')
      .trim()
      .replace(/^@/, '')
      .toLowerCase();
    const isOwn = Boolean(
      threadsAuth
      && (
        (ownUid && cleanRawId && cleanRawId === ownUid)
        || (ownHandle && cleanHandle && cleanHandle === ownHandle)
      )
    );
    if (isOwn) {
      const verified = threadsAuth?.secrets?.accessToken
        ? await verifyThreadsCredentials({ accessToken: threadsAuth.secrets.accessToken }).catch(() => null)
        : null;
      const handle = String(verified?.username || ownHandle || cleanHandle).replace(/^@/, '');
      return {
        profile: normalizeAccountRecord({
          id: String(verified?.id || ownUid || handle),
          protocol: 'threads',
          network: 'threads',
          username: handle,
          acct: handle,
          displayName: verified?.name || threadsAuth?.meta?.displayName || handle,
          avatar: verified?.threads_profile_picture_url || threadsAuth?.meta?.avatar || '',
          noteText: verified?.threads_biography || threadsAuth?.meta?.noteText || '',
          url: handle ? `https://www.threads.net/@${handle}` : 'https://www.threads.net',
        }),
        relationship: null,
      };
    }

    if (threads && cleanHandle && typeof threads.lookupProfile === 'function') {
      const lookedUp = await threads.lookupProfile(cleanHandle).catch(() => null);
      if (lookedUp) {
        return {
          profile: normalizeAccountRecord({
            ...lookedUp,
            protocol: 'threads',
            network: 'threads',
            id: cleanHandle,
            acct: cleanHandle,
            username: cleanHandle,
            note: lookedUp.noteText || '',
            url: `https://www.threads.net/@${cleanHandle}`,
            threadsLimited: !lookedUp.followersCount && !lookedUp.noteText,
          }),
          relationship: null,
        };
      }
    }

    if (mastoAuth && cleanHandle) {
      const homeOrigin = normalizeInstanceUrl(mastoAuth.meta.instanceUrl || 'https://mastodon.social');
      const token = mastoAuth.secrets?.accessToken || '';
      if (token) {
        const fedProfile = await lookupAccountByAcct({
          instanceUrl: homeOrigin,
          accessToken: token,
          acct: `${cleanHandle}@threads.net`,
        }).catch(() => null);
        if (fedProfile?.id) {
          const rels = await getRelationships({
            instanceUrl: homeOrigin,
            accessToken: token,
            accountIds: [fedProfile.id],
          }).catch(() => []);
          return {
            profile: normalizeAccountRecord({
              ...fedProfile,
              protocol: 'threads',
              network: 'threads',
              acct: cleanHandle,
              username: cleanHandle,
              url: `https://www.threads.net/@${cleanHandle}`,
              federatedMastodonId: String(fedProfile.id),
            }),
            relationship: rels[0] || null,
            resolvedInstanceUrl: homeOrigin,
            federatedMastodon: true,
          };
        }
      }
    }

    return {
      profile: normalizeAccountRecord({
        id: cleanHandle || cleanRawId || 'threads',
        protocol: 'threads',
        network: 'threads',
        username: cleanHandle,
        acct: cleanHandle,
        displayName: cleanHandle || 'Threads User',
        avatar: '',
        url: cleanHandle ? `https://www.threads.net/@${cleanHandle}` : 'https://www.threads.net',
        threadsLimited: true,
      }),
      relationship: null,
    };
  }

  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    const raw = await getBskyProfile({
      actor: accountId || acct,
      ...getBskyReadOpts(bskyAuth),
    });
    return normalizeBskyActorProfile(raw);
  }

  const { mastoAuth } = await getClientAdapters();
  const remoteOrigin = normalizeInstanceUrl(instanceUrl || 'https://mastodon.social');
  const homeOrigin = mastoAuth?.meta?.instanceUrl ? normalizeInstanceUrl(mastoAuth.meta.instanceUrl) : '';
  const token = mastoAuth?.secrets?.accessToken || '';

  if (mastoAuth && homeOrigin && homeOrigin === remoteOrigin) {
    const [profile, rels] = await Promise.all([
      getAccountProfile({ instanceUrl: homeOrigin, accessToken: token, accountId }),
      token ? getRelationships({ instanceUrl: homeOrigin, accessToken: token, accountIds: [accountId] }).catch(() => []) : [],
    ]);
    return { profile, relationship: rels[0] || null, resolvedInstanceUrl: homeOrigin };
  }

  if (mastoAuth && homeOrigin && acct) {
    let localProfile = null;
    try {
      localProfile = await lookupAccountByAcct({ instanceUrl: homeOrigin, accessToken: token, acct });
    } catch {
      const searched = await searchFediverse({
        instanceUrl: homeOrigin,
        accessToken: token,
        query: acct,
        type: 'accounts',
        resolve: true,
        limit: 1,
      }).catch(() => ({ accounts: [] }));
      localProfile = searched.accounts?.[0] || null;
    }
    if (localProfile?.id) {
      const rels = await getRelationships({
        instanceUrl: homeOrigin,
        accessToken: token,
        accountIds: [localProfile.id],
      }).catch(() => []);
      return { profile: localProfile, relationship: rels[0] || null, resolvedInstanceUrl: homeOrigin };
    }
  }

  const profile = await getAccountProfile({ instanceUrl: remoteOrigin, accessToken: '', accountId });
  return { profile, relationship: null, resolvedInstanceUrl: remoteOrigin };
}

function getBskyGraphAuth(bskyAuth) {
  return {
    serviceUrl: bskyAuth.meta.serviceUrl,
    repo: bskyAuth.meta.did || bskyAuth.meta.userId || bskyAuth.meta.id.replace(/^bluesky:/, ''),
    accessJwt: bskyAuth.secrets.accessJwt,
    refreshJwt: bskyAuth.secrets.refreshJwt,
    onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
  };
}

export async function toggleFollowAuthor(accountId, unfollow = false, opts = {}) {
  const isBsky = opts?.protocol === 'bluesky' || String(accountId || '').startsWith('did:');
  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    if (!bskyAuth) throw new Error('Connect Bluesky bridge first.');
    return followBskyActor({
      ...getBskyGraphAuth(bskyAuth),
      targetDid: accountId,
      followUri: opts?.followUri || null,
      unfollow,
    });
  }
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return followAccount({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, accountId, unfollow });
}

function normalizeThreadsModUsername(accountId, acct = '') {
  return String(acct || accountId || '')
    .trim()
    .replace(/^threads:/i, '')
    .replace(/^@/, '')
    .replace(/@threads\.net$/i, '')
    .split('@')[0]
    .toLowerCase();
}

async function executeModerationToggle({ kind, accountId, undo = false, opts = {} }) {
  const isMute = kind === 'mutes';
  const actionName = isMute ? (undo ? 'unmute' : 'mute') : (undo ? 'unblock' : 'block');
  const rawProto = String(opts?.protocol || '').trim().toLowerCase();
  const cleanRawId = String(accountId || '').trim();
  const rawAcctInput = String(opts?.acct || '').trim().replace(/^@/, '');
  const isBridgyBsky = rawAcctInput.toLowerCase().endsWith('@bsky.brid.gy');
  const isThreads = !isBridgyBsky && (
    rawProto === 'threads'
    || cleanRawId.startsWith('threads:')
    || rawAcctInput.toLowerCase().endsWith('@threads.net')
  );
  const isBsky = !isThreads && (
    isBridgyBsky
    || rawProto === 'bluesky'
    || cleanRawId.startsWith('did:')
    || cleanRawId.startsWith('bluesky:')
  );
  const proto = isThreads ? 'threads' : (isBsky ? 'bluesky' : 'mastodon');

  let cleanId = '';
  let username = '';
  let acct = '';
  let canon = '';
  let targetKey = '';

  if (isThreads) {
    username = normalizeThreadsModUsername(cleanRawId, rawAcctInput);
    if (!username) throw new Error('Threads handle is required.');
    acct = `${username}@threads.net`;
    canon = `threads:${username}`;
    targetKey = username;
    cleanId = cleanRawId.startsWith('threads:') ? '' : cleanRawId;
  } else if (isBsky) {
    const strippedHandle = rawAcctInput.replace(/^bluesky:/i, '').replace(/@bsky\.brid\.gy$/i, '').toLowerCase();
    cleanId = cleanRawId.replace(/^bluesky:/i, '');
    const cleanTarget = cleanId || strippedHandle;
    if (!cleanTarget) throw new Error('Bluesky account identifier is required.');
    acct = strippedHandle || cleanTarget;
    username = acct;
    canon = strippedHandle ? `bluesky:${strippedHandle}` : `bluesky:${cleanTarget.toLowerCase()}`;
    targetKey = cleanTarget;
  } else {
    const strippedAcct = rawAcctInput.replace(/^(?:mastodon|fediverse):/i, '').toLowerCase();
    cleanId = cleanRawId.replace(/^(?:mastodon|fediverse):/i, '');
    const cleanTarget = cleanId || strippedAcct;
    if (!cleanTarget) throw new Error('Mastodon account identifier is required.');
    acct = strippedAcct || cleanId;
    username = acct ? acct.split('@')[0] : cleanId;
    canon = strippedAcct ? canonicalizeActorHandle(strippedAcct, 'mastodon') : `mastodon:${cleanId.toLowerCase()}`;
    targetKey = cleanTarget;
  }

  const localMatchTarget = {
    id: cleanId || opts?.id || '',
    acct,
    username,
    protocol: proto,
    canonicalActor: canon,
  };

  if (undo) {
    await removeLocalModeratedAccount(kind, localMatchTarget).catch(() => {});
  } else {
    const curLocal = await getLocalModeratedAccounts().catch(() => ({ blocks: [], mutes: [] }));
    const existing = curLocal[kind] || [];
    const entry = {
      ...(localMatchTarget.id ? { id: localMatchTarget.id } : {}),
      username,
      displayName: opts?.displayName || acct || targetKey,
      acct,
      protocol: proto,
      canonicalActor: canon,
    };
    const nextList = [
      entry,
      ...existing.filter((r) => {
        const rc = String(r?.canonicalActor || '').toLowerCase();
        const ri = String(r?.id || '').toLowerCase();
        const ra = String(r?.acct || '').toLowerCase();
        if (canon && rc === canon) return false;
        if (localMatchTarget.id && ri && ri === localMatchTarget.id.toLowerCase()) return false;
        if (acct && ra && ra === acct.toLowerCase()) return false;
        return true;
      }),
    ];
    await saveLocalModeratedAccounts({ [kind]: nextList }).catch(() => {});
  }
  await hydrateCachedModeration().catch(() => {});
  if (!undo) {
    await purgeModeratedAuthorAffinity([
      canon,
      localMatchTarget.id ? `${proto}:${localMatchTarget.id.toLowerCase()}` : '',
      localMatchTarget.id && localMatchTarget.id.startsWith('did:') ? localMatchTarget.id.toLowerCase() : '',
    ]).catch(() => {});
  }

  const cleanReplyPid = !isMute && isThreads
    ? String(opts?.replyPostId || '').replace(/^threads:(?:notif:)?/, '').trim()
    : '';

  const warnings = [];
  let remoteRes = null;

  if (isThreads) {
    if (!isMute && !undo && cleanReplyPid) {
      const hideRes = await hideReplyUnified({
        id: `threads:${cleanReplyPid}`,
        protocol: 'threads',
        _meta: { threads: { postId: cleanReplyPid } },
      }).catch(() => null);
      if (hideRes?.warnings?.length) warnings.push(...hideRes.warnings);
    }
    const { mastoAuth } = await getClientAdapters();
    if (mastoAuth?.secrets?.accessToken) {
      const fed = await lookupAccountByAcct({
        instanceUrl: mastoAuth.meta.instanceUrl,
        accessToken: mastoAuth.secrets.accessToken,
        acct: `${username}@threads.net`,
      }).catch(() => null);
      if (fed?.id) {
        const fedFn = isMute ? muteAccount : blockAccount;
        remoteRes = await fedFn({
          instanceUrl: mastoAuth.meta.instanceUrl,
          accessToken: mastoAuth.secrets.accessToken,
          accountId: fed.id,
          ...(isMute ? { unmute: undo } : { unblock: undo }),
        }).catch(() => null);
      }
    }
  } else if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky').catch(() => null);
    if (bskyAuth?.secrets?.accessJwt) {
      try {
        if (isMute) {
          remoteRes = await muteBskyActor({
            ...getBskyGraphAuth(bskyAuth),
            actor: targetKey,
            unmute: undo,
          });
        } else {
          remoteRes = await blockBskyActor({
            ...getBskyGraphAuth(bskyAuth),
            targetDid: targetKey,
            blockUri: opts?.blockUri || null,
            unblock: undo,
          });
        }
      } catch (err) {
        warnings.push(err?.message || `Unable to sync ${actionName} on Bluesky`);
      }
    }
  } else {
    const { mastoAuth } = await getClientAdapters();
    if (mastoAuth?.secrets?.accessToken) {
      try {
        const homeOrigin = normalizeInstanceUrl(mastoAuth.meta.instanceUrl);
        let resolvedTargetId = cleanId;
        const postInstance = opts?.instanceUrl ? normalizeInstanceUrl(opts.instanceUrl) : '';
        if (acct && acct.includes('@') && (!resolvedTargetId || (postInstance && postInstance !== homeOrigin))) {
          const lookedUp = await lookupAccountByAcct({
            instanceUrl: homeOrigin,
            accessToken: mastoAuth.secrets.accessToken,
            acct,
          }).catch(() => null);
          if (lookedUp?.id) resolvedTargetId = String(lookedUp.id);
        }
        if (resolvedTargetId) {
          const mFn = isMute ? muteAccount : blockAccount;
          remoteRes = await mFn({
            instanceUrl: homeOrigin,
            accessToken: mastoAuth.secrets.accessToken,
            accountId: resolvedTargetId,
            ...(isMute ? { unmute: undo } : { unblock: undo }),
          });
        }
      } catch (err) {
        warnings.push(err?.message || `Unable to sync ${actionName} on Mastodon`);
      }
    }
  }

  updateModerationCacheEntry(
    kind,
    undo ? { removeId: localMatchTarget.id || targetKey, removeCanon: canon } : { invalidate: true }
  );
  return {
    ...(remoteRes && typeof remoteRes === 'object' ? remoteRes : {}),
    ...(isMute ? { muting: !undo } : { blocking: !undo }),
    localModeration: !undo && !remoteRes,
    ...(isThreads ? { username } : { acct }),
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export async function toggleMuteAuthor(accountId, unmute = false, opts = {}) {
  return executeModerationToggle({ kind: 'mutes', accountId, undo: unmute, opts });
}

export async function toggleBlockAuthor(accountId, unblock = false, opts = {}) {
  return executeModerationToggle({ kind: 'blocks', accountId, undo: unblock, opts });
}

export async function fetchFollowConnections(
  accountId,
  { kind = 'following', protocol = 'mastodon', instanceUrl = 'https://mastodon.social', acct = '', cursor = '' } = {}
) {
  const isBsky = protocol === 'bluesky' || String(accountId || '').startsWith('did:');

  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    const readOpts = { ...getBskyReadOpts(bskyAuth), actor: accountId || acct, cursor };
    return kind === 'followers' ? getBskyFollowers(readOpts) : getBskyFollows(readOpts);
  }

  const { targetId, targetOrigin, token } = await resolveMastoClientTarget(accountId, instanceUrl, acct);
  return kind === 'followers'
    ? getAccountFollowers({ instanceUrl: targetOrigin, accessToken: token, accountId: targetId, maxId: cursor })
    : getAccountFollowing({ instanceUrl: targetOrigin, accessToken: token, accountId: targetId, maxId: cursor });
}

function connectionDedupeKey(account) {
  const isBsky =
    account?.protocol === 'bluesky'
    || String(account?.did || account?.id || '').startsWith('did:');
  const proto = isBsky ? 'bluesky' : 'mastodon';
  const handle = account?.acct || account?.handle || account?.did || account?.id || '';
  return canonicalizeActorHandle(handle, proto) || `${proto}:${account?.id || account?.did || ''}`;
}

export function mergeCentralizedConnectionAccounts(existing = [], mastoAccounts = [], bskyAccounts = []) {
  const mastoList = Array.isArray(mastoAccounts) ? mastoAccounts : [];
  const bskyList = Array.isArray(bskyAccounts) ? bskyAccounts : [];
  const incoming = [];
  const maxLen = Math.max(mastoList.length, bskyList.length);
  for (let i = 0; i < maxLen; i++) {
    if (i < mastoList.length && mastoList[i]) {
      incoming.push({ ...mastoList[i], protocol: mastoList[i].protocol || 'mastodon' });
    }
    if (i < bskyList.length && bskyList[i]) {
      incoming.push({ ...bskyList[i], protocol: bskyList[i].protocol || 'bluesky' });
    }
  }

  const byKey = new Map();
  for (const rawItem of [...(Array.isArray(existing) ? existing : []), ...incoming]) {
    if (!rawItem) continue;
    const isBsky =
      rawItem.protocol === 'bluesky'
      || String(rawItem.did || rawItem.id || '').startsWith('did:');
    const item = { ...rawItem, protocol: isBsky ? 'bluesky' : 'mastodon' };
    const key = connectionDedupeKey(item);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, item);
      continue;
    }
    if (item.protocol === 'bluesky' && prev.protocol !== 'bluesky') {
      byKey.set(key, item);
    }
  }
  return Array.from(byKey.values());
}

export async function fetchCentralizedConnections({ kind = 'following', cursors = {} } = {}) {
  const [mastoAuth, bskyAuth] = await Promise.all([
    getAuthenticatedAccount('fediverse'),
    getAuthenticatedAccount('bluesky'),
  ]);

  const hasCursorMap = Boolean(
    cursors && (Object.hasOwn(cursors, 'mastodon') || Object.hasOwn(cursors, 'bluesky'))
  );
  const mastoTargetId = mastoAuth?.meta?.userId || mastoAuth?.meta?.accountId || '';
  const mastoAcct = mastoAuth?.meta?.acct || mastoAuth?.meta?.handle || '';
  const mastoInstance = mastoAuth?.meta?.instanceUrl || 'https://mastodon.social';
  const bskyActor = bskyAuth?.meta?.did || bskyAuth?.meta?.handle || bskyAuth?.meta?.acct || '';
  const bskyAcct = bskyAuth?.meta?.handle || bskyAuth?.meta?.acct || bskyActor;

  const canFetchMasto = Boolean(mastoAuth?.meta && (mastoTargetId || mastoAcct));
  const canFetchBsky = Boolean(bskyAuth?.meta && bskyActor);
  const wantMasto = canFetchMasto && (!hasCursorMap || Boolean(cursors.mastodon));
  const wantBsky = canFetchBsky && (!hasCursorMap || Boolean(cursors.bluesky));

  const tasks = [];
  if (wantMasto) {
    tasks.push({
      protocol: 'mastodon',
      promise: fetchFollowConnections(mastoTargetId || mastoAcct, {
        kind,
        protocol: 'mastodon',
        instanceUrl: mastoInstance,
        acct: mastoAcct,
        cursor: cursors?.mastodon || '',
      }),
    });
  }
  if (wantBsky) {
    tasks.push({
      protocol: 'bluesky',
      promise: fetchFollowConnections(bskyActor, {
        kind,
        protocol: 'bluesky',
        acct: bskyAcct,
        cursor: cursors?.bluesky || '',
      }),
    });
  }

  const settled = await Promise.allSettled(tasks.map((t) => t.promise));
  let mastoAccounts = [];
  let bskyAccounts = [];
  let mastoNext = null;
  let bskyNext = null;
  const errors = [];

  settled.forEach((res, idx) => {
    const proto = tasks[idx].protocol;
    if (res.status === 'fulfilled') {
      const page = res.value || {};
      if (proto === 'mastodon') {
        mastoAccounts = Array.isArray(page.accounts) ? page.accounts : [];
        mastoNext = page.nextCursor || null;
      } else {
        bskyAccounts = Array.isArray(page.accounts) ? page.accounts : [];
        bskyNext = page.nextCursor || null;
      }
    } else {
      errors.push({ protocol: proto, message: res.reason?.message || String(res.reason || 'Failed') });
    }
  });

  if (tasks.length > 0 && errors.length === tasks.length) {
    const firstErr = settled.find((s) => s.status === 'rejected')?.reason;
    throw firstErr || new Error('Could not load connections.');
  }

  const accounts = mergeCentralizedConnectionAccounts([], mastoAccounts, bskyAccounts);
  const nextCursors = { mastodon: mastoNext, bluesky: bskyNext };
  const networks = [];
  if (canFetchMasto) networks.push('mastodon');
  if (canFetchBsky) networks.push('bluesky');

  return {
    accounts,
    mastoAccounts,
    bskyAccounts,
    cursors: nextCursors,
    hasMore: Boolean(mastoNext || bskyNext),
    networks,
    errors,
  };
}

function mergeThreadDescendantsStreams(streams = []) {
  const validStreams = streams.filter((s) => Array.isArray(s) && s.length > 0);
  if (validStreams.length === 0) return [];
  if (validStreams.length === 1) return validStreams[0];

  const sigOf = (item) => {
    const proto = String(item?.protocol || 'mastodon').toLowerCase();
    const handle = String(item?.author?.handle || '');
    const canon = canonicalizeActorHandle(handle, proto);
    const snippet = String(item?.content_text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
    return `${canon}\u001f${snippet}`;
  };
  const seenSigs = new Map();
  const suppressedIds = new Set();
  for (const list of validStreams) {
    for (const entry of list) {
      const item = entry?.item;
      if (!item?.id) continue;
      const sig = sigOf(item);
      if (!sig || sig.startsWith('\u001f')) continue;
      const prev = seenSigs.get(sig);
      if (!prev) {
        seenSigs.set(sig, entry);
        continue;
      }
      const tDiff = Math.abs((Date.parse(prev.item.date_published || '') || 0) - (Date.parse(item.date_published || '') || 0));
      if (tDiff <= 120_000) {
        const prevH = String(prev.item.author?.handle || '').toLowerCase();
        const curH = String(item.author?.handle || '').toLowerCase();
        const prevBridge = prevH.endsWith('@threads.net') || prevH.endsWith('@bsky.brid.gy');
        const curBridge = curH.endsWith('@threads.net') || curH.endsWith('@bsky.brid.gy');
        if (prevBridge && !curBridge) {
          entry.depth = prev.depth;
          suppressedIds.add(prev.item.id);
          seenSigs.set(sig, entry);
        } else if (!prevBridge && curBridge) {
          suppressedIds.add(item.id);
        } else if (prev.item.id !== item.id) {
          suppressedIds.add(item.id);
        }
      }
    }
  }

  const subtrees = [];
  const seenIds = new Set();
  for (const list of validStreams) {
    let curTree = [];
    for (const entry of list) {
      const id = entry?.item?.id;
      if (!id || seenIds.has(id) || suppressedIds.has(id)) continue;
      seenIds.add(id);
      if (Number(entry.depth || 0) === 0 || curTree.length === 0) {
        if (curTree.length > 0) {
          subtrees.push({ ts: Date.parse(curTree[0].item.date_published || '') || 0, nodes: curTree });
        }
        curTree = [entry];
      } else {
        curTree.push(entry);
      }
    }
    if (curTree.length > 0) {
      subtrees.push({ ts: Date.parse(curTree[0].item.date_published || '') || 0, nodes: curTree });
    }
  }
  subtrees.sort((a, b) => a.ts - b.ts);
  return subtrees.flatMap((t) => t.nodes);
}

function cleanMirroredEntries(entries, mirroredUris, mirroredThreadsIds) {
  const out = [];
  let shiftDown = false;
  for (const entry of entries || []) {
    const item = toUnifiedItem(entry.item || entry);
    let depth = Number(entry.depth ?? entry?._threadDepth ?? 0);
    const bUri = String(item._meta?.bluesky?.uri || '');
    const tId = String(item._meta?.threads?.postId || '');
    if ((bUri && mirroredUris.has(bUri)) || (tId && mirroredThreadsIds.has(tId))) {
      shiftDown = true;
      continue;
    }
    if (shiftDown && depth > 0) {
      depth -= 1;
    } else if (shiftDown && depth === 0) {
      shiftDown = false;
    }
    out.push({ item, depth });
  }
  return out;
}

export async function fetchPostThread(rawPost) {
  const focal = toUnifiedItem(rawPost);
  const proto = focal.protocol || 'mastodon';
  const [hiddenSet, modSet] = await Promise.all([
    getHiddenReplyIds(),
    getClientModeratedActorSet(),
  ]);

  const rawIdForProto = proto === 'threads'
    ? String(focal._meta?.threads?.postId || String(focal.id || '').replace(/^threads:(?:notif:)?/, ''))
    : proto === 'bluesky'
      ? String(focal._meta?.bluesky?.uri || String(focal.id || '').replace(/^bluesky:/, ''))
      : String(focal._meta?.mastodon?.statusId || String(focal.id || '').replace(/^mastodon:/, ''));

  let primaryFocal = focal;
  let primaryAncestors = [];
  let primaryDescendants = [];
  let primaryTargetId = rawIdForProto;

  if (proto === 'threads') {
    if (!primaryTargetId) return { focal, ancestors: [], descendants: [] };
    const { threads } = await getClientAdapters();
    if (!threads) throw new Error('Connect Threads bridge to load Threads replies.');
    const res = await threads.getPostThread(focal);
    primaryFocal = res?.status ? toUnifiedItem(res.status) : focal;
    primaryAncestors = Array.isArray(res?.ancestors) ? res.ancestors.map((a) => toUnifiedItem(a)) : [];
    primaryDescendants = Array.isArray(res?.descendants)
      ? res.descendants.map((d) => ({ item: toUnifiedItem(d.item || d), depth: Number(d.depth ?? d?._threadDepth ?? 0) }))
      : [];
  } else if (proto === 'bluesky') {
    if (!primaryTargetId) return { focal, ancestors: [], descendants: [] };
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    const res = await getBskyPostThread({ ...getBskyReadOpts(bskyAuth), uri: primaryTargetId });
    primaryFocal = res?.status ? toUnifiedItem(res.status) : focal;
    primaryAncestors = Array.isArray(res?.ancestors) ? res.ancestors.map((a) => toUnifiedItem(a)) : [];
    primaryDescendants = Array.isArray(res?.descendants)
      ? res.descendants.map((d) => ({ item: toUnifiedItem(d.item || d), depth: Number(d.depth || 0) }))
      : [];
  } else if (proto === 'mastodon') {
    if (!primaryTargetId) return { focal, ancestors: [], descendants: [] };
    const mastoAuth = await getAuthenticatedAccount('fediverse');
    const homeOrigin = mastoAuth?.meta?.instanceUrl ? normalizeInstanceUrl(mastoAuth.meta.instanceUrl) : '';
    const postOrigin = normalizeInstanceUrl(
      focal._meta?.mastodon?.instanceUrl || rawPost?.instanceUrl || homeOrigin || 'https://mastodon.social'
    );
    let targetOrigin = postOrigin;
    let token = '';
    if (homeOrigin && homeOrigin === postOrigin) {
      targetOrigin = homeOrigin;
      token = mastoAuth.secrets.accessToken || '';
    } else if (homeOrigin && focal.url) {
      const searchRes = await searchFediverse({
        instanceUrl: homeOrigin,
        accessToken: mastoAuth.secrets.accessToken,
        query: focal.url,
        type: 'statuses',
        resolve: true,
        limit: 1,
      }).catch(() => null);
      if (searchRes?.statuses?.[0]?.id) {
        primaryTargetId = searchRes.statuses[0].id;
        targetOrigin = homeOrigin;
        token = mastoAuth.secrets.accessToken || '';
      }
    }
    const ctx = await getStatusContext({ instanceUrl: targetOrigin, accessToken: token, statusId: primaryTargetId });
    const depthMap = new Map([[String(primaryTargetId), -1]]);
    primaryDescendants = (Array.isArray(ctx?.descendants) ? ctx.descendants : []).map((d) => {
      const u = toUnifiedItem(d);
      const dSid = String(u._meta?.mastodon?.statusId || '');
      const parentSid = String(u._meta?.mastodon?.inReplyToId || '');
      const depth = depthMap.has(parentSid) ? Math.min(depthMap.get(parentSid) + 1, 3) : 0;
      if (dSid) depthMap.set(dSid, depth);
      return { item: u, depth };
    });
    primaryFocal = ctx?.status ? toUnifiedItem(ctx.status) : focal;
    primaryAncestors = Array.isArray(ctx?.ancestors) ? ctx.ancestors.map((a) => toUnifiedItem(a)) : [];
  } else {
    return { focal, ancestors: [], descendants: [] };
  }

  // Merge cross-posted Bluesky & Threads replies locally (works offline / Android / fallback mode too)
  const group = await findLocalLinkedPostGroup(primaryFocal.id || focal.id).catch(() => []);
  const linkedSummary = primaryFocal._meta?.linkedIds || focal._meta?.linkedIds || cleanLinkedIdsSummary(group[0] || {});
  const linkedBskyUris = [
    ...new Set([
      ...(linkedSummary.blueskyUri ? [linkedSummary.blueskyUri] : []),
      ...group.map((g) => g.blueskyUri).filter(Boolean),
    ]),
  ];
  const linkedThreadsIds = [
    ...new Set([
      ...(linkedSummary.threadsPostId ? [linkedSummary.threadsPostId] : []),
      ...group.map((g) => g.threadsPostId).filter(Boolean),
    ]),
  ];

  const fetchedBsky = new Set(proto === 'bluesky' ? [primaryTargetId] : []);
  const fetchedThreads = new Set(proto === 'threads' ? [primaryTargetId] : []);
  const pendingBsky = linkedBskyUris.filter((u) => !fetchedBsky.has(u));
  const pendingThreads = linkedThreadsIds.filter((tid) => !fetchedThreads.has(tid));

  if (pendingBsky.length > 0 || pendingThreads.length > 0) {
    const [{ threads }, bskyAuth] = await Promise.all([
      getClientAdapters().catch(() => ({ threads: null })),
      getAuthenticatedAccount('bluesky').catch(() => null),
    ]);
    const bskyReadOpts = getBskyReadOpts(bskyAuth);
    const mirroredBsky = new Set(group.slice(1).map((g) => g.blueskyUri).filter(Boolean));
    const mirroredThreads = new Set(group.slice(1).map((g) => g.threadsPostId).filter(Boolean));
    if (proto === 'mastodon' && linkedSummary.blueskyUri) mirroredBsky.add(linkedSummary.blueskyUri);
    if (proto === 'mastodon' && linkedSummary.threadsPostId) mirroredThreads.add(linkedSummary.threadsPostId);

    const extraTasks = [];
    for (const bUri of pendingBsky) {
      extraTasks.push(
        getBskyPostThread({ ...bskyReadOpts, uri: bUri })
          .then((res) => cleanMirroredEntries(res?.descendants || [], mirroredBsky, mirroredThreads))
          .catch(() => [])
      );
    }
    if (threads) {
      for (const tid of pendingThreads) {
        extraTasks.push(
          threads.getPostThread(tid)
            .then((res) => cleanMirroredEntries(res?.descendants || [], mirroredBsky, mirroredThreads))
            .catch(() => [])
        );
      }
    }
    const extraStreams = await Promise.all(extraTasks);
    primaryDescendants = mergeThreadDescendantsStreams([primaryDescendants, ...extraStreams]);
  }

  const [enrichedFocal] = await enrichUnifiedItemsMetrics([primaryFocal]);
  const finalFocal = enrichedFocal || primaryFocal;
  if (Object.keys(linkedSummary).length > 0) {
    finalFocal._meta = { ...(finalFocal._meta || {}), linkedIds: linkedSummary };
  }

  const ownAccounts = authStore.get().accounts || [];
  const fHandle = String(finalFocal.author?.handle || '').replace(/^@/, '').toLowerCase();
  const fId = String(finalFocal.author?.id || '');
  const isOwnThread = Boolean(group.length > 0 || ownAccounts.some((a) => {
    const ah = String(a.acct || a.handle || '').replace(/^@/, '').toLowerCase();
    return (ah && fHandle && ah === fHandle) || (a.userId && fId && String(a.userId) === fId);
  }));

  const visibleAncestors = primaryAncestors.filter((a) => !isItemHiddenOrModeratedClient(a, hiddenSet, modSet));
  const visibleDescendants = primaryDescendants
    .filter((e) => !isItemHiddenOrModeratedClient(e.item, hiddenSet, modSet))
    .map((e) => {
      if (isOwnThread) {
        e.item._meta = { ...(e.item._meta || {}), onOwnThread: true };
      }
      return e;
    });

  if (finalFocal.metrics) {
    finalFocal.metrics.replies = Math.max(Number(finalFocal.metrics.replies || 0), visibleDescendants.length);
  }

  return {
    focal: finalFocal,
    ancestors: visibleAncestors,
    descendants: visibleDescendants,
  };
}

export async function removeFollowerAccount(accountId) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return removeFollower({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
    accountId,
  });
}

export async function fetchPendingFollowRequests() {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return getFollowRequests({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
  });
}

export async function respondToFollowRequest(accountId, accept = true) {
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return respondFollowRequest({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
    accountId,
    accept: Boolean(accept),
  });
}

export async function searchAccountsAndPosts(query) {
  const [{ mastoAuth, threads }, bskyAuth] = await Promise.all([
    getClientAdapters(),
    getAuthenticatedAccount('bluesky').catch(() => null),
  ]);
  const origin = mastoAuth?.meta?.instanceUrl || 'https://mastodon.social';
  const token = mastoAuth?.secrets?.accessToken || '';
  const readOpts = getBskyReadOpts(bskyAuth);
  const cleanActorQuery = String(query || '').trim().replace(/^@/, '');
  const wantThreads = Boolean(threads && authStore.get().isThreadsConnected);

  const [fediRes, bskyActorsRes, bskyPostsRes, thrProfileRes, thrPostsRes] = await Promise.allSettled([
    (async () => {
      const res = await searchFediverse({ instanceUrl: origin, accessToken: token, query, resolve: Boolean(token) });
      let fediAccounts = res.accounts || [];
      if (token && fediAccounts.length) {
        const rels = await getRelationships({ instanceUrl: origin, accessToken: token, accountIds: fediAccounts.map((a) => a.id) }).catch(() => []);
        const byId = new Map(rels.map((r) => [String(r.id), r]));
        fediAccounts = fediAccounts.map((a) => ({ ...a, relationship: byId.get(String(a.id)) || null }));
      }
      return {
        accounts: fediAccounts,
        statuses: (res.statuses || []).map((s) => toUnifiedItem(s)),
        hashtags: res.hashtags || [],
      };
    })(),
    searchBskyActors({ ...readOpts, query: cleanActorQuery, limit: 12 }),
    searchBskyPosts({ ...readOpts, query, limit: 12 }),
    wantThreads && cleanActorQuery && !cleanActorQuery.includes(' ')
      ? threads.lookupProfile(cleanActorQuery)
      : Promise.resolve(null),
    wantThreads ? threads.searchPosts(query, 12) : Promise.resolve([]),
  ]);

  const accounts = fediRes.status === 'fulfilled' ? [...fediRes.value.accounts] : [];
  let statuses = fediRes.status === 'fulfilled' ? [...fediRes.value.statuses] : [];
  const hashtags = fediRes.status === 'fulfilled' ? [...fediRes.value.hashtags] : [];

  if (bskyActorsRes.status === 'fulfilled' && Array.isArray(bskyActorsRes.value?.actors)) {
    const seenDids = new Set(accounts.map((a) => a.did || a.id));
    for (const actor of bskyActorsRes.value.actors) {
      if (actor?.did && !seenDids.has(actor.did)) {
        seenDids.add(actor.did);
        accounts.push(normalizeBskyActorSummary(actor));
      }
    }
  }
  if (bskyPostsRes.status === 'fulfilled' && Array.isArray(bskyPostsRes.value?.items)) {
    statuses = deduplicateUnifiedItems([
      ...statuses,
      ...bskyPostsRes.value.items.map((p) => toUnifiedItem(p)),
    ]);
  }
  if (thrProfileRes.status === 'fulfilled' && thrProfileRes.value?.username) {
    const p = thrProfileRes.value;
    if (!accounts.some((a) => a.protocol === 'threads' && a.username === p.username)) {
      accounts.push(normalizeAccountRecord(p));
    }
  }
  if (thrPostsRes.status === 'fulfilled' && Array.isArray(thrPostsRes.value)) {
    statuses = deduplicateUnifiedItems([
      ...statuses,
      ...thrPostsRes.value.map((p) => toUnifiedItem(p)),
    ]);
  }

  return { accounts, statuses, hashtags };
}

export async function fetchHashtagPosts(rawTag, { limit = 30 } = {}) {
  const cleanTag = String(rawTag || '').replace(/^#/, '').trim();
  if (!cleanTag) return [];
  const { mastoAuth, bskyAuth, threads } = await getClientAdapters();
  const origin = mastoAuth?.meta?.instanceUrl || 'https://mastodon.social';
  const token = mastoAuth?.secrets?.accessToken || '';
  const readOpts = getBskyReadOpts(bskyAuth);
  const wantThreads = Boolean(threads && authStore.get().isThreadsConnected);
  const hashQuery = `#${cleanTag}`;

  const [fediRes, bskyRes, thrRes] = await Promise.allSettled([
    getTimeline({
      instanceUrl: origin,
      accessToken: token,
      stream: 'hashtag',
      hashtag: cleanTag,
      limit,
    }).then((r) => (r?.items || []).map((it) => toUnifiedItem(it))),
    searchBskyPosts({ ...readOpts, query: hashQuery, limit }).then((r) =>
      (r?.items || []).map((it) => toUnifiedItem(it))
    ),
    wantThreads
      ? threads.searchPosts(hashQuery, Math.min(limit, 20)).then((rows) =>
          (Array.isArray(rows) ? rows : []).map((it) => toUnifiedItem(it))
        )
      : Promise.resolve([]),
  ]);

  const combined = [
    ...(fediRes.status === 'fulfilled' ? fediRes.value : []),
    ...(bskyRes.status === 'fulfilled' ? bskyRes.value : []),
    ...(thrRes.status === 'fulfilled' ? thrRes.value : []),
  ];
  return deduplicateUnifiedItems(combined).sort(
    (a, b) => (Date.parse(b?.date_published || '') || 0) - (Date.parse(a?.date_published || '') || 0)
  );
}

export async function fetchSocialBridgeStatus() {
  const retries = await listLocalRetries().catch(() => []);
  authStore.set({ retryQueue: retries });
  return { retryQueue: retries };
}

async function linkLocalRetryResults({ protocol, rootCanonical, mastodonStatusId, offset = 0, results = [] }) {
  if (!rootCanonical || results.length === 0) return;
  const group = await findLocalLinkedPostGroup(rootCanonical).catch(() => []);
  const mastoInst = group[0]?.mastodonInstance || '';
  for (let i = 0; i < results.length; i += 1) {
    const segIdx = offset + i;
    const rec = group[segIdx] || null;
    const canonicalId = rec?.canonicalId || rec?.canonical_id || (segIdx === 0 ? rootCanonical : `${rootCanonical}:part:${segIdx}`);
    const parentCanonicalId = rec ? (rec.parentCanonicalId || '') : (segIdx === 0 ? '' : rootCanonical);
    const mSid = rec ? (rec.mastodonStatusId || '') : (segIdx === 0 ? (mastodonStatusId || '') : '');
    const val = results[i];
    if (protocol === 'bluesky') {
      await saveLocalLinkedPost({
        canonicalId,
        mastodonStatusId: mSid,
        mastodonInstance: mastoInst,
        blueskyUri: val?.uri || '',
        blueskyCid: val?.cid || '',
        parentCanonicalId,
      });
    } else {
      await saveLocalLinkedPost({
        canonicalId,
        mastodonStatusId: mSid,
        mastodonInstance: mastoInst,
        threadsPostId: String(val || ''),
        parentCanonicalId,
      });
    }
  }
}

export async function runBridgeRetry(retryId) {
  const retries = await listLocalRetries();
  const entry = retries.find((r) => r.id === retryId);
  if (!entry) return { retryQueue: retries };
  const { bsky, threads } = await getClientAdapters();
  const parts = Array.isArray(entry.payload?.textParts) && entry.payload.textParts.length > 0
    ? entry.payload.textParts
    : [''];
  const offset = Number(entry.payload?.segmentOffset || 0);
  const rootCanonical = entry.payload?.canonicalId || (entry.payload?.mastodonStatusId ? `mastodon:${entry.payload.mastodonStatusId}` : '');
  const mSid = entry.payload?.mastodonStatusId || '';

  if (entry.protocol === 'bluesky' && bsky) {
    if (entry.operation === 'delete') {
      await bsky.delete({ uri: entry.payload?.nativeId || '' });
    } else {
      try {
        const res = await publishBskySegments({
          bsky,
          textParts: parts,
          rootRef: entry.payload?.replyRoot || null,
          parentRef: entry.payload?.replyParent || null,
        });
        await linkLocalRetryResults({
          protocol: 'bluesky',
          rootCanonical,
          mastodonStatusId: mSid,
          offset,
          results: res.refs || [],
        });
      } catch (err) {
        if (err instanceof PartialBridgePublishError) {
          await linkLocalRetryResults({
            protocol: 'bluesky',
            rootCanonical,
            mastodonStatusId: mSid,
            offset,
            results: err.published,
          });
          await enqueueLocalRetry({
            ...entry,
            payload: {
              ...entry.payload,
              textParts: err.remainingSegments,
              segmentOffset: offset + err.published.length,
              replyRoot: entry.payload?.replyRoot || err.published[0] || null,
              replyParent: err.lastParent,
            },
            lastError: err.message,
          });
        }
        throw err;
      }
    }
  } else if (entry.protocol === 'threads' && threads) {
    if (entry.operation === 'delete') {
      await threads.delete({ postId: entry.payload?.nativeId || '' });
    } else {
      const mediaUrls = offset === 0 ? (entry.payload?.mastodonMediaUrls || []).filter(Boolean) : [];
      try {
        const res = await publishThreadsSegments({
          threads,
          textParts: parts,
          media: mediaUrls.map((url) => ({ url })),
          uploadedUrls: mediaUrls,
          parentTid: entry.payload?.replyToThreadsId || '',
        });
        await linkLocalRetryResults({
          protocol: 'threads',
          rootCanonical,
          mastodonStatusId: mSid,
          offset,
          results: res.ids || [],
        });
      } catch (err) {
        if (err instanceof PartialBridgePublishError) {
          await linkLocalRetryResults({
            protocol: 'threads',
            rootCanonical,
            mastodonStatusId: mSid,
            offset,
            results: err.published,
          });
          await enqueueLocalRetry({
            ...entry,
            payload: {
              ...entry.payload,
              textParts: err.remainingSegments,
              segmentOffset: offset + err.published.length,
              replyToThreadsId: String(err.lastParent || ''),
              mastodonMediaUrls: [],
            },
            lastError: err.message,
          });
        }
        throw err;
      }
    }
  }
  await deleteLocalRetry(retryId);
  const next = await listLocalRetries();
  authStore.set({ retryQueue: next });
  return { retryQueue: next };
}

export async function dismissBridgeRetry(retryId) {
  await deleteLocalRetry(retryId);
  const next = await listLocalRetries();
  authStore.set({ retryQueue: next });
  return { retryQueue: next };
}

export const retrySocialBridgeItem = runBridgeRetry;
export const dismissSocialBridgeItem = dismissBridgeRetry;

/**
 * Push up to 3 most recent token-free own social posts to the Sanctuary node
 * so active AI Programs stay aware of what the user has been writing publicly.
 */
export async function syncRecentUserPostsToSanctuary({ preloadedItems = null, freshItems = null } = {}) {
  if (connectionStore.get().mode !== 'online') return { synced: false, count: 0 };
  const accounts = authStore.get().accounts || [];
  const mastoMeta = accounts.find((a) => a.platform === 'fediverse' || a.platform === 'mastodon');
  if (!mastoMeta) return { synced: false, count: 0 };

  let fetched = [];
  let fetchFailed = false;
  if (Array.isArray(preloadedItems)) {
    fetched = preloadedItems;
  } else {
    try {
      fetched = await fetchOwnStatuses(mastoMeta.userId || mastoMeta.acct || mastoMeta.handle, {
        tab: 'posts',
        instanceUrl: mastoMeta.instanceUrl || 'https://mastodon.social',
        acct: mastoMeta.acct || mastoMeta.handle || '',
      });
    } catch {
      fetchFailed = true;
      fetched = [];
    }
  }

  const combined = [...(Array.isArray(freshItems) ? freshItems : []), ...fetched];
  const collected = [];
  const seenTexts = new Set();
  for (const rawItem of combined) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = toUnifiedItem(rawItem);
    if (item._meta?.mastodon?.rebloggedBy || item._meta?.bluesky?.rebloggedBy || rawItem.reblog) continue;
    const text = String(item.content_text || item.text || '').trim();
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    const createdAt = String(item.date_published || item.createdAt || '').trim();
    const parsedTs = Date.parse(createdAt);
    collected.push({
      text,
      created_at: createdAt,
      _ts: Number.isFinite(parsedTs) ? parsedTs : 0,
    });
  }
  collected.sort((a, b) => b._ts - a._ts);
  const recentPosts = collected.slice(0, 3).map(({ text, created_at }) => ({ text, created_at }));

  if (fetchFailed && recentPosts.length === 0) {
    return { synced: false, count: 0 };
  }

  await syncMastodonUserProfileToSanctuary({
    username: mastoMeta.handle || '',
    acct: mastoMeta.acct || mastoMeta.handle || '',
    display_name: mastoMeta.displayName || mastoMeta.handle || '',
    note_text: mastoMeta.noteText || '',
    note: mastoMeta.note || '',
    fields: Array.isArray(mastoMeta.fields) ? mastoMeta.fields : [],
    recent_posts: recentPosts,
  });
  return { synced: true, count: recentPosts.length };
}

/**
 * Subscribe to real-time Mastodon /api/v1/streaming updates via direct Mastodon WebSocket.
 */
export function subscribeLiveSocialUpdates({ onUpdate, onDelete, onNotification: _onNotification } = {}) {
  let ws = null;
  let closed = false;
  void (async () => {
    const mastoAuth = await getAuthenticatedAccount('fediverse');
    if (closed || !mastoAuth || typeof globalThis.WebSocket !== 'function') return;
    try {
      const u = new URL(mastoAuth.meta.instanceUrl);
      const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
      const streamUrl = `${wsProto}//${u.host}/api/v1/streaming?stream=user&access_token=${encodeURIComponent(mastoAuth.secrets.accessToken)}`;
      ws = new globalThis.WebSocket(streamUrl);
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data || '{}');
          if ((msg.event === 'update' || msg.event === 'status.update') && msg.payload) {
            const payload = typeof msg.payload === 'string' ? JSON.parse(msg.payload) : msg.payload;
            // Lightweight raw normalization via dynamic import fallback
            if (payload?.id) onUpdate?.(toUnifiedItem({ network: 'fediverse', instanceUrl: mastoAuth.meta.instanceUrl, ...payload, id: String(payload.id), contentHtml: payload.content || '', createdAt: payload.created_at || '', author: payload.account || {} }));
          } else if (msg.event === 'delete' && msg.payload) {
            onDelete?.(`mastodon:${msg.payload}`);
          }
        } catch {
          // ignore parse errors
        }
      };
    } catch {
      // ignore offline WS failures
    }
  })();

  return () => {
    closed = true;
    ws?.close?.();
  };
}

/**
 * Score feed items semantically against concept anchors using the Sanctuary node CPU embedding bridge.
 * Returns {} immediately when the Sanctuary node is offline/dormant.
 */
export async function fetchSemanticFeedScores({
  items = [],
  boostConcepts = [],
  dampenConcepts = [],
  positiveExamples = [],
  negativeExamples = [],
  includeAxes = false,
  timeoutMs = 4000,
} = {}) {
  const boost = Array.isArray(boostConcepts) ? boostConcepts : [];
  const dampen = Array.isArray(dampenConcepts) ? dampenConcepts : [];
  const posEx = Array.isArray(positiveExamples) ? positiveExamples.slice(0, 40) : [];
  const negEx = Array.isArray(negativeExamples) ? negativeExamples.slice(0, 25) : [];
  if (
    (!includeAxes && boost.length === 0 && dampen.length === 0 && posEx.length === 0 && negEx.length === 0) ||
    !Array.isArray(items) ||
    items.length === 0
  ) {
    return { scores: {}, axisScores: {}, tasteScores: {} };
  }
  const payloadItems = items
    .filter((it) => it && it.id && (it.content_text || it.text || it._meta?.linkCard?.title || it._meta?.quotePost?.text))
    .slice(0, 120)
    .map((it) => ({
      id: String(it.id),
      text: [
        it.content_text || it.text || '',
        it._meta?.mastodon?.spoilerText || it.spoilerText || '',
        it._meta?.linkCard?.title || '',
        it._meta?.linkCard?.description || '',
        it._meta?.quotePost?.text || '',
        ...(Array.isArray(it.attachments) ? it.attachments.map((a) => a?.alt_text || '').filter(Boolean) : []),
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 600),
    }));
  if (payloadItems.length === 0) return { scores: {}, axisScores: {}, tasteScores: {} };
  const res = await requestSocialBridge(
    '/feed/semantic-score',
    {
      items: payloadItems,
      boostConcepts: boost,
      dampenConcepts: dampen,
      positiveExamples: posEx,
      negativeExamples: negEx,
      includeAxes: Boolean(includeAxes),
    },
    { timeoutMs }
  );
  if (!res?.available) {
    return { scores: {}, axisScores: {}, tasteScores: {} };
  }
  return {
    scores: typeof res.scores === 'object' && res.scores ? res.scores : {},
    axisScores: typeof res.axisScores === 'object' && res.axisScores ? res.axisScores : {},
    tasteScores: typeof res.tasteScores === 'object' && res.tasteScores ? res.tasteScores : {},
  };
}

const postTranslationCache = new Map();

export function clearTranslationCacheForTests() {
  postTranslationCache.clear();
}

async function fetchDirectWebTranslation(text, sourceLang = 'auto', targetLang = 'en') {
  const cleanText = String(text || '').trim();
  if (!cleanText) return { text: '', detectedSourceLanguage: '' };
  const qs = new URLSearchParams({
    client: 'gtx',
    sl: sourceLang || 'auto',
    tl: targetLang || 'en',
    dt: 't',
    q: cleanText,
  });
  const data = await fetchWrapper(`https://translate.googleapis.com/translate_a/single?${qs.toString()}`, {
    timeoutMs: 7000,
  });
  if (!Array.isArray(data) || !Array.isArray(data[0])) {
    throw new Error('Translation response unavailable');
  }
  const translated = data[0].map((seg) => (Array.isArray(seg) ? String(seg[0] || '') : '')).join('').trim();
  if (!translated) {
    throw new Error('Empty translation returned');
  }
  const detected = String(typeof data[2] === 'string' ? data[2] : (sourceLang !== 'auto' ? sourceLang : '')).trim().toLowerCase();
  return { text: translated, detectedSourceLanguage: detected };
}

/**
 * Translate a non-English UnifiedItem via Mastodon native /translate, local Sanctuary LLM bridge, or HTTPS web translate.
 */
export async function translateUnifiedPost(rawPost, { targetLang = 'en', sourceLang = 'auto' } = {}) {
  const unified = toUnifiedItem(rawPost);
  const cleanTarget = String(targetLang || 'en').trim().toLowerCase() || 'en';
  const cleanSource = String(sourceLang || unified.language || 'auto').trim().toLowerCase() || 'auto';
  const text = String(unified.content_text || '').trim();
  const mMeta = unified._meta?.mastodon || {};
  const spoilerText = String(mMeta.spoilerText || '').trim();
  const statusId = String(mMeta.statusId || '').trim();
  const instanceUrl = String(mMeta.instanceUrl || 'https://mastodon.social').trim();
  const cacheKey = `${unified.id || text.slice(0, 120)}::${cleanTarget}`;

  if (postTranslationCache.has(cacheKey)) {
    return postTranslationCache.get(cacheKey);
  }
  if (!text && !spoilerText && !statusId) {
    throw new Error('No translatable text on post');
  }

  if (unified.protocol === 'mastodon' && statusId) {
    try {
      const fediAuth = await getAuthenticatedAccount('fediverse');
      const authOrigin = fediAuth?.meta?.instanceUrl ? normalizeInstanceUrl(fediAuth.meta.instanceUrl) : '';
      const targetOrigin = normalizeInstanceUrl(instanceUrl);
      const token = authOrigin && authOrigin === targetOrigin ? (fediAuth?.secrets?.accessToken || '') : '';
      const nativeRes = await translateMastodonStatus({
        instanceUrl: targetOrigin,
        accessToken: token,
        statusId,
        lang: cleanTarget,
      });
      if (nativeRes?.text || nativeRes?.html) {
        postTranslationCache.set(cacheKey, nativeRes);
        return nativeRes;
      }
    } catch {
      // Fall through to local LLM bridge or stateless web translate
    }
  }

  const bridgeRes = await requestSocialBridge('/translate', {
    text,
    spoilerText,
    sourceLang: cleanSource,
    targetLang: cleanTarget,
  });
  if (bridgeRes?.text) {
    const result = {
      ...bridgeRes,
      html: sanitizeFediverseHtmlToString(plainTextToHtml(bridgeRes.text), []),
    };
    postTranslationCache.set(cacheKey, result);
    return result;
  }

  const mainRes = text
    ? await fetchDirectWebTranslation(text, cleanSource, cleanTarget)
    : { text: '', detectedSourceLanguage: cleanSource !== 'auto' ? cleanSource : '' };
  let translatedSpoiler = '';
  let detectedLang = mainRes.detectedSourceLanguage;
  if (spoilerText) {
    const spRes = await fetchDirectWebTranslation(spoilerText, detectedLang || cleanSource, cleanTarget).catch(() => null);
    if (spRes?.text) {
      translatedSpoiler = spRes.text;
      if (!detectedLang && spRes.detectedSourceLanguage) {
        detectedLang = spRes.detectedSourceLanguage;
      }
    }
  }

  const result = {
    text: mainRes.text,
    html: sanitizeFediverseHtmlToString(plainTextToHtml(mainRes.text), []),
    spoilerText: translatedSpoiler,
    detectedSourceLanguage: detectedLang,
    provider: 'Web Translate',
  };
  postTranslationCache.set(cacheKey, result);
  return result;
}
