import {
  isAllowedSocialUrl,
  normalizeInstanceUrl,
} from '../constants/endpoints.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
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

export const MAX_VISIBLE_URL_CHARS = 26;

/**
 * Split a raw HTTP(S) URL label into hidden scheme/tail and capped visible prefix parts
 * while keeping full text intact in the DOM for accessibility, copy, and search.
 * @param {string} rawLabel
 * @param {string} [safeHref]
 */
export function splitUrlDisplayParts(rawLabel, safeHref = '') {
  const label = String(rawLabel || '');
  if (!label || /\s/.test(label) || label.startsWith('@') || label.startsWith('#') || /(?:\.\.\.|…)$/.test(label)) {
    return null;
  }
  const schemeMatch = /^(https?:\/\/(?:www\.)?)/i.exec(label);
  let matchesHrefHost = false;
  if (!schemeMatch && safeHref) {
    try {
      const parsed = new URL(String(safeHref));
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
        const cleanLabel = label.toLowerCase().replace(/^www\./, '');
        matchesHrefHost = Boolean(
          host
          && (cleanLabel === host || cleanLabel.startsWith(`${host}/`) || cleanLabel.startsWith(`${host}?`) || cleanLabel.startsWith(`${host}#`))
          && [...label].length > MAX_VISIBLE_URL_CHARS
        );
      }
    } catch {
      matchesHrefHost = false;
    }
  }
  if (!schemeMatch && !matchesHrefHost) {
    return null;
  }

  const prefix = schemeMatch ? schemeMatch[1] : '';
  const rest = label.slice(prefix.length);
  if (!rest) return null;

  const restChars = [...rest];
  if (rest.endsWith('/') && restChars.length - 1 <= MAX_VISIBLE_URL_CHARS && !rest.slice(0, -1).includes('/')) {
    return {
      prefix,
      visible: rest.slice(0, -1),
      ellipsis: false,
      tail: '/',
    };
  }
  if (restChars.length <= MAX_VISIBLE_URL_CHARS) {
    return {
      prefix,
      visible: rest,
      ellipsis: false,
      tail: '',
    };
  }
  return {
    prefix,
    visible: restChars.slice(0, MAX_VISIBLE_URL_CHARS).join(''),
    ellipsis: true,
    tail: restChars.slice(MAX_VISIBLE_URL_CHARS).join(''),
  };
}

/**
 * Format an HTTP(S) anchor label using `.invisible` and `.ellipsis` spans for CSS truncation.
 * @param {string} rawLabel
 * @param {string} [safeHref]
 * @returns {string}
 */
export function formatTruncatedUrlInnerHtml(rawLabel, safeHref = '') {
  const parts = splitUrlDisplayParts(rawLabel, safeHref);
  if (!parts) return escapeHtmlText(String(rawLabel || ''));
  const chunks = [];
  if (parts.prefix) {
    chunks.push(`<span class="invisible">${escapeHtmlText(parts.prefix)}</span>`);
  }
  if (parts.visible) {
    chunks.push(
      parts.ellipsis
        ? `<span class="ellipsis">${escapeHtmlText(parts.visible)}</span>`
        : `<span>${escapeHtmlText(parts.visible)}</span>`
    );
  }
  if (parts.tail) {
    chunks.push(`<span class="invisible">${escapeHtmlText(parts.tail)}</span>`);
  }
  return chunks.join('');
}

export function buildUrlDisplayFragment(doc, parts) {
  const frag = doc.createDocumentFragment();
  if (parts.prefix) {
    const sp = doc.createElement('span');
    sp.className = 'invisible';
    sp.textContent = parts.prefix;
    frag.appendChild(sp);
  }
  if (parts.visible) {
    const sp = doc.createElement('span');
    if (parts.ellipsis) sp.className = 'ellipsis';
    sp.textContent = parts.visible;
    frag.appendChild(sp);
  }
  if (parts.tail) {
    const sp = doc.createElement('span');
    sp.className = 'invisible';
    sp.textContent = parts.tail;
    frag.appendChild(sp);
  }
  return frag;
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

const ALLOWED_NODE_ATTRS = new Set(['href', 'rel', 'target', 'class', 'title', 'src', 'alt', 'loading']);

function buildAllowlistedDomNode(doc, sourceNode) {
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
      const built = buildAllowlistedDomNode(doc, child);
      if (built) frag.appendChild(built);
    }
    return frag;
  }
  const el = doc.createElement(tag);
  for (const attr of sourceNode.attributes) {
    if (ALLOWED_NODE_ATTRS.has(attr.name.toLowerCase())) {
      el.setAttribute(attr.name, attr.value);
    }
  }
  if (tag === 'a' && el.getAttribute('href')) {
    el.setAttribute('rel', 'noopener noreferrer');
    el.setAttribute('target', '_blank');
  }
  for (const child of sourceNode.childNodes) {
    const built = buildAllowlistedDomNode(doc, child);
    if (built) el.appendChild(built);
  }
  return el;
}

function appendCleanHtmlWithoutDomParser(containerEl, cleanHtml) {
  const doc = containerEl.ownerDocument || globalThis.document;
  if (!doc) return;
  const rootNodes = [];
  const stack = [];
  const appendTarget = (node) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.appendChild(node);
    else rootNodes.push(node);
  };

  let cursor = 0;
  while (cursor < cleanHtml.length) {
    const lt = cleanHtml.indexOf('<', cursor);
    if (lt === -1) {
      const tail = decodeHtmlEntities(cleanHtml.slice(cursor));
      if (tail) appendTarget(doc.createTextNode(tail));
      break;
    }
    if (lt > cursor) {
      const text = decodeHtmlEntities(cleanHtml.slice(cursor, lt));
      if (text) appendTarget(doc.createTextNode(text));
    }
    let gt = lt + 1;
    let quote = '';
    while (gt < cleanHtml.length) {
      const ch = cleanHtml[gt];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      gt += 1;
    }
    if (gt >= cleanHtml.length) {
      appendTarget(doc.createTextNode(decodeHtmlEntities(cleanHtml.slice(lt))));
      break;
    }
    const rawBody = cleanHtml.slice(lt + 1, gt).trim();
    cursor = gt + 1;
    if (!rawBody) continue;
    const isClosing = rawBody.startsWith('/');
    const tagContent = isClosing ? rawBody.slice(1).trim() : rawBody;
    const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(tagContent);
    if (!m) continue;
    const tagName = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tagName) && tagName !== 'img') continue;

    if (isClosing) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tagName.toLowerCase() === tagName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const el = doc.createElement(tagName);
    const attrs = parseTagAttributes(tagContent.slice(m[0].length));
    for (const [k, v] of attrs.entries()) {
      if (ALLOWED_NODE_ATTRS.has(k)) {
        el.setAttribute(k, decodeHtmlEntities(v));
      }
    }
    if (tagName === 'a' && el.getAttribute('href')) {
      el.setAttribute('rel', 'noopener noreferrer');
      el.setAttribute('target', '_blank');
    }
    appendTarget(el);
    if (!VOID_TAGS.has(tagName) && !rawBody.endsWith('/')) {
      stack.push(el);
    }
  }

  containerEl.replaceChildren(...rootNodes);
}

function appendDomNodesFromCleanHtml(containerEl, cleanHtml) {
  const doc = containerEl.ownerDocument;
  if (!doc) return;

  let parsedDoc = null;
  if (typeof globalThis.Document?.parseHTML === 'function') {
    try {
      parsedDoc = globalThis.Document.parseHTML(cleanHtml);
    } catch {
      parsedDoc = null;
    }
  }
  if (!parsedDoc && typeof DOMParser === 'function') {
    parsedDoc = new DOMParser().parseFromString(cleanHtml, 'text/html');
  }

  if (parsedDoc?.body) {
    const nodes = [];
    for (const child of parsedDoc.body.childNodes) {
      const built = buildAllowlistedDomNode(doc, child);
      if (built) nodes.push(built);
    }
    containerEl.replaceChildren(...nodes);
    return;
  }

  appendCleanHtmlWithoutDomParser(containerEl, cleanHtml);
}

function decorateBareUrlAnchors(containerEl) {
  if (!containerEl || typeof containerEl.querySelectorAll !== 'function') return;
  const doc = containerEl.ownerDocument || globalThis.document;
  if (!doc) return;
  for (const anchor of containerEl.querySelectorAll('a[href]')) {
    const cls = anchor.getAttribute?.('class') || '';
    if (/\b(?:mention|hashtag)\b/.test(cls)) continue;
    if (anchor.childNodes.length !== 1 || anchor.childNodes[0]?.nodeType !== 3) continue;
    const rawText = anchor.childNodes[0].nodeValue || '';
    const parts = splitUrlDisplayParts(rawText, anchor.getAttribute?.('href') || '');
    if (!parts) continue;
    anchor.replaceChildren(buildUrlDisplayFragment(doc, parts));
  }
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

  if ('setHTML' in containerEl && typeof containerEl.setHTML === 'function') {
    const sanitizerConfig = {
      elements: [...ALLOWED_TAGS, 'img'],
      attributes: [...ALLOWED_NODE_ATTRS],
    };
    try {
      containerEl.setHTML(cleanHtml, { sanitizer: sanitizerConfig });
    } catch {
      appendDomNodesFromCleanHtml(containerEl, cleanHtml);
    }
    if (typeof containerEl.querySelectorAll === 'function') {
      for (const anchor of containerEl.querySelectorAll('a[href]')) {
        anchor.setAttribute('rel', 'noopener noreferrer');
        anchor.setAttribute('target', '_blank');
      }
    }
    decorateBareUrlAnchors(containerEl);
    return;
  }

  appendDomNodesFromCleanHtml(containerEl, cleanHtml);
  decorateBareUrlAnchors(containerEl);
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

function resolveMastodonAttachmentUrl(rawUrl, origin) {
  const clean = cleanMastodonMediaUrl(rawUrl);
  if (!clean) return '';
  if (/^https?:\/\//i.test(clean)) return clean;
  if (clean.startsWith('//')) return `https:${clean}`;
  if (clean.startsWith('/') && origin) return `${origin}${clean}`;
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
  let linkCard = null;
  if (post?.card?.url) {
    const safeCardUrl = sanitizeHref(post.card.url);
    if (safeCardUrl) {
      linkCard = {
        url: safeCardUrl,
        title: decodeHtmlEntities(String(post.card.title || '')),
        description: decodeHtmlEntities(String(post.card.description || '')),
        image: cleanMastodonMediaUrl(post.card.image),
      };
    }
  }

  const rawQuote = post?.quote?.quoted_status || post?.quote || null;
  let quotePost = null;
  if (rawQuote && typeof rawQuote === 'object' && (rawQuote.id || rawQuote.content) && rawQuote.account) {
    const qAcc = normalizeMastodonAccount(rawQuote.account, origin);
    const qText = decodeHtmlEntities(
      String(rawQuote.content || '')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
    ).trim();
    const qThumb = cleanMastodonMediaUrl(rawQuote.media_attachments?.[0]?.preview_url || rawQuote.media_attachments?.[0]?.url);
    quotePost = {
      id: `mastodon:${rawQuote.id || ''}`,
      protocol: 'mastodon',
      statusId: String(rawQuote.id || ''),
      instanceUrl: origin,
      url: rawQuote.url || rawQuote.uri || '',
      authorName: qAcc.displayName,
      authorHandle: qAcc.acct,
      authorAvatar: qAcc.avatar,
      text: qText,
      createdAt: rawQuote.created_at || '',
      ...(qThumb ? { thumbUrl: qThumb } : {}),
      ...(rawQuote.sensitive || rawQuote.spoiler_text ? { sensitive: true } : {}),
    };
  }

  const rawFiltered = Array.isArray(post?.filtered)
    ? post.filtered
    : (Array.isArray(raw?.filtered) ? raw.filtered : []);
  let filteredAction = '';
  let filteredTitle = '';
  if (rawFiltered.length > 0) {
    const hasHide = rawFiltered.some(
      (f) => String(f?.filter?.filter_action || f?.filter_action || 'hide').toLowerCase() === 'hide'
    );
    filteredAction = hasHide ? 'hide' : 'warn';
    filteredTitle = String(rawFiltered[0]?.filter?.title || rawFiltered[0]?.title || '').trim();
  }

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
    rebloggedAt: reblogSource ? String(raw.created_at || '') : '',
    pinned: Boolean(post.pinned),
    contentHtml: post.content || '',
    sanitizedHtml: sanitizeFediverseHtmlToString(post.content || '', emojis),
    spoilerText: post.spoiler_text || '',
    sensitive: Boolean(post.sensitive),
    visibility: post.visibility || 'public',
    language: post.language ? String(post.language).trim().toLowerCase() : '',
    inReplyToId: post.in_reply_to_id ? String(post.in_reply_to_id) : null,
    inReplyToAccountId: post.in_reply_to_account_id ? String(post.in_reply_to_account_id) : null,
    media: Array.isArray(post.media_attachments)
      ? post.media_attachments.map((att) => {
          const url = resolveMastodonAttachmentUrl(att.url || att.remote_url, origin);
          const previewUrl = resolveMastodonAttachmentUrl(att.preview_url || att.url || att.remote_url, origin);
          const rawType = String(att.type || '').toLowerCase();
          let resolvedType = rawType;
          if (!resolvedType || resolvedType === 'unknown') {
            if (/\.(?:mp4|webm|mov|m4v)(?:[?#]|$)/i.test(url)) {
              resolvedType = 'video';
            } else if (/\.(?:jpe?g|png|webp|avif|gif)(?:[?#]|$)/i.test(url) || Boolean(previewUrl || url)) {
              resolvedType = 'image';
            } else {
              resolvedType = 'image';
            }
          }
          return {
            id: String(att.id || ''),
            type: resolvedType,
            url,
            previewUrl,
            description: att.description || '',
            width: Number.parseInt(att.meta?.original?.width || att.meta?.small?.width || 0, 10) || 0,
            height: Number.parseInt(att.meta?.original?.height || att.meta?.small?.height || 0, 10) || 0,
            meta: att.meta || null,
          };
        })
      : [],
    emojis,
    linkCard,
    ...(quotePost ? { quotePost } : {}),
    ...(filteredAction ? { filteredAction, ...(filteredTitle ? { filteredTitle } : {}) } : {}),
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
  hashtag = '',
  maxId = '',
  sinceId = '',
  limit = 20,
  onlyMedia = false,
  cache,
  timeoutMs,
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
  } else if (stream === 'hashtag') {
    const cleanTag = String(hashtag || '').replace(/^#/, '').trim();
    if (!cleanTag) throw new Error('hashtag is required for hashtag timeline');
    path = `/api/v1/timelines/tag/${encodeURIComponent(cleanTag)}`;
  } else if (stream === 'bookmarks') {
    path = '/api/v1/bookmarks';
  }

  if (onlyMedia) params.set('only_media', 'true');
  if (maxId) params.set('max_id', maxId);
  if (sinceId) params.set('since_id', sinceId);

  const res = await fetchWrapper(`${origin}${path}?${params.toString()}`, {
    headers: authHeaders(accessToken),
    responseType: 'raw',
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  const list = await res.json();
  const items = Array.isArray(list) ? list.map((s) => normalizeMastodonStatus(s, origin)) : [];
  const nextCursor = items.length >= limit ? extractNextMaxIdFromHeaders(res.headers, list) : null;
  return { items, nextCursor };
}

export async function getTagTimeline({
  instanceUrl = 'https://mastodon.social',
  accessToken = '',
  tag = '',
  maxId = '',
  limit = 15,
  onlyMedia = false,
  cache,
  timeoutMs,
  fetchImpl,
} = {}) {
  const cleanTag = String(tag || '').trim().replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  if (!cleanTag) return { items: [], nextCursor: null };
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (onlyMedia) params.set('only_media', 'true');
  if (maxId) params.set('max_id', maxId);
  const res = await fetchWrapper(`${origin}/api/v1/timelines/tag/${encodeURIComponent(cleanTag)}?${params.toString()}`, {
    headers: authHeaders(accessToken),
    responseType: 'raw',
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  const list = await res.json();
  const items = Array.isArray(list) ? list.map((s) => normalizeMastodonStatus(s, origin)) : [];
  const nextCursor = items.length >= limit ? extractNextMaxIdFromHeaders(res.headers, list) : null;
  return { items, nextCursor };
}

export async function getTrendingStatuses({
  instanceUrl = 'https://mastodon.social',
  accessToken = '',
  limit = 20,
  offset = 0,
  cache,
  timeoutMs,
  fetchImpl,
} = {}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(Math.max(0, Number(offset) || 0)),
  });
  const list = await fetchWrapper(`${origin}/api/v1/trends/statuses?${params.toString()}`, {
    headers: authHeaders(accessToken),
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  const items = Array.isArray(list) ? list.map((s) => normalizeMastodonStatus(s, origin)) : [];
  return {
    items,
    nextOffset: items.length >= limit ? (Number(offset) || 0) + items.length : null,
  };
}

/**
 * Return true if the host/origin matches a known Lemmy / Hexbear instance domain.
 * @param {string} hostOrUrl
 * @returns {boolean}
 */
export function isLemmyInstanceHost(hostOrUrl) {
  const clean = String(hostOrUrl || '')
    .trim()
    .toLowerCase()
    .replace(/^(?:https?:\/\/|:\/\/|\/\/)/, '')
    .split(/[/?#]/)[0]
    .replace(/\.$/, '');
  if (!clean) return false;
  return /^(?:lemmy[a-z0-9-]*\.|hexbear\.net$)/i.test(clean) || /\.lemmy\./i.test(clean);
}

/**
 * Normalize a Lemmy v3 PostView row ({ post, creator, community, counts }) into a fediverse PostItem.
 * @param {object} row
 * @param {string} instanceUrl
 */
export function normalizeLemmyPost(row, instanceUrl) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const host = new URL(origin).host;
  const post = row?.post || {};
  const creator = row?.creator || {};
  const community = row?.community || {};
  const counts = row?.counts || {};

  const postId = String(post.id || '');
  const permalink = sanitizeHref(post.ap_id || '') || `${origin}/post/${encodeURIComponent(postId)}`;

  let creatorHost = host;
  if (creator.actor_id) {
    try {
      creatorHost = new URL(creator.actor_id).host || host;
    } catch {
      creatorHost = host;
    }
  }
  const creatorName = String(creator.name || '').trim();
  const acct = creatorName ? `${creatorName}@${creatorHost}` : host;
  const displayName = decodeHtmlEntities(String(creator.display_name || creatorName || acct)).trim();

  const title = decodeHtmlEntities(String(post.name || '')).trim();
  const bodyText = decodeHtmlEntities(String(post.body || '')).trim();
  const commName = String(community.name || '').trim();
  const communityLabel = commName ? `!${commName}@${host}` : '';

  const htmlParts = [];
  if (title) {
    htmlParts.push(`<p><strong>${escapeHtmlText(title)}</strong></p>`);
  }
  if (communityLabel) {
    htmlParts.push(`<p><span>${escapeHtmlText(communityLabel)}</span></p>`);
  }
  if (bodyText) {
    for (const para of bodyText.replace(/\r\n/g, '\n').split(/\n{2,}/)) {
      const trimmed = para.trim();
      if (trimmed) {
        htmlParts.push(`<p>${trimmed.split('\n').map((line) => escapeHtmlText(line)).join('<br>')}</p>`);
      }
    }
  }
  const contentHtml = htmlParts.join('');

  const safePostUrl = sanitizeHref(post.url || '');
  const safeThumb = cleanMastodonMediaUrl(sanitizeHref(post.thumbnail_url || '') || '');
  const isImagePostUrl = Boolean(
    safePostUrl
    && (/\.(?:jpe?g|png|gif|webp|avif)(?:\?.*)?$/i.test(safePostUrl) || /\/(?:pictrs\/image|image_proxy)\b/i.test(safePostUrl))
  );

  const media = isImagePostUrl
    ? [{
        id: `lemmy-media:${postId}`,
        type: 'image',
        url: safePostUrl,
        previewUrl: safeThumb || safePostUrl,
        description: title,
        width: 0,
        height: 0,
        meta: null,
      }]
    : [];

  let linkCard = null;
  if (safePostUrl && !isImagePostUrl && safePostUrl !== permalink) {
    linkCard = {
      url: safePostUrl,
      title: decodeHtmlEntities(String(post.embed_title || title || safePostUrl)),
      description: decodeHtmlEntities(String(post.embed_description || '')),
      image: safeThumb,
    };
  }

  const publishedAt = String(post.published || counts.published || '');
  return {
    key: `fediverse:${origin}:lemmy:${post.ap_id || postId}`,
    network: 'fediverse',
    instanceUrl: origin,
    id: `lemmy:${postId}`,
    wrapperId: `lemmy:${postId}`,
    uri: post.ap_id || permalink,
    url: permalink,
    createdAt: publishedAt,
    createdAtMs: Date.parse(publishedAt) || 0,
    author: {
      id: String(creator.id || ''),
      username: creatorName || host,
      acct,
      displayName,
      avatar: cleanMastodonMediaUrl(creator.avatar || ''),
      header: '',
      url: sanitizeHref(creator.actor_id || '') || '',
      note: '',
      noteText: '',
      fields: [],
      locked: false,
      bot: Boolean(creator.bot_account),
      discoverable: true,
      indexable: true,
      hideCollections: false,
      defaultVisibility: 'public',
      defaultSensitive: false,
      defaultLanguage: 'en',
      attributionDomains: [],
      followersCount: 0,
      followingCount: 0,
      statusesCount: 0,
      emojis: [],
    },
    rebloggedBy: null,
    rebloggedAt: '',
    pinned: Boolean(post.featured_local || post.featured_community),
    contentHtml,
    sanitizedHtml: sanitizeFediverseHtmlToString(contentHtml, []),
    spoilerText: '',
    sensitive: Boolean(post.nsfw || community.nsfw),
    visibility: 'public',
    language: '',
    inReplyToId: null,
    inReplyToAccountId: null,
    media,
    emojis: [],
    linkCard,
    counts: {
      replies: Number(counts.comments || 0),
      reposts: 0,
      likes: Number(counts.upvotes ?? counts.score ?? 0),
    },
    viewerState: {
      favourited: false,
      reblogged: false,
      bookmarked: false,
    },
    raw: row,
  };
}

/**
 * Fetch local posts from a Lemmy v3 / Hexbear instance (/api/v3/post/list).
 */
export async function getLemmyLocalPosts({
  instanceUrl,
  pageCursor = '',
  limit = 12,
  cache,
  timeoutMs,
  fetchImpl,
} = {}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({
    type_: 'Local',
    sort: 'New',
    limit: String(limit),
  });
  const cursorStr = String(pageCursor || '').trim();
  if (cursorStr) {
    if (/^\d+$/.test(cursorStr)) {
      params.set('page', cursorStr);
    } else {
      params.set('page_cursor', cursorStr);
    }
  }
  const data = await fetchWrapper(`${origin}/api/v3/post/list?${params.toString()}`, {
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  const rows = Array.isArray(data?.posts) ? data.posts : [];
  const items = rows.map((row) => normalizeLemmyPost(row, origin));
  const nextCursor = items.length > 0 && data?.next_page ? String(data.next_page) : null;
  return { items, nextCursor };
}

export async function getUserLists({ instanceUrl, accessToken, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  return fetchWrapper(`${origin}/api/v1/lists`, {
    headers: authHeaders(accessToken),
    fetchImpl,
  });
}

export async function getFollowedTags({ instanceUrl, accessToken, limit = 50, cache, timeoutMs, fetchImpl } = {}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  const list = await fetchWrapper(`${origin}/api/v1/followed_tags?${params.toString()}`, {
    headers: authHeaders(accessToken),
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  const tags = [];
  const seen = new Set();
  for (const row of Array.isArray(list) ? list : []) {
    const clean = String(row?.name || '').trim().replace(/^#+/, '').toLowerCase();
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    tags.push(clean);
  }
  return tags;
}

export async function getFavouritedStatuses({ instanceUrl, accessToken, limit = 15, cache, timeoutMs, fetchImpl } = {}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  const list = await fetchWrapper(`${origin}/api/v1/favourites?${params.toString()}`, {
    headers: authHeaders(accessToken),
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  return Array.isArray(list) ? list.map((s) => normalizeMastodonStatus(s, origin)) : [];
}

export async function getStatusBoostersAndLikers({ instanceUrl, accessToken, statusId, limit = 20, timeoutMs, fetchImpl } = {}) {
  if (!statusId) return [];
  const origin = normalizeInstanceUrl(instanceUrl);
  const sid = encodeURIComponent(String(statusId));
  const params = new URLSearchParams({ limit: String(limit) });
  const opts = {
    headers: authHeaders(accessToken),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  };
  const [reblogsRes, favsRes] = await Promise.allSettled([
    fetchWrapper(`${origin}/api/v1/statuses/${sid}/reblogged_by?${params.toString()}`, opts),
    fetchWrapper(`${origin}/api/v1/statuses/${sid}/favourited_by?${params.toString()}`, opts),
  ]);
  const byKey = new Map();
  for (const res of [reblogsRes, favsRes]) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const acc of res.value) {
      const id = String(acc?.id || '');
      const acct = String(acc?.acct || acc?.username || '').trim();
      const key = acct.toLowerCase() || id;
      if (!key || byKey.has(key)) continue;
      byKey.set(key, {
        id,
        acct,
        username: String(acc?.username || ''),
        displayName: String(acc?.display_name || acc?.displayName || acct),
      });
    }
  }
  return [...byKey.values()];
}

export async function getNotifications({
  instanceUrl,
  accessToken,
  maxId = '',
  limit = 30,
  cache,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (maxId) params.set('max_id', maxId);
  const rows = await fetchWrapper(`${origin}/api/v1/notifications?${params.toString()}`, {
    headers: authHeaders(accessToken),
    ...(cache ? { cache } : {}),
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

export async function dismissMastodonNotification({
  instanceUrl,
  accessToken,
  notifId,
  fetchImpl,
}) {
  const cleanId = String(notifId || '').replace(/^mastodon:(?:notif:)?/, '').trim();
  if (!cleanId) return false;
  const origin = normalizeInstanceUrl(instanceUrl);
  await fetchWrapper(`${origin}/api/v1/notifications/${encodeURIComponent(cleanId)}/dismiss`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return true;
}

export async function clearMastodonNotifications({
  instanceUrl,
  accessToken,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  await fetchWrapper(`${origin}/api/v1/notifications/clear`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    fetchImpl,
  });
  return true;
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
  timeoutMs,
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
    ...(timeoutMs ? { timeoutMs } : {}),
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

export async function lookupAccountByAcct({ instanceUrl, accessToken = '', acct, timeoutMs, fetchImpl }) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const cleanAcct = String(acct || '').trim().replace(/^@/, '');
  const raw = await fetchWrapper(`${origin}/api/v1/accounts/lookup?acct=${encodeURIComponent(cleanAcct)}`, {
    headers: authHeaders(accessToken),
    ...(timeoutMs ? { timeoutMs } : {}),
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
  excludeReblogs = false,
  onlyMedia = false,
  pinned = false,
  limit = 20,
  timeoutMs,
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const params = new URLSearchParams({ limit: String(limit) });
  if (maxId) params.set('max_id', maxId);
  if (excludeReplies) params.set('exclude_replies', 'true');
  if (excludeReblogs) params.set('exclude_reblogs', 'true');
  if (onlyMedia) params.set('only_media', 'true');
  if (pinned) params.set('pinned', 'true');
  const rows = await fetchWrapper(
    `${origin}/api/v1/accounts/${encodeURIComponent(accountId)}/statuses?${params.toString()}`,
    { headers: authHeaders(accessToken), ...(timeoutMs ? { timeoutMs } : {}), fetchImpl }
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

export async function translateMastodonStatus({
  instanceUrl,
  accessToken = '',
  statusId,
  lang = 'en',
  fetchImpl,
}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const raw = await fetchWrapper(`${origin}/api/v1/statuses/${encodeURIComponent(statusId)}/translate`, {
    method: 'POST',
    headers: authHeaders(accessToken),
    json: { lang },
    timeoutMs: 8000,
    fetchImpl,
  });
  const contentHtml = String(raw?.content || '');
  return {
    html: sanitizeFediverseHtmlToString(contentHtml, []),
    text: decodeHtmlEntities(
      contentHtml
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/p\s*>/gi, '\n\n')
        .replace(/<[^>]*>/g, '')
    )
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    spoilerText: String(raw?.spoiler_text || ''),
    detectedSourceLanguage: String(raw?.detected_source_language || '').trim().toLowerCase(),
    provider: raw?.provider ? `Mastodon (${raw.provider})` : 'Mastodon',
  };
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
  const nowMs = Date.now();
  try {
    const rows = await fetchWrapper(`${origin}/api/v2/filters`, {
      headers: authHeaders(accessToken),
      fetchImpl,
    });
    return (Array.isArray(rows) ? rows : [])
      .filter((f) => {
        if (!f?.expires_at) return true;
        const exp = Date.parse(f.expires_at);
        return !Number.isFinite(exp) || exp > nowMs;
      })
      .map((f) => {
        const kws = Array.isArray(f.keywords)
          ? f.keywords.map((k) => String(k?.keyword || '').trim()).filter(Boolean)
          : [];
        return {
          id: String(f.id),
          title: f.title || kws[0] || '',
          phrase: kws[0] || f.title || '',
          ...(kws.length > 0 ? { keywords: kws } : {}),
          context: f.context || ['home', 'public', 'notifications', 'thread'],
          filter_action: f.filter_action || 'hide',
          mastodon_filter_id: String(f.id),
        };
      });
  } catch {
    const rows = await fetchWrapper(`${origin}/api/v1/filters`, {
      headers: authHeaders(accessToken),
      fetchImpl,
    });
    return (Array.isArray(rows) ? rows : [])
      .filter((f) => {
        if (!f?.expires_at) return true;
        const exp = Date.parse(f.expires_at);
        return !Number.isFinite(exp) || exp > nowMs;
      })
      .map((f) => ({
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
  const cleanPhrase = String(phrase || '').trim();
  const wholeWord = /^[\p{L}\p{N}_].*[\p{L}\p{N}_]$|^[\p{L}\p{N}_]$/u.test(cleanPhrase);
  try {
    const created = await fetchWrapper(`${origin}/api/v2/filters`, {
      method: 'POST',
      headers: authHeaders(accessToken),
      json: {
        title: title || cleanPhrase,
        context,
        filter_action: filterAction,
        keywords_attributes: [{ keyword: cleanPhrase, whole_word: wholeWord }],
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

const FEDIDB_SERVERS_URL = 'https://api.fedidb.org/v1/servers?limit=40';
const FEDIDB_CACHE_KV_KEY = 'sanctuary_fedidb_pool_v1';
const FEDIDB_QUARANTINE_KV_KEY = 'sanctuary_fedidb_quarantine_v1';
const FEDIDB_TTL_MS = 24 * 3600_000;
const PUBLIC_OPT_OUT_RE = /#(?:noindex|nobot|nodiscover)\b/i;

const SUPPORTED_FEDIDB_SLUGS = new Set([
  'mastodon',
  'pixelfed',
  'pleroma',
  'akkoma',
  'gotosocial',
  'hometown',
  'misskey',
  'sharkey',
  'firefish',
  'iceshrimp',
]);
const MISSKEY_FAMILY_SLUGS = new Set(['misskey', 'sharkey', 'firefish', 'iceshrimp']);
const AUTH_WALLED_PUBLIC_HOSTS = new Set([
  'mastodon.social',
  'mstdn.social',
  'mastodon.online',
  'pixelfed.social',
  'pixelfed.de',
  'pixelfed.uno',
  'gram.social',
  'metapixl.com',
  'fed.brid.gy',
]);

export const FALLBACK_FEDIVERSE_POOL = Object.freeze([
  Object.freeze({ domain: 'mastodon.world', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'mas.to', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'universeodon.com', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'hachyderm.io', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'fosstodon.org', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'sfba.social', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'mastodon.cloud', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'mstdn.jp', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'social.vivaldi.net', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'techhub.social', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'infosec.exchange', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'kolektiva.social', software: 'mastodon', weight: 1.0 }),
  Object.freeze({ domain: 'misskey.io', software: 'misskey', weight: 1.0 }),
  Object.freeze({ domain: 'misskey.design', software: 'misskey', weight: 1.0 }),
]);

let cachedFediPoolEntry = null;
const quarantinedPublicHosts = new Map();
let quarantineHydrated = false;
let lastSampledPoolDomains = new Set();

export function clearFediverseDiscoveryCacheForTests() {
  cachedFediPoolEntry = null;
  quarantinedPublicHosts.clear();
  quarantineHydrated = false;
  lastSampledPoolDomains.clear();
}

/**
 * Respect Fediverse privacy signals (#noindex, #nobot, discoverable: false, indexable: false)
 * on public discovery streams.
 * @param {object} item
 * @returns {boolean}
 */
export function isPublicDiscoveryOptOut(item) {
  if (!item || typeof item !== 'object') return false;
  const author = item.author || {};
  if (author.discoverable === false || author.indexable === false) return true;
  const bio = `${author.noteText || ''} ${author.note || ''}`;
  if (bio && PUBLIC_OPT_OUT_RE.test(bio)) return true;
  const body = `${item.content_text || item.text || ''} ${item.contentHtml || ''}`;
  return Boolean(body && PUBLIC_OPT_OUT_RE.test(body));
}

function escapeHtmlPlain(raw) {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeMisskeyNote(note, origin) {
  const host = new URL(origin).hostname;
  const user = note?.user || {};
  const uHost = String(user.host || host).toLowerCase();
  const uname = String(user.username || user.id || 'user');
  const acct = `${uname}@${uHost}`;
  const rawText = String(note?.text || '').trim();
  const cw = String(note?.cw || '').trim();
  const contentHtml = rawText ? `<p>${escapeHtmlPlain(rawText).replace(/\n+/g, '<br>')}</p>` : '';
  const files = Array.isArray(note?.files) ? note.files : [];
  const media = files
    .filter((f) => f && f.url)
    .map((f) => {
      const mime = String(f.type || '').toLowerCase();
      const type = mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'image');
      return {
        id: String(f.id || ''),
        type,
        mimeType: mime,
        url: cleanMastodonMediaUrl(f.url),
        previewUrl: cleanMastodonMediaUrl(f.thumbnailUrl || f.url),
        description: String(f.comment || ''),
        width: Number.parseInt(f.properties?.width || 0, 10) || 0,
        height: Number.parseInt(f.properties?.height || 0, 10) || 0,
      };
    });
  const publishedAt = String(note?.createdAt || '');
  const reactionTotal = Object.values(note?.reactions || {}).reduce((sum, n) => sum + Number(n || 0), 0);
  const permalink = sanitizeHref(note?.uri || note?.url || `${origin}/notes/${encodeURIComponent(String(note?.id || ''))}`)
    || `${origin}/notes/${encodeURIComponent(String(note?.id || ''))}`;

  return {
    key: `fediverse:${origin}:misskey:${note.id}`,
    network: 'fediverse',
    instanceUrl: origin,
    id: `misskey:${host}:${note.id}`,
    wrapperId: `misskey:${host}:${note.id}`,
    uri: note.uri || permalink,
    url: permalink,
    createdAt: publishedAt,
    createdAtMs: Date.parse(publishedAt) || 0,
    author: {
      id: String(user.id || uname),
      username: uname,
      acct,
      displayName: String(user.name || uname),
      avatar: cleanMastodonMediaUrl(user.avatarUrl || ''),
      header: '',
      url: sanitizeHref(`${origin}/@${uname}`) || '',
      note: '',
      noteText: String(user.description || ''),
      fields: [],
      locked: Boolean(user.isLocked),
      bot: Boolean(user.isBot),
      discoverable: user.discoverable !== false,
      indexable: user.indexable !== false,
      hideCollections: false,
      defaultVisibility: 'public',
      defaultSensitive: false,
      defaultLanguage: 'en',
      attributionDomains: [],
      followersCount: 0,
      followingCount: 0,
      statusesCount: 0,
      emojis: [],
    },
    rebloggedBy: null,
    rebloggedAt: '',
    pinned: false,
    contentHtml,
    sanitizedHtml: sanitizeFediverseHtmlToString(contentHtml, []),
    spoilerText: cw,
    sensitive: Boolean(cw || files.some((f) => Boolean(f?.isSensitive))),
    visibility: 'public',
    language: '',
    inReplyToId: null,
    inReplyToAccountId: null,
    media,
    emojis: [],
    linkCard: null,
    counts: {
      replies: Number(note?.repliesCount || 0),
      reposts: Number(note?.renoteCount || 0),
      likes: reactionTotal,
    },
    viewerState: { favourited: false, reblogged: false, bookmarked: false },
    raw: note,
  };
}

/**
 * Fetch local public notes from a Misskey / Sharkey / Firefish / Iceshrimp instance.
 */
export async function getMisskeyLocalNotes({
  instanceUrl,
  limit = 20,
  onlyMedia = false,
  untilId = '',
  cache,
  timeoutMs = 3500,
  fetchImpl,
} = {}) {
  const origin = normalizeInstanceUrl(instanceUrl);
  const body = { limit: Math.min(40, Math.max(1, Number(limit) || 20)) };
  if (onlyMedia) body.withFiles = true;
  if (untilId) body.untilId = untilId;
  const rows = await fetchWrapper(`${origin}/api/notes/local-timeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    json: body,
    ...(cache !== undefined ? { cache } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
    fetchImpl,
  });
  const list = Array.isArray(rows) ? rows : [];
  const items = [];
  for (const note of list) {
    if (!note || typeof note !== 'object' || note.replyId) continue;
    const vis = String(note.visibility || 'public').toLowerCase();
    if (vis !== 'public' && vis !== 'home') continue;
    if (!note.text && (!Array.isArray(note.files) || note.files.length === 0)) continue;
    items.push(normalizeMisskeyNote(note, origin));
  }
  const lastId = list.length >= body.limit && list[list.length - 1]?.id ? String(list[list.length - 1].id) : null;
  return { items, nextCursor: lastId };
}

async function ensureQuarantineHydrated() {
  if (quarantineHydrated) return;
  quarantineHydrated = true;
  const saved = await kvGet(FEDIDB_QUARANTINE_KV_KEY, null).catch(() => null);
  if (!saved || typeof saved !== 'object') return;
  const now = Date.now();
  for (const [host, expiresAt] of Object.entries(saved)) {
    if (Number(expiresAt) > now) quarantinedPublicHosts.set(host, Number(expiresAt));
  }
}

function recordQuarantinedHost(domain) {
  const clean = String(domain || '').trim().toLowerCase();
  if (!clean) return;
  const now = Date.now();
  quarantinedPublicHosts.set(clean, now + FEDIDB_TTL_MS);
  const snapshot = {};
  for (const [h, exp] of quarantinedPublicHosts.entries()) {
    if (exp > now) snapshot[h] = exp;
  }
  void kvSet(FEDIDB_QUARANTINE_KV_KEY, snapshot).catch(() => {});
}

function normalizeFediPoolEntry(domainRaw, softwareRaw = 'mastodon', weightRaw = 1) {
  const domain = String(domainRaw || '').trim().toLowerCase().replace(/^https?:\/\//, '').split(/[/?#]/)[0];
  if (!domain || !isAllowedSocialUrl(`https://${domain}`) || AUTH_WALLED_PUBLIC_HOSTS.has(domain)) {
    return null;
  }
  const software = String(softwareRaw || 'mastodon').trim().toLowerCase();
  if (!SUPPORTED_FEDIDB_SLUGS.has(software)) return null;
  return {
    domain,
    software,
    weight: Number.isFinite(Number(weightRaw)) && Number(weightRaw) > 0 ? Number(weightRaw) : 1,
  };
}

/**
 * Fetch and cache active Mastodon, Pixelfed, Pleroma, and Misskey instances from FediDB for 24 hours,
 * falling back cleanly to a curated open seed pool if offline or rate-limited.
 */
export async function fetchDynamicFediverseInstances({
  forceRefresh = false,
  timeoutMs = 4000,
  fetchImpl,
} = {}) {
  await ensureQuarantineHydrated();
  const now = Date.now();

  if (!forceRefresh) {
    if (cachedFediPoolEntry && cachedFediPoolEntry.expiresAt > now && Array.isArray(cachedFediPoolEntry.instances)) {
      return cachedFediPoolEntry.instances.filter((e) => (quarantinedPublicHosts.get(e.domain) || 0) <= now);
    }
    const stored = await kvGet(FEDIDB_CACHE_KV_KEY, null).catch(() => null);
    if (stored && Number(stored.expiresAt || 0) > now && Array.isArray(stored.instances) && stored.instances.length > 0) {
      cachedFediPoolEntry = { instances: stored.instances, expiresAt: Number(stored.expiresAt) };
      return stored.instances.filter((e) => (quarantinedPublicHosts.get(e.domain) || 0) <= now);
    }
  }

  const byDomain = new Map();
  const addEntry = (entry) => {
    if (!entry) return;
    if (!byDomain.has(entry.domain)) byDomain.set(entry.domain, entry);
  };

  try {
    const payload = await fetchWrapper(FEDIDB_SERVERS_URL, {
      ...(timeoutMs ? { timeoutMs } : {}),
      fetchImpl,
    });
    const rows = Array.isArray(payload?.data) ? payload.data : (Array.isArray(payload) ? payload : []);
    for (const row of rows) {
      if (!row || row.stats_held || row.open_registration === false) continue;
      const slug = String(row.software?.slug || row.software?.name || '').toLowerCase();
      addEntry(normalizeFediPoolEntry(row.domain, slug, 1.0));
    }
  } catch {
    // Fall back gracefully to seed list when offline or rate-limited
  }

  for (const seed of FALLBACK_FEDIVERSE_POOL) {
    addEntry(normalizeFediPoolEntry(seed.domain, seed.software, seed.weight));
  }

  const instances = [...byDomain.values()];
  cachedFediPoolEntry = { instances, expiresAt: now + FEDIDB_TTL_MS };
  void kvSet(FEDIDB_CACHE_KV_KEY, cachedFediPoolEntry).catch(() => {});
  return instances.filter((e) => (quarantinedPublicHosts.get(e.domain) || 0) <= now);
}

function weightedSampleInstances(pool, count, { onlyMedia = false, mediaType = 'any', avoidDomains = null, rng = Math.random } = {}) {
  const candidates = [...pool];
  if (candidates.length === 0 || count <= 0) return [];
  const shouldAvoid = avoidDomains instanceof Set && avoidDomains.size > 0 && candidates.length > count;
  const picked = [];
  while (picked.length < count && candidates.length > 0) {
    const weights = candidates.map((c) => {
      let w = c.weight || 1;
      if (mediaType === 'image' && c.software === 'pixelfed') {
        w *= 6.0;
      } else if (onlyMedia && (c.software === 'pixelfed' || MISSKEY_FAMILY_SLUGS.has(c.software))) {
        w *= 2.5;
      }
      if (shouldAvoid && avoidDomains.has(c.domain)) {
        w *= 0.12;
      }
      return w;
    });
    const totalW = weights.reduce((a, b) => a + b, 0);
    let target = (typeof rng === 'function' ? rng() : Math.random()) * totalW;
    let chosenIdx = candidates.length - 1;
    for (let i = 0; i < weights.length; i += 1) {
      target -= weights[i];
      if (target <= 0) {
        chosenIdx = i;
        break;
      }
    }
    picked.push(candidates.splice(chosenIdx, 1)[0]);
  }
  return picked;
}

function matchesFediverseMediaType(item, mediaType = 'any') {
  if (!mediaType || mediaType === 'any') return true;
  const media = Array.isArray(item?.media) ? item.media : [];
  if (media.length === 0) return false;
  if (mediaType === 'image') {
    return media.some((m) => String(m?.type || 'image').toLowerCase() === 'image');
  }
  if (mediaType === 'video') {
    return media.some((m) => {
      const t = String(m?.type || '').toLowerCase();
      return t === 'video' || t === 'gifv' || Boolean(m?.hlsUrl);
    });
  }
  return true;
}

/**
 * Sample open Fediverse instances uniformly at random from the 24h FediDB cache in parallel (3500ms timeout),
 * drop opt-out accounts (#noindex, #nobot, discoverable: false, indexable: false), and ingest Misskey & #loops video streams.
 */
export async function harvestDynamicFediversePool({
  sampleSize = 10,
  perInstanceLimit = 20,
  timeoutMs = 3500,
  onlyMedia = false,
  mediaType = 'any',
  includePhotoTags = false,
  includeLoopsTags = false,
  connectedHost = '',
  connectedAccessToken = '',
  forceRefresh = false,
  rng = Math.random,
  fetchImpl,
} = {}) {
  const pool = await fetchDynamicFediverseInstances({ timeoutMs: Math.max(timeoutMs, 4000), fetchImpl });
  const reqCache = forceRefresh ? 'no-store' : undefined;
  const sampled = weightedSampleInstances(pool, Math.min(12, Math.max(1, Number(sampleSize) || 10)), {
    onlyMedia: Boolean(onlyMedia || mediaType !== 'any'),
    mediaType,
    avoidDomains: forceRefresh ? lastSampledPoolDomains : null,
    rng,
  });
  lastSampledPoolDomains = new Set(sampled.map((s) => s.domain));

  const cleanConnHost = String(connectedHost || '').trim().toLowerCase();
  const tasks = sampled.map(async (entry) => {
    const origin = `https://${entry.domain}`;
    try {
      const res = MISSKEY_FAMILY_SLUGS.has(entry.software)
        ? await getMisskeyLocalNotes({
            instanceUrl: origin,
            limit: perInstanceLimit,
            onlyMedia: Boolean(onlyMedia || mediaType !== 'any'),
            ...(reqCache ? { cache: reqCache } : {}),
            timeoutMs,
            fetchImpl,
          })
        : await getTimeline({
            instanceUrl: origin,
            accessToken: entry.domain === cleanConnHost ? connectedAccessToken : '',
            stream: 'local',
            onlyMedia: Boolean(onlyMedia || mediaType !== 'any'),
            limit: perInstanceLimit,
            ...(reqCache ? { cache: reqCache } : {}),
            timeoutMs,
            fetchImpl,
          });
      return res.items || [];
    } catch (err) {
      const status = Number(err?.status || 0);
      if (status === 401 || status === 403 || status === 404 || status === 422) {
        recordQuarantinedHost(entry.domain);
      }
      return [];
    }
  });

  const extraTags = [];
  if (includePhotoTags) extraTags.push('pixelfed', 'fediphoto', 'photography', 'photooftheday');
  if (includeLoopsTags) extraTags.push('loops', 'loopsvideo', 'shortform', 'video');

  if (extraTags.length > 0) {
    const tagHosts = [cleanConnHost || 'mastodon.world', 'mas.to'];
    const seenTagHost = new Set();
    for (const host of tagHosts) {
      if (!host || seenTagHost.has(host)) continue;
      seenTagHost.add(host);
      for (const tag of extraTags) {
        tasks.push(
          getTagTimeline({
            instanceUrl: `https://${host}`,
            accessToken: host === cleanConnHost ? connectedAccessToken : '',
            tag,
            onlyMedia: true,
            limit: 25,
            ...(reqCache ? { cache: reqCache } : {}),
            timeoutMs,
            fetchImpl,
          })
            .then((r) => r.items || [])
            .catch(() => [])
        );
      }
    }
  }

  const settled = await Promise.allSettled(tasks);
  const out = [];
  for (const res of settled) {
    if (res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const item of res.value) {
      if (!item || isPublicDiscoveryOptOut(item)) continue;
      if (!matchesFediverseMediaType(item, mediaType)) continue;
      out.push(item);
    }
  }
  return out;
}
