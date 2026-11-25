import { createOfflineNotice } from '../components/OfflineNotice.js';
import {
  createLoopsSlide,
  createPostCard,
  getPostActionCapabilities,
  syncPostCardReactions,
  VOLUME_MUTED_SVG,
  VOLUME_ON_SVG,
} from '../components/PostCard.js';
import { attachPullToRefresh } from '../components/PullToRefresh.js';
import { attachSearchSuggestions } from '../components/SearchSuggestions.js';
import { createClassicModalDialog, showAlert, showConfirm } from '../components/sanctuary/SanctuaryDialog.js';
import { createLoadingState } from '../components/ui/index.js';
import { normalizeInstanceUrl } from '../constants/endpoints.js';
import { DEFAULT_AVATAR_DATA_URI } from '../constants/avatars.js';
import { hasVisualMediaAttachment, isAutomatedSyndicationOrBotItem, rankFeedItems } from '../core/feedRanker.js';
import {
  applyKeywordFilters,
  buildOwnAccountKeySet,
  isOwnOrSelfBoostedUnifiedItem,
  isUnifiedItemModerated,
  resolveContextualStreamItems,
} from '../core/schema/unifiedItem.js';
import { getBskyTimeline } from '../queries/bluesky.js';
import { harvestSanctuaryFeed, syncOwnViewerActivity } from '../queries/feedHarvester.js';
import { formatApiErrorMessage } from '../queries/fetch/fetchWrapper.js';
import { getTimeline, searchFediverse, toggleBookmark } from '../queries/fediverse.js';
import {
  addAccountToMastodonList,
  createMastodonList,
  deleteMastodonList,
  deleteUnified,
  dismissBridgeRetry,
  enrichUnifiedItemsMetrics,
  fetchHashtagPosts,
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
  toggleMuteAuthor,
} from '../queries/socialClient.js';
import { removeActivityByActor } from '../state/activityStore.js';
import { authStore, getAuthenticatedAccount, updateAccountTokens } from '../state/authStore.js';
import { openCompose, prefillReply } from '../state/composeStore.js';
import {
  appendStreamItems,
  applyPostInterestFeedback,
  feedStore,
  hydrateCachedFilters,
  hydrateCachedModeration,
  hydrateCachedStream,
  hydrateFeedTuning,
  hydrateRankingManifest,
  mergeChronologicalPosts,
  mergeDiscoveredViewerInteractions,
  mergeSemanticFeedScores,
  mergeTasteMemoryWithFollowing,
  mutatePostAcrossStreams,
  persistStreamCache,
  reconcileEnrichedStreamItems,
  recordAuthorInteraction,
  recordBehavioralSignal,
  removePostAcrossStreams,
  setActiveStream,
  setStreamItems,
  setStreamLoading,
  setUserLists,
} from '../state/feedStore.js';
import { hydrateMetricsLedger } from '../state/metricsLedger.js';
import { connectionStore, onSanctuaryEvent } from '../state/sanctuary/connection.js';
import { publishOrganicPost } from './composeModal.js';
import { openEditPostDialog } from './profile.js';

const INFINITE_SCROLL_THRESHOLD_PX = 480;
const FEED_REFRESH_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><path d="M21 3v5h-5"></path></svg>`;

const STREAM_TABS = [
  ['feed', 'Feed'],
  ['following', 'Following'],
  ['photos', 'Photos'],
  ['video', 'Video'],
];
const DISCOVERY_STREAMS = new Set(['feed', 'photos', 'video', 'visual']);
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
  return `${Boolean(authState?.vaultLocked)}:` + (authState?.accounts || [])
    .map((a) => `${a.id}:${a.avatar || ''}`)
    .join('|');
}

function getRetrySig(authState) {
  return (authState?.retryQueue || [])
    .map((r) => `${r.id}:${r.lastError || ''}`)
    .join('|');
}

function computePostStructureSig(post, showSanctuary, hasMasto, hasBsky = false, hasThreads = false, retrySig = '', manifestSig = '', streamVariant = 'default') {
  const key = String(post?.id || post?.key || '');
  const m = post?._meta?.mastodon || {};
  const b = post?._meta?.bluesky || {};
  const attUrls = Array.isArray(post?.attachments) ? post.attachments.map((a) => a?.url || '').join(',') : '';
  const quoteKey = post?._meta?.quotePost?.id || post?._meta?.quotePost?.url || (post?._meta?.quotePost?.unavailable ? 'unavail' : '');
  const bskyLabels = Array.isArray(b.labels) ? b.labels.join(',') : '';
  return [
    streamVariant,
    key,
    post?.content_html || post?.content_text || '',
    post?.language || '',
    m.spoilerText || post?.spoilerText || '',
    Boolean(m.sensitive),
    bskyLabels,
    post?._meta?.linkCard?.url || post?.linkCard?.url || '',
    attUrls,
    quoteKey,
    post?._meta?.replyContext?.id || '',
    Boolean(m.pinned),
    m.rebloggedBy?.handle || b.rebloggedBy?.handle || '',
    Array.isArray(post?._meta?.boosters) ? post._meta.boosters.length : 0,
    Number(post?._meta?.peerVouches || 0),
    Boolean(showSanctuary),
    Boolean(hasMasto),
    Boolean(hasBsky),
    Boolean(hasThreads),
    retrySig,
    manifestSig,
  ].join('\u001f');
}

function computePostReactionSig(post) {
  const m = post?._meta?.mastodon || {};
  const b = post?._meta?.bluesky || {};
  const linked = post?._meta?.linkedIds || {};
  const metrics = post?.metrics || {};
  return [
    metrics.likes ?? 0,
    metrics.replies ?? 0,
    metrics.reposts ?? 0,
    Boolean(m.favourited || b.likeUri || post?.viewerState?.favourited),
    Boolean(post?._meta?.viewerReplied || m.replied || b.replied || post?.viewerState?.replied),
    Boolean(m.reblogged || b.repostUri || post?.viewerState?.reblogged),
    Boolean(m.bookmarked || post?.viewerState?.bookmarked),
    Boolean(b.replyDisabled),
    String(m.visibility || 'public'),
    post?._meta?.feedFeedback || '',
    linked.mastodonStatusId || m.statusId || '',
    linked.blueskyUri || b.uri || '',
    linked.threadsPostId || post?._meta?.threads?.postId || '',
    Boolean(authStore.get()?.vaultLocked),
    JSON.stringify(post?._meta?.metricsBreakdown || null),
  ].join('\u001f');
}

function computeTuningSig(tuning, manifest = null) {
  const t = tuning || {};
  return JSON.stringify([
    t.discoveryChannels || [],
    t.discoveryInstances || [],
    manifest?.version || 1,
    manifest?.weights || null,
    manifest?.caps || null,
    manifest?.syndicationBotPatterns || null,
    manifest?.sensitiveContentTriggers || null,
  ]);
}

function computeHarvestSourceSig(tuning) {
  const t = tuning || {};
  return JSON.stringify([
    t.discoveryChannels || [],
    t.discoveryInstances || [],
  ]);
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

function scheduleMetricsEnrichment(items, isStale, streamName = null) {
  if (!Array.isArray(items) || items.length === 0) return;
  void enrichUnifiedItemsMetrics(items)
    .then((enriched) => {
      if (isStale?.() || !Array.isArray(enriched) || enriched.length === 0) return;
      reconcileEnrichedStreamItems(enriched);
      if (streamName) {
        void persistStreamCache(streamName).catch(() => {});
      }
    })
    .catch((err) => {
      console.warn('[feed] Metrics enrichment failed:', err);
    });
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
  startupReadyPromise = null,
} = {}) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let selectedListId = '';
  let requestEpoch = 0;
  let inFlightRefresh = false;
  let loadingOlder = false;
  let appendError = '';
  let refreshStartedAt = 0;
  let showRefreshSpinner = false;
  let lastListOptionsSig = '';
  let sentinelIntersecting = false;
  let lastAutoCursorSig = '';
  let autoCheckTimer = null;
  let sourceRefreshTimer = null;
  let tasteRescoreTimer = null;
  let activeHashtag = '';
  let hashtagItems = [];
  let hashtagLoading = false;
  let hashtagError = '';
  let hashtagRequestEpoch = 0;
  let prefsHydrated = false;
  let initialStartupSettled = !startupReadyPromise;
  let lastUserTuningEpoch = Number(feedStore.get().userTuningEpoch || 0);
  let lastHarvestSourceSig = computeHarvestSourceSig(feedStore.get().tuning);
  let syncedFilterAccountsSig = '';

  async function scoreItemsWithNode(items, { replaceTaste = false } = {}) {
    if (destroyed || !Array.isArray(items) || items.length === 0) return;
    if (connectionStore.get().mode !== 'online') return;
    const st = feedStore.get();
    const effectiveTaste = mergeTasteMemoryWithFollowing(st.tasteMemory, st.streams?.following?.items);
    try {
      const res = await fetchSemanticFeedScores({
        items,
        boostConcepts: st.tuning?.discoveryChannels || [],
        positiveExamples: effectiveTaste.positive,
        negativeExamples: effectiveTaste.negative,
        includeAxes: false,
        timeoutMs: 2500,
      });
      if (destroyed) return;
      const hasAxes = Object.keys(res?.axisScores || {}).length > 0;
      const hasConcepts = Object.keys(res?.scores || {}).length > 0;
      const hasTaste = Object.keys(res?.tasteScores || {}).length > 0;
      if (hasAxes || hasConcepts || hasTaste) {
        mergeSemanticFeedScores({
          scores: res.scores,
          axisScores: res.axisScores,
          tasteScores: res.tasteScores,
          replaceTaste,
        });
      }
    } catch {
      // Offline or node unavailable; rankFeedItems falls back to structural + lexical signals
    }
  }

  const cardCache = new Map();
  const streamOrders = new Map();
  const warmHydratedStreams = new Set();
  const pendingReactions = new Set();
  let loopsMuted = true;
  let activeLoopsSlide = null;
  let loopsSnapObserver = null;
  let loopsPreloadObserver = null;

  function unobserveCardLoops(cardEl) {
    if (!cardEl) return;
    loopsSnapObserver?.unobserve?.(cardEl);
    loopsPreloadObserver?.unobserve?.(cardEl);
  }

  function clearCardCache() {
    for (const entry of cardCache.values()) {
      unobserveCardLoops(entry.card);
      entry.card?.remove?.();
    }
    cardCache.clear();
  }
  const prefsHydrationPromise = Promise.allSettled([
    hydrateFeedTuning(),
    hydrateRankingManifest(),
    hydrateCachedModeration(),
    hydrateCachedFilters(),
  ]).finally(() => {
    prefsHydrated = true;
    lastHarvestSourceSig = computeHarvestSourceSig(feedStore.get().tuning);
    if (!destroyed && hasAnySocialAccount(authStore.get())) {
      void fetchKeywordFilters().catch(() => {});
    }
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
      if (activeHashtag) {
        activeHashtag = '';
        hashtagItems = [];
        hashtagError = '';
        hashtagLoading = false;
        if (key === prevStream) render();
      }
      setActiveStream(key);
      if (key !== prevStream) {
        const bucket = feedStore.get().streams[key];
        if (!bucket || (bucket.items?.length || 0) === 0 || warmHydratedStreams.has(key)) {
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
    void loadStream(false, { showSpinner: true, forceRefresh: true });
  });

  tabsRow.append(feedRefreshBtn);

  function syncRefreshButton() {
    if (destroyed) return;
    feedRefreshBtn.disabled = inFlightRefresh;
    feedRefreshBtn.classList.toggle('is-spinning', inFlightRefresh && showRefreshSpinner);
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

  const hashtagBar = doc.createElement('div');
  hashtagBar.className = 'feed-hashtag-bar';
  hashtagBar.hidden = true;
  const hashtagLabel = doc.createElement('span');
  hashtagLabel.className = 'feed-hashtag-label';
  const hashtagClearBtn = doc.createElement('button');
  hashtagClearBtn.type = 'button';
  hashtagClearBtn.className = 'btn-sleek-pill feed-hashtag-clear-btn';
  hashtagClearBtn.textContent = 'Clear';
  hashtagClearBtn.addEventListener('click', () => {
    activeHashtag = '';
    hashtagItems = [];
    hashtagError = '';
    hashtagLoading = false;
    hashtagRequestEpoch += 1;
    render();
  });
  hashtagBar.append(hashtagLabel, hashtagClearBtn);

  stageHeader.append(tabsRow, listFilterBar, hashtagBar);

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
  const detachPull = attachPullToRefresh(scrollTarget, () => loadStream(false, { forceRefresh: true }));

  function hydrateLazyLoopsVideo(video) {
    if (!video) return;
    let changed = false;
    if (video.dataset?.lazyPoster) {
      video.poster = video.dataset.lazyPoster;
      video.setAttribute('poster', video.dataset.lazyPoster);
      delete video.dataset.lazyPoster;
      changed = true;
    }
    const lazyHls = video.dataset?.lazyHls || '';
    const lazySrc = video.dataset?.lazySrc || '';
    const lazyMime = video.dataset?.lazyMime || '';
    if (lazyHls && video.canPlayType?.('application/vnd.apple.mpegurl')) {
      const hlsSource = doc.createElement('source');
      hlsSource.setAttribute('src', lazyHls);
      hlsSource.setAttribute('type', 'application/vnd.apple.mpegurl');
      video.appendChild(hlsSource);
      if (lazySrc && lazySrc !== lazyHls) {
        const mp4Source = doc.createElement('source');
        mp4Source.setAttribute('src', lazySrc);
        mp4Source.setAttribute('type', lazyMime.startsWith('video/') ? lazyMime : 'video/mp4');
        video.appendChild(mp4Source);
      }
      changed = true;
    } else if (lazySrc) {
      video.src = lazySrc;
      video.setAttribute('src', lazySrc);
      changed = true;
    }
    if (video.dataset) {
      delete video.dataset.lazyHls;
      delete video.dataset.lazySrc;
      delete video.dataset.lazyMime;
    }
    if (changed) {
      video.preload = 'metadata';
      video.setAttribute('preload', 'metadata');
      try {
        video.load?.();
      } catch {
        // Ignore load errors in synthetic DOM
      }
    }
  }

  function pauseAllLoopsVideos() {
    activeLoopsSlide = null;
    for (const v of listEl.querySelectorAll('video.loops-video')) {
      try {
        v.pause?.();
      } catch {
        // Ignore pause errors in synthetic DOM
      }
    }
  }

  function syncLoopsSoundButtons() {
    for (const v of listEl.querySelectorAll('video.loops-video')) {
      v.muted = loopsMuted;
      if (loopsMuted) v.setAttribute?.('muted', '');
      else v.removeAttribute?.('muted');
    }
    for (const btn of listEl.querySelectorAll('.loops-sound-btn')) {
      btn.setAttribute('aria-pressed', loopsMuted ? 'false' : 'true');
      btn.setAttribute('aria-label', loopsMuted ? 'Unmute audio' : 'Mute audio');
      btn.innerHTML = loopsMuted ? VOLUME_MUTED_SVG : VOLUME_ON_SVG;
    }
  }

  function activateLoopsSlide(slideEl) {
    if (destroyed || !slideEl) return;
    if ((feedStore.get().activeStream || 'feed') !== 'video') return;
    activeLoopsSlide = slideEl;
    const targetVideo = slideEl.querySelector('video.loops-video');
    for (const v of listEl.querySelectorAll('video.loops-video')) {
      if (v !== targetVideo) {
        try {
          v.pause?.();
        } catch {
          // Ignore pause error
        }
      }
    }
    if (!targetVideo) return;
    hydrateLazyLoopsVideo(targetVideo);
    targetVideo.preload = 'auto';
    targetVideo.setAttribute?.('preload', 'auto');
    const nextVid = slideEl.nextElementSibling?.querySelector?.('video.loops-video');
    if (nextVid) hydrateLazyLoopsVideo(nextVid);
    targetVideo.muted = loopsMuted;
    if (loopsMuted) targetVideo.setAttribute?.('muted', '');
    else targetVideo.removeAttribute?.('muted');
    const stage = slideEl.querySelector('.loops-stage');
    const reducedMotion = Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
    if (!stage?.classList?.contains('is-blurred') && !stage?.classList?.contains('is-user-paused') && !reducedMotion) {
      try {
        targetVideo.play?.()?.catch?.(() => {});
      } catch {
        // Ignore autoplay rejection
      }
    }
  }

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
      const errNote = doc.createElement('span');
      errNote.className = 'feed-infinite-error';
      errNote.textContent = formatApiErrorMessage(appendError, 'Unable to load older posts.');
      footerStatusEl.append(retryBtn, errNote);
      return;
    }
    const st = feedStore.get();
    const sName = ALLOWED_STREAMS.has(st.activeStream) ? st.activeStream : 'feed';
    const b = st.streams[sName];
    if (
      sName !== 'video'
      && !inFlightRefresh
      && !activeHashtag
      && b?.nextCursor
      && (b.items?.length || 0) > 0
      && (sName !== 'following' || hasAnySocialAccount(authStore.get()))
    ) {
      const moreBtn = doc.createElement('button');
      moreBtn.type = 'button';
      moreBtn.className = 'btn-sleek-pill feed-load-more-btn';
      moreBtn.textContent = 'Load more posts';
      moreBtn.addEventListener('click', () => {
        lastAutoCursorSig = '';
        void loadStream(true);
      });
      footerStatusEl.appendChild(moreBtn);
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

  function persistActiveStreamIfNeeded() {
    const activeName = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
    void persistStreamCache(activeName).catch(() => {});
  }

  async function handleLike(post) {
    const cur = resolvePostInActiveBucket(post) || post;
    if (!getPostActionCapabilities(cur).like.enabled) return;
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
      persistActiveStreamIfNeeded();
      if (!wasLiked) {
        void recordAuthorInteraction(cur, cur?.protocol, 1);
        void recordBehavioralSignal(cur, 'like');
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
    if (!getPostActionCapabilities(cur).repost.enabled) return;
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
      if (!destroyed) persistActiveStreamIfNeeded();
      if (!wasReposted) {
        void recordAuthorInteraction(cur, cur?.protocol, 1.5);
        void recordBehavioralSignal(cur, 'repost');
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
    let sid = cur._meta?.mastodon?.statusId || cur.id;
    const bookmarked = Boolean(cur._meta?.mastodon?.bookmarked || cur.viewerState?.bookmarked);
    const optimistic = buildOptimisticReactionPost(cur, 'bookmark', !bookmarked);
    mutatePostAcrossStreams(postKey, () => optimistic);
    try {
      try {
        const homeOrigin = normalizeInstanceUrl(fedi.meta.instanceUrl);
        const itemOrigin = cur._meta?.mastodon?.instanceUrl
          ? normalizeInstanceUrl(cur._meta.mastodon.instanceUrl)
          : homeOrigin;
        if (itemOrigin !== homeOrigin && cur.url) {
          const searchRes = await searchFediverse({
            instanceUrl: homeOrigin,
            accessToken: fedi.secrets.accessToken,
            query: cur.url,
            type: 'statuses',
            resolve: true,
            limit: 1,
          }).catch(() => null);
          if (searchRes?.statuses?.[0]?.id) {
            sid = searchRes.statuses[0].id;
          }
        }
      } catch {
        // Ignore malformed instance URLs and fall back to statusId
      }
      const updated = await toggleBookmark({
        instanceUrl: fedi.meta.instanceUrl,
        accessToken: fedi.secrets.accessToken,
        statusId: sid,
        bookmarked,
      });
      if (destroyed) return;
      if (!bookmarked) {
        void recordAuthorInteraction(cur, 'mastodon', 1);
        void recordBehavioralSignal(cur, 'bookmark');
      }
      const curMasto = cur._meta?.mastodon || {};
      const nextBookmarked = Boolean(updated?.viewerState?.bookmarked ?? updated?.bookmarked ?? !bookmarked);
      mutatePostAcrossStreams(postKey, () => ({
        ...cur,
        _meta: {
          ...(cur._meta || {}),
          mastodon: {
            ...curMasto,
            bookmarked: nextBookmarked,
          },
        },
      }));
      persistActiveStreamIfNeeded();
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
    titleIn.setAttribute('autocomplete', 'off');
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
      searchIn.type = 'search';
      searchIn.className = 'onboarding-input';
      searchIn.placeholder = 'Add @user to list...';
      searchIn.setAttribute('autocomplete', 'off');
      searchIn.setAttribute('autocorrect', 'off');
      searchIn.setAttribute('autocapitalize', 'none');
      searchIn.setAttribute('spellcheck', 'false');
      const searchBtn = doc.createElement('button');
      searchBtn.type = 'submit';
      searchBtn.className = 'onboarding-btn';
      searchBtn.textContent = 'Find';
      addForm.append(searchIn, searchBtn);

      attachSearchSuggestions(searchIn, {
        anchorEl: addForm,
        debounceMs: 220,
        minChars: 2,
        maxItems: 6,
        fetchRemoteSuggestions: async (rawQ) => {
          const found = await searchAccountsAndPosts(rawQ).catch(() => ({ accounts: [] }));
          return (found.accounts || [])
            .filter((acc) => acc?.id && acc?.acct)
            .slice(0, 6)
            .map((acc) => ({
              kind: 'account',
              icon: 'account',
              label: acc.displayName || acc.username || acc.acct,
              sublabel: `@${acc.acct}`,
              value: acc.id,
            }));
        },
        onSelect: async (item) => {
          searchIn.value = '';
          await addAccountToMastodonList(listObj.id, item.value);
          searchResults.replaceChildren();
          await renderMembers(listObj);
        },
      });

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

  manageListsBtn.addEventListener('click', () => openManageListsModal());
  listSelect.addEventListener('change', () => {
    selectedListId = listSelect.value || '';
    void loadStream(false);
  });

  async function loadStream(append = false, { showSpinner = false, forceRefresh = false } = {}) {
    if (destroyed) return;
    await hydrateMetricsLedger();
    const state = feedStore.get();
    const streamName = ALLOWED_STREAMS.has(state.activeStream) ? state.activeStream : 'feed';
    const existingBucket = state.streams[streamName] || { items: [], nextCursor: null };
    const priorSeenIds = !append && forceRefresh && DISCOVERY_STREAMS.has(streamName)
      ? (existingBucket.items || []).map((it) => String(it?.id || it?.key || '')).filter(Boolean)
      : [];

    if (append) {
      if (loadingOlder || inFlightRefresh || !existingBucket.nextCursor) return;
    } else {
      requestEpoch += 1;
      inFlightRefresh = true;
      showRefreshSpinner = showSpinner;
      refreshStartedAt = showSpinner ? Date.now() : 0;
      loadingOlder = false;
      appendError = '';
      lastAutoCursorSig = '';
      if (forceRefresh) {
        if (scrollTarget) scrollTarget.scrollTop = 0;
        listEl.scrollTop = 0;
      }
      syncRefreshButton();
      syncInfiniteFooter();
    }

    const epoch = requestEpoch;
    const hadItems = existingBucket.items.length > 0;

    if (!append) {
      if (!hadItems) {
        setStreamLoading(true, null);
      }
      if (!initialStartupSettled && startupReadyPromise) {
        await Promise.allSettled([prefsHydrationPromise, startupReadyPromise]);
        initialStartupSettled = true;
      } else {
        await prefsHydrationPromise;
      }
      if (destroyed || epoch !== requestEpoch) return;
    }

    if (append) {
      loadingOlder = true;
      appendError = '';
      syncInfiniteFooter();
    }

    try {
      const [fediAuth, bskyAuth, threadsAuth] = await Promise.all([
        getAuthenticatedAccount('fediverse'),
        getAuthenticatedAccount('bluesky'),
        DISCOVERY_STREAMS.has(streamName) ? getAuthenticatedAccount('threads') : Promise.resolve(null),
      ]);
      if (destroyed || epoch !== requestEpoch) return;

      const curFilterAccSig = `${fediAuth?.meta?.id || ''}|${bskyAuth?.meta?.id || ''}`;
      if (!append && curFilterAccSig !== syncedFilterAccountsSig) {
        await fetchKeywordFilters().catch(() => {});
        syncedFilterAccountsSig = curFilterAccSig;
        if (destroyed || epoch !== requestEpoch) return;
      }

      if (!append && streamName === 'following' && (fediAuth || bskyAuth)) {
        void syncOwnViewerActivity({ fediAuth, bskyAuth })
          .then((entries) => {
            if (!destroyed && Array.isArray(entries) && entries.length > 0) {
              mergeDiscoveredViewerInteractions(entries);
            }
          })
          .catch(() => {});
      }

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
              limit: 40,
              ...(forceRefresh && !append ? { cache: 'no-store' } : {}),
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
              onSessionRefreshed: (tok) => updateAccountTokens(bskyAuth.meta.id, tok).catch(() => {}),
              cursor: append ? (curCursor.bsky || '') : '',
              limit: 50,
              ...(forceRefresh && !append ? { cache: 'no-store' } : {}),
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
            await hydrateCachedStream('following').catch(() => {});
            if (destroyed || epoch !== requestEpoch) return;
          }
          if ((feedStore.get().streams.following?.items?.length || 0) === 0) {
            setStreamLoading(false, firstError || 'Unable to load Following stream.');
          } else {
            setStreamLoading(false, null);
          }
          return;
        }

        const nextCursor = (nextFedi || nextBsky) ? { fedi: nextFedi, bsky: nextBsky } : null;
        if (append) appendStreamItems('following', combinedItems, nextCursor);
        else {
          warmHydratedStreams.delete('following');
          setStreamItems('following', combinedItems, nextCursor);
        }
        scheduleMetricsEnrichment(combinedItems, () => destroyed || epoch !== requestEpoch, 'following');
        void persistStreamCache('following').catch(() => {});
        return;
      }

      // Discovery streams ('feed', 'photos', 'video'): Unmediated Jetstream + FediDB + RankingManifest
      const latestState = feedStore.get();
      lastHarvestSourceSig = computeHarvestSourceSig(latestState.tuning);
      const discoveryMode = streamName === 'photos' || streamName === 'video' || streamName === 'visual'
        ? streamName
        : 'default';
      const prevCount = append ? (feedStore.get().streams[streamName]?.items?.length || 0) : 0;
      const harvestOpts = {
        fediAuth,
        bskyAuth,
        threadsAuth,
        tuning: latestState.tuning,
        manifest: latestState.rankingManifest,
        discoveryMode,
        interactedAuthors: latestState.interactedAuthors,
        tasteMemory: latestState.tasteMemory,
        moderatedActors: latestState.moderatedActors,
        filterRules: latestState.filters,
      };
      let harvested;
      try {
        harvested = await harvestSanctuaryFeed({
          ...harvestOpts,
          cursor: append ? curCursor : null,
          append,
          forceRefresh: Boolean(forceRefresh && !append),
        });
      } catch (harvestErr) {
        if (append && curCursor && Object.keys(curCursor).length > 1) {
          harvested = await harvestSanctuaryFeed({
            ...harvestOpts,
            cursor: { page: Math.max(1, Number(curCursor?.page || 1)) },
            append: true,
            forceRefresh: false,
          });
        } else {
          throw harvestErr;
        }
      }
      if (destroyed || epoch !== requestEpoch) return;

      if (Array.isArray(harvested?.viewerEntries) && harvested.viewerEntries.length > 0) {
        mergeDiscoveredViewerInteractions(harvested.viewerEntries);
      }

      let harvestedItems = Array.isArray(harvested?.items) ? harvested.items : [];
      let nextCursor = harvested?.nextCursor || null;
      let nextItems = harvestedItems;

      const latestSt = feedStore.get();
      const hasTasteSeed =
        (latestSt.tasteMemory?.positive?.length || 0) > 0
        || (latestSt.tasteMemory?.negative?.length || 0) > 0
        || (latestSt.streams?.following?.items?.length || 0) > 0
        || (latestSt.tuning?.discoveryChannels?.length || 0) > 0;
      const needPreScore =
        connectionStore.get().mode === 'online'
        && nextItems.length > 0
        && hasTasteSeed;
      if (needPreScore) {
        await scoreItemsWithNode(nextItems);
        if (destroyed || epoch !== requestEpoch) return;
      }

      if (append) {
        appendStreamItems(streamName, nextItems, nextCursor);
        const afterCount = feedStore.get().streams[streamName]?.items?.length || 0;
        if (afterCount === prevCount && nextCursor) {
          harvested = await harvestSanctuaryFeed({
            ...harvestOpts,
            cursor: nextCursor,
            append: true,
            forceRefresh: false,
          });
          if (destroyed || epoch !== requestEpoch) return;
          if (Array.isArray(harvested?.viewerEntries) && harvested.viewerEntries.length > 0) {
            mergeDiscoveredViewerInteractions(harvested.viewerEntries);
          }
          harvestedItems = Array.isArray(harvested?.items) ? harvested.items : [];
          nextCursor = harvested?.nextCursor || null;
          nextItems = harvestedItems;
          if (needPreScore && nextItems.length > 0) {
            await scoreItemsWithNode(nextItems);
            if (destroyed || epoch !== requestEpoch) return;
          }
          appendStreamItems(streamName, nextItems, nextCursor);
        }
      } else {
        warmHydratedStreams.delete(streamName);
        setStreamItems(streamName, nextItems, nextCursor, {
          shuffleSeed: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
          deprioritizeIds: priorSeenIds,
        });
      }
      scheduleMetricsEnrichment(nextItems, () => destroyed || epoch !== requestEpoch, streamName);
      void persistStreamCache(streamName).catch(() => {});
      if (!needPreScore && nextItems.length > 0) {
        void scoreItemsWithNode(nextItems);
      }
    } catch (err) {
      if (destroyed || epoch !== requestEpoch) return;
      console.warn('[feed] loadStream error:', err?.message || err);
      if (append) {
        appendError = err?.message || 'Unable to load older posts.';
      } else {
        if ((feedStore.get().streams[streamName]?.items?.length || 0) === 0) {
          await hydrateCachedStream(streamName).catch(() => {});
          if (destroyed || epoch !== requestEpoch) return;
        }
        if ((feedStore.get().streams[streamName]?.items?.length || 0) === 0) {
          setStreamLoading(false, err?.message || 'Unable to load timeline');
        } else {
          setStreamLoading(false, null);
        }
      }
    } finally {
      if (epoch === requestEpoch) {
        if (append) loadingOlder = false;
        else {
          if (showSpinner && refreshStartedAt > 0) {
            const elapsed = Date.now() - refreshStartedAt;
            const remaining = Math.max(0, 550 - elapsed);
            if (remaining > 0) {
              await new Promise((resolve) => setTimeout(resolve, remaining));
            }
          }
          if (epoch === requestEpoch) {
            inFlightRefresh = false;
            syncRefreshButton();
            syncInfiniteFooter();
          }
        }
        if (!append) {
          clearTimeout(autoCheckTimer);
        } else {
          syncRefreshButton();
          syncInfiniteFooter();
        }
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
        }, append ? 120 : 0);
      }
    }
  }

  function buildCardForPost(key, initialPost, showSanctuary, hasMasto, hasBsky, hasThreads, streamVariant = 'default', slideIdx = 0) {
    const getLivePost = () => cardCache.get(key)?.post || initialPost;
    const postProto = initialPost?.protocol || (initialPost?.network === 'bluesky' ? 'bluesky' : initialPost?.network === 'threads' ? 'threads' : 'mastodon');
    const canModerateProto = Boolean(initialPost?.author?.id || initialPost?.author?.handle);
    const commonHandlers = {
      onReply: () => {
        const p = getLivePost();
        void recordAuthorInteraction(p, p?.protocol, 1.8);
        void recordBehavioralSignal(p, 'reply');
        prefillReply(p);
      },
      onToggleLike: () => void handleLike(getLivePost()),
      onToggleRepost: () => void handleRepost(getLivePost()),
      onToggleBookmark: () => void handleBookmark(getLivePost()),
      onOpenThread: onOpenPostThread
        ? (target) => {
            const resolved = target && target !== initialPost ? target : getLivePost();
            onOpenPostThread(resolved);
          }
        : undefined,
      onAskSanctuary: onAskSanctuary
        ? () => {
            const p = getLivePost();
            void recordAuthorInteraction(p, p?.protocol, 1.5);
            void recordBehavioralSignal(p, 'share_sanctuary');
            onAskSanctuary(p);
          }
        : undefined,
      onSelectAuthor: onSelectAuthor
        ? (author, item) => {
            const p = item || getLivePost();
            onSelectAuthor(author, p);
          }
        : undefined,
      onEditPost: ((hasMasto && postProto === 'mastodon') || (authStore.get().isBlueskyConnected && postProto === 'bluesky')) ? () => {
        const p = getLivePost();
        openEditPostDialog(p, {
          onSaved: (updated) => mutatePostAcrossStreams(
            (it) => it?.id === p.id || it?.key === p.key || it?.id === updated?.id,
            () => updated
          ),
        });
      } : null,
      onDeletePost: () => {
        const p = getLivePost();
        const linked = p._meta?.linkedIds || {};
        const targets = [
          p.protocol === 'mastodon' || linked.mastodonStatusId ? 'Mastodon' : '',
          linked.blueskyUri || p.protocol === 'bluesky' ? 'Bluesky' : '',
          linked.threadsPostId || p.protocol === 'threads' ? 'Threads' : '',
        ].filter(Boolean);
        showConfirm(
          'Delete Post',
          targets.length > 1
            ? `Delete this post from ${targets.join(', ')}?`
            : `Delete this ${targets[0] || ''} post?`,
          async () => {
            const res = await deleteUnified(p);
            removePostAcrossStreams(p.id || p.key);
            if (res?.warnings?.length > 0) {
              showAlert('Bridge Delete Warning', res.warnings.join('\n\n'));
            }
          }
        );
      },
      onInterested: () => {
        void applyPostInterestFeedback(getLivePost(), 'interested').then(() => {
          if (!destroyed) persistActiveStreamIfNeeded();
        });
      },
      onNotInterested: () => void applyPostInterestFeedback(getLivePost(), 'not_interested'),
      onMuteAuthor: canModerateProto ? (_raw, u) => {
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
            const modActors = feedStore.get().moderatedActors || [];
            removeActivityByActor(u.author, u.protocol);
            removePostAcrossStreams(
              (item) =>
                isUnifiedItemModerated(item, modActors)
                || item?.author?.handle === u.author.handle
                || (u.author.id && item?.author?.id === u.author.id)
            );
          } catch (err) {
            showAlert('Moderation Error', formatApiErrorMessage(err?.message, 'Unable to mute account.'));
          }
        });
      } : null,
      onBlockAuthor: canModerateProto ? (_raw, u) => {
        const cleanH = String(u?.author?.handle || '').replace(/^@/, '');
        if (!u?.author?.id && !cleanH) return;
        showConfirm('Block Account', `Block @${cleanH || u.author.id}?`, async () => {
          try {
            await toggleBlockAuthor(u.author.id || cleanH, false, {
              protocol: u.protocol,
              acct: cleanH,
              displayName: u.author.name || cleanH,
              instanceUrl: u._meta?.mastodon?.instanceUrl || '',
            });
            const modActors = feedStore.get().moderatedActors || [];
            removeActivityByActor(u.author, u.protocol);
            removePostAcrossStreams(
              (item) =>
                isUnifiedItemModerated(item, modActors)
                || item?.author?.handle === u.author.handle
                || (u.author.id && item?.author?.id === u.author.id)
            );
          } catch (err) {
            showAlert('Moderation Error', formatApiErrorMessage(err?.message, 'Unable to block account.'));
          }
        });
      } : null,
      showSanctuaryAction: showSanctuary,
    };

    if (streamVariant === 'loops') {
      return createLoopsSlide(initialPost, {
        ...commonHandlers,
        isFirstSlide: slideIdx === 0,
        initialMuted: loopsMuted,
        onToggleSound: () => {
          loopsMuted = !loopsMuted;
          syncLoopsSoundButtons();
        },
        onRequestPlay: (slideEl) => activateLoopsSlide(slideEl),
      });
    }

    return createPostCard(initialPost, {
      ...commonHandlers,
      onTogglePin: hasMasto && postProto === 'mastodon' ? async () => {
        const p = getLivePost();
        const updated = await pinUnified(p, Boolean(p._meta?.mastodon?.pinned));
        if (updated) mutatePostAcrossStreams(p.id || p.key, () => updated);
      } : null,
      onRetryBridge: (retryEntry) => {
        void runBridgeRetry(retryEntry.id).catch((err) => {
          showAlert('Bridge Retry Failed', err?.message || 'Unable to retry bridge sync.');
        });
      },
      layoutVariant: streamVariant,
      mediaPriority: slideIdx === 0 ? 'high' : (slideIdx < 3 ? 'eager' : 'lazy'),
    });
  }

  function resolveStableOrderedItems(streamName, bucket, state) {
    const isDiscovery = DISCOVERY_STREAMS.has(streamName);
    const ownAccountKeys = isDiscovery ? buildOwnAccountKeySet(authStore.get().accounts || []) : null;
    const rawItems = (Array.isArray(bucket?.items) ? bucket.items : [])
      .filter(
        (p) =>
          (!isDiscovery || !isOwnOrSelfBoostedUnifiedItem(p, ownAccountKeys))
          && (streamName !== 'feed' || !hasVisualMediaAttachment(p))
      );
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
    const curUserEpoch = Number(state.userTuningEpoch || 0);
    const tuningSig = computeTuningSig(state.tuning, state.rankingManifest);
    let order = streamOrders.get(streamName);

    const isReRank = Boolean(order && order.generation === gen && order.userTuningEpoch !== curUserEpoch);
    const effectiveDiscoveryTaste = isDiscovery
      ? mergeTasteMemoryWithFollowing(state.tasteMemory, state.streams?.following?.items)
      : undefined;
    if (!order || order.generation !== gen || order.userTuningEpoch !== curUserEpoch) {
      if (isReRank && scrollTarget) {
        scrollTarget.scrollTop = 0;
      }
      const ranked = rankFeedItems(rawItems, state.tuning, {
        nowMs: bucket.updatedAt || Date.now(),
        shuffleSeed: isDiscovery ? (bucket.shuffleSeed || '') : '',
        deprioritizeIds: isDiscovery ? bucket.deprioritizeIds : undefined,
        streamMode: isDiscovery ? 'feed' : streamName,
        discoveryMode: streamName,
        manifest: state.rankingManifest,
        interactedAuthors: state.interactedAuthors,
        semanticScores: state.semanticScores,
        tasteScores: isDiscovery ? state.tasteScores : undefined,
        tasteMemory: effectiveDiscoveryTaste,
      });
      order = {
        generation: gen,
        userTuningEpoch: curUserEpoch,
        tuningSig,
        orderedIds: ranked.map((p) => String(p?.id || p?.key || '')).filter(Boolean),
        seenIds: new Set(byId.keys()),
      };
      streamOrders.set(streamName, order);
    } else {
      order.tuningSig = tuningSig;
      order.userTuningEpoch = curUserEpoch;
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
          shuffleSeed: '',
          streamMode: isDiscovery ? 'feed' : streamName,
          discoveryMode: streamName,
          manifest: state.rankingManifest,
          interactedAuthors: state.interactedAuthors,
          semanticScores: state.semanticScores,
          tasteScores: isDiscovery ? state.tasteScores : undefined,
          tasteMemory: effectiveDiscoveryTaste,
        });
        for (const p of rankedAppended) {
          const id = String(p?.id || p?.key || '');
          if (id) order.orderedIds.push(id);
        }
      }
    }

    const dismissed = new Set(state.dismissedPostIds || []);
    let ordered = order.orderedIds
      .filter((id) => !dismissed.has(id))
      .map((id) => byId.get(id))
      .filter(Boolean);
    const keepBotsExplicitly = state.rankingManifest?.caps?.filterDiscoveryBotsByDefault === false;
    if (isDiscovery && !keepBotsExplicitly) {
      ordered = ordered.filter(
        (p) => p?._meta?.feedSource === 'following' || !isAutomatedSyndicationOrBotItem(p, state.rankingManifest)
      );
    }
    const contextualized = resolveContextualStreamItems(ordered, { streamMode: isDiscovery ? 'feed' : streamName });
    return applyKeywordFilters(contextualized, state.filters || [], state.moderatedActors || []);
  }

  function reconcilePostList(visibleItems, { streamName = 'feed', showSanctuary, hasMasto, hasBsky, hasThreads = false, retrySig = '', manifestSig = '', isLoading, errorMsg }) {
    if (visibleItems.length === 0) {
      clearCardCache();
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

    const activeKeys = new Set();
    const keyedEntries = visibleItems.map((post, idx) => {
      const key = String(post?.id || post?.key || `row-${idx}`);
      activeKeys.add(key);
      return { post, key };
    });

    for (const [cachedKey, entry] of [...cardCache.entries()]) {
      if (!activeKeys.has(cachedKey)) {
        unobserveCardLoops(entry.card);
        entry.card.remove();
        cardCache.delete(cachedKey);
      }
    }

    const liveCachedNodes = new Set();
    for (const entry of cardCache.values()) {
      if (entry?.card) liveCachedNodes.add(entry.card);
    }
    for (const child of [...listEl.children]) {
      if (!liveCachedNodes.has(child)) {
        unobserveCardLoops(child);
        child.remove();
      }
    }

    const canMoveBefore =
      Object.hasOwn(globalThis.Element?.prototype || {}, 'moveBefore') &&
      typeof listEl.moveBefore === 'function';

    const streamVariant = streamName === 'video'
      ? 'loops'
      : (streamName === 'photos' ? 'ig_photo' : 'default');
    const prevActiveKey = activeLoopsSlide?.dataset?.postKey || activeLoopsSlide?.dataset?.postId || '';
    for (let idx = 0; idx < keyedEntries.length; idx += 1) {
      const { post, key } = keyedEntries[idx];
      const structSig = computePostStructureSig(post, showSanctuary, hasMasto, hasBsky, hasThreads, retrySig, manifestSig, streamVariant);
      const reactSig = computePostReactionSig(post);
      const existing = cardCache.get(key);
      let cardEl = existing?.card || null;
      if (!existing || existing.structSig !== structSig) {
        if (existing?.card) unobserveCardLoops(existing.card);
        const nextCard = buildCardForPost(key, post, showSanctuary, hasMasto, hasBsky, hasThreads, streamVariant, idx);
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
      cardEl.classList.toggle('is-below-fold', streamVariant !== 'loops' && idx >= 5);
      const currentAtIdx = listEl.children[idx] || null;
      if (currentAtIdx !== cardEl) {
        if (canMoveBefore && cardEl.parentNode === listEl) {
          try {
            listEl.moveBefore(cardEl, currentAtIdx);
          } catch {
            listEl.insertBefore(cardEl, currentAtIdx);
          }
        } else {
          listEl.insertBefore(cardEl, currentAtIdx);
        }
      }
      if (streamVariant === 'loops') {
        loopsSnapObserver?.observe?.(cardEl);
        loopsPreloadObserver?.observe?.(cardEl);
      } else {
        unobserveCardLoops(cardEl);
      }
    }
    while (listEl.children.length > keyedEntries.length) {
      const extra = listEl.lastElementChild;
      if (!extra) break;
      unobserveCardLoops(extra);
      extra.remove();
    }
    if (streamVariant === 'loops') {
      if (!activeLoopsSlide || activeLoopsSlide.parentNode !== listEl) {
        const matched = prevActiveKey
          ? [...listEl.querySelectorAll('.loops-slide')].find(
              (el) => el.dataset?.postKey === prevActiveKey || el.dataset?.postId === prevActiveKey
            )
          : null;
        const targetSlide = matched || listEl.querySelector('.loops-slide');
        if (targetSlide) activateLoopsSlide(targetSlide);
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
    const isLoops = streamName === 'video';

    root.dataset.stream = streamName;
    root.classList.toggle('is-loops-mode', isLoops);
    inlineComposeForm.hidden = streamName === 'photos' || isLoops;
    if (inlineComposeForm.hidden) {
      inlineStatusEl.hidden = true;
    }
    feedFooterWrap.hidden = isLoops;

    listEl.classList.toggle('is-loops-viewer', isLoops);
    if (isLoops) {
      listEl.setAttribute('role', 'region');
      listEl.setAttribute('aria-label', 'Loops video viewer');
      listEl.tabIndex = 0;
    } else {
      pauseAllLoopsVideos();
      listEl.removeAttribute('role');
      listEl.removeAttribute('aria-label');
      listEl.removeAttribute('tabindex');
    }

    composeAvatar.src = authState.accounts[0]?.avatar || DEFAULT_AVATAR_DATA_URI;

    for (const [key, btn] of tabButtons.entries()) {
      const active = streamName === key;
      const wasActive = btn.classList.contains('active');
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
      if (active && !wasActive) {
        try {
          btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest', container: 'nearest' });
        } catch {
          btn.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
        }
      }
    }

    const retries = Array.isArray(authState.retryQueue) ? authState.retryQueue : [];
    if (retries.length > 0) {
      retryBannerEl.hidden = false;
      retryBannerEl.replaceChildren();
      const firstRetry = retries[0];
      const msg = doc.createElement('span');
      msg.className = 'bridge-retry-msg';
      msg.textContent = `${firstRetry.protocol} bridge sync paused (${retries.length}): ${formatApiErrorMessage(firstRetry.lastError, 'temporary error')}`;
      const retryBtn = doc.createElement('button');
      retryBtn.type = 'button';
      retryBtn.className = 'btn-sleek-pill';
      retryBtn.textContent = 'Retry';
      retryBtn.addEventListener('click', () => {
        retryBtn.disabled = true;
        void runBridgeRetry(firstRetry.id)
          .catch((err) => showAlert('Bridge Retry Failed', formatApiErrorMessage(err?.message, 'Retry failed.')))
          .finally(() => { retryBtn.disabled = false; });
      });
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
    const hasThreads = authState.accounts.some((a) => a.platform === 'threads');
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
      clearCardCache();
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

    const isHashtagView = Boolean(activeHashtag && streamName === 'feed');
    hashtagBar.hidden = !isHashtagView;
    if (isHashtagView) {
      hashtagLabel.textContent = `#${activeHashtag}`;
    }

    const visibleItems = isHashtagView
      ? applyKeywordFilters(hashtagItems, state.filters || [], state.moderatedActors || [])
      : resolveStableOrderedItems(streamName, bucket, state);
    const showSanctuary = conn.mode === 'online' || conn.programs.length > 0;
    const manifestSig = JSON.stringify(state.rankingManifest || null);
    reconcilePostList(visibleItems, {
      streamName,
      showSanctuary,
      hasMasto,
      hasBsky,
      hasThreads,
      retrySig: getRetrySig(authState),
      manifestSig,
      isLoading: isHashtagView ? hashtagLoading : Boolean(state.loading),
      errorMsg: isHashtagView ? hashtagError : state.error,
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
    const rect = sentinelEl.getBoundingClientRect?.();
    const vh = Number(globalThis.innerHeight || doc.documentElement?.clientHeight || 0);
    if (rect && (rect.width > 0 || rect.height > 0) && vh > 0 && rect.top - vh <= INFINITE_SCROLL_THRESHOLD_PX) {
      return true;
    }
    const scrollH = Number(scrollTarget.scrollHeight || 0);
    const clientH = Number(scrollTarget.clientHeight || 0);
    const scrollT = Number(scrollTarget.scrollTop || 0);
    if (scrollH > 0 && clientH > 0 && scrollH - scrollT - clientH <= INFINITE_SCROLL_THRESHOLD_PX) {
      return true;
    }
    const rootEl = doc.documentElement;
    const docH = Number(rootEl?.scrollHeight || 0);
    const docClientH = Number(rootEl?.clientHeight || 0);
    const docScrollT = Number(rootEl?.scrollTop || globalThis.scrollY || 0);
    if (docH > 0 && docClientH > 0 && docH - docScrollT - docClientH <= INFINITE_SCROLL_THRESHOLD_PX) {
      return true;
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
  globalThis.addEventListener?.('scroll', handleScroll, { passive: true });

  function onLoopsListScroll() {
    if (destroyed || (feedStore.get().activeStream || 'feed') !== 'video') return;
    if (!canLoadOlder()) return;
    const scrollH = Number(listEl.scrollHeight || 0);
    const clientH = Number(listEl.clientHeight || 0);
    const scrollT = Number(listEl.scrollTop || 0);
    if (scrollH > 0 && clientH > 0 && scrollH - scrollT - clientH <= 800) {
      void loadStream(true);
    }
  }
  listEl.addEventListener('scroll', onLoopsListScroll, { passive: true });

  function onLoopsKeyDown(e) {
    if (destroyed || (feedStore.get().activeStream || 'feed') !== 'video') return;
    const tag = String(e.target?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const slides = [...listEl.querySelectorAll('.loops-slide')];
    if (slides.length === 0) return;
    const curIdx = Math.max(0, slides.indexOf(activeLoopsSlide));
    if (e.key === 'ArrowDown' || e.key === 'PageDown') {
      const next = slides[Math.min(slides.length - 1, curIdx + 1)];
      if (next && next !== activeLoopsSlide) {
        e.preventDefault();
        next.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        activateLoopsSlide(next);
      }
    } else if (e.key === 'ArrowUp' || e.key === 'PageUp') {
      const prev = slides[Math.max(0, curIdx - 1)];
      if (prev && prev !== activeLoopsSlide) {
        e.preventDefault();
        prev.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
        activateLoopsSlide(prev);
      }
    } else if (e.key === ' ' && (e.target === listEl || e.target?.classList?.contains?.('loops-slide'))) {
      e.preventDefault();
      const v = activeLoopsSlide?.querySelector?.('video.loops-video');
      const stage = activeLoopsSlide?.querySelector?.('.loops-stage');
      if (v && !stage?.classList?.contains('is-blurred')) {
        if (v.paused) {
          stage?.classList?.remove('is-user-paused');
          v.play?.()?.catch?.(() => {});
        } else {
          stage?.classList?.add('is-user-paused');
          v.pause?.();
        }
      }
    } else if (e.key === 'm' || e.key === 'M') {
      loopsMuted = !loopsMuted;
      syncLoopsSoundButtons();
    }
  }
  listEl.addEventListener('keydown', onLoopsKeyDown);

  const hasScrollSnapChange = Boolean(globalThis.HTMLElement && 'onscrollsnapchange' in globalThis.HTMLElement.prototype);
  const onLoopsSnapChange = hasScrollSnapChange
    ? (ev) => {
        if (destroyed || (feedStore.get().activeStream || 'feed') !== 'video') return;
        const slide = ev.snapTargetBlock?.closest?.('.loops-slide');
        if (slide) activateLoopsSlide(slide);
      }
    : null;
  if (onLoopsSnapChange) {
    listEl.addEventListener('scrollsnapchange', onLoopsSnapChange);
  }

  let intersectionObserver = null;
  if (typeof globalThis.IntersectionObserver === 'function') {
    if (!hasScrollSnapChange) {
      loopsSnapObserver = new globalThis.IntersectionObserver(
        (entries) => {
          if (destroyed || (feedStore.get().activeStream || 'feed') !== 'video') return;
          for (const entry of entries) {
            if (entry.isIntersecting && Number(entry.intersectionRatio ?? 1) >= 0.6) {
              activateLoopsSlide(entry.target);
            }
          }
        },
        { root: listEl, threshold: [0, 0.6] }
      );
    }
    loopsPreloadObserver = new globalThis.IntersectionObserver(
      (entries, observer) => {
        if (destroyed) return;
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const v = entry.target?.querySelector?.('video.loops-video');
          if (v) hydrateLazyLoopsVideo(v);
          observer.unobserve?.(entry.target);
        }
      },
      { root: listEl, rootMargin: '300px 0px' }
    );
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
      { root: null, rootMargin: `0px 0px ${INFINITE_SCROLL_THRESHOLD_PX}px 0px` }
    );
    intersectionObserver.observe(sentinelEl);
  }

  let prevSocialIdsSig = getSocialIdsSig(authStore.get());
  let prevAccountsUiSig = getAccountsUiSig(authStore.get());
  let prevRetrySig = getRetrySig(authStore.get());

  const unsubFeed = feedStore.subscribe((nextState) => {
    render();
    if (!prefsHydrated || destroyed) return;
    const activeName = ALLOWED_STREAMS.has(nextState?.activeStream) ? nextState.activeStream : 'feed';
    const nextUserEpoch = Number(nextState?.userTuningEpoch || 0);
    const userEpochChanged = nextUserEpoch !== lastUserTuningEpoch;
    lastUserTuningEpoch = nextUserEpoch;
    const nextSourceSig = computeHarvestSourceSig(nextState?.tuning);
    if (nextSourceSig !== lastHarvestSourceSig) {
      lastHarvestSourceSig = nextSourceSig;
      if (userEpochChanged && DISCOVERY_STREAMS.has(activeName) && !inFlightRefresh) {
        clearTimeout(sourceRefreshTimer);
        sourceRefreshTimer = setTimeout(() => {
          if (!destroyed && !inFlightRefresh) {
            void loadStream(false);
          }
        }, 300);
      }
    }
  });
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
      syncedFilterAccountsSig = '';
      void fetchKeywordFilters().catch(() => {});
      const activeName = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
      const curItems = feedStore.get().streams[activeName]?.items || [];
      render();
      if (
        !inFlightRefresh &&
        hasAnySocialAccount(nextAuth) &&
        ((activeName === 'following' && curItems.length === 0) || DISCOVERY_STREAMS.has(activeName))
      ) {
        void loadStream(false);
      }
      return;
    }
    render();
  });

  const onFeedReset = () => {
    if (destroyed || inFlightRefresh) return;
    for (const sName of DISCOVERY_STREAMS) streamOrders.delete(sName);
    const active = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
    if (DISCOVERY_STREAMS.has(active)) {
      void loadStream(false, { showSpinner: true, forceRefresh: true });
    }
  };
  const onManifestUpdated = () => {
    if (destroyed) return;
    streamOrders.clear();
    clearCardCache();
    render();
  };
  const onTasteReset = () => {
    if (destroyed) return;
    clearTimeout(tasteRescoreTimer);
  };
  async function openHashtagFeed(rawTag) {
    const cleanTag = String(rawTag || '').replace(/^#+/, '').trim();
    if (!cleanTag || destroyed) return;
    activeHashtag = cleanTag;
    hashtagItems = [];
    hashtagLoading = true;
    hashtagError = '';
    const hEpoch = ++hashtagRequestEpoch;
    if (feedStore.get().activeStream !== 'feed') {
      setActiveStream('feed');
    }
    render();
    try {
      const rows = await fetchHashtagPosts(cleanTag, { limit: 30 });
      if (destroyed || hEpoch !== hashtagRequestEpoch) return;
      hashtagItems = Array.isArray(rows) ? rows : [];
      hashtagLoading = false;
      render();
    } catch (err) {
      if (destroyed || hEpoch !== hashtagRequestEpoch) return;
      hashtagLoading = false;
      hashtagError = err?.message || `Unable to load #${cleanTag}.`;
      render();
    }
  }
  const onOpenHashtag = (e) => {
    if (destroyed) return;
    const tag = e?.detail?.tag;
    if (tag) void openHashtagFeed(tag);
  };
  const offVaultFeed = onSanctuaryEvent('sanctuary:vault-changed', (e) => {
    if (destroyed || !e?.detail?.unlocked || inFlightRefresh) return;
    void loadStream(false);
  });
  doc.addEventListener?.('sanctuary:open-hashtag', onOpenHashtag);
  globalThis.addEventListener?.('sanctuary:feed-reset', onFeedReset);
  globalThis.addEventListener?.('sanctuary:manifest-updated', onManifestUpdated);
  globalThis.addEventListener?.('sanctuary:taste-reset', onTasteReset);

  render();
  const initialStream = ALLOWED_STREAMS.has(feedStore.get().activeStream) ? feedStore.get().activeStream : 'feed';
  let idleWarmHydrateTimer = 0;
  const scheduleIdleMediaWarmHydrate = () => {
    clearTimeout(idleWarmHydrateTimer);
    idleWarmHydrateTimer = setTimeout(() => {
      if (destroyed) return;
      const curStreams = feedStore.get().streams || {};
      if ((curStreams.photos?.items?.length || 0) === 0) {
        void hydrateCachedStream('photos').then((ok) => { if (ok && !destroyed) warmHydratedStreams.add('photos'); }).catch(() => {});
      }
      if ((curStreams.video?.items?.length || 0) === 0) {
        void hydrateCachedStream('video').then((ok) => { if (ok && !destroyed) warmHydratedStreams.add('video'); }).catch(() => {});
      }
    }, 600);
  };
  if ((feedStore.get().streams[initialStream]?.items?.length || 0) === 0) {
    void loadStream(false).finally(() => {
      if (!destroyed) scheduleIdleMediaWarmHydrate();
    });
  } else {
    scheduleIdleMediaWarmHydrate();
  }

  return {
    refresh: () => loadStream(false),
    destroy() {
      destroyed = true;
      requestEpoch += 1;
      hashtagRequestEpoch += 1;
      clearTimeout(idleWarmHydrateTimer);
      doc.removeEventListener?.('sanctuary:open-hashtag', onOpenHashtag);
      globalThis.removeEventListener?.('sanctuary:feed-reset', onFeedReset);
      globalThis.removeEventListener?.('sanctuary:manifest-updated', onManifestUpdated);
      globalThis.removeEventListener?.('sanctuary:taste-reset', onTasteReset);
      clearTimeout(autoCheckTimer);
      clearTimeout(sourceRefreshTimer);
      clearTimeout(tasteRescoreTimer);
      detachPull();
      scrollTarget.removeEventListener('scroll', handleScroll);
      globalThis.removeEventListener?.('scroll', handleScroll);
      listEl.removeEventListener('scroll', onLoopsListScroll);
      listEl.removeEventListener('keydown', onLoopsKeyDown);
      if (onLoopsSnapChange) listEl.removeEventListener('scrollsnapchange', onLoopsSnapChange);
      pauseAllLoopsVideos();
      loopsSnapObserver?.disconnect();
      loopsPreloadObserver?.disconnect();
      intersectionObserver?.disconnect();
      cardCache.clear();
      streamOrders.clear();
      pendingReactions.clear();
      unsubFeed();
      unsubConn();
      unsubAuth();
      offVaultFeed();
    },
  };
}
