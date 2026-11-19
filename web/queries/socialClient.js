import { BlueskyAdapter } from '../adapters/bluesky/index.js';
import { MastodonAdapter } from '../adapters/mastodon/index.js';
import { ThreadsAdapter } from '../adapters/threads/index.js';
import { DEFAULT_THREADS_SCOPES, PUBLIC_BSKY_API, isAllowedSocialUrl, normalizeInstanceUrl } from '../constants/endpoints.js';
import { canonicalizeActorHandle, deduplicateUnifiedItems, plainTextToHtml, toUnifiedItem } from '../core/schema/unifiedItem.js';
import { extractFirstHttpsUrl, fetchLinkPreview } from './linkPreview.js';
import {
  buildThreadsAuthorizeUrl,
  exchangeThreadsLongLivedToken,
  exchangeThreadsOAuthCode,
  getThreadsPostInsights,
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
  getBskyPostThread,
  getBskyPostsMetrics,
  getBskyProfile,
  muteBskyActor,
  normalizeBskyActorProfile,
  normalizeBskyActorSummary,
  searchBskyActors,
  searchBskyPosts,
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
  getStatusContext,
  getUserLists,
  lookupAccountByAcct,
  muteAccount,
  removeAccountsFromList,
  removeFollower,
  respondFollowRequest,
  searchFediverse,
  updateCredentials,
} from './fediverse.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens, upsertSocialAccount } from '../state/authStore.js';
import { feedStore, hydrateCachedModeration, persistCachedFilters, setFilterRules, setModeratedActors } from '../state/feedStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { syncMastodonUserProfileToSanctuary } from './sanctuary.js';
import {
  deleteLocalFilterRule,
  deleteLocalLinkedChildren,
  deleteLocalLinkedPost,
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
  saveLocalLinkedPost,
} from '../storage/nativeStore.js';

function isNodeTestEnvironment() {
  return typeof globalThis.process?.versions?.node === 'string' && !globalThis.__SANCTUARY_FORCE_HTTP_STORE__;
}

function getSocialBackendOrigin() {
  if (globalThis.Capacitor?.Plugins?.SanctuaryNativeStore) return '';
  if (isNodeTestEnvironment()) return '';
  const loc = globalThis.location;
  if (!loc || !loc.origin || loc.origin === 'null') return '';
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return '';
  return loc.origin.replace(/\/+$/, '');
}

let backendAvailable = null;

async function callBackendSocial(path, { method = 'GET', json, body } = {}) {
  const origin = getSocialBackendOrigin();
  if (!origin || backendAvailable === false) return { used: false };
  try {
    const res = await fetch(`${origin}/api/social${path}`, {
      method,
      headers: json !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    if (res.status === 502 || res.status === 503) {
      backendAvailable = false;
      return { used: false };
    }
    if (res.status === 404) {
      return { used: false, status: 404 };
    }
    backendAvailable = true;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data?.error || `Social host error (${res.status})`);
    }
    return { used: true, data };
  } catch (err) {
    if (backendAvailable === true) throw err;
    backendAvailable = false;
    return { used: false };
  }
}

async function callBackendSocialOptional(path, opts = {}, swallowErrors = false) {
  try {
    return await callBackendSocial(path, opts);
  } catch (err) {
    if (swallowErrors) return { used: false, error: err };
    throw err;
  }
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

  const slimItems = items.map((item) => ({
    id: item?.id || '',
    protocol: item?.protocol || 'mastodon',
    metrics: item?.metrics || { likes: 0, replies: 0, reposts: 0 },
    _meta: {
      ...(item?._meta?.mastodon ? { mastodon: item._meta.mastodon } : {}),
      ...(item?._meta?.bluesky ? { bluesky: item._meta.bluesky } : {}),
      ...(item?._meta?.threads ? { threads: item._meta.threads } : {}),
      ...(item?._meta?.linkedIds ? { linkedIds: item._meta.linkedIds } : {}),
      ...(item?._meta?.metricsBreakdown ? { metricsBreakdown: item._meta.metricsBreakdown } : {}),
    },
  }));

  const backend = await callBackendSocialOptional(
    '/posts/enrich-metrics',
    { method: 'POST', json: { items: slimItems } },
    true
  );
  if (backend.used && Array.isArray(backend.data?.items)) {
    const byId = new Map();
    for (const row of backend.data.items) {
      if (row?.id) byId.set(String(row.id), row);
    }
    return items.map((orig, idx) => {
      const updated = (orig?.id && byId.get(String(orig.id))) || backend.data.items[idx];
      if (!updated || typeof updated !== 'object') return orig;
      return {
        ...orig,
        metrics: updated.metrics || orig.metrics,
        _meta: {
          ...(orig._meta || {}),
          ...(updated._meta?.linkedIds ? { linkedIds: updated._meta.linkedIds } : {}),
          ...(updated._meta?.metricsBreakdown ? { metricsBreakdown: updated._meta.metricsBreakdown } : {}),
        },
      };
    });
  }

  const storedByKey = new Map();
  await Promise.all(
    items.map(async (item) => {
      const key = getItemLinkKey(item);
      if (!key) return;
      let stored = await findLocalLinkedPost(key);
      if (!stored && item?._meta?.mastodon?.statusId && key !== `mastodon:${item._meta.mastodon.statusId}`) {
        stored = await findLocalLinkedPost(`mastodon:${item._meta.mastodon.statusId}`);
      }
      if (stored) storedByKey.set(key, stored);
    })
  );

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
    }).catch(() => ({}));
  }

  const threadsMetrics = {};
  const threadsToken = threadsAuth?.secrets?.accessToken || '';
  if (threadsIds.size > 0 && threadsToken) {
    const tids = [...threadsIds].slice(0, 25);
    await Promise.allSettled(
      tids.map(async (pid) => {
        const res = await getThreadsPostInsights({ postId: pid, accessToken: threadsToken }).catch(() => null);
        if (res && typeof res === 'object') {
          threadsMetrics[pid] = {
            likes: Number(res.likes || 0),
            replies: Number(res.replies || 0),
            reposts: Number(res.reposts || 0),
          };
        }
      })
    );
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
    if (link.blueskyUri && bskyMetrics[link.blueskyUri]) {
      breakdown.bluesky = { ...bskyMetrics[link.blueskyUri] };
    }
    if (link.threadsPostId && threadsMetrics[link.threadsPostId]) {
      breakdown.threads = { ...threadsMetrics[link.threadsPostId] };
    }

    const keys = Object.keys(breakdown);
    const total = { likes: 0, replies: 0, reposts: 0 };
    for (const m of Object.values(breakdown)) {
      total.likes += Number(m.likes || 0);
      total.replies += Number(m.replies || 0);
      total.reposts += Number(m.reposts || 0);
    }

    return {
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

async function syncThreadsAccountFromStatus(statusData) {
  if (Array.isArray(statusData?.retryQueue)) {
    authStore.set({ retryQueue: statusData.retryQueue });
  }
  const accounts = Array.isArray(statusData?.accounts) ? statusData.accounts : [];
  const rawThreads = accounts.find((a) => a?.protocol === 'threads');
  if (!rawThreads?.id) return null;
  const uid = String(rawThreads.meta?.userId || rawThreads.id.replace(/^threads:/, ''));
  return upsertSocialAccount({
    id: rawThreads.id,
    platform: 'threads',
    userId: uid,
    handle: rawThreads.handle || '',
    acct: rawThreads.handle || '',
    displayName: rawThreads.displayName || rawThreads.handle || '',
    avatar: rawThreads.avatarUrl || rawThreads.avatar || '',
    noteText: rawThreads.meta?.noteText || '',
    isVerified: Boolean(rawThreads.meta?.isVerified),
    expiresAt: Number(rawThreads.meta?.expiresAt || 0),
  });
}

export async function connectThreadsToken({ accessToken, clientSecret = '', expiresIn = 0 } = {}) {
  const cleanTok = String(accessToken || '').trim();
  if (!cleanTok) throw new Error('Threads access token is required.');

  const backend = await callBackendSocial('/accounts/connect', {
    method: 'POST',
    json: { protocol: 'threads', accessToken: cleanTok, clientSecret, expiresIn },
  });
  if (backend.used) {
    await syncThreadsAccountFromStatus(backend.data);
    return backend.data;
  }

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
  const backend = await callBackendSocial('/oauth/threads/start', {
    method: 'POST',
    json: { clientId: cid, clientSecret: csec, redirectUri: ruri, scope, state },
  });
  if (backend.used) return backend.data;
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
  const backend = await callBackendSocial('/oauth/threads/callback', {
    method: 'POST',
    json: { code, redirectUri, clientId, clientSecret },
  });
  if (backend.used) {
    await syncThreadsAccountFromStatus(backend.data);
    return backend.data;
  }
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
  const backend = await callBackendSocial('/oauth/threads/refresh', { method: 'POST' });
  if (backend.used) {
    await syncThreadsAccountFromStatus(backend.data?.status);
    return backend.data;
  }
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

async function publishBskySegments({ bsky, textParts, media = [], resolvedCard = null }) {
  const rawMedia = Array.isArray(media) ? media : [];
  const chunks = (Array.isArray(textParts) ? textParts : []).flatMap((p) => splitTextClean(p, 300));
  if (chunks.length === 0 && rawMedia.length > 0) chunks.push('');
  const refs = [];
  const publishedItems = [];
  let rootRef = null;
  let parentRef = null;
  for (let i = 0; i < chunks.length; i += 1) {
    const res = await bsky.publish(chunks[i], i === 0 ? rawMedia : [], {
      reply: parentRef ? { root: rootRef, parent: parentRef } : null,
      ...(i === 0 && rawMedia.length === 0 && resolvedCard ? { externalEmbed: resolvedCard } : {}),
    });
    publishedItems.push(res);
    const ref = { uri: res._meta?.bluesky?.uri || '', cid: res._meta?.bluesky?.cid || '' };
    refs.push(ref);
    if (i === 0) rootRef = ref;
    parentRef = ref;
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
}) {
  const rawMedia = Array.isArray(media) ? media : [];
  const chunks = (Array.isArray(textParts) ? textParts : []).flatMap((p) => splitTextClean(p, 500));
  if (chunks.length === 0 && (rawMedia.length > 0 || uploadedUrls.length > 0)) chunks.push('');
  const ids = [];
  const publishedItems = [];
  let parentTid = '';
  for (let i = 0; i < chunks.length; i += 1) {
    const res = await threads.publish(chunks[i], i === 0 ? rawMedia : [], {
      ...(i === 0 && uploadedUrls.length > 0 ? { mastodonMediaUrls: uploadedUrls } : {}),
      publicMediaBaseUrl: authStore.get().publicMediaBaseUrl || '',
      replyToId: parentTid,
      replyControl: !parentTid && visibility === 'private' ? 'accounts_you_follow' : '',
      ...(i === 0 && rawMedia.length === 0 && uploadedUrls.length === 0 && resolvedCard?.url
        ? { linkAttachment: resolvedCard.url }
        : {}),
    });
    publishedItems.push(res);
    const pid = res._meta?.threads?.postId || '';
    ids.push(pid);
    parentTid = pid;
  }
  return { protocol: 'threads', ids, items: publishedItems };
}

/**
 * Automatic outbound fan-out: Mastodon primary + concurrent non-blocking Promise.allSettled
 * fan-out to Bluesky and Threads with retry queuing and linkedIds SQLite mapping.
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

  if (mediaAttachments.length === 0) {
    const backend = await callBackendSocial('/posts', {
      method: 'POST',
      json: {
        text: cleanText,
        thread_items: extraParts,
        visibility,
        spoiler_text: spoilerText,
        language,
        ...(linkCard?.url && !dismissLinkCard ? { linkCard } : {}),
        ...(dismissLinkCard ? { dismissLinkCard: true } : {}),
      },
    });
    if (backend.used) {
      const items = backend.data.items || backend.data.results || [];
      authStore.set({ retryQueue: backend.data.retryQueue || [] });
      return { ...backend.data, items, results: items };
    }
  } else if (
    typeof globalThis.FormData === 'function'
    && mediaAttachments.every((att) => att?.blob || att?.file)
  ) {
    const form = new globalThis.FormData();
    form.append('text', cleanText);
    form.append('visibility', visibility);
    form.append('spoiler_text', spoilerText);
    form.append('language', language);
    form.append('thread_items', JSON.stringify(extraParts));
    form.append(
      'alt_texts',
      JSON.stringify(mediaAttachments.map((att) => String(att.altText || att.alt_text || '')))
    );
    mediaAttachments.forEach((att, idx) => {
      const fileObj = att.blob || att.file;
      if (fileObj) {
        form.append('media', fileObj, att.name || fileObj.name || `upload_${idx}.png`);
      }
    });
    const backend = await callBackendSocial('/posts', {
      method: 'POST',
      body: form,
    });
    if (backend.used) {
      const items = backend.data.items || backend.data.results || [];
      authStore.set({ retryQueue: backend.data.retryQueue || [] });
      return { ...backend.data, items, results: items };
    }
  }

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
      const errMsg = s.reason?.message || 'Bridge publish failed';
      warnings.push(`${proto}: ${errMsg}`);
      await enqueueLocalRetry({
        id: `retry_${proto}_${Date.now()}`,
        operation: 'publish',
        protocol: proto,
        payload: {
          canonicalId: rootCanonical,
          mastodonStatusId: rootMastoId,
          textParts: rawParts,
          mastodonMediaUrls: uploadedUrls,
        },
        lastError: errMsg,
      });
    }
  }

  for (let i = 0; i < mastoResults.length; i += 1) {
    const m = mastoResults[i];
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
  const backend = await callBackendSocial('/posts/reply', {
    method: 'POST',
    json: { targetItem, text, visibility },
  });
  if (backend.used && mediaAttachments.length === 0) return backend.data.item;

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
  const backend = await callBackendSocial(`/posts/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
  if (backend.used) {
    if (Array.isArray(backend.data?.retryQueue)) {
      authStore.set({ retryQueue: backend.data.retryQueue });
    }
    return backend.data;
  }

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

export async function editUnified(statusId, draft, spoilerText = '', { replaceBridges = false } = {}) {
  const cleanId = String(statusId || '').replace(/^mastodon:/, '');
  const backend = await callBackendSocial(`/posts/${encodeURIComponent(cleanId)}`, {
    method: 'PUT',
    json: { text: draft, spoiler_text: spoilerText, replace_bridges: Boolean(replaceBridges) },
  });
  if (backend.used) {
    const item = backend.data.item;
    const warnings = Array.isArray(backend.data.warnings)
      ? backend.data.warnings
      : (Array.isArray(item?._meta?.bridgeWarnings) ? item._meta.bridgeWarnings : []);
    if (item && warnings.length > 0) {
      item._bridgeWarnings = warnings;
    }
    return item;
  }

  const { masto, bsky, threads } = await getClientAdapters();
  if (!masto) throw new Error('Connect Mastodon to edit posts.');
  const updated = await masto.edit(cleanId, draft, spoilerText);

  const canonId = updated.id || `mastodon:${cleanId}`;
  const group = await findLocalLinkedPostGroup(canonId);
  const rootLink = group[0] || (await findLocalLinkedPost(`mastodon:${cleanId}`)) || null;
  const warnings = [];
  const visibility = String(updated._meta?.mastodon?.visibility || 'public').toLowerCase();

  let bskyUri = rootLink?.blueskyUri || '';
  let bskyCid = rootLink?.blueskyCid || '';
  let threadsPostId = rootLink?.threadsPostId || '';

  if (replaceBridges && visibility !== 'direct') {
    const oldBskyUris = [...new Set(group.map((g) => g.blueskyUri).filter(Boolean))];
    if (bskyUri && !oldBskyUris.includes(bskyUri)) oldBskyUris.unshift(bskyUri);
    const oldBskyCid = bskyCid;
    const oldThreadsIds = [...new Set(group.map((g) => g.threadsPostId).filter(Boolean))];
    if (threadsPostId && !oldThreadsIds.includes(threadsPostId)) oldThreadsIds.unshift(threadsPostId);

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

    let newBskyRefs = [];
    if (bsky) {
      const undeletedBsky = [];
      for (const uri of oldBskyUris) {
        try {
          await bsky.delete({ uri });
        } catch (err) {
          undeletedBsky.push(uri);
          const msg = `Bluesky: ${err?.message || 'Delete failed'}`;
          if (!warnings.includes(msg)) warnings.push(msg);
        }
      }
      if (undeletedBsky.length > 0) {
        bskyUri = undeletedBsky[0];
        bskyCid = bskyUri === oldBskyUris[0] ? oldBskyCid : '';
      } else {
        bskyUri = '';
        bskyCid = '';
        const bskyMedia = [];
        for (const att of attachments.slice(0, 4)) {
          const mime = String(att?.mime_type || att?.mimeType || '');
          if (att?.url && mime.startsWith('image/') && isAllowedSocialUrl(att.url)) {
            try {
              const res = await fetch(att.url);
              const ctype = String(res.headers?.get?.('content-type') || mime).toLowerCase();
              if (res.ok && ctype.startsWith('image/')) {
                const blob = await res.blob();
                if (blob && blob.size > 0) {
                  bskyMedia.push({ blob, mimeType: blob.type || mime, altText: att.alt_text || att.altText || '' });
                }
              }
            } catch {
              // Skip unreachable image bytes and still republish edited text
            }
          }
        }
        try {
          const bRes = await publishBskySegments({
            bsky,
            textParts: [draft],
            media: bskyMedia,
            resolvedCard: attachments.length === 0 ? resolvedCard : null,
          });
          newBskyRefs = bRes.refs || [];
          if (newBskyRefs[0]?.uri) {
            bskyUri = newBskyRefs[0].uri;
            bskyCid = newBskyRefs[0].cid || '';
          }
        } catch (err) {
          warnings.push(`Bluesky: ${err?.message || 'Republish failed'}`);
        }
      }
    }

    let newThreadsIds = [];
    if (threads) {
      const undeletedThreads = [];
      for (const tid of oldThreadsIds) {
        try {
          await threads.delete({ postId: tid });
        } catch (err) {
          undeletedThreads.push(tid);
          const msg = `Threads: ${err?.message || 'Delete failed'}`;
          if (!warnings.includes(msg)) warnings.push(msg);
        }
      }
      if (undeletedThreads.length > 0) {
        threadsPostId = undeletedThreads[0];
      } else {
        threadsPostId = '';
        try {
          const tRes = await publishThreadsSegments({
            threads,
            textParts: [draft],
            media: threadsMedia,
            uploadedUrls: mastoMediaUrls,
            resolvedCard: attachments.length === 0 ? resolvedCard : null,
            visibility,
          });
          newThreadsIds = tRes.ids || [];
          if (newThreadsIds[0]) {
            threadsPostId = newThreadsIds[0];
          }
        } catch (err) {
          warnings.push(`Threads: ${err?.message || 'Republish failed'}`);
        }
      }
    }

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
      const extraMax = Math.max(newBskyRefs.length, newThreadsIds.length);
      for (let extraIdx = 1; extraIdx < extraMax; extraIdx += 1) {
        const bRef = newBskyRefs[extraIdx] || {};
        const tId = newThreadsIds[extraIdx] || '';
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
  const backend = await callBackendSocial('/posts/pin', {
    method: 'POST',
    json: { statusId: sid, targetItem: item, undo: unpin },
  });
  if (backend.used) return backend.data.item;

  const { masto } = await getClientAdapters();
  if (!masto) throw new Error('Connect Mastodon to pin posts.');
  return masto.pin(sid, unpin);
}

export async function likeUnified(targetItem, unlike = undefined) {
  const item = toUnifiedItem(targetItem);
  const currentlyLiked = Boolean(item._meta?.mastodon?.favourited || item._meta?.bluesky?.likeUri);
  const undo = unlike !== undefined ? Boolean(unlike) : currentlyLiked;
  const backend = await callBackendSocial('/posts/like', {
    method: 'POST',
    json: { targetItem: item, undo },
  });
  if (backend.used) return backend.data.item;

  const { masto, bsky } = await getClientAdapters();
  if (item.protocol === 'bluesky') {
    if (!bsky) throw new Error('Connect Bluesky bridge to like Bluesky posts.');
    return bsky.like(item, undo);
  }
  if (!masto) throw new Error('Connect Mastodon to favourite posts.');
  return masto.like(item, undo);
}

export async function repostUnified(targetItem, unrepost = undefined) {
  const item = toUnifiedItem(targetItem);
  const currentlyReposted = Boolean(item._meta?.mastodon?.reblogged || item._meta?.bluesky?.repostUri);
  const undo = unrepost !== undefined ? Boolean(unrepost) : currentlyReposted;
  const backend = await callBackendSocial('/posts/repost', {
    method: 'POST',
    json: { targetItem: item, undo },
  });
  if (backend.used) return backend.data.item;

  const { masto, bsky } = await getClientAdapters();
  if (item.protocol === 'bluesky') {
    if (!bsky) throw new Error('Connect Bluesky bridge to repost Bluesky posts.');
    return bsky.repost(item, undo);
  }
  if (!masto) throw new Error('Connect Mastodon to boost posts.');
  return masto.repost(item, undo);
}

const ACTIVITY_DISMISSED_KV_KEY = 'activity_dismissed_v1';

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

export async function fetchUnifiedNotifications({ limit = 35 } = {}) {
  const backend = await callBackendSocial(`/notifications?limit=${limit}`);
  if (backend.used) return backend.data;

  const { masto, bsky, threads, threadsAuth } = await getClientAdapters();
  const linkedRows = await listLocalLinkedPosts(40).catch(() => []);
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

  const tasks = [];
  if (masto) tasks.push(masto.fetchNotifications('', limit));
  if (bsky) tasks.push(bsky.fetchNotifications('', limit));
  if (threads) tasks.push(threads.fetchNotifications('', 12, { trackedPostIds }));

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
    await Promise.allSettled(
      [...new Set(trackedPostIds)].slice(0, 12).map(async (tid) => {
        const ins = await getThreadsPostInsights({ postId: tid, accessToken: threadsToken }).catch(() => null);
        if (ins && typeof ins === 'object') {
          threadsInsights[String(tid)] = ins;
        }
      })
    );
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

  const filtered = collected.filter(
    (it) => !isNotificationLocallyDismissed(it, dismissedSet, dismissedState.clearedBeforeMs)
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

  const backend = await callBackendSocial('/notifications/dismiss', {
    method: 'POST',
    json: { ids: cleanIds, mastodonNotifIds, threadsWatermarks },
  });
  if (backend.used) return backend.data;

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

  const backend = await callBackendSocial('/notifications/clear', {
    method: 'POST',
    json: { threadsWatermarks },
  });
  if (backend.used) return backend.data;

  const { masto, bsky } = await getClientAdapters();
  const ops = [];
  if (masto) ops.push(masto.clearNotifications().catch(() => {}));
  if (bsky) ops.push(bsky.updateNotificationsSeen().catch(() => {}));
  await Promise.allSettled(ops);
  return { cleared: true, clearedBeforeMs: now };
}

export async function markUnifiedNotificationsSeen() {
  const backend = await callBackendSocial('/notifications/seen', {
    method: 'POST',
    json: { seenTs: Date.now() / 1000 },
  });
  if (backend.used) return backend.data;

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
      followersCount: prof.followersCount,
      followingCount: prof.followingCount,
      statusesCount: prof.statusesCount,
      did: prof.did || repo,
    });
  }
  return { synced: true, profile: prof || null };
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

export async function fetchOwnStatuses(
  accountId,
  { tab = 'posts', instanceUrl = 'https://mastodon.social', maxId = '', protocol = 'mastodon', acct = '', federatedMastodonId = '' } = {}
) {
  const isThreads = protocol === 'threads' || String(accountId || '').startsWith('threads:') || String(instanceUrl || '').includes('threads.net');
  const isBsky = !isThreads && (protocol === 'bluesky' || String(accountId || '').startsWith('did:'));
  const protoKey = isThreads ? 'threads' : (isBsky ? 'bluesky' : 'mastodon');
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId || acct)}/statuses?tab=${encodeURIComponent(tab)}&instanceUrl=${encodeURIComponent(instanceUrl)}&max_id=${encodeURIComponent(maxId)}&protocol=${encodeURIComponent(protoKey)}&acct=${encodeURIComponent(acct)}${federatedMastodonId ? `&federatedMastodonId=${encodeURIComponent(federatedMastodonId)}` : ''}`,
    {},
    isBsky || isThreads
  );
  if (backend.used) return backend.data.items || [];

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
      return enrichUnifiedItemsMetrics(own);
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
        onlyMedia: tab === 'media',
        pinned: tab === 'pinned',
        maxId,
      });
      return enrichUnifiedItemsMetrics(rows.map((r) => toUnifiedItem(r)));
    }
    return [];
  }

  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    const filter = tab === 'media' ? 'posts_with_media' : (tab === 'replies' ? 'posts_with_replies' : 'posts_no_replies');
    const res = await getBskyAuthorFeed({
      actor: accountId || acct,
      cursor: maxId,
      filter,
      ...getBskyReadOpts(bskyAuth),
    });
    return (res.items || []).map((r) => toUnifiedItem(r));
  }

  const { targetId, targetOrigin, token } = await resolveMastoClientTarget(accountId, instanceUrl, acct);
  const rows = await getAccountStatuses({
    instanceUrl: targetOrigin,
    accessToken: token,
    accountId: targetId,
    excludeReplies: tab === 'posts',
    onlyMedia: tab === 'media',
    pinned: tab === 'pinned',
    maxId,
  });
  return enrichUnifiedItemsMetrics(rows.map((r) => toUnifiedItem(r)));
}

export async function fetchLists() {
  const backend = await callBackendSocial('/lists');
  if (backend.used) return backend.data.lists || [];
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return getUserLists({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken });
}

export async function createMastodonList(title, repliesPolicy = 'list') {
  const backend = await callBackendSocial('/lists', {
    method: 'POST',
    json: { title, replies_policy: repliesPolicy },
  });
  if (backend.used) return backend.data.list;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return createUserList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, title, repliesPolicy });
}

export async function deleteMastodonList(listId) {
  const backend = await callBackendSocial(`/lists/${encodeURIComponent(listId)}`, { method: 'DELETE' });
  if (backend.used) return true;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return deleteUserList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId });
}

/**
 * Normalize backend snake_case or client camelCase account metadata into one uniform shape.
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
  const backend = await callBackendSocial(`/lists/${encodeURIComponent(listId)}/accounts`);
  if (backend.used) return (backend.data.accounts || []).map(normalizeAccountRecord);
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return getListAccounts({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId });
}

export async function addAccountToMastodonList(listId, accountId) {
  const backend = await callBackendSocial(`/lists/${encodeURIComponent(listId)}/accounts`, {
    method: 'POST',
    json: { account_ids: [accountId] },
  });
  if (backend.used) return true;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return addAccountsToList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId, accountIds: [accountId] });
}

export async function removeAccountFromMastodonList(listId, accountId) {
  const backend = await callBackendSocial(`/lists/${encodeURIComponent(listId)}/accounts`, {
    method: 'DELETE',
    json: { account_ids: [accountId] },
  });
  if (backend.used) return true;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return removeAccountsFromList({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, listId, accountIds: [accountId] });
}

function normalizeFilterRuleRecord(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const kws = Array.isArray(rule.keywords)
    ? rule.keywords.map((k) => String(typeof k === 'string' ? k : k?.keyword || '').trim()).filter(Boolean)
    : [];
  const phrase = String(rule.phrase || kws[0] || rule.title || '').trim();
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
  const backend = await callBackendSocial('/filters');
  if (backend.used) return syncStoreFilters(backend.data.filters || []);
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return syncStoreFilters(await listLocalFilterRules());
  const rules = await getFilters({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken });
  return syncStoreFilters(rules);
}

export async function addKeywordFilter({ title, phrase, filterAction = 'hide' }) {
  const backend = await callBackendSocial('/filters', {
    method: 'POST',
    json: { title: title || phrase, phrase, filter_action: filterAction },
  });
  let created;
  if (backend.used) {
    created = backend.data.filter;
  } else {
    const { mastoAuth } = await getClientAdapters();
    if (!mastoAuth) {
      created = { id: `local_${Date.now()}`, title: title || phrase, phrase, filter_action: filterAction };
      await saveLocalFilterRule(created);
    } else {
      created = await createFilterRule({
        instanceUrl: mastoAuth.meta.instanceUrl,
        accessToken: mastoAuth.secrets.accessToken,
        title: title || phrase,
        phrase,
        filterAction,
      });
    }
  }
  const norm = normalizeFilterRuleRecord({
    ...created,
    phrase: created?.phrase || phrase,
    title: created?.title || title || phrase,
    filter_action: created?.filter_action || filterAction,
  });
  if (norm) {
    const next = [...(feedStore.get().filters || []).filter((f) => String(f.id) !== String(norm.id)), norm];
    syncStoreFilters(next);
  }
  return norm || created;
}

export async function removeKeywordFilter(filterId) {
  const backend = await callBackendSocial(`/filters/${encodeURIComponent(filterId)}`, { method: 'DELETE' });
  if (!backend.used) {
    const { mastoAuth } = await getClientAdapters();
    if (!mastoAuth || String(filterId).startsWith('local_')) {
      await deleteLocalFilterRule(filterId);
    } else {
      await deleteFilterRule({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, filterId });
    }
  }
  const next = (feedStore.get().filters || []).filter((f) => String(f.id) !== String(filterId));
  syncStoreFilters(next);
  return true;
}

export async function fetchModerationAccounts(kind = 'mutes') {
  if (kind !== 'mutes' && kind !== 'blocks') return [];
  const [backend, { mastoAuth, bskyAuth }, localMod] = await Promise.all([
    callBackendSocialOptional(`/moderation/${kind}`, {}, true),
    getClientAdapters(),
    getLocalModeratedAccounts().catch(() => ({ blocks: [], mutes: [] })),
  ]);

  const backendAccounts = backend?.used && Array.isArray(backend.data?.accounts)
    ? backend.data.accounts.map((a) => ({
        ...normalizeAccountRecord(a),
        localModeration: Boolean(a?.localModeration),
      }))
    : [];
  const hasBackendMasto = backendAccounts.some((a) => a.protocol === 'mastodon');
  const hasBackendBsky = backendAccounts.some((a) => a.protocol === 'bluesky');

  const tasks = [];
  if (mastoAuth?.secrets?.accessToken && !hasBackendMasto) {
    tasks.push(
      (kind === 'blocks'
        ? getBlocks({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken })
        : getMutes({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken })
      )
        .then((list) => (list || []).map((a) => normalizeAccountRecord({ ...a, protocol: 'mastodon' })))
        .catch(() => [])
    );
  }
  if (bskyAuth?.secrets?.accessJwt && !hasBackendBsky) {
    const bskyOpts = getBskyGraphAuth(bskyAuth);
    tasks.push(
      (kind === 'blocks' ? getBskyBlocks(bskyOpts) : getBskyMutes(bskyOpts))
        .then((res) => (res?.accounts || []).map(normalizeAccountRecord))
        .catch(() => [])
    );
  }

  const localEntries = !backend?.used
    ? (localMod[kind] || []).map((row) => ({
        ...normalizeAccountRecord({
          id: row.canonicalActor || `${row.protocol || 'threads'}:${row.username}`,
          protocol: row.protocol || 'threads',
          network: row.protocol || 'threads',
          username: row.username,
          acct: row.acct || `${row.username}@threads.net`,
          displayName: row.displayName || row.username,
          localModeration: true,
        }),
        localModeration: true,
      }))
    : [];

  const extra = tasks.length > 0 ? (await Promise.all(tasks)).flat() : [];
  const seen = new Set();
  const out = [];
  for (const acc of [...backendAccounts, ...extra, ...localEntries]) {
    if (!acc?.id) continue;
    const key = canonicalizeActorHandle(acc.acct || acc.username || acc.id, acc.protocol || 'mastodon') || `${acc.protocol || 'mastodon'}:${acc.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(acc);
  }
  return out;
}

export async function removeModeratedAccount(kind, account) {
  if (kind !== 'mutes' && kind !== 'blocks') return { ok: false };
  const targetId = String(account?.id || account?.canonicalActor || account?.username || account?.acct || '');
  await callBackendSocialOptional(
    `/moderation/${kind}/${encodeURIComponent(targetId)}`,
    { method: 'DELETE' },
    true
  );
  await removeLocalModeratedAccount(kind, targetId).catch(() => {});
  const curActors = feedStore.get().moderatedActors || [];
  const canon = canonicalizeActorHandle(account?.acct || account?.username || targetId, account?.protocol || 'threads');
  if (canon) {
    setModeratedActors(curActors.filter((a) => a !== canon));
  }
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
  const protoKey = isThreads ? 'threads' : (isBsky ? 'bluesky' : 'mastodon');
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId || acct)}/profile?instanceUrl=${encodeURIComponent(instanceUrl)}&protocol=${encodeURIComponent(protoKey)}&acct=${encodeURIComponent(acct)}`,
    {},
    isBsky || isThreads
  );
  if (backend.used) {
    return {
      ...backend.data,
      profile: backend.data.profile ? normalizeAccountRecord(backend.data.profile) : null,
    };
  }

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
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId)}/${unfollow ? 'unfollow' : 'follow'}`,
    {
      method: 'POST',
      json: { protocol: isBsky ? 'bluesky' : 'mastodon', followUri: opts?.followUri || null },
    },
    isBsky
  );
  if (backend.used) return backend.data;
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

export async function toggleMuteAuthor(accountId, unmute = false, opts = {}) {
  const isBsky = opts?.protocol === 'bluesky' || String(accountId || '').startsWith('did:');
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId)}/${unmute ? 'unmute' : 'mute'}`,
    {
      method: 'POST',
      json: { protocol: isBsky ? 'bluesky' : 'mastodon' },
    },
    isBsky
  );
  if (backend.used) return backend.data;
  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    if (!bskyAuth) throw new Error('Connect Bluesky bridge first.');
    return muteBskyActor({
      ...getBskyGraphAuth(bskyAuth),
      actor: accountId,
      unmute,
    });
  }
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return muteAccount({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, accountId, unmute });
}

export async function toggleBlockAuthor(accountId, unblock = false, opts = {}) {
  const isBsky = opts?.protocol === 'bluesky' || String(accountId || '').startsWith('did:');
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId)}/${unblock ? 'unblock' : 'block'}`,
    {
      method: 'POST',
      json: { protocol: isBsky ? 'bluesky' : 'mastodon', blockUri: opts?.blockUri || null },
    },
    isBsky
  );
  if (backend.used) return backend.data;
  if (isBsky) {
    const bskyAuth = await getAuthenticatedAccount('bluesky');
    if (!bskyAuth) throw new Error('Connect Bluesky bridge first.');
    return blockBskyActor({
      ...getBskyGraphAuth(bskyAuth),
      targetDid: accountId,
      blockUri: opts?.blockUri || null,
      unblock,
    });
  }
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return blockAccount({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, accountId, unblock });
}

export async function fetchFollowConnections(
  accountId,
  { kind = 'following', protocol = 'mastodon', instanceUrl = 'https://mastodon.social', acct = '', cursor = '' } = {}
) {
  const isBsky = protocol === 'bluesky' || String(accountId || '').startsWith('did:');
  const protoKey = isBsky ? 'bluesky' : 'mastodon';
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId || acct)}/connections?kind=${encodeURIComponent(kind)}&protocol=${encodeURIComponent(protoKey)}&instanceUrl=${encodeURIComponent(instanceUrl)}&acct=${encodeURIComponent(acct)}&cursor=${encodeURIComponent(cursor)}`,
    {},
    isBsky
  );
  if (backend.used) {
    return {
      accounts: (backend.data.accounts || []).map(normalizeAccountRecord),
      nextCursor: backend.data.next_cursor || null,
    };
  }

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

export async function fetchPostThread(rawPost) {
  const focal = toUnifiedItem(rawPost);
  if (focal.protocol === 'threads') {
    const postId = focal._meta?.threads?.postId || String(focal.id || '').replace(/^threads:(?:notif:)?/, '');
    if (!postId) return { focal, ancestors: [], descendants: [] };

    const backend = await callBackendSocialOptional(
      `/posts/${encodeURIComponent(postId)}/context?protocol=threads`,
      {},
      true
    );
    if (backend.used && backend.data) {
      return {
        focal: backend.data.status ? toUnifiedItem(backend.data.status) : focal,
        ancestors: Array.isArray(backend.data.ancestors) ? backend.data.ancestors.map((a) => toUnifiedItem(a)) : [],
        descendants: Array.isArray(backend.data.descendants)
          ? backend.data.descendants.map((d) => ({ item: toUnifiedItem(d), depth: Number(d?._threadDepth || 0) }))
          : [],
      };
    }

    const { threads } = await getClientAdapters();
    if (!threads) {
      throw new Error('Connect Threads bridge to load Threads replies.');
    }
    const res = await threads.getPostThread(focal);
    const focalItem = res?.status ? toUnifiedItem(res.status) : focal;
    const [enrichedFocal] = await enrichUnifiedItemsMetrics([focalItem]);
    return {
      focal: enrichedFocal || focalItem,
      ancestors: Array.isArray(res?.ancestors) ? res.ancestors.map((a) => toUnifiedItem(a)) : [],
      descendants: Array.isArray(res?.descendants)
        ? res.descendants.map((d) => ({ item: toUnifiedItem(d.item || d), depth: Number(d.depth ?? d?._threadDepth ?? 0) }))
        : [],
    };
  }

  if (focal.protocol === 'bluesky') {
    const uri = focal._meta?.bluesky?.uri || String(focal.id || '').replace(/^bluesky:/, '');
    if (!uri) return { focal, ancestors: [], descendants: [] };

    const backend = await callBackendSocialOptional(
      `/posts/${encodeURIComponent(uri)}/context?protocol=bluesky`,
      {},
      true
    );
    if (backend.used && backend.data) {
      return {
        focal: backend.data.status ? toUnifiedItem(backend.data.status) : focal,
        ancestors: Array.isArray(backend.data.ancestors) ? backend.data.ancestors.map((a) => toUnifiedItem(a)) : [],
        descendants: Array.isArray(backend.data.descendants)
          ? backend.data.descendants.map((d) => ({ item: toUnifiedItem(d), depth: Number(d?._threadDepth || 0) }))
          : [],
      };
    }

    const bskyAuth = await getAuthenticatedAccount('bluesky');
    const res = await getBskyPostThread({ ...getBskyReadOpts(bskyAuth), uri });
    const focalItem = res?.status ? toUnifiedItem(res.status) : focal;
    const [enrichedFocal] = await enrichUnifiedItemsMetrics([focalItem]);
    return {
      focal: enrichedFocal || focalItem,
      ancestors: Array.isArray(res?.ancestors) ? res.ancestors.map((a) => toUnifiedItem(a)) : [],
      descendants: Array.isArray(res?.descendants)
        ? res.descendants.map((d) => ({ item: toUnifiedItem(d.item || d), depth: Number(d.depth || 0) }))
        : [],
    };
  }

  if (focal.protocol === 'mastodon') {
    let statusId = focal._meta?.mastodon?.statusId || String(focal.id || '').replace(/^mastodon:/, '');
    if (!statusId) return { focal, ancestors: [], descendants: [] };

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
        statusId = searchRes.statuses[0].id;
        targetOrigin = homeOrigin;
        token = mastoAuth.secrets.accessToken || '';
      }
    }

    const ctx = await getStatusContext({ instanceUrl: targetOrigin, accessToken: token, statusId });
    const depthMap = new Map([[String(statusId), -1]]);
    const descendants = (Array.isArray(ctx?.descendants) ? ctx.descendants : []).map((d) => {
      const u = toUnifiedItem(d);
      const dSid = String(u._meta?.mastodon?.statusId || '');
      const parentSid = String(u._meta?.mastodon?.inReplyToId || '');
      const depth = depthMap.has(parentSid) ? Math.min(depthMap.get(parentSid) + 1, 3) : 0;
      if (dSid) depthMap.set(dSid, depth);
      return { item: u, depth };
    });

    const focalItem = ctx?.status ? toUnifiedItem(ctx.status) : focal;
    const [enrichedFocal] = await enrichUnifiedItemsMetrics([focalItem]);
    return {
      focal: enrichedFocal || focalItem,
      ancestors: Array.isArray(ctx?.ancestors) ? ctx.ancestors.map((a) => toUnifiedItem(a)) : [],
      descendants,
    };
  }

  return { focal, ancestors: [], descendants: [] };
}

export async function removeFollowerAccount(accountId) {
  const backend = await callBackendSocial(`/accounts/${encodeURIComponent(accountId)}/remove-follower`, {
    method: 'POST',
  });
  if (backend.used) return backend.data;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) throw new Error('Connect Mastodon first.');
  return removeFollower({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
    accountId,
  });
}

export async function fetchPendingFollowRequests() {
  const backend = await callBackendSocial('/accounts/self/connections?kind=requests');
  if (backend.used) {
    return (backend.data.accounts || []).map(normalizeAccountRecord);
  }
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return getFollowRequests({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
  });
}

export async function respondToFollowRequest(accountId, accept = true) {
  const backend = await callBackendSocial(`/follow-requests/${encodeURIComponent(accountId)}`, {
    method: 'POST',
    json: { accept: Boolean(accept) },
  });
  if (backend.used) return backend.data;
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
  const backend = await callBackendSocial(`/search?q=${encodeURIComponent(query)}`);
  let accounts = [];
  let statuses = [];
  let hashtags = [];

  if (backend.used) {
    accounts = (backend.data.accounts || []).map(normalizeAccountRecord);
    statuses = (backend.data.statuses || []).map((s) => toUnifiedItem(s));
    hashtags = backend.data.hashtags || [];
  } else {
    const { mastoAuth } = await getClientAdapters();
    const origin = mastoAuth?.meta?.instanceUrl || 'https://mastodon.social';
    const token = mastoAuth?.secrets?.accessToken || '';
    const res = await searchFediverse({ instanceUrl: origin, accessToken: token, query, resolve: Boolean(token) });
    accounts = res.accounts || [];
    if (token && accounts.length) {
      const rels = await getRelationships({ instanceUrl: origin, accessToken: token, accountIds: accounts.map((a) => a.id) }).catch(() => []);
      const byId = new Map(rels.map((r) => [String(r.id), r]));
      accounts = accounts.map((a) => ({ ...a, relationship: byId.get(String(a.id)) || null }));
    }
    statuses = (res.statuses || []).map((s) => toUnifiedItem(s));
    hashtags = res.hashtags || [];
  }

  const wantsBskyFallback = !accounts.some((a) => a.protocol === 'bluesky')
    && (authStore.get().isBlueskyConnected || /\.bsky\.social\b/i.test(query));
  if (wantsBskyFallback) {
    const bskyAuth = await getAuthenticatedAccount('bluesky').catch(() => null);
    const readOpts = getBskyReadOpts(bskyAuth);
    const cleanActorQuery = String(query || '').trim().replace(/^@/, '');
    const [bskyActorsRes, bskyPostsRes] = await Promise.allSettled([
      searchBskyActors({ ...readOpts, query: cleanActorQuery, limit: 12 }),
      searchBskyPosts({ ...readOpts, query, limit: 12 }),
    ]);
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
  }

  const wantsThreadsFallback = !statuses.some((s) => s.protocol === 'threads')
    && authStore.get().isThreadsConnected
    && !backend.used;
  if (wantsThreadsFallback) {
    const { threads } = await getClientAdapters().catch(() => ({ threads: null }));
    if (threads) {
      const cleanActorQuery = String(query || '').trim().replace(/^@/, '');
      const [thrProfileRes, thrPostsRes] = await Promise.allSettled([
        cleanActorQuery && !cleanActorQuery.includes(' ') ? threads.lookupProfile(cleanActorQuery) : Promise.resolve(null),
        threads.searchPosts(query, 12),
      ]);
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
    }
  }

  return { accounts, statuses, hashtags };
}

export async function fetchSocialBridgeStatus() {
  const backend = await callBackendSocialOptional('/status', {}, true);
  if (backend.used && backend.data) {
    if (Array.isArray(backend.data.retryQueue)) {
      authStore.set({ retryQueue: backend.data.retryQueue });
    }
    return backend.data;
  }
  const retries = await listLocalRetries().catch(() => []);
  authStore.set({ retryQueue: retries });
  return { retryQueue: retries };
}

export async function runBridgeRetry(retryId) {
  const backend = await callBackendSocial(`/retries/${encodeURIComponent(retryId)}/run`, { method: 'POST' });
  if (backend.used) {
    authStore.set({ retryQueue: backend.data.retryQueue || [] });
    return backend.data;
  }
  const retries = await listLocalRetries();
  const entry = retries.find((r) => r.id === retryId);
  if (!entry) return { retryQueue: retries };
  const { bsky, threads } = await getClientAdapters();
  const parts = Array.isArray(entry.payload?.textParts) && entry.payload.textParts.length > 0
    ? entry.payload.textParts
    : [''];
  if (entry.protocol === 'bluesky' && bsky) {
    if (entry.operation === 'delete') {
      await bsky.delete({ uri: entry.payload?.nativeId || '' });
    } else {
      await publishBskySegments({ bsky, textParts: parts });
    }
  } else if (entry.protocol === 'threads' && threads) {
    if (entry.operation === 'delete') {
      await threads.delete({ postId: entry.payload?.nativeId || '' });
    } else {
      const mediaUrls = (entry.payload?.mastodonMediaUrls || []).filter(Boolean);
      await publishThreadsSegments({
        threads,
        textParts: parts,
        media: mediaUrls.map((url) => ({ url })),
        uploadedUrls: mediaUrls,
      });
    }
  }
  await deleteLocalRetry(retryId);
  const next = await listLocalRetries();
  authStore.set({ retryQueue: next });
  return { retryQueue: next };
}

export async function dismissBridgeRetry(retryId) {
  const backend = await callBackendSocial(`/retries/${encodeURIComponent(retryId)}`, { method: 'DELETE' });
  if (backend.used) {
    authStore.set({ retryQueue: backend.data.retryQueue || [] });
    return backend.data;
  }
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
  const recentPosts = [];
  const seenTexts = new Set();
  for (const rawItem of combined) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = toUnifiedItem(rawItem);
    if (item._meta?.mastodon?.rebloggedBy || item._meta?.bluesky?.rebloggedBy || rawItem.reblog) continue;
    const text = String(item.content_text || item.text || '').trim();
    if (!text || seenTexts.has(text)) continue;
    seenTexts.add(text);
    recentPosts.push({
      text,
      created_at: String(item.date_published || item.createdAt || '').trim(),
    });
    if (recentPosts.length >= 3) break;
  }

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
 * Subscribe to real-time Mastodon /api/v1/streaming updates via local SSE hub (Desktop)
 * or direct Mastodon WebSocket (standalone Capacitor Android).
 */
export function subscribeLiveSocialUpdates({ onUpdate, onDelete, onNotification } = {}) {
  const origin = getSocialBackendOrigin();
  if (origin && backendAvailable !== false && typeof globalThis.EventSource === 'function') {
    const es = new globalThis.EventSource(`${origin}/api/social/events`);
    es.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data || '{}');
        if (msg.type === 'update') onUpdate?.(toUnifiedItem(msg.data));
        else if (msg.type === 'delete') onDelete?.(msg.data?.id || msg.data?.statusId || '');
        else if (msg.type === 'notification') onNotification?.(toUnifiedItem(msg.data));
      } catch {
        // ignore malformed keepalives
      }
    };
    return () => es.close();
  }

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
 * Score feed items semantically against concept anchors using the Desktop/LAN CPU embedding endpoint.
 * Returns {} immediately when running offline or on Capacitor Android.
 */
export async function fetchSemanticFeedScores({ items = [], boostConcepts = [], dampenConcepts = [] } = {}) {
  const boost = Array.isArray(boostConcepts) ? boostConcepts : [];
  const dampen = Array.isArray(dampenConcepts) ? dampenConcepts : [];
  if ((boost.length === 0 && dampen.length === 0) || !Array.isArray(items) || items.length === 0) {
    return {};
  }
  const payloadItems = items
    .filter((it) => it && it.id && (it.content_text || it.text || it._meta?.linkCard?.title))
    .slice(0, 120)
    .map((it) => ({
      id: String(it.id),
      text: [
        it.content_text || it.text || '',
        it._meta?.linkCard?.title || '',
        it._meta?.linkCard?.description || '',
      ]
        .filter(Boolean)
        .join(' ')
        .slice(0, 600),
    }));
  if (payloadItems.length === 0) return {};
  const res = await callBackendSocialOptional(
    '/feed/semantic-score',
    {
      method: 'POST',
      json: { items: payloadItems, boostConcepts: boost, dampenConcepts: dampen },
    },
    true
  );
  if (!res?.used || !res.data?.available || typeof res.data?.scores !== 'object') {
    return {};
  }
  return res.data.scores;
}
