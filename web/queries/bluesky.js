import {
  BLUESKY_CHAT_PROXY,
  DEFAULT_BSKY_SERVICE,
  PUBLIC_BSKY_API,
  normalizeInstanceUrl,
} from '../constants/endpoints.js';
import { FetchError } from './fetch/FetchError.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';
import { extractFieldLinkUrl, formatTruncatedUrlInnerHtml } from './fediverse.js';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });
const NATIVE_NODE_WEBSOCKET = typeof globalThis.process?.versions?.node === 'string' && typeof globalThis.WebSocket === 'function'
  ? globalThis.WebSocket
  : null;
const JETSTREAM_ENDPOINTS = Object.freeze([
  'wss://jetstream2.us-east.bsky.network/subscribe',
  'wss://jetstream1.us-east.bsky.network/subscribe',
]);

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
    const query = `com.atproto.identity.resolveHandle?handle=${encodeURIComponent(facet._handle)}`;
    let did = '';
    try {
      const data = await fetchWrapper(`${origin}/xrpc/${query}`, { fetchImpl });
      did = data?.did ? String(data.did) : '';
    } catch {
      did = '';
    }
    if (!did && origin !== PUBLIC_BSKY_API) {
      try {
        const pubData = await fetchWrapper(`${PUBLIC_BSKY_API}/xrpc/${query}`, { fetchImpl });
        did = pubData?.did ? String(pubData.did) : '';
      } catch {
        did = '';
      }
    }
    if (did) {
      resolved.push({
        index: facet.index,
        features: [{ $type: 'app.bsky.richtext.facet#mention', did }],
      });
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

const rotatedBskySessions = new Map();

async function rotateBskySession({ origin, refreshJwt, fetchImpl }) {
  let pending = rotatedBskySessions.get(refreshJwt);
  if (!pending) {
    if (rotatedBskySessions.size >= 32) {
      rotatedBskySessions.delete(rotatedBskySessions.keys().next().value);
    }
    pending = refreshBskySession({
      serviceUrl: origin,
      refreshJwt,
      fetchImpl,
    }).catch((err) => {
      rotatedBskySessions.delete(refreshJwt);
      throw err;
    });
    rotatedBskySessions.set(refreshJwt, pending);
  }
  const seen = new Set([refreshJwt]);
  let session = await pending;
  while (session?.refreshJwt && !seen.has(session.refreshJwt) && rotatedBskySessions.has(session.refreshJwt)) {
    seen.add(session.refreshJwt);
    session = await rotatedBskySessions.get(session.refreshJwt);
  }
  return session;
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
  cache,
  timeoutMs,
  fetchImpl,
}) {
  if (refreshJwt && typeof onSessionRefreshed !== 'function') {
    throw new Error(`bskyRequest(${endpoint}): refreshJwt requires onSessionRefreshed so rotated tokens are persisted`);
  }
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
      ...(cache !== undefined ? { cache } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
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
      const refreshed = await rotateBskySession({
        origin,
        refreshJwt,
        fetchImpl,
      });
      await onSessionRefreshed(refreshed);
      return runWithToken(refreshed.accessJwt);
    }
    throw err;
  }
}

function rkeyFromAtUri(uri) {
  const parts = String(uri || '').split('/');
  return parts[parts.length - 1] || '';
}

function escapeBskyHtmlText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeBskyHtmlAttr(value) {
  return escapeBskyHtmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function splitUrlAndTrailingSuffix(token) {
  let clean = token.replace(/[.,!?;:]+$/, '');
  while (clean.endsWith(')')) {
    const opens = (clean.match(/\(/g) || []).length;
    const closes = (clean.match(/\)/g) || []).length;
    if (closes > opens) {
      clean = clean.slice(0, -1).replace(/[.,!?;:]+$/, '');
    } else {
      break;
    }
  }
  return { clean, suffix: token.slice(clean.length) };
}

/**
 * Escape a plain-text segment and turn raw http(s):// URLs into external <a> links.
 */
export function linkifyPlainTextSegment(rawSegment) {
  const input = String(rawSegment || '');
  if (!input) return '';
  const urlRe = /(?:^|[\s(])(https?:\/\/[^\s<>[\]{}"']+)/g;
  const parts = [];
  let cursor = 0;

  for (const m of input.matchAll(urlRe)) {
    const token = m[1];
    const tokenStart = m.index + m[0].indexOf(token);
    const { clean, suffix } = splitUrlAndTrailingSuffix(token);
    if (!clean) continue;

    let href = '';
    try {
      const parsed = new URL(clean);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        href = parsed.href;
      }
    } catch {
      href = '';
    }
    if (!href) continue;

    if (tokenStart > cursor) {
      parts.push(escapeBskyHtmlText(input.slice(cursor, tokenStart)));
    }
    parts.push(`<a href="${escapeBskyHtmlAttr(href)}" target="_blank" rel="noopener noreferrer">${formatTruncatedUrlInnerHtml(clean, href)}</a>`);
    if (suffix) {
      parts.push(escapeBskyHtmlText(suffix));
    }
    cursor = tokenStart + token.length;
  }

  if (cursor < input.length) {
    parts.push(escapeBskyHtmlText(input.slice(cursor)));
  }
  return parts.join('');
}

function renderBskyFacetAnchor(label, features = []) {
  for (const feat of Array.isArray(features) ? features : []) {
    const type = String(feat?.$type || '');
    if ((type === 'app.bsky.richtext.facet#link' || (!type && feat?.uri)) && feat?.uri) {
      try {
        const parsed = new URL(String(feat.uri).trim());
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          return `<a href="${escapeBskyHtmlAttr(parsed.href)}" target="_blank" rel="noopener noreferrer">${formatTruncatedUrlInnerHtml(label, parsed.href)}</a>`;
        }
      } catch {
        // Ignore invalid facet link URI
      }
    } else if (type === 'app.bsky.richtext.facet#mention' && feat?.did) {
      const href = `https://bsky.app/profile/${encodeURIComponent(String(feat.did))}`;
      return `<a href="${escapeBskyHtmlAttr(href)}" class="mention" target="_blank" rel="noopener noreferrer">${escapeBskyHtmlText(label)}</a>`;
    } else if (type === 'app.bsky.richtext.facet#tag' && feat?.tag) {
      const href = `https://bsky.app/hashtag/${encodeURIComponent(String(feat.tag))}`;
      return `<a href="${escapeBskyHtmlAttr(href)}" class="hashtag" target="_blank" rel="noopener noreferrer">${escapeBskyHtmlText(label)}</a>`;
    }
  }
  return linkifyPlainTextSegment(label);
}

/**
 * Convert AT Protocol plain text + UTF-8 byte-indexed facets into paragraph-wrapped sanitized HTML.
 */
export function renderBskyRichTextToHtml(text, facets = []) {
  const source = String(text || '');
  if (!source) return '';

  const bytes = utf8Encoder.encode(source);
  const validFacets = (Array.isArray(facets) ? facets : [])
    .filter(
      (f) =>
        Number.isInteger(f?.index?.byteStart) &&
        Number.isInteger(f?.index?.byteEnd) &&
        f.index.byteStart >= 0 &&
        f.index.byteStart < f.index.byteEnd &&
        f.index.byteEnd <= bytes.byteLength
    )
    .sort((a, b) => a.index.byteStart - b.index.byteStart);

  const inlineParts = [];
  let cursor = 0;

  for (const facet of validFacets) {
    const { byteStart, byteEnd } = facet.index;
    if (byteStart < cursor) continue;
    if (byteStart > cursor) {
      inlineParts.push(linkifyPlainTextSegment(utf8Decoder.decode(bytes.subarray(cursor, byteStart))));
    }
    const label = utf8Decoder.decode(bytes.subarray(byteStart, byteEnd));
    inlineParts.push(renderBskyFacetAnchor(label, facet.features));
    cursor = byteEnd;
  }

  if (cursor < bytes.byteLength) {
    inlineParts.push(linkifyPlainTextSegment(utf8Decoder.decode(bytes.subarray(cursor))));
  }

  return inlineParts
    .join('')
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .filter((block) => block.length > 0)
    .map((block) => `<p>${block.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function isDirectAnimatedGifUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '').trim());
    if (parsed.protocol !== 'https:') return false;
    if (/\.gif$/i.test(parsed.pathname)) return true;
    const host = parsed.hostname.toLowerCase();
    const isKnownGifCdn =
      host === 'tenor.com' ||
      host.endsWith('.tenor.com') ||
      host === 'giphy.com' ||
      host.endsWith('.giphy.com') ||
      host === 'klipy.com' ||
      host.endsWith('.klipy.com');
    return isKnownGifCdn && /\.webp$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function extractBskyVideoMedia(embedMedia, recordMedia, post, author) {
  const embType = String(embedMedia?.$type || '');
  if (!embType.startsWith('app.bsky.embed.video') && !embedMedia?.playlist && !recordMedia?.video) {
    return null;
  }
  const cid = String(embedMedia?.cid || recordMedia?.video?.ref?.$link || '');
  const did = String(author?.did || '');
  const mp4Url = did && cid
    ? `https://bsky.social/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(did)}&cid=${encodeURIComponent(cid)}`
    : '';
  const hlsUrl = String(embedMedia?.playlist || '');
  if (!mp4Url && !hlsUrl) return null;

  const ar = embedMedia?.aspectRatio || recordMedia?.aspectRatio || {};
  const width = Number.parseInt(ar.width, 10) > 0 ? Number.parseInt(ar.width, 10) : 640;
  const height = Number.parseInt(ar.height, 10) > 0 ? Number.parseInt(ar.height, 10) : 360;
  const isGif = embedMedia?.presentation === 'gif';
  return {
    id: `${post?.cid || cid || 'vid'}_0`,
    type: isGif ? 'gifv' : 'video',
    mimeType: String(recordMedia?.video?.mimeType || (mp4Url ? 'video/mp4' : 'application/vnd.apple.mpegurl')),
    url: mp4Url || hlsUrl,
    hlsUrl,
    previewUrl: String(embedMedia?.thumbnail || ''),
    description: String(embedMedia?.alt || recordMedia?.alt || ''),
    width,
    height,
    did,
    cid,
  };
}

const BSKY_SENSITIVE_LABELS = new Set([
  'porn',
  'sexual',
  'nudity',
  'graphic-media',
  'gore',
  'corpse',
  'self-harm',
  'torture',
  'nsfw',
  'adult',
  'suggestive',
  '!warn',
]);

function collectBskyModerationLabels(post, record = null, author = null) {
  const out = new Set();
  const pushAll = (arr) => {
    for (const l of Array.isArray(arr) ? arr : []) {
      const val = String(l?.val ?? l ?? '').trim().toLowerCase();
      if (val) out.add(val);
    }
  };
  pushAll(post?.labels);
  pushAll(record?.labels?.values);
  pushAll(author?.labels || post?.author?.labels);
  pushAll(post?.embed?.labels);
  pushAll(post?.embed?.media?.labels);
  pushAll(record?.embed?.labels);
  pushAll(record?.embed?.media?.labels);
  return [...out];
}

function hasSensitiveBskyLabels(labels) {
  return Array.isArray(labels) && labels.some((l) => BSKY_SENSITIVE_LABELS.has(String(l || '').toLowerCase()));
}

function extractBskyQuotePost(rawEmbed) {
  if (!rawEmbed || typeof rawEmbed !== 'object') return null;
  const isWithMedia = String(rawEmbed.$type || '').startsWith('app.bsky.embed.recordWithMedia');
  const rawRec = isWithMedia ? rawEmbed.record?.record : rawEmbed.record;
  if (!rawRec || typeof rawRec !== 'object') return null;

  const recType = String(rawRec.$type || '');
  if (
    recType.includes('viewNotFound') ||
    recType.includes('viewBlocked') ||
    recType.includes('viewDetached') ||
    rawRec.notFound ||
    rawRec.blocked ||
    rawRec.detached
  ) {
    return {
      unavailable: true,
      reason: rawRec.blocked ? 'Quoted post from blocked account' : 'Quoted post unavailable',
    };
  }

  if (!recType.includes('viewRecord') && !(rawRec.value && rawRec.author)) {
    return null;
  }

  const qUri = String(rawRec.uri || '');
  const qCid = String(rawRec.cid || '');
  const qRkey = rkeyFromAtUri(qUri);
  const qAuthor = rawRec.author || {};
  const qHandle = String(qAuthor.handle || qAuthor.did || '');
  const qVal = rawRec.value || {};
  const firstEmbed = Array.isArray(rawRec.embeds) ? rawRec.embeds[0] : null;
  const thumbUrl =
    firstEmbed?.images?.[0]?.thumb ||
    firstEmbed?.images?.[0]?.fullsize ||
    firstEmbed?.thumbnail ||
    firstEmbed?.media?.images?.[0]?.thumb ||
    firstEmbed?.media?.thumbnail ||
    firstEmbed?.external?.thumb ||
    '';
  const qLabels = collectBskyModerationLabels(
    { labels: rawRec.labels, embed: firstEmbed, author: qAuthor },
    qVal,
    qAuthor
  );

  return {
    id: `bluesky:${qUri || qCid}`,
    protocol: 'bluesky',
    uri: qUri,
    cid: qCid,
    authorName: String(qAuthor.displayName || qHandle),
    authorHandle: qHandle,
    authorDid: String(qAuthor.did || ''),
    authorAvatar: String(qAuthor.avatar || ''),
    text: String(qVal.text || ''),
    createdAt: String(qVal.createdAt || rawRec.indexedAt || ''),
    url: qHandle && qRkey ? `https://bsky.app/profile/${qHandle}/post/${qRkey}` : '',
    ...(thumbUrl ? { thumbUrl: String(thumbUrl) } : {}),
    ...(hasSensitiveBskyLabels(qLabels) ? { sensitive: true } : {}),
  };
}

function extractBskyLinkCard(embedMedia) {
  const ext = embedMedia?.external;
  if (!ext || typeof ext !== 'object' || !ext.uri) return null;
  if (isDirectAnimatedGifUrl(ext.uri)) return null;
  try {
    const parsed = new URL(String(ext.uri).trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return {
      url: parsed.href,
      title: String(ext.title || ''),
      description: String(ext.description || ''),
      image: String(ext.thumb || ''),
    };
  } catch {
    return null;
  }
}

function extractBskyReplyContext(rawReply) {
  if (!rawReply || typeof rawReply !== 'object') return null;
  const rawParent = rawReply.parent;
  const rawRoot = rawReply.root;
  const isRenderable = (node) => {
    if (!node || typeof node !== 'object') return false;
    const t = String(node.$type || '');
    if (
      t.includes('notFoundPost')
      || t.includes('blockedPost')
      || node.notFound
      || node.blocked
      || node.detached
    ) {
      return false;
    }
    return Boolean(node.uri && node.author && node.record);
  };
  const parent = isRenderable(rawParent) ? rawParent : (isRenderable(rawRoot) ? rawRoot : null);
  if (!parent) return null;

  const pUri = String(parent.uri || '');
  const pAuthor = parent.author || {};
  const pViewer = pAuthor.viewer || {};
  if (pViewer.muted || pViewer.mutedByList || pViewer.blocking || pViewer.blockedBy || pViewer.blockingByList) {
    return null;
  }

  const pHandle = String(pAuthor.handle || pAuthor.did || '');
  const pRkey = rkeyFromAtUri(pUri);
  const pRecord = parent.record || {};
  const firstEmbed = parent.embed || null;
  const thumbUrl =
    firstEmbed?.images?.[0]?.thumb ||
    firstEmbed?.images?.[0]?.fullsize ||
    firstEmbed?.thumbnail ||
    firstEmbed?.media?.images?.[0]?.thumb ||
    firstEmbed?.media?.thumbnail ||
    firstEmbed?.external?.thumb ||
    '';
  const pLabels = collectBskyModerationLabels(parent, pRecord, pAuthor);

  return {
    id: `bluesky:${pUri}`,
    protocol: 'bluesky',
    uri: pUri,
    cid: String(parent.cid || ''),
    url: pHandle && pRkey ? `https://bsky.app/profile/${pHandle}/post/${pRkey}` : '',
    authorId: String(pAuthor.did || ''),
    authorName: String(pAuthor.displayName || pHandle),
    authorHandle: pHandle,
    authorAvatar: String(pAuthor.avatar || ''),
    text: String(pRecord.text || ''),
    createdAt: String(pRecord.createdAt || parent.indexedAt || ''),
    ...(thumbUrl ? { thumbUrl: String(thumbUrl) } : {}),
    ...(hasSensitiveBskyLabels(pLabels) ? { sensitive: true } : {}),
  };
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
  const rawEmbed = post?.embed || {};
  const embedMedia = String(rawEmbed.$type || '').startsWith('app.bsky.embed.recordWithMedia')
    ? (rawEmbed.media || {})
    : rawEmbed;
  const recordEmbed = record?.embed || {};
  const recordMedia = String(recordEmbed.$type || '').startsWith('app.bsky.embed.recordWithMedia')
    ? (recordEmbed.media || {})
    : recordEmbed;
  const embedImages = Array.isArray(embedMedia?.images) ? embedMedia.images : [];
  const rawBlobImages = embedImages.length === 0 && author?.did && Array.isArray(recordMedia?.images)
    ? recordMedia.images
    : [];
  const videoMedia = extractBskyVideoMedia(embedMedia, recordMedia, post, author);
  const gifExternal = embedMedia?.external && isDirectAnimatedGifUrl(embedMedia.external.uri) ? embedMedia.external : null;
  const linkCard = gifExternal ? null : extractBskyLinkCard(embedMedia);
  const quotePost = extractBskyQuotePost(rawEmbed);
  const replyContext = extractBskyReplyContext(feedItem?.reply);
  const createdAt = record.createdAt || post?.indexedAt || '';
  const facets = Array.isArray(record.facets) ? record.facets : [];
  const labels = collectBskyModerationLabels(post, record, author);

  const media = embedImages.length > 0
    ? embedImages.map((img, idx) => ({
        id: `${post?.cid || 'img'}_${idx}`,
        type: 'image',
        url: img.fullsize || img.thumb || '',
        previewUrl: img.thumb || img.fullsize || '',
        description: img.alt || '',
        width: Number.parseInt(img.aspectRatio?.width, 10) || 0,
        height: Number.parseInt(img.aspectRatio?.height, 10) || 0,
      }))
    : rawBlobImages
        .map((ri, idx) => {
          const blobCid = String(ri?.image?.ref?.$link || ri?.image?.cid || '').trim();
          if (!blobCid || !author?.did) return null;
          const didEnc = encodeURIComponent(String(author.did));
          const cidEnc = encodeURIComponent(blobCid);
          return {
            id: `${post?.cid || 'img'}_${idx}`,
            type: 'image',
            url: `https://cdn.bsky.app/img/feed_fullsize/plain/${didEnc}/${cidEnc}@jpeg`,
            previewUrl: `https://cdn.bsky.app/img/feed_thumbnail/plain/${didEnc}/${cidEnc}@jpeg`,
            description: String(ri?.alt || ''),
            width: Number.parseInt(ri?.aspectRatio?.width, 10) || 0,
            height: Number.parseInt(ri?.aspectRatio?.height, 10) || 0,
          };
        })
        .filter(Boolean);
  if (videoMedia) {
    media.push(videoMedia);
  }
  if (gifExternal) {
    let gifWidth = 0;
    let gifHeight = 0;
    try {
      const parsedGif = new URL(String(gifExternal.uri));
      gifWidth = Number.parseInt(parsedGif.searchParams.get('ww') || '0', 10) || 0;
      gifHeight = Number.parseInt(parsedGif.searchParams.get('hh') || '0', 10) || 0;
    } catch {
      // Ignore query parse
    }
    media.push({
      id: `${post?.cid || 'gif'}_${media.length}`,
      type: 'image',
      mimeType: 'image/gif',
      url: String(gifExternal.uri),
      previewUrl: String(gifExternal.thumb || gifExternal.uri),
      description: String(gifExternal.description || gifExternal.title || '').replace(/^ALT:\s*/i, ''),
      width: gifWidth,
      height: gifHeight,
    });
  }

  const authorViewer = author?.viewer || {};
  const reasonViewer = feedItem?.reason?.by?.viewer || {};

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
          ...(feedItem?.reason?.uri ? { uri: String(feedItem.reason.uri) } : {}),
        }
      : null,
    rebloggedAt: feedItem?.reason?.indexedAt ? String(feedItem.reason.indexedAt) : '',
    text: record.text || '',
    facets,
    sanitizedHtml: renderBskyRichTextToHtml(record.text || '', facets),
    spoilerText: '',
    labels,
    visibility: 'public',
    language: Array.isArray(record.langs) && record.langs[0] ? String(record.langs[0]).trim().toLowerCase() : '',
    langs: Array.isArray(record.langs) ? record.langs.map((l) => String(l || '').trim().toLowerCase()).filter(Boolean) : [],
    media,
    linkCard,
    ...(quotePost ? { quotePost } : {}),
    ...(replyContext ? { replyContext } : {}),
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
      replyDisabled: Boolean(post?.viewer?.replyDisabled),
      viewerMuted: Boolean(authorViewer.muted || authorViewer.mutedByList || reasonViewer.muted || reasonViewer.mutedByList),
      viewerBlocking: Boolean(
        authorViewer.blocking
        || authorViewer.blockedBy
        || authorViewer.blockingByList
        || reasonViewer.blocking
        || reasonViewer.blockedBy
        || reasonViewer.blockingByList
      ),
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
  const rawLabels = Array.isArray(raw?.labels) ? raw.labels : [];
  const loggedOutHidden = rawLabels.some(
    (l) => String(l?.val ?? l ?? '').trim().toLowerCase() === '!no-unauthenticated'
  );
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
      note: description ? renderBskyRichTextToHtml(description, raw?.descriptionFacets) : '',
      noteText: description,
      fields: fields.slice(0, 4),
      publicVisible: !loggedOutHidden,
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

export async function getBskyMutes(opts = {}) {
  const { cursor = '', limit = 100, ...auth } = opts;
  const data = await bskyRequest({
    ...auth,
    endpoint: 'app.bsky.graph.getMutes',
    params: { limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    accounts: Array.isArray(data?.mutes) ? data.mutes.map(normalizeBskyActorSummary) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function getBskyBlocks(opts = {}) {
  const { cursor = '', limit = 100, ...auth } = opts;
  const data = await bskyRequest({
    ...auth,
    endpoint: 'app.bsky.graph.getBlocks',
    params: { limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    accounts: Array.isArray(data?.blocks) ? data.blocks.map(normalizeBskyActorSummary) : [],
    nextCursor: data?.cursor || null,
  };
}

function isActiveMutedWordItem(item, nowMs = Date.now()) {
  if (!item || typeof item !== 'object') return false;
  const val = String(item.value || '').trim();
  if (!val) return false;
  if (item.expiresAt) {
    const expMs = Date.parse(item.expiresAt);
    if (Number.isFinite(expMs) && expMs <= nowMs) return false;
  }
  return true;
}

/**
 * Fetch active Bluesky muted words & tags from app.bsky.actor.getPreferences (mutedWordsPref).
 */
export async function getBskyMutedWords(opts = {}) {
  const data = await bskyRequest({
    ...opts,
    endpoint: 'app.bsky.actor.getPreferences',
  });
  const prefs = Array.isArray(data?.preferences) ? data.preferences : [];
  const mutedPref = prefs.find((p) => p?.$type === 'app.bsky.actor.defs#mutedWordsPref');
  const items = Array.isArray(mutedPref?.items) ? mutedPref.items : [];
  const nowMs = Date.now();
  const out = [];
  const seen = new Set();
  for (const item of items) {
    if (!isActiveMutedWordItem(item, nowMs)) continue;
    const phrase = String(item.value || '').trim();
    const low = phrase.toLowerCase();
    if (seen.has(low)) continue;
    seen.add(low);
    out.push({
      id: `bsky_mw_${item.id || low}`,
      title: phrase,
      phrase,
      keywords: [phrase],
      filter_action: 'hide',
      source: 'bluesky',
    });
  }
  return out;
}

/**
 * Add or remove a muted word/tag in Bluesky app.bsky.actor.defs#mutedWordsPref via putPreferences.
 */
export async function syncBskyMutedWord({ phrase, remove = false, ...auth } = {}) {
  const cleanPhrase = String(phrase || '').trim();
  if (!cleanPhrase) return false;
  const data = await bskyRequest({
    ...auth,
    endpoint: 'app.bsky.actor.getPreferences',
  });
  const prefs = Array.isArray(data?.preferences) ? [...data.preferences] : [];
  const idx = prefs.findIndex((p) => p?.$type === 'app.bsky.actor.defs#mutedWordsPref');
  const curPref = idx >= 0
    ? { ...prefs[idx], items: Array.isArray(prefs[idx].items) ? [...prefs[idx].items] : [] }
    : { $type: 'app.bsky.actor.defs#mutedWordsPref', items: [] };

  const low = cleanPhrase.toLowerCase();
  const filteredItems = curPref.items.filter(
    (item) => String(item?.value || '').trim().toLowerCase() !== low
  );
  if (remove) {
    curPref.items = filteredItems;
  } else {
    curPref.items = [
      ...filteredItems,
      { value: cleanPhrase, targets: ['content', 'tag'] },
    ];
  }

  if (idx >= 0) prefs[idx] = curPref;
  else prefs.push(curPref);

  await bskyRequest({
    ...auth,
    endpoint: 'app.bsky.actor.putPreferences',
    method: 'POST',
    json: { preferences: prefs },
  });
  return true;
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
  publicVisible,
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

  if (typeof publicVisible === 'boolean') {
    const existingLabelVals = Array.isArray(existingValue.labels?.values)
      ? existingValue.labels.values.filter(
          (v) => v && typeof v.val === 'string' && v.val.trim().toLowerCase() !== '!no-unauthenticated'
        )
      : [];
    if (!publicVisible) {
      record.labels = {
        $type: 'com.atproto.label.defs#selfLabels',
        values: [...existingLabelVals, { val: '!no-unauthenticated' }],
      };
    } else if (existingLabelVals.length > 0) {
      record.labels = {
        $type: 'com.atproto.label.defs#selfLabels',
        values: existingLabelVals,
      };
    } else {
      delete record.labels;
    }
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

const bskyMetricsCache = new Map();
const BSKY_METRICS_TTL_MS = 60_000;

/**
 * Batch-fetch and normalize Bluesky posts keyed by ATProto URI via app.bsky.feed.getPosts.
 */
export async function getBskyPostsByUris({ uris = [], ...auth } = {}) {
  const cleanUris = [
    ...new Set(
      (Array.isArray(uris) ? uris : [])
        .map((u) => String(u || '').replace(/^bluesky:/, '').trim())
        .filter((u) => u.startsWith('at://'))
    ),
  ];
  if (cleanUris.length === 0) return {};

  const result = {};
  for (let i = 0; i < cleanUris.length; i += 25) {
    const chunk = cleanUris.slice(i, i + 25);
    try {
      const data = await bskyPublicReadRequest({
        ...auth,
        endpoint: 'app.bsky.feed.getPosts',
        params: { uris: chunk },
      });
      for (const post of Array.isArray(data?.posts) ? data.posts : []) {
        if (!post?.uri) continue;
        result[post.uri] = normalizeBskyPost({ post });
      }
    } catch {
      // Non-fatal post lookup failure
    }
  }
  return result;
}

/**
 * Batch-fetch engagement counts (likes, replies, reposts + quotes) for ATProto URIs via app.bsky.feed.getPosts.
 */
export async function getBskyPostsMetrics({ uris = [], ...auth } = {}) {
  const cleanUris = [
    ...new Set(
      (Array.isArray(uris) ? uris : [])
        .map((u) => String(u || '').replace(/^bluesky:/, '').trim())
        .filter((u) => u.startsWith('at://'))
    ),
  ];
  if (cleanUris.length === 0) return {};

  const useCache = typeof auth.fetchImpl !== 'function';
  const now = Date.now();
  const result = {};
  const toFetch = [];

  for (const uri of cleanUris) {
    const cached = useCache ? bskyMetricsCache.get(uri) : null;
    if (cached && cached.expiresAt > now) {
      result[uri] = { ...cached.value };
    } else {
      toFetch.push(uri);
    }
  }

  for (let i = 0; i < toFetch.length; i += 25) {
    const chunk = toFetch.slice(i, i + 25);
    try {
      const data = await bskyPublicReadRequest({
        ...auth,
        endpoint: 'app.bsky.feed.getPosts',
        params: { uris: chunk },
      });
      for (const post of Array.isArray(data?.posts) ? data.posts : []) {
        if (!post?.uri) continue;
        const m = {
          likes: Number(post.likeCount ?? 0),
          replies: Number(post.replyCount ?? 0),
          reposts: Number(post.repostCount ?? 0) + Number(post.quoteCount ?? 0),
        };
        result[post.uri] = m;
        if (useCache) {
          bskyMetricsCache.set(post.uri, { value: m, expiresAt: now + BSKY_METRICS_TTL_MS });
        }
      }
    } catch {
      // Non-fatal metric batch lookup failure
    }
  }
  return result;
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

export async function getBskyActorLikes(opts = {}) {
  const { actor, limit = 15, cursor = '', ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.getActorLikes',
    params: { actor, limit, ...(cursor ? { cursor } : {}) },
  });
  return {
    items: Array.isArray(data?.feed) ? data.feed.map(normalizeBskyPost) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function getBskyPostLikes(opts = {}) {
  const { uri, limit = 25, cursor = '', ...auth } = opts;
  if (!uri) return { likes: [], nextCursor: null };
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.getLikes',
    params: { uri, limit, ...(cursor ? { cursor } : {}) },
  });
  const likes = (Array.isArray(data?.likes) ? data.likes : [])
    .map((row) => row?.actor)
    .filter((a) => a && (a.did || a.handle));
  return {
    likes,
    nextCursor: data?.cursor || null,
  };
}

export async function getBskySavedFeedUris(opts = {}) {
  if (!opts?.accessJwt) return [];
  const data = await bskyRequest({
    ...opts,
    endpoint: 'app.bsky.actor.getPreferences',
  });
  const prefs = Array.isArray(data?.preferences) ? data.preferences : [];
  const uris = [];
  const seen = new Set();
  const addUri = (raw) => {
    const val = String(raw || '').trim();
    if (!val.startsWith('at://') || !val.includes('/app.bsky.feed.generator/')) return;
    if (seen.has(val)) return;
    seen.add(val);
    uris.push(val);
  };
  for (const pref of prefs) {
    if (!pref || typeof pref !== 'object') continue;
    if (pref.$type === 'app.bsky.actor.defs#savedFeedsPrefV2' && Array.isArray(pref.items)) {
      for (const item of pref.items) {
        if (item?.type === 'feed' || String(item?.value || '').includes('/app.bsky.feed.generator/')) {
          addUri(item.value);
        }
      }
    } else if (pref.$type === 'app.bsky.actor.defs#savedFeedsPref') {
      for (const raw of [...(Array.isArray(pref.pinned) ? pref.pinned : []), ...(Array.isArray(pref.saved) ? pref.saved : [])]) {
        addUri(raw);
      }
    }
  }
  return uris;
}

export async function getBskyPostThread(opts) {
  const { uri, depth = 6, parentHeight = 20, ...auth } = opts;
  let data;
  try {
    data = await bskyPublicReadRequest({
      ...auth,
      endpoint: 'app.bsky.feed.getPostThread',
      params: { uri, depth, parentHeight },
    });
  } catch (err) {
    const rawUri = String(uri || '');
    if (rawUri.startsWith('at://')) {
      const rest = rawUri.slice(5);
      const slashIdx = rest.indexOf('/');
      const authority = slashIdx >= 0 ? rest.slice(0, slashIdx) : '';
      const tail = slashIdx >= 0 ? rest.slice(slashIdx) : '';
      if (authority && !authority.startsWith('did:') && tail) {
        const prof = await bskyPublicReadRequest({
          ...auth,
          endpoint: 'app.bsky.actor.getProfile',
          params: { actor: authority },
        }).catch(() => null);
        if (prof?.did) {
          data = await bskyPublicReadRequest({
            ...auth,
            endpoint: 'app.bsky.feed.getPostThread',
            params: { uri: `at://${prof.did}${tail}`, depth, parentHeight },
          });
        } else {
          throw err;
        }
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }
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
    let resolvedUri = recordUri;
    if (!resolvedUri && targetDid) {
      const listed = await bskyRequest({
        serviceUrl,
        endpoint: 'com.atproto.repo.listRecords',
        params: { repo, collection, limit: 100 },
        accessJwt,
        refreshJwt,
        onSessionRefreshed,
        fetchImpl,
      }).catch(() => ({ records: [] }));
      const match = (listed?.records || []).find((r) => r?.value?.subject === targetDid);
      if (match?.uri) resolvedUri = match.uri;
    }
    if (resolvedUri) {
      await bskyRequest({
        serviceUrl,
        endpoint: 'com.atproto.repo.deleteRecord',
        method: 'POST',
        json: { repo, collection, rkey: rkeyFromAtUri(resolvedUri) },
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
  let resolvedDid = String(targetDid || '').trim();
  if (resolvedDid && !resolvedDid.startsWith('did:')) {
    const cleanHandle = resolvedDid.replace(/^bluesky:/i, '').replace(/^@/, '').trim();
    if (cleanHandle) {
      const res = await bskyRequest({
        ...rest,
        endpoint: 'com.atproto.identity.resolveHandle',
        params: { handle: cleanHandle },
      });
      if (res?.did) resolvedDid = String(res.did);
    }
  }
  const out = await toggleBskyGraphRecord({
    ...rest,
    targetDid: resolvedDid,
    recordUri: blockUri,
    collection: 'app.bsky.graph.block',
    undo: unblock,
  });
  return { blocking: out.active, blockUri: out.active ? (out.uri || 'blocked') : null };
}

export async function hideBskyReply({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  repo,
  rootUri,
  replyUri,
  unhide = false,
  accessJwt,
  refreshJwt,
  onSessionRefreshed,
  fetchImpl,
}) {
  const cleanRoot = String(rootUri || '').replace(/^bluesky:/, '').trim();
  const cleanReply = String(replyUri || '').replace(/^bluesky:/, '').trim();
  if (!cleanRoot.startsWith('at://') || !cleanReply.startsWith('at://')) return false;
  const parts = cleanRoot.slice('at://'.length).split('/');
  if (parts.length < 3) return false;
  const [rootDid, collection, rkey] = parts;
  if (rootDid !== repo || collection !== 'app.bsky.feed.post' || !rkey) return false;

  let record = {
    $type: 'app.bsky.feed.threadgate',
    post: cleanRoot,
    createdAt: new Date().toISOString(),
    hiddenReplies: [],
  };
  try {
    const existing = await bskyRequest({
      serviceUrl,
      endpoint: 'com.atproto.repo.getRecord',
      params: { repo, collection: 'app.bsky.feed.threadgate', rkey },
      accessJwt,
      refreshJwt,
      onSessionRefreshed,
      fetchImpl,
    });
    if (existing?.value && typeof existing.value === 'object') {
      record = {
        ...existing.value,
        $type: 'app.bsky.feed.threadgate',
        post: existing.value.post || cleanRoot,
        createdAt: existing.value.createdAt || new Date().toISOString(),
      };
    }
  } catch {
    // No existing threadgate record
  }

  const cur = Array.isArray(record.hiddenReplies) ? record.hiddenReplies.map(String).filter(Boolean) : [];
  record.hiddenReplies = unhide
    ? cur.filter((u) => u !== cleanReply)
    : [...new Set([...cur, cleanReply])].slice(0, 50);

  await bskyRequest({
    serviceUrl,
    endpoint: 'com.atproto.repo.putRecord',
    method: 'POST',
    json: {
      repo,
      collection: 'app.bsky.feed.threadgate',
      rkey,
      record,
    },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
  return true;
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
  const { query, limit = 20, cursor = '', sort = 'latest', lang = '', ...auth } = opts;
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.feed.searchPosts',
    params: {
      q: query,
      limit,
      ...(sort ? { sort } : {}),
      ...(lang ? { lang } : {}),
      ...(cursor ? { cursor } : {}),
    },
  });
  return {
    items: Array.isArray(data?.posts) ? data.posts.map((p) => normalizeBskyPost({ post: p })) : [],
    nextCursor: data?.cursor || null,
  };
}

export async function searchBskyFeedGenerators(opts = {}) {
  const { query = '', limit = 6, ...auth } = opts;
  const cleanQuery = String(query || '').trim();
  const data = await bskyPublicReadRequest({
    ...auth,
    endpoint: 'app.bsky.unspecced.getPopularFeedGenerators',
    params: { ...(cleanQuery ? { query: cleanQuery } : {}), limit },
  });
  return (Array.isArray(data?.feeds) ? data.feeds : [])
    .map((f) => ({
      uri: String(f?.uri || ''),
      cid: String(f?.cid || ''),
      displayName: String(f?.displayName || ''),
      description: String(f?.description || ''),
      likeCount: Number(f?.likeCount || 0),
      creatorHandle: String(f?.creator?.handle || ''),
      avatar: String(f?.avatar || ''),
    }))
    .filter((f) => f.uri.startsWith('at://'));
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
  externalEmbed = null,
  reply = null,
  sensitive = false,
  selfLabels = [],
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
  if ((sensitive && Array.isArray(images) && images.length > 0) || (Array.isArray(selfLabels) && selfLabels.length > 0)) {
    const labelValues = Array.isArray(selfLabels) && selfLabels.length > 0
      ? selfLabels.map((v) => ({ val: String(v).trim() })).filter((v) => v.val)
      : [{ val: 'sexual' }];
    if (labelValues.length > 0) {
      record.labels = {
        $type: 'com.atproto.label.defs#selfLabels',
        values: labelValues,
      };
    }
  }
  if (Array.isArray(images) && images.length > 0) {
    record.embed = {
      $type: 'app.bsky.embed.images',
      images: images.slice(0, 4).map((img) => ({
        alt: img.alt || '',
        image: img.blob,
      })),
    };
  } else if (externalEmbed && externalEmbed.url) {
    const ext = {
      uri: String(externalEmbed.url),
      title: String(externalEmbed.title || externalEmbed.url).slice(0, 300),
      description: String(externalEmbed.description || '').slice(0, 1000),
    };
    if (externalEmbed.thumb) {
      ext.thumb = externalEmbed.thumb;
    }
    record.embed = {
      $type: 'app.bsky.embed.external',
      external: ext,
    };
  }

  const res = await bskyRequest({
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
  return facets.length && res && typeof res === 'object' ? { ...res, facets } : res;
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

export async function updateBskyConvoRead(opts) {
  const { convoId, messageId = '', ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.updateRead',
    method: 'POST',
    json: { convoId, ...(messageId ? { messageId } : {}) },
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

export async function getBskyConvoLog(opts) {
  const { cursor = '', ...auth } = opts;
  return bskyRequest({
    ...auth,
    endpoint: 'chat.bsky.convo.getLog',
    params: cursor ? { cursor } : {},
    headers: { 'Atproto-Proxy': BLUESKY_CHAT_PROXY },
  });
}

const BSKY_CHAT_REFUSALS = [
  {
    codes: ['NotFollowedBySender'],
    phrases: ['incoming messages to come from someone they follow'],
    text: (who) => `${who} only accepts messages from people they follow.`,
  },
  {
    codes: ['MessagesDisabled', 'RecipientDisabled'],
    phrases: ['disabled incoming messages'],
    text: (who) => `${who} has turned off direct messages.`,
  },
  {
    codes: ['BlockedActor', 'BlockedSubject'],
    phrases: ['block between recipient and sender'],
    text: (who) => (
      who === 'This account'
        ? "You can't message this account because one of you has blocked the other."
        : `You can't message ${who} because one of you has blocked the other.`
    ),
  },
  {
    codes: ['AccountSuspended'],
    phrases: ['account is suspended'],
    text: () => 'This conversation is unavailable because one of the accounts is suspended.',
  },
  {
    codes: ['RecipientNotFound'],
    phrases: [],
    text: (who) => `Couldn't find ${who} on Bluesky.`,
  },
];

/** Plain-language text for known Bluesky chat refusals (recipient settings, blocks, suspension); '' otherwise. */
export function describeBskyChatRefusal(err, peerHandle = '') {
  const body = err?.body && typeof err.body === 'object' ? err.body : null;
  if (!body) return '';
  const code = String(body.error || '');
  const message = String(body.message || '').toLowerCase();
  const clean = String(peerHandle || '').trim().replace(/^@/, '');
  const who = clean ? `@${clean}` : 'This account';
  const hit = BSKY_CHAT_REFUSALS.find(
    (r) => r.codes.includes(code) || r.phrases.some((p) => message.includes(p))
  );
  return hit ? hit.text(who) : '';
}

export async function deleteBskyPost({ serviceUrl = DEFAULT_BSKY_SERVICE, repo, uri, accessJwt, refreshJwt, onSessionRefreshed, fetchImpl }) {
  const rkey = rkeyFromAtUri(uri);
  if (!rkey) return false;
  try {
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
  } catch (err) {
    if (err instanceof FetchError && (err.status === 404 || /RecordNotFound|Could not locate record/i.test(err.message))) {
      return true;
    }
    throw err;
  }
  return true;
}

export async function listBskyNotifications({ serviceUrl = DEFAULT_BSKY_SERVICE, limit = 30, cursor = '', accessJwt, refreshJwt, onSessionRefreshed, cache, fetchImpl }) {
  return bskyRequest({
    serviceUrl,
    endpoint: 'app.bsky.notification.listNotifications',
    params: { limit, ...(cursor ? { cursor } : {}) },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    cache,
    fetchImpl,
  });
}

export async function updateBskyNotificationsSeen({
  serviceUrl = DEFAULT_BSKY_SERVICE,
  seenAt = new Date().toISOString(),
  accessJwt,
  refreshJwt,
  onSessionRefreshed,
  fetchImpl,
}) {
  return bskyRequest({
    serviceUrl,
    endpoint: 'app.bsky.notification.updateSeen',
    method: 'POST',
    json: { seenAt },
    accessJwt,
    refreshJwt,
    onSessionRefreshed,
    fetchImpl,
  });
}

/**
 * Batch-hydrate AT URIs in chunks of 25 via authenticated PDS or public AppView getPosts.
 * @param {{ uris?: Array<string>, timeoutMs?: number, fetchImpl?: Function, serviceUrl?: string, accessJwt?: string, refreshJwt?: string, onSessionRefreshed?: Function }} [options]
 * @returns {Promise<Array<object>>}
 */
export async function getBskyPosts({ uris = [], timeoutMs = 4500, fetchImpl, ...auth } = {}) {
  const cleanUris = [
    ...new Set(
      (Array.isArray(uris) ? uris : [])
        .map((u) => String(u || '').trim())
        .filter((u) => u.startsWith('at://'))
    ),
  ];
  if (cleanUris.length === 0) return [];

  const chunks = [];
  for (let i = 0; i < cleanUris.length; i += 25) {
    chunks.push(cleanUris.slice(i, i + 25));
  }

  const results = await Promise.allSettled(
    chunks.map((chunk) =>
      bskyPublicReadRequest({
        ...auth,
        endpoint: 'app.bsky.feed.getPosts',
        params: { uris: chunk },
        ...(timeoutMs ? { timeoutMs } : {}),
        fetchImpl,
      })
    )
  );

  const hydrated = [];
  for (const res of results) {
    if (res.status !== 'fulfilled') continue;
    for (const postView of Array.isArray(res.value?.posts) ? res.value.posts : []) {
      hydrated.push(normalizeBskyPost({ post: postView }));
    }
  }
  return hydrated;
}

const DEFAULT_JETSTREAM_BLOCKED_LABELS = ['!hide', '!takedown', 'spam'];

function matchesJetstreamMediaFilter(record, mediaFilter) {
  if (!mediaFilter || mediaFilter === 'any') return true;
  const emb = record?.embed;
  const topType = emb && typeof emb === 'object' ? String(emb.$type || '') : '';
  const nestedType = emb && typeof emb === 'object' ? String(emb.media?.$type || '') : '';
  const hasImages = topType === 'app.bsky.embed.images' || nestedType === 'app.bsky.embed.images';
  const hasVideo = topType === 'app.bsky.embed.video' || nestedType === 'app.bsky.embed.video';
  if (mediaFilter === 'text') return !hasImages && !hasVideo;
  if (!emb || typeof emb !== 'object') return false;
  if (mediaFilter === 'images') return hasImages;
  if (mediaFilter === 'video') return hasVideo;
  return hasImages || hasVideo;
}

function collectJetstreamSocketUris(endpoint, {
  targetCount,
  deadlineMs,
  cursorUs,
  mediaFilter,
  preferredLanguage,
  blockedLabelSet,
  recordMatcher = null,
  signal,
  WebSocketImpl,
}) {
  return new Promise((resolve) => {
    const remainingMs = Math.max(0, deadlineMs - Date.now());
    if (remainingMs < 50 || signal?.aborted) {
      resolve({ uris: [], errored: false });
      return;
    }

    const url = `${endpoint}?wantedCollections=app.bsky.feed.post&cursor=${Math.max(0, Math.floor(cursorUs))}`;
    let ws;
    try {
      ws = new WebSocketImpl(url);
    } catch {
      resolve({ uris: [], errored: true });
      return;
    }

    const seen = new Set();
    const preferredUris = [];
    const fallbackUris = [];
    let settled = false;
    let errored = false;

    const cleanup = () => {
      clearTimeout(timer);
      if (signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', onAbort);
      }
      if (ws) {
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
      }
    };

    const finish = (didError = false) => {
      if (settled) return;
      settled = true;
      errored = didError;
      cleanup();
      try {
        ws?.close?.();
      } catch {
        // Ignore already-closed WebSocket
      }
      const uris = [...preferredUris, ...fallbackUris].slice(0, targetCount);
      resolve({ uris, errored });
    };

    const onAbort = () => finish(false);
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => finish(false), remainingMs);

    ws.onmessage = (ev) => {
      if (settled || typeof ev?.data !== 'string') return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg?.kind !== 'commit') return;
      const commit = msg.commit;
      if (
        !commit
        || commit.operation !== 'create'
        || commit.collection !== 'app.bsky.feed.post'
        || !msg.did
        || !commit.rkey
      ) {
        return;
      }
      const record = commit.record;
      if (!record || typeof record !== 'object' || record.reply) return;

      const selfLabels = Array.isArray(record.labels?.values) ? record.labels.values : [];
      if (blockedLabelSet.size > 0 && selfLabels.some((l) => blockedLabelSet.has(String(l?.val ?? l ?? '').trim().toLowerCase()))) {
        return;
      }

      if (preferredLanguage && Array.isArray(record.langs) && record.langs.length > 0) {
        const pref = String(preferredLanguage).trim().toLowerCase().split('-')[0];
        if (pref && !record.langs.some((lang) => String(lang || '').toLowerCase().startsWith(pref))) {
          return;
        }
      }

      if (!matchesJetstreamMediaFilter(record, mediaFilter)) return;

      const verdict = typeof recordMatcher === 'function' ? recordMatcher(record) : 'prefer';
      if (verdict === 'skip') return;

      const atUri = `at://${msg.did}/app.bsky.feed.post/${commit.rkey}`;
      if (seen.has(atUri)) return;
      seen.add(atUri);
      if (verdict === 'prefer') {
        preferredUris.push(atUri);
        if (preferredUris.length >= targetCount) {
          finish(false);
        }
      } else if (fallbackUris.length < targetCount) {
        fallbackUris.push(atUri);
      }
    };

    ws.onerror = () => {
      if (preferredUris.length === 0 && fallbackUris.length === 0) {
        finish(true);
      }
    };

    ws.onclose = () => {
      finish(false);
    };
  });
}

/**
 * Zero-auth client-side Bluesky Jetstream WebSocket burst sampler with 45s ring-buffer
 * rewind (for Ozone labeler propagation) and 25-URI AppView batch hydration.
 */
export async function harvestBlueskyJetstreamBurst({
  targetCount = 60,
  maxDurationMs = 2500,
  cursorRewindMs = 45_000,
  mediaOnly = false,
  mediaFilter = 'any',
  preferredLanguage = '',
  blockedSelfLabels = DEFAULT_JETSTREAM_BLOCKED_LABELS,
  recordMatcher = null,
  signal = null,
  WebSocketImpl = globalThis.WebSocket,
  timeoutMs = 4500,
  fetchImpl,
  ...auth
} = {}) {
  if (typeof WebSocketImpl !== 'function') return [];
  if (NATIVE_NODE_WEBSOCKET && WebSocketImpl === NATIVE_NODE_WEBSOCKET) return [];
  if (signal?.aborted) return [];

  const effMedia = mediaOnly && (!mediaFilter || mediaFilter === 'any') ? 'media' : (mediaFilter || 'any');
  const blockedLabelSet = new Set(
    (Array.isArray(blockedSelfLabels) ? blockedSelfLabels : [])
      .map((l) => String(l || '').trim().toLowerCase())
      .filter(Boolean)
  );
  const deadlineMs = Date.now() + Math.max(100, Number(maxDurationMs) || 2500);
  const cursorUs = (Date.now() - Math.max(0, Number(cursorRewindMs) || 0)) * 1000;

  let uris = [];
  for (let i = 0; i < JETSTREAM_ENDPOINTS.length; i += 1) {
    if (signal?.aborted || Date.now() >= deadlineMs) break;
    const res = await collectJetstreamSocketUris(JETSTREAM_ENDPOINTS[i], {
      targetCount: Math.max(1, Number(targetCount) || 60),
      deadlineMs,
      cursorUs,
      mediaFilter: effMedia,
      preferredLanguage,
      blockedLabelSet,
      recordMatcher,
      signal,
      WebSocketImpl,
    });
    if (res.uris.length > 0) {
      uris = res.uris;
      break;
    }
    if (!res.errored && Date.now() >= deadlineMs) break;
  }

  if (uris.length === 0 || signal?.aborted) return [];
  return getBskyPosts({ uris, timeoutMs, fetchImpl, ...auth });
}
