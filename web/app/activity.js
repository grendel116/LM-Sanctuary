import { createOfflineNotice } from '../components/OfflineNotice.js';
import { getPostActionCapabilities } from '../components/PostCard.js';
import { showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import {
  hideReplyUnified,
  toggleBlockAuthor,
  toggleFollowAuthor,
  toggleMuteAuthor,
} from '../queries/socialClient.js';
import {
  activityStore,
  clearAllActivity,
  computeActivityTotals,
  dismissActivityGroup,
  groupActivityNotifications,
  refreshActivityNotifications,
  removeActivityByActor,
} from '../state/activityStore.js';
import { authStore, getAuthenticatedAccount } from '../state/authStore.js';
import { prefillReply } from '../state/composeStore.js';
import { removePostAcrossStreams } from '../state/feedStore.js';

const BADGE_ICONS = {
  like: `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`,
  repost: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"></polyline><path d="M3 11V9a4 4 0 0 1 4-4h14"></path><polyline points="7 23 3 19 7 15"></polyline><path d="M21 13v2a4 4 0 0 1-4 4H3"></path></svg>`,
  reply: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>`,
  mention: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"></circle><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-3.92 7.94"></path></svg>`,
  quote: `<svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>`,
  follow: `<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="8.5" cy="7" r="4"></circle><line x1="20" y1="8" x2="20" y2="14"></line><line x1="23" y1="11" x2="17" y2="11"></line></svg>`,
};

const MORE_DOTS_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>`;

const VERB_LABELS = {
  reply: 'replied',
  mention: 'mentioned you',
  quote: 'quoted your post',
  follow: 'followed you',
  poll: 'ended a poll',
  status: 'posted',
};

const PROTO_DISPLAY = {
  mastodon: 'Mastodon',
  bluesky: 'Bluesky',
  threads: 'Threads',
};

let popoverIdSeq = 1;

function formatRelativeShort(dateStr) {
  const ts = Date.parse(dateStr || '');
  if (!Number.isFinite(ts) || ts <= 0) return '';
  const diffSec = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diffSec < 60) return diffSec < 15 ? 'now' : `${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

function formatBreakdownTitle(breakdown) {
  if (!breakdown || typeof breakdown !== 'object') return '';
  const lines = [];
  for (const proto of ['mastodon', 'bluesky', 'threads']) {
    const vals = breakdown[proto];
    if (!vals) continue;
    lines.push(
      `${PROTO_DISPLAY[proto]}: ${vals.likes || 0} likes · ${vals.reposts || 0} reposts · ${vals.replies || 0} comments`
    );
  }
  return lines.join('\n');
}

function formatPlatformTotalTitle(totals, field) {
  const parts = [];
  for (const proto of ['mastodon', 'bluesky', 'threads']) {
    const val = Number(totals?.byPlatform?.[proto]?.[field] || 0);
    if (val > 0) parts.push(`${PROTO_DISPLAY[proto]}: ${val}`);
  }
  return parts.join(' · ');
}

function supportsNativePopover(doc) {
  try {
    return (
      typeof globalThis.HTMLElement !== 'undefined'
      && Object.hasOwn(globalThis.HTMLElement.prototype, 'popover')
      && typeof doc.createElement('div').showPopover === 'function'
    );
  } catch {
    return false;
  }
}

function supportsCssAnchorPositioning() {
  try {
    return Boolean(globalThis.CSS?.supports?.('position-area: block-end'));
  } catch {
    return false;
  }
}

function positionPopoverNearTrigger(panelEl, triggerEl) {
  const rect = triggerEl?.getBoundingClientRect?.();
  if (!rect) return;
  const vw = Number(globalThis.innerWidth || 1280);
  const vh = Number(globalThis.innerHeight || 720);
  const panelW = Math.min(196, vw - 16);
  const left = Math.max(8, Math.min(vw - panelW - 8, rect.right - panelW));
  const preferTop = rect.bottom + 140 > vh && rect.top > 140;
  panelEl.style.position = 'fixed';
  panelEl.style.inset = 'auto';
  panelEl.style.margin = '0';
  panelEl.style.left = `${left}px`;
  if (preferTop) {
    panelEl.style.top = 'auto';
    panelEl.style.bottom = `${Math.max(8, vh - rect.top + 4)}px`;
  } else {
    panelEl.style.bottom = 'auto';
    panelEl.style.top = `${Math.max(8, rect.bottom + 4)}px`;
  }
}

/**
 * Activity view: grouped chronological notifications across Mastodon, Bluesky, and Threads
 * with cross-platform engagement totals and per-item/bulk deletion.
 */
export function mountActivityScreen(containerEl, {
  onOpenPostThread,
  onAskSanctuary: _onAskSanctuary,
  onOpenAccounts,
  onSelectAuthor,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();
  let destroyed = false;
  let activeFilter = 'all';
  let openFallbackMenuClose = null;
  const nativePopover = supportsNativePopover(doc);
  const nativeAnchor = supportsCssAnchorPositioning();

  const root = doc.createElement('section');
  root.className = 'activity-screen';

  const header = doc.createElement('div');
  header.className = 'stage-header';
  const h1 = doc.createElement('h1');
  h1.className = 'stage-title';
  h1.textContent = 'Activity';

  const headerActions = doc.createElement('div');
  headerActions.className = 'activity-header-actions';

  const clearAllBtn = doc.createElement('button');
  clearAllBtn.type = 'button';
  clearAllBtn.className = 'edit-btn edit-cancel-btn activity-clear-all-btn';
  clearAllBtn.textContent = 'Clear all';
  clearAllBtn.hidden = true;

  const refreshBtn = doc.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'edit-btn edit-cancel-btn activity-refresh-btn';
  refreshBtn.textContent = 'Refresh';

  headerActions.append(clearAllBtn, refreshBtn);
  header.append(h1, headerActions);

  const totalsBarEl = doc.createElement('div');
  totalsBarEl.className = 'activity-totals-bar';
  totalsBarEl.hidden = true;

  const listEl = doc.createElement('div');
  listEl.className = 'activity-list';
  root.append(header, totalsBarEl, listEl);
  containerEl.appendChild(root);

  function closeFallbackMenus() {
    openFallbackMenuClose?.();
    openFallbackMenuClose = null;
  }

  function handleDocClickOutside(ev) {
    if (!openFallbackMenuClose) return;
    const t = ev.target?.nodeType === 1 ? ev.target : ev.target?.parentElement;
    if (!t?.closest?.('.activity-more-wrap')) {
      closeFallbackMenus();
    }
  }
  doc.addEventListener?.('click', handleDocClickOutside);

  function renderFromStore() {
    if (destroyed) return;
    closeFallbackMenus();

    const accounts = authStore.get().accounts || [];
    const state = activityStore.get();

    if (accounts.length === 0) {
      clearAllBtn.hidden = true;
      totalsBarEl.hidden = true;
      const notice = createOfflineNotice({
        variant: 'info',
        message: 'Connect Mastodon under Profile → Accounts & Bridges to view notifications.',
        actionLabel: 'Accounts',
        onAction: () => onOpenAccounts?.(),
      });
      listEl.replaceChildren(notice);
      return;
    }

    if (state.loading && state.items.length === 0) {
      clearAllBtn.hidden = true;
      totalsBarEl.hidden = true;
      listEl.replaceChildren(createLoadingState('Loading notifications…'));
      return;
    }

    if (state.error && state.items.length === 0) {
      clearAllBtn.hidden = true;
      totalsBarEl.hidden = true;
      listEl.replaceChildren(createOfflineNotice({ variant: 'error', message: state.error }));
      return;
    }

    const groups = groupActivityNotifications(state.items);
    clearAllBtn.hidden = groups.length === 0;

    if (groups.length === 0) {
      totalsBarEl.hidden = true;
      const empty = doc.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = 'No notifications.';
      listEl.replaceChildren(empty);
      return;
    }

    const totals = computeActivityTotals(state.items);
    const filters = [
      { id: 'all', label: `All (${groups.length})`, title: 'Show all notifications' },
      { id: 'like', label: `♥ ${totals.likes}`, aria: `${totals.likes} total likes`, title: formatPlatformTotalTitle(totals, 'likes') || 'Likes' },
      { id: 'repost', label: `↻ ${totals.reposts}`, aria: `${totals.reposts} total reposts`, title: formatPlatformTotalTitle(totals, 'reposts') || 'Reposts' },
      { id: 'comment', label: `💬 ${totals.comments}`, aria: `${totals.comments} total comments`, title: formatPlatformTotalTitle(totals, 'comments') || 'Comments' },
    ];
    if (totals.follows > 0) {
      filters.push({ id: 'follow', label: `Follows (${totals.follows})`, title: 'Follows' });
    }

    totalsBarEl.hidden = false;
    totalsBarEl.replaceChildren(
      ...filters.map((f) => {
        const pill = doc.createElement('button');
        pill.type = 'button';
        pill.className = `activity-filter-pill${activeFilter === f.id ? ' is-active' : ''}`;
        pill.dataset.filter = f.id;
        pill.textContent = f.label;
        if (f.aria) pill.setAttribute('aria-label', f.aria);
        if (f.title) pill.title = f.title;
        pill.addEventListener('click', () => {
          activeFilter = f.id;
          renderFromStore();
        });
        return pill;
      })
    );

    const visibleGroups = groups.filter((g) => {
      if (activeFilter === 'all') return true;
      if (activeFilter === 'like') return g.kind === 'like';
      if (activeFilter === 'repost') return g.kind === 'repost';
      if (activeFilter === 'comment') return g.kind === 'reply' || g.kind === 'mention' || g.kind === 'quote';
      if (activeFilter === 'follow') return g.kind === 'follow';
      return true;
    });

    if (visibleGroups.length === 0) {
      const emptyFilter = doc.createElement('p');
      emptyFilter.className = 'empty-state';
      emptyFilter.textContent = 'No matching notifications.';
      listEl.replaceChildren(emptyFilter);
      return;
    }

    listEl.replaceChildren(...visibleGroups.map((group) => buildGroupRow(group)));
  }

  function buildGroupRow(group) {
    const row = doc.createElement('div');
    row.className = `activity-row activity-row--${group.kind}`;
    row.dataset.groupKey = group.groupKey;

    const actor = group.primaryActor || {};
    const primaryItem = group.primaryItem;
    const targetItem = group.threadTargetItem;

    // 1. Leading avatar + colored action badge
    const avatarWrap = doc.createElement('div');
    avatarWrap.className = 'activity-avatar-wrap';

    const avatar = doc.createElement('img');
    avatar.className = 'post-avatar activity-avatar';
    avatar.src = actor.avatar_url || actor.avatar || DEFAULT_AVATAR_DATA_URI;
    avatar.alt = actor.name || actor.handle || 'Account';
    if (!group.isSyntheticOnly && (actor.id || actor.handle)) {
      avatar.addEventListener('click', () => onSelectAuthor?.(actor, primaryItem));
    }

    const badge = doc.createElement('span');
    badge.className = `activity-kind-badge activity-kind-badge--${group.kind}`;
    badge.setAttribute('aria-hidden', 'true');
    badge.innerHTML = BADGE_ICONS[group.kind] || BADGE_ICONS.mention;
    avatarWrap.append(avatar, badge);

    // 2. Center content column
    const mainCol = doc.createElement('div');
    mainCol.className = 'activity-main-col';

    const headline = doc.createElement('div');
    headline.className = 'activity-headline';

    if (group.isSyntheticOnly) {
      const synSpan = doc.createElement('span');
      synSpan.className = 'activity-synthetic-actor';
      synSpan.textContent = actor.name || `${group.totalActorCount} people on Threads`;
      headline.appendChild(synSpan);
    } else {
      const actorBtn = doc.createElement('button');
      actorBtn.type = 'button';
      actorBtn.className = 'activity-actor-btn';
      actorBtn.textContent = actor.name || actor.handle || 'User';
      actorBtn.addEventListener('click', () => {
        if (actor.id || actor.handle) onSelectAuthor?.(actor, primaryItem);
      });
      headline.appendChild(actorBtn);

      if (group.totalActorCount > 1 && (group.kind === 'like' || group.kind === 'repost')) {
        const othersSpan = doc.createElement('span');
        othersSpan.className = 'activity-others-label';
        const extra = group.totalActorCount - 1;
        othersSpan.textContent = `and ${extra} ${extra === 1 ? 'other' : 'others'}`;
        headline.appendChild(othersSpan);
      } else if (group.kind !== 'like' && group.kind !== 'repost') {
        const verbSpan = doc.createElement('span');
        verbSpan.className = 'activity-verb-label';
        verbSpan.textContent = VERB_LABELS[group.kind] || group.kind;
        headline.appendChild(verbSpan);
      }
    }

    const relTime = formatRelativeShort(group.latestDate);
    if (relTime) {
      const timeEl = doc.createElement('time');
      timeEl.className = 'activity-time';
      if (group.latestDate) timeEl.setAttribute('datetime', group.latestDate);
      timeEl.textContent = relTime;
      headline.appendChild(timeEl);
    }

    const protoList = doc.createElement('span');
    protoList.className = 'activity-proto-pills';
    for (const proto of group.protocols) {
      const pBadge = doc.createElement('span');
      pBadge.className = `post-protocol-badge post-protocol-badge--${proto}`;
      pBadge.textContent = PROTO_DISPLAY[proto] || proto;
      protoList.appendChild(pBadge);
    }
    headline.appendChild(protoList);
    mainCol.appendChild(headline);

    const openThread = () => {
      if (targetItem && group.kind !== 'follow') {
        onOpenPostThread?.(targetItem);
      }
    };

    if (group.kind !== 'follow' && (group.snippetText || group.thumbUrl)) {
      const snippet = doc.createElement('div');
      snippet.className = 'activity-snippet post-body-html';
      snippet.setAttribute('role', 'button');
      snippet.setAttribute('tabindex', '0');
      snippet.textContent = group.snippetText || '[Media attachment]';
      snippet.addEventListener('click', openThread);
      snippet.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openThread();
        }
      });
      mainCol.appendChild(snippet);
    }

    const subFooter = doc.createElement('div');
    subFooter.className = 'activity-subfooter';

    if (group.kind !== 'follow' && (group.postMetrics.likes + group.postMetrics.reposts + group.postMetrics.replies > 0 || group.metricsBreakdown)) {
      const metricsRow = doc.createElement('span');
      metricsRow.className = 'activity-post-metrics';
      metricsRow.textContent = `♥ ${group.postMetrics.likes}  ↻ ${group.postMetrics.reposts}  💬 ${group.postMetrics.replies}`;
      const bdTitle = formatBreakdownTitle(group.metricsBreakdown);
      if (bdTitle) metricsRow.title = bdTitle;
      subFooter.appendChild(metricsRow);
    }

    const authState = authStore.get();
    const replyCap = getPostActionCapabilities(primaryItem, authState).reply;
    const canCommentReply = group.kind === 'reply' || group.kind === 'mention' || group.kind === 'quote';
    const canFollowBack = group.kind === 'follow'
      && Boolean(actor.id)
      && ((primaryItem.protocol === 'mastodon' && authState.isMastodonConnected)
        || (primaryItem.protocol === 'bluesky' && authState.isBlueskyConnected));

    if (canCommentReply) {
      const replyBtn = doc.createElement('button');
      replyBtn.type = 'button';
      replyBtn.className = 'btn-sleek-pill activity-inline-action-btn';
      replyBtn.textContent = 'Reply';
      replyBtn.disabled = !replyCap.enabled;
      if (!replyCap.enabled && replyCap.reason) {
        replyBtn.title = replyCap.reason;
        replyBtn.setAttribute('aria-description', replyCap.reason);
      }
      replyBtn.addEventListener('click', () => {
        if (replyBtn.disabled) return;
        prefillReply(primaryItem);
      });
      subFooter.appendChild(replyBtn);
    } else if (canFollowBack) {
      const followBtn = doc.createElement('button');
      followBtn.type = 'button';
      followBtn.className = 'btn-sleek-pill activity-follow-btn';
      followBtn.textContent = 'Follow Back';
      followBtn.addEventListener('click', async () => {
        followBtn.disabled = true;
        try {
          await toggleFollowAuthor(actor.id, false, { protocol: primaryItem.protocol });
          followBtn.textContent = 'Following';
        } catch {
          followBtn.disabled = false;
        }
      });
      subFooter.appendChild(followBtn);
    }

    if (subFooter.childNodes.length > 0) {
      mainCol.appendChild(subFooter);
    }

    // 3. Trailing optional media thumbnail + overflow action button-group popover
    const trailing = doc.createElement('div');
    trailing.className = 'activity-trailing';

    if (group.thumbUrl) {
      const thumb = doc.createElement('img');
      thumb.className = 'activity-media-thumb';
      thumb.src = group.thumbUrl;
      thumb.alt = 'Post media';
      thumb.loading = 'lazy';
      thumb.addEventListener('click', openThread);
      trailing.appendChild(thumb);
    }

    const moreWrap = doc.createElement('div');
    moreWrap.className = 'activity-more-wrap';
    const popId = `activity-actions-${popoverIdSeq++}`;

    const moreBtn = doc.createElement('button');
    moreBtn.type = 'button';
    moreBtn.className = 'post-more-btn activity-more-btn';
    moreBtn.setAttribute('aria-label', 'Notification actions');
    moreBtn.innerHTML = MORE_DOTS_SVG;

    const panel = doc.createElement('div');
    panel.id = popId;
    panel.className = 'activity-action-popover anchored-overlay';

    const closePanel = () => {
      if (nativePopover) {
        try {
          if (panel.matches?.(':popover-open')) panel.hidePopover();
        } catch {
          panel.hidePopover?.();
        }
      } else {
        panel.hidden = true;
        moreBtn.setAttribute('aria-expanded', 'false');
        if (openFallbackMenuClose === closePanel) openFallbackMenuClose = null;
      }
    };

    const addPanelBtn = (label, handler, danger = false) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `activity-action-item${danger ? ' is-danger' : ''}`;
      btn.textContent = label;
      btn.addEventListener('click', () => {
        closePanel();
        handler();
      });
      panel.appendChild(btn);
      return btn;
    };

    if (group.kind !== 'follow' && targetItem) {
      addPanelBtn('Open thread', openThread);
    }
    if (canCommentReply && replyCap.enabled) {
      addPanelBtn('Reply', () => prefillReply(primaryItem));
    }
    if (!group.isSyntheticOnly && (actor.id || actor.handle)) {
      addPanelBtn('View profile', () => onSelectAuthor?.(actor, primaryItem));
    }
    if (!group.isSyntheticOnly && (actor.id || actor.handle)) {
      const sep = doc.createElement('hr');
      sep.className = 'post-context-sep';
      panel.appendChild(sep);
      if (group.kind === 'reply' || group.kind === 'mention') {
        addPanelBtn('Hide comment', () => {
          void (async () => {
            const res = await hideReplyUnified(primaryItem);
            await dismissActivityGroup(group);
            if (res?.warnings?.length > 0) {
              showAlert('Comment Hidden Locally', res.warnings.join('\n\n'));
            }
          })();
        }, true);
      }
      if (group.actors.length <= 1) {
        const cleanH = String(actor.handle || '').replace(/^@/, '');
        const proto = String(primaryItem?.protocol || actor.protocol || 'mastodon').toLowerCase();
        const displayTarget = cleanH ? `@${cleanH}` : (actor.name || 'account');
        addPanelBtn(`Mute ${displayTarget}`, () => {
          showConfirm('Mute Account', `Mute ${displayTarget}?`, async () => {
            try {
              await toggleMuteAuthor(actor.id || cleanH, false, {
                protocol: proto,
                acct: cleanH,
                displayName: actor.name || cleanH,
                instanceUrl: primaryItem?._meta?.mastodon?.instanceUrl || '',
              });
              removeActivityByActor(actor, proto);
              removePostAcrossStreams((it) => it?.author?.handle === actor.handle || (actor.id && it?.author?.id === actor.id));
            } catch (err) {
              showAlert('Moderation Error', err?.message || 'Unable to mute account.');
            }
          });
        });
        addPanelBtn(`Block ${displayTarget}`, () => {
          const replyPid = proto === 'threads' && group.kind === 'reply' ? (primaryItem?._meta?.threads?.postId || '') : '';
          const hideNote = replyPid ? ' and hide their comment on Threads' : '';
          showConfirm('Block Account', `Block ${displayTarget}${hideNote}?`, async () => {
            try {
              const res = await toggleBlockAuthor(actor.id || cleanH, false, {
                protocol: proto,
                acct: cleanH,
                displayName: actor.name || cleanH,
                instanceUrl: primaryItem?._meta?.mastodon?.instanceUrl || '',
                replyPostId: replyPid,
              });
              removeActivityByActor(actor, proto);
              await dismissActivityGroup(group);
              removePostAcrossStreams((it) => it?.author?.handle === actor.handle || (actor.id && it?.author?.id === actor.id));
              if (res?.warnings?.length > 0) {
                showAlert('Block Warning', res.warnings.join('\n\n'));
              }
            } catch (err) {
              showAlert('Moderation Error', err?.message || 'Unable to block account.');
            }
          });
        }, true);
      }
    }
    addPanelBtn(
      group.notificationIds.length > 1 ? `Delete notifications (${group.notificationIds.length})` : 'Delete notification',
      () => void dismissActivityGroup(group),
      true
    );

    if (nativePopover) {
      moreBtn.setAttribute('popovertarget', popId);
      panel.setAttribute('popover', 'auto');
      if (!nativeAnchor) {
        panel.addEventListener('toggle', (ev) => {
          if (ev.newState === 'open') {
            positionPopoverNearTrigger(panel, moreBtn);
          }
        });
      }
    } else {
      panel.hidden = true;
      moreBtn.setAttribute('aria-expanded', 'false');
      moreBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = panel.hidden;
        closeFallbackMenus();
        panel.hidden = !willOpen;
        moreBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
        if (willOpen) openFallbackMenuClose = closePanel;
      });
    }

    moreWrap.append(moreBtn, panel);
    trailing.appendChild(moreWrap);
    row.append(avatarWrap, mainCol, trailing);
    return row;
  }

  async function loadNotifications() {
    if (destroyed) return;
    const [fedi, bsky, thr] = await Promise.all([
      getAuthenticatedAccount('fediverse'),
      getAuthenticatedAccount('bluesky'),
      getAuthenticatedAccount('threads'),
    ]);
    if (destroyed) return;
    if (!fedi && !bsky && !thr && (authStore.get().accounts || []).length === 0) {
      renderFromStore();
      return;
    }
    await refreshActivityNotifications({ limit: 40, markSeen: true, background: false }).catch(() => {});
  }

  refreshBtn.addEventListener('click', () => void loadNotifications());
  clearAllBtn.addEventListener('click', () => void clearAllActivity());

  const unsubActivity = activityStore.subscribe(() => renderFromStore());

  const buildAuthSig = (s) =>
    `${Boolean(s?.hydrated)}:${s?.activeFediverseId || ''}:${s?.activeBlueskyId || ''}:${s?.activeThreadsId || ''}:${(s?.accounts || []).map((a) => a.id).join(',')}`;
  let prevAuthSig = buildAuthSig(authStore.get());
  const unsubAuth = authStore.subscribe((authState) => {
    if (destroyed) return;
    const sig = buildAuthSig(authState);
    if (sig !== prevAuthSig) {
      prevAuthSig = sig;
      renderFromStore();
      void loadNotifications();
    }
  });

  renderFromStore();
  void loadNotifications();

  return {
    refresh: loadNotifications,
    destroy() {
      destroyed = true;
      closeFallbackMenus();
      doc.removeEventListener?.('click', handleDocClickOutside);
      unsubActivity();
      unsubAuth();
    },
  };
}
