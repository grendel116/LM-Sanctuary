import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { detectPostLanguageInfo, resolveLanguageDisplayName } from '../core/postLanguage.js';
import {
  enrichUnlinkedMentionsInHtml,
  getSensitiveMediaWarning,
  plainTextToHtml,
  toUnifiedItem,
} from '../core/schema/unifiedItem.js';
import { buildUrlDisplayFragment, renderSanitizedHtml, splitUrlDisplayParts } from '../queries/fediverse.js';
import { translateUnifiedPost } from '../queries/socialClient.js';
import { authStore } from '../state/authStore.js';
import { feedStore } from '../state/feedStore.js';
import { createContentWarning } from './ContentWarning.js';
import { createEmbedCard, resolvePostEmbedCard } from './EmbedCard.js';
import { createPostMediaGrid } from './MediaAttachment.js';
import { openMediaLightbox } from './sanctuary/PortraitGrid.js';

const REPLY_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
const REPLY_ACTIVE_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path><path d="m9 12 2 2 4-4"></path></svg>`;
const REPOST_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path></svg>`;
const REPOST_ACTIVE_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M11 18H7a4 4 0 0 1-4-4v-1"></path><path d="m15 16 2 2 4-4"></path></svg>`;
const HEART_OUTLINE_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
const HEART_FILLED_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
const SANCTUARY_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4Z"></path></svg>`;
const SHARE_LINK_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`;
const CHECK_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const MORE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>`;
const TRANSLATE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 8 6 6"></path><path d="m4 14 6-6 2-3"></path><path d="M2 5h12"></path><path d="M7 2h1"></path><path d="m22 22-5-10-5 10"></path><path d="M14 18h6"></path></svg>`;
const EYE_OPEN_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
export const VOLUME_MUTED_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><line x1="23" y1="9" x2="17" y2="15"></line><line x1="17" y1="9" x2="23" y2="15"></line></svg>`;
export const VOLUME_ON_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`;

const PROTOCOL_LABELS = Object.freeze({
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  threads: 'Threads',
});

export const PROTOCOL_LOGO_SVGS = Object.freeze({
  mastodon: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M23.268 5.313c-.35-2.578-2.617-4.61-5.304-5.004C17.51.242 15.792 0 11.813 0h-.03c-3.98 0-4.835.242-5.288.309C3.882.692 1.496 2.518.917 5.127.64 6.412.61 7.837.661 9.143c.074 1.874.088 3.745.26 5.611.118 1.24.325 2.47.62 3.68.55 2.237 2.777 4.098 4.96 4.857 2.336.792 4.849.923 7.256.38.265-.061.527-.132.786-.213.585-.184 1.27-.39 1.774-.753a.057.057 0 0 0 .023-.043v-1.809a.052.052 0 0 0-.02-.041.053.053 0 0 0-.046-.01 20.282 20.282 0 0 1-4.709.545c-2.73 0-3.463-1.284-3.674-1.818a5.593 5.593 0 0 1-.319-1.433.053.053 0 0 1 .066-.054c1.517.363 3.072.546 4.632.546.376 0 .75 0 1.125-.01 1.57-.044 3.224-.124 4.768-.422.038-.008.077-.015.11-.024 2.435-.464 4.753-1.92 4.989-5.604.008-.145.03-1.52.03-1.67.002-.512.167-3.63-.024-5.545zm-3.748 9.195h-2.561V8.29c0-1.309-.55-1.976-1.67-1.976-1.23 0-1.846.79-1.846 2.35v3.403h-2.546V8.663c0-1.56-.617-2.35-1.848-2.35-1.112 0-1.668.668-1.67 1.977v6.218H4.822V8.102c0-1.31.337-2.35 1.011-3.12.696-.77 1.608-1.164 2.74-1.164 1.311 0 2.302.5 2.962 1.498l.638 1.06.638-1.06c.66-.999 1.65-1.498 2.96-1.498 1.13 0 2.043.395 2.74 1.164.675.77 1.012 1.81 1.012 3.12v6.406z"/></svg>`,
  bluesky: `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><path d="M12 10.8c-1.087-2.114-4.046-6.053-6.798-7.995C2.566.944 1.561 1.266.902 1.565.139 1.908 0 3.08 0 3.768c0 .69.378 5.65.624 6.479.815 2.736 3.713 3.66 6.383 3.364.136-.02.275-.039.415-.056-.138.022-.276.04-.415.056-3.912.58-7.387 2.005-2.83 7.078 5.013 5.19 6.87-1.113 7.823-4.308.953 3.195 2.05 9.271 7.733 4.308 4.267-4.308 1.172-6.498-2.74-7.078a8.741 8.741 0 0 1-.415-.056c.14.017.279.036.415.056 2.67.297 5.568-.628 6.383-3.364.246-.828.624-5.79.624-6.478 0-.69-.139-1.861-.902-2.206-.659-.298-1.664-.62-4.3 1.24C16.046 4.748 13.087 8.687 12 10.8Z"/></svg>`,
  threads: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.15" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M16.75 19.75C15.35 20.7 13.7 21.15 11.9 21.15 6.85 21.15 3.35 17.35 3.35 12c0-5.35 3.6-9.15 8.8-9.15 5.1 0 8.5 3.5 8.5 8.6 0 3.1-1.7 4.8-3.7 4.8-1.6 0-2.4-1.2-2.25-3.1l.25-3.2c.15-1.75-1.1-2.75-3-2.75-1.7 0-2.9.85-3.3 2.15"/><path d="M14.8 11.85c-.9-.5-2.05-.7-3.15-.6-2 .2-3.1 1.3-3.1 2.8 0 1.5 1.25 2.4 3.05 2.4 1.95 0 3.05-1.15 3.15-3.05"/></svg>`,
});

const copyTimers = new WeakMap();
let lastCopyAnnouncement = '';
let menuTriggerSeq = 1;
let loopsVideoSeq = 1;

function legacyCopyText(text) {
  const doc = globalThis.document;
  if (!doc || typeof doc.execCommand !== 'function') return false;
  const field = doc.createElement('textarea');
  field.value = text;
  field.setAttribute('readonly', '');
  field.style.cssText = 'position:fixed;inset-block-start:0;opacity:0';
  doc.body?.appendChild(field);
  field.select?.();
  try {
    return doc.execCommand('copy');
  } finally {
    field.remove();
  }
}

function reportCopyOutcome(button, iconEl, tipEl, ok) {
  clearTimeout(copyTimers.get(button));
  button.removeAttribute('data-copied');
  button.removeAttribute('data-failed');
  let msg = ok ? 'Copied' : 'Copy failed';
  if (msg === lastCopyAnnouncement) msg += '\u00A0';
  lastCopyAnnouncement = msg;
  tipEl.textContent = '';
  void button.offsetWidth;
  button.setAttribute(ok ? 'data-copied' : 'data-failed', '');
  iconEl.innerHTML = ok ? CHECK_SVG : SHARE_LINK_SVG;
  const announce = () => {
    tipEl.textContent = msg;
  };
  if (typeof globalThis.requestAnimationFrame === 'function') {
    globalThis.requestAnimationFrame(announce);
  } else {
    announce();
  }
  copyTimers.set(
    button,
    setTimeout(() => {
      button.removeAttribute('data-copied');
      button.removeAttribute('data-failed');
      iconEl.innerHTML = SHARE_LINK_SVG;
      tipEl.textContent = '';
    }, 1800)
  );
}

async function copyPostPermalink(url, button, iconEl, tipEl) {
  const cleanUrl = String(url || '').trim();
  if (!cleanUrl) {
    reportCopyOutcome(button, iconEl, tipEl, false);
    return;
  }
  try {
    if (globalThis.navigator?.clipboard?.writeText) {
      await globalThis.navigator.clipboard.writeText(cleanUrl);
    } else if (!legacyCopyText(cleanUrl)) {
      throw new Error('Clipboard unavailable');
    }
    reportCopyOutcome(button, iconEl, tipEl, true);
  } catch {
    if (legacyCopyText(cleanUrl)) {
      reportCopyOutcome(button, iconEl, tipEl, true);
    } else {
      reportCopyOutcome(button, iconEl, tipEl, false);
    }
  }
}

function formatRelativeTime(createdAt) {
  if (!createdAt) return '';
  const ts = Date.parse(createdAt);
  if (!Number.isFinite(ts)) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return `${diffSec}s`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h`;
  return new Date(ts).toLocaleDateString();
}

function applyActionButtonMeta(btn, {
  label = '',
  tooltip = '',
  count = null,
  pressed = null,
  active = false,
  disabled = false,
  disabledReason = '',
}) {
  const baseTip = tooltip || label;
  const isDisabled = Boolean(disabled);
  btn.disabled = isDisabled;
  btn.classList.toggle('is-active', Boolean(active));
  if (pressed !== null && pressed !== undefined) {
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
  btn.title = isDisabled && disabledReason ? `${baseTip} — ${disabledReason}` : baseTip;
  btn.setAttribute('aria-label', count !== null && count !== undefined ? `${baseTip} (${count})` : baseTip);
  if (isDisabled && disabledReason) {
    btn.setAttribute('aria-description', disabledReason);
  } else {
    btn.removeAttribute('aria-description');
  }
}

function createActionButton({
  iconSvg,
  count,
  label,
  tooltip = '',
  pressed = null,
  active = false,
  disabled = false,
  disabledReason = '',
  hasHandler = true,
  className = '',
  onClick,
}) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = ['post-action-btn', className].filter(Boolean).join(' ');
  btn.dataset.hasHandler = hasHandler ? '1' : '0';
  applyActionButtonMeta(btn, { label, tooltip, count, pressed, active, disabled, disabledReason });
  const iconWrap = doc.createElement('span');
  iconWrap.className = 'post-action-icon';
  iconWrap.setAttribute('aria-hidden', 'true');
  iconWrap.style.display = 'contents';
  iconWrap.innerHTML = iconSvg;
  btn.appendChild(iconWrap);
  if (count !== null && count !== undefined) {
    const span = doc.createElement('span');
    span.className = 'post-action-count';
    span.textContent = String(count);
    btn.appendChild(span);
  }
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (btn.disabled) return;
    onClick?.();
  });
  return btn;
}

function isOwnPostItem(unified, authState = authStore.get()) {
  const accounts = authState?.accounts || [];
  const authorHandle = String(unified.author?.handle || '').replace(/^@/, '').toLowerCase();
  const authorId = String(unified.author?.id || '');
  return accounts.some((acc) => {
    const accAcct = String(acc.acct || acc.handle || '').replace(/^@/, '').toLowerCase();
    return (accAcct && accAcct === authorHandle) || (acc.userId && String(acc.userId) === authorId);
  });
}

/**
 * Determine protocol and session capabilities for Favourite, Reply, and Boost controls on a post.
 */
export function getPostActionCapabilities(rawPost, authState = authStore.get()) {
  const unified = toUnifiedItem(rawPost);
  const accounts = Array.isArray(authState?.accounts) ? authState.accounts : [];
  const hasMastodon = Boolean(authState?.isMastodonConnected || accounts.some((a) => a.platform === 'fediverse'));
  const hasBluesky = Boolean(authState?.isBlueskyConnected || accounts.some((a) => a.platform === 'bluesky'));
  const hasThreads = Boolean(authState?.isThreadsConnected || accounts.some((a) => a.platform === 'threads'));
  const isSynthetic = Boolean(unified._meta?.notification?.synthetic);
  const isVaultLocked = Boolean(authState?.vaultLocked);

  if (isVaultLocked) {
    if (unified.protocol === 'threads') {
      return {
        like: { enabled: false, reason: 'Likes are not supported by the Threads API' },
        reply: { enabled: false, reason: 'Unlock vault to reply' },
        repost: { enabled: false, reason: 'Boosts are not supported by the Threads API' },
      };
    }
    return {
      like: { enabled: false, reason: 'Unlock vault to like' },
      reply: { enabled: false, reason: 'Unlock vault to reply' },
      repost: { enabled: false, reason: 'Unlock vault to boost' },
    };
  }

  if (unified.protocol === 'threads') {
    const postId = String(unified._meta?.threads?.postId || String(unified.id || '').replace(/^threads:(?:notif:)?/, '')).trim();
    const reply = isSynthetic || !postId
      ? { enabled: false, reason: 'Replies unavailable for this post' }
      : !hasThreads
        ? { enabled: false, reason: 'Connect Threads bridge to reply' }
        : { enabled: true, reason: '' };
    return {
      like: { enabled: false, reason: 'Likes are not supported by the Threads API' },
      reply,
      repost: { enabled: false, reason: 'Boosts are not supported by the Threads API' },
    };
  }

  if (unified.protocol === 'bluesky') {
    const bMeta = unified._meta?.bluesky || {};
    const uri = String(
      bMeta.uri || rawPost?.uri || (String(unified.id || '').startsWith('bluesky:') ? String(unified.id).slice('bluesky:'.length) : '')
    ).trim();
    const replyDisabled = Boolean(
      bMeta.replyDisabled || rawPost?.viewerState?.replyDisabled || rawPost?.raw?.post?.viewer?.replyDisabled || rawPost?.viewer?.replyDisabled
    );
    if (isSynthetic || !uri) {
      const unavail = { enabled: false, reason: 'Action unavailable for this post' };
      return { like: unavail, reply: unavail, repost: unavail };
    }
    if (!hasBluesky) {
      return {
        like: { enabled: false, reason: 'Connect Bluesky bridge to like' },
        reply: { enabled: false, reason: 'Connect Bluesky bridge to reply' },
        repost: { enabled: false, reason: 'Connect Bluesky bridge to boost' },
      };
    }
    return {
      like: { enabled: true, reason: '' },
      reply: replyDisabled
        ? { enabled: false, reason: 'Author restricted replies on Bluesky' }
        : { enabled: true, reason: '' },
      repost: { enabled: true, reason: '' },
    };
  }

  const mMeta = unified._meta?.mastodon || {};
  const statusId = String(mMeta.statusId || String(unified.id || '').replace(/^mastodon:/, '')).trim();
  const hasTarget = Boolean(statusId || unified.url);
  const vis = String(mMeta.visibility || rawPost?.visibility || 'public').toLowerCase();
  const isOwn = isOwnPostItem(unified, authState);
  if (isSynthetic || !hasTarget) {
    const unavail = { enabled: false, reason: 'Action unavailable for this post' };
    return { like: unavail, reply: unavail, repost: unavail };
  }
  if (!hasMastodon) {
    return {
      like: { enabled: false, reason: 'Connect Mastodon to favourite' },
      reply: { enabled: false, reason: 'Connect Mastodon to reply' },
      repost: { enabled: false, reason: 'Connect Mastodon to boost' },
    };
  }
  return {
    like: { enabled: true, reason: '' },
    reply: { enabled: true, reason: '' },
    repost: vis === 'direct'
      ? { enabled: false, reason: 'Mentioned-only posts cannot be boosted' }
      : vis === 'private' && !isOwn
        ? { enabled: false, reason: 'Followers-only posts cannot be boosted' }
        : { enabled: true, reason: '' },
  };
}

export function resolvePostBadgeProtocols(rawPost) {
  const unified = toUnifiedItem(rawPost);
  const linked = unified._meta?.linkedIds || {};
  const hasMastodon =
    unified.protocol === 'mastodon' ||
    Boolean(linked.mastodonStatusId || unified._meta?.mastodon?.statusId || unified._meta?.mastodon?.uri);
  const hasBluesky =
    unified.protocol === 'bluesky' ||
    Boolean(linked.blueskyUri || unified._meta?.bluesky?.uri);
  const hasThreads =
    unified.protocol === 'threads' ||
    Boolean(linked.threadsPostId || unified._meta?.threads?.postId);

  const protocols = [];
  if (hasMastodon) protocols.push('mastodon');
  if (hasBluesky) protocols.push('bluesky');
  if (hasThreads) protocols.push('threads');
  return protocols;
}

function formatBreakdownTip(breakdown, baseLabel, metricKey) {
  if (!breakdown || typeof breakdown !== 'object') return baseLabel;
  const order = [
    ['mastodon', 'Mastodon'],
    ['bluesky', 'Bluesky'],
    ['threads', 'Threads'],
  ];
  const parts = order
    .filter(([k]) => breakdown[k] && typeof breakdown[k] === 'object')
    .map(([k, lbl]) => `${lbl}: ${Number(breakdown[k][metricKey] || 0)}`);
  return parts.length >= 2 ? `${baseLabel} · ${parts.join(' · ')}` : baseLabel;
}

function updateActionButtonState(btn, { iconSvg, count, label, tooltip, active, pressed, disabled, disabledReason }) {
  if (!btn) return;
  applyActionButtonMeta(btn, { label, tooltip, count, pressed, active, disabled, disabledReason });
  const iconEl = btn.querySelector('.post-action-icon');
  if (iconEl) {
    iconEl.innerHTML = iconSvg;
  }
  const countEl = btn.querySelector('.post-action-count');
  if (countEl && count !== null && count !== undefined) {
    countEl.textContent = String(count);
  }
}

function buildReactionControls(unified, rawPost) {
  const mMeta = unified._meta?.mastodon || {};
  const bMeta = unified._meta?.bluesky || {};
  const liked = Boolean(mMeta.favourited || bMeta.likeUri || rawPost?.viewerState?.favourited);
  const replied = Boolean(unified._meta?.viewerReplied || mMeta.replied || bMeta.replied || rawPost?.viewerState?.replied);
  const reposted = Boolean(mMeta.reblogged || bMeta.repostUri || rawPost?.viewerState?.reblogged);
  const caps = getPostActionCapabilities(rawPost ?? unified);
  return [
    {
      key: 'like',
      selector: '.post-action-like',
      className: 'post-action-like',
      cap: caps.like,
      iconSvg: liked ? HEART_FILLED_SVG : HEART_OUTLINE_SVG,
      count: unified.metrics?.likes ?? 0,
      label: 'Favourite',
      metricKey: 'likes',
      active: liked,
      pressed: liked,
    },
    {
      key: 'reply',
      selector: '.post-action-reply',
      className: 'post-action-reply',
      cap: caps.reply,
      iconSvg: replied ? REPLY_ACTIVE_SVG : REPLY_SVG,
      count: unified.metrics?.replies ?? 0,
      label: replied ? 'Replied' : 'Reply',
      metricKey: 'replies',
      active: replied,
      pressed: replied,
    },
    {
      key: 'repost',
      selector: '.post-action-repost',
      className: 'post-action-repost',
      cap: caps.repost,
      iconSvg: reposted ? REPOST_ACTIVE_SVG : REPOST_SVG,
      count: unified.metrics?.reposts ?? 0,
      label: 'Boost',
      metricKey: 'reposts',
      active: reposted,
      pressed: reposted,
    },
  ];
}

function resolveDisabledState(cap, hasHandler) {
  const disabled = !cap.enabled || !hasHandler;
  const disabledReason = !cap.enabled ? cap.reason : (!hasHandler ? 'Action unavailable' : '');
  return { disabled, disabledReason };
}

function formatMediaClock(rawSec) {
  const sec = Math.max(0, Math.floor(Number(rawSec) || 0));
  const mins = Math.floor(sec / 60);
  const rem = sec % 60;
  return `${mins}:${String(rem).padStart(2, '0')}`;
}

function syncCrossPlatformResonanceStrip(actionsEl, unified, doc = globalThis.document) {
  if (!actionsEl || !doc) return;
  const bd = unified?._meta?.metricsBreakdown && typeof unified._meta.metricsBreakdown === 'object'
    ? unified._meta.metricsBreakdown
    : null;
  const protocols = resolvePostBadgeProtocols(unified);
  if (bd) {
    for (const p of ['mastodon', 'bluesky', 'threads']) {
      if (bd[p] && typeof bd[p] === 'object' && !protocols.includes(p)) {
        protocols.push(p);
      }
    }
  }

  const existing = actionsEl.querySelector('.post-network-resonance');
  if (protocols.length === 0) {
    existing?.remove?.();
    return;
  }

  const entries = protocols.map((proto) => {
    const vals = bd?.[proto] && typeof bd[proto] === 'object'
      ? bd[proto]
      : (proto === unified.protocol ? (unified.metrics || {}) : {});
    const likes = Number(vals.likes || 0);
    const replies = Number(vals.replies || 0);
    const reposts = Number(vals.reposts || 0);
    return {
      proto,
      label: PROTOCOL_LABELS[proto] || proto,
      likes,
      replies,
      reposts,
      total: likes + replies + reposts,
    };
  });

  const strip = existing || doc.createElement('span');
  strip.className = 'post-network-resonance';
  strip.dataset.protocols = protocols.join(',');
  strip.setAttribute('role', 'group');
  const tip = entries
    .map((e) => `${e.label}: ${e.likes} likes, ${e.replies} replies, ${e.reposts} boosts`)
    .join(' · ');
  strip.setAttribute('aria-label', tip);
  strip.title = tip;
  strip.replaceChildren();

  for (const entry of entries) {
    const chip = doc.createElement('span');
    chip.className = `post-resonance-chip post-resonance-chip--${entry.proto}`;
    chip.dataset.networkTotal = String(entry.total);
    const iconSpan = doc.createElement('span');
    iconSpan.className = 'post-resonance-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = PROTOCOL_LOGO_SVGS[entry.proto] || '';
    const countSpan = doc.createElement('span');
    countSpan.className = 'post-resonance-count';
    countSpan.textContent = String(entry.total);
    chip.append(iconSpan, countSpan);
    strip.appendChild(chip);
  }

  if (!existing) {
    const copyWrap = actionsEl.querySelector('.post-copy-wrap');
    if (copyWrap) {
      actionsEl.insertBefore(strip, copyWrap);
    } else {
      actionsEl.appendChild(strip);
    }
  }
}

/**
 * Update Favourite, Reply, and Boost controls on an existing `<article class="post-card">`
 * in place without detaching DOM nodes or discarding button focus.
 */
export function syncPostCardReactions(cardEl, rawPost) {
  if (!cardEl) return;
  const unified = toUnifiedItem(rawPost);
  const breakdown = unified._meta?.metricsBreakdown;

  for (const ctrl of buildReactionControls(unified, rawPost)) {
    const btn = cardEl.querySelector(ctrl.selector);
    if (!btn) continue;
    const hasHandler = btn.dataset?.hasHandler !== '0';
    const { disabled, disabledReason } = resolveDisabledState(ctrl.cap, hasHandler);
    updateActionButtonState(btn, {
      iconSvg: ctrl.iconSvg,
      count: ctrl.count,
      label: ctrl.label,
      tooltip: formatBreakdownTip(breakdown, ctrl.label, ctrl.metricKey),
      active: ctrl.active,
      pressed: ctrl.pressed,
      disabled,
      disabledReason,
    });
  }
  const sanctuaryBtn = cardEl.querySelector('.post-action-sanctuary');
  if (sanctuaryBtn) {
    const sanctuaryLocked = Boolean(authStore.get()?.vaultLocked);
    applyActionButtonMeta(sanctuaryBtn, {
      label: 'Share to Program',
      count: null,
      disabled: sanctuaryLocked,
      disabledReason: sanctuaryLocked ? 'Unlock vault to share to Program' : '',
    });
  }
  syncCrossPlatformResonanceStrip(cardEl.querySelector('.post-card-actions'), unified, cardEl.ownerDocument || globalThis.document);
  const interestedItem = cardEl.querySelector('.post-context-menuitem[data-menu-action="interested"]');
  if (interestedItem) {
    interestedItem.textContent = unified._meta?.feedFeedback === 'interested' ? 'Interested ✓' : 'Interested';
  }
}

function appendQuoteTextWithTruncatedUrls(doc, pEl, rawText) {
  const input = String(rawText || '');
  if (!input) return;
  const urlRe = /(?:^|[\s(])(https?:\/\/[^\s<>()[\]{}"']+)/g;
  let cursor = 0;
  for (const m of input.matchAll(urlRe)) {
    const token = m[1];
    const tokenStart = m.index + m[0].indexOf(token);
    let clean = token.replace(/[.,!?;:]+$/, '');
    while (clean.endsWith(')')) {
      const opens = (clean.match(/\(/g) || []).length;
      const closes = (clean.match(/\)/g) || []).length;
      if (closes > opens) clean = clean.slice(0, -1).replace(/[.,!?;:]+$/, '');
      else break;
    }
    const parts = splitUrlDisplayParts(clean, clean);
    if (!parts) continue;
    if (tokenStart > cursor) {
      pEl.appendChild(doc.createTextNode(input.slice(cursor, tokenStart)));
    }
    const urlSpan = doc.createElement('span');
    urlSpan.className = 'post-quote-url';
    urlSpan.appendChild(buildUrlDisplayFragment(doc, parts));
    pEl.appendChild(urlSpan);
    const suffix = token.slice(clean.length);
    if (suffix) pEl.appendChild(doc.createTextNode(suffix));
    cursor = tokenStart + token.length;
  }
  if (cursor < input.length) {
    pEl.appendChild(doc.createTextNode(input.slice(cursor)));
  }
}

function isAsciiDigits(str) {
  const s = String(str || '');
  if (!s) return false;
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function stripLeadingAt(str) {
  const s = String(str || '');
  return s.startsWith('@') ? s.slice(1) : s;
}

export function parseSocialPostItemFromUrl(rawUrl, fallback = {}) {
  const input = String(rawUrl || '').trim();
  if (!input) return null;
  let parsed;
  try {
    parsed = new URL(input, 'https://bsky.app');
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const segs = parsed.pathname.split('/').filter(Boolean);

  if ((host === 'bsky.app' || host === 'staging.bsky.app') && segs.length === 4 && segs[0] === 'profile' && segs[2] === 'post') {
    let actor = segs[1];
    let rkey = segs[3];
    try {
      actor = decodeURIComponent(actor);
      rkey = decodeURIComponent(rkey);
    } catch {
      // keep raw path segment
    }
    if (!actor || !rkey) return null;
    const cleanHandle = stripLeadingAt(fallback.authorHandle || (actor.startsWith('did:') ? '' : actor));
    const uri = fallback.uri || `at://${actor}/app.bsky.feed.post/${rkey}`;
    return toUnifiedItem({
      id: fallback.id || `bluesky:${uri}`,
      protocol: 'bluesky',
      url: parsed.href,
      content_text: fallback.text || '',
      date_published: fallback.createdAt || '',
      author: {
        id: fallback.authorDid || fallback.authorId || (actor.startsWith('did:') ? actor : cleanHandle),
        name: fallback.authorName || cleanHandle || actor,
        handle: cleanHandle,
        avatar_url: fallback.authorAvatar || '',
        url: `https://bsky.app/profile/${actor}`,
      },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: { bluesky: { uri, cid: fallback.cid || '' } },
    });
  }

  let mastoUser = '';
  let mastoStatusId = '';
  if (segs.length === 2 && segs[0].startsWith('@') && segs[0].length > 1 && isAsciiDigits(segs[1])) {
    mastoUser = segs[0].slice(1);
    mastoStatusId = segs[1];
  } else if (segs.length === 4 && segs[0] === 'users' && segs[2] === 'statuses' && isAsciiDigits(segs[3])) {
    mastoUser = segs[1];
    mastoStatusId = segs[3];
  }
  if (mastoUser && mastoStatusId) {
    try {
      mastoUser = decodeURIComponent(mastoUser);
    } catch {
      // keep raw segment
    }
    const cleanFallbackHandle = stripLeadingAt(fallback.authorHandle || '');
    const handle = cleanFallbackHandle || (mastoUser.includes('@') ? mastoUser : `${mastoUser}@${host}`);
    return toUnifiedItem({
      id: fallback.id || `mastodon:${mastoStatusId}`,
      protocol: 'mastodon',
      url: parsed.href,
      content_text: fallback.text || '',
      date_published: fallback.createdAt || '',
      author: {
        id: fallback.authorId || handle,
        name: fallback.authorName || mastoUser.split('@')[0],
        handle,
        avatar_url: fallback.authorAvatar || '',
        url: `${parsed.origin}/@${mastoUser.split('@')[0]}`,
      },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: { mastodon: { statusId: mastoStatusId, instanceUrl: parsed.origin } },
    });
  }

  return null;
}

function buildEmbeddedPostTarget(item, protocolDefault = 'bluesky') {
  if (!item || typeof item !== 'object') return null;
  const proto = item.protocol || protocolDefault;
  const cleanHandle = stripLeadingAt(item.authorHandle || '');
  const hasDirectId = Boolean(item.uri || item.statusId || item.postId || item.id);
  if (!hasDirectId) {
    return item.url ? parseSocialPostItemFromUrl(item.url, item) : null;
  }
  let authorUrl = '';
  if (proto === 'mastodon') {
    try {
      authorUrl = item.url ? `${new URL(item.url).origin}/@${cleanHandle.split('@')[0]}` : '';
    } catch {
      authorUrl = '';
    }
  } else if (proto === 'threads' && cleanHandle) {
    authorUrl = `https://www.threads.net/@${cleanHandle}`;
  } else if (cleanHandle) {
    authorUrl = `https://bsky.app/profile/${cleanHandle}`;
  }
  return toUnifiedItem({
    id: item.id || '',
    protocol: proto,
    url: item.url || '',
    content_text: item.text || '',
    date_published: item.createdAt || '',
    author: {
      id: item.authorDid || item.authorId || cleanHandle,
      name: item.authorName || cleanHandle,
      handle: cleanHandle,
      avatar_url: item.authorAvatar || '',
      url: authorUrl,
    },
    attachments: [],
    metrics: { replies: 0, reposts: 0, likes: 0 },
    _meta: proto === 'mastodon'
      ? { mastodon: { statusId: item.statusId || '', instanceUrl: item.instanceUrl || 'https://mastodon.social' } }
      : proto === 'threads'
        ? { threads: { postId: item.postId || '' } }
        : { bluesky: { uri: item.uri || '', cid: item.cid || '' } },
  });
}

function createQuotePostCard(doc, quote, { onOpenThread } = {}) {
  if (!quote || typeof quote !== 'object') return null;
  if (quote.unavailable) {
    const box = doc.createElement('div');
    box.className = 'post-quote-card is-unavailable';
    box.textContent = quote.reason || 'Quoted post unavailable';
    return box;
  }

  const resolvedTarget = buildEmbeddedPostTarget(quote, 'bluesky');
  const canOpenInternal = Boolean(resolvedTarget);
  const openHandler = typeof onOpenThread === 'function'
    ? onOpenThread
    : (item) => doc.dispatchEvent(new CustomEvent('sanctuary:open-post', { detail: item }));
  const el = canOpenInternal ? doc.createElement('button') : doc.createElement('a');
  if (canOpenInternal) {
    el.type = 'button';
  } else {
    el.href = quote.url || '#';
    el.setAttribute('target', '_blank');
    el.setAttribute('rel', 'noopener noreferrer');
  }
  el.className = 'post-quote-card';

  const head = doc.createElement('div');
  head.className = 'post-quote-header';
  if (quote.authorAvatar) {
    const av = doc.createElement('img');
    av.className = 'post-quote-avatar';
    av.src = quote.authorAvatar;
    av.alt = '';
    av.loading = 'lazy';
    head.appendChild(av);
  }
  const nameEl = doc.createElement('strong');
  nameEl.className = 'post-quote-author-name';
  nameEl.textContent = quote.authorName || quote.authorHandle || '';
  const handleEl = doc.createElement('span');
  handleEl.className = 'post-quote-author-handle';
  const cleanHandle = stripLeadingAt(quote.authorHandle || '');
  handleEl.textContent = cleanHandle ? `@${cleanHandle}` : '';
  head.append(nameEl, handleEl);
  el.appendChild(head);

  if (quote.text) {
    const p = doc.createElement('p');
    p.className = 'post-quote-text';
    appendQuoteTextWithTruncatedUrls(doc, p, quote.text);
    el.appendChild(p);
  }

  if (quote.thumbUrl) {
    const thumb = doc.createElement('img');
    thumb.className = `post-quote-thumb${quote.sensitive ? ' is-sensitive-thumb' : ''}`;
    thumb.src = quote.thumbUrl;
    thumb.alt = '';
    thumb.loading = 'lazy';
    el.appendChild(thumb);
  }

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!canOpenInternal) return;
    openHandler(resolvedTarget);
  });

  return el;
}

export function createReplyContextBlock(doc, replyCtx, { onOpenThread } = {}) {
  if (!replyCtx || typeof replyCtx !== 'object') return null;
  if (!replyCtx.text && !replyCtx.authorHandle && !replyCtx.authorName) return null;

  const resolvedTarget = buildEmbeddedPostTarget(replyCtx, 'bluesky');
  const canOpenInternal = Boolean(resolvedTarget);
  const openHandler = typeof onOpenThread === 'function'
    ? onOpenThread
    : (item) => doc.dispatchEvent(new CustomEvent('sanctuary:open-post', { detail: item }));
  const block = canOpenInternal ? doc.createElement('button') : doc.createElement('a');
  if (canOpenInternal) {
    block.type = 'button';
  } else {
    block.href = replyCtx.url || '#';
    block.setAttribute('target', '_blank');
    block.setAttribute('rel', 'noopener noreferrer');
  }
  block.className = 'post-reply-context';

  const rail = doc.createElement('div');
  rail.className = 'post-reply-context-rail';
  rail.setAttribute('aria-hidden', 'true');
  const av = doc.createElement('img');
  av.className = 'post-reply-context-avatar';
  av.src = replyCtx.authorAvatar || DEFAULT_AVATAR_DATA_URI;
  av.alt = '';
  av.loading = 'lazy';
  const spine = doc.createElement('span');
  spine.className = 'post-reply-context-spine';
  rail.append(av, spine);

  const main = doc.createElement('div');
  main.className = 'post-reply-context-main';

  const head = doc.createElement('div');
  head.className = 'post-reply-context-head';
  const nameEl = doc.createElement('strong');
  nameEl.className = 'post-reply-context-name';
  nameEl.textContent = replyCtx.authorName || replyCtx.authorHandle || 'Original post';
  const cleanHandle = stripLeadingAt(replyCtx.authorHandle || '');
  head.appendChild(nameEl);
  if (cleanHandle) {
    const handleEl = doc.createElement('span');
    handleEl.className = 'post-reply-context-handle';
    handleEl.textContent = `@${cleanHandle}`;
    head.appendChild(handleEl);
  }
  const relTime = formatRelativeTime(replyCtx.createdAt);
  if (relTime) {
    const timeEl = doc.createElement('span');
    timeEl.className = 'post-reply-context-time';
    timeEl.textContent = `· ${relTime}`;
    head.appendChild(timeEl);
  }
  main.appendChild(head);

  if (replyCtx.text) {
    const p = doc.createElement('p');
    p.className = 'post-reply-context-text';
    appendQuoteTextWithTruncatedUrls(doc, p, replyCtx.text);
    main.appendChild(p);
  }

  if (replyCtx.thumbUrl) {
    const thumb = doc.createElement('img');
    thumb.className = `post-reply-context-thumb${replyCtx.sensitive ? ' is-sensitive-thumb' : ''}`;
    thumb.src = replyCtx.thumbUrl;
    thumb.alt = '';
    thumb.loading = 'lazy';
    main.appendChild(thumb);
  }

  block.append(rail, main);

  block.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!canOpenInternal) return;
    openHandler(resolvedTarget);
  });

  return block;
}

function appendReactionButtons(actionsEl, unified, rawPost, handlers, {
  showSanctuaryAction = false,
  onAskSanctuary = null,
} = {}) {
  const breakdown = unified._meta?.metricsBreakdown;
  for (const ctrl of buildReactionControls(unified, rawPost)) {
    const handler = handlers[ctrl.key];
    const hasHandler = typeof handler === 'function';
    const { disabled, disabledReason } = resolveDisabledState(ctrl.cap, hasHandler);
    actionsEl.appendChild(
      createActionButton({
        iconSvg: ctrl.iconSvg,
        count: ctrl.count,
        label: ctrl.label,
        tooltip: formatBreakdownTip(breakdown, ctrl.label, ctrl.metricKey),
        pressed: ctrl.pressed,
        active: ctrl.active,
        disabled,
        disabledReason,
        hasHandler,
        className: ctrl.className,
        onClick: () => handler?.(rawPost),
      })
    );
  }
  if (showSanctuaryAction && typeof onAskSanctuary === 'function') {
    const sanctuaryLocked = Boolean(authStore.get()?.vaultLocked);
    actionsEl.appendChild(
      createActionButton({
        iconSvg: SANCTUARY_SVG,
        count: null,
        label: 'Share to Program',
        disabled: sanctuaryLocked,
        disabledReason: sanctuaryLocked ? 'Unlock vault to share to Program' : '',
        className: 'post-action-sanctuary',
        onClick: () => onAskSanctuary(rawPost),
      })
    );
  }
}

function buildPostContextMenu(doc, rawPost, unified, isOwn, isPinned, {
  onEditPost,
  onTogglePin,
  onDeletePost,
  onInterested,
  onNotInterested,
  onHideReply,
  onMuteAuthor,
  onBlockAuthor,
} = {}) {
  const hasMenuActions = Boolean(
    onEditPost
    || onDeletePost
    || onTogglePin
    || onInterested
    || onNotInterested
    || onHideReply
    || onMuteAuthor
    || onBlockAuthor
  );
  if (!hasMenuActions) return null;

  const menuWrap = doc.createElement('div');
  menuWrap.className = 'post-menu-wrap';

  const seq = menuTriggerSeq++;
  const hasNativeFocusGroup = Boolean(globalThis.HTMLElement && 'focusGroup' in globalThis.HTMLElement.prototype);
  const hasNativePopover = Boolean(
    globalThis.HTMLElement
    && ('popover' in globalThis.HTMLElement.prototype)
    && typeof doc.createElement('div').showPopover === 'function'
  );
  const hasAnchorPos = Boolean(globalThis.CSS?.supports?.('position-area: block-end'));

  const moreBtn = doc.createElement('button');
  moreBtn.type = 'button';
  moreBtn.id = `post-more-trigger-${seq}`;
  moreBtn.className = 'post-more-btn';
  moreBtn.setAttribute('aria-label', 'Post actions');
  moreBtn.setAttribute('aria-haspopup', 'menu');
  moreBtn.setAttribute('aria-expanded', 'false');
  moreBtn.innerHTML = MORE_SVG;

  const menuPopover = doc.createElement('div');
  menuPopover.className = 'post-menu-popover';
  menuPopover.id = `post-more-popover-${seq}`;

  const menuPanel = doc.createElement('div');
  menuPanel.className = 'post-context-menu';
  menuPanel.setAttribute('focusgroup', 'menu nomemory');
  menuPanel.setAttribute('aria-labelledby', moreBtn.id);
  if (!hasNativeFocusGroup) {
    menuPanel.setAttribute('role', 'menu');
  }
  menuPanel.hidden = true;
  menuPopover.appendChild(menuPanel);

  const getEnabledMenuItems = () =>
    [...menuPanel.querySelectorAll('button.post-context-menuitem')].filter((b) => !b.disabled);

  const toggleHasOpenMenu = (isOpen) => {
    menuWrap.parentElement?.classList?.toggle?.('has-open-menu', isOpen);
    menuWrap.closest?.('.post-card, .loops-action-rail')?.classList?.toggle?.('has-open-menu', isOpen);
  };

  let onOutside = null;
  let onViewportChange = null;
  let pendingFocusFirst = false;

  const detachViewportListeners = () => {
    if (onViewportChange) {
      globalThis.removeEventListener?.('scroll', onViewportChange, true);
      globalThis.removeEventListener?.('resize', onViewportChange);
      onViewportChange = null;
    }
  };

  const positionPopoverFallback = () => {
    if (hasAnchorPos || typeof moreBtn.getBoundingClientRect !== 'function') return;
    const rect = moreBtn.getBoundingClientRect();
    const menuRect = menuPanel.getBoundingClientRect();
    const viewW = Number(globalThis.innerWidth || 0);
    const viewH = Number(globalThis.innerHeight || 0);
    const menuW = menuRect.width || 190;
    const menuH = menuRect.height || 180;
    const isLoopsRail = Boolean(menuWrap.closest?.('.loops-action-rail'));

    let left = isLoopsRail ? rect.left - menuW - 10 : rect.right - menuW;
    let top = isLoopsRail ? rect.bottom - menuH : rect.bottom + 4;
    if (!isLoopsRail && viewH > 0 && top + menuH > viewH - 8 && rect.top - menuH - 4 >= 8) {
      top = rect.top - menuH - 4;
    }
    if (viewW > 0) left = Math.max(8, Math.min(left, viewW - menuW - 8));
    if (viewH > 0) top = Math.max(8, Math.min(top, viewH - menuH - 8));
    menuPopover.style.left = `${Math.round(left)}px`;
    menuPopover.style.top = `${Math.round(top)}px`;
  };

  const closeMenu = () => {
    pendingFocusFirst = false;
    if (hasNativePopover && menuPopover.matches?.(':popover-open')) {
      try {
        menuPopover.hidePopover();
        return;
      } catch (_) {}
    }
    menuPanel.hidden = true;
    menuPanel.classList.remove('is-flipped-up');
    toggleHasOpenMenu(false);
    moreBtn.setAttribute('aria-expanded', 'false');
    detachViewportListeners();
    if (onOutside) {
      doc.removeEventListener('click', onOutside);
      onOutside = null;
    }
  };

  const openMenu = ({ focusFirst = false } = {}) => {
    pendingFocusFirst = focusFirst;
    if (hasNativePopover) {
      menuPanel.hidden = false;
      if (!menuPopover.matches?.(':popover-open')) {
        try {
          menuPopover.showPopover({ source: moreBtn });
        } catch (_) {
          try {
            menuPopover.showPopover();
          } catch (__) {}
        }
      } else if (focusFirst) {
        pendingFocusFirst = false;
        getEnabledMenuItems()[0]?.focus?.({ preventScroll: true });
      }
      return;
    }
    toggleHasOpenMenu(true);
    if (!menuWrap.closest?.('.loops-action-rail') && typeof moreBtn.getBoundingClientRect === 'function') {
      const rect = moreBtn.getBoundingClientRect();
      const viewH = Number(globalThis.innerHeight || 0);
      menuPanel.classList.toggle('is-flipped-up', viewH > 0 && rect.bottom > 0 && rect.bottom + 210 > viewH);
    }
    menuPanel.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    if (!onOutside) {
      onOutside = (ev) => {
        if (!menuWrap.contains(ev.target)) {
          closeMenu();
        }
      };
      doc.addEventListener('click', onOutside);
    }
    if (focusFirst) {
      pendingFocusFirst = false;
      getEnabledMenuItems()[0]?.focus?.({ preventScroll: true });
    }
  };

  if (hasNativePopover) {
    menuPopover.setAttribute('popover', 'auto');
    const anchorName = `--post-more-anchor-${seq}`;
    moreBtn.style.setProperty('anchor-name', anchorName);
    menuPopover.style.setProperty('position-anchor', anchorName);
    if (globalThis.HTMLButtonElement && 'commandForElement' in globalThis.HTMLButtonElement.prototype) {
      moreBtn.setAttribute('commandfor', menuPopover.id);
      moreBtn.setAttribute('command', 'toggle-popover');
    } else {
      moreBtn.setAttribute('popovertarget', menuPopover.id);
    }
    menuPopover.addEventListener('toggle', (ev) => {
      const isOpen = ev.newState ? ev.newState === 'open' : Boolean(menuPopover.matches?.(':popover-open'));
      menuPanel.hidden = !isOpen;
      moreBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggleHasOpenMenu(isOpen);
      if (isOpen) {
        if (!hasAnchorPos) {
          positionPopoverFallback();
          if (!onViewportChange) {
            onViewportChange = () => positionPopoverFallback();
            globalThis.addEventListener?.('scroll', onViewportChange, { capture: true, passive: true });
            globalThis.addEventListener?.('resize', onViewportChange, { passive: true });
          }
        }
        if (pendingFocusFirst) {
          pendingFocusFirst = false;
          getEnabledMenuItems()[0]?.focus?.({ preventScroll: true });
        }
      } else {
        pendingFocusFirst = false;
        detachViewportListeners();
      }
    });
  }

  const addMenuItem = (label, handler, danger = false, { requiresAuth = false } = {}) => {
    const itemBtn = doc.createElement('button');
    itemBtn.type = 'button';
    if (!hasNativeFocusGroup) {
      itemBtn.setAttribute('role', 'menuitem');
    }
    itemBtn.className = `post-context-menuitem${danger ? ' is-danger' : ''}`;
    itemBtn.textContent = label;
    if (requiresAuth && authStore.get()?.vaultLocked) {
      itemBtn.disabled = true;
      itemBtn.title = 'Unlock vault first';
    }
    itemBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (itemBtn.disabled) return;
      closeMenu();
      handler?.(rawPost, unified);
    });
    menuPanel.appendChild(itemBtn);
    return itemBtn;
  };

  if (isOwn) {
    if (onEditPost && (unified.protocol === 'mastodon' || unified.protocol === 'bluesky')) addMenuItem('Edit Post', onEditPost, false, { requiresAuth: true });
    if (onTogglePin && unified.protocol === 'mastodon') {
      addMenuItem(isPinned ? 'Unpin from Profile' : 'Pin to Profile', onTogglePin, false, { requiresAuth: true });
    }
    if (onDeletePost) addMenuItem('Delete Post', onDeletePost, true, { requiresAuth: true });
  } else {
    if (onInterested) {
      const interestedBtn = addMenuItem(
        unified._meta?.feedFeedback === 'interested' ? 'Interested ✓' : 'Interested',
        onInterested
      );
      interestedBtn.dataset.menuAction = 'interested';
    }
    if (onNotInterested) addMenuItem('Not Interested', onNotInterested);
    if (onHideReply || onMuteAuthor || onBlockAuthor) {
      if (menuPanel.childNodes.length > 0) {
        const sep = doc.createElement('hr');
        sep.className = 'post-context-sep';
        menuPanel.appendChild(sep);
      }
      if (onHideReply) addMenuItem('Hide Comment', onHideReply, true, { requiresAuth: true });
      if (onMuteAuthor) addMenuItem('Mute Account', onMuteAuthor, false, { requiresAuth: true });
      if (onBlockAuthor) addMenuItem('Block Account', onBlockAuthor, true, { requiresAuth: true });
    }
  }

  if (menuPanel.childNodes.length === 0) return null;

  if (!hasNativePopover) {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (menuPanel.hidden) {
        openMenu({ focusFirst: e.detail === 0 });
      } else {
        closeMenu();
      }
    });
  } else {
    moreBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      menuPanel.hidden = false;
    });
  }
  moreBtn.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      openMenu({ focusFirst: true });
    } else if (e.key === 'Escape' && !menuPanel.hidden) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    }
  });
  menuPanel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
      moreBtn.focus?.();
      return;
    }
    if (!hasNativeFocusGroup && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      const items = getEnabledMenuItems();
      if (items.length === 0) return;
      const curIdx = items.indexOf(doc.activeElement);
      let nextIdx = 0;
      if (e.key === 'End') nextIdx = items.length - 1;
      else if (e.key === 'ArrowDown') nextIdx = curIdx >= 0 ? (curIdx + 1) % items.length : 0;
      else if (e.key === 'ArrowUp') nextIdx = curIdx >= 0 ? (curIdx - 1 + items.length) % items.length : items.length - 1;
      e.preventDefault();
      e.stopPropagation();
      items[nextIdx]?.focus?.({ preventScroll: true });
    }
  });
  menuWrap.append(moreBtn, menuPopover);
  return menuWrap;
}

/**
 * Clean hairline-divided post card consuming UnifiedItem with contextual '⋯' controls.
 */
export function createPostCard(rawPost, {
  onReply,
  onToggleLike,
  onToggleRepost,
  onOpenThread,
  onAskSanctuary,
  onSelectAuthor,
  onExpandMedia,
  onEditPost,
  onDeletePost,
  onTogglePin,
  onInterested,
  onNotInterested,
  onHideReply,
  onMuteAuthor,
  onBlockAuthor,
  onRetryBridge,
  onTranslatePost,
  showSanctuaryAction = false,
  disableCardOpenThread = false,
  layoutVariant = 'default',
  mediaPriority = 'lazy',
} = {}) {
  const doc = globalThis.document;
  const unified = toUnifiedItem(rawPost);
  const card = doc.createElement('article');
  card.className = 'post-card';
  card.dataset.postId = unified.id || '';
  card.dataset.postKey = rawPost?.key || unified.id || '';
  card.dataset.protocol = unified.protocol || 'mastodon';

  const mMeta = unified._meta?.mastodon || {};
  const bMeta = unified._meta?.bluesky || {};
  const isPinned = Boolean(mMeta.pinned);
  const rebloggedBy = mMeta.rebloggedBy || bMeta.rebloggedBy || rawPost?.rebloggedBy || null;
  const boosters = Array.isArray(unified._meta?.boosters) ? unified._meta.boosters : [];

  if (isPinned) {
    const pinRow = doc.createElement('div');
    pinRow.className = 'post-reblog-banner';
    pinRow.textContent = 'Pinned post';
    card.appendChild(pinRow);
  } else if (rebloggedBy) {
    const boostRow = doc.createElement('div');
    boostRow.className = 'post-reblog-banner';
    const boosterName = rebloggedBy.name || rebloggedBy.displayName || rebloggedBy.handle || rebloggedBy.acct || '';
    const extraBoosters = Math.max(0, boosters.length - 1);
    const boostSuffix = extraBoosters > 0
      ? `\u00A0+ ${extraBoosters} ${extraBoosters === 1 ? 'other' : 'others'} boosted`
      : '\u00A0boosted';
    if (onSelectAuthor && (rebloggedBy.id || rebloggedBy.handle || rebloggedBy.acct)) {
      const boosterBtn = doc.createElement('button');
      boosterBtn.type = 'button';
      boosterBtn.className = 'post-reblog-author-btn';
      boosterBtn.textContent = boosterName;
      boosterBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelectAuthor(
          {
            ...rebloggedBy,
            protocol: unified.protocol,
          },
          unified
        );
      });
      boostRow.append(boosterBtn, doc.createTextNode(boostSuffix));
    } else {
      const nameSpan = doc.createElement('span');
      nameSpan.className = 'post-reblog-name';
      nameSpan.textContent = boosterName;
      boostRow.append(nameSpan, doc.createTextNode(boostSuffix));
    }
    card.appendChild(boostRow);
  } else if (unified._meta?.feedSource === 'second_degree' && unified._meta?.endorsedBy) {
    const endorserHandle = String(unified._meta.endorsedBy).replace(/^@/, '');
    const extraVouches = Math.max(0, Number(unified._meta?.peerVouches || 1) - 1);
    const vouchSuffix = extraVouches > 0
      ? `\u00A0+ ${extraVouches} ${extraVouches === 1 ? 'peer' : 'peers'} liked`
      : '';
    const provRow = doc.createElement('div');
    provRow.className = 'post-reblog-banner post-provenance-banner';
    if (onSelectAuthor) {
      const endorserBtn = doc.createElement('button');
      endorserBtn.type = 'button';
      endorserBtn.className = 'post-reblog-author-btn';
      endorserBtn.textContent = `@${endorserHandle}`;
      endorserBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onSelectAuthor({ handle: endorserHandle, protocol: unified.protocol }, unified);
      });
      provRow.append(doc.createTextNode('Liked by\u00A0'), endorserBtn);
      if (vouchSuffix) provRow.append(doc.createTextNode(vouchSuffix));
    } else {
      provRow.textContent = `Liked by @${endorserHandle}${vouchSuffix}`;
    }
    card.appendChild(provRow);
  }

  const replyContextEl = createReplyContextBlock(doc, unified._meta?.replyContext, { onOpenThread });
  if (replyContextEl) {
    card.appendChild(replyContextEl);
  }

  const header = doc.createElement('div');
  header.className = 'post-card-header';

  const avatar = doc.createElement('img');
  avatar.className = 'post-avatar';
  avatar.src = unified.author?.avatar_url || DEFAULT_AVATAR_DATA_URI;
  avatar.alt = unified.author?.name || unified.author?.handle || 'Author avatar';
  if (mediaPriority === 'lazy') {
    avatar.loading = 'lazy';
  }
  avatar.decoding = 'async';

  const authorRow = doc.createElement('div');
  authorRow.className = 'post-author-row';

  const authorBtn = doc.createElement('button');
  authorBtn.type = 'button';
  authorBtn.className = 'post-author-meta';
  authorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onSelectAuthor?.(unified.author, unified);
  });

  const displayName = doc.createElement('span');
  displayName.className = 'post-author-name';
  displayName.textContent = unified.author?.name || unified.author?.handle || 'Unknown';
  authorBtn.appendChild(displayName);

  if (unified.author?.handle) {
    const handle = doc.createElement('span');
    handle.className = 'post-author-handle';
    handle.textContent = `@${unified.author.handle.replace(/^@/, '')}`;
    authorBtn.appendChild(handle);
  }

  const timeEl = doc.createElement('time');
  timeEl.className = 'post-time';
  if (unified.date_published) timeEl.setAttribute('datetime', unified.date_published);
  timeEl.textContent = formatRelativeTime(unified.date_published);

  authorRow.append(authorBtn, timeEl);

  const metaRight = doc.createElement('div');
  metaRight.className = 'post-header-right';

  const isOwn = isOwnPostItem(unified);
  if (isOwn && onRetryBridge) {
    const retryQueue = authStore.get()?.retryQueue || [];
    const linked = unified._meta?.linkedIds || {};
    const matchedRetry = retryQueue.find((r) => {
      const p = r?.payload || {};
      if (p.canonicalId && p.canonicalId === unified.id) return true;
      if (mMeta.statusId && p.mastodonStatusId && String(p.mastodonStatusId) === String(mMeta.statusId)) return true;
      if (p.nativeId && (p.nativeId === linked.threadsPostId || p.nativeId === linked.blueskyUri)) return true;
      return false;
    });
    if (matchedRetry) {
      const retryBtn = doc.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'post-retry-pill';
      retryBtn.textContent = `Retry ${matchedRetry.protocol}`;
      retryBtn.title = matchedRetry.lastError || `Retry ${matchedRetry.protocol} sync`;
      retryBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        onRetryBridge(matchedRetry, unified);
      });
      metaRight.appendChild(retryBtn);
    }
  }

  const menuWrap = buildPostContextMenu(doc, rawPost, unified, isOwn, isPinned, {
    onEditPost,
    onTogglePin,
    onDeletePost,
    onInterested,
    onNotInterested,
    onHideReply,
    onMuteAuthor,
    onBlockAuthor,
  });
  if (menuWrap) {
    metaRight.appendChild(menuWrap);
  }

  header.append(avatar, authorRow, metaRight);
  card.appendChild(header);

  const contentInner = doc.createElement('div');
  contentInner.className = 'post-content-wrap';

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'post-body-html';
  const langInfo = detectPostLanguageInfo(unified);
  if (langInfo.langTag) {
    bodyEl.setAttribute('lang', langInfo.langTag);
  }
  if (unified.content_html) {
    const htmlWithMentions = unified.content_html.includes('@')
      ? enrichUnlinkedMentionsInHtml(unified.content_html)
      : unified.content_html;
    renderSanitizedHtml(bodyEl, htmlWithMentions, mMeta.emojis || rawPost?.emojis || []);
  } else if (unified.content_text) {
    renderSanitizedHtml(bodyEl, plainTextToHtml(unified.content_text), mMeta.emojis || rawPost?.emojis || []);
  } else {
    const p = doc.createElement('p');
    p.textContent = '';
    bodyEl.appendChild(p);
  }
  contentInner.appendChild(bodyEl);

  if (langInfo.shouldOfferTranslate) {
    const translatedBodyEl = doc.createElement('div');
    translatedBodyEl.className = 'post-body-html post-translated-body';
    translatedBodyEl.setAttribute('lang', 'en');
    translatedBodyEl.hidden = true;

    const translateBar = doc.createElement('div');
    translateBar.className = 'post-translate-bar';

    const metaSpan = doc.createElement('span');
    metaSpan.className = 'post-translate-meta';
    metaSpan.hidden = true;

    const translateBtn = doc.createElement('button');
    translateBtn.type = 'button';
    translateBtn.className = 'post-translate-btn';
    const iconSpan = doc.createElement('span');
    iconSpan.className = 'post-translate-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.innerHTML = TRANSLATE_SVG;
    const labelSpan = doc.createElement('span');
    labelSpan.className = 'post-translate-label';
    const initialLabel = langInfo.languageName ? `Translate from ${langInfo.languageName}` : 'Translate post';
    labelSpan.textContent = initialLabel;
    translateBtn.append(iconSpan, labelSpan);

    const statusSpan = doc.createElement('span');
    statusSpan.className = 'post-translate-error';
    statusSpan.setAttribute('role', 'status');

    translateBar.append(metaSpan, translateBtn, statusSpan);
    contentInner.append(translatedBodyEl, translateBar);

    let inFlight = false;
    let cachedTranslation = null;
    let showingTranslation = false;
    let resolvedLangName = langInfo.languageName;

    translateBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (inFlight) return;
      if (cachedTranslation) {
        showingTranslation = !showingTranslation;
        bodyEl.hidden = showingTranslation;
        translatedBodyEl.hidden = !showingTranslation;
        metaSpan.hidden = !showingTranslation;
        labelSpan.textContent = showingTranslation
          ? 'Show original'
          : (resolvedLangName ? `Translate from ${resolvedLangName}` : 'Show translation');
        return;
      }

      inFlight = true;
      translateBtn.disabled = true;
      labelSpan.textContent = 'Translating…';
      statusSpan.textContent = '';
      try {
        const translatorFn = typeof onTranslatePost === 'function' ? onTranslatePost : translateUnifiedPost;
        const res = await translatorFn(rawPost, {
          targetLang: 'en',
          sourceLang: langInfo.sourceHint || 'auto',
        });
        translatedBodyEl.replaceChildren();
        if (res?.spoilerText) {
          const cwEl = doc.createElement('p');
          cwEl.className = 'post-translated-spoiler';
          cwEl.textContent = `CW: ${res.spoilerText}`;
          translatedBodyEl.appendChild(cwEl);
        }
        if (res?.html) {
          const htmlWrap = doc.createElement('div');
          renderSanitizedHtml(htmlWrap, res.html, []);
          translatedBodyEl.appendChild(htmlWrap);
        } else {
          const p = doc.createElement('p');
          p.textContent = String(res?.text || '');
          translatedBodyEl.appendChild(p);
        }
        resolvedLangName = resolveLanguageDisplayName(res?.detectedSourceLanguage) || langInfo.languageName;
        metaSpan.textContent = resolvedLangName ? `Translated from ${resolvedLangName} · ` : 'Translated · ';
        cachedTranslation = res;
        showingTranslation = true;
        bodyEl.hidden = true;
        translatedBodyEl.hidden = false;
        metaSpan.hidden = false;
        labelSpan.textContent = 'Show original';
      } catch {
        labelSpan.textContent = 'Retry translation';
        statusSpan.textContent = 'Translation unavailable';
      } finally {
        inFlight = false;
        translateBtn.disabled = false;
      }
    });
  }

  const isIgPhoto = layoutVariant === 'ig_photo';
  let mediaGridNode = null;
  if (Array.isArray(unified.attachments) && unified.attachments.length > 0) {
    const handleExpandMedia =
      typeof onExpandMedia === 'function'
        ? onExpandMedia
        : (item, idx, allItems) => {
            const list = Array.isArray(allItems) && allItems.length > 0 ? allItems : unified.attachments;
            openMediaLightbox(item.url || item.previewUrl, {
              source: 'social',
              initialIndex: Number.isInteger(idx) ? idx : 0,
              prompt: item.alt_text || item.description || '',
              type: String(item.type || item.mime_type || item.mimeType || 'image'),
              mimeType: String(item.mime_type || item.mimeType || ''),
              galleryItems: list.map((m) => ({
                url: m.url || m.previewUrl || '',
                prompt: m.alt_text || m.description || '',
                type: String(m.type || m.mime_type || m.mimeType || 'image'),
                mimeType: String(m.mime_type || m.mimeType || ''),
              })),
            });
          };
    const sensitiveWarning = getSensitiveMediaWarning(unified, feedStore.get().rankingManifest);
    mediaGridNode = createPostMediaGrid(unified.attachments, {
      onExpand: handleExpandMedia,
      sensitiveWarning,
      forceCarousel: isIgPhoto,
      mediaPriority,
    });
    if (!isIgPhoto) {
      contentInner.appendChild(mediaGridNode);
    }
  } else {
    const embedCard = resolvePostEmbedCard(unified);
    if (embedCard) {
      const sensitiveWarning = getSensitiveMediaWarning(unified, feedStore.get().rankingManifest);
      const cardNode = createEmbedCard(embedCard, { sensitive: Boolean(sensitiveWarning) });
      if (cardNode) contentInner.appendChild(cardNode);
    }
  }

  const quoteNode = createQuotePostCard(doc, unified._meta?.quotePost, { onOpenThread });
  if (quoteNode) {
    contentInner.appendChild(quoteNode);
  }

  const spoiler = mMeta.spoilerText || rawPost?.spoilerText || '';
  const hasCaptionText = Boolean(String(unified.content_text || '').trim());
  const actions = doc.createElement('div');
  actions.className = 'post-card-actions';
  const handlers = {
    like: onToggleLike,
    reply: onReply,
    repost: onToggleRepost,
  };
  appendReactionButtons(actions, unified, rawPost, handlers, {
    showSanctuaryAction,
    onAskSanctuary,
  });
  syncCrossPlatformResonanceStrip(actions, unified, doc);

  const shareUrl = unified.url || mMeta.uri || '';
  if (shareUrl) {
    const copyWrap = doc.createElement('span');
    copyWrap.className = 'post-copy-wrap';
    const copyBtn = doc.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'post-action-btn post-action-copy-link';
    const authorLabel = unified.author?.name || unified.author?.handle || 'author';
    copyBtn.setAttribute('aria-label', `Copy link to post by ${authorLabel}`);
    copyBtn.title = 'Copy link';
    const copyIcon = doc.createElement('span');
    copyIcon.className = 'post-copy-icon';
    copyIcon.setAttribute('aria-hidden', 'true');
    copyIcon.innerHTML = SHARE_LINK_SVG;
    copyBtn.appendChild(copyIcon);
    const tipEl = doc.createElement('span');
    tipEl.className = 'post-copy-tip';
    tipEl.setAttribute('role', 'status');
    copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      void copyPostPermalink(shareUrl, copyBtn, copyIcon, tipEl);
    });
    copyWrap.append(copyBtn, tipEl);
    actions.appendChild(copyWrap);
  }

  const mountContentBlock = () => (
    spoiler
      ? createContentWarning({
          spoilerText: spoiler,
          contentNode: contentInner,
          idPrefix: `post-cw-${unified.id || 'item'}`,
        })
      : contentInner
  );

  if (isIgPhoto && mediaGridNode) {
    card.classList.add('is-ig-photo-card');
    card.appendChild(mediaGridNode);
    card.appendChild(actions);
    if (hasCaptionText || spoiler || quoteNode) {
      card.appendChild(mountContentBlock());
    }
  } else {
    card.appendChild(mountContentBlock());
    card.appendChild(actions);
  }

  if (typeof onOpenThread === 'function' && !disableCardOpenThread) {
    card.addEventListener('click', (e) => {
      if (e.target?.closest?.('a, button, video, audio, iframe, input, .post-menu-wrap, .post-media-sensitive-wrap, .post-media-pair, .post-media-carousel, .post-embed-card, .post-quote-card, .post-translate-bar')) return;
      onOpenThread(rawPost);
    });
  }

  return card;
}

/**
 * Full-bleed vertical Loops short-video slide with snap target, lazy media deferrals,
 * sensitive-content reveal gate, right-edge action rail, and tap-to-pause stage.
 */
export function createLoopsSlide(rawPost, {
  isFirstSlide = false,
  initialMuted = true,
  onToggleSound,
  onRequestPlay,
  onReply,
  onToggleLike,
  onToggleRepost,
  onOpenThread,
  onAskSanctuary,
  onSelectAuthor,
  onInterested,
  onNotInterested,
  onMuteAuthor,
  onBlockAuthor,
  onEditPost,
  onDeletePost,
  showSanctuaryAction = false,
} = {}) {
  const doc = globalThis.document;
  const unified = toUnifiedItem(rawPost);
  const slide = doc.createElement('article');
  slide.className = 'loops-slide';
  slide.tabIndex = -1;
  slide.dataset.postId = unified.id || '';
  slide.dataset.postKey = rawPost?.key || unified.id || '';
  slide.dataset.protocol = unified.protocol || 'mastodon';

  const stage = doc.createElement('div');
  stage.className = 'loops-stage';

  const atts = Array.isArray(unified.attachments) ? unified.attachments : [];
  const vidAtt =
    atts.find((a) => {
      const t = String(a?.type || '').toLowerCase();
      const mime = String(a?.mime_type || a?.mimeType || '').toLowerCase();
      return t === 'video' || t === 'gifv' || mime.startsWith('video/') || Boolean(a?.hlsUrl);
    })
    || atts[0]
    || {};

  const video = doc.createElement('video');
  const videoId = `loops-video-${loopsVideoSeq++}`;
  video.id = videoId;
  video.className = 'loops-video';
  video.disablePictureInPicture = true;
  video.setAttribute('disablepictureinpicture', '');
  video.loop = true;
  video.setAttribute('loop', '');
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.muted = Boolean(initialMuted);
  if (initialMuted) video.setAttribute('muted', '');
  video.referrerPolicy = 'no-referrer';
  video.setAttribute('referrerpolicy', 'no-referrer');
  video.width = Number.parseInt(vidAtt.width, 10) || 720;
  video.height = Number.parseInt(vidAtt.height, 10) || 1280;
  video.setAttribute('width', String(video.width));
  video.setAttribute('height', String(video.height));

  const altDesc = vidAtt.description || vidAtt.alt_text || '';
  if (altDesc) {
    video.setAttribute('aria-label', altDesc);
  }

  const videoUrl = String(vidAtt.url || vidAtt.hlsUrl || '');
  const posterUrl = String(vidAtt.previewUrl || '');
  const mimeType = String(vidAtt.mime_type || vidAtt.mimeType || '').toLowerCase();
  const supportsLazyMedia = Object.hasOwn(globalThis.HTMLMediaElement?.prototype || {}, 'loading');

  const attachImmediateSources = () => {
    if (posterUrl && posterUrl !== videoUrl) {
      video.poster = posterUrl;
      video.setAttribute('poster', posterUrl);
    }
    const canPlayHls = Boolean(vidAtt.hlsUrl && video.canPlayType?.('application/vnd.apple.mpegurl'));
    if (canPlayHls) {
      const hlsSource = doc.createElement('source');
      hlsSource.setAttribute('src', vidAtt.hlsUrl);
      hlsSource.setAttribute('type', 'application/vnd.apple.mpegurl');
      video.appendChild(hlsSource);
      if (videoUrl && videoUrl !== vidAtt.hlsUrl) {
        const mp4Source = doc.createElement('source');
        mp4Source.setAttribute('src', videoUrl);
        mp4Source.setAttribute('type', mimeType.startsWith('video/') ? mimeType : 'video/mp4');
        video.appendChild(mp4Source);
      }
    } else if (videoUrl) {
      video.src = videoUrl;
      video.setAttribute('src', videoUrl);
    }
  };

  if (isFirstSlide) {
    video.preload = 'auto';
    video.setAttribute('preload', 'auto');
    attachImmediateSources();
  } else {
    video.setAttribute('loading', 'lazy');
    if (supportsLazyMedia) {
      video.preload = 'metadata';
      video.setAttribute('preload', 'metadata');
      attachImmediateSources();
    } else {
      video.preload = 'none';
      video.setAttribute('preload', 'none');
      if (posterUrl && posterUrl !== videoUrl) video.dataset.lazyPoster = posterUrl;
      if (vidAtt.hlsUrl && video.canPlayType?.('application/vnd.apple.mpegurl')) {
        video.dataset.lazyHls = vidAtt.hlsUrl;
      }
      if (videoUrl) video.dataset.lazySrc = videoUrl;
      if (mimeType) video.dataset.lazyMime = mimeType;
    }
  }

  if (vidAtt.did && vidAtt.cid) {
    video.addEventListener(
      'error',
      () => {
        void (async () => {
          try {
            const plcRes = await fetch(`https://plc.directory/${encodeURIComponent(vidAtt.did)}`);
            if (!plcRes.ok) return;
            const plcDoc = await plcRes.json();
            const services = Array.isArray(plcDoc?.service) ? plcDoc.service : [];
            const pds = services.find((s) => s?.id === '#atproto_pds')?.serviceEndpoint || '';
            if (typeof pds === 'string' && pds.startsWith('https://')) {
              const directUrl = `${pds.replace(/\/+$/, '')}/xrpc/com.atproto.sync.getBlob?did=${encodeURIComponent(vidAtt.did)}&cid=${encodeURIComponent(vidAtt.cid)}`;
              if (directUrl !== video.src) {
                video.src = directUrl;
                video.setAttribute('src', directUrl);
              }
            }
          } catch {
            // Ignore PDS lookup failure
          }
        })();
      },
      { once: true }
    );
  }

  const canLoopPlay = () =>
    !stage.classList.contains('is-user-paused') && !stage.classList.contains('is-blurred');

  video.addEventListener('timeupdate', () => {
    if (!canLoopPlay() || video.paused || video.seeking) return;
    const dur = Number(video.duration);
    if (Number.isFinite(dur) && dur > 0.35 && video.currentTime >= dur - 0.05) {
      try {
        video.currentTime = 0;
      } catch {
        // Ignore synthetic DOM currentTime assignment errors
      }
    }
  });

  video.addEventListener('ended', () => {
    if (!canLoopPlay()) return;
    try {
      video.currentTime = 0;
      video.play?.()?.catch?.(() => {});
    } catch {
      // Ignore synthetic DOM play errors
    }
  });

  stage.appendChild(video);

  const sensitiveWarning = getSensitiveMediaWarning(unified, feedStore.get().rankingManifest);
  if (sensitiveWarning) {
    stage.classList.add('is-blurred');
    video.inert = true;
    video.setAttribute('inert', '');

    const revealBtn = doc.createElement('button');
    revealBtn.type = 'button';
    revealBtn.className = 'post-media-sensitive-btn';
    revealBtn.setAttribute('aria-controls', videoId);

    const iconEl = doc.createElement('span');
    iconEl.className = 'post-media-sensitive-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.style.display = 'contents';
    const labelEl = doc.createElement('span');
    labelEl.className = 'post-media-sensitive-label';
    revealBtn.append(iconEl, labelEl);

    let revealed = false;
    const syncGate = () => {
      stage.classList.toggle('is-blurred', !revealed);
      stage.classList.toggle('is-revealed', revealed);
      video.inert = !revealed;
      if (revealed) video.removeAttribute?.('inert');
      else video.setAttribute?.('inert', '');
      revealBtn.setAttribute('aria-expanded', revealed ? 'true' : 'false');
      iconEl.innerHTML = revealed ? EYE_OFF_SVG : EYE_OPEN_SVG;
      labelEl.textContent = revealed ? 'Hide media' : `Show · ${sensitiveWarning}`;
    };

    revealBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      revealed = !revealed;
      syncGate();
      if (revealed) {
        onRequestPlay?.(slide);
      } else {
        try {
          video.pause?.();
        } catch {
          // Ignore pause errors in synthetic DOM
        }
      }
    });

    syncGate();
    stage.appendChild(revealBtn);
  }

  stage.addEventListener('click', (e) => {
    if (e.target?.closest?.('button, a, input, .post-menu-wrap, .loops-progress-wrap')) return;
    if (stage.classList.contains('is-blurred')) return;
    if (video.paused) {
      stage.classList.remove('is-user-paused');
      try {
        video.play?.()?.catch?.(() => {});
      } catch {
        // Ignore play failure
      }
    } else {
      stage.classList.add('is-user-paused');
      try {
        video.pause?.();
      } catch {
        // Ignore pause failure
      }
    }
  });

  const soundBtn = doc.createElement('button');
  soundBtn.type = 'button';
  soundBtn.className = 'loops-sound-btn';
  soundBtn.setAttribute('aria-label', initialMuted ? 'Unmute audio' : 'Mute audio');
  soundBtn.setAttribute('aria-pressed', initialMuted ? 'false' : 'true');
  soundBtn.innerHTML = initialMuted ? VOLUME_MUTED_SVG : VOLUME_ON_SVG;
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggleSound?.();
  });
  stage.appendChild(soundBtn);

  const rail = doc.createElement('div');
  rail.className = 'loops-action-rail';
  appendReactionButtons(
    rail,
    unified,
    rawPost,
    {
      like: onToggleLike,
      reply: onOpenThread ? () => onOpenThread(rawPost) : onReply,
      repost: onToggleRepost,
    },
    { showSanctuaryAction, onAskSanctuary }
  );

  const isOwn = isOwnPostItem(unified);
  const menuWrap = buildPostContextMenu(doc, rawPost, unified, isOwn, false, {
    onEditPost,
    onDeletePost,
    onInterested,
    onNotInterested,
    onMuteAuthor,
    onBlockAuthor,
  });
  if (menuWrap) {
    rail.appendChild(menuWrap);
  }
  stage.appendChild(rail);

  const captionOverlay = doc.createElement('div');
  captionOverlay.className = 'loops-caption-overlay';

  const authorBtn = doc.createElement('button');
  authorBtn.type = 'button';
  authorBtn.className = 'loops-author-btn';
  const avatar = doc.createElement('img');
  avatar.className = 'post-avatar loops-author-avatar';
  avatar.src = unified.author?.avatar_url || DEFAULT_AVATAR_DATA_URI;
  avatar.alt = unified.author?.name || unified.author?.handle || 'Author avatar';
  avatar.loading = 'lazy';
  const handleSpan = doc.createElement('span');
  handleSpan.className = 'loops-author-handle';
  handleSpan.textContent = unified.author?.handle
    ? `@${unified.author.handle.replace(/^@/, '')}`
    : (unified.author?.name || 'Unknown');
  authorBtn.append(avatar, handleSpan);
  authorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onSelectAuthor?.(unified.author, unified);
  });
  captionOverlay.appendChild(authorBtn);

  const cleanCaption = String(unified.content_text || '').trim();
  if (cleanCaption) {
    const capText = doc.createElement('p');
    capText.className = 'loops-caption-text';
    capText.textContent = cleanCaption;
    captionOverlay.appendChild(capText);
    if (cleanCaption.length > 110) {
      const capToggle = doc.createElement('button');
      capToggle.type = 'button';
      capToggle.className = 'loops-caption-more-btn';
      capToggle.setAttribute('aria-expanded', 'false');
      capToggle.textContent = 'More';
      capToggle.addEventListener('click', (e) => {
        e.stopPropagation();
        const expanded = capText.classList.toggle('is-expanded');
        capToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        capToggle.textContent = expanded ? 'Less' : 'More';
      });
      captionOverlay.appendChild(capToggle);
    }
  }

  const progressWrap = doc.createElement('div');
  progressWrap.className = 'loops-progress-wrap';
  const scrubber = doc.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'loops-scrubber';
  scrubber.min = '0';
  scrubber.max = '1000';
  scrubber.step = '1';
  scrubber.value = '0';
  scrubber.setAttribute('aria-label', 'Seek video position');
  const timePill = doc.createElement('span');
  timePill.className = 'loops-time-pill';
  timePill.setAttribute('aria-live', 'off');
  timePill.textContent = '0:00';

  const syncScrubberUi = () => {
    const dur = Number(video.duration);
    if (Number.isFinite(dur) && dur > 0) {
      const pos = Math.max(0, Math.min(1000, Math.round((Number(video.currentTime || 0) / dur) * 1000)));
      scrubber.value = String(pos);
      timePill.textContent = `${formatMediaClock(video.currentTime)} / ${formatMediaClock(dur)}`;
    } else {
      timePill.textContent = formatMediaClock(video.currentTime);
    }
  };
  video.addEventListener('loadedmetadata', syncScrubberUi);
  video.addEventListener('timeupdate', syncScrubberUi);
  const handleScrub = (e) => {
    e.stopPropagation();
    const dur = Number(video.duration);
    if (Number.isFinite(dur) && dur > 0) {
      try {
        video.currentTime = (Number(scrubber.value) / 1000) * dur;
      } catch {
        // Ignore synthetic DOM currentTime errors
      }
      syncScrubberUi();
    }
  };
  scrubber.addEventListener('click', (e) => e.stopPropagation());
  scrubber.addEventListener('input', handleScrub);
  scrubber.addEventListener('change', handleScrub);
  progressWrap.append(scrubber, timePill);
  captionOverlay.appendChild(progressWrap);

  stage.appendChild(captionOverlay);
  slide.appendChild(stage);
  return slide;
}
