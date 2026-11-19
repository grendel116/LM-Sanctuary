import {
  isAllowedSocialUrl,
  normalizeInstanceUrl,
} from '../constants/endpoints.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';

const DROP_CONTENT_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'noscript',
  'template',
  'form',
]);

const ALLOWED_TAGS = new Set([
  'p',
  'br',
  'a',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  'del',
  's',
  'code',
  'pre',
  'blockquote',
  'ul',
  'ol',
  'li',
]);

const VOID_TAGS = new Set(['br', 'img']);

function escapeHtmlText(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(value) {
  return escapeHtmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function decodeHtmlEntities(str) {
  return String(str || '').replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (full, ent) => {
    const lower = ent.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos' || lower === '#39') return "'";
    if (lower.startsWith('#x')) {
      const code = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    if (lower.startsWith('#')) {
      const code = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    }
    return full;
  });
}

function sanitizeHref(rawHref) {
  const decoded = decodeHtmlEntities(rawHref).replace(/[\u0000-\u0020]+/g, '').trim();
  if (!decoded) return null;
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:' || parsed.protocol === 'mailto:') {
      return parsed.href;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeSafeClass(rawClass) {
  const tokens = decodeHtmlEntities(rawClass)
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => /^[a-zA-Z0-9_-]+$/.test(t));
  return tokens.join(' ');
}

function parseTagAttributes(attrSlice) {
  const attrs = new Map();
  let i = 0;
  const len = attrSlice.length;
  while (i < len) {
    while (i < len && /[\s/]/.test(attrSlice[i])) i += 1;
    if (i >= len) break;
    const nameStart = i;
    while (i < len && !/[\s=/>]/.test(attrSlice[i])) i += 1;
    const name = attrSlice.slice(nameStart, i).toLowerCase();
    while (i < len && /\s/.test(attrSlice[i])) i += 1;

    let value = '';
    if (i < len && attrSlice[i] === '=') {
      i += 1;
      while (i < len && /\s/.test(attrSlice[i])) i += 1;
      if (i < len && (attrSlice[i] === '"' || attrSlice[i] === "'")) {
        const quote = attrSlice[i];
        i += 1;
        const valStart = i;
        while (i < len && attrSlice[i] !== quote) i += 1;
        value = attrSlice.slice(valStart, i);
        if (i < len && attrSlice[i] === quote) i += 1;
      } else {
        const valStart = i;
        while (i < len && !/[\s>]/.test(attrSlice[i])) i += 1;
        value = attrSlice.slice(valStart, i);
      }
    }
    if (name && !attrs.has(name)) {
      attrs.set(name, value);
    }
  }
  return attrs;
}

function formatTextWithCustomEmojis(rawText, emojiMap) {
  const decoded = decodeHtmlEntities(rawText);
  if (!emojiMap || emojiMap.size === 0) {
    return escapeHtmlText(decoded);
  }
  const parts = [];
  let lastIdx = 0;
  for (const match of decoded.matchAll(/:([a-zA-Z0-9_]+):/g)) {
    if (match.index > lastIdx) {
      parts.push(escapeHtmlText(decoded.slice(lastIdx, match.index)));
    }
    const shortcode = match[1];
    const emojiUrl = emojiMap.get(shortcode);
    if (emojiUrl) {
      const label = `:${shortcode}:`;
      parts.push(`<img class="custom-emoji" src="${escapeHtmlAttr(emojiUrl)}" alt="${escapeHtmlAttr(label)}" title="${escapeHtmlAttr(label)}" loading="lazy">`);
    } else {
      parts.push(escapeHtmlText(match[0]));
    }
    lastIdx = match.index + match[0].length;
  }
  if (lastIdx < decoded.length) {
    parts.push(escapeHtmlText(decoded.slice(lastIdx)));
  }
  return parts.join('');
}

function buildSafeEmojiMap(customEmojis = []) {
  const map = new Map();
  if (!Array.isArray(customEmojis)) return map;
  for (const emoji of customEmojis) {
    const code = typeof emoji?.shortcode === 'string' ? emoji.shortcode.trim() : '';
    const url = emoji?.url || emoji?.static_url || '';
    if (/^[a-zA-Z0-9_]+$/.test(code) && isAllowedSocialUrl(url)) {
      map.set(code, new URL(url).href);
    }
  }
  return map;
}

/**
 * Tokenizer-based allowlist sanitizer for untrusted ActivityPub post HTML.
 * Drops active/dangerous tags (<script>, <style>, <iframe>, <svg>, etc.) including
 * their inner content, rejects javascript:/data: hrefs, and substitutes custom emojis.
 * @param {string} html
 * @param {Array<{ shortcode: string, url?: string, static_url?: string }>} [customEmojis]
 * @returns {string}
 */
export function sanitizeFediverseHtmlToString(html, customEmojis = []) {
  const input = String(html || '');
  if (!input) return '';

  const emojiMap = buildSafeEmojiMap(customEmojis);
  const emojiUrlSet = new Set(emojiMap.values());
  const out = [];
  let dropDepth = 0;
  let i = 0;

  while (i < input.length) {
    const lt = input.indexOf('<', i);
    if (lt === -1) {
      if (dropDepth === 0) {
        out.push(formatTextWithCustomEmojis(input.slice(i), emojiMap));
      }
      break;
    }

    if (lt > i && dropDepth === 0) {
      out.push(formatTextWithCustomEmojis(input.slice(i, lt), emojiMap));
    }

    if (input.startsWith('<!--', lt)) {
      const commentEnd = input.indexOf('-->', lt + 4);
      i = commentEnd === -1 ? input.length : commentEnd + 3;
      continue;
    }

    // Find matching closing '>' outside quotes so quoted attributes cannot terminate early.
    let cursor = lt + 1;
    let quoteChar = '';
    while (cursor < input.length) {
      const ch = input[cursor];
      if (quoteChar) {
        if (ch === quoteChar) quoteChar = '';
      } else if (ch === '"' || ch === "'") {
        quoteChar = ch;
      } else if (ch === '>') {
        break;
      }
      cursor += 1;
    }

    if (cursor >= input.length) {
      if (dropDepth === 0) {
        out.push(escapeHtmlText(input.slice(lt)));
      }
      break;
    }

    const rawTagBody = input.slice(lt + 1, cursor).trim();
    i = cursor + 1;

    if (!rawTagBody || rawTagBody.startsWith('!') || rawTagBody.startsWith('?')) {
      continue;
    }

    const isClosing = rawTagBody.startsWith('/');
    const tagContent = isClosing ? rawTagBody.slice(1).trim() : rawTagBody;
    const tagMatch = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagContent);
    if (!tagMatch) {
      continue;
    }
    const tagName = tagMatch[1].toLowerCase();

    if (DROP_CONTENT_TAGS.has(tagName)) {
      if (isClosing) {
        dropDepth = Math.max(0, dropDepth - 1);
      } else if (!rawTagBody.endsWith('/')) {
        dropDepth += 1;
      }
      continue;
    }

    if (dropDepth > 0) {
      continue;
    }

    if (tagName === 'img') {
      if (isClosing) continue;
      const attrs = parseTagAttributes(tagContent.slice(tagMatch[0].length));
      const rawSrc = decodeHtmlEntities(attrs.get('src') || '').trim();
      if (isAllowedSocialUrl(rawSrc)) {
        const canonicalSrc = new URL(rawSrc).href;
        const safeClass = sanitizeSafeClass(attrs.get('class') || '');
        if (emojiUrlSet.has(canonicalSrc) || safeClass.split(' ').includes('custom-emoji')) {
          const alt = decodeHtmlEntities(attrs.get('alt') || '');
          const title = decodeHtmlEntities(attrs.get('title') || alt);
          out.push(`<img class="custom-emoji" src="${escapeHtmlAttr(canonicalSrc)}" alt="${escapeHtmlAttr(alt)}" title="${escapeHtmlAttr(title)}" loading="lazy">`);
        }
      }
      continue;
    }

    if (!ALLOWED_TAGS.has(tagName)) {
      continue;
    }

    if (isClosing) {
      if (!VOID_TAGS.has(tagName)) {
        out.push(`</${tagName}>`);
      }
      continue;
    }

    const attrs = parseTagAttributes(tagContent.slice(tagMatch[0].length));
    const serializedAttrs = [];

    if (tagName === 'a') {
      const safeHref = sanitizeHref(attrs.get('href') || '');
      if (safeHref) {
        serializedAttrs.push(`href="${escapeHtmlAttr(safeHref)}"`);
        serializedAttrs.push('rel="noopener noreferrer"');
        serializedAttrs.push('target="_blank"');
      }
      const cls = sanitizeSafeClass(attrs.get('class') || '');
      if (cls) serializedAttrs.push(`class="${escapeHtmlAttr(cls)}"`);
    } else if (tagName === 'span') {
      const cls = sanitizeSafeClass(attrs.get('class') || '');
      if (cls) serializedAttrs.push(`class="${escapeHtmlAttr(cls)}"`);
    }

    const titleAttr = attrs.get('title');
    if (titleAttr && tagName !== 'img') {
      serializedAttrs.push(`title="${escapeHtmlAttr(decodeHtmlEntities(titleAttr))}"`);
    }

    const attrStr = serializedAttrs.length > 0 ? ` ${serializedAttrs.join(' ')}` : '';
    out.push(`<${tagName}${attrStr}>`);
  }

  return out.join('');
}

function appendDomNodesFromCleanHtml(containerEl, cleanHtml) {
  const doc = containerEl.ownerDocument;
  if (typeof DOMParser === 'function' && doc) {
    const parsed = new DOMParser().parseFromString(cleanHtml, 'text/html');
    const buildNode = (sourceNode) => {
      if (sourceNode.nodeType === 3) {
        return doc.createTextNode(sourceNode.nodeValue || '');
      }
      if (sourceNode.nodeType !== 1) {
        return null;
      }
      const tag = sourceNode.tagName.toLowerCase();
      if (!ALLOWED_TAGS.has(tag) && tag !== 'img') {
        const frag = doc.createDocumentFragment();
        for (const child of sourceNode.childNodes) {
          const built = buildNode(child);
          if (built) frag.appendChild(built);
        }
        return frag;
      }
      const el = doc.createElement(tag);
      for (const attr of sourceNode.attributes) {
        el.setAttribute(attr.name, attr.value);
      }
      for (const child of sourceNode.childNodes) {
        const built = buildNode(child);
        if (built) el.appendChild(built);
      }
      return el;
    };

    const nodes = [];
    for (const child of parsed.body.childNodes) {
      const built = buildNode(child);
      if (built) nodes.push(built);
    }
    containerEl.replaceChildren(...nodes);
    return;
  }

  containerEl.textContent = decodeHtmlEntities(cleanHtml.replace(/<[^>]*>/g, ''));
}

/**
 * Safely mount untrusted Fediverse HTML inside a DOM element without innerHTML assignment.
 * Prefers native Element.prototype.setHTML() when present and falls back to DOMParser allowlist node creation.
 * @param {Element} containerEl
 * @param {string} html
 * @param {Array<{ shortcode: string, url?: string, static_url?: string }>} [customEmojis]
 */
export function renderSanitizedHtml(containerEl, html, customEmojis = []) {
  if (!containerEl) return;
  containerEl.replaceChildren();
  const cleanHtml = sanitizeFediverseHtmlToString(html, customEmojis);
  if (!cleanHtml) return;

  if (typeof containerEl.setHTML === 'function') {
    containerEl.setHTML(cleanHtml);
    if (typeof containerEl.querySelectorAll === 'function') {
      for (const anchor of containerEl.querySelectorAll('a[href]')) {
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.setAttribute('target', '_blank');
      }
    }
    return;
  }

  appendDomNodesFromCleanHtml(containerEl, cleanHtml);
}

/**
 * Render a profile metadata field value as clickable link when valid URL/HTML, plus optional verification tick.
 */
export function renderProfileFieldValue(containerEl, field, customEmojis = []) {
  if (!containerEl) return;
  const doc = containerEl.ownerDocument || globalThis.document;
  containerEl.replaceChildren();

  const valueHtml = String(field?.valueHtml || field?.value_html || '');
  const rawValue = decodeHtmlEntities(String(field?.value || '').trim());

  if (/<a\b/i.test(valueHtml)) {
    renderSanitizedHtml(containerEl, valueHtml, customEmojis);
  } else {
    const safeHref = sanitizeHref(rawValue);
    if (safeHref && doc) {
      const anchor = doc.createElement('a');
      anchor.href = safeHref;
      anchor.setAttribute('target', '_blank');
      anchor.setAttribute('rel', 'noopener noreferrer');
      anchor.textContent = rawValue;
      containerEl.appendChild(anchor);
    } else {
      containerEl.textContent = rawValue;
    }
  }

  if (field?.verified_at && doc) {
    const badge = doc.createElement('span');
    badge.className = 'profile-verified-badge';
    badge.title = 'Verified via rel="me"';
    badge.textContent = '✓ Verified';
    containerEl.appendChild(badge);
  }
}

/**
 * Extract an HTTP(S) URL from a Mastodon profile field value or anchor HTML, or return ''.
 * @param {string} rawValue
 */
export function extractFieldLinkUrl(rawValue) {
  const text = String(rawValue || '').trim();
  if (!text) return '';
  const anchorMatch = /<a\b[^>]*href=(?:"([^"]+)"|'([^']+)')/i.exec(text);
  const candidate = anchorMatch ? (anchorMatch[1] || anchorMatch[2] || '') : text;
  const decoded = decodeHtmlEntities(candidate).replace(/[\u0000-\u0020]+/g, '').trim();
  if (!decoded) return '';
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
      return parsed.href;
    }
  } catch {
    // Ignore non-URL plain metadata values
  }
  return '';
}

/**
 * Derive a compact human-readable label for a profile link pill (never raw https:// URL text).
 * @param {string} name
 * @param {string} href
 */
export function formatCompactLinkLabel(name, href) {
  const cleanName = decodeHtmlEntities(String(name || '')).trim();
  if (cleanName && !/^https?:\/\//i.test(cleanName)) {
    return cleanName;
  }
  try {
    const host = new URL(href).hostname.replace(/^www\./i, '');
    if (host) return host;
  } catch {
    // Fallback below
  }
  return cleanName || String(href || '').replace(/^https?:\/\//i, '');
}

/**
 * Render profile links as compact label pills (.profile-link-chip) and plain attributes as subtle chips.
 * @param {Element} containerEl
 * @param {Array<object>} [fields]
 * @param {Array<object>} [customEmojis]
 */
export function renderProfileLinksAndFields(containerEl, fields = [], customEmojis = []) {
  if (!containerEl) return;
  const doc = containerEl.ownerDocument || globalThis.document;
  containerEl.replaceChildren();
  if (!doc || !Array.isArray(fields) || fields.length === 0) return;

  for (const field of fields) {
    const name = decodeHtmlEntities(String(field?.name || '')).trim();
    const rawValueHtml = String(field?.valueHtml || field?.value_html || '');
    const rawValueText = decodeHtmlEntities(String(field?.value || '').trim());
    const href = extractFieldLinkUrl(rawValueText) || extractFieldLinkUrl(rawValueHtml);

    if (href) {
      const chip = doc.createElement('a');
      chip.className = 'profile-link-chip';
      chip.href = href;
      chip.setAttribute('target', '_blank');
      chip.setAttribute('rel', 'noopener noreferrer');
      chip.title = href;

      const arrow = doc.createElement('span');
      arrow.className = 'profile-link-chip-icon';
      arrow.setAttribute('aria-hidden', 'true');
      arrow.textContent = '↗';

      const labelSpan = doc.createElement('span');
      labelSpan.className = 'profile-link-chip-label';
      labelSpan.textContent = formatCompactLinkLabel(name, href);
      chip.append(arrow, labelSpan);

      if (field?.verified_at || field?.verifiedAt) {
        const vBadge = doc.createElement('span');
        vBadge.className = 'profile-verified-check';
        vBadge.title = 'Verified link';
        vBadge.textContent = '✓';
        chip.appendChild(vBadge);
      }
      containerEl.appendChild(chip);
      continue;
    }

    if (!name && !rawValueText) continue;
    const metaChip = doc.createElement('span');
    metaChip.className = 'profile-meta-chip';
    if (name) {
      const kSpan = doc.createElement('span');
      kSpan.className = 'profile-meta-chip-key';
      kSpan.textContent = `${name}:`;
      metaChip.appendChild(kSpan);
    }
    const vSpan = doc.createElement('span');
    vSpan.className = 'profile-meta-chip-val';
    if (/<[a-z]/i.test(rawValueHtml)) {
      renderSanitizedHtml(vSpan, rawValueHtml, customEmojis);
    } else {
      vSpan.textContent = rawValueText;
    }
    metaChip.appendChild(vSpan);
    containerEl.appendChild(metaChip);
  }
}

function authHeaders(accessToken, extra = {}) {
  const headers = { ...extra };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

export function cleanMastodonMediaUrl(url) {
  const clean = String(url || '').trim();
  if (!clean || clean.toLowerCase().endsWith('/missing.png')) return '';
  return clean;
}

export function parseMastodonNextMaxId(linkHeader) {
  const header = String(linkHeader || '');
  if (!header) return null;
  const nextMatch = /<([^>]+)>;\s*rel="next"/i.exec(header);
  if (!nextMatch) return null;
  try {
    return new URL(nextMatch[1]).searchParams.get('max_id') || null;
  } catch {
    return null;
  }
}

function extractNextMaxIdFromHeaders(headers, items) {
  const nextFromLink = parseMastodonNextMaxId(headers?.get?.('link'));
  if (nextFromLink) return nextFromLink;
  return items.length > 0 ? String(items[items.length - 1].id || '') : null;
}

/**
 * @param {object} rawAccount
 * @param {string} instanceUrl
 */
export function normalizeMastodonAccount(rawAccount, instanceUrl) {
  const host = new URL(instanceUrl).host;
  const rawAcct = String(rawAccount?.acct || rawAccount?.username || '');
  const fullAcct = rawAcct.includes('@') ? rawAcct : `${rawAcct}@${host}`;
  const emojis = Array.isArray(rawAccount?.emojis) ? rawAccount.emojis : [];
  const source = rawAccount?.source || {};
  const rawFields = Array.isArray(source.fields) ? source.fields : (Array.isArray(rawAccount?.fields) ? rawAccount.fields : []);
  const fields = rawFields.slice(0, 4).map((f) => ({
    name: decodeHtmlEntities(String(f?.name || '')),
    value: decodeHtmlEntities(String(f?.value || '').replace(/<[^>]*>/g, '')).trim(),
    valueHtml: sanitizeFediverseHtmlToString(String(f?.value || ''), emojis),
    verified_at: f?.verified_at || null,
  }));
  const noteHtml = rawAccount?.note || '';
  const noteText = source.note !== undefined
    ? String(source.note || '')
    : decodeHtmlEntities(
        String(noteHtml).replace(/<br\s*\/?>/gi, '\n').replace(/<\/p\s*>/gi, '\n\n').replace(/<[^>]*>/g, '')
      ).trim();

  const localUsername = String(rawAccount?.username || rawAcct.replace(/^@/, '').split('@')[0] || rawAcct);
  const cleanDisplayName = decodeHtmlEntities(String(rawAccount?.display_name || '')).trim();

  return {
    id: String(rawAccount?.id || ''),
    username: localUsername,
    acct: fullAcct,
    displayName: cleanDisplayName || localUsername,
    avatar: cleanMastodonMediaUrl(rawAccount?.avatar || rawAccount?.avatar_static),
    header: cleanMastodonMediaUrl(rawAccount?.header || rawAccount?.header_static),
    url: rawAccount?.url || '',
    note: noteHtml,
    noteText,
    fields,
    locked: Boolean(rawAccount?.locked),
    bot: Boolean(rawAccount?.bot),
    discoverable: rawAccount?.discoverable !== false,
    indexable: source.indexable !== undefined ? Boolean(source.indexable) : (rawAccount?.indexable !== false),
    hideCollections: source.hide_collections !== undefined
      ? Boolean(source.hide_collections)
      : Boolean(rawAccount?.hide_collections),
    defaultVisibility: source.privacy || 'public',
    defaultSensitive: Boolean(source.sensitive),
    defaultLanguage: source.language || 'en',
    attributionDomains: Array.isArray(source.attribution_domains)
      ? source.attribution_domains
      : (Array.isArray(rawAccount?.attribution_domains) ? rawAccount.attribution_domains : []),
    followersCount: rawAccount?.followers_count ?? 0,
    followingCount: rawAccount?.following_count ?? 0,
    statusesCount: rawAccount?.statuses_count ?? 0,
    emojis,
  };
}

/**
 * Normalize a Mastodon / GoToSocial / Pixelfed / Akkoma status into a uniform PostItem.
 * @param {object} raw
 * @param {string} instanceUrl
 */
export function normalizeMastodonStatus(raw, instanceUrl) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const reblogSource = raw?.reblog || null;
  const post = reblogSource || raw;
  const emojis = Array.isArray(post?.emojis) ? post.emojis : [];

  return {
    key: `fediverse:${origin}:${post.uri || post.id}`,
    network: 'fediverse',
    instanceUrl: origin,
    id: String(post.id || ''),
    wrapperId: String(raw.id || post.id || ''),
    uri: post.uri || post.url || '',
    url: post.url || post.uri || '',
    createdAt: post.created_at || raw.created_at || '',
    createdAtMs: Date.parse(post.created_at || raw.created_at || '') || 0,
    author: normalizeMastodonAccount(post.account || {}, origin),
    rebloggedBy: reblogSource ? normalizeMastodonAccount(raw.account || {}, origin) : null,
    contentHtml: post.content || '',
    sanitizedHtml: sanitizeFediverseHtmlToString(post.content || '', emojis),
    spoilerText: post.spoiler_text || '',
    visibility: post.visibility || 'public',
    inReplyToId: post.in_reply_to_id ? String(post.in_reply_to_id) : null,
    media: Array.isArray(post.media_attachments)
      ? post.media_attachments.map((att) => ({
          id: String(att.id || ''),
          type: att.type || 'image',
          url: att.url || att.remote_url || '',
          previewUrl: att.preview_url || att.url || '',
          description: att.description || '',
          meta: att.meta || null,
        }))
      : [],
    emojis,
    counts: {
      replies: post.replies_count ?? 0,
      reposts: post.reblogs_count ?? 0,
      likes: post.favourites_count ?? 0,
    },
    viewerState: {
      favourited: Boolean(post.favourited),
      reblogged: Boolean(post.reblogged),
      bookmarked: Boolean(post.bookmarked),
    },
    raw,
  };
}

/**
 * Dynamic OAuth2 client registration on any Mastodon-compatible server.
 */
export async function registerOAuthApp({
  instanceUrl,
  clientName = 'LM-Sanctuary',
  redirectUri,
  scopes = 'read write follow push',
  website = '',
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/apps`, {
    method: 'POST',
    json: {
      client_name: clientName,
      redirect_uris: redirectUri,
      scopes,
      ...(website ? { website } : {}),
    },
    fetchImpl,
  });
}

export function buildOAuthAuthorizeUrl({
  instanceUrl,
  clientId,
  redirectUri,
  scope = 'read write follow push',
  state = '',
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const url = new URL(`${origin}/oauth/authorize`);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scope);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

export async function exchangeOAuthCode({
  instanceUrl,
  clientId,
  clientSecret,
  redirectUri,
  code,
  scope = 'read write follow push',
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/oauth/token`, {
    method: 'POST',
    json: {
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code,
      scope,
    },
    fetchImpl,
  });
}

export async function verifyCredentials({ instanceUrl, accessToken, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const account = await fetchWrapper(`${origin}/api/v1/accounts/verify_credentials`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonAccount(account, origin);
}

/**
 * Fetch Home, Local, Federated, List, or Bookmarks timeline.
 */
export async function getTimeline({
  instanceUrl,
  accessToken = '',
  stream = 'home',
  listId = '',
  maxId = '',
  sinceId = '',
  limit = 20,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  let path = '/api/v1/timelines/home';
  const params = new URLSearchParams({ limit: String(limit) });

  if (stream === 'local') {
    path = '/api/v1/timelines/public';
    params.set('local', 'true');
  } else if (stream === 'federated') {
    path = '/api/v1/timelines/public';
  } else if (stream === 'list') {
    if (!listId) throw new Error('listId is required for list timeline');
    path = `/api/v1/timelines/list/${encodeURIComponent(listId)}`;
  } else if (stream === 'bookmarks') {
    path = '/api/v1/bookmarks';
  }

  if (maxId) params.set('max_id', maxId);
  if (sinceId) params.set('since_id', sinceId);

  const res = await fetchWrapper(`${origin}${path}?${params.toString()}`, {
    headers: authHeaders(accessToken),
    responseType: 'raw',
    fetchImpl,
  });
  const list = await res.json();
  const items = Array.isArray(list) ? list.map((s) => normalizeMastodonStatus(s, origin)) : [];
  const nextCursor = items.length >= limit ? extractNextMaxIdFromHeaders(res.headers, list) : null;
  return { items, nextCursor };
}

export async function getTrendingStatuses({
  instanceUrl = 'https://mastodon.social',
  limit = 20,
  offset = 0,
  fetchImpl,
} = {}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(Math.max(0, Number(offset) || 0)),
  });
  const list = await fetchWrapper(`${origin}/api/v1/trends/statuses?${params.toString()}`, {
    fetchImpl,
  });
  const items = Array.isArray(list) ? list.map((s) => normalizeMastodonStatus(s, origin)) : [];
  return {
    items,
    nextOffset: items.length >= limit ? (Number(offset) || 0) + items.length : null,
  };
}

export async function getUserLists({ instanceUrl, accessToken, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/lists`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

export async function getNotifications({
  instanceUrl,
  accessToken,
  maxId = '',
  limit = 30,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (maxId) params.set('max_id', maxId);
  const rows = await fetchWrapper(`${origin}/api/v1/notifications?${params.toString()}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return Array.isArray(rows)
    ? rows.map((n) => ({
        id: String(n.id),
        type: n.type,
        createdAt: n.created_at,
        createdAtMs: Date.parse(n.created_at || '') || 0,
        account: normalizeMastodonAccount(n.account || {}, origin),
        status: n.status ? normalizeMastodonStatus(n.status, origin) : null,
      }))
    : [];
}

export async function getStatus({ instanceUrl, accessToken = '', statusId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const status = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonStatus(status, origin);
}

export async function getStatusContext({ instanceUrl, accessToken = '', statusId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const [status, context] = await Promise.all([
    getStatus({ instanceUrl: origin, accessToken, statusId, fetchImpl }),
    fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/context`, {
      headers: authHeaders(accessToken),
      fetchImpl,
    }),
  ]);
  return {
    status,
    ancestors: Array.isArray(context?.ancestors)
      ? context.ancestors.map((s) => normalizeMastodonStatus(s, origin))
      : [],
    descendants: Array.isArray(context?.descendants)
      ? context.descendants.map((s) => normalizeMastodonStatus(s, origin))
      : [],
  };
}

export async function searchFediverse({
  instanceUrl,
  accessToken = '',
  query,
  type = '',
  resolve = true,
  limit = 20,
  offset = 0,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({
    q: String(query || ''),
    resolve: resolve ? 'true' : 'false',
    limit: String(limit),
    offset: String(offset),
  });
  if (type) params.set('type', type);
  const res = await fetchWrapper(`${origin}/api/v2/search?${params.toString()}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return {
    accounts: Array.isArray(res?.accounts) ? res.accounts.map((a) => normalizeMastodonAccount(a, origin)) : [],
    statuses: Array.isArray(res?.statuses) ? res.statuses.map((s) => normalizeMastodonStatus(s, origin)) : [],
    hashtags: Array.isArray(res?.hashtags) ? res.hashtags : [],
  };
}

export async function getConversations({ instanceUrl, accessToken, maxId = '', limit = 20, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (maxId) params.set('max_id', maxId);
  const list = await fetchWrapper(`${origin}/api/v1/conversations?${params.toString()}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return Array.isArray(list)
    ? list.map((convo) => ({
        id: String(convo.id),
        network: 'fediverse',
        unread: Boolean(convo.unread),
        accounts: Array.isArray(convo.accounts)
          ? convo.accounts.map((a) => normalizeMastodonAccount(a, origin))
          : [],
        lastStatus: convo.last_status ? normalizeMastodonStatus(convo.last_status, origin) : null,
      }))
    : [];
}

export async function getAccountProfile({ instanceUrl, accessToken = '', accountId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const raw = await fetchWrapper(`${origin}/api/v1/accounts/${encodeURIComponent(accountId)}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonAccount(raw, origin);
}

export async function lookupAccountByAcct({ instanceUrl, accessToken = '', acct, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const cleanAcct = String(acct || '').trim().replace(/^@/, '');
  const raw = await fetchWrapper(`${origin}/api/v1/accounts/lookup?acct=${encodeURIComponent(cleanAcct)}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonAccount(raw, origin);
}

export async function getAccountStatuses({
  instanceUrl,
  accessToken = '',
  accountId,
  maxId = '',
  excludeReplies = false,
  onlyMedia = false,
  pinned = false,
  limit = 20,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (maxId) params.set('max_id', maxId);
  if (excludeReplies) params.set('exclude_replies', 'true');
  if (onlyMedia) params.set('only_media', 'true');
  if (pinned) params.set('pinned', 'true');
  const rows = await fetchWrapper(
    `${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?${params.toString()}`,
    { headers: authHeaders(accessToken), fetchImpl }
  );
  return Array.isArray(rows) ? rows.map((s) => normalizeMastodonStatus(s, origin)) : [];
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer?.unref?.();
  });
}

/**
 * Upload media to Mastodon /api/v2/media (returning public HTTPS CDN attachment URL).
 */
export async function uploadMedia({
  instanceUrl,
  accessToken,
  file,
  description = '',
  pollDelayMs = 500,
  maxPolls = 12,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const form = new FormData();
  form.append('file', file);
  if (description) {
    form.append('description', description);
  }

  const res = await fetchWrapper(`${origin}/api/v2/media`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: form,
    responseType: 'raw',
    timeoutMs: 60000,
    fetchImpl,
  });
  let media = await res.json();

  if ((res.status === 202 || !media?.url) && media?.id) {
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      if (pollDelayMs > 0) await sleep(pollDelayMs);
      const checkRes = await fetchWrapper(`${origin}/api/v1/media/${encodeURIComponent(media.id)}`, {
        headers: authHeaders(accessToken),
        responseType: 'raw',
        fetchImpl,
      });
      if (checkRes.status === 200) {
        media = await checkRes.json();
        if (media?.url) break;
      }
    }
  }

  return {
    id: String(media.id),
    url: media.url || '',
    previewUrl: media.preview_url || media.url || '',
    type: media.type || 'image',
    description: media.description || description,
  };
}

export async function publishStatus({
  instanceUrl,
  accessToken,
  status,
  spoilerText = '',
  visibility = 'public',
  mediaIds = [],
  inReplyToId = null,
  language = '',
  idempotencyKey = '',
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const extraHeaders = idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {};
  const payload = {
    status: String(status || ''),
    visibility,
  };
  if (spoilerText) payload.spoiler_text = spoilerText;
  if (Array.isArray(mediaIds) && mediaIds.length > 0) payload.media_ids = mediaIds;
  if (inReplyToId) payload.in_reply_to_id = inReplyToId;
  if (language) payload.language = language;

  const created = await fetchWrapper(`${origin}/api/v1/statuses`, {
    method: 'POST',
    headers: authHeaders(accessToken, extraHeaders),
    json: payload,
    fetchImpl,
  });
  return normalizeMastodonStatus(created, origin);
}

/**
 * Publish a multi-post thread sequentially by chaining in_reply_to_id.
 */
export async function publishThread({
  instanceUrl,
  accessToken,
  posts = [],
  firstPostMediaIds = [],
  visibility = 'public',
  inReplyToId = null,
  language = '',
  fetchImpl,
}) {
  const results = [];
  let parentId = inReplyToId;
  for (let i = 0; i < posts.length; i += 1) {
    const entry = posts[i];
    const published = await publishStatus({
      instanceUrl,
      accessToken,
      status: entry.status ?? entry.text ?? '',
      spoilerText: entry.spoilerText ?? '',
      visibility: entry.visibility ?? visibility,
      mediaIds: i === 0 ? firstPostMediaIds : [],
      inReplyToId: parentId,
      language,
      fetchImpl,
    });
    results.push(published);
    parentId = published.id;
  }
  return results;
}

export async function toggleFavourite({ instanceUrl, accessToken, statusId, favourited, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const action = favourited ? 'unfavourite' : 'favourite';
  const updated = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonStatus(updated, origin);
}

export async function toggleReblog({ instanceUrl, accessToken, statusId, reblogged, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const action = reblogged ? 'unreblog' : 'reblog';
  const updated = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonStatus(updated, origin);
}

export async function toggleBookmark({ instanceUrl, accessToken, statusId, bookmarked, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const action = bookmarked ? 'unbookmark' : 'bookmark';
  const updated = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonStatus(updated, origin);
}

export async function updateCredentials({
  instanceUrl,
  accessToken,
  displayName,
  note,
  locked,
  bot,
  discoverable,
  indexable,
  hideCollections,
  defaultVisibility,
  defaultSensitive,
  defaultLanguage,
  fields,
  attributionDomains,
  avatarFile = null,
  headerFile = null,
  removeAvatar = false,
  removeHeader = false,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  if (removeAvatar && !avatarFile) {
    await fetchWrapper(`${origin}/api/v1/profile/avatar`, {
      method: 'DELETE',
      headers: authHeaders(accessToken),
      fetchImpl,
    }).catch(() => null);
  }
  if (removeHeader && !headerFile) {
    await fetchWrapper(`${origin}/api/v1/profile/header`, {
      method: 'DELETE',
      headers: authHeaders(accessToken),
      fetchImpl,
    }).catch(() => null);
  }

  const form = new FormData();
  if (displayName !== undefined) form.append('display_name', String(displayName));
  if (note !== undefined) form.append('note', String(note));
  if (locked !== undefined) form.append('locked', locked ? 'true' : 'false');
  if (bot !== undefined) form.append('bot', bot ? 'true' : 'false');
  if (discoverable !== undefined) form.append('discoverable', discoverable ? 'true' : 'false');
  if (indexable !== undefined) {
    const idxVal = indexable ? 'true' : 'false';
    form.append('indexable', idxVal);
    form.append('source[indexable]', idxVal);
  }
  if (hideCollections !== undefined) form.append('hide_collections', hideCollections ? 'true' : 'false');
  if (defaultVisibility !== undefined) form.append('source[privacy]', String(defaultVisibility));
  if (defaultSensitive !== undefined) form.append('source[sensitive]', defaultSensitive ? 'true' : 'false');
  if (defaultLanguage !== undefined) form.append('source[language]', String(defaultLanguage));
  if (Array.isArray(fields)) {
    for (let i = 0; i < 4; i += 1) {
      const f = fields[i] || { name: '', value: '' };
      form.append(`fields_attributes[${i}][name]`, String(f.name || ''));
      form.append(`fields_attributes[${i}][value]`, String(f.value || ''));
    }
  }
  if (Array.isArray(attributionDomains)) {
    const cleanDomains = attributionDomains.map((d) => String(d || '').trim()).filter(Boolean);
    if (cleanDomains.length === 0) {
      form.append('attribution_domains[]', '');
    } else {
      for (const dom of cleanDomains) {
        form.append('attribution_domains[]', dom);
      }
    }
  }
  if (avatarFile) form.append('avatar', avatarFile);
  if (headerFile) form.append('header', headerFile);

  const updated = await fetchWrapper(`${origin}/api/v1/accounts/update_credentials`, {
    method: 'PATCH',
    headers: authHeaders(accessToken),
    body: form,
    fetchImpl,
  });
  return normalizeMastodonAccount(updated, origin);
}

export async function editStatus({ instanceUrl, accessToken, statusId, status, spoilerText = '', fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const payload = { status: String(status || '') };
  if (spoilerText) payload.spoiler_text = spoilerText;
  const updated = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}`, {
    method: 'PUT',
    headers: authHeaders(accessToken),
    json: payload,
    fetchImpl,
  });
  return normalizeMastodonStatus(updated, origin);
}

export async function deleteStatus({ instanceUrl, accessToken, statusId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return true;
}

export async function pinStatus({ instanceUrl, accessToken, statusId, pinned, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const action = pinned ? 'unpin' : 'pin';
  const updated = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return normalizeMastodonStatus(updated, origin);
}

export async function createUserList({ instanceUrl, accessToken, title, repliesPolicy = 'list', exclusive = false, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/lists`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    json: { title, replies_policy: repliesPolicy, exclusive },
    fetchImpl,
  });
}

export async function deleteUserList({ instanceUrl, accessToken, listId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  await fetchWrapper(`${origin}/api/v1/lists/${encodeURIComponent(listId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return true;
}

export async function getListAccounts({ instanceUrl, accessToken, listId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const rows = await fetchWrapper(`${origin}/api/v1/lists/${encodeURIComponent(listId)}/accounts?limit=50`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return Array.isArray(rows) ? rows.map((a) => normalizeMastodonAccount(a, origin)) : [];
}

export async function addAccountsToList({ instanceUrl, accessToken, listId, accountIds = [], fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    json: { account_ids: accountIds },
    fetchImpl,
  });
}

export async function removeAccountsFromList({ instanceUrl, accessToken, listId, accountIds = [], fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/lists/${encodeURIComponent(listId)}/accounts`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
    json: { account_ids: accountIds },
    fetchImpl,
  });
}

export async function getFilters({ instanceUrl, accessToken, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  try {
    const rows = await fetchWrapper(`${origin}/api/v2/filters`, {
      headers: authHeaders(accessToken),
      fetchImpl,
    });
    return (Array.isArray(rows) ? rows : []).map((f) => ({
      id: String(f.id),
      title: f.title || f.keywords?.[0]?.keyword || '',
      phrase: f.keywords?.[0]?.keyword || f.title || '',
      context: f.context || ['home', 'public', 'notifications', 'thread'],
      filter_action: f.filter_action || 'hide',
      mastodon_filter_id: String(f.id),
    }));
  } catch {
    const rows = await fetchWrapper(`${origin}/api/v1/filters`, {
      headers: authHeaders(accessToken),
      fetchImpl,
    });
    return (Array.isArray(rows) ? rows : []).map((f) => ({
      id: String(f.id),
      title: f.phrase || '',
      phrase: f.phrase || '',
      context: f.context || ['home', 'public'],
      filter_action: 'hide',
      mastodon_filter_id: String(f.id),
    }));
  }
}

export async function createFilterRule({ instanceUrl, accessToken, title, phrase, context = ['home', 'public', 'notifications', 'thread'], filterAction = 'hide', fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  try {
    const created = await fetchWrapper(`${origin}/api/v2/filters`, {
      method: 'POST',
      headers: authHeaders(accessToken),
      json: {
        title: title || phrase,
        context,
        filter_action: filterAction,
        keywords_attributes: [{ keyword: phrase, whole_word: false }],
      },
      fetchImpl,
    });
    return {
      id: String(created.id),
      title: created.title || title || phrase,
      phrase,
      context: created.context || context,
      filter_action: created.filter_action || filterAction,
      mastodon_filter_id: String(created.id),
    };
  } catch {
    const created = await fetchWrapper(`${origin}/api/v1/filters`, {
      method: 'POST',
      headers: authHeaders(accessToken),
      json: { phrase, context, irreversible: filterAction === 'hide' },
      fetchImpl,
    });
    return {
      id: String(created.id),
      title: title || phrase,
      phrase: created.phrase || phrase,
      context: created.context || context,
      filter_action: filterAction,
      mastodon_filter_id: String(created.id),
    };
  }
}

export async function deleteFilterRule({ instanceUrl, accessToken, filterId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  try {
    await fetchWrapper(`${origin}/api/v2/filters/${encodeURIComponent(filterId)}`, {
      method: 'DELETE',
      headers: authHeaders(accessToken),
      fetchImpl,
    });
  } catch {
    await fetchWrapper(`${origin}/api/v1/filters/${encodeURIComponent(filterId)}`, {
      method: 'DELETE',
      headers: authHeaders(accessToken),
      fetchImpl,
    });
  }
  return true;
}

export async function getMutes({ instanceUrl, accessToken, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const rows = await fetchWrapper(`${origin}/api/v1/mutes`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return Array.isArray(rows) ? rows.map((a) => normalizeMastodonAccount(a, origin)) : [];
}

export async function getBlocks({ instanceUrl, accessToken, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const rows = await fetchWrapper(`${origin}/api/v1/blocks`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return Array.isArray(rows) ? rows.map((a) => normalizeMastodonAccount(a, origin)) : [];
}

export async function getRelationships({ instanceUrl, accessToken, accountIds = [], fetchImpl }) {
  if (!accountIds.length) return [];
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams();
  for (const id of accountIds) params.append('id[]', String(id));
  return fetchWrapper(`${origin}/api/v1/accounts/relationships?${params.toString()}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

export async function followAccount({ instanceUrl, accessToken, accountId, unfollow = false, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/${unfollow ? 'unfollow' : 'follow'}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

export async function muteAccount({ instanceUrl, accessToken, accountId, unmute = false, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/${unmute ? 'unmute' : 'mute'}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

export async function blockAccount({ instanceUrl, accessToken, accountId, unblock = false, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/${unblock ? 'unblock' : 'block'}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

async function fetchAccountConnectionPage({
  instanceUrl,
  accessToken = '',
  accountId,
  edge,
  maxId = '',
  limit = 40,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (maxId) params.set('max_id', maxId);
  const res = await fetchWrapper(`${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/${edge}?${params.toString()}`, {
    headers: authHeaders(accessToken),
    responseType: 'raw',
    fetchImpl,
  });
  const rows = await res.json();
  const accounts = Array.isArray(rows) ? rows.map((a) => normalizeMastodonAccount(a, origin)) : [];
  if (accessToken && accounts.length > 0) {
    const rels = await getRelationships({
      instanceUrl: origin,
      accessToken,
      accountIds: accounts.map((a) => a.id).filter(Boolean),
      fetchImpl,
    }).catch(() => []);
    const byId = new Map((Array.isArray(rels) ? rels : []).map((r) => [String(r.id), r]));
    for (const acc of accounts) {
      acc.relationship = byId.get(String(acc.id)) || null;
    }
  }
  return {
    accounts,
    nextCursor: parseMastodonNextMaxId(res.headers?.get?.('link')),
  };
}

export async function getAccountFollowing({ instanceUrl, accessToken = '', accountId, maxId = '', limit = 40, fetchImpl }) {
  return fetchAccountConnectionPage({ instanceUrl, accessToken, accountId, edge: 'following', maxId, limit, fetchImpl });
}

export async function getAccountFollowers({ instanceUrl, accessToken = '', accountId, maxId = '', limit = 40, fetchImpl }) {
  return fetchAccountConnectionPage({ instanceUrl, accessToken, accountId, edge: 'followers', maxId, limit, fetchImpl });
}

export async function removeFollower({ instanceUrl, accessToken, accountId, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/remove_from_followers`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

export async function getFollowRequests({ instanceUrl, accessToken, limit = 40, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const rows = await fetchWrapper(`${origin}/api/v1/follow_requests?limit=${limit}`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return Array.isArray(rows) ? rows.map((a) => normalizeMastodonAccount(a, origin)) : [];
}

export async function respondFollowRequest({ instanceUrl, accessToken, accountId, accept = true, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const action = accept ? 'authorize' : 'reject';
  return fetchWrapper(`${origin}/api/v1/follow_requests/${encodeURIComponent(accountId)}/${action}`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}
