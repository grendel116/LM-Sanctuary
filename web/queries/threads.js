import { THREADS_GRAPH_BASE, isAllowedSocialUrl, isTailscaleFunnelUrl } from '../constants/endpoints.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';

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
  if (Array.isArray(children) && children.length > 0) {
    params.set('children', children.join(','));
  }

  return fetchWrapper(`${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads`, {
    method: 'POST',
    body: params,
    fetchImpl,
  });
}

export async function getThreadsContainerStatus({ containerId, accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(containerId)}?fields=id,status,error_message&access_token=${encodeURIComponent(accessToken)}`;
  return fetchWrapper(url, { fetchImpl });
}

export async function waitThreadsContainerReady({
  containerId,
  accessToken,
  pollDelayMs = 1000,
  maxPolls = 15,
  fetchImpl,
}) {
  for (let i = 0; i < maxPolls; i += 1) {
    const info = await getThreadsContainerStatus({ containerId, accessToken, fetchImpl });
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
export async function publishThreadsContainer({ userId, accessToken, creationId, fetchImpl }) {
  const params = new URLSearchParams({
    creation_id: creationId,
    access_token: accessToken,
  });
  return fetchWrapper(`${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads_publish`, {
    method: 'POST',
    body: params,
    fetchImpl,
  });
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
      fetchImpl,
    });
    return publishThreadsContainer({
      userId,
      accessToken,
      creationId: created.id,
      fetchImpl,
    });
  }

  if (items.length === 1) {
    const att = items[0];
    const resolvedUrl = resolveThreadsMediaUrl(att, {
      mastodonUploadedUrl: mastodonUrls[0] || '',
      publicMediaBaseUrl,
    });
    const isVideo = String(att?.type || att?.mimeType || '').startsWith('video');
    const created = await createThreadsContainer({
      userId,
      accessToken,
      mediaType: isVideo ? 'VIDEO' : 'IMAGE',
      text,
      ...(isVideo ? { videoUrl: resolvedUrl } : { imageUrl: resolvedUrl }),
      altText: att?.altText || att?.description || '',
      replyToId,
      fetchImpl,
    });
    await waitThreadsContainerReady({
      containerId: created.id,
      accessToken,
      pollDelayMs,
      fetchImpl,
    });
    return publishThreadsContainer({
      userId,
      accessToken,
      creationId: created.id,
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
    const isVideo = String(att?.type || att?.mimeType || '').startsWith('video');
    const child = await createThreadsContainer({
      userId,
      accessToken,
      mediaType: isVideo ? 'VIDEO' : 'IMAGE',
      ...(isVideo ? { videoUrl: resolvedUrl } : { imageUrl: resolvedUrl }),
      altText: att?.altText || att?.description || '',
      isCarouselItem: true,
      fetchImpl,
    });
    await waitThreadsContainerReady({
      containerId: child.id,
      accessToken,
      pollDelayMs,
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
    fetchImpl,
  });
  return publishThreadsContainer({
    userId,
    accessToken,
    creationId: carousel.id,
    fetchImpl,
  });
}

/**
 * Resolve authenticated user's Threads ID, handle, and avatar from an access token.
 */
export async function verifyThreadsCredentials({ accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/me?fields=id,username,name,threads_profile_picture_url&access_token=${encodeURIComponent(accessToken)}`;
  return fetchWrapper(url, { fetchImpl });
}

/**
 * Read only the authenticated user's own Threads posts (never algorithmic feeds).
 */
export async function getOwnThreadsPosts({ userId, accessToken, limit = 20, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(userId)}/threads?fields=id,text,media_type,media_url,permalink,timestamp&limit=${limit}&access_token=${encodeURIComponent(accessToken)}`;
  return fetchWrapper(url, { fetchImpl });
}

/**
 * Read replies to one of the authenticated user's own Threads posts.
 */
export async function getThreadsPostReplies({ postId, accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}/replies?fields=id,text,username,timestamp,permalink&access_token=${encodeURIComponent(accessToken)}`;
  return fetchWrapper(url, { fetchImpl });
}

export async function deleteThreadsPost({ postId, accessToken, fetchImpl }) {
  const url = `${THREADS_GRAPH_BASE}/${encodeURIComponent(postId)}?access_token=${encodeURIComponent(accessToken)}`;
  return fetchWrapper(url, { method: 'DELETE', fetchImpl });
}
