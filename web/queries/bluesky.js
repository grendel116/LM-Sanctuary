import {
  BLUESKY_CHAT_PROXY,
  DEFAULT_BSKY_SERVICE,
  PUBLIC_BSKY_API,
  normalizeInstanceUrl,
} from '../constants/endpoints.js';
import { FetchError } from './fetch/FetchError.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';
import { extractFieldLinkUrl } from './fediverse.js';

const utf8Encoder = new TextEncoder();

function cleanServiceOrigin(serviceUrl = DEFAULT_BSKY_SERVICE) {
  return normalizeInstanceUrl(serviceUrl || DEFAULT_BSKY_SERVICE);
}

/**
 * Compute exact UTF-8 byte offsets for URLs, @handles, and #tags in AT Protocol RichText.
 * @param {string} text
 * @returns {Array<{ index: { byteStart: number, byteEnd: number }, features: Array<object>, _handle?: string }>}
 */
export function extractUtf8ByteFacets(text) {
  const input = String(text || '');
  if (!input) return [];

  const candidates = [];

  const byteRange = (charStart, token) => {
    const byteStart = utf8Encoder.encode(input.slice(0, charStart)).byteLength;
    const byteEnd = byteStart + utf8Encoder.encode(token).byteLength;
    return { byteStart, byteEnd };
  };

  // URLs
  const urlRe = /(?:^|[\s(])(https?:\/\/[^\s<>()[\]{}"']+)/g;
  for (const m of input.matchAll(urlRe)) {
    const rawUrl = m[1].replace(/[.,!?;:]+$/, '');
    if (!rawUrl) continue;
    try {
      const parsed = new URL(rawUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    const charStart = m.index + m[0].indexOf(m[1]);
    candidates.push({
      index: byteRange(charStart, rawUrl),
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: rawUrl }],
    });
  }

  // @handle.tld mentions
  const mentionRe = /(?:^|[^\w.])(@([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+))(?![a-zA-Z0-9.-])/g;
  for (const m of input.matchAll(mentionRe)) {
    const fullMention = m[1];
    const handle = m[2];
    const charStart = m.index + m[0].indexOf(fullMention);
    candidates.push({
      index: byteRange(charStart, fullMention),
      features: [{ $type: 'app.bsky.richtext.facet#mention', did: '' }],
      _handle: handle.toLowerCase(),
    });
  }

  // #hashtags
  const tagRe = /(?:^|[\s(])(#([^\s#.,!?;:()[\]{}"']+))/g;
  for (const m of input.matchAll(tagRe)) {
    const fullTag = m[1];
    const tagValue = m[2].replace(/[.,!?;:]+$/, '');
    if (!tagValue || /^\d+$/.test(tagValue) || utf8Encoder.encode(tagValue).byteLength > 64) {
      continue;
    }
    const cleanToken = `#${tagValue}`;
    const charStart = m.index + m[0].indexOf(fullTag);
    candidates.push({
      index: byteRange(charStart, cleanToken),
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag: tagValue }],
    });
  }

  candidates.sort((a, b) => a.index.byteStart - b.index.byteStart);
  const nonOverlapping = [];
  let lastEnd = 0;
  for (const facet of candidates) {
    if (facet.index.byteStart < lastEnd) continue;
    nonOverlapping.push(facet);
    lastEnd = facet.index.byteEnd;
  }
  return nonOverlapping;
}

/**
 * Resolve ATProto DIDs for extracted @mention facets via com.atproto.identity.resolveHandle.
 */
export async function resolveMentionFacets(facets, { serviceUrl = PUBLIC_BSKY_API, fetchImpl } = {}) {
  const origin = cleanServiceOrigin(serviceUrl);
  const resolved = [];
  for (const facet of facets) {
    if (!facet._handle) {
      resolved.push(facet);
      continue;
    }
    try {
      const data = await fetchWrapper(
        `${origin}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(facet._handle)}`,
        { fetchImpl }
      );
      if (data?.did) {
        resolved.push({
          index: facet.index,
          features: [{ $type: 'app.bsky.richtext.facet#mention', did: data.did }],
        });
      }
    } catch {
      // Drop unresolved mention facets so createRecord stays valid.
    }
  }
  return resolved;
}

export async function createBskySession({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  identifier,
  password,
  fetchImpl,
}) {
  const origin = cleanServiceOrigin(serviceUrl);
  return fetchWrapper(`${origin}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    json: { identifier, password },
    fetchImpl,
  });
}

export async function refreshBskySession({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  refreshJwt,
  fetchImpl,
}) {
  const origin = cleanServiceOrigin(serviceUrl);
  return fetchWrapper(`${origin}/xrpc/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshJwt}` },
    fetchImpl,
  });
}

/**
 * Execute an XRPC call and automatically refresh once when the accessJwt expires.
 */
export async function bskyRequest({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  endpoint,
  method = 'GET',
  params,
  json,
  body,
  headers = {},
  accessJwt = '',
  refreshJwt = '',
  onSessionRefreshed,
  fetchImpl,
}) {
  const origin = cleanServiceOrigin(serviceUrl);
  const url = new URL(`${origin}/xrpc/${endpoint}`);
  if (params && typeof params === 'object') {
    for (const [k, v] of Object.entries(params)) {
      if (Array.isArray(v)) {
        for (const item of v) {
          if (item !== undefined && item !== null && item !== '') {
            url.searchParams.append(k, String(item));
          }
        }
      } else if (v !== undefined && v !== null && v !== '') {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const runWithToken = async (token) => {
    const reqHeaders = { ...headers };
    if (token) reqHeaders.Authorization = `Bearer ${token}`;
    return fetchWrapper(url.toString(), {
      method,
      headers: reqHeaders,
      json,
      body,
      fetchImpl,
    });
  };

  try {
    return await runWithToken(accessJwt);
  } catch (err) {
    const isExpired = err instanceof FetchError && (
      err.status === 401 ||
      (err.status === 400 && err.body?.error === 'ExpiredToken')
    );
    if (isExpired && refreshJwt) {
      const refreshed = await refreshBskySession({
        serviceUrl: origin,
        refreshJwt,
        fetchImpl,
      });
      if (typeof onSessionRefreshed === 'function') {
        await onSessionRefreshed(refreshed);
      }
      return runWithToken(refreshed.accessJwt);
    }
    throw err;
  }
}

function rkeyFromAtUri(uri) {
  const parts = String(uri || '').split('/');
  return parts[parts.length - 1] || '';
}

function escapePlainTextToParagraphs(text) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((block) => `<p>${block.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/**
 * Normalize an AT Protocol feedViewPost or postView into the shared PostItem shape.
 */
export function normalizeBskyPost(feedItem) {
  const post = feedItem?.post || feedItem;
  const record = post?.record || {};
  const author = post?.author || {};
  const uri = String(post?.uri || '');
  const rkey = rkeyFromAtUri(uri);
  const handle = author.handle || author.did || '';
  const embedImages = Array.isArray(post?.embed?.images) ? post.embed.images : [];
  const createdAt = record.createdAt || post?.indexedAt || '';

  return {
    key: `bluesky:${uri || post?.cid || ''}`,
    network: 'bluesky',
    instanceUrl: 'https://bsky.app',
    id: rkey || uri,
    cid: post?.cid || '',
    uri,
    url: handle && rkey ? `https://bsky.app/profile/${handle}/post/${rkey}` : '',
    createdAt,
    createdAtMs: Date.parse(createdAt) || 0,
    author: {
      id: author.did || '',
      did: author.did || '',
      username: handle,
      acct: handle,
      displayName: author.displayName || handle,
      avatar: author.avatar || '',
      url: handle ? `https://bsky.app/profile/${handle}` : '',
    },
    rebloggedBy: feedItem?.reason?.by
      ? {
          id: feedItem.reason.by.did || '',
          acct: feedItem.reason.by.handle || '',
          displayName: feedItem.reason.by.displayName || feedItem.reason.by.handle || '',
          avatar: feedItem.reason.by.avatar || '',
        }
      : null,
    text: record.text || '',
    sanitizedHtml: escapePlainTextToParagraphs(record.text || ''),
    spoilerText: '',
    visibility: 'public',
    media: embedImages.map((img, idx) => ({
      id: `${post?.cid || 'img'}_${idx}`,
      type: 'image',
      url: img.fullsize || img.thumb || '',
      previewUrl: img.thumb || img.fullsize || '',
      description: img.alt || '',
    })),
    counts: {
      replies: post?.replyCount ?? 0,
      reposts: post?.repostCount ?? 0,
      likes: post?.likeCount ?? 0,
    },
    viewerState: {
      favourited: Boolean(post?.viewer?.like),
      likeUri: post?.viewer?.like || null,
      reblogged: Boolean(post?.viewer?.repost),
      repostUri: post?.viewer?.repost || null,
      bookmarked: false,
    },
    reply: record.reply && typeof record.reply === 'object' ? record.reply : null,
    raw: feedItem,
  };
}

export async function getBskyTimeline(opts) {
  const { cursor = '', limit = 25, ...auth } = opts;
  const data = await bskyRequest({
    ...auth,
    endpoint: 'app.bsky.feed.getTimeline',
    params: { limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    items: Array.isArray(data?.feed) ? data.feed.map(normalizeBskyPost) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function getBskyCustomFeed(opts) {
  const { feed, cursor = '', limit = 25, ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.getFeed',
    params: { feed, limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    items: Array.isArray(data?.feed) ? data.feed.map(normalizeBskyPost) : [],
    nextCursor: data?.cursor || null,
  };
}

function defaultBskyReadService(opts) {
  return opts?.accessJwt ? (opts?.serviceUrl || DEFAULT_BSKY_SERVICE) : PUBLIC_BSKY_API;
}

async function bskyPublicReadRequest(opts) {
  const serviceUrl = defaultBskyReadService(opts);
  try {
    return await bskyRequest({ ...opts, serviceUrl });
  } catch (err) {
    const status = Number(err?.status || 0);
    if (serviceUrl !== PUBLIC_BSKY_API && (status === 400 || status === 401 || status === 403)) {
      return bskyRequest({
        ...opts,
        accessJwt: '',
        refreshJwt: '',
        onSessionRefreshed: null,
        serviceUrl: PUBLIC_BSKY_API,
      });
    }
    throw err;
  }
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return String(url || '');
  }
}

function buildBskyViewerRel(viewer = {}) {
  return {
    following: Boolean(viewer.following),
    followUri: viewer.following || null,
    followed_by: Boolean(viewer.followedBy),
    muting: Boolean(viewer.muted),
    blocking: Boolean(viewer.blocking),
    blockUri: viewer.blocking || null,
  };
}

/**
 * Normalize an AT Protocol app.bsky.actor.defs#profileView summary into a shared account row.
 */
export function normalizeBskyActorSummary(raw) {
  const did = String(raw?.did || '');
  const handle = String(raw?.handle || did || '');
  const viewer = raw?.viewer || {};
  return {
    id: did,
    did,
    protocol: 'bluesky',
    network: 'bluesky',
    username: handle,
    acct: handle,
    displayName: raw?.displayName || handle,
    avatar: raw?.avatar || '',
    url: handle ? `https://bsky.app/profile/${handle}` : '',
    noteText: String(raw?.description || ''),
    viewer,
    relationship: buildBskyViewerRel(viewer),
  };
}

/**
 * Normalize an AT Protocol app.bsky.actor.defs#profileViewDetailed payload
 * into the shared profile + relationship shape consumed by AuthorSheetModal.
 */
export function normalizeBskyActorProfile(raw) {
  const did = String(raw?.did || '');
  const handle = String(raw?.handle || did || '');
  const description = String(raw?.description || '');
  const viewer = raw?.viewer || {};
  const fields = [];
  if (Array.isArray(raw?.links)) {
    for (const item of raw.links.slice(0, 4)) {
      const url = extractFieldLinkUrl(item?.url);
      if (!url) continue;
      const title = String(item?.title || '').trim() || hostnameFromUrl(url);
      fields.push({
        name: title,
        value: url,
        uri: String(item?.uri || ''),
        cid: String(item?.cid || ''),
      });
    }
  }
  if (typeof raw?.pronouns === 'string' && raw.pronouns.trim()) {
    fields.push({ name: 'Pronouns', value: raw.pronouns.trim() });
  }
  return {
    profile: {
      id: did,
      did,
      protocol: 'bluesky',
      username: handle,
      acct: handle,
      displayName: raw?.displayName || handle,
      avatar: raw?.avatar || '',
      header: raw?.banner || '',
      url: handle ? `https://bsky.app/profile/${handle}` : '',
      note: description ? escapePlainTextToParagraphs(description) : '',
      noteText: description,
      fields: fields.slice(0, 4),
      followersCount: raw?.followersCount ?? 0,
      followingCount: raw?.followsCount ?? 0,
      statusesCount: raw?.postsCount ?? 0,
    },
    relationship: buildBskyViewerRel(viewer),
  };
}

export async function getBskyFollows(opts) {
  const { actor, limit = 40, cursor = '', ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.graph.getFollows',
    params: { actor, limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    accounts: Array.isArray(data?.follows) ? data.follows.map(normalizeBskyActorSummary) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function getBskyFollowers(opts) {
  const { actor, limit = 40, cursor = '', ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.graph.getFollowers',
    params: { actor, limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    accounts: Array.isArray(data?.followers) ? data.followers.map(normalizeBskyActorSummary) : [],
    nextCursor: data?.cursor || null,
  };
}

/**
 * Sync displayName, description, avatar/banner blobs, pronouns, and app.bsky.actor.link records
 * onto the connected Bluesky PDS repository (`app.bsky.actor.profile` rkey `self`).
 */
export async function updateBskyProfile({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  repo,
  accessJwt,
  refreshJwt,
  onSessionRefreshed,
  displayName,
  description,
  fields,
  avatarBlob = null,
  bannerBlob = null,
  removeAvatar = false,
  removeHeader = false,
  fetchImpl,
}) {
  let liveAccess = accessJwt || '';
  let liveRefresh = refreshJwt || '';
  const handleRefreshed = async (tok) => {
    if (tok?.accessJwt) liveAccess = tok.accessJwt;
    if (tok?.refreshJwt) liveRefresh = tok.refreshJwt;
    await onSessionRefreshed?.(tok);
  };
  const xrpc = (opts) => bskyRequest({
    serviceUrl,
    accessJwt: liveAccess,
    refreshJwt: liveRefresh,
    onSessionRefreshed: handleRefreshed,
    fetchImpl,
    ...opts,
  });

  const [existingRes, existingLinksRes] = await Promise.all([
    xrpc({
      endpoint: 'com.atproto.repo.getRecord',
      params: { repo, collection: 'app.bsky.actor.profile', rkey: 'self' },
    }).catch(() => ({})),
    xrpc({
      endpoint: 'com.atproto.repo.listRecords',
      params: { repo, collection: 'app.bsky.actor.link', limit: 50 },
    }).catch(() => ({ records: [] })),
  ]);

  const existingValue = (existingRes?.value && typeof existingRes.value === 'object') ? existingRes.value : {};
  const record = {
    ...existingValue,
    $type: 'app.bsky.actor.profile',
    createdAt: existingValue.createdAt || new Date().toISOString(),
  };

  if (displayName !== undefined && displayName !== null) {
    record.displayName = [...String(displayName).trim()].slice(0, 64).join('');
  }
  if (description !== undefined && description !== null) {
    record.description = [...String(description).trim()].slice(0, 256).join('');
  }

  if (Array.isArray(fields)) {
    const desiredLinks = [];
    let desiredPronouns = '';
    for (const f of fields.slice(0, 4)) {
      const name = String(f?.name || '').trim();
      const val = String(f?.value || '').trim();
      const href = extractFieldLinkUrl(val);
      if (href) {
        desiredLinks.push({
          url: href,
          title: [...(name && !/^https?:\/\//i.test(name) ? name : hostnameFromUrl(href))].slice(0, 100).join(''),
        });
      } else if (name.toLowerCase() === 'pronouns') {
        desiredPronouns = [...val].slice(0, 64).join('');
      }
    }

    const existingRecords = Array.isArray(existingLinksRes?.records) ? existingLinksRes.records : [];
    const usedUris = new Set();
    const strongRefs = [];
    for (const desired of desiredLinks) {
      const match = existingRecords.find(
        (rec) => !usedUris.has(rec?.uri)
          && rec?.uri
          && rec?.cid
          && rec?.value?.url === desired.url
          && String(rec?.value?.title || '') === desired.title
      );
      if (match) {
        usedUris.add(match.uri);
        strongRefs.push({ uri: match.uri, cid: match.cid });
      } else {
        const created = await xrpc({
          endpoint: 'com.atproto.repo.createRecord',
          method: 'POST',
          json: {
            repo,
            collection: 'app.bsky.actor.link',
            record: {
              $type: 'app.bsky.actor.link',
              url: desired.url,
              title: desired.title,
              createdAt: new Date().toISOString(),
            },
          },
        });
        if (created?.uri && created?.cid) {
          usedUris.add(created.uri);
          strongRefs.push({ uri: created.uri, cid: created.cid });
        }
      }
    }

    for (const stale of existingRecords) {
      if (stale?.uri && !usedUris.has(stale.uri)) {
        const rkey = rkeyFromAtUri(stale.uri);
        if (rkey) {
          await xrpc({
            endpoint: 'com.atproto.repo.deleteRecord',
            method: 'POST',
            json: { repo, collection: 'app.bsky.actor.link', rkey },
          }).catch(() => {});
        }
      }
    }

    if (strongRefs.length > 0) record.links = strongRefs;
    else delete record.links;

    if (desiredPronouns) record.pronouns = desiredPronouns;
    else if ('pronouns' in record) delete record.pronouns;
  }

  const resolveMediaBlob = async (candidate) => {
    if (!candidate) return null;
    if (candidate.$type === 'blob') return candidate;
    return uploadBskyBlob({
      serviceUrl,
      accessJwt: liveAccess,
      refreshJwt: liveRefresh,
      onSessionRefreshed: handleRefreshed,
      blob: candidate,
      mimeType: candidate.type || 'image/jpeg',
      fetchImpl,
    });
  };

  if (avatarBlob) {
    record.avatar = await resolveMediaBlob(avatarBlob);
  } else if (removeAvatar) {
    delete record.avatar;
  }

  if (bannerBlob) {
    record.banner = await resolveMediaBlob(bannerBlob);
  } else if (removeHeader) {
    delete record.banner;
  }

  await xrpc({
    endpoint: 'com.atproto.repo.putRecord',
    method: 'POST',
    json: {
      repo,
      collection: 'app.bsky.actor.profile',
      rkey: 'self',
      record,
    },
  });

  const refreshedProfile = await getBskyProfile({
    serviceUrl,
    actor: repo,
    accessJwt: liveAccess,
    refreshJwt: liveRefresh,
    onSessionRefreshed: handleRefreshed,
    fetchImpl,
  });
  return normalizeBskyActorProfile(refreshedProfile);
}

export async function getBskyProfile(opts) {
  const { actor, ...auth } = opts;
  return bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.actor.getProfile',
    params: { actor },
  });
}

export async function getBskyAuthorFeed(opts) {
  const { actor, limit = 15, cursor = '', filter = 'posts_no_replies', ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.getAuthorFeed',
    params: { actor, limit, filter, ...(cursor ? { cursor } : {}) },
  });
  return {
    items: Array.isArray(data?.feed) ? data.feed.map(normalizeBskyPost) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function getBskyPostThread(opts) {
  const { uri, depth = 6, parentHeight = 20, ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.getPostThread',
    params: { uri, depth, parentHeight },
  });
  const thread = data?.thread || {};

  const seenAncestors = new Set();
  const rawAncestors = [];
  let p = thread.parent;
  while (p && p.post?.uri && !seenAncestors.has(p.post.uri)) {
    seenAncestors.add(p.post.uri);
    rawAncestors.push(normalizeBskyPost({ post: p.post }));
    p = p.parent;
  }
  rawAncestors.reverse();

  const focal = thread.post?.uri ? normalizeBskyPost({ post: thread.post }) : null;
  const threadRootRef = rawAncestors[0]
    ? { uri: rawAncestors[0].uri, cid: rawAncestors[0].cid }
    : (focal?.reply?.root?.uri && focal?.reply?.root?.cid
      ? focal.reply.root
      : (focal ? { uri: focal.uri, cid: focal.cid } : null));

  const descendants = [];
  const seenReplies = new Set();
  function walkReplies(nodes, currentDepth, parentDid, parentRef) {
    if (!Array.isArray(nodes) || nodes.length === 0) return;
    const valid = nodes.filter((n) => n?.post?.uri && !seenReplies.has(n.post.uri));
    valid.sort((a, b) => {
      const aSelf = a.post?.author?.did && parentDid && a.post.author.did === parentDid ? 0 : 1;
      const bSelf = b.post?.author?.did && parentDid && b.post.author.did === parentDid ? 0 : 1;
      if (aSelf !== bSelf) return aSelf - bSelf;
      const aTs = Date.parse(a.post?.record?.createdAt || a.post?.indexedAt || '');
      const bTs = Date.parse(b.post?.record?.createdAt || b.post?.indexedAt || '');
      if (Number.isFinite(aTs) && Number.isFinite(bTs) && aTs !== bTs) return aTs - bTs;
      return 0;
    });
    for (const node of valid) {
      seenReplies.add(node.post.uri);
      const norm = normalizeBskyPost({ post: node.post });
      if (!norm.reply && threadRootRef && parentRef) {
        norm.reply = { root: threadRootRef, parent: parentRef };
      } else if (norm.reply && !norm.reply.root && threadRootRef) {
        norm.reply = { ...norm.reply, root: threadRootRef };
      }
      descendants.push({ item: norm, depth: currentDepth });
      walkReplies(
        node.replies,
        currentDepth + 1,
        node.post?.author?.did || '',
        { uri: norm.uri, cid: norm.cid }
      );
    }
  }

  if (focal) {
    walkReplies(
      thread.replies,
      0,
      thread.post?.author?.did || focal.author?.did || '',
      { uri: focal.uri, cid: focal.cid }
    );
  }

  return {
    status: focal,
    ancestors: rawAncestors,
    descendants,
  };
}

async function toggleBskyGraphRecord({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  repo,
  targetDid,
  recordUri = null,
  collection,
  undo = false,
  accessJwt,
  refreshJwt,
  onSessionRefreshed,
  fetchImpl,
}) {
  if (undo) {
    if (recordUri) {
      await bskyRequest({
        serviceUrl,
        endpoint: 'com.atproto.repo.deleteRecord',
        method: 'POST',
        json: { repo, collection, rkey: rkeyFromAtUri(recordUri) },
        accessJwt,
        refreshJwt,
        onSessionRefreshed,
        fetchImpl,
      });
    }
    return { active: false, uri: null };
  }
  const res = await bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.createRecord',
    method: 'POST',
    json: {
      repo,
      collection,
      record: { $type: collection, subject: targetDid, createdAt: new Date().toISOString() },
    },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
  return { active: true, uri: res?.uri || null };
}

export async function followBskyActor({ targetDid, followUri = null, unfollow = false, ...rest }) {
  const out = await toggleBskyGraphRecord({
    ...rest,
    targetDid,
    recordUri: followUri,
    collection: 'app.bsky.graph.follow',
    undo: unfollow,
  });
  return { following: out.active, followUri: out.active ? (out.uri || 'followed') : null };
}

export async function muteBskyActor({ serviceUrl = DEFAULT_BSKY_SERVICE, actor, unmute = false, accessJwt, refreshJwt, onSessionRefreshed, fetchImpl }) {
  await bskyRequest({
    serviceUrl,
    endpoint: unmute ? 'app.bsky.graph.unmuteActor' : 'app.bsky.graph.muteActor',
    method: 'POST',
    json: { actor },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
  return { muting: !unmute };
}

export async function blockBskyActor({ targetDid, blockUri = null, unblock = false, ...rest }) {
  const out = await toggleBskyGraphRecord({
    ...rest,
    targetDid,
    recordUri: blockUri,
    collection: 'app.bsky.graph.block',
    undo: unblock,
  });
  return { blocking: out.active, blockUri: out.active ? (out.uri || 'blocked') : null };
}

export async function searchBskyActors(opts) {
  const { query, limit = 20, cursor = '', ...auth } = opts;
  return bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.actor.searchActors',
    params: { q: query, limit, ...(cursor ? { cursor } : {}) },
  });
}

export async function searchBskyPosts(opts) {
  const { query, limit = 20, cursor = '', ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.searchPosts',
    params: { q: query, limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    items: Array.isArray(data?.posts) ? data.posts.map((p) => normalizeBskyPost({ post: p })) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function uploadBskyBlob({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  accessJwt,
  refreshJwt,
  onSessionRefreshed,
  blob,
  mimeType,
  fetchImpl,
}) {
  const type = mimeType || blob?.type || 'image/jpeg';
  const data = await bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.uploadBlob',
    method: 'POST',
    headers: { 'Content-Type': type },
    body: blob,
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
  return data?.blob;
}

export async function createBskyPost({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  repo,
  accessJwt,
  refreshJwt,
  onSessionRefreshed,
  text,
  langs = ['en'],
  images = [],
  reply = null,
  resolveMentions = true,
  fetchImpl,
}) {
  const rawFacets = extractUtf8ByteFacets(text);
  const facets = resolveMentions
    ? await resolveMentionFacets(rawFacets, { serviceUrl, fetchImpl })
    : rawFacets.filter((f) => !f._handle);

  const record = {
    $type: 'app.bsky.feed.post',
    text: String(text || ''),
    createdAt: new Date().toISOString(),
  };
  if (langs?.length) record.langs = langs;
  if (facets.length) record.facets = facets;
  if (reply) record.reply = reply;
  if (Array.isArray(images) && images.length > 0) {
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: images.slice(0, 4).map((img) => ({
        alt: img.alt || '',
        image: img.blob,
      })),
    };
  }

  return bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.createRecord',
    method: 'POST',
    json: {
      repo,
      collection: 'app.bsky.feed.post',
      record,
    },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
}

export async function likeBskyPost({ serviceUrl = DEFAULT_BSKY_SERVICE, repo, uri, cid, likeUri, accessJwt, refreshJwt, onSessionRefreshed, fetchImpl }) {
  if (likeUri) {
    return bskyRequest({
      serviceUrl,
      endpoint: 'com.atproto.repo.deleteRecord',
      method: 'POST',
      json: { repo, collection: 'app.bsky.feed.like', rkey: rkeyFromAtUri(likeUri) },
      accessJwt,
      refreshJwt,
      onSessionRefreshed,
      fetchImpl,
    });
  }
  return bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.createRecord',
    method: 'POST',
    json: {
      repo,
      collection: 'app.bsky.feed.like',
      record: { $type: 'app.bsky.feed.like', subject: { uri, cid }, createdAt: new Date().toISOString() },
    },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
}

export async function repostBskyPost({ serviceUrl = DEFAULT_BSKY_SERVICE, repo, uri, cid, repostUri, accessJwt, refreshJwt, onSessionRefreshed, fetchImpl }) {
  if (repostUri) {
    return bskyRequest({
      serviceUrl,
      endpoint: 'com.atproto.repo.deleteRecord',
      method: 'POST',
      json: { repo, collection: 'app.bsky.feed.repost', rkey: rkeyFromAtUri(repostUri) },
      accessJwt,
      refreshJwt,
      onSessionRefreshed,
      fetchImpl,
    });
  }
  return bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.createRecord',
    method: 'POST',
    json: {
      repo,
      collection: 'app.bsky.feed.repost',
      record: { $type: 'app.bsky.feed.repost', subject: { uri, cid }, createdAt: new Date().toISOString() },
    },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
}

// AT Protocol Direct Messages (chat.bsky.convo.*) via bsky_chat proxy header

export async function getBskyConvoForMembers(opts) {
  const { members = [], ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.getConvoForMembers',
    params: { members },
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

export async function listBskyConvos(opts) {
  const { cursor = '', limit = 30, ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.listConvos',
    params: { limit, ...(cursor ? { cursor } : {}) },
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

export async function getBskyConvoMessages(opts) {
  const { convoId, cursor = '', limit = 50, ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.getMessages',
    params: { convoId, limit, ...(cursor ? { cursor } : {}) },
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

export async function sendBskyConvoMessage(opts) {
  const { convoId, text, ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.sendMessage',
    method: 'POST',
    json: { convoId, message: { text: String(text || '') } },
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

export async function acceptBskyConvo(opts) {
  const { convoId, ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.acceptConvo',
    method: 'POST',
    json: { convoId },
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

export async function deleteBskyPost({ serviceUrl = DEFAULT_BSKY_SERVICE, repo, uri, accessJwt, refreshJwt, onSessionRefreshed, fetchImpl }) {
  const rkey = rkeyFromAtUri(uri);
  if (!rkey) return false;
  await bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.deleteRecord',
    method: 'POST',
    json: { repo, collection: 'app.bsky.feed.post', rkey },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
  return true;
}

export async function listBskyNotifications({ serviceUrl = DEFAULT_BSKY_SERVICE, limit = 30, cursor = '', accessJwt, refreshJwt, onSessionRefreshed, fetchImpl }) {
  return bskyRequest({
    serviceUrl,
    endpoint: 'app.bsky.notification.listNotifications',
    params: { limit, ...(cursor ? { cursor } : {}) },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
}
