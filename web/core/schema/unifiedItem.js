import {
  MAX_VISIBLE_URL_CHARS,
  formatTruncatedUrlInnerHtml,
  sanitizeFediverseHtmlToString,
  splitUrlDisplayParts,
} from '../../queries/fediverse.js';

export { MAX_VISIBLE_URL_CHARS, formatTruncatedUrlInnerHtml, splitUrlDisplayParts };

export const ORIGIN_PROTOCOLS = Object.freeze(['mastodon', 'bluesky', 'threads']);

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function decodeBasicEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

export function stripHtmlToText(html) {
  const raw = String(html || '');
  if (!raw) return '';
  return decodeBasicEntities(
    raw
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p\s*>/gi, '\n\n')
      .replace(/<[^>]*>/g, '')
  )
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeAttr(text) {
  return escapeHtml(text)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function linkifyLineFragment(fragment) {
  const input = String(fragment || '');
  if (!input) return '';
  const urlRe = /(?:^|[\s(])(https?:\/\/[^\s<>[\]{}"']+)/g;
  const parts = [];
  let cursor = 0;

  for (const m of input.matchAll(urlRe)) {
    const token = m[1];
    const tokenStart = m.index + m[0].indexOf(token);
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
      parts.push(escapeHtml(input.slice(cursor, tokenStart)));
    }
    parts.push(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${formatTruncatedUrlInnerHtml(clean, href)}</a>`);
    const suffix = token.slice(clean.length);
    if (suffix) parts.push(escapeHtml(suffix));
    cursor = tokenStart + token.length;
  }

  if (cursor < input.length) {
    parts.push(escapeHtml(input.slice(cursor)));
  }
  return parts.join('');
}

export function plainTextToHtml(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return '';
  return raw
    .split(/\n{2,}/)
    .map((block) => `<p>${block.split('\n').map(linkifyLineFragment).join('<br>')}</p>`)
    .join('');
}

function normalizeLinkCard(rawCard) {
  if (!rawCard || typeof rawCard !== 'object' || !rawCard.url) return null;
  try {
    const parsed = new URL(String(rawCard.url).trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return {
      url: parsed.href,
      title: String(rawCard.title || ''),
      description: String(rawCard.description || ''),
      image: String(rawCard.image || rawCard.thumb || ''),
    };
  } catch {
    return null;
  }
}

/**
 * Normalize bridged ActivityPub handles (@u.bsky.social@bsky.brid.gy, @u@threads.net)
 * into a canonical actor key for cross-protocol deduplication.
 * @param {string} handle
 * @param {string} [protocol]
 * @returns {string}
 */
export function canonicalizeActorHandle(handle, protocol = 'mastodon') {
  const clean = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!clean) return '';
  if (protocol === 'bluesky' || clean.endsWith('@bsky.brid.gy')) {
    const base = clean.endsWith('@bsky.brid.gy') ? clean.slice(0, -'@bsky.brid.gy'.length) : clean;
    return `bluesky:${base}`;
  }
  if (protocol === 'threads' || clean.endsWith('@threads.net')) {
    const base = clean.endsWith('@threads.net') ? clean.slice(0, -'@threads.net'.length) : clean;
    return `threads:${base}`;
  }
  return `${protocol === 'fediverse' ? 'mastodon' : protocol}:${clean}`;
}

function mapAttachmentMime(att) {
  if (att?.mime_type || att?.mimeType) return String(att.mime_type || att.mimeType);
  const t = String(att?.type || 'image').toLowerCase();
  if (t === 'video' || t === 'gifv') return 'video/mp4';
  if (t === 'audio') return 'audio/mpeg';
  return 'image/jpeg';
}

function normalizeAttachmentsList(rawList = []) {
  if (!Array.isArray(rawList)) return [];
  return rawList
    .filter((att) => att && (att.url || att.previewUrl || att.remote_url || att.hlsUrl))
    .map((att) => {
      const mime = mapAttachmentMime(att);
      const rawType = String(att.type || '').toLowerCase();
      const type = rawType || (mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'image');
      const w = Number.parseInt(att.width, 10);
      const h = Number.parseInt(att.height, 10);
      return {
        url: String(att.url || att.remote_url || att.previewUrl || att.hlsUrl || ''),
        type,
        mime_type: mime,
        alt_text: String(att.alt_text ?? att.description ?? ''),
        ...(att.previewUrl || att.preview_url ? { previewUrl: String(att.previewUrl || att.preview_url) } : {}),
        ...(att.hlsUrl ? { hlsUrl: String(att.hlsUrl) } : {}),
        ...(Number.isFinite(w) && w > 0 ? { width: w } : {}),
        ...(Number.isFinite(h) && h > 0 ? { height: h } : {}),
        ...(att.did ? { did: String(att.did) } : {}),
        ...(att.cid ? { cid: String(att.cid) } : {}),
      };
    });
}

function normalizeLangTag(raw) {
  const clean = String(raw || '').trim().toLowerCase().replace(/_/g, '-');
  if (!clean || clean === 'und' || clean === 'zxx' || clean === 'mul' || clean === 'mis') return '';
  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/.test(clean)) return '';
  return clean;
}

/**
 * Ensure any post object (legacy normalized post or UnifiedItem) conforms strictly to UnifiedItem.
 * @param {object} item
 * @returns {object}
 */
export function toUnifiedItem(item) {
  if (!item || typeof item !== 'object') {
    return {
      id: '',
      protocol: 'mastodon',
      url: '',
      content_html: '',
      content_text: '',
      date_published: '',
      language: '',
      author: { id: '', name: '', handle: '', avatar_url: '', url: '' },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: {},
    };
  }

  // Already a UnifiedItem
  if (ORIGIN_PROTOCOLS.includes(item.protocol) && typeof item.date_published === 'string' && item._meta) {
    if (item.language === undefined) {
      const inferred = normalizeLangTag(item._meta?.mastodon?.language || item._meta?.bluesky?.language || '');
      if (inferred) return { ...item, language: inferred };
    }
    return item;
  }

  const protocol = ORIGIN_PROTOCOLS.includes(item.protocol)
    ? item.protocol
    : item.network === 'bluesky'
      ? 'bluesky'
      : item.network === 'threads'
        ? 'threads'
        : 'mastodon';
  const nativeId = protocol === 'bluesky'
    ? (item._meta?.bluesky?.uri || item.uri || String(item.id || '').replace(/^bluesky:/, ''))
    : protocol === 'threads'
      ? (item._meta?.threads?.postId || String(item.id || '').replace(/^threads:/, ''))
      : (item._meta?.mastodon?.statusId || String(item.id || item.uri || '').replace(/^mastodon:/, ''));
  const html = item.content_html || item.sanitizedHtml || item.contentHtml || (item.content_text || item.text ? plainTextToHtml(item.content_text || item.text) : '');
  const text = item.content_text || item.text || stripHtmlToText(html);
  const handle = item.author?.handle || item.author?.acct || item.author?.username || '';
  const language = normalizeLangTag(
    item.language
    || (Array.isArray(item.langs) ? item.langs[0] : '')
    || item._meta?.mastodon?.language
    || item._meta?.bluesky?.language
    || item.raw?.reblog?.language
    || item.raw?.language
    || item.raw?.post?.record?.langs?.[0]
    || ''
  );

  const meta = {};
  if (protocol === 'mastodon') {
    meta.mastodon = {
      statusId: String(item._meta?.mastodon?.statusId || nativeId || ''),
      uri: item._meta?.mastodon?.uri || item.uri || item.url || '',
      visibility: item._meta?.mastodon?.visibility || item.visibility || 'public',
      ...(language ? { language } : {}),
      sensitive: Boolean(item._meta?.mastodon?.sensitive ?? item.sensitive ?? item.raw?.sensitive ?? item.raw?.reblog?.sensitive),
      favourited: Boolean(item._meta?.mastodon?.favourited ?? item.viewerState?.favourited),
      reblogged: Boolean(item._meta?.mastodon?.reblogged ?? item.viewerState?.reblogged),
      bookmarked: Boolean(item._meta?.mastodon?.bookmarked ?? item.viewerState?.bookmarked),
      pinned: Boolean(item._meta?.mastodon?.pinned ?? item.pinned ?? item.raw?.pinned),
      spoilerText: item._meta?.mastodon?.spoilerText || item.spoilerText || '',
      inReplyToId: item._meta?.mastodon?.inReplyToId || item.inReplyToId || null,
      ...(item._meta?.mastodon?.inReplyToAccountId || item.inReplyToAccountId
        ? { inReplyToAccountId: String(item._meta?.mastodon?.inReplyToAccountId || item.inReplyToAccountId) }
        : {}),
      instanceUrl: item._meta?.mastodon?.instanceUrl || item.instanceUrl || 'https://mastodon.social',
      emojis: Array.isArray(item._meta?.mastodon?.emojis) ? item._meta.mastodon.emojis : (Array.isArray(item.emojis) ? item.emojis : []),
      ...(item._meta?.mastodon?.rebloggedBy || item.rebloggedBy ? { rebloggedBy: item._meta?.mastodon?.rebloggedBy || item.rebloggedBy } : {}),
      ...(item._meta?.mastodon?.rebloggedAt || item.rebloggedAt ? { rebloggedAt: String(item._meta?.mastodon?.rebloggedAt || item.rebloggedAt) } : {}),
    };
  } else if (protocol === 'bluesky') {
    const bskyFacets = Array.isArray(item._meta?.bluesky?.facets)
      ? item._meta.bluesky.facets
      : (Array.isArray(item.facets) ? item.facets : []);
    const bskyLabels = [
      ...new Set(
        [
          ...(Array.isArray(item._meta?.bluesky?.labels) ? item._meta.bluesky.labels : []),
          ...(Array.isArray(item.labels) ? item.labels : []),
        ]
          .map((l) => String(l?.val ?? l ?? '').trim().toLowerCase())
          .filter(Boolean)
      ),
    ];
    meta.bluesky = {
      uri: item._meta?.bluesky?.uri || item.uri || '',
      cid: item._meta?.bluesky?.cid || item.cid || '',
      likeUri: item._meta?.bluesky?.likeUri ?? item.viewerState?.likeUri ?? null,
      repostUri: item._meta?.bluesky?.repostUri ?? item.viewerState?.repostUri ?? null,
      ...(language ? { language } : {}),
      ...(item._meta?.bluesky?.replyDisabled || item.viewerState?.replyDisabled ? { replyDisabled: true } : {}),
      ...(item._meta?.bluesky?.viewerMuted || item.viewerState?.viewerMuted ? { viewerMuted: true } : {}),
      ...(item._meta?.bluesky?.viewerBlocking || item.viewerState?.viewerBlocking ? { viewerBlocking: true } : {}),
      ...(bskyFacets.length > 0 ? { facets: bskyFacets } : {}),
      ...(bskyLabels.length > 0 ? { labels: bskyLabels } : {}),
      ...(item._meta?.bluesky?.reply || item.reply ? { reply: item._meta?.bluesky?.reply || item.reply } : {}),
      ...(item._meta?.bluesky?.rebloggedBy || item.rebloggedBy
        ? { rebloggedBy: item._meta?.bluesky?.rebloggedBy || item.rebloggedBy }
        : {}),
      ...(item._meta?.bluesky?.rebloggedAt || item.rebloggedAt
        ? { rebloggedAt: String(item._meta?.bluesky?.rebloggedAt || item.rebloggedAt) }
        : {}),
    };
  } else {
    meta.threads = {
      postId: String(item._meta?.threads?.postId || nativeId || ''),
      ...(item._meta?.threads?.parentPostId ? { parentPostId: String(item._meta.threads.parentPostId) } : {}),
      ...(item._meta?.threads?.repliedToId ? { repliedToId: String(item._meta.threads.repliedToId) } : {}),
      ...(item._meta?.threads?.rootPostId ? { rootPostId: String(item._meta.threads.rootPostId) } : {}),
      ...(item._meta?.threads?.topicTag ? { topicTag: String(item._meta.threads.topicTag) } : {}),
      ...(item._meta?.threads?.shortcode ? { shortcode: String(item._meta.threads.shortcode) } : {}),
      ...(item._meta?.threads?.isQuotePost ? { isQuotePost: true } : {}),
    };
  }

  const linkCard = normalizeLinkCard(item.linkCard || item.link_card || item._meta?.linkCard);
  if (linkCard) {
    meta.linkCard = linkCard;
  }
  if (item._meta?.quotePost || item.quotePost) {
    meta.quotePost = item._meta?.quotePost || item.quotePost;
  }
  if (item._meta?.linkedIds || item.linkedIds) {
    meta.linkedIds = item._meta?.linkedIds || item.linkedIds;
  }
  if (item._meta?.metricsBreakdown) {
    meta.metricsBreakdown = item._meta.metricsBreakdown;
  }
  if (item._meta?.notification) {
    meta.notification = item._meta.notification;
  }
  if (item._meta?.feedSource) {
    meta.feedSource = String(item._meta.feedSource);
  }
  if (item._meta?.endorsedBy) {
    meta.endorsedBy = String(item._meta.endorsedBy);
  }
  if (item._meta?.feedFeedback) {
    meta.feedFeedback = String(item._meta.feedFeedback);
  }

  return {
    id: `${protocol}:${nativeId}`,
    protocol,
    url: item.url || '',
    content_html: sanitizeFediverseHtmlToString(html, item.emojis || []),
    content_text: text,
    date_published: item.createdAt || new Date().toISOString(),
    language,
    author: {
      id: String(item.author?.id || item.author?.did || ''),
      name: String(item.author?.displayName || item.author?.name || handle),
      handle: String(handle),
      avatar_url: String(item.author?.avatar_url || item.author?.avatar || ''),
      url: String(item.author?.url || ''),
    },
    attachments: normalizeAttachmentsList(item.media || item.attachments),
    metrics: {
      replies: Number(item.counts?.replies ?? item.metrics?.replies ?? 0),
      reposts: Number(item.counts?.reposts ?? item.metrics?.reposts ?? 0),
      likes: Number(item.counts?.likes ?? item.metrics?.likes ?? 0),
    },
    _meta: meta,
  };
}

/**
 * Deduplicate and sort UnifiedItem[] newest-first, collapsing Bridgy/Threads Fediverse mirrors.
 * @param {Array<object>} items
 * @param {number} [windowMs]
 * @returns {Array<object>}
 */
const TRACKING_QUERY_PARAMS = new Set([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'fbclid',
  'gclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'si',
  's',
  't',
  'feature',
]);

/**
 * Normalize an external URL by stripping tracking params, fragments, and www/m prefixes for deduplication.
 * @param {string} rawUrl
 * @returns {string}
 */
export function canonicalizeUrlForDedupe(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw) return '';
  let candidate = raw;
  if (!/^https?:\/\//i.test(candidate)) {
    if (/^[a-z0-9.-]+\.[a-z]{2,}\/\S+/i.test(candidate)) {
      candidate = `https://${candidate}`;
    } else {
      return '';
    }
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    const host = parsed.hostname.toLowerCase().replace(/^(?:www|m)\./, '');
    if (!host || !host.includes('.')) return '';
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    const keptParams = [];
    for (const [k, v] of parsed.searchParams.entries()) {
      const kl = k.toLowerCase();
      if (TRACKING_QUERY_PARAMS.has(kl) || kl.startsWith('utm_')) continue;
      keptParams.push([k, v]);
    }
    keptParams.sort((a, b) => (a[0] === b[0] ? String(a[1]).localeCompare(String(b[1])) : String(a[0]).localeCompare(String(b[0]))));
    const search = keptParams.length > 0 ? `?${new URLSearchParams(keptParams).toString()}` : '';
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol.toLowerCase()}//${host}${port}${pathname}${search}`;
  } catch {
    return '';
  }
}

function normalizeNativeUri(rawUri) {
  const raw = String(rawUri || '').trim();
  if (!raw) return '';
  if (!/^https?:\/\//i.test(raw)) return raw;
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.length > 1 ? parsed.pathname.replace(/\/+$/, '') : parsed.pathname;
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${parsed.protocol.toLowerCase()}//${parsed.hostname.toLowerCase()}${port}${pathname}${parsed.search}`;
  } catch {
    return raw;
  }
}

function trimCleanExtractedUrl(token) {
  let clean = String(token || '').replace(/[.,!?;:]+$/, '');
  while (clean.endsWith(')')) {
    const opens = (clean.match(/\(/g) || []).length;
    const closes = (clean.match(/\)/g) || []).length;
    if (closes > opens) {
      clean = clean.slice(0, -1).replace(/[.,!?;:]+$/, '');
    } else {
      break;
    }
  }
  return clean;
}

function extractPrimaryUrlFromItem(item) {
  if (item?._meta?.linkCard?.url) return String(item._meta.linkCard.url);
  const html = String(item?.content_html || '');
  if (html) {
    const anchorRe = /<a\b([^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*)>/gi;
    for (const m of html.matchAll(anchorRe)) {
      const attrs = String(m[1] || '');
      const href = decodeBasicEntities(m[2] ?? m[3] ?? '').trim();
      if (!/^https?:\/\//i.test(href)) continue;
      if (/\bclass\s*=\s*(?:"[^"]*\b(?:mention|hashtag)\b[^"]*"|'[^']*\b(?:mention|hashtag)\b[^']*')/i.test(attrs)) {
        continue;
      }
      try {
        const p = new URL(href);
        if (p.pathname.includes('/tags/')) continue;
      } catch {
        continue;
      }
      return href;
    }
  }
  const text = String(item?.content_text || '');
  const textMatch = text.match(/(?:^|[\s(])(https?:\/\/[^\s<>[\]{}"']+)/i);
  if (textMatch) {
    return trimCleanExtractedUrl(textMatch[1]);
  }
  return '';
}

const FEED_SOURCE_RANK = { following: 0, second_degree: 1, discovery: 2 };

function mergeFeedProvenance(aMeta = {}, bMeta = {}) {
  const aSrc = aMeta?.feedSource;
  const bSrc = bMeta?.feedSource;
  const aR = FEED_SOURCE_RANK[aSrc] ?? 9;
  const bR = FEED_SOURCE_RANK[bSrc] ?? 9;
  const winSrc = aR <= bR ? (aSrc || bSrc) : bSrc;
  const winEndorser = (aR <= bR ? aMeta?.endorsedBy : bMeta?.endorsedBy) || aMeta?.endorsedBy || bMeta?.endorsedBy;
  return {
    ...aMeta,
    ...bMeta,
    ...(winSrc ? { feedSource: winSrc } : {}),
    ...(winEndorser ? { endorsedBy: winEndorser } : {}),
  };
}

function buildOwnAccountKeySet(ownAccounts = []) {
  const keys = new Set();
  for (const raw of Array.isArray(ownAccounts) ? ownAccounts : []) {
    const acc = raw?.meta && typeof raw.meta === 'object' ? raw.meta : raw;
    if (!acc || typeof acc !== 'object') continue;
    const proto = acc.platform === 'fediverse' || acc.platform === 'mastodon'
      ? 'mastodon'
      : String(acc.platform || '').toLowerCase();
    if (!proto) continue;
    for (const candidateHandle of [acc.acct, acc.handle, acc.username]) {
      if (!candidateHandle) continue;
      const ck = canonicalizeActorHandle(candidateHandle, proto);
      if (ck && ck !== `${proto}:`) keys.add(ck);
      const local = String(candidateHandle).trim().replace(/^@/, '').toLowerCase();
      if (proto === 'mastodon' && local && !local.includes('@') && acc.instanceUrl) {
        try {
          const host = new URL(String(acc.instanceUrl)).hostname.toLowerCase();
          if (host) keys.add(`mastodon:${local}@${host}`);
        } catch {
          // ignore malformed instanceUrl
        }
      }
    }
    if (acc.did) {
      const didLow = String(acc.did).trim().toLowerCase();
      keys.add(`bluesky:${didLow}`);
      keys.add(`bluesky:id:${didLow}`);
    }
    if (acc.userId) {
      keys.add(`${proto}:id:${String(acc.userId).trim().toLowerCase()}`);
    }
  }
  return keys;
}

function extractAuthorStem(handle, protocol) {
  const clean = String(handle || '').trim().replace(/^@/, '').toLowerCase();
  if (!clean) return '';
  let local = clean;
  if (protocol === 'bluesky' || clean.endsWith('@bsky.brid.gy')) {
    const noBridge = clean.replace(/@bsky\.brid\.gy$/i, '').replace(/\.bsky\.social$/i, '');
    const dotIdx = noBridge.indexOf('.');
    local = dotIdx > 0 ? noBridge.slice(0, dotIdx) : noBridge;
  } else {
    const atIdx = clean.indexOf('@');
    local = atIdx > 0 ? clean.slice(0, atIdx) : clean;
  }
  const stem = local.replace(/[^a-z0-9]/g, '');
  return stem.length >= 4 ? stem : '';
}

function extractDedupeFeatures(item, ownAccountKeys) {
  const notif = item._meta?.notification;
  const ts = Date.parse(item.date_published || '') || 0;
  if (notif) {
    const actor = notif.actor?.handle || item.author?.handle;
    const kind = `notif:${notif.type}`;
    const text = String(item.content_text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
    return {
      item,
      isNotification: true,
      ts,
      notifSig: `${canonicalizeActorHandle(actor, item.protocol)}|${kind}|${text}`,
    };
  }

  const proto = item.protocol || 'mastodon';
  const isBoost = Boolean(item._meta?.mastodon?.rebloggedBy || item._meta?.bluesky?.rebloggedBy);
  let nativeUri = '';
  if (proto === 'mastodon') {
    nativeUri = normalizeNativeUri(item._meta?.mastodon?.uri || item.url || '');
  } else if (proto === 'bluesky') {
    nativeUri = String(item._meta?.bluesky?.uri || '').trim();
  } else if (proto === 'threads' && item._meta?.threads?.postId) {
    nativeUri = `threads:${String(item._meta.threads.postId).trim()}`;
  }

  const linked = item._meta?.linkedIds;
  const hasExplicitLinks = Boolean(linked && typeof linked === 'object' && Object.values(linked).some(Boolean));
  const explicitLinkTokens = new Set();
  if (hasExplicitLinks) {
    if (linked.blueskyUri) explicitLinkTokens.add(`bsky:${String(linked.blueskyUri).trim()}`);
    if (linked.threadsPostId) explicitLinkTokens.add(`threads:${String(linked.threadsPostId).trim()}`);
    if (linked.mastodonStatusId) explicitLinkTokens.add(`masto_linked:${String(linked.mastodonStatusId).trim()}`);
  }
  const selfLinkTokens = new Set();
  if (proto === 'bluesky' && item._meta?.bluesky?.uri) {
    selfLinkTokens.add(`bsky:${String(item._meta.bluesky.uri).trim()}`);
  } else if (proto === 'threads' && item._meta?.threads?.postId) {
    selfLinkTokens.add(`threads:${String(item._meta.threads.postId).trim()}`);
  } else if (proto === 'mastodon') {
    const sid = item._meta?.mastodon?.statusId || String(item.id || '').replace(/^mastodon:/, '');
    if (sid) selfLinkTokens.add(`masto_linked:${String(sid).trim()}`);
  }

  const rawHandle = String(item.author?.handle || '').trim();
  const canonActor = canonicalizeActorHandle(rawHandle, proto);
  const authorIdLow = String(item.author?.id || '').trim().toLowerCase();
  let isOwnAuthor = false;
  if (!isBoost && ownAccountKeys.size > 0) {
    if ((canonActor && ownAccountKeys.has(canonActor)) || (authorIdLow && ownAccountKeys.has(`${proto}:id:${authorIdLow}`))) {
      isOwnAuthor = true;
    } else if (proto === 'mastodon' && rawHandle && !rawHandle.includes('@') && item._meta?.mastodon?.instanceUrl) {
      try {
        const host = new URL(String(item._meta.mastodon.instanceUrl)).hostname.toLowerCase();
        if (host && ownAccountKeys.has(`mastodon:${rawHandle.toLowerCase()}@${host}`)) {
          isOwnAuthor = true;
        }
      } catch {
        // ignore
      }
    }
  }

  const authorStem = extractAuthorStem(rawHandle, proto);
  const nameClean = String(item.author?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const authorNameKey = nameClean.length >= 6 ? nameClean : '';

  const canonUrl = canonicalizeUrlForDedupe(extractPrimaryUrlFromItem(item));
  const rawText = String(item.content_text || '');
  const rawSnippet = rawText.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
  const normFullText = rawText
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const normProse = normFullText
    .replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  const normCardTitle = String(item._meta?.linkCard?.title || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .trim();
  const commentaryProse = canonUrl && (!normProse || normProse === normCardTitle) ? '' : normProse;

  return {
    item,
    isNotification: false,
    isBoost,
    ts,
    nativeUri,
    hasExplicitLinks,
    explicitLinkTokens,
    selfLinkTokens,
    canonActor,
    isOwnAuthor,
    authorStem,
    authorNameKey,
    canonUrl,
    normFullText,
    normProse,
    normCardTitle,
    commentaryProse,
    rawSnippet,
  };
}

function setsIntersect(a, b) {
  for (const val of a) {
    if (b.has(val)) return true;
  }
  return false;
}

function matchPostDuplicate(exFeat, candFeat, windowMs) {
  if (exFeat.isNotification || candFeat.isNotification) {
    if (
      exFeat.isNotification &&
      candFeat.isNotification &&
      exFeat.notifSig === candFeat.notifSig &&
      Math.abs(exFeat.ts - candFeat.ts) <= windowMs
    ) {
      return { duplicate: true, mergeCrossProtocolMeta: true };
    }
    return { duplicate: false, mergeCrossProtocolMeta: false };
  }

  // Rule A: Exact native / federated URI
  if (exFeat.nativeUri && exFeat.nativeUri === candFeat.nativeUri) {
    return { duplicate: true, mergeCrossProtocolMeta: true };
  }

  // Rule B: Explicit _meta.linkedIds cross-reference
  if (exFeat.hasExplicitLinks || candFeat.hasExplicitLinks) {
    if (
      setsIntersect(exFeat.explicitLinkTokens, candFeat.explicitLinkTokens) ||
      setsIntersect(exFeat.explicitLinkTokens, candFeat.selfLinkTokens) ||
      setsIntersect(candFeat.explicitLinkTokens, exFeat.selfLinkTokens)
    ) {
      return { duplicate: true, mergeCrossProtocolMeta: true };
    }
  }

  const dt = Math.abs(exFeat.ts - candFeat.ts);
  const crossProto = exFeat.item.protocol !== candFeat.item.protocol;

  // Rule C: Same canonical actor (or Bridgy mirror)
  if (exFeat.canonActor && exFeat.canonActor === candFeat.canonActor) {
    const limitC = crossProto ? Math.max(windowMs, 12 * 3600_000) : Math.max(windowMs, 15 * 60_000);
    if (dt <= limitC) {
      const sameUrlPost = Boolean(
        exFeat.canonUrl &&
        exFeat.canonUrl === candFeat.canonUrl &&
        exFeat.commentaryProse === candFeat.commentaryProse
      );
      const sameTextOnly = Boolean(
        !exFeat.canonUrl &&
        !candFeat.canonUrl &&
        exFeat.normFullText &&
        exFeat.normFullText === candFeat.normFullText
      );
      const sameRaw = Boolean(exFeat.rawSnippet && exFeat.rawSnippet === candFeat.rawSnippet);
      if (sameUrlPost || sameTextOnly || sameRaw) {
        return { duplicate: true, mergeCrossProtocolMeta: true };
      }
    }
  }

  // Rule D: Own connected accounts OR cross-protocol same author stem / display name
  const sameCrossAuthor =
    (exFeat.isOwnAuthor && candFeat.isOwnAuthor) ||
    (crossProto &&
      !exFeat.isBoost &&
      !candFeat.isBoost &&
      ((exFeat.authorStem && exFeat.authorStem === candFeat.authorStem) ||
        (exFeat.authorNameKey && exFeat.authorNameKey === candFeat.authorNameKey)));
  if (sameCrossAuthor && dt <= Math.max(windowMs, 12 * 3600_000)) {
    const sameUrlMatch = Boolean(
      exFeat.canonUrl &&
      exFeat.canonUrl === candFeat.canonUrl &&
      (exFeat.commentaryProse === candFeat.commentaryProse ||
        (exFeat.normProse.length >= 24 &&
          candFeat.normProse.length >= 24 &&
          (exFeat.normProse.startsWith(candFeat.normProse) || candFeat.normProse.startsWith(exFeat.normProse))))
    );
    const sameProseOnly = Boolean(
      !exFeat.canonUrl &&
      !candFeat.canonUrl &&
      exFeat.normProse.length > 0 &&
      (exFeat.normProse === candFeat.normProse ||
        (exFeat.normProse.length >= 80 &&
          candFeat.normProse.length >= 80 &&
          (exFeat.normProse.startsWith(candFeat.normProse) || candFeat.normProse.startsWith(exFeat.normProse))))
    );
    if (sameUrlMatch || sameProseOnly) {
      return { duplicate: true, mergeCrossProtocolMeta: true };
    }
  }

  // Rule E: Cross-account syndicated / identical link-share or copypasta within 24h
  if (dt <= Math.max(windowMs, 24 * 3600_000)) {
    const sameSyndicatedLink = Boolean(
      exFeat.canonUrl &&
      exFeat.canonUrl === candFeat.canonUrl &&
      (exFeat.commentaryProse === candFeat.commentaryProse ||
        (!exFeat.commentaryProse && candFeat.normProse && candFeat.normProse === exFeat.normCardTitle) ||
        (!candFeat.commentaryProse && exFeat.normProse && exFeat.normProse === candFeat.normCardTitle))
    );
    const sameCopypasta = Boolean(
      exFeat.normFullText.length >= 45 &&
      exFeat.normFullText === candFeat.normFullText &&
      exFeat.canonUrl === candFeat.canonUrl
    );
    if (sameSyndicatedLink || sameCopypasta) {
      return { duplicate: true, mergeCrossProtocolMeta: false };
    }
  }

  return { duplicate: false, mergeCrossProtocolMeta: false };
}

function mergeAbsorbedMeta(target, absorbed, { mergeCrossProtocolMeta = false } = {}) {
  let nextMeta = mergeFeedProvenance(target._meta, {
    ...(absorbed._meta?.feedSource ? { feedSource: absorbed._meta.feedSource } : {}),
    ...(absorbed._meta?.endorsedBy ? { endorsedBy: absorbed._meta.endorsedBy } : {}),
  });
  let nextMetrics = target.metrics;

  if (mergeCrossProtocolMeta) {
    for (const k of ['mastodon', 'bluesky', 'threads', 'linkCard']) {
      if (absorbed._meta?.[k] && !nextMeta[k]) {
        nextMeta = { ...nextMeta, [k]: absorbed._meta[k] };
      }
    }
    if (absorbed._meta?.linkedIds || nextMeta.linkedIds) {
      nextMeta = {
        ...nextMeta,
        linkedIds: { ...(nextMeta.linkedIds || {}), ...(absorbed._meta?.linkedIds || {}) },
      };
    }
    const candBd = absorbed._meta?.metricsBreakdown;
    const prevBd = nextMeta.metricsBreakdown;
    const candCount = candBd && typeof candBd === 'object' ? Object.keys(candBd).length : 0;
    const prevCount = prevBd && typeof prevBd === 'object' ? Object.keys(prevBd).length : 0;
    if (candCount > prevCount) {
      nextMeta = { ...nextMeta, metricsBreakdown: candBd };
      if (absorbed.metrics) nextMetrics = absorbed.metrics;
    }
  }

  return { ...target, metrics: nextMetrics, _meta: nextMeta };
}

function cloneFeatureSetWithAbsorbed(feat, mergedItem) {
  feat.item = mergedItem;
  if (mergedItem._meta?.linkedIds) {
    const linked = mergedItem._meta.linkedIds;
    feat.hasExplicitLinks = Object.values(linked).some(Boolean);
    if (linked.blueskyUri) feat.explicitLinkTokens.add(`bsky:${String(linked.blueskyUri).trim()}`);
    if (linked.threadsPostId) feat.explicitLinkTokens.add(`threads:${String(linked.threadsPostId).trim()}`);
    if (linked.mastodonStatusId) feat.explicitLinkTokens.add(`masto_linked:${String(linked.mastodonStatusId).trim()}`);
  }
}

/**
 * Deduplicate and sort UnifiedItem[] newest-first, collapsing Bridgy/Threads mirrors,
 * multi-account cross-posts, syndicated link reposts, and federated copies.
 * @param {Array<object>} items
 * @param {number} [windowMs]
 * @param {{ ownAccounts?: Array<object> }} [options]
 * @returns {Array<object>}
 */
export function deduplicateUnifiedItems(items = [], windowMs = 120_000, options = {}) {
  const normalized = items.filter(Boolean).map((it) => toUnifiedItem(it));
  const priority = { mastodon: 0, bluesky: 1, threads: 2 };
  const ownAccountKeys = buildOwnAccountKeySet(options?.ownAccounts);
  const byId = new Map();

  for (const item of normalized) {
    if (!item.id) continue;
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
    } else {
      byId.set(item.id, { ...prev, ...item, _meta: mergeFeedProvenance(prev._meta, item._meta) });
    }
  }

  const winnerOrder = [...byId.values()].sort((a, b) => {
    const sA = FEED_SOURCE_RANK[a._meta?.feedSource] ?? 3;
    const sB = FEED_SOURCE_RANK[b._meta?.feedSource] ?? 3;
    if (sA !== sB) return sA - sB;
    const bBoostA = (a._meta?.mastodon?.rebloggedBy || a._meta?.bluesky?.rebloggedBy) ? 1 : 0;
    const bBoostB = (b._meta?.mastodon?.rebloggedBy || b._meta?.bluesky?.rebloggedBy) ? 1 : 0;
    if (bBoostA !== bBoostB) return bBoostA - bBoostB;
    const pDiff = (priority[a.protocol] ?? 9) - (priority[b.protocol] ?? 9);
    if (pDiff !== 0) return pDiff;
    return (Date.parse(b.date_published || '') || 0) - (Date.parse(a.date_published || '') || 0);
  });

  const keptFeatures = [];
  for (const cand of winnerOrder) {
    const candFeat = extractDedupeFeatures(cand, ownAccountKeys);
    let matched = false;
    for (const exFeat of keptFeatures) {
      const res = matchPostDuplicate(exFeat, candFeat, windowMs);
      if (res.duplicate) {
        const merged = mergeAbsorbedMeta(exFeat.item, cand, {
          mergeCrossProtocolMeta: res.mergeCrossProtocolMeta,
        });
        cloneFeatureSetWithAbsorbed(exFeat, merged);
        matched = true;
        break;
      }
    }
    if (!matched) {
      keptFeatures.push(candFeat);
    }
  }

  return keptFeatures
    .map((f) => f.item)
    .sort((a, b) => {
      const dt = (Date.parse(b.date_published || '') || 0) - (Date.parse(a.date_published || '') || 0);
      if (dt !== 0) return dt;
      return (priority[a.protocol] ?? 9) - (priority[b.protocol] ?? 9);
    });
}

/**
 * Append incoming page items onto existing items without reordering or removing existing cards,
 * dropping incoming duplicates and enriching matching existing items in place when linked.
 * @param {Array<object>} existingItems
 * @param {Array<object>} incomingItems
 * @param {{ ownAccounts?: Array<object> }} [options]
 * @returns {{ nextExisting: Array<object>, appended: Array<object> }}
 */
export function deduplicateAppendItems(existingItems = [], incomingItems = [], options = {}) {
  const ownAccountKeys = buildOwnAccountKeySet(options?.ownAccounts);
  const nextExisting = (Array.isArray(existingItems) ? existingItems : []).filter(Boolean).map((it) => toUnifiedItem(it));
  const existingIds = new Set(nextExisting.map((it) => it.id).filter(Boolean));
  const existingFeats = nextExisting.map((it) => extractDedupeFeatures(it, ownAccountKeys));
  const cleanIncoming = deduplicateUnifiedItems(incomingItems, 120_000, options);
  const appended = [];

  for (const cand of cleanIncoming) {
    if (!cand?.id || existingIds.has(cand.id)) continue;
    const candFeat = extractDedupeFeatures(cand, ownAccountKeys);
    let absorbed = false;
    for (let i = 0; i < existingFeats.length; i += 1) {
      const exFeat = existingFeats[i];
      const res = matchPostDuplicate(exFeat, candFeat, 120_000);
      if (res.duplicate) {
        if (res.mergeCrossProtocolMeta) {
          const merged = mergeAbsorbedMeta(nextExisting[i], cand, { mergeCrossProtocolMeta: true });
          nextExisting[i] = merged;
          cloneFeatureSetWithAbsorbed(exFeat, merged);
        }
        absorbed = true;
        break;
      }
    }
    if (!absorbed) {
      existingIds.add(cand.id);
      appended.push(cand);
    }
  }

  return { nextExisting, appended };
}

function escapeFilterRegex(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildFilterMatcher(rawTerm) {
  const term = String(rawTerm || '').trim();
  if (!term) return null;
  const startsWord = /^[\p{L}\p{N}_]/u.test(term);
  const endsWord = /[\p{L}\p{N}_]$/u.test(term);
  const prefix = startsWord ? '(?<![\\p{L}\\p{N}_])' : '';

  let body;
  if (endsWord && term.length >= 6 && /s$/i.test(term) && !/(?:ss|us|is)$/i.test(term)) {
    const stem = escapeFilterRegex(term.slice(0, -1)).replace(/\s+/g, '\\s+');
    body = `(?:${stem}s?)`;
  } else {
    const base = escapeFilterRegex(term).replace(/\s+/g, '\\s+');
    body = endsWord && term.length >= 4 ? `${base}(?:s|es)?` : base;
  }

  const suffix = endsWord ? '(?![\\p{L}\\p{N}_])' : '';
  return new RegExp(`${prefix}${body}${suffix}`, 'iu');
}

function buildModeratedActorSet(moderatedActors = []) {
  if (moderatedActors instanceof Set) return moderatedActors;
  return new Set(
    (Array.isArray(moderatedActors) ? moderatedActors : [])
      .map((a) => String(a || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

function actorMatchesModSet(modSet, handleRaw, idRaw, protocol = 'mastodon', instanceUrl = '') {
  if (!modSet || modSet.size === 0) return false;
  const proto = protocol === 'fediverse' ? 'mastodon' : String(protocol || 'mastodon').toLowerCase();
  const h = String(handleRaw || '').trim().replace(/^@/, '').toLowerCase();
  const id = String(idRaw || '').trim().replace(/^@/, '').toLowerCase();
  const canon = h ? canonicalizeActorHandle(h, proto) : '';
  if ((canon && modSet.has(canon)) || (h && modSet.has(h))) return true;
  if (proto === 'mastodon' && h && !h.includes('@') && instanceUrl) {
    try {
      const host = new URL(String(instanceUrl)).hostname.toLowerCase();
      if (host && modSet.has(canonicalizeActorHandle(`${h}@${host}`, 'mastodon'))) {
        return true;
      }
    } catch {
      // ignore malformed instanceUrl
    }
  }
  if (id) {
    if (modSet.has(id) || modSet.has(`${proto}:${id}`)) return true;
  }
  return false;
}

/**
 * Determine whether a UnifiedItem (its author, booster, quoted author, or Bluesky viewer flags)
 * is muted or blocked.
 * @param {object} rawItem
 * @param {Array<string> | Set<string>} [moderatedActors]
 * @returns {boolean}
 */
export function isUnifiedItemModerated(rawItem, moderatedActors = []) {
  if (!rawItem || typeof rawItem !== 'object') return false;
  const item = toUnifiedItem(rawItem);
  if (item._meta?.bluesky?.viewerMuted || item._meta?.bluesky?.viewerBlocking) {
    return true;
  }
  const modSet = buildModeratedActorSet(moderatedActors);
  if (modSet.size === 0) return false;

  const proto = item.protocol || 'mastodon';
  const inst = item._meta?.mastodon?.instanceUrl || '';
  if (actorMatchesModSet(modSet, item.author?.handle, item.author?.id, proto, inst)) {
    return true;
  }
  const nmActor = item._meta?.notification?.actor;
  if (nmActor && actorMatchesModSet(modSet, nmActor.handle || nmActor.acct, nmActor.id || nmActor.did, proto, inst)) {
    return true;
  }
  const rebloggedBy = item._meta?.mastodon?.rebloggedBy || item._meta?.bluesky?.rebloggedBy || null;
  if (rebloggedBy && actorMatchesModSet(modSet, rebloggedBy.acct || rebloggedBy.handle, rebloggedBy.id || rebloggedBy.did, proto, inst)) {
    return true;
  }
  const quote = item._meta?.quotePost || null;
  if (quote && !quote.unavailable && actorMatchesModSet(modSet, quote.authorHandle, quote.authorDid, quote.protocol || proto, quote.instanceUrl || '')) {
    return true;
  }
  return false;
}

/**
 * Enforce Mastodon and local SQLite keyword filter rules ('hide' or 'warn')
 * across post text, content warnings, link preview cards, media alt text, and author metadata.
 * @param {Array<object>} items
 * @param {Array<{ phrase?: string, keywords?: string[], filter_action?: string, title?: string }>} rules
 * @returns {Array<object>}
 */
export function applyKeywordFilters(items = [], rules = [], moderatedActors = []) {
  const modSet = buildModeratedActorSet(moderatedActors);
  const compiledRules = [];
  for (const r of Array.isArray(rules) ? rules : []) {
    if (!r) continue;
    const rawTerms = Array.isArray(r.keywords) && r.keywords.length > 0
      ? r.keywords
      : [r.phrase || r.title || ''];
    const matchers = rawTerms.map(buildFilterMatcher).filter(Boolean);
    if (matchers.length === 0) continue;
    compiledRules.push({
      action: String(r.filter_action || 'hide').toLowerCase(),
      title: r.title || (r.phrase ? `Filtered: ${r.phrase}` : 'Filtered'),
      matchers,
    });
  }
  if (compiledRules.length === 0 && modSet.size === 0) {
    return items.filter((raw) => !(raw?._meta?.bluesky?.viewerMuted || raw?._meta?.bluesky?.viewerBlocking || raw?.viewerState?.viewerMuted || raw?.viewerState?.viewerBlocking));
  }

  const out = [];
  for (const raw of items) {
    const item = toUnifiedItem(raw);
    if (isUnifiedItemModerated(item, modSet)) continue;
    const linkCard = item._meta?.linkCard || {};
    const altTexts = Array.isArray(item.attachments)
      ? item.attachments.map((a) => a?.alt_text || '').filter(Boolean)
      : [];
    const quote = item._meta?.quotePost || null;
    const haystack = [
      item.content_text || '',
      item._meta?.mastodon?.spoilerText || '',
      linkCard.title || '',
      linkCard.description || '',
      linkCard.url || '',
      quote?.text || '',
      quote?.authorHandle || '',
      ...altTexts,
      item.author?.name || '',
      item.author?.handle || '',
    ].join('\n');

    let hidden = false;
    let warnTitle = '';
    for (const r of compiledRules) {
      if (!r.matchers.some((rx) => rx.test(haystack))) continue;
      if (r.action === 'hide') {
        hidden = true;
        break;
      }
      warnTitle = warnTitle || r.title;
    }
    if (hidden) continue;
    if (warnTitle && !item._meta?.mastodon?.spoilerText) {
      out.push({
        ...item,
        _meta: {
          ...item._meta,
          mastodon: { ...(item._meta?.mastodon || {}), spoilerText: warnTitle },
        },
      });
    } else {
      out.push(item);
    }
  }
  return out;
}
