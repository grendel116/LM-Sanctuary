import { createOfflineNotice } from '../components/OfflineNotice.js';
import { createPostCard, syncPostCardReactions } from '../components/PostCard.js';
import { attachPullToRefresh } from '../components/PullToRefresh.js';
import { createClassicModalDialog, showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { rankFeedItems } from '../core/feedRanker.js';
import { applyKeywordFilters } from '../core/schema/unifiedItem.js';
import {
  getBskyCustomFeed,
  getBskyTimeline,
} from '../queries/bluesky.js';
import {
  getTimeline,
  getTrendingStatuses,
  toggleBookmark,
} from '../queries/fediverse.js';
import {
  addAccountToMastodonList,
  createMastodonList,
  deleteMastodonList,
  deleteUnified,
  dismissBridgeRetry,
  enrichUnifiedItemsMetrics,
  fetchKeywordFilters,
  fetchListAccounts,
  fetchLists,
  fetchSemanticFeedScores,
  likeUnified,
  pinUnified,
  removeAccountFromMastodonList,
  repostUnified,
  runBridgeRetry,
  searchAccountsAndPosts,
  toggleBlockAuthor,
  toggleFollowAuthor,
  toggleMuteAuthor,
} from '../queries/socialClient.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens } from '../state/authStore.js';
import { openCompose, prefillReply } from '../state/composeStore.js';
import {
  appendStreamItems,
  feedStore,
  hydrateCachedFilters,
  hydrateCachedModeration,
  hydrateCachedStream,
  hydrateFeedTuning,
  mergeChronologicalPosts,
  mutatePostAcrossStreams,
  persistStreamCache,
  recordAuthorInteraction,
  removePostAcrossStreams,
  setActiveStream,
  setSemanticScores,
  setStreamItems,
  setStreamLoading,
  setUserLists,
} from '../state/feedStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';
import { publishOrganicPost } from './composeModal.js';
import { openEditPostDialog } from './profile.js';

const DEFAULT_PUBLIC_INSTANCE = 'https://mastodon.social';
const BSKY_WHATS_HOT_FEED = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
const INFINITE_SCROLL_THRESHOLD_PX = 480;
const FEED_REFRESH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><path d="M21 3v5h-5"></path></svg>`;

const STREAM_TABS = [
  ['feed', 'Feed'],
  ['following', 'Following'],
];
const ALLOWED_STREAMS = new Set(STREAM_TABS.map(([id]) => id));

function hasAnySocialAccount(authState) {
  return (authState?.accounts || []).some((a) => a.platform === 'fediverse' || a.platform === 'bluesky');
}

function getSocialIdsSig(authState) {
  return (authState?.accounts || [])
    .filter((a) => a.platform === 'fediverse' || a.platform === 'mastodon' || a.platform === 'bluesky')
    .map((a) => `${a.platform}:${a.id}`)
    .sort()
    .join('|');
}

function getAccountsUiSig(authState) {
  return (authState?.accounts || [])
    .map((a) => `${a.id}:${a.avatar || ''}`)
    .join('|');
}

function getRetrySig(authState) {
  return (authState?.retryQueue || [])
    .map((r) => `${r.id}:${r.lastError || ''}`)
    .join('|');
}

function computePostStructureSig(post, showSanctuary, hasMasto, hasBsky = false) {
  const key = String(post?.id || post?.key || '');
  const m = post?._meta?.mastodon || {};
  const b = post?._meta?.bluesky || {};
  const linked = post?._meta?.linkedIds || {};
  const attUrls = Array.isArray(post?.attachments) ? post.attachments.map((a) => a?.url || '').join(',') : '';
  const quoteKey = post?._meta?.quotePost?.id || post?._meta?.quotePost?.url || (post?._meta?.quotePost?.unavailable ? 'unavail' : '');
  return [
    key,
    post?.content_html || post?.content_text || '',
    m.spoilerText || post?.spoilerText || '',
    post?._meta?.linkCard?.url || post?.linkCard?.url || '',
    attUrls,
    quoteKey,
    Boolean(m.pinned),
    linked.blueskyUri || '',
    linked.threadsPostId || '',
    m.rebloggedBy?.handle || b.rebloggedBy?.handle || '',
    Boolean(showSanctuary),
    Boolean(hasMasto),
    Boolean(hasBsky),
  ].join('\u001f');
}

function computePostReactionSig(post) {
  const m = post?._meta?.mastodon || {};
  const b = post?._meta?.bluesky || {};
  const metrics = post?.metrics || {};
  return [
    metrics.likes ?? 0,
    metrics.replies ?? 0,
    metrics.reposts ?? 0,
    Boolean(m.favourited || b.likeUri || post?.viewerState?.favourited),
    Boolean(m.reblogged || b.repostUri || post?.viewerState?.reblogged),
    Boolean(m.bookmarked || post?.viewerState?.bookmarked),
    JSON.stringify(post?._meta?.metricsBreakdown || null),
  ].join('\u001f');
}

function computeTuningSig(tuning) {
  const t = tuning || {};
  return JSON.stringify([t.sliders || {}, t.boostConcepts || [], t.dampenConcepts || []]);
}

function buildOptimisticReactionPost(cur, kind, nextActive) {
  const proto = cur?.protocol || 'mastodon';
  const delta = nextActive ? 1 : -1;
  const metricKey = kind === 'like' ? 'likes' : (kind === 'repost' ? 'reposts' : '');
  const nextMetrics = { ...(cur?.metrics || { replies: 0, reposts: 0, likes: 0 }) };
  if (metricKey) {
    nextMetrics[metricKey] = Math.max(0, Number(nextMetrics[metricKey] || 0) + delta);
  }
  const nextMeta = { ...(cur?._meta || {}) };
  if (proto === 'bluesky') {
    const prevBsky = cur?._meta?.bluesky || {};
    nextMeta.bluesky = {
      ...prevBsky,
      ...(kind === 'like' ? { likeUri: nextActive ? (prevBsky.likeUri || 'optimistic:like') : null } : {}),
      ...(kind === 'repost' ? { repostUri: nextActive ? (prevBsky.repostUri || 'optimistic:repost') : null } : {}),
    };
  } else {
    const prevProtoMeta = cur?._meta?.[proto] || {};
    nextMeta[proto] = {
      ...prevProtoMeta,
      ...(kind === 'like' ? { favourited: nextActive } : {}),
      ...(kind === 'repost' ? { reblogged: nextActive } : {}),
      ...(kind === 'bookmark' ? { bookmarked: nextActive } : {}),
    };
  }
  if (metricKey && cur?._meta?.metricsBreakdown?.[proto] && typeof cur._meta.metricsBreakdown[proto] === 'object') {
    const prevProtoBd = cur._meta.metricsBreakdown[proto];
    nextMeta.metricsBreakdown = {
      ...cur._meta.metricsBreakdown,
      [proto]: {
        ...prevProtoBd,
        [metricKey]: Math.max(0, Number(prevProtoBd[metricKey] || 0) + delta),
      },
    };
  }
  return {
    ...cur,
    metrics: nextMetrics,
    _meta: nextMeta,
  };
}

function scheduleMetricsEnrichment(items, isStale) {
  if (!Array.isArray(items) || items.length === 0) return;
  void enrichUnifiedItemsMetrics(items).then((enriched) => {
    if (isStale?.() || !Array.isArray(enriched)) return;
    for (let i = 0; i < enriched.length; i += 1) {
      const next = enriched[i];
      const prev = items[i];
      if (!next?.id || next === prev) continue;
      if (
        next.metrics?.likes !== prev?.metrics?.likes ||
        next.metrics?.replies !== prev?.metrics?.replies ||
        next.metrics?.reposts !== prev?.metrics?.reposts ||
        Boolean(next._meta?.metricsBreakdown) !== Boolean(prev?._meta?.metricsBreakdown)
      ) {
        mutatePostAcrossStreams(next.id, () => next);
      }
    }
  }).catch(() => {});
}

/**
 * Center column Home view: clean two-tab chronological discovery (`Feed` | `Following`)
 * combining Mastodon & Bluesky posts with infinite scroll and keyed DOM stability.
 */
export function mountFeedScreen(containerEl, {
  onOpenPostThread,
  onAskSanctuary,
  onOpenAccounts,
  onSelectAuthor,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let selectedListId = '';
  let requestEpoch = 0;
  let inFlightRefresh = false;
  let loadingOlder = false;
  let appendError = '';
  let lastListOptionsSig = '';
  let lastSemanticSig = '';
  let sentinelIntersecting = false;
  let lastAutoCursorSig = '';
  let autoCheckTimer = null;

  const cardCache = new Map();
  const streamOrders = new Map();
  const pendingReactions = new Set();
  const prefsHydrationPromise = Promise.allSettled([
    hydrateFeedTuning(),
    hydrateCachedModeration(),
    hydrateCachedFilters(),
  ]).finally(() => {
    if (!destroyed) void fetchKeywordFilters().catch(() => {});
  });

  const root = doc.createElement('section');
  root.className = 'feed-screen';

  const stageHeader = doc.createElement('div');
  stageHeader.className = 'stage-header feed-stage-header';
  const tabsRow = doc.createElement('div');
  tabsRow.className = 'stage-tabs feed-stream-tabs';

  const tabButtons = new Map();
  for (const [key, label] of STREAM_TABS) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'stage-tab-btn';
    btn.dataset.stream = key;
    btn.setAttribute('aria-pressed', 'false');
    const labelEl = doc.createElement('span');
    labelEl.className = 'stage-tab-label';
    labelEl.textContent = label;
    btn.appendChild(labelEl);
    btn.addEventListener('click', () => {
      const prevStream = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
      setActiveStream(key);
      if (key !== prevStream) {
        const bucket = feedStore.get().streams[key];
        if (!bucket || (bucket.items?.length || 0) === 0) {
          void loadStream(false);
        }
      }
    });
    tabButtons.set(key, btn);
    tabsRow.appendChild(btn);
  }

  const feedRefreshBtn = doc.createElement('button');
  feedRefreshBtn.type = 'button';
  feedRefreshBtn.className = 'feed-refresh-btn';
  feedRefreshBtn.setAttribute('aria-label', 'Refresh feed');
  feedRefreshBtn.title = 'Refresh feed';
  feedRefreshBtn.innerHTML = FEED_REFRESH_SVG;
  feedRefreshBtn.addEventListener('click', () => {
    void loadStream(false);
  });

  tabsRow.append(feedRefreshBtn);

  function syncRefreshButton() {
    if (destroyed) return;
    feedRefreshBtn.disabled = inFlightRefresh;
    feedRefreshBtn.classList.toggle('is-spinning', inFlightRefresh);
  }

  const listFilterBar = doc.createElement('div');
  listFilterBar.className = 'feed-list-filter-bar';
  listFilterBar.hidden = true;
  const listSelect = doc.createElement('select');
  listSelect.className = 'glass-select feed-list-select';
  listSelect.setAttribute('aria-label', 'Filter following by list');
  const manageListsBtn = doc.createElement('button');
  manageListsBtn.type = 'button';
  manageListsBtn.className = 'btn-sleek-pill feed-manage-lists-btn';
  manageListsBtn.textContent = 'Manage Lists';
  listFilterBar.append(listSelect, manageListsBtn);

  stageHeader.append(tabsRow, listFilterBar);

  // Inline quick-compose bar ("What's new?")
  const inlineComposeForm = doc.createElement('form');
  inlineComposeForm.className = 'inline-compose-row';
  const composeAvatar = doc.createElement('img');
  composeAvatar.className = 'post-avatar inline-compose-avatar';
  composeAvatar.alt = 'Account avatar';
  composeAvatar.src = authStore.get().accounts[0]?.avatar || DEFAULT_AVATAR_DATA_URI;

  const composeInput = doc.createElement('input');
  composeInput.type = 'text';
  composeInput.className = 'inline-compose-input';
  composeInput.placeholder = "What's new?";
  composeInput.setAttribute('aria-label', "What's new?");

  const composeSubmitBtn = doc.createElement('button');
  composeSubmitBtn.type = 'submit';
  composeSubmitBtn.className = 'btn-sleek-pill inline-compose-submit';
  composeSubmitBtn.textContent = 'Post';

  inlineComposeForm.append(composeAvatar, composeInput, composeSubmitBtn);

  const inlineStatusEl = doc.createElement('p');
  inlineStatusEl.className = 'classic-modal-status inline-compose-status';
  inlineStatusEl.setAttribute('role', 'status');
  inlineStatusEl.setAttribute('aria-live', 'polite');
  inlineStatusEl.hidden = true;

  const retryBannerEl = doc.createElement('div');
  retryBannerEl.className = 'bridge-retry-banner';
  retryBannerEl.hidden = true;

  const listEl = doc.createElement('div');
  listEl.className = 'feed-posts-list';

  const feedFooterWrap = doc.createElement('div');
  feedFooterWrap.className = 'feed-infinite-footer';
  const sentinelEl = doc.createElement('div');
  sentinelEl.className = 'feed-scroll-sentinel';
  sentinelEl.setAttribute('aria-hidden', 'true');
  const footerStatusEl = doc.createElement('div');
  footerStatusEl.className = 'feed-infinite-status';
  feedFooterWrap.append(sentinelEl, footerStatusEl);

  root.append(stageHeader, inlineComposeForm, inlineStatusEl, retryBannerEl, listEl, feedFooterWrap);
  containerEl.appendChild(root);

  const scrollRoot = containerEl.closest?.('.center-column-wrap') || null;
  const scrollTarget = scrollRoot || containerEl;
  const detachPull = attachPullToRefresh(scrollTarget, () => loadStream(false));

  function syncInfiniteFooter() {
    if (destroyed) return;
    footerStatusEl.replaceChildren();
    if (loadingOlder) {
      footerStatusEl.appendChild(createLoadingState('Loading more posts…', { doc, size: 'compact' }));
      return;
    }
    if (appendError) {
      const retryBtn = doc.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-sleek-pill feed-retry-more-btn';
      retryBtn.textContent = 'Retry loading older posts';
      retryBtn.addEventListener('click', () => {
        appendError = '';
        syncInfiniteFooter();
        void loadStream(true);
      });
      footerStatusEl.appendChild(retryBtn);
    }
  }

  inlineComposeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const draft = composeInput.value.trim();
    if (!draft) {
      openCompose({});
      return;
    }
    composeSubmitBtn.disabled = true;
    inlineStatusEl.hidden = false;
    inlineStatusEl.textContent = 'Posting...';
    try {
      await publishOrganicPost({ text: draft });
      composeInput.value = '';
      inlineStatusEl.hidden = true;
      inlineStatusEl.textContent = '';
    } catch (err) {
      inlineStatusEl.hidden = false;
      inlineStatusEl.textContent = err?.message || 'Unable to publish post.';
    } finally {
      composeSubmitBtn.disabled = false;
    }
  });

  function resolvePostInActiveBucket(post) {
    const postKey = String(post?.id || post?.key || '');
    if (!postKey) return post;
    const state = feedStore.get();
    const streamName = ALLOWED_STREAMS.has(state.activeStream) ? state.activeStream : 'feed';
    const items = state.streams[streamName]?.items || [];
    return items.find((it) => String(it?.id || it?.key || '') === postKey) || post;
  }

  async function handleLike(post) {
    const cur = resolvePostInActiveBucket(post) || post;
    const postKey = String(cur?.id || cur?.key || '');
    const lockKey = `like:${postKey}`;
    if (!postKey || pendingReactions.has(lockKey)) return;
    pendingReactions.add(lockKey);
    const wasLiked = Boolean(cur?._meta?.mastodon?.favourited || cur?._meta?.bluesky?.likeUri || cur?.viewerState?.favourited);
    const optimistic = buildOptimisticReactionPost(cur, 'like', !wasLiked);
    mutatePostAcrossStreams(postKey, () => optimistic);
    try {
      const updated = await likeUnified(cur, wasLiked);
      if (destroyed) return;
      if (updated) {
        mutatePostAcrossStreams(postKey, () => updated);
      }
      if (!wasLiked) {
        void recordAuthorInteraction(cur, cur?.protocol, 1);
      }
    } catch {
      if (!destroyed) {
        mutatePostAcrossStreams(postKey, () => cur);
      }
    } finally {
      pendingReactions.delete(lockKey);
    }
  }

  async function handleRepost(post) {
    const cur = resolvePostInActiveBucket(post) || post;
    const postKey = String(cur?.id || cur?.key || '');
    const lockKey = `repost:${postKey}`;
    if (!postKey || pendingReactions.has(lockKey)) return;
    pendingReactions.add(lockKey);
    const wasReposted = Boolean(cur?._meta?.mastodon?.reblogged || cur?._meta?.bluesky?.repostUri || cur?.viewerState?.reblogged);
    const optimistic = buildOptimisticReactionPost(cur, 'repost', !wasReposted);
    mutatePostAcrossStreams(postKey, () => optimistic);
    try {
      const updated = await repostUnified(cur, wasReposted);
      if (!destroyed && updated) {
        mutatePostAcrossStreams(postKey, () => updated);
      }
    } catch {
      if (!destroyed) {
        mutatePostAcrossStreams(postKey, () => cur);
      }
    } finally {
      pendingReactions.delete(lockKey);
    }
  }

  async function handleBookmark(post) {
    const cur = resolvePostInActiveBucket(post) || post;
    const postKey = String(cur?.id || cur?.key || '');
    const lockKey = `bookmark:${postKey}`;
    if (!postKey || pendingReactions.has(lockKey)) return;
    const fedi = await getAuthenticatedAccount('fediverse');
    if (!fedi) return;
    pendingReactions.add(lockKey);
    const sid = cur._meta?.mastodon?.statusId || cur.id;
    const bookmarked = Boolean(cur._meta?.mastodon?.bookmarked || cur.viewerState?.bookmarked);
    const optimistic = buildOptimisticReactionPost(cur, 'bookmark', !bookmarked);
    mutatePostAcrossStreams(postKey, () => optimistic);
    try {
      const updated = await toggleBookmark({
        instanceUrl: fedi.meta.instanceUrl,
        accessToken: fedi.secrets.accessToken,
        statusId: sid,
        bookmarked,
      });
      if (destroyed) return;
      if (!bookmarked) {
        void recordAuthorInteraction(cur, 'mastodon', 1);
      }
      mutatePostAcrossStreams(postKey, () => updated);
    } catch {
      if (!destroyed) {
        mutatePostAcrossStreams(postKey, () => cur);
      }
    } finally {
      pendingReactions.delete(lockKey);
    }
  }

  function openManageListsModal() {
    const modal = createClassicModalDialog({
      id: 'manage-lists-dialog',
      maxWidth: '520px',
      onClose: () => modal.dialog.remove(),
    });
    const heading = doc.createElement('h3');
    heading.id = modal.titleId;
    heading.className = 'classic-modal-title';
    heading.textContent = 'Manage Mastodon Lists';

    const body = doc.createElement('div');
    body.className = 'classic-modal-scroll-body';

    const createRow = doc.createElement('form');
    createRow.className = 'list-create-row';
    const titleIn = doc.createElement('input');
    titleIn.type = 'text';
    titleIn.className = 'onboarding-input';
    titleIn.placeholder = 'New list title...';
    const createBtn = doc.createElement('button');
    createBtn.type = 'submit';
    createBtn.className = 'btn-sleek-pill';
    createBtn.textContent = 'Create List';
    createRow.append(titleIn, createBtn);

    const listsStack = doc.createElement('div');
    listsStack.className = 'classic-cards-stack';

    const membersWrap = doc.createElement('div');
    membersWrap.className = 'classic-section-divider';

    let inspectListId = selectedListId || '';

    async function renderMembers(listObj) {
      membersWrap.replaceChildren();
      if (!listObj) return;
      const mh = doc.createElement('h4');
      mh.className = 'modal-sub-header';
      mh.textContent = `Members: ${listObj.title}`;

      const addForm = doc.createElement('form');
      addForm.className = 'list-create-row';
      const searchIn = doc.createElement('input');
      searchIn.type = 'text';
      searchIn.className = 'onboarding-input';
      searchIn.placeholder = 'Add @user to list...';
      searchIn.setAttribute('autocorrect', 'off');
      searchIn.setAttribute('autocapitalize', 'none');
      searchIn.setAttribute('spellcheck', 'false');
      const searchBtn = doc.createElement('button');
      searchBtn.type = 'submit';
      searchBtn.className = 'onboarding-btn';
      searchBtn.textContent = 'Find';
      addForm.append(searchIn, searchBtn);

      const searchResults = doc.createElement('div');
      searchResults.className = 'classic-cards-stack';
      addForm.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const q = searchIn.value.trim();
        if (!q) return;
        const found = await searchAccountsAndPosts(q);
        searchResults.replaceChildren(
          ...(found.accounts || []).slice(0, 5).map((acc) => {
            const row = doc.createElement('div');
            row.className = 'list-entry-row row-layout';
            const lbl = doc.createElement('span');
            lbl.textContent = `${acc.displayName || acc.username} (@${acc.acct})`;
            const addB = doc.createElement('button');
            addB.type = 'button';
            addB.className = 'btn-sleek-pill';
            addB.textContent = '+ Add';
            addB.addEventListener('click', async () => {
              await addAccountToMastodonList(listObj.id, acc.id);
              searchResults.replaceChildren();
              await renderMembers(listObj);
            });
            row.append(lbl, addB);
            return row;
          })
        );
      });

      const currentList = doc.createElement('div');
      currentList.className = 'classic-cards-stack';
      const members = await fetchListAccounts(listObj.id).catch(() => []);
      for (const acc of members) {
        const row = doc.createElement('div');
        row.className = 'list-entry-row row-layout';
        const lbl = doc.createElement('span');
        lbl.textContent = `${acc.displayName || acc.username} (@${acc.acct})`;
        const rmB = doc.createElement('button');
        rmB.type = 'button';
        rmB.className = 'edit-btn';
        rmB.textContent = 'Remove';
        rmB.addEventListener('click', async () => {
          await removeAccountFromMastodonList(listObj.id, acc.id);
          await renderMembers(listObj);
        });
        row.append(lbl, rmB);
        currentList.appendChild(row);
      }
      membersWrap.append(mh, addForm, searchResults, currentList);
    }

    async function refreshListsUi() {
      const lists = await fetchLists().catch(() => []);
      setUserLists(lists);
      listsStack.replaceChildren(
        ...lists.map((l) => {
          const row = doc.createElement('div');
          row.className = 'list-entry-row row-layout';
          const nameBtn = doc.createElement('button');
          nameBtn.type = 'button';
          nameBtn.className = 'list-row-select-btn';
          nameBtn.textContent = l.title;
          nameBtn.addEventListener('click', () => {
            inspectListId = l.id;
            void renderMembers(l);
          });
          const useBtn = doc.createElement('button');
          useBtn.type = 'button';
          useBtn.className = 'onboarding-btn';
          useBtn.textContent = 'Filter Stream';
          useBtn.addEventListener('click', () => {
            selectedListId = l.id;
            modal.close();
            void loadStream(false);
          });
          const delBtn = doc.createElement('button');
          delBtn.type = 'button';
          delBtn.className = 'edit-btn edit-cancel-btn';
          delBtn.textContent = 'Delete';
          delBtn.addEventListener('click', async () => {
            await deleteMastodonList(l.id);
            if (selectedListId === l.id) selectedListId = '';
            if (inspectListId === l.id) inspectListId = '';
            await refreshListsUi();
            render();
          });
          row.append(nameBtn, useBtn, delBtn);
          return row;
        })
      );
      const targetList = lists.find((l) => l.id === inspectListId) || lists[0] || null;
      await renderMembers(targetList);
      render();
    }

    createRow.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const title = titleIn.value.trim();
      if (!title) return;
      await createMastodonList(title);
      titleIn.value = '';
      await refreshListsUi();
    });

    body.append(createRow, listsStack, membersWrap);
    modal.card.append(heading, body);
    void refreshListsUi();
    modal.open();
  }

  function openAuthorListPicker(author) {
    const accountId = author?.id;
    const lists = feedStore.get().lists || [];
    if (!accountId || lists.length === 0) {
      showAlert('Lists', 'Create a Mastodon list first under Following → Manage Lists.');
      return;
    }
    const modal = createClassicModalDialog({
      id: 'pick-author-list-dialog',
      maxWidth: '400px',
      onClose: () => modal.dialog.remove(),
    });
    const heading = doc.createElement('h3');
    heading.id = modal.titleId;
    heading.className = 'classic-modal-title';
    heading.textContent = `Add @${String(author.handle || author.acct || '').replace(/^@/, '')} to List`;
    const stack = doc.createElement('div');
    stack.className = 'classic-cards-stack';
    for (const l of lists) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'onboarding-btn';
      btn.textContent = `+ ${l.title}`;
      btn.addEventListener('click', async () => {
        await addAccountToMastodonList(l.id, accountId);
        modal.close();
      });
      stack.appendChild(btn);
    }
    modal.card.append(heading, stack);
    modal.open();
  }

  manageListsBtn.addEventListener('click', () => openManageListsModal());
  listSelect.addEventListener('change', () => {
    selectedListId = listSelect.value || '';
    void loadStream(false);
  });

  async function fetchFediverseFeed(fediAuth, curCursor, append) {
    if (fediAuth && (!append || curCursor.fedi)) {
      try {
        const res = await getTimeline({
          instanceUrl: fediAuth.meta.instanceUrl,
          accessToken: fediAuth.secrets.accessToken,
          stream: 'federated',
          maxId: append ? (curCursor.fedi || '') : '',
        });
        return { items: res.items, nextFedi: res.nextCursor, nextOffset: null };
      } catch {
        if (append) throw new Error('Unable to load older Fediverse posts.');
        // Fall through on initial load to trending statuses if federated timeline is restricted
      }
    }
    const tr = await getTrendingStatuses({
      instanceUrl: fediAuth ? fediAuth.meta.instanceUrl : DEFAULT_PUBLIC_INSTANCE,
      offset: append ? (curCursor.fediOffset || 0) : 0,
    });
    return { items: tr.items, nextFedi: null, nextOffset: tr.nextOffset };
  }

  async function loadStream(append = false) {
    if (destroyed) return;
    const state = feedStore.get();
    const streamName = ALLOWED_STREAMS.has(state.activeStream) ? state.activeStream : 'feed';
    const existingBucket = state.streams[streamName] || { items: [], nextCursor: null };

    if (append) {
      if (loadingOlder || inFlightRefresh || !existingBucket.nextCursor) return;
    } else {
      requestEpoch += 1;
      inFlightRefresh = true;
      loadingOlder = false;
      appendError = '';
      lastAutoCursorSig = '';
      syncRefreshButton();
      syncInfiniteFooter();
    }

    const epoch = requestEpoch;
    const hadItems = existingBucket.items.length > 0;

    if (!append) {
      await prefsHydrationPromise;
      if (destroyed || epoch !== requestEpoch) return;
      if (!hadItems) {
        setStreamLoading(true, null);
        await hydrateCachedStream(streamName);
        if (destroyed || epoch !== requestEpoch) return;
      }
    }

    if (append) {
      loadingOlder = true;
      appendError = '';
      syncInfiniteFooter();
    }

    try {
      const [fediAuth, bskyAuth] = await Promise.all([
        getAuthenticatedAccount('fediverse'),
        getAuthenticatedAccount('bluesky'),
      ]);
      if (destroyed || epoch !== requestEpoch) return;

      const curCursor = feedStore.get().streams[streamName]?.nextCursor || {};

      if (streamName === 'following') {
        if (!fediAuth && !bskyAuth) {
          if (!append) setStreamItems('following', [], null);
          return;
        }

        const wantFedi = Boolean(fediAuth) && (!append || Boolean(curCursor.fedi));
        const wantBsky = Boolean(bskyAuth && !selectedListId) && (!append || Boolean(curCursor.bsky));
        if (append && !wantFedi && !wantBsky) {
          appendStreamItems('following', [], null);
          return;
        }

        const tasks = [];
        if (wantFedi) {
          tasks.push(
            getTimeline({
              instanceUrl: fediAuth.meta.instanceUrl,
              accessToken: fediAuth.secrets.accessToken,
              stream: selectedListId ? 'list' : 'home',
              listId: selectedListId,
              maxId: append ? (curCursor.fedi || '') : '',
            })
              .then((r) => ({ source: 'fedi', items: r.items, nextFedi: r.nextCursor }))
              .catch((err) => {
                err._source = 'fedi';
                throw err;
              })
          );
          if (!append) {
            void fetchLists().then((lists) => { if (!destroyed) setUserLists(lists); }).catch(() => {});
          }
        }
        if (wantBsky) {
          tasks.push(
            getBskyTimeline({
              serviceUrl: bskyAuth.meta.serviceUrl,
              accessJwt: bskyAuth.secrets.accessJwt,
              refreshJwt: bskyAuth.secrets.refreshJwt,
              onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
              cursor: append ? (curCursor.bsky || '') : '',
            })
              .then((r) => ({ source: 'bsky', items: r.items, nextBsky: r.nextCursor }))
              .catch((err) => {
                err._source = 'bsky';
                throw err;
              })
          );
        }

        const settled = await Promise.allSettled(tasks);
        if (destroyed || epoch !== requestEpoch) return;

        const combinedItems = [];
        let nextFedi = null;
        let nextBsky = null;
        let anySucceeded = false;
        let firstError = '';

        for (const res of settled) {
          if (res.status === 'fulfilled') {
            anySucceeded = true;
            combinedItems.push(...(res.value.items || []));
            if (res.value.source === 'fedi') nextFedi = res.value.nextFedi || null;
            if (res.value.source === 'bsky') nextBsky = res.value.nextBsky || null;
          } else {
            if (!firstError) firstError = res.reason?.message || 'Unable to load Following stream.';
            if (append && res.reason?._source === 'fedi' && curCursor.fedi) nextFedi = curCursor.fedi;
            if (append && res.reason?._source === 'bsky' && curCursor.bsky) nextBsky = curCursor.bsky;
          }
        }

        if (!anySucceeded) {
          if (append) {
            appendError = firstError || 'Unable to load older posts.';
            return;
          }
          if ((feedStore.get().streams.following?.items?.length || 0) === 0) {
            setStreamLoading(false, firstError || 'Unable to load Following stream.');
          } else {
            setStreamLoading(false, null);
          }
          return;
        }

        const nextCursor = (nextFedi || nextBsky) ? { fedi: nextFedi, bsky: nextBsky } : null;
        const nextItems = append
          ? combinedItems
          : mergeChronologicalPosts([], combinedItems);
        if (append) appendStreamItems('following', nextItems, nextCursor);
        else setStreamItems('following', nextItems, nextCursor);
        await persistStreamCache('following');
        scheduleMetricsEnrichment(nextItems, () => destroyed || epoch !== requestEpoch);
        return;
      }

      // 'feed' stream: Open social web discovery (Mastodon public/trending + Bluesky What's Hot)
      const wantFedi = !append || Boolean(curCursor.fedi) || curCursor.fediOffset != null;
      const wantBsky = !append || Boolean(curCursor.bsky);
      if (append && !wantFedi && !wantBsky) {
        appendStreamItems('feed', [], null);
        return;
      }

      const [fediResult, bskyResult] = await Promise.allSettled([
        wantFedi ? fetchFediverseFeed(fediAuth, curCursor, append) : Promise.resolve({ skipped: true }),
        wantBsky
          ? getBskyCustomFeed({
              feed: BSKY_WHATS_HOT_FEED,
              cursor: append ? (curCursor.bsky || '') : '',
              ...(bskyAuth
                ? {
                    serviceUrl: bskyAuth.meta.serviceUrl,
                    accessJwt: bskyAuth.secrets.accessJwt,
                    refreshJwt: bskyAuth.secrets.refreshJwt,
                    onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok),
                  }
                : {}),
            })
          : Promise.resolve({ skipped: true }),
      ]);
      if (destroyed || epoch !== requestEpoch) return;

      const combinedItems = [];
      let nextFedi = null;
      let nextOffset = null;
      let nextBsky = null;
      let anySucceeded = false;
      let firstError = '';

      if (fediResult.status === 'fulfilled') {
        if (!fediResult.value?.skipped) {
          anySucceeded = true;
          combinedItems.push(...(fediResult.value.items || []));
          nextFedi = fediResult.value.nextFedi || null;
          nextOffset = fediResult.value.nextOffset ?? null;
        }
      } else {
        firstError = fediResult.reason?.message || 'Unable to load Fediverse feed.';
        if (append) {
          nextFedi = curCursor.fedi || null;
          nextOffset = curCursor.fediOffset ?? null;
        }
      }

      if (bskyResult.status === 'fulfilled') {
        if (!bskyResult.value?.skipped) {
          anySucceeded = true;
          combinedItems.push(...(bskyResult.value.items || []));
          nextBsky = bskyResult.value.nextCursor || null;
        }
      } else {
        if (!firstError) firstError = bskyResult.reason?.message || 'Unable to load Bluesky feed.';
        if (append) nextBsky = curCursor.bsky || null;
      }

      if (!anySucceeded) {
        if (append) {
          appendError = firstError || 'Unable to load older posts.';
          return;
        }
        if ((feedStore.get().streams.feed?.items?.length || 0) === 0) {
          setStreamLoading(false, firstError || 'Unable to load feed.');
        } else {
          setStreamLoading(false, null);
        }
        return;
      }

      const nextCursor = (nextFedi || nextOffset !== null || nextBsky)
        ? { fedi: nextFedi, fediOffset: nextOffset, bsky: nextBsky }
        : null;

      const nextItems = append
        ? combinedItems
        : mergeChronologicalPosts([], combinedItems);
      if (append) {
        appendStreamItems('feed', nextItems, nextCursor);
      } else {
        setStreamItems('feed', nextItems, nextCursor);
      }
      await persistStreamCache('feed');
      scheduleMetricsEnrichment(nextItems, () => destroyed || epoch !== requestEpoch);
    } catch (err) {
      if (destroyed || epoch !== requestEpoch) return;
      if (append) {
        appendError = err?.message || 'Unable to load older posts.';
      } else if ((feedStore.get().streams[streamName]?.items?.length || 0) === 0) {
        setStreamLoading(false, err?.message || 'Unable to load timeline');
      } else {
        setStreamLoading(false, null);
      }
    } finally {
      if (epoch === requestEpoch) {
        if (append) loadingOlder = false;
        else inFlightRefresh = false;
        syncRefreshButton();
        syncInfiniteFooter();
        clearTimeout(autoCheckTimer);
        autoCheckTimer = setTimeout(() => {
          if (destroyed || epoch !== requestEpoch) return;
          if ((sentinelIntersecting || isNearBottom()) && canLoadOlder()) {
            const activeName = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
            const curSig = JSON.stringify(feedStore.get().streams[activeName]?.nextCursor || null);
            if (curSig && curSig !== 'null' && curSig !== lastAutoCursorSig) {
              lastAutoCursorSig = curSig;
              void loadStream(true);
            }
          }
        }, 0);
      }
    }
  }

  function buildCardForPost(key, initialPost, showSanctuary, hasMasto, hasBsky) {
    const getLivePost = () => cardCache.get(key)?.post || initialPost;
    const postProto = initialPost?.protocol || (initialPost?.network === 'bluesky' ? 'bluesky' : 'mastodon');
    const canActProto = postProto === 'bluesky' ? hasBsky : hasMasto;
    return createPostCard(initialPost, {
      onReply: () => prefillReply(getLivePost()),
      onToggleLike: () => void handleLike(getLivePost()),
      onToggleRepost: () => void handleRepost(getLivePost()),
      onToggleBookmark: () => void handleBookmark(getLivePost()),
      onOpenThread: onOpenPostThread
        ? (target) => onOpenPostThread(target && target !== initialPost ? target : getLivePost())
        : undefined,
      onAskSanctuary: onAskSanctuary
        ? () => {
            const p = getLivePost();
            void recordAuthorInteraction(p, p?.protocol, 1.5);
            onAskSanctuary(p);
          }
        : undefined,
      onSelectAuthor,
      onEditPost: hasMasto && postProto === 'mastodon' ? () => {
        const p = getLivePost();
        openEditPostDialog(p, {
          onSaved: (updated) => mutatePostAcrossStreams(p.id || p.key, () => updated),
        });
      } : null,
      onTogglePin: hasMasto && postProto === 'mastodon' ? async () => {
        const p = getLivePost();
        const updated = await pinUnified(p, Boolean(p._meta?.mastodon?.pinned));
        if (updated) mutatePostAcrossStreams(p.id || p.key, () => updated);
      } : null,
      onDeletePost: () => {
        const p = getLivePost();
        showConfirm(
          'Delete Post',
          p._meta?.linkedIds?.blueskyUri || p._meta?.linkedIds?.threadsPostId
            ? 'Delete this post from Mastodon and all linked bridges?'
            : 'Delete this post?',
          async () => {
            const res = await deleteUnified(p);
            removePostAcrossStreams(p.id || p.key);
            if (res?.warnings?.length > 0) {
              showAlert('Bridge Delete Warning', res.warnings.join('\n\n'));
            }
          }
        );
      },
      onFollowAuthor: canActProto ? (_raw, u) => {
        if (!u?.author?.id) return;
        void toggleFollowAuthor(u.author.id, false, { protocol: u.protocol });
      } : null,
      onManageAuthorLists: hasMasto && postProto === 'mastodon' ? (_raw, u) => openAuthorListPicker(u?.author) : null,
      onMuteAuthor: canActProto ? (_raw, u) => {
        if (!u?.author?.id) return;
        showConfirm('Mute Account', `Mute @${String(u.author.handle || '').replace(/^@/, '')}?`, async () => {
          await toggleMuteAuthor(u.author.id, false, { protocol: u.protocol });
          removePostAcrossStreams((item) => item?.author?.id === u.author.id);
        });
      } : null,
      onBlockAuthor: canActProto ? (_raw, u) => {
        if (!u?.author?.id) return;
        showConfirm('Block Account', `Block @${String(u.author.handle || '').replace(/^@/, '')}?`, async () => {
          await toggleBlockAuthor(u.author.id, false, { protocol: u.protocol });
          removePostAcrossStreams((item) => item?.author?.id === u.author.id);
        });
      } : null,
      showSanctuaryAction: showSanctuary,
    });
  }

  function resolveStableOrderedItems(streamName, bucket, state) {
    const rawItems = Array.isArray(bucket?.items) ? bucket.items : [];
    const byId = new Map();
    for (const p of rawItems) {
      const id = String(p?.id || p?.key || '');
      if (id) byId.set(id, p);
    }
    if (byId.size === 0) {
      streamOrders.delete(streamName);
      return [];
    }

    const gen = Number(bucket?.generation || 0);
    const tuningSig = computeTuningSig(state.tuning);
    let order = streamOrders.get(streamName);

    if (!order || order.generation !== gen || order.tuningSig !== tuningSig) {
      const ranked = rankFeedItems(rawItems, state.tuning, {
        nowMs: bucket.updatedAt || Date.now(),
        interactedAuthors: state.interactedAuthors,
        semanticScores: state.semanticScores,
      });
      order = {
        generation: gen,
        tuningSig,
        orderedIds: ranked.map((p) => String(p?.id || p?.key || '')).filter(Boolean),
        seenIds: new Set(byId.keys()),
      };
      streamOrders.set(streamName, order);
    } else {
      order.orderedIds = order.orderedIds.filter((id) => byId.has(id));
      let leadCount = 0;
      while (leadCount < rawItems.length) {
        const lid = String(rawItems[leadCount]?.id || rawItems[leadCount]?.key || '');
        if (!lid || order.seenIds.has(lid)) break;
        leadCount += 1;
      }
      const prependedIds = [];
      for (let i = 0; i < leadCount; i += 1) {
        const lid = String(rawItems[i]?.id || rawItems[i]?.key || '');
        if (lid && !order.seenIds.has(lid)) {
          order.seenIds.add(lid);
          prependedIds.push(lid);
        }
      }
      const appendedItems = [];
      for (let i = leadCount; i < rawItems.length; i += 1) {
        const aid = String(rawItems[i]?.id || rawItems[i]?.key || '');
        if (aid && !order.seenIds.has(aid)) {
          order.seenIds.add(aid);
          appendedItems.push(rawItems[i]);
        }
      }
      if (prependedIds.length > 0) {
        order.orderedIds = [...prependedIds, ...order.orderedIds];
      }
      if (appendedItems.length > 0) {
        const rankedAppended = rankFeedItems(appendedItems, state.tuning, {
          nowMs: bucket.updatedAt || Date.now(),
          interactedAuthors: state.interactedAuthors,
          semanticScores: state.semanticScores,
        });
        for (const p of rankedAppended) {
          const id = String(p?.id || p?.key || '');
          if (id) order.orderedIds.push(id);
        }
      }
    }

    const ordered = order.orderedIds.map((id) => byId.get(id)).filter(Boolean);
    return applyKeywordFilters(ordered, state.filters || [], state.moderatedActors || []);
  }

  function reconcilePostList(visibleItems, { showSanctuary, hasMasto, hasBsky, isLoading, errorMsg }) {
    if (visibleItems.length === 0) {
      cardCache.clear();
      if (errorMsg) {
        listEl.replaceChildren(createOfflineNotice({ variant: 'error', message: errorMsg }));
      } else if (isLoading) {
        listEl.replaceChildren(createLoadingState('Loading stream…'));
      } else {
        const empty = doc.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No posts loaded.';
        listEl.replaceChildren(empty);
      }
      return;
    }

    for (const child of [...listEl.children]) {
      if (child.tagName !== 'ARTICLE') {
        child.remove();
      }
    }

    const activeKeys = new Set();
    const keyedEntries = visibleItems.map((post, idx) => {
      const key = String(post?.id || post?.key || `row-${idx}`);
      activeKeys.add(key);
      return { post, key };
    });

    for (const [cachedKey, entry] of [...cardCache.entries()]) {
      if (!activeKeys.has(cachedKey)) {
        entry.card.remove();
        cardCache.delete(cachedKey);
      }
    }

    const canMoveBefore =
      Object.hasOwn(globalThis.Element?.prototype || {}, 'moveBefore') &&
      typeof listEl.moveBefore === 'function';

    for (let idx = 0; idx < keyedEntries.length; idx += 1) {
      const { post, key } = keyedEntries[idx];
      const structSig = computePostStructureSig(post, showSanctuary, hasMasto, hasBsky);
      const reactSig = computePostReactionSig(post);
      const existing = cardCache.get(key);
      let cardEl = existing?.card || null;
      if (!existing || existing.structSig !== structSig) {
        const nextCard = buildCardForPost(key, post, showSanctuary, hasMasto, hasBsky);
        if (existing?.card && existing.card.parentNode === listEl) {
          listEl.replaceChild(nextCard, existing.card);
        }
        cardEl = nextCard;
        cardCache.set(key, { structSig, reactSig, card: nextCard, post });
      } else {
        existing.post = post;
        if (existing.reactSig !== reactSig) {
          syncPostCardReactions(existing.card, post);
          existing.reactSig = reactSig;
        }
      }
      const currentAtIdx = listEl.children[idx] || null;
      if (currentAtIdx !== cardEl) {
        if (canMoveBefore && cardEl.parentNode === listEl) {
          listEl.moveBefore(cardEl, currentAtIdx);
        } else {
          listEl.insertBefore(cardEl, currentAtIdx);
        }
      }
    }
  }

  function render() {
    if (destroyed) return;
    const state = feedStore.get();
    const conn = connectionStore.get();
    const authState = authStore.get();
    const streamName = ALLOWED_STREAMS.has(state.activeStream) ? state.activeStream : 'feed';
    const bucket = state.streams[streamName] || { items: [], nextCursor: null };

    composeAvatar.src = authState.accounts[0]?.avatar || DEFAULT_AVATAR_DATA_URI;

    for (const [key, btn] of tabButtons.entries()) {
      const active = streamName === key;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    }

    const retries = Array.isArray(authState.retryQueue) ? authState.retryQueue : [];
    if (retries.length > 0) {
      retryBannerEl.hidden = false;
      retryBannerEl.replaceChildren();
      const firstRetry = retries[0];
      const msg = doc.createElement('span');
      msg.className = 'bridge-retry-msg';
      msg.textContent = `${firstRetry.protocol} bridge sync paused (${retries.length}): ${firstRetry.lastError || 'temporary error'}`;
      const retryBtn = doc.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-sleek-pill';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => void runBridgeRetry(firstRetry.id));
      const dismissBtn = doc.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'edit-btn';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', () => void dismissBridgeRetry(firstRetry.id));
      retryBannerEl.append(msg, retryBtn, dismissBtn);
    } else {
      retryBannerEl.hidden = true;
      retryBannerEl.replaceChildren();
    }

    const hasMasto = authState.accounts.some((a) => a.platform === 'fediverse');
    const hasBsky = authState.accounts.some((a) => a.platform === 'bluesky');
    listFilterBar.hidden = !(streamName === 'following' && hasMasto);
    if (!listFilterBar.hidden) {
      const curLists = state.lists || [];
      const nextListSig = `${selectedListId}::${curLists.map((l) => `${l.id}:${l.title}`).join('|')}`;
      if (nextListSig !== lastListOptionsSig) {
        lastListOptionsSig = nextListSig;
        listSelect.replaceChildren();
        const allOpt = doc.createElement('option');
        allOpt.value = '';
        allOpt.textContent = 'All Following';
        allOpt.selected = !selectedListId;
        listSelect.appendChild(allOpt);
        for (const l of curLists) {
          const opt = doc.createElement('option');
          opt.value = l.id;
          opt.textContent = l.title;
          opt.selected = String(selectedListId) === String(l.id);
          listSelect.appendChild(opt);
        }
      }
    }

    const hasSocial = hasAnySocialAccount(authState);
    if (streamName === 'following' && !hasSocial) {
      cardCache.clear();
      const box = doc.createElement('div');
      box.className = 'empty-state';
      const p = doc.createElement('p');
      p.style.margin = '0 0 14px';
      p.textContent = 'Connect Mastodon or Bluesky under Profile → Accounts & Bridges to see people you follow.';
      const connectBtn = doc.createElement('button');
      connectBtn.type = 'button';
      connectBtn.className = 'btn-sleek-pill following-connect-btn';
      connectBtn.textContent = 'Connect Accounts';
      connectBtn.addEventListener('click', () => onOpenAccounts?.());
      box.append(p, connectBtn);
      listEl.replaceChildren(box);
      syncInfiniteFooter();
      return;
    }

    const boostConcepts = state.tuning?.boostConcepts || [];
    const dampenConcepts = state.tuning?.dampenConcepts || [];
    if ((boostConcepts.length > 0 || dampenConcepts.length > 0) && (bucket.items?.length || 0) > 0) {
      const filteredForSem = applyKeywordFilters(bucket.items, state.filters || [], state.moderatedActors || []);
      const semSig = `${streamName}::${bucket.generation || 0}::${filteredForSem.length}::${boostConcepts.join('\u001f')}||${dampenConcepts.join('\u001f')}`;
      if (semSig !== lastSemanticSig && filteredForSem.length > 0) {
        lastSemanticSig = semSig;
        void fetchSemanticFeedScores({ items: filteredForSem, boostConcepts, dampenConcepts })
          .then((scores) => {
            if (!destroyed && scores && Object.keys(scores).length > 0) {
              setSemanticScores(scores);
            }
          })
          .catch(() => {});
      }
    }
    const visibleItems = resolveStableOrderedItems(streamName, bucket, state);
    const showSanctuary = conn.mode === 'online' || conn.programs.length > 0;
    reconcilePostList(visibleItems, {
      showSanctuary,
      hasMasto,
      hasBsky,
      isLoading: Boolean(state.loading),
      errorMsg: state.error,
    });
    syncInfiniteFooter();
  }

  function canLoadOlder() {
    if (destroyed || loadingOlder || inFlightRefresh || appendError) return false;
    const state = feedStore.get();
    if (state.loading) return false;
    const streamName = ALLOWED_STREAMS.has(state.activeStream) ? state.activeStream : 'feed';
    if (streamName === 'following' && !hasAnySocialAccount(authStore.get())) return false;
    const bucket = state.streams[streamName];
    return Boolean(bucket?.nextCursor) && (bucket?.items?.length || 0) > 0;
  }

  function isNearBottom() {
    const scrollH = Number(scrollTarget.scrollHeight || 0);
    const clientH = Number(scrollTarget.clientHeight || 0);
    const scrollT = Number(scrollTarget.scrollTop || 0);
    if (scrollH > 0 && clientH > 0 && scrollH - scrollT - clientH <= INFINITE_SCROLL_THRESHOLD_PX) {
      return true;
    }
    if (!scrollRoot) {
      const rootEl = doc.documentElement;
      const docH = Number(rootEl?.scrollHeight || 0);
      const docClientH = Number(rootEl?.clientHeight || 0);
      const docScrollT = Number(rootEl?.scrollTop || globalThis.scrollY || 0);
      if (docH > 0 && docClientH > 0 && docH - docScrollT - docClientH <= INFINITE_SCROLL_THRESHOLD_PX) {
        return true;
      }
    }
    return false;
  }

  function handleScroll() {
    lastAutoCursorSig = '';
    if (!canLoadOlder()) return;
    if (isNearBottom()) {
      void loadStream(true);
    }
  }
  scrollTarget.addEventListener('scroll', handleScroll, { passive: true });

  let intersectionObserver = null;
  if (typeof globalThis.IntersectionObserver === 'function') {
    intersectionObserver = new globalThis.IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.target === sentinelEl) {
            sentinelIntersecting = Boolean(entry.isIntersecting);
          }
        }
        if (sentinelIntersecting && canLoadOlder()) {
          void loadStream(true);
        }
      },
      { root: scrollRoot, rootMargin: `0px 0px ${INFINITE_SCROLL_THRESHOLD_PX}px 0px` }
    );
    intersectionObserver.observe(sentinelEl);
  }

  let prevSocialIdsSig = getSocialIdsSig(authStore.get());
  let prevAccountsUiSig = getAccountsUiSig(authStore.get());
  let prevRetrySig = getRetrySig(authStore.get());

  const unsubFeed = feedStore.subscribe(render);
  const unsubConn = connectionStore.select(
    (s) => s.mode === 'online' || s.programs.length > 0,
    () => render()
  );
  const unsubAuth = authStore.subscribe((nextAuth) => {
    const nextSocialIdsSig = getSocialIdsSig(nextAuth);
    const nextAccountsUiSig = getAccountsUiSig(nextAuth);
    const nextRetrySig = getRetrySig(nextAuth);
    if (
      nextSocialIdsSig === prevSocialIdsSig &&
      nextAccountsUiSig === prevAccountsUiSig &&
      nextRetrySig === prevRetrySig
    ) {
      return;
    }
    const socialChanged = nextSocialIdsSig !== prevSocialIdsSig;
    prevSocialIdsSig = nextSocialIdsSig;
    prevAccountsUiSig = nextAccountsUiSig;
    prevRetrySig = nextRetrySig;
    if (socialChanged) {
      const activeName = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
      const curItems = feedStore.get().streams[activeName]?.items || [];
      render();
      if (activeName === 'following' && curItems.length === 0 && hasAnySocialAccount(nextAuth)) {
        void loadStream(false);
      }
      return;
    }
    render();
  });

  render();
  const initialStream = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
  if ((feedStore.get().streams[initialStream]?.items?.length || 0) === 0) {
    void loadStream(false);
  }

  return {
    refresh: () => loadStream(false),
    destroy() {
      destroyed = true;
      requestEpoch += 1;
      clearTimeout(autoCheckTimer);
      detachPull();
      scrollTarget.removeEventListener('scroll', handleScroll);
      intersectionObserver?.disconnect();
      cardCache.clear();
      streamOrders.clear();
      pendingReactions.clear();
      unsubFeed();
      unsubConn();
      unsubAuth();
    },
  };
}
