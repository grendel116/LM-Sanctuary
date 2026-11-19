import { isAllowedSocialUrl } from '../constants/endpoints.js';

const HTTPS_URL_RE = /https:\/\/[^\s<>"'`]+/g;
const YT_ID_RE = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID_RE = /^[0-9]{5,15}$/;

const LINK_PREVIEW_TTL_MS = 5 * 60_000;
const previewCache = new Map();

export function clearLinkPreviewCacheForTests() {
  previewCache.clear();
}

export function extractFirstHttpsUrl(text) {
  const source = String(text || '');
  HTTPS_URL_RE.lastIndex = 0;
  let match;
  while ((match = HTTPS_URL_RE.exec(source)) !== null) {
    let raw = match[0];
    while (raw && /[.,!?;:\]}'"”’]$/.test(raw)) {
      raw = raw.slice(0, -1);
    }
    while (raw.endsWith(')') && (raw.match(/\)/g)?.length || 0) > (raw.match(/\(/g)?.length || 0)) {
      raw = raw.slice(0, -1);
    }
    try {
      const parsed = new URL(raw);
      if (parsed.protocol === 'https:' && isAllowedSocialUrl(parsed.href)) {
        return parsed.href;
      }
    } catch {
      // Ignore malformed match
    }
  }
  return '';
}

export function parseVideoEmbedInfo(url) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname) return null;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  const parts = parsed.pathname.split('/').filter(Boolean);

  let ytId = '';
  if (host === 'youtu.be') {
    const cand = parts[0] || '';
    if (YT_ID_RE.test(cand)) ytId = cand;
  } else if (
    host === 'youtube.com' ||
    host === 'www.youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'music.youtube.com' ||
    host === 'www.youtube-nocookie.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (parts[0] === 'watch') {
      const cand = parsed.searchParams.get('v') || '';
      if (YT_ID_RE.test(cand)) ytId = cand;
    } else if (parts.length >= 2 && (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed')) {
      if (YT_ID_RE.test(parts[1])) ytId = parts[1];
    }
  }

  if (ytId) {
    return {
      provider: 'youtube',
      videoId: ytId,
      embedUrl: `https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1&rel=0`,
      thumbnailUrl: `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`,
      canonicalUrl: `https://www.youtube.com/watch?v=${ytId}`,
    };
  }

  if (host === 'vimeo.com' || host === 'www.vimeo.com' || host === 'player.vimeo.com') {
    const cand = host === 'player.vimeo.com' && parts[0] === 'video' ? (parts[1] || '') : (parts[0] || '');
    if (VIMEO_ID_RE.test(cand)) {
      return {
        provider: 'vimeo',
        videoId: cand,
        embedUrl: `https://player.vimeo.com/video/${cand}?autoplay=1&dnt=1`,
        thumbnailUrl: '',
        canonicalUrl: `https://vimeo.com/${cand}`,
      };
    }
  }

  return null;
}

function isPublicHttpsHost(parsed) {
  if (!parsed || parsed.protocol !== 'https:') return false;
  const host = String(parsed.hostname || '').toLowerCase().replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net') || host.endsWith('.internal')) {
    return false;
  }
  return isAllowedSocialUrl(parsed.href);
}

function getBackendOriginIfAvailable() {
  if (globalThis.Capacitor?.Plugins?.SanctuaryNativeStore) return '';
  if (typeof globalThis.process?.versions?.node === 'string' && !globalThis.__SANCTUARY_FORCE_HTTP_STORE__) {
    return '';
  }
  const loc = globalThis.location;
  if (!loc || !loc.origin || loc.origin === 'null') return '';
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return '';
  return loc.origin.replace(/\/+$/, '');
}

function mergeSignal(callerSignal, timeoutMs = 6000) {
  const timeoutSig = typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(timeoutMs) : null;
  const list = [callerSignal, timeoutSig].filter(Boolean);
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return typeof AbortSignal?.any === 'function' ? AbortSignal.any(list) : list[0];
}

function buildOembedEndpoint(url, video) {
  if (video?.provider === 'youtube') {
    return `https://www.youtube.com/oembed?url=${encodeURIComponent(video.canonicalUrl)}&format=json`;
  }
  if (video?.provider === 'vimeo') {
    return `https://vimeo.com/api/oembed.json?url=${encodeURIComponent(video.canonicalUrl)}`;
  }
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host === 'open.spotify.com' || host === 'play.spotify.com') {
      return `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
    }
    if (host === 'soundcloud.com' || host === 'www.soundcloud.com' || host === 'm.soundcloud.com') {
      return `https://soundcloud.com/oembed?format=json&url=${encodeURIComponent(url)}`;
    }
  } catch {
    // Ignore
  }
  return '';
}

export async function fetchLinkPreview(url, { signal, fetchImpl } = {}) {
  let parsed;
  try {
    parsed = new URL(String(url || '').trim());
  } catch {
    return null;
  }
  if (!isPublicHttpsHost(parsed)) return null;

  const cleanUrl = parsed.href;
  const now = Date.now();
  if (!fetchImpl) {
    const cached = previewCache.get(cleanUrl);
    if (cached && cached.expiresAt > now) {
      return cached.value ? { ...cached.value } : null;
    }
  }

  const doFetch = fetchImpl || globalThis.fetch;
  const reqSignal = mergeSignal(signal, 6000);
  const origin = !fetchImpl ? getBackendOriginIfAvailable() : '';

  if (origin && typeof doFetch === 'function') {
    try {
      const res = await doFetch(`${origin}/api/social/link-preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
        ...(reqSignal ? { signal: reqSignal } : {}),
      });
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.card?.url) {
          if (!fetchImpl) {
            if (previewCache.size >= 128) previewCache.delete(previewCache.keys().next().value);
            previewCache.set(cleanUrl, { value: data.card, expiresAt: now + LINK_PREVIEW_TTL_MS });
          }
          return { ...data.card };
        }
      }
    } catch {
      // Fall through to public oEmbed / video metadata
    }
  }

  const video = parseVideoEmbedInfo(cleanUrl);
  const host = parsed.hostname.replace(/^www\./i, '');
  let title = '';
  let description = '';
  let image = video?.thumbnailUrl || '';
  let siteName = host;

  const oembedUrl = buildOembedEndpoint(cleanUrl, video);
  if (oembedUrl && typeof doFetch === 'function') {
    try {
      const res = await doFetch(oembedUrl, reqSignal ? { signal: reqSignal } : {});
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && typeof data === 'object') {
          title = String(data.title || '').trim();
          const author = String(data.author_name || '').trim();
          if (author) description = author;
          siteName = String(data.provider_name || siteName).trim();
          const thumb = String(data.thumbnail_url || '').trim();
          if (/^https:\/\//i.test(thumb)) image = thumb;
        }
      }
    } catch {
      // Use video/host fallback below
    }
  }

  const card = {
    url: cleanUrl,
    title: title || (video ? `${video.provider === 'youtube' ? 'YouTube' : 'Vimeo'} Video` : host),
    description,
    image,
    siteName,
    provider: video?.provider || '',
    embedUrl: video?.embedUrl || '',
  };

  if (!fetchImpl) {
    if (previewCache.size >= 128) previewCache.delete(previewCache.keys().next().value);
    previewCache.set(cleanUrl, { value: card, expiresAt: now + LINK_PREVIEW_TTL_MS });
  }
  return card;
}
