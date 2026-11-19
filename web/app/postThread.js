import { createPostCard } from '../components/PostCard.js';
import { showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { toUnifiedItem } from '../core/schema/unifiedItem.js';
import {
  deleteUnified,
  fetchPostThread,
  likeUnified,
  replyUnified,
  repostUnified,
} from '../queries/socialClient.js';
import { authStore } from '../state/authStore.js';
import { prefillReply } from '../state/composeStore.js';
import { mutatePostAcrossStreams, removePostAcrossStreams } from '../state/feedStore.js';

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
  let ancestors = [];
  let descendants = [];
  const historyStack = [];
  let loadSeq = 0;

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
        const updated = await likeUnified(p);
        if (!updated || destroyed) return;
        applyUpdatedItem(updated);
        mutatePostAcrossStreams(p.id || p.key, () => updated);
      },
      onToggleRepost: async (p) => {
        const updated = await repostUnified(p);
        if (!updated || destroyed) return;
        applyUpdatedItem(updated);
        mutatePostAcrossStreams(p.id || p.key, () => updated);
      },
      onOpenThread: isFocal
        ? null
        : (p) => {
            historyStack.push(currentFocal);
            currentFocal = toUnifiedItem(p);
            ancestors = [];
            descendants = [];
            replyStatus.hidden = true;
            replyStatus.textContent = '';
            renderSections();
            void loadThreadContext();
          },
      onSelectAuthor,
      onAskSanctuary,
      onDeletePost: (p) => {
        showConfirm('Delete Post', 'Delete this post?', async () => {
          await deleteUnified(p);
          removePostAcrossStreams(p.id || p.key);
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
        });
      },
      showSanctuaryAction,
    };
  }

  function renderSections() {
    if (destroyed) return;
    const authState = authStore.get();
    replyAvatar.src = pickReplyAvatar(authState, currentFocal.protocol);
    const authorHandle = String(currentFocal.author?.handle || '').replace(/^@/, '');
    replyInput.placeholder = authorHandle ? `Reply to @${authorHandle}...` : 'Write a reply...';

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
        itemWrap.className = 'thread-reply-item';
        itemWrap.dataset.depth = String(Math.max(0, Math.min(Number(entry.depth || 0), 3)));
        itemWrap.appendChild(createPostCard(toUnifiedItem(entry.item), makeCardOpts({ isFocal: false })));
        return itemWrap;
      })
    );
  }

  async function loadThreadContext({ silent = false } = {}) {
    const seq = ++loadSeq;
    const canFetch =
      currentFocal.protocol === 'bluesky'
        ? Boolean(currentFocal._meta?.bluesky?.uri || currentFocal.id.replace(/^bluesky:/, ''))
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
    const draft = replyInput.value.trim();
    if (!draft) {
      prefillReply(currentFocal);
      return;
    }
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
      replyInput.value = '';
      replyStatus.hidden = true;
      replyStatus.textContent = '';
      currentFocal = {
        ...currentFocal,
        metrics: {
          ...(currentFocal.metrics || {}),
          replies: Number(currentFocal.metrics?.replies ?? 0) + 1,
        },
      };
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
      if (!destroyed) {
        replyBtn.disabled = false;
        replyInput.disabled = false;
      }
    }
  });

  renderSections();
  void loadThreadContext();

  return {
    refresh: () => loadThreadContext({ silent: true }),
    destroy() {
      destroyed = true;
      loadSeq += 1;
    },
  };
}
