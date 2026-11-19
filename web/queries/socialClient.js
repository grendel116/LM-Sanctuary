import { BlueskyAdapter } from '../adapters/bluesky/index.js';
import { MastodonAdapter } from '../adapters/mastodon/index.js';
import { ThreadsAdapter } from '../adapters/threads/index.js';
import { PUBLIC_BSKY_API, normalizeInstanceUrl } from '../constants/endpoints.js';
import { canonicalizeActorHandle, deduplicateUnifiedItems, toUnifiedItem } from '../core/schema/unifiedItem.js';
import {
  blockBskyActor,
  followBskyActor,
  getBskyAuthorFeed,
  getBskyFollowers,
  getBskyFollows,
  getBskyPostThread,
  getBskyProfile,
  muteBskyActor,
  normalizeBskyActorProfile,
  normalizeBskyActorSummary,
  searchBskyActors,
  searchBskyPosts,
  updateBskyProfile,
} from './bluesky.js';
import {
  addAccountsToList,
  blockAccount,
  cleanMastodonMediaUrl,
  createFilterRule,
  createUserList,
  decodeHtmlEntities,
  deleteFilterRule,
  deleteUserList,
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
import { connectionStore } from '../state/sanctuary/connection.js';
import { syncMastodonUserProfileToSanctuary } from './sanctuary.js';
import {
  deleteLocalFilterRule,
  deleteLocalLinkedPost,
  deleteLocalRetry,
  enqueueLocalRetry,
  findLocalLinkedPost,
  listLocalFilterRules,
  listLocalRetries,
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

async function getClientAdapters() {
  const [mastoAuth, bskyAuth, threadsAuth] = await Promise.all([
    getAuthenticatedAccount('fediverse'),
    getAuthenticatedAccount('bluesky'),
    getAuthenticatedAccount('threads'),
  ]);

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
} = {}) {
  const cleanText = String(text || '').trim();
  const extraParts = Array.isArray(threadItems)
    ? threadItems.map((it) => String(it?.text ?? it ?? '').trim()).filter(Boolean)
    : [];
  const rawParts = [cleanText, ...extraParts].filter((p, idx) => idx === 0 || Boolean(p));

  const backend = await callBackendSocial('/posts', {
    method: 'POST',
    json: { text: cleanText, thread_items: extraParts, visibility, spoiler_text: spoilerText, language },
  });
  if (backend.used && mediaAttachments.length === 0) {
    const items = backend.data.items || backend.data.results || [];
    return { ...backend.data, items, results: items };
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

  const bridgeJobs = [];
  if (bsky) {
    bridgeJobs.push(
      (async () => {
        const bskyChunks = rawParts.flatMap((p) => splitTextClean(p, 300));
        if (bskyChunks.length === 0 && normalizedMedia.length > 0) bskyChunks.push('');
        const refs = [];
        const publishedItems = [];
        let rootRef = null;
        let parentRef = null;
        for (let i = 0; i < bskyChunks.length; i += 1) {
          const res = await bsky.publish(bskyChunks[i], i === 0 ? normalizedMedia : [], {
            reply: parentRef ? { root: rootRef, parent: parentRef } : null,
          });
          publishedItems.push(res);
          const ref = { uri: res._meta.bluesky.uri, cid: res._meta.bluesky.cid };
          refs.push(ref);
          if (i === 0) rootRef = ref;
          parentRef = ref;
        }
        return { protocol: 'bluesky', refs, items: publishedItems };
      })()
    );
  }
  if (threads) {
    bridgeJobs.push(
      (async () => {
        const thrChunks = rawParts.flatMap((p) => splitTextClean(p, 500));
        if (thrChunks.length === 0 && normalizedMedia.length > 0) thrChunks.push('');
        const ids = [];
        const publishedItems = [];
        let parentTid = '';
        for (let i = 0; i < thrChunks.length; i += 1) {
          const res = await threads.publish(thrChunks[i], i === 0 ? normalizedMedia : [], {
            mastodonMediaUrls: uploadedUrls,
            publicMediaBaseUrl: authStore.get().publicMediaBaseUrl || '',
            replyToId: parentTid,
          });
          publishedItems.push(res);
          const pid = res._meta.threads.postId;
          ids.push(pid);
          parentTid = pid;
        }
        return { protocol: 'threads', ids, items: publishedItems };
      })()
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
      const proto = i === 0 && bsky ? 'bluesky' : 'threads';
      const errMsg = s.reason?.message || 'Bridge publish failed';
      warnings.push(`${proto}: ${errMsg}`);
      await enqueueLocalRetry({
        id: `retry_${proto}_${Date.now()}`,
        operation: 'publish',
        protocol: proto,
        payload: { canonicalId: rootCanonical, mastodonStatusId: rootMastoId, textParts: rawParts },
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
  if (backend.used) return backend.data;

  const storedLink = await findLocalLinkedPost(item.id);
  const linked = item._meta?.linkedIds || storedLink || {};
  const mastoId = linked.mastodonStatusId || item._meta?.mastodon?.statusId || (item.protocol === 'mastodon' ? item.id.replace(/^mastodon:/, '') : '');
  const bskyUri = linked.blueskyUri || item._meta?.bluesky?.uri || '';
  const threadsPostId = linked.threadsPostId || item._meta?.threads?.postId || '';

  const { masto, bsky, threads } = await getClientAdapters();
  const tasks = [];
  if (masto && mastoId) tasks.push(masto.delete({ statusId: mastoId }).then(() => ({ protocol: 'mastodon' })));
  if (bsky && bskyUri) tasks.push(bsky.delete({ uri: bskyUri }).then(() => ({ protocol: 'bluesky' })));
  if (threads && threadsPostId) tasks.push(threads.delete({ postId: threadsPostId }).then(() => ({ protocol: 'threads' })));

  const settled = await Promise.allSettled(tasks);
  const warnings = [];
  for (const res of settled) {
    if (res.status === 'rejected') {
      warnings.push(res.reason?.message || 'Delete leg failed');
    }
  }
  await deleteLocalLinkedPost(item.id);
  return { deleted: true, warnings, retryQueue: await listLocalRetries() };
}

export async function editUnified(statusId, draft, spoilerText = '') {
  const cleanId = String(statusId || '').replace(/^mastodon:/, '');
  const backend = await callBackendSocial(`/posts/${encodeURIComponent(cleanId)}`, {
    method: 'PUT',
    json: { text: draft, spoiler_text: spoilerText },
  });
  if (backend.used) return backend.data.item;

  const { masto } = await getClientAdapters();
  if (!masto) throw new Error('Connect Mastodon to edit posts.');
  return masto.edit(cleanId, draft, spoilerText);
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

export async function fetchUnifiedNotifications({ limit = 35 } = {}) {
  const backend = await callBackendSocial(`/notifications?limit=${limit}`);
  if (backend.used) return backend.data;

  const { masto, bsky, threads } = await getClientAdapters();
  const tasks = [];
  if (masto) tasks.push(masto.fetchNotifications('', limit));
  if (bsky) tasks.push(bsky.fetchNotifications('', limit));
  if (threads) tasks.push(threads.fetchNotifications('', 12));

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
  return { items: deduplicateUnifiedItems(collected).slice(0, limit), warnings };
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
  { tab = 'posts', instanceUrl = 'https://mastodon.social', maxId = '', protocol = 'mastodon', acct = '' } = {}
) {
  const isBsky = protocol === 'bluesky' || String(accountId || '').startsWith('did:');
  const protoKey = isBsky ? 'bluesky' : 'mastodon';
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId || acct)}/statuses?tab=${encodeURIComponent(tab)}&instanceUrl=${encodeURIComponent(instanceUrl)}&max_id=${encodeURIComponent(maxId)}&protocol=${encodeURIComponent(protoKey)}&acct=${encodeURIComponent(acct)}`,
    {},
    isBsky
  );
  if (backend.used) return backend.data.items || [];

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
  return rows.map((r) => toUnifiedItem(r));
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
  const protocol = raw?.protocol || (raw?.network === 'bluesky' || String(raw?.id || raw?.did || '').startsWith('did:') ? 'bluesky' : 'mastodon');
  return {
    id: String(raw?.id || raw?.did || ''),
    did: String(raw?.did || ''),
    protocol,
    network: raw?.network || (protocol === 'bluesky' ? 'bluesky' : 'fediverse'),
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

export async function fetchKeywordFilters() {
  const backend = await callBackendSocial('/filters');
  if (backend.used) return backend.data.filters || [];
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return listLocalFilterRules();
  const rules = await getFilters({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken });
  return rules;
}

export async function addKeywordFilter({ title, phrase, filterAction = 'hide' }) {
  const backend = await callBackendSocial('/filters', {
    method: 'POST',
    json: { title: title || phrase, phrase, filter_action: filterAction },
  });
  if (backend.used) return backend.data.filter;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) {
    const localRule = { id: `local_${Date.now()}`, title: title || phrase, phrase, filter_action: filterAction };
    await saveLocalFilterRule(localRule);
    return localRule;
  }
  return createFilterRule({
    instanceUrl: mastoAuth.meta.instanceUrl,
    accessToken: mastoAuth.secrets.accessToken,
    title: title || phrase,
    phrase,
    filterAction,
  });
}

export async function removeKeywordFilter(filterId) {
  const backend = await callBackendSocial(`/filters/${encodeURIComponent(filterId)}`, { method: 'DELETE' });
  if (backend.used) return true;
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth || String(filterId).startsWith('local_')) {
    await deleteLocalFilterRule(filterId);
    return true;
  }
  return deleteFilterRule({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken, filterId });
}

export async function fetchModerationAccounts(kind = 'mutes') {
  const backend = await callBackendSocial(`/moderation/${kind}`);
  if (backend.used) return (backend.data.accounts || []).map(normalizeAccountRecord);
  const { mastoAuth } = await getClientAdapters();
  if (!mastoAuth) return [];
  return kind === 'blocks'
    ? getBlocks({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken })
    : getMutes({ instanceUrl: mastoAuth.meta.instanceUrl, accessToken: mastoAuth.secrets.accessToken });
}

export async function fetchAuthorWithRelationship(
  accountId,
  instanceUrl = 'https://mastodon.social',
  { protocol = 'mastodon', acct = '' } = {}
) {
  const isBsky = protocol === 'bluesky' || String(accountId || '').startsWith('did:');
  const protoKey = isBsky ? 'bluesky' : 'mastodon';
  const backend = await callBackendSocialOptional(
    `/accounts/${encodeURIComponent(accountId || acct)}/profile?instanceUrl=${encodeURIComponent(instanceUrl)}&protocol=${encodeURIComponent(protoKey)}&acct=${encodeURIComponent(acct)}`,
    {},
    isBsky
  );
  if (backend.used) {
    return {
      ...backend.data,
      profile: backend.data.profile ? normalizeAccountRecord(backend.data.profile) : null,
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
    return {
      focal: res?.status ? toUnifiedItem(res.status) : focal,
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

    return {
      focal: ctx?.status ? toUnifiedItem(ctx.status) : focal,
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

  return { accounts, statuses, hashtags };
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
  if (entry.protocol === 'bluesky' && bsky) {
    await bsky.publish(entry.payload?.textParts?.[0] || '');
  } else if (entry.protocol === 'threads' && threads) {
    await threads.publish(entry.payload?.textParts?.[0] || '');
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
