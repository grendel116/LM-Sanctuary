import { createPostCard, getPostActionCapabilities } from '../components/PostCard.js';
import { showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { canonicalizeActorHandle, toUnifiedItem } from '../core/schema/unifiedItem.js';
import {
  deleteUnified,
  fetchPostThread,
  hideReplyUnified,
  likeUnified,
  pinUnified,
  replyUnified,
  repostUnified,
  runBridgeRetry,
  toggleBlockAuthor,
  toggleMuteAuthor,
} from '../queries/socialClient.js';
import { removeActivityByActor } from '../state/activityStore.js';
import { authStore } from '../state/authStore.js';
import { prefillReply } from '../state/composeStore.js';
import { mutatePostAcrossStreams, recordAuthorInteraction, removePostAcrossStreams, applyPostInterestFeedback } from '../state/feedStore.js';
import { openEditPostDialog } from './profile.js';

function pickReplyAvatar(authState, protocol) {
  const accounts = authState?.accounts || [];
  const targetPlatform = protocol === 'bluesky'
    ? 'bluesky'
    : protocol === 'threads'
      ? 'threads'
      : 'fediverse';
  const exact = accounts.find((a) => a.platform === targetPlatform && a.avatar);
  if (exact?.avatar) return exact.avatar;
  const anyAvatar = accounts.find((a) => a.avatar);
  return anyAvatar?.avatar || DEFAULT_AVATAR_DATA_URI;
}

/**
 * Unified context thread view (Mastodon & Bluesky) showing ancestors, focal post,
 * an inline reply box, and interactive replies (each independently replyable/navigable).
 */
export function renderPostThreadView(containerEl, {
  post,
  onBack,
  onAskSanctuary,
  onSelectAuthor,
  showSanctuaryAction = false,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let currentFocal = toUnifiedItem(post);
  const initialFocusReplyId = String(post?._meta?.focusReplyId || '');
  const normFocusReplyId = initialFocusReplyId.replace(/^threads:notif:/, 'threads:');
  let didScrollFocusReply = false;
  let ancestors = [];
  let descendants = [];
  const historyStack = [];
  let loadSeq = 0;
  let sendingReply = false;

  function isOwnThreadFocal() {
    if (currentFocal?._meta?.linkedIds) return true;
    const accounts = authStore.get()?.accounts || [];
    const fHandle = String(currentFocal?.author?.handle || '').replace(/^@/, '').toLowerCase();
    const fId = String(currentFocal?.author?.id || '');
    return accounts.some((acc) => {
      const ah = String(acc.acct || acc.handle || '').replace(/^@/, '').toLowerCase();
      return (ah && fHandle && ah === fHandle) || (acc.userId && fId && String(acc.userId) === fId);
    });
  }

  function purgeAuthorFromThread(u) {
    const proto = String(u?.protocol || 'mastodon').toLowerCase();
    const handle = String(u?.author?.handle || '').trim().replace(/^@/, '').toLowerCase();
    const aid = String(u?.author?.id || '').trim().toLowerCase();
    const canon = handle ? canonicalizeActorHandle(handle, proto) : '';
    const matchesItem = (item) => {
      const ih = String(item?.author?.handle || '').trim().replace(/^@/, '').toLowerCase();
      const iid = String(item?.author?.id || '').trim().toLowerCase();
      const ic = ih ? canonicalizeActorHandle(ih, item?.protocol || proto) : '';
      return Boolean((canon && ic === canon) || (handle && ih === handle) || (aid && iid === aid));
    };
    descendants = descendants.filter((d) => !matchesItem(d.item));
    ancestors = ancestors.filter((a) => !matchesItem(a));
    renderSections();
    removePostAcrossStreams(matchesItem);
    removeActivityByActor(u?.author, proto);
  }

  const wrap = doc.createElement('section');
  wrap.className = 'post-thread-view';

  const topBar = doc.createElement('div');
  topBar.className = 'stage-header thread-stage-header';

  const backBtn = doc.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'edit-btn edit-cancel-btn';
  backBtn.textContent = '← Back';
  backBtn.addEventListener('click', () => {
    if (historyStack.length > 0) {
      currentFocal = historyStack.pop();
      ancestors = [];
      descendants = [];
      renderSections();
      void loadThreadContext();
      return;
    }
    onBack?.();
  });

  const h1 = doc.createElement('h1');
  h1.className = 'stage-title';
  h1.textContent = 'Thread';
  topBar.append(backBtn, h1);

  const ancestorsEl = doc.createElement('div');
  ancestorsEl.className = 'thread-ancestors';

  const focalEl = doc.createElement('div');
  focalEl.className = 'thread-focal';

  const replyForm = doc.createElement('form');
  replyForm.className = 'inline-compose-row thread-inline-reply-form';

  const replyAvatar = doc.createElement('img');
  replyAvatar.className = 'post-avatar inline-compose-avatar';
  replyAvatar.alt = 'Your avatar';

  const replyInput = doc.createElement('input');
  replyInput.type = 'text';
  replyInput.className = 'inline-compose-input';
  replyInput.setAttribute('aria-label', 'Reply to post');

  const replyBtn = doc.createElement('button');
  replyBtn.type = 'submit';
  replyBtn.className = 'btn-sleek-pill inline-compose-submit';
  replyBtn.textContent = 'Reply';

  replyForm.append(replyAvatar, replyInput, replyBtn);

  const replyStatus = doc.createElement('p');
  replyStatus.className = 'classic-modal-status inline-compose-status';
  replyStatus.setAttribute('role', 'status');
  replyStatus.setAttribute('aria-live', 'polite');
  replyStatus.hidden = true;

  const repliesHeadingEl = doc.createElement('div');
  repliesHeadingEl.className = 'search-section-title thread-replies-heading';
  repliesHeadingEl.hidden = true;

  const statusEl = doc.createElement('div');
  statusEl.className = 'thread-loading-status';

  const descendantsEl = doc.createElement('div');
  descendantsEl.className = 'thread-descendants';

  wrap.append(
    topBar,
    ancestorsEl,
    focalEl,
    replyForm,
    replyStatus,
    repliesHeadingEl,
    statusEl,
    descendantsEl
  );
  containerEl.appendChild(wrap);

  function applyUpdatedItem(updated) {
    const unifiedUpdated = toUnifiedItem(updated);
    const id = unifiedUpdated.id;
    if (currentFocal.id === id) currentFocal = unifiedUpdated;
    ancestors = ancestors.map((a) => (a.id === id ? unifiedUpdated : a));
    descendants = descendants.map((d) => (d.item.id === id ? { ...d, item: unifiedUpdated } : d));
    renderSections();
  }

  function makeCardOpts({ isFocal = false } = {}) {
    return {
      onReply: (p) => prefillReply(p),
      onToggleLike: async (p) => {
        const wasLiked = Boolean(p?._meta?.mastodon?.favourited || p?._meta?.bluesky?.likeUri);
        const updated = await likeUnified(p);
        if (!updated || destroyed) return;
        if (!wasLiked) {
          void recordAuthorInteraction(p, p?.protocol, 1);
        }
        applyUpdatedItem(updated);
        mutatePostAcrossStreams(p.id || p.key, () => updated);
      },
      onToggleRepost: async (p) => {
        const updated = await repostUnified(p);
        if (!updated || destroyed) return;
        applyUpdatedItem(updated);
        mutatePostAcrossStreams(p.id || p.key, () => updated);
      },
      disableCardOpenThread: isFocal,
      onOpenThread: (p) => {
        const next = toUnifiedItem(p);
        if (!next?.id || next.id === currentFocal.id) return;
        historyStack.push(currentFocal);
        currentFocal = next;
        ancestors = [];
        descendants = [];
        replyStatus.hidden = true;
        replyStatus.textContent = '';
        renderSections();
        void loadThreadContext();
      },
      onSelectAuthor,
      onAskSanctuary: onAskSanctuary
        ? (p) => {
            void recordAuthorInteraction(p, p?.protocol, 1.5);
            onAskSanctuary(p);
          }
        : undefined,
      onEditPost: (authStore.get().isMastodonConnected || authStore.get().isBlueskyConnected) ? (p) => {
        const authNow = authStore.get();
        const canEdit = (p?.protocol === 'mastodon' && authNow.isMastodonConnected)
          || (p?.protocol === 'bluesky' && authNow.isBlueskyConnected);
        if (!canEdit) return;
        openEditPostDialog(p, {
          onSaved: (updated) => {
            if (!updated || destroyed) return;
            applyUpdatedItem(updated);
            mutatePostAcrossStreams((it) => it?.id === p.id || it?.key === p.key || it?.id === updated.id, () => updated);
          },
        });
      } : null,
      onTogglePin: authStore.get().isMastodonConnected ? async (p) => {
        if (p?.protocol !== 'mastodon') return;
        const updated = await pinUnified(p, Boolean(p._meta?.mastodon?.pinned));
        if (!updated || destroyed) return;
        applyUpdatedItem(updated);
        mutatePostAcrossStreams(p.id || p.key, () => updated);
      } : null,
      onRetryBridge: (retryEntry) => {
        void runBridgeRetry(retryEntry.id)
          .then(() => loadThreadContext({ silent: true }))
          .catch((err) => showAlert('Bridge Retry Failed', err?.message || 'Retry failed.'));
      },
      onHideReply: !isFocal && isOwnThreadFocal() ? (_raw, u) => {
        void (async () => {
          const res = await hideReplyUnified(u, { rootItem: currentFocal });
          if (destroyed) return;
          descendants = descendants.filter((d) => d.item.id !== u.id);
          if (currentFocal?.metrics) {
            currentFocal = {
              ...currentFocal,
              metrics: { ...currentFocal.metrics, replies: Math.max(0, Number(currentFocal.metrics.replies || 0) - 1) },
            };
          }
          renderSections();
          if (res?.warnings?.length > 0) {
            showAlert('Comment Hidden Locally', res.warnings.join('\n\n'));
          }
        })();
      } : null,
      onInterested: async (p) => {
        const updated = await applyPostInterestFeedback(p, 'interested');
        if (updated && !destroyed) applyUpdatedItem(updated);
      },
      onNotInterested: async (p) => {
        await applyPostInterestFeedback(p, 'not_interested');
        if (destroyed || isFocal) return;
        const targetId = toUnifiedItem(p).id;
        descendants = descendants.filter((d) => d.item.id !== targetId);
        ancestors = ancestors.filter((a) => a.id !== targetId);
        renderSections();
      },
      onMuteAuthor: (_raw, u) => {
        const cleanH = String(u?.author?.handle || '').replace(/^@/, '');
        if (!u?.author?.id && !cleanH) return;
        showConfirm('Mute Account', `Mute @${cleanH || u.author.id}?`, async () => {
          try {
            await toggleMuteAuthor(u.author.id || cleanH, false, {
              protocol: u.protocol,
              acct: cleanH,
              displayName: u.author.name || cleanH,
              instanceUrl: u._meta?.mastodon?.instanceUrl || '',
            });
            if (!destroyed) purgeAuthorFromThread(u);
          } catch (err) {
            showAlert('Moderation Error', err?.message || 'Unable to mute account.');
          }
        });
      },
      onBlockAuthor: (_raw, u) => {
        const cleanH = String(u?.author?.handle || '').replace(/^@/, '');
        if (!u?.author?.id && !cleanH) return;
        const ownThread = isOwnThreadFocal() || Boolean(u?._meta?.onOwnThread);
        const hideNote = ownThread && u.protocol === 'threads' ? ' and hide their comment on Threads' : '';
        showConfirm('Block Account', `Block @${cleanH || u.author.id}${hideNote}?`, async () => {
          try {
            const res = await toggleBlockAuthor(u.author.id || cleanH, false, {
              protocol: u.protocol,
              acct: cleanH,
              displayName: u.author.name || cleanH,
              instanceUrl: u._meta?.mastodon?.instanceUrl || '',
              replyPostId: ownThread && u.protocol === 'threads' ? (u._meta?.threads?.postId || '') : '',
            });
            if (!destroyed) purgeAuthorFromThread(u);
            if (res?.warnings?.length > 0) {
              showAlert('Block Warning', res.warnings.join('\n\n'));
            }
          } catch (err) {
            showAlert('Moderation Error', err?.message || 'Unable to block account.');
          }
        });
      },
      onDeletePost: (p) => {
        showConfirm(
          'Delete Post',
          p?._meta?.linkedIds?.blueskyUri || p?._meta?.linkedIds?.threadsPostId
            ? 'Delete this post from Mastodon and all linked bridges?'
            : 'Delete this post?',
          async () => {
            const res = await deleteUnified(p);
            removePostAcrossStreams(p.id || p.key);
            if (res?.warnings?.length > 0) {
              showAlert('Bridge Delete Warning', res.warnings.join('\n\n'));
            }
            if (destroyed) return;
            if (p.id === currentFocal.id || toUnifiedItem(p).id === currentFocal.id) {
              if (historyStack.length > 0) {
                currentFocal = historyStack.pop();
                ancestors = [];
                descendants = [];
                renderSections();
                void loadThreadContext();
              } else {
                onBack?.();
              }
            } else {
              descendants = descendants.filter((d) => d.item.id !== toUnifiedItem(p).id);
              ancestors = ancestors.filter((a) => a.id !== toUnifiedItem(p).id);
              renderSections();
            }
          }
        );
      },
      showSanctuaryAction,
    };
  }

  function renderSections() {
    if (destroyed) return;
    const authState = authStore.get();
    const replyCap = getPostActionCapabilities(currentFocal, authState).reply;
    replyAvatar.src = pickReplyAvatar(authState, currentFocal.protocol);
    const authorHandle = String(currentFocal.author?.handle || '').replace(/^@/, '');
    if (!replyCap.enabled) {
      replyInput.disabled = true;
      replyBtn.disabled = true;
      replyInput.placeholder = replyCap.reason || 'Replies unavailable for this post.';
      replyBtn.title = replyCap.reason || 'Replies unavailable for this post.';
    } else if (!sendingReply) {
      replyInput.disabled = false;
      replyBtn.disabled = false;
      replyInput.placeholder = authorHandle ? `Reply to @${authorHandle}...` : 'Write a reply...';
      replyBtn.title = '';
    }

    ancestorsEl.replaceChildren(
      ...ancestors.map((a) => {
        const itemWrap = doc.createElement('div');
        itemWrap.className = 'thread-ancestor-item';
        itemWrap.appendChild(createPostCard(toUnifiedItem(a), makeCardOpts({ isFocal: false })));
        return itemWrap;
      })
    );

    focalEl.replaceChildren(createPostCard(currentFocal, makeCardOpts({ isFocal: true })));

    repliesHeadingEl.hidden = descendants.length === 0;
    repliesHeadingEl.textContent = descendants.length > 0 ? `Replies (${descendants.length})` : '';

    descendantsEl.replaceChildren(
      ...descendants.map((entry) => {
        const itemWrap = doc.createElement('div');
        const entryId = String(entry?.item?.id || '');
        const normEntryId = entryId.replace(/^threads:notif:/, 'threads:');
        const isHighlighted = Boolean(
          initialFocusReplyId && (entryId === initialFocusReplyId || normEntryId === normFocusReplyId)
        );
        itemWrap.className = `thread-reply-item${isHighlighted ? ' is-highlighted-reply' : ''}`;
        itemWrap.dataset.depth = String(Math.max(0, Math.min(Number(entry.depth || 0), 3)));
        itemWrap.appendChild(createPostCard(toUnifiedItem(entry.item), makeCardOpts({ isFocal: false })));
        if (isHighlighted && !didScrollFocusReply) {
          didScrollFocusReply = true;
          setTimeout(() => itemWrap.scrollIntoView?.({ block: 'nearest' }), 0);
        }
        return itemWrap;
      })
    );
  }

  async function loadThreadContext({ silent = false } = {}) {
    const seq = ++loadSeq;
    const canFetch =
      currentFocal.protocol === 'bluesky'
        ? Boolean(currentFocal._meta?.bluesky?.uri || currentFocal.id.replace(/^bluesky:/, ''))
        : currentFocal.protocol === 'threads'
          ? Boolean(currentFocal._meta?.threads?.postId || currentFocal.id.replace(/^threads:(?:notif:)?/, ''))
          : currentFocal.protocol === 'mastodon'
            ? Boolean(currentFocal._meta?.mastodon?.statusId || currentFocal.id.replace(/^mastodon:/, ''))
            : false;

    if (!canFetch) {
      statusEl.replaceChildren();
      return;
    }

    if (!silent && descendants.length === 0) {
      statusEl.replaceChildren(createLoadingState('Loading replies…', { doc, size: 'compact' }));
    }

    try {
      const ctx = await fetchPostThread(currentFocal);
      if (destroyed || seq !== loadSeq) return;
      if (ctx?.focal) currentFocal = ctx.focal;
      ancestors = Array.isArray(ctx?.ancestors) ? ctx.ancestors : [];
      descendants = Array.isArray(ctx?.descendants) ? ctx.descendants : [];
      statusEl.replaceChildren();
      if (descendants.length === 0) {
        statusEl.textContent = 'No replies yet.';
      }
      renderSections();
    } catch (err) {
      if (destroyed || seq !== loadSeq) return;
      statusEl.replaceChildren();
      if (descendants.length === 0) {
        statusEl.textContent = err?.message || 'Unable to load replies.';
      }
    }
  }

  replyForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!getPostActionCapabilities(currentFocal).reply.enabled) return;
    const draft = replyInput.value.trim();
    if (!draft) {
      prefillReply(currentFocal);
      return;
    }
    sendingReply = true;
    replyBtn.disabled = true;
    replyInput.disabled = true;
    replyStatus.hidden = false;
    replyStatus.textContent = 'Sending reply...';
    try {
      const replied = await replyUnified({
        targetItem: currentFocal,
        text: draft,
        visibility: currentFocal._meta?.mastodon?.visibility || 'public',
      });
      if (destroyed) return;
      void recordAuthorInteraction(currentFocal, currentFocal?.protocol, 2);
      replyInput.value = '';
      replyStatus.hidden = true;
      replyStatus.textContent = '';
      currentFocal = {
        ...currentFocal,
        metrics: {
          ...(currentFocal.metrics || {}),
          replies: Number(currentFocal.metrics?.replies ?? 0) + 1,
        },
        _meta: {
          ...(currentFocal._meta || {}),
          viewerReplied: true,
          ...(currentFocal.protocol === 'mastodon' || currentFocal._meta?.mastodon
            ? { mastodon: { ...(currentFocal._meta?.mastodon || {}), replied: true } }
            : {}),
          ...(currentFocal.protocol === 'bluesky' || currentFocal._meta?.bluesky
            ? { bluesky: { ...(currentFocal._meta?.bluesky || {}), replied: true } }
            : {}),
        },
      };
      mutatePostAcrossStreams(currentFocal.id || currentFocal.key, () => currentFocal);
      if (replied) {
        const unifiedReply = toUnifiedItem(replied);
        if (!descendants.some((d) => d.item.id === unifiedReply.id)) {
          descendants = [...descendants, { item: unifiedReply, depth: 0 }];
        }
      }
      statusEl.replaceChildren();
      renderSections();
      void loadThreadContext({ silent: true });
    } catch (err) {
      if (!destroyed) {
        replyStatus.hidden = false;
        replyStatus.textContent = err?.message || 'Unable to send reply.';
      }
    } finally {
      sendingReply = false;
      if (!destroyed) {
        const canStillReply = getPostActionCapabilities(currentFocal).reply.enabled;
        replyBtn.disabled = !canStillReply;
        replyInput.disabled = !canStillReply;
      }
    }
  });

  const unsubAuth = authStore.subscribe(() => {
    if (!destroyed) renderSections();
  });

  renderSections();
  void loadThreadContext();

  return {
    refresh: () => loadThreadContext({ silent: true }),
    destroy() {
      destroyed = true;
      loadSeq += 1;
      unsubAuth();
    },
  };
}
