import { sanitizeFediverseHtmlToString } from '../../queries/fediverse.js';

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
    parts.push(`<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(clean)}</a>`);
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
      author: { id: '', name: '', handle: '', avatar_url: '', url: '' },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: {},
    };
  }

  // Already a UnifiedItem
  if (ORIGIN_PROTOCOLS.includes(item.protocol) && typeof item.date_published === 'string' && item._meta) {
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

  const meta = {};
  if (protocol === 'mastodon') {
    meta.mastodon = {
      statusId: String(item._meta?.mastodon?.statusId || nativeId || ''),
      uri: item._meta?.mastodon?.uri || item.uri || item.url || '',
      visibility: item._meta?.mastodon?.visibility || item.visibility || 'public',
      sensitive: Boolean(item._meta?.mastodon?.sensitive ?? item.sensitive ?? item.raw?.sensitive ?? item.raw?.reblog?.sensitive),
      favourited: Boolean(item._meta?.mastodon?.favourited ?? item.viewerState?.favourited),
      reblogged: Boolean(item._meta?.mastodon?.reblogged ?? item.viewerState?.reblogged),
      bookmarked: Boolean(item._meta?.mastodon?.bookmarked ?? item.viewerState?.bookmarked),
      pinned: Boolean(item._meta?.mastodon?.pinned ?? item.pinned ?? item.raw?.pinned),
      spoilerText: item._meta?.mastodon?.spoilerText || item.spoilerText || '',
      inReplyToId: item._meta?.mastodon?.inReplyToId || item.inReplyToId || null,
      instanceUrl: item._meta?.mastodon?.instanceUrl || item.instanceUrl || 'https://mastodon.social',
      emojis: Array.isArray(item._meta?.mastodon?.emojis) ? item._meta.mastodon.emojis : (Array.isArray(item.emojis) ? item.emojis : []),
      ...(item._meta?.mastodon?.rebloggedBy || item.rebloggedBy ? { rebloggedBy: item._meta?.mastodon?.rebloggedBy || item.rebloggedBy } : {}),
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
      ...(bskyFacets.length > 0 ? { facets: bskyFacets } : {}),
      ...(bskyLabels.length > 0 ? { labels: bskyLabels } : {}),
      ...(item._meta?.bluesky?.reply || item.reply ? { reply: item._meta?.bluesky?.reply || item.reply } : {}),
      ...(item._meta?.bluesky?.rebloggedBy || item.rebloggedBy
        ? { rebloggedBy: item._meta?.bluesky?.rebloggedBy || item.rebloggedBy }
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

  return {
    id: `${protocol}:${nativeId}`,
    protocol,
    url: item.url || '',
    content_html: sanitizeFediverseHtmlToString(html, item.emojis || []),
    content_text: text,
    date_published: item.createdAt || new Date().toISOString(),
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
export function deduplicateUnifiedItems(items = [], windowMs = 120_000) {
  const normalized = items.filter(Boolean).map((it) => toUnifiedItem(it));
  const priority = { mastodon: 0, bluesky: 1, threads: 2 };
  const byId = new Map();

  for (const item of normalized) {
    if (!item.id) continue;
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
    } else {
      byId.set(item.id, { ...prev, ...item, _meta: { ...prev._meta, ...item._meta } });
    }
  }

  const ordered = [...byId.values()].sort((a, b) => {
    const dt = (Date.parse(b.date_published || '') || 0) - (Date.parse(a.date_published || '') || 0);
    if (dt !== 0) return dt;
    return (priority[a.protocol] ?? 9) - (priority[b.protocol] ?? 9);
  });

  const sigOf = (item) => {
    const notif = item._meta?.notification;
    const actor = notif ? notif.actor?.handle || item.author?.handle : item.author?.handle;
    const kind = notif ? `notif:${notif.type}` : 'post';
    const text = String(item.content_text || '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 100);
    return `${canonicalizeActorHandle(actor, item.protocol)}|${kind}|${text}`;
  };

  const kept = [];
  for (const cand of ordered) {
    const candSig = sigOf(cand);
    const candTs = Date.parse(cand.date_published || '') || 0;
    const dup = kept.find(
      (ex) => sigOf(ex) === candSig && Math.abs((Date.parse(ex.date_published || '') || 0) - candTs) <= windowMs
    );
    if (dup) {
      for (const k of ['mastodon', 'bluesky', 'threads', 'linkedIds', 'metricsBreakdown']) {
        if (cand._meta?.[k] && !dup._meta?.[k]) {
          dup._meta = { ...dup._meta, [k]: cand._meta[k] };
        }
      }
      continue;
    }
    kept.push(cand);
  }

  return kept;
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

/**
 * Enforce Mastodon and local SQLite keyword filter rules ('hide' or 'warn')
 * across post text, content warnings, link preview cards, media alt text, and author metadata.
 * @param {Array<object>} items
 * @param {Array<{ phrase?: string, keywords?: string[], filter_action?: string, title?: string }>} rules
 * @returns {Array<object>}
 */
export function applyKeywordFilters(items = [], rules = [], moderatedActors = []) {
  const modSet = new Set(
    (Array.isArray(moderatedActors) ? moderatedActors : [])
      .map((a) => String(a || '').trim().toLowerCase())
      .filter(Boolean)
  );
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
  if (compiledRules.length === 0 && modSet.size === 0) return items;

  const out = [];
  for (const raw of items) {
    const item = toUnifiedItem(raw);
    if (modSet.size > 0) {
      const actorKey = canonicalizeActorHandle(item.author?.handle || '', item.protocol || 'mastodon');
      if (actorKey && modSet.has(actorKey)) continue;
      const rebloggedBy = item._meta?.mastodon?.rebloggedBy || item._meta?.bluesky?.rebloggedBy || null;
      if (rebloggedBy?.acct || rebloggedBy?.handle) {
        const boosterKey = canonicalizeActorHandle(
          rebloggedBy.acct || rebloggedBy.handle,
          item.protocol || 'mastodon'
        );
        if (boosterKey && modSet.has(boosterKey)) continue;
      }
    }
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
