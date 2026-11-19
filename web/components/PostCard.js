import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { toUnifiedItem } from '../core/schema/unifiedItem.js';
import { renderSanitizedHtml } from '../queries/fediverse.js';
import { authStore } from '../state/authStore.js';
import { createContentWarning } from './ContentWarning.js';
import { createEmbedCard, resolvePostEmbedCard } from './EmbedCard.js';
import { createPostMediaGrid } from './MediaAttachment.js';
import { openMediaLightbox } from './sanctuary/PortraitGrid.js';

const REPLY_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`;
const REPOST_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M21 13v1a4 4 0 0 1-4 4H3"></path></svg>`;
const REPOST_ACTIVE_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"></path><path d="M3 11v-1a4 4 0 0 1 4-4h14"></path><path d="m7 22-4-4 4-4"></path><path d="M11 18H7a4 4 0 0 1-4-4v-1"></path><path d="m15 16 2 2 4-4"></path></svg>`;
const HEART_OUTLINE_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
const HEART_FILLED_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`;
const SANCTUARY_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4Z"></path></svg>`;
const SHARE_LINK_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="18" cy="5" r="3"></circle><circle cx="6" cy="12" r="3"></circle><circle cx="18" cy="19" r="3"></circle><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line></svg>`;
const CHECK_SVG = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
const MORE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>`;

const copyTimers = new WeakMap();
let lastCopyAnnouncement = '';

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

function createActionButton({ iconSvg, count, label, tooltip = '', pressed = null, active = false, className = '', onClick }) {
  const doc = globalThis.document;
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = ['post-action-btn', active ? 'is-active' : '', className].filter(Boolean).join(' ');
  const resolvedTitle = tooltip || label;
  btn.setAttribute('aria-label', count !== null && count !== undefined ? `${resolvedTitle} (${count})` : resolvedTitle);
  btn.title = resolvedTitle;
  if (pressed !== null) {
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
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
    onClick?.();
  });
  return btn;
}

function isOwnPostItem(unified) {
  const accounts = authStore.get().accounts || [];
  const authorHandle = String(unified.author?.handle || '').replace(/^@/, '').toLowerCase();
  const authorId = String(unified.author?.id || '');
  return accounts.some((acc) => {
    const accAcct = String(acc.acct || acc.handle || '').replace(/^@/, '').toLowerCase();
    return (accAcct && accAcct === authorHandle) || (acc.userId && String(acc.userId) === authorId);
  });
}

function formatProtocolBadge(unified) {
  const linked = unified._meta?.linkedIds;
  if (linked && (linked.blueskyUri || linked.threadsPostId)) {
    const parts = ['Mastodon'];
    if (linked.blueskyUri) parts.push('Bluesky');
    if (linked.threadsPostId) parts.push('Threads');
    return parts.join(' · ');
  }
  if (unified.protocol === 'bluesky') return 'Bluesky';
  if (unified.protocol === 'threads') return 'Threads';
  return '';
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

function updateActionButtonState(btn, { iconSvg, count, tip, active, pressed }) {
  if (!btn) return;
  btn.classList.toggle('is-active', Boolean(active));
  if (pressed !== null && pressed !== undefined) {
    btn.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  }
  btn.title = tip;
  btn.setAttribute('aria-label', count !== null && count !== undefined ? `${tip} (${count})` : tip);
  const iconEl = btn.querySelector('.post-action-icon');
  if (iconEl) {
    iconEl.innerHTML = iconSvg;
  }
  const countEl = btn.querySelector('.post-action-count');
  if (countEl && count !== null && count !== undefined) {
    countEl.textContent = String(count);
  }
}

/**
 * Update Favourite, Reply, and Boost controls on an existing `<article class="post-card">`
 * in place without detaching DOM nodes or discarding button focus.
 */
export function syncPostCardReactions(cardEl, rawPost) {
  if (!cardEl) return;
  const unified = toUnifiedItem(rawPost);
  const mMeta = unified._meta?.mastodon || {};
  const bMeta = unified._meta?.bluesky || {};
  const liked = Boolean(mMeta.favourited || bMeta.likeUri || rawPost?.viewerState?.favourited);
  const reposted = Boolean(mMeta.reblogged || bMeta.repostUri || rawPost?.viewerState?.reblogged);
  const breakdown = unified._meta?.metricsBreakdown;

  updateActionButtonState(cardEl.querySelector('.post-action-like'), {
    iconSvg: liked ? HEART_FILLED_SVG : HEART_OUTLINE_SVG,
    count: unified.metrics?.likes ?? 0,
    tip: formatBreakdownTip(breakdown, 'Favourite', 'likes'),
    active: liked,
    pressed: liked,
  });
  updateActionButtonState(cardEl.querySelector('.post-action-reply'), {
    iconSvg: REPLY_SVG,
    count: unified.metrics?.replies ?? 0,
    tip: formatBreakdownTip(breakdown, 'Reply', 'replies'),
    active: false,
    pressed: null,
  });
  updateActionButtonState(cardEl.querySelector('.post-action-repost'), {
    iconSvg: reposted ? REPOST_ACTIVE_SVG : REPOST_SVG,
    count: unified.metrics?.reposts ?? 0,
    tip: formatBreakdownTip(breakdown, 'Boost', 'reposts'),
    active: reposted,
    pressed: reposted,
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

  const canOpenInternal = typeof onOpenThread === 'function' && (quote.uri || quote.statusId || quote.id);
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
  const cleanHandle = String(quote.authorHandle || '').replace(/^@/, '');
  handleEl.textContent = cleanHandle ? `@${cleanHandle}` : '';
  head.append(nameEl, handleEl);
  el.appendChild(head);

  if (quote.text) {
    const p = doc.createElement('p');
    p.className = 'post-quote-text';
    p.textContent = quote.text;
    el.appendChild(p);
  }

  if (quote.thumbUrl) {
    const thumb = doc.createElement('img');
    thumb.className = 'post-quote-thumb';
    thumb.src = quote.thumbUrl;
    thumb.alt = '';
    thumb.loading = 'lazy';
    el.appendChild(thumb);
  }

  el.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!canOpenInternal) return;
    let authorUrl = '';
    if (quote.protocol === 'mastodon') {
      try {
        authorUrl = quote.url ? `${new URL(quote.url).origin}/@${cleanHandle.split('@')[0]}` : '';
      } catch {
        authorUrl = '';
      }
    } else if (cleanHandle) {
      authorUrl = `https://bsky.app/profile/${cleanHandle}`;
    }
    const quotedUnified = toUnifiedItem({
      id: quote.id || '',
      protocol: quote.protocol || 'bluesky',
      url: quote.url || '',
      content_text: quote.text || '',
      date_published: quote.createdAt || '',
      author: {
        id: quote.authorDid || cleanHandle,
        name: quote.authorName || cleanHandle,
        handle: cleanHandle,
        avatar_url: quote.authorAvatar || '',
        url: authorUrl,
      },
      attachments: [],
      metrics: { replies: 0, reposts: 0, likes: 0 },
      _meta: quote.protocol === 'mastodon'
        ? { mastodon: { statusId: quote.statusId || '', instanceUrl: quote.instanceUrl || 'https://mastodon.social' } }
        : { bluesky: { uri: quote.uri || '', cid: quote.cid || '' } },
    });
    onOpenThread(quotedUnified);
  });

  return el;
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
  onFollowAuthor,
  onManageAuthorLists,
  onMuteAuthor,
  onBlockAuthor,
  showSanctuaryAction = false,
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

  if (isPinned) {
    const pinRow = doc.createElement('div');
    pinRow.className = 'post-reblog-banner';
    pinRow.textContent = 'Pinned post';
    card.appendChild(pinRow);
  } else if (rebloggedBy) {
    const boostRow = doc.createElement('div');
    boostRow.className = 'post-reblog-banner';
    const boosterName = rebloggedBy.name || rebloggedBy.displayName || rebloggedBy.handle || rebloggedBy.acct || '';
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
      boostRow.append(boosterBtn, doc.createTextNode('\u00A0boosted'));
    } else {
      const nameSpan = doc.createElement('span');
      nameSpan.className = 'post-reblog-name';
      nameSpan.textContent = boosterName;
      boostRow.append(nameSpan, doc.createTextNode('\u00A0boosted'));
    }
    card.appendChild(boostRow);
  }

  const header = doc.createElement('div');
  header.className = 'post-card-header';

  const avatar = doc.createElement('img');
  avatar.className = 'post-avatar';
  avatar.src = unified.author?.avatar_url || DEFAULT_AVATAR_DATA_URI;
  avatar.alt = unified.author?.name || unified.author?.handle || 'Author avatar';
  avatar.loading = 'lazy';
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

  const protoLabel = formatProtocolBadge(unified);
  if (protoLabel) {
    const badge = doc.createElement('span');
    badge.className = 'post-protocol-badge';
    badge.textContent = protoLabel;
    metaRight.appendChild(badge);
  }

  const isOwn = isOwnPostItem(unified);
  const hasMenuActions = Boolean(
    onEditPost || onDeletePost || onTogglePin || onFollowAuthor || onManageAuthorLists || onMuteAuthor || onBlockAuthor || onSelectAuthor
  );
  if (hasMenuActions) {
    const menuWrap = doc.createElement('div');
    menuWrap.className = 'post-menu-wrap';

    const moreBtn = doc.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'post-more-btn';
    moreBtn.setAttribute('aria-label', 'Post actions');
    moreBtn.setAttribute('aria-haspopup', 'menu');
    moreBtn.setAttribute('aria-expanded', 'false');
    moreBtn.innerHTML = MORE_SVG;

    const menuPanel = doc.createElement('div');
    menuPanel.className = 'post-context-menu';
    menuPanel.setAttribute('role', 'menu');
    menuPanel.hidden = true;

    const closeMenu = () => {
      menuPanel.hidden = true;
      moreBtn.setAttribute('aria-expanded', 'false');
    };

    const addMenuItem = (label, handler, danger = false) => {
      const itemBtn = doc.createElement('button');
      itemBtn.type = 'button';
      itemBtn.setAttribute('role', 'menuitem');
      itemBtn.className = `post-context-menuitem${danger ? ' is-danger' : ''}`;
      itemBtn.textContent = label;
      itemBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenu();
        handler?.(rawPost, unified);
      });
      menuPanel.appendChild(itemBtn);
    };

    if (isOwn) {
      if (onEditPost && unified.protocol === 'mastodon') addMenuItem('Edit Post', onEditPost);
      if (onTogglePin && unified.protocol === 'mastodon') {
        addMenuItem(isPinned ? 'Unpin from Profile' : 'Pin to Profile', onTogglePin);
      }
      if (onDeletePost) addMenuItem('Delete Post', onDeletePost, true);
    } else {
      if (onSelectAuthor) addMenuItem('View Profile', () => onSelectAuthor(unified.author, unified));
      if (onFollowAuthor) addMenuItem('Follow / Unfollow', onFollowAuthor);
      if (onManageAuthorLists) addMenuItem('Add / Remove from Lists', onManageAuthorLists);
      if (onMuteAuthor) addMenuItem('Mute Account', onMuteAuthor);
      if (onBlockAuthor) addMenuItem('Block Account', onBlockAuthor, true);
    }

    if (menuPanel.childNodes.length > 0) {
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menuPanel.hidden;
        menuPanel.hidden = !willOpen;
        moreBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) {
          const onOutside = (ev) => {
            if (!menuWrap.contains(ev.target)) {
              closeMenu();
              doc.removeEventListener('click', onOutside);
            }
          };
          doc.addEventListener('click', onOutside);
        }
      });
      menuWrap.append(moreBtn, menuPanel);
      metaRight.appendChild(menuWrap);
    }
  }

  header.append(avatar, authorRow, metaRight);
  card.appendChild(header);

  const contentInner = doc.createElement('div');
  contentInner.className = 'post-content-wrap';

  const bodyEl = doc.createElement('div');
  bodyEl.className = 'post-body-html';
  if (unified.content_html) {
    renderSanitizedHtml(bodyEl, unified.content_html, mMeta.emojis || rawPost?.emojis || []);
  } else {
    const p = doc.createElement('p');
    p.textContent = unified.content_text || '';
    bodyEl.appendChild(p);
  }
  contentInner.appendChild(bodyEl);

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
    contentInner.appendChild(createPostMediaGrid(unified.attachments, { onExpand: handleExpandMedia }));
  } else {
    const embedCard = resolvePostEmbedCard(unified);
    if (embedCard) {
      const cardNode = createEmbedCard(embedCard);
      if (cardNode) contentInner.appendChild(cardNode);
    }
  }

  const quoteNode = createQuotePostCard(doc, unified._meta?.quotePost, { onOpenThread });
  if (quoteNode) {
    contentInner.appendChild(quoteNode);
  }

  const spoiler = mMeta.spoilerText || rawPost?.spoilerText || '';
  if (spoiler) {
    card.appendChild(
      createContentWarning({
        spoilerText: spoiler,
        contentNode: contentInner,
        idPrefix: `post-cw-${unified.id || 'item'}`,
      })
    );
  } else {
    card.appendChild(contentInner);
  }

  const actions = doc.createElement('div');
  actions.className = 'post-card-actions';
  const liked = Boolean(mMeta.favourited || bMeta.likeUri || rawPost?.viewerState?.favourited);
  const reposted = Boolean(mMeta.reblogged || bMeta.repostUri || rawPost?.viewerState?.reblogged);
  const breakdown = unified._meta?.metricsBreakdown;

  actions.appendChild(
    createActionButton({
      iconSvg: liked ? HEART_FILLED_SVG : HEART_OUTLINE_SVG,
      count: unified.metrics?.likes ?? 0,
      label: 'Favourite',
      tooltip: formatBreakdownTip(breakdown, 'Favourite', 'likes'),
      pressed: liked,
      active: liked,
      className: 'post-action-like',
      onClick: () => onToggleLike?.(rawPost),
    })
  );
  actions.appendChild(
    createActionButton({
      iconSvg: REPLY_SVG,
      count: unified.metrics?.replies ?? 0,
      label: 'Reply',
      tooltip: formatBreakdownTip(breakdown, 'Reply', 'replies'),
      className: 'post-action-reply',
      onClick: () => onReply?.(rawPost),
    })
  );
  actions.appendChild(
    createActionButton({
      iconSvg: reposted ? REPOST_ACTIVE_SVG : REPOST_SVG,
      count: unified.metrics?.reposts ?? 0,
      label: 'Boost',
      tooltip: formatBreakdownTip(breakdown, 'Boost', 'reposts'),
      pressed: reposted,
      active: reposted,
      className: 'post-action-repost',
      onClick: () => onToggleRepost?.(rawPost),
    })
  );

  if (showSanctuaryAction && typeof onAskSanctuary === 'function') {
    actions.appendChild(
      createActionButton({
        iconSvg: SANCTUARY_SVG,
        count: null,
        label: 'Share to Program',
        className: 'post-action-sanctuary',
        onClick: () => onAskSanctuary(rawPost),
      })
    );
  }

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

  card.appendChild(actions);

  if (typeof onOpenThread === 'function') {
    card.addEventListener('click', (e) => {
      if (e.target?.closest?.('a, button, video, audio, iframe, input, .post-menu-wrap, .post-media-carousel, .post-embed-card, .post-quote-card')) return;
      onOpenThread(rawPost);
    });
  }

  return card;
}
