import {
  DEFAULT_THREADS_SCOPES,
  THREADS_GRAPH_BASE,
  THREADS_OAUTH_AUTHORIZE_URL,
  THREADS_TOKEN_BASE,
  isAllowedSocialUrl,
  isTailscaleFunnelUrl,
} from '../constants/endpoints.js';
import { plainTextToHtml } from '../core/schema/unifiedItem.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { FetchError } from './fetch/FetchError.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';
import { requestThreadsInsightsBatch, requestThreadsProxy } from './sanctuary.js';

function extractThreadsProxyError(body, status) {
  if (body && typeof body === 'object') {
    if (body.error && typeof body.error === 'object') {
      const msg = body.error.error_user_msg || body.error.message;
      if (msg) return String(msg).trim();
    }
    if (typeof body.error === 'string' && body.error) return body.error;
    if (typeof body.error_message === 'string' && body.error_message) return body.error_message;
    if (typeof body.message === 'string' && body.message) return body.message;
  }
  if (typeof body === 'string' && body.trim()) return body.trim();
  return `HTTP ${status}`;
}

async function threadsFetch(url, options = {}) {
  const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
  if (typeof options.fetchImpl !== 'function' && !isNative) {
    const method = String(options.method || 'GET').toUpperCase();
    const body = options.body instanceof URLSearchParams
      ? options.body.toString()
      : (typeof options.body === 'string' ? options.body : '');
    const relayed = await requestThreadsProxy({
      url: String(url),
      method,
      body,
      ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    });
    if (relayed && typeof relayed.status === 'number') {
      if (relayed.status >= 200 && relayed.status < 300) {
        return relayed.body;
      }
      throw new FetchError(extractThreadsProxyError(relayed.body, relayed.status), {
        status: relayed.status,
        url: String(url),
        body: relayed.body,
      });
    }
  }
  return fetchWrapper(url, options);
}

const THREADS_DELETE_PERM_MSG =
  "Threads token lacks 'threads_delete' permission. Enable threads_delete under Use Cases → Permissions in your Meta App and update your token.";
const THREADS_MANAGE_REPLIES_PERM_MSG =
  "Threads token lacks 'threads_manage_replies' permission. Enable threads_manage_replies under Use Cases → Permissions in your Meta App and update your token.";
const THREADS_TRANSIENT_LAG_RE = /2207027|4279009|cannot be found|does not exist|not ready|processing|"is_transient":\s*true/i;

function isExplicitThreadsLag(err) {
  if (!(err instanceof FetchError)) return false;
  const rawErr = `${err.message || ''} ${JSON.stringify(err.body || '')}`;
  return THREADS_TRANSIENT_LAG_RE.test(rawErr);
}

function isTransientThreadsLag(err) {
  if (!(err instanceof FetchError)) return false;
  if (isExplicitThreadsLag(err)) return true;
  if (err.status === 502 || err.status === 504) return false;
  return err.status >= 500;
}

function isThreadsVideoAttachment(att, resolvedUrl = '') {
  const t = String(att?.type || '').toLowerCase();
  const m = String(att?.mimeType || att?.mime_type || att?.file?.type || att?.blob?.type || '').toLowerCase();
  const u = String(resolvedUrl || att?.url || '').split(/[?#]/)[0].toLowerCase();
  return t === 'video' || t === 'gifv' || m.startsWith('video/') || /\.(?:mp4|webm|mov|m4v)$/.test(u);
}

function extractThreadsErrorMessage(err, fallback = 'Threads request failed') {
  const errObj = err?.body?.error && typeof err.body.error === 'object' ? err.body.error : null;
  if (errObj?.error_user_msg || errObj?.message) {
    return String(errObj.error_user_msg || errObj.message).trim();
  }
  return err?.message || fallback;
}

export const THREADS_POST_FIELDS =
  'id,media_product_type,media_type,media_url,thumbnail_url,permalink,username,text,timestamp,shortcode,is_quote_post,alt_text,link_attachment_url,topic_tag,replied_to,root_post,children{id,media_type,media_url,thumbnail_url,alt_text}';

export const THREADS_REPLY_FIELDS =
  'id,text,username,timestamp,permalink,media_type,media_url,thumbnail_url,alt_text,replied_to,root_post,hide_status';

export function cleanThreadsAuthCode(rawCodeOrUrl) {
  const raw = String(rawCodeOrUrl || '').trim();
  if (!raw) return '';
  let params = null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      params = new URL(raw).searchParams;
    } catch {
      params = null;
    }
  } else if (raw.includes('code=') || raw.includes('error=')) {
    params = new URLSearchParams(raw.replace(/^[?#]+/, '').replace(/#_$/, ''));
  }
  if (params) {
    const errDesc = params.get('error_description') || params.get('error');
    if (errDesc) {
      throw new Error(String(errDesc));
    }
    const code = params.get('code') || '';
    return code.replace(/#_$/, '').trim();
  }
  return raw.replace(/#_$/, '').trim();
}

export function buildThreadsAuthorizeUrl({
  clientId,
  redirectUri,
  scope = DEFAULT_THREADS_SCOPES,
  state = '',
}) {
  const url = new URL(THREADS_OAUTH_AUTHORIZE_URL);
  url.searchParams.set('client_id', String(clientId || '').trim());
  url.searchParams.set('redirect_uri', String(redirectUri || '').trim());
  url.searchParams.set('scope', String(scope || DEFAULT_THREADS_SCOPES).trim());
  url.searchParams.set('response_type', 'code');
  if (state) url.searchParams.set('state', String(state));
  return url.href;
}

export async function exchangeThreadsOAuthCode({
  clientId,
  clientSecret,
  redirectUri,
  code,
  fetchImpl,
}) {
  const cleaned = cleanThreadsAuthCode(code);
  if (!cleaned) {
    throw new Error('Threads authorization code is required.');
  }
  const params = new URLSearchParams({
    client_id: String(clientId || '').trim(),
    client_secret: String(clientSecret || '').trim(),
    grant_type: 'authorization_code',
    redirect_uri: String(redirectUri || '').trim(),
    code: cleaned,
  });
  return threadsFetch(`${THREADS_TOKEN_BASE}/oauth/access_token`, {
    method: 'POST',
    body: params,
    fetchImpl,
  });
}

export async function exchangeThreadsLongLivedToken({
  clientSecret,
  accessToken,
  fetchImpl,
}) {
  const qs = new URLSearchParams({
    grant_type: 'th_exchange_token',
    client_secret: String(clientSecret || '').trim(),
    access_token: String(accessToken || '').trim(),
  });
  return threadsFetch(`${THREADS_TOKEN_BASE}/access_token?${qs.toString()}`, { fetchImpl });
}

export async function refreshThreadsLongLivedToken({ accessToken, fetchImpl }) {
  const qs = new URLSearchParams({
    grant_type: 'th_refresh_token',
    access_token: String(accessToken || '').trim(),
  });
  return threadsFetch(`${THREADS_TOKEN_BASE}/refresh_access_token?${qs.toString()}`, { fetchImpl });
}

export function sanitizeThreadsTopicTag(tag) {
  return String(tag || '')
    .replace(/^#+/, '')
    .replace(/[.&]/g, '')
    .trim()
    .slice(0, 50);
}

export function extractThreadsLinkAttachment(text, explicitUrl = '') {
  if (explicitUrl && isAllowedSocialUrl(explicitUrl)) {
    return new URL(explicitUrl).href;
  }
  const source = String(text || '');
  if (!source) return '';
  const urlRe = /(?:^|[\s(])(https?:\/\/[^\s<>[\]{}"']+)/g;
  const unique = [];
  const seen = new Set();
  for (const m of source.matchAll(urlRe)) {
    let clean = m[1].replace(/[.,!?;:]+$/, '');
    while (clean.endsWith(')')) {
      const opens = (clean.match(/\(/g) || []).length;
      const closes = (clean.match(/\)/g) || []).length;
      if (closes > opens) {
        clean = clean.slice(0, -1).replace(/[.,!?;:]+$/, '');
      } else {
        break;
      }
    }
    if (!clean || !isAllowedSocialUrl(clean)) continue;
    const href = new URL(clean).href;
    if (!seen.has(href)) {
      seen.add(href);
      unique.push(href);
    }
  }
  return unique.length >= 1 && unique.length <= 5 ? unique[0] : '';
}

function isReachableThreadsMediaUrl(url) {
  return isAllowedSocialUrl(url) || isTailscaleFunnelUrl(url);
}

function sleep(ms) {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t?.unref?.();
  });
}

/**
 * Resolve a public HTTPS media URL suitable for Meta Threads Graph API containers.
 * Prefers Mastodon's returned public CDN URL when already uploaded, then direct HTTPS URLs,
 * and finally joins relative paths onto the user's configured publicMediaBaseUrl.
 *
 * @param {object | string} attachment
 * @param {{ mastodonUploadedUrl?: string, publicMediaBaseUrl?: string }} [options]
 * @returns {string}
 */
export function resolveThreadsMediaUrl(
  attachment,
  { mastodonUploadedUrl = '', publicMediaBaseUrl = '' } = {}
) {
  if (mastodonUploadedUrl && isAllowedSocialUrl(mastodonUploadedUrl)) {
    return new URL(mastodonUploadedUrl).href;
  }
  const rawUrl = typeof attachment === 'string' ? attachment : attachment?.url || '';
  if (rawUrl && isReachableThreadsMediaUrl(rawUrl)) {
    return new URL(rawUrl).href;
  }
  if (rawUrl && rawUrl.startsWith('/') && publicMediaBaseUrl && isReachableThreadsMediaUrl(publicMediaBaseUrl)) {
    const base = new URL(publicMediaBaseUrl).origin;
    const combined = `${base}${rawUrl}`;
    if (isReachableThreadsMediaUrl(combined)) {
      return combined;
    }
  }
  throw new Error(
    'Threads cross-posting with media requires uploading to Mastodon first or configuring a public HTTPS media base URL in Profile.'
  );
}

/**
 * Step 1: Create an unpublished Threads media container.
 */
export async function createThreadsContainer({
  userId,
  accessToken,
  mediaType = 'TEXT',
  text = '',
  imageUrl = '',
  videoUrl = '',
  altText = '',
  children = [],
  isCarouselItem = false,
  replyToId = '',
  linkAttachment = '',
  topicTag = '',
  quotePostId = '',
  replyControl = '',
  pollDelayMs = 600,
  fetchImpl,
}) {
  const params = new URLSearchParams({
    media_type: mediaType,
    access_token: accessToken,
  });
  if (text && !isCarouselItem) params.set('text', text);
  if (imageUrl) params.set('image_url', imageUrl);
  if (videoUrl) params.set('video_url', videoUrl);
  if (altText) params.set('alt_text', altText);
  if (isCarouselItem) params.set('is_carousel_item', 'true');
  if (replyToId) params.set('reply_to_id', replyToId);
  if (!isCarouselItem) {
    if (mediaType === 'TEXT') {
      const resolvedLink = extractThreadsLinkAttachment(text, linkAttachment);
      if (resolvedLink) params.set('link_attachment', resolvedLink);
    } else if (linkAttachment && isAllowedSocialUrl(linkAttachment)) {
      params.set('link_attachment', new URL(linkAttachment).href);
    }
    const cleanTag = sanitizeThreadsTopicTag(topicTag);
    if (cleanTag) params.set('topic_tag', cleanTag);
    if (quotePostId) params.set('quote_post_id', String(quotePostId));
    if (replyControl) params.set('reply_control', String(replyControl));
  }
  if (Array.isArray(children) && children.length > 0) {
    params.set('children', children.join(','));
  }

  const endpoint = `${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads`;
  const maxAttempts = replyToId ? 4 : 2;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await threadsFetch(endpoint, {
        method: 'POST',
        body: params,
        fetchImpl,
      });
    } catch (err) {
      lastErr = err;
      const canRetry = replyToId ? isTransientThreadsLag(err) : isExplicitThreadsLag(err);
      if (attempt + 1 < maxAttempts && canRetry) {
        if (pollDelayMs > 0) await sleep(pollDelayMs * (1 + attempt * 0.75));
        continue;
      }
      throw new Error(extractThreadsErrorMessage(err, 'Threads container creation failed'));
    }
  }
  throw new Error(extractThreadsErrorMessage(lastErr, 'Threads container creation failed'));
}

export async function getThreadsContainerStatus({ containerId, accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(containerId)}?fields=id,status,error_message&access_token=${encodeURIComponent(accessToken)}`;
  return threadsFetch(url, { fetchImpl });
}

export async function waitThreadsContainerReady({
  containerId,
  accessToken,
  pollDelayMs = 800,
  maxPolls = 15,
  fetchImpl,
}) {
  for (let i = 0; i < maxPolls; i += 1) {
    let info;
    try {
      info = await getThreadsContainerStatus({ containerId, accessToken, fetchImpl });
    } catch (err) {
      if (isTransientThreadsLag(err)) {
        if (pollDelayMs > 0) await sleep(pollDelayMs);
        continue;
      }
      throw err;
    }
    if (!info?.status || info.status === 'FINISHED' || info.status === 'PUBLISHED') {
      return info;
    }
    if (info.status === 'ERROR' || info.status === 'EXPIRED') {
      throw new Error(info.error_message || `Threads container failed (${info.status})`);
    }
    if (pollDelayMs > 0) await sleep(pollDelayMs);
  }
  throw new Error('Timed out waiting for Threads media container to finish processing');
}

/**
 * Step 2: Publish a created Threads container.
 */
export async function publishThreadsContainer({ userId, accessToken, creationId, pollDelayMs = 800, fetchImpl }) {
  const endpoint = `${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads_publish`;
  const runPublish = () =>
    threadsFetch(endpoint, {
      method: 'POST',
      body: new URLSearchParams({
        creation_id: creationId,
        access_token: accessToken,
      }),
      fetchImpl,
    });
  const maxAttempts = 5;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await runPublish();
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < maxAttempts && isTransientThreadsLag(err)) {
        const waitMs = pollDelayMs > 0 ? Math.round(pollDelayMs * (1 + attempt * 0.75)) : 0;
        const t0 = Date.now();
        const readyInfo = await waitThreadsContainerReady({
          containerId: creationId,
          accessToken,
          pollDelayMs: waitMs,
          maxPolls: 6,
          fetchImpl,
        });
        if (String(readyInfo?.status || '').toUpperCase() === 'PUBLISHED') {
          return { id: String(readyInfo.id || creationId) };
        }
        const elapsed = Date.now() - t0;
        if (waitMs > 0 && elapsed < waitMs * 0.5) {
          await sleep(waitMs);
        }
        continue;
      }
      if (err instanceof FetchError) {
        throw new Error(extractThreadsErrorMessage(err, 'Threads publish failed'));
      }
      throw err;
    }
  }
  throw new Error(extractThreadsErrorMessage(lastErr, 'Threads publish failed'));
}

/**
 * Headless user-initiated Threads publish supporting TEXT, single IMAGE/VIDEO, or CAROUSEL.
 */
export async function publishThreadsPost({
  userId,
  accessToken,
  text = '',
  media = [],
  mastodonUrls = [],
  publicMediaBaseUrl = '',
  replyToId = '',
  linkAttachment = '',
  topicTag = '',
  quotePostId = '',
  replyControl = '',
  pollDelayMs = 1000,
  fetchImpl,
}) {
  const items = Array.isArray(media) ? media : [];
  if (items.length === 0) {
    const created = await createThreadsContainer({
      userId,
      accessToken,
      mediaType: 'TEXT',
      text,
      replyToId,
      linkAttachment,
      topicTag,
      quotePostId,
      replyControl,
      pollDelayMs,
      fetchImpl,
    });
    return publishThreadsContainer({
      userId,
      accessToken,
      creationId: created.id,
      pollDelayMs,
      fetchImpl,
    });
  }

  if (items.length === 1) {
    const att = items[0];
    const resolvedUrl = resolveThreadsMediaUrl(att, {
      mastodonUploadedUrl: mastodonUrls[0] || '',
      publicMediaBaseUrl,
    });
    const isVideo = isThreadsVideoAttachment(att, resolvedUrl);
    const created = await createThreadsContainer({
      userId,
      accessToken,
      mediaType: isVideo ? 'VIDEO' : 'IMAGE',
      text,
      ...(isVideo ? { videoUrl: resolvedUrl } : { imageUrl: resolvedUrl }),
      altText: att?.altText || att?.description || '',
      replyToId,
      topicTag,
      quotePostId,
      replyControl,
      pollDelayMs,
      fetchImpl,
    });
    const readyPollDelay = isVideo && pollDelayMs >= 500 ? Math.max(pollDelayMs, 2000) : pollDelayMs;
    const readyMaxPolls = isVideo && pollDelayMs >= 500 ? 60 : 15;
    await waitThreadsContainerReady({
      containerId: created.id,
      accessToken,
      pollDelayMs: readyPollDelay,
      maxPolls: readyMaxPolls,
      fetchImpl,
    });
    return publishThreadsContainer({
      userId,
      accessToken,
      creationId: created.id,
      pollDelayMs,
      fetchImpl,
    });
  }

  const childIds = [];
  for (let i = 0; i < Math.min(items.length, 10); i += 1) {
    const att = items[i];
    const resolvedUrl = resolveThreadsMediaUrl(att, {
      mastodonUploadedUrl: mastodonUrls[i] || '',
      publicMediaBaseUrl,
    });
    const isVideo = isThreadsVideoAttachment(att, resolvedUrl);
    const child = await createThreadsContainer({
      userId,
      accessToken,
      mediaType: isVideo ? 'VIDEO' : 'IMAGE',
      ...(isVideo ? { videoUrl: resolvedUrl } : { imageUrl: resolvedUrl }),
      altText: att?.altText || att?.description || '',
      isCarouselItem: true,
      pollDelayMs,
      fetchImpl,
    });
    const readyPollDelay = isVideo && pollDelayMs >= 500 ? Math.max(pollDelayMs, 2000) : pollDelayMs;
    const readyMaxPolls = isVideo && pollDelayMs >= 500 ? 60 : 15;
    await waitThreadsContainerReady({
      containerId: child.id,
      accessToken,
      pollDelayMs: readyPollDelay,
      maxPolls: readyMaxPolls,
      fetchImpl,
    });
    childIds.push(child.id);
  }

  const carousel = await createThreadsContainer({
    userId,
    accessToken,
    mediaType: 'CAROUSEL',
    text,
    children: childIds,
    replyToId,
    topicTag,
    quotePostId,
    replyControl,
    pollDelayMs,
    fetchImpl,
  });
  return publishThreadsContainer({
    userId,
    accessToken,
    creationId: carousel.id,
    pollDelayMs,
    fetchImpl,
  });
}

function mapThreadsAttachment(node, fallbackAlt = '') {
  const url = String(node?.media_url || '').trim();
  if (!url) return null;
  const mt = String(node?.media_type || '').toUpperCase();
  const mimeType = mt === 'VIDEO' ? 'video/mp4' : mt === 'AUDIO' ? 'audio/mpeg' : 'image/jpeg';
  return {
    url,
    mime_type: mimeType,
    alt_text: String(node?.alt_text || fallbackAlt || ''),
    ...(node?.thumbnail_url ? { preview_url: String(node.thumbnail_url) } : {}),
  };
}

/**
 * Normalize a Threads Graph API post or reply object into UnifiedItem.
 */
export function normalizeThreadsPostRecord(raw = {}, authorProfile = {}) {
  const postId = String(raw?.id || '').trim();
  const text = String(raw?.text || '');
  const username = String(raw?.username || authorProfile?.username || authorProfile?.handle || '').replace(/^@/, '');
  const childRows = Array.isArray(raw?.children?.data) ? raw.children.data : [];
  const attachments = childRows.length > 0
    ? childRows.map((child) => mapThreadsAttachment(child, raw?.alt_text)).filter(Boolean)
    : [mapThreadsAttachment(raw)].filter(Boolean);

  const mediaType = String(raw?.media_type || '').trim();
  const threadsMeta = {
    postId,
    ...(mediaType ? { mediaType } : {}),
    ...(mediaType === 'REPOST_FACADE' ? { isRepost: true } : {}),
    ...(raw?.shortcode ? { shortcode: String(raw.shortcode) } : {}),
    ...(raw?.topic_tag ? { topicTag: String(raw.topic_tag) } : {}),
    ...(raw?.is_quote_post ? { isQuotePost: true } : {}),
    ...(raw?.replied_to?.id ? { repliedToId: String(raw.replied_to.id), parentPostId: String(raw.replied_to.id) } : {}),
    ...(raw?.root_post?.id ? { rootPostId: String(raw.root_post.id) } : {}),
    ...(raw?.hide_status ? { hideStatus: String(raw.hide_status) } : {}),
  };

  const meta = { threads: threadsMeta };
  if (raw?.link_attachment_url && isAllowedSocialUrl(raw.link_attachment_url)) {
    const parsedLink = new URL(raw.link_attachment_url);
    meta.linkCard = {
      url: parsedLink.href,
      title: parsedLink.hostname,
      description: '',
      image: '',
    };
  }

  return {
    id: `threads:${postId}`,
    protocol: 'threads',
    url: String(raw?.permalink || (username && postId ? `https://www.threads.net/@${username}/post/${postId}` : '')),
    content_html: plainTextToHtml(text),
    content_text: text,
    date_published: String(raw?.timestamp || new Date().toISOString()),
    author: {
      id: String(authorProfile?.userId || authorProfile?.id || username || postId),
      name: String(authorProfile?.displayName || authorProfile?.name || username || 'Threads user'),
      handle: username,
      avatar_url: String(authorProfile?.avatar || authorProfile?.threads_profile_picture_url || ''),
      url: username ? `https://www.threads.net/@${username}` : '',
    },
    attachments,
    metrics: { replies: 0, reposts: 0, likes: 0 },
    _meta: meta,
  };
}

/**
 * Resolve authenticated user's Threads ID, handle, bio, verified flag, and avatar from an access token.
 */
export async function verifyThreadsCredentials({ accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/me?fields=id,username,name,threads_profile_picture_url,threads_biography,is_verified&access_token=${encodeURIComponent(accessToken)}`;
  return threadsFetch(url, { fetchImpl });
}

/**
 * Read only the authenticated user's own Threads posts (never algorithmic feeds).
 */
export async function getOwnThreadsPosts({ userId, accessToken, limit = 20, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads?fields=${encodeURIComponent(THREADS_POST_FIELDS)}&limit=${limit}&access_token=${encodeURIComponent(accessToken)}`;
  return threadsFetch(url, { fetchImpl });
}

export async function getThreadsPost({ postId, accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}?fields=${encodeURIComponent(THREADS_POST_FIELDS)}&access_token=${encodeURIComponent(accessToken)}`;
  try {
    return await threadsFetch(url, { fetchImpl });
  } catch (err) {
    if (err instanceof FetchError && err.status >= 400 && err.status !== 404) {
      const fallbackUrl = `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}?fields=${encodeURIComponent(THREADS_REPLY_FIELDS)}&access_token=${encodeURIComponent(accessToken)}`;
      return threadsFetch(fallbackUrl, { fetchImpl });
    }
    throw err;
  }
}

/**
 * Read direct replies to one of the authenticated user's own Threads posts.
 */
export async function getThreadsPostReplies({ postId, accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}/replies?fields=${encodeURIComponent(THREADS_REPLY_FIELDS)}&access_token=${encodeURIComponent(accessToken)}`;
  return threadsFetch(url, { fetchImpl });
}

const threadsInsightsCache = new Map();
const threadsInsightsInFlight = new Map();
const threadsInsightsLastGood = new Map();
const THREADS_INSIGHTS_TTL_MS = 60_000;
const THREADS_INSIGHTS_ERR_TTL_MS = 8_000;

export function clearThreadsInsightsCacheForTests() {
  threadsInsightsCache.clear();
  threadsInsightsInFlight.clear();
  threadsInsightsLastGood.clear();
}

/**
 * Fetch engagement counts (likes, replies, reposts + quotes) for a Threads post via /{media-id}/insights.
 * Returns null silently when threads_manage_insights permission is missing or rate-limited.
 */
export async function getThreadsPostInsights({ postId, accessToken, fetchImpl } = {}) {
  const cleanId = String(postId || '').replace(/^threads:(?:notif:)?/, '').trim();
  if (!cleanId || !accessToken) return null;

  const useCache = typeof fetchImpl !== 'function';
  const now = Date.now();
  if (useCache) {
    const cached = threadsInsightsCache.get(cleanId);
    if (cached && cached.expiresAt > now) {
      return cached.value ? { ...cached.value } : null;
    }
    const pending = threadsInsightsInFlight.get(cleanId);
    if (pending) {
      const res = await pending;
      return res ? { ...res } : null;
    }
  }

  const run = async () => {
    const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(cleanId)}/insights?metric=likes,replies,reposts,quotes&access_token=${encodeURIComponent(accessToken)}`;
    try {
      const body = await threadsFetch(url, { fetchImpl, background: true, timeoutMs: 12000 });
      const rows = Array.isArray(body?.data) ? body.data : [];
      let likes = 0;
      let replies = 0;
      let reposts = 0;
      let quotes = 0;
      for (const row of rows) {
        const name = String(row?.name || '').toLowerCase();
        const val = Number(row?.total_value?.value ?? row?.values?.[0]?.value ?? 0) || 0;
        if (name === 'likes') likes = val;
        else if (name === 'replies') replies = val;
        else if (name === 'reposts') reposts = val;
        else if (name === 'quotes') quotes = val;
      }
      const metrics = { likes, replies, reposts: reposts + quotes };
      if (useCache) {
        const doneNow = Date.now();
        threadsInsightsCache.set(cleanId, { value: metrics, expiresAt: doneNow + THREADS_INSIGHTS_TTL_MS });
        threadsInsightsLastGood.set(cleanId, metrics);
      }
      return metrics;
    } catch {
      const lastGood = useCache ? threadsInsightsLastGood.get(cleanId) : null;
      if (lastGood) {
        return { ...lastGood };
      }
      const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
      if (useCache && (connectionStore.get().mode === 'online' || isNative)) {
        threadsInsightsCache.set(cleanId, { value: null, expiresAt: Date.now() + THREADS_INSIGHTS_ERR_TTL_MS });
      }
      return null;
    } finally {
      if (useCache) threadsInsightsInFlight.delete(cleanId);
    }
  };

  if (useCache) {
    const p = run();
    threadsInsightsInFlight.set(cleanId, p);
    const res = await p;
    return res ? { ...res } : null;
  }
  return run();
}

export async function getThreadsPostsInsightsBatch({ postIds = [], accessToken = '', forceRefresh = false, fetchImpl } = {}) {
  if (!accessToken) return {};
  const cleanIds = [];
  const seen = new Set();
  for (const raw of Array.isArray(postIds) ? postIds : []) {
    const cid = String(raw || '').replace(/^threads:(?:notif:)?/, '').trim();
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    cleanIds.push(cid);
    if (cleanIds.length >= 30) break;
  }
  if (cleanIds.length === 0) return {};

  const useCache = !forceRefresh && typeof fetchImpl !== 'function';
  const now = Date.now();
  const out = {};
  const missingIds = [];
  for (const cid of cleanIds) {
    if (useCache) {
      const cached = threadsInsightsCache.get(cid);
      if (cached && cached.expiresAt > now) {
        if (cached.value) out[cid] = { ...cached.value };
        continue;
      }
    }
    missingIds.push(cid);
  }

  if (missingIds.length === 0) return out;

  const isNative = Boolean(globalThis.Capacitor?.isNativePlatform?.());
  if (useCache && !isNative) {
    const batchResults = await requestThreadsInsightsBatch({ postIds: missingIds, accessToken });
    if (batchResults && typeof batchResults === 'object') {
      const doneNow = Date.now();
      for (const cid of missingIds) {
        const entry = batchResults[cid];
        if (entry && typeof entry === 'object') {
          const metrics = {
            likes: Number(entry.likes || 0),
            replies: Number(entry.replies || 0),
            reposts: Number(entry.reposts || 0),
          };
          out[cid] = metrics;
          threadsInsightsCache.set(cid, { value: metrics, expiresAt: doneNow + THREADS_INSIGHTS_TTL_MS });
          threadsInsightsLastGood.set(cid, metrics);
        } else if (threadsInsightsLastGood.has(cid)) {
          out[cid] = { ...threadsInsightsLastGood.get(cid) };
        }
      }
      return out;
    }
  }

  let cursor = 0;
  const workerCount = Math.min(4, missingIds.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < missingIds.length) {
        const cid = missingIds[cursor++];
        const res = await getThreadsPostInsights({ postId: cid, accessToken, fetchImpl }).catch(() => null);
        if (res && typeof res === 'object') {
          out[cid] = res;
        }
      }
    })
  );
  return out;
}

/**
 * Read the full conversation thread beneath a Threads post (requires threads_read_replies).
 */
export async function getThreadsConversation({ postId, accessToken, reverse = false, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}/conversation?fields=${encodeURIComponent(THREADS_REPLY_FIELDS)}&reverse=${reverse ? 'true' : 'false'}&access_token=${encodeURIComponent(accessToken)}`;
  return threadsFetch(url, { fetchImpl });
}

export async function getThreadsMentions({ accessToken, limit = 20, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/me/mentions?fields=${encodeURIComponent(THREADS_POST_FIELDS)}&limit=${limit}&access_token=${encodeURIComponent(accessToken)}`;
  return threadsFetch(url, { fetchImpl });
}

export async function searchThreadsKeyword({
  query,
  searchType = 'TOP',
  searchMode = 'KEYWORD',
  limit = 15,
  accessToken,
  timeoutMs,
  fetchImpl,
}) {
  const qs = new URLSearchParams({
    q: String(query || '').trim(),
    search_type: searchType,
    search_mode: searchMode,
    fields: THREADS_POST_FIELDS,
    limit: String(limit),
    access_token: accessToken,
  });
  return threadsFetch(`${THREADS_GRAPH_BASE}/keyword_search?${qs.toString()}`, {
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
}

export async function lookupThreadsProfile({ username, accessToken, fetchImpl }) {
  const clean = String(username || '').trim().replace(/^@/, '');
  const qs = new URLSearchParams({
    username: clean,
    fields: 'username,name,profile_picture_url,biography,follower_count,is_verified',
    access_token: accessToken,
  });
  return threadsFetch(`${THREADS_GRAPH_BASE}/profile_lookup?${qs.toString()}`, { fetchImpl });
}

export async function manageThreadsReply({ replyId, accessToken, hide = true, fetchImpl }) {
  const cleanId = String(replyId || '').replace(/^threads:(?:notif:)?/, '').trim();
  if (!cleanId) return { success: false };
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(cleanId)}/manage_reply`;
  try {
    return await threadsFetch(url, {
      method: 'POST',
      body: new URLSearchParams({
        hide: hide ? 'true' : 'false',
        access_token: accessToken,
      }),
      fetchImpl,
    });
  } catch (err) {
    if (err instanceof FetchError) {
      if (err.status === 404) return { success: true };
      const errObj = err.body?.error && typeof err.body.error === 'object' ? err.body.error : {};
      const code = Number(errObj.code);
      const subcode = Number(errObj.error_subcode);
      if (err.status === 403 || code === 10 || code === 200) {
        throw new Error(THREADS_MANAGE_REPLIES_PERM_MSG);
      }
      if (err.status === 400 && code === 100 && subcode === 33) {
        return { success: true };
      }
      throw new Error(extractThreadsErrorMessage(err, 'Threads manage_reply failed'));
    }
    throw err;
  }
}

export async function deleteThreadsPost({ postId, accessToken, fetchImpl }) {
  const cleanId = String(postId || '').replace(/^threads:(?:notif:)?/, '').trim();
  if (!cleanId) return { success: false };
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(cleanId)}?access_token=${encodeURIComponent(accessToken)}`;
  try {
    return await threadsFetch(url, { method: 'DELETE', fetchImpl });
  } catch (err) {
    if (err instanceof FetchError) {
      if (err.status === 404) return { success: true };
      const errObj = err.body?.error && typeof err.body.error === 'object' ? err.body.error : {};
      const code = Number(errObj.code);
      const subcode = Number(errObj.error_subcode);
      if (err.status === 403 || code === 10) {
        throw new Error(THREADS_DELETE_PERM_MSG);
      }
      if (err.status === 400 && code === 100 && subcode === 33) {
        const exists = await getThreadsPost({ postId: cleanId, accessToken, fetchImpl }).catch(() => null);
        if (!exists?.id) return { success: true };
        throw new Error(THREADS_DELETE_PERM_MSG);
      }
    }
    throw err;
  }
}
