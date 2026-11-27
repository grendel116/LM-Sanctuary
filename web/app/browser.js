/* SPDX-License-Identifier: AGPL-3.0-or-later */

import { createClassicModalDialog, showAlert } from '../components/sanctuary/SanctuaryDialog.js';
import { openKeyBoxModal, openSettingsModal, promptUnlockVault } from '../components/sanctuary/SettingsModal.js';
import { attachSearchSuggestions } from '../components/SearchSuggestions.js';
import {
  NEWTAB_URL,
  SEARCH_ENGINES,
  buildSearchUrl,
  extractHostname,
  getSearchEngineLabel,
  normalizeSearchEngineId,
  resolveAddressBarInput,
  stripTrackingParams,
} from '../core/urlPrivacy.js';
import { sanitizeFediverseHtmlToString } from '../queries/fediverse.js';
import { fetchProjectSettings, fetchSanctuaryBrowserSuggest, ingestDatabankText } from '../queries/sanctuary.js';
import {
  autofillBrowserHostTab,
  captureBrowserTabPreview,
  connectKeePassXC,
  extractBrowserTabContent,
  fillKeePassXCLoginForUrl,
  getBrowserHostKind,
  getPasswordManagerStatus,
  loadBrowserTabPage,
  lockKeePassXCVault,
  openPrivateBrowserWindow,
  refreshKeePassStatus,
  stepBrowserHostHistory,
  subscribeBrowserHostEvents,
  syncBrowserHostLayout,
} from '../adapters/browserBridge.js';
import {
  browserStore,
  clearBrowserHistory,
  closeBrowserTab,
  focusBrowserPane,
  goBackBrowserTab,
  goForwardBrowserTab,
  isJavaScriptEnabledForUrl,
  isUrlBookmarked,
  moveBrowserTab,
  navigateBrowserTab,
  openBrowserTab,
  removeBookmark,
  selectBrowserTab,
  setPrivacySettings,
  setSearchConfig,
  setTabViewMode,
  toggleBookmark,
  toggleBrowserSplitView,
  toggleSiteJavaScript,
  updateBrowserTabResult,
} from '../state/browserStore.js';
import { connectionStore } from '../state/sanctuary/connection.js';

const BACK_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"></polyline></svg>`;
const FORWARD_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"></polyline></svg>`;
const RELOAD_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>`;
const HOME_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>`;
const SHIELD_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`;
const BOOKMARK_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"></path></svg>`;
const STAR_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`;
const SPLIT_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="12" y1="3" x2="12" y2="21"></line></svg>`;
const SANCTUARY_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 2 11 13"></path><path d="m22 2-7 20-4-9-9-4Z"></path></svg>`;
const CLIP_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`;
const SHARE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>`;
const REFUSAL_SVG = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>`;
const PLUS_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>`;
const CLOSE_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;
const PRIVATE_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 11c-1.5 0-2.5.5-3 2"></path><path d="M4 6a2 2 0 0 0-2 2v4a5 5 0 0 0 5 5 8 8 0 0 1 5 2 8 8 0 0 1 5-2 5 5 0 0 0 5-5V8a2 2 0 0 0-2-2h-3a8 8 0 0 0-5 2 8 8 0 0 0-5-2z"></path><path d="M6 11c1.5 0 2.5.5 3 2"></path></svg>`;

function installRovingFallback(container, getItems, { orientation = 'horizontal' } = {}) {
  if ('focusGroup' in (globalThis.HTMLElement?.prototype || {})) return;
  const syncTabs = () => {
    const items = getItems();
    const activeIdx = items.findIndex((el) => el.getAttribute('aria-selected') === 'true' || el.tabIndex === 0);
    items.forEach((el, i) => {
      el.tabIndex = i === (activeIdx >= 0 ? activeIdx : 0) ? 0 : -1;
    });
  };
  syncTabs();

  container.addEventListener('focusin', (event) => {
    const items = getItems();
    if (!items.includes(event.target)) return;
    items.forEach((el) => {
      el.tabIndex = el === event.target ? 0 : -1;
    });
  });

  container.addEventListener('keydown', (event) => {
    const items = getItems();
    if (items.length === 0) return;
    const currentIdx = items.indexOf(event.target);
    if (currentIdx === -1) return;

    const isVertical = orientation === 'vertical';
    let step = 0;
    if (!isVertical && event.key === 'ArrowRight') step = 1;
    else if (!isVertical && event.key === 'ArrowLeft') step = -1;
    else if (isVertical && event.key === 'ArrowDown') step = 1;
    else if (isVertical && event.key === 'ArrowUp') step = -1;
    else if (event.key === 'Home') step = -currentIdx;
    else if (event.key === 'End') step = items.length - 1 - currentIdx;
    else return;

    event.preventDefault();
    const nextIdx = (currentIdx + step + items.length) % items.length;
    const target = items[nextIdx];
    items.forEach((el) => {
      el.tabIndex = el === target ? 0 : -1;
    });
    target?.focus?.();
  });
}

function renderSafeReaderMarkdown(doc, articleBody, readerData, fallbackTitle = '') {
  articleBody.replaceChildren();
  const titleEl = doc.createElement('h1');
  titleEl.className = 'browser-reader-title';
  titleEl.textContent = readerData?.title || fallbackTitle || 'Reader View';
  articleBody.appendChild(titleEl);

  const metaEl = doc.createElement('p');
  metaEl.className = 'browser-reader-meta';
  metaEl.textContent = readerData?.siteName ? `${readerData.siteName} · ${readerData.url || ''}` : readerData?.url || '';
  articleBody.appendChild(metaEl);

  const mdText = String(readerData?.markdown || readerData?.excerpt || '').trim();
  if (!mdText) {
    const empty = doc.createElement('p');
    empty.className = 'browser-reader-empty';
    empty.textContent = 'No readable article body was extracted for this page.';
    articleBody.appendChild(empty);
    return;
  }

  const contentWrap = doc.createElement('div');
  contentWrap.className = 'browser-reader-content';
  if (typeof globalThis.marked?.parse === 'function') {
    const rawHtml = globalThis.marked.parse(mdText);
    contentWrap.innerHTML = sanitizeFediverseHtmlToString(rawHtml);
  } else {
    for (const block of mdText.split(/\n{2,}/)) {
      const clean = block.trim();
      if (!clean) continue;
      if (clean.startsWith('#')) {
        const heading = doc.createElement('h2');
        heading.textContent = clean.replace(/^#+\s*/, '');
        contentWrap.appendChild(heading);
      } else {
        const p = doc.createElement('p');
        p.textContent = clean;
        contentWrap.appendChild(p);
      }
    }
  }
  articleBody.appendChild(contentWrap);
}

/**
 * Mount the integrated obsidian-and-glass Browser workspace stage.
 */
export function mountBrowserScreen(
  containerEl,
  {
    onAskSanctuaryPage,
    onShareToFediverse,
  } = {}
) {
  const doc = globalThis.document;
  containerEl.replaceChildren();

  let destroyed = false;
  let isSyncingAddress = false;
  let isEditingAddress = false;
  let selectAddressOnMouseUp = false;
  let lastFocusedTabId = null;
  let lastLoadedUrlSig = new Map();
  const tabAbortMap = new Map();
  const steppingHistoryTabs = new Set();

  const root = doc.createElement('section');
  root.className = 'browser-screen';
  root.setAttribute('aria-label', 'Browser Workspace');

  // 1. Header: Single-row scrollable Tab Strip + Close/New Tab controls
  const stageHeader = doc.createElement('div');
  stageHeader.className = 'stage-header browser-stage-header';

  const tablistEl = doc.createElement('div');
  tablistEl.className = 'browser-tablist';
  tablistEl.setAttribute('role', 'tablist');
  tablistEl.setAttribute('focusgroup', 'tablist nomemory');
  tablistEl.setAttribute('aria-label', 'Browser tabs');

  const tabStripActions = doc.createElement('div');
  tabStripActions.className = 'browser-tabstrip-actions';

  const newTabBtn = doc.createElement('button');
  newTabBtn.type = 'button';
  newTabBtn.className = 'action-icon-btn browser-new-tab-btn';
  newTabBtn.setAttribute('aria-label', 'New tab');
  newTabBtn.title = 'New tab';
  newTabBtn.innerHTML = PLUS_SVG;

  const privateWindowBtn = doc.createElement('button');
  privateWindowBtn.type = 'button';
  privateWindowBtn.className = 'action-icon-btn browser-private-window-btn';
  privateWindowBtn.setAttribute('aria-label', 'New private window');
  privateWindowBtn.title = 'New Private Window';
  privateWindowBtn.innerHTML = PRIVATE_SVG;

  tabStripActions.append(privateWindowBtn);
  stageHeader.append(tabStripActions, tablistEl);

  // 2. Navigation Toolbar + Unified Search / Address Bar
  const controlsRow = doc.createElement('div');
  controlsRow.className = 'browser-controls-row';

  const toolbarEl = doc.createElement('div');
  toolbarEl.className = 'browser-toolbar';
  toolbarEl.setAttribute('role', 'toolbar');
  toolbarEl.setAttribute('focusgroup', 'toolbar wrap');
  toolbarEl.setAttribute('aria-label', 'Browser controls');

  const navGroup = doc.createElement('div');
  navGroup.className = 'browser-toolbar-group';
  navGroup.setAttribute('role', 'group');
  navGroup.setAttribute('aria-label', 'History');

  const backBtn = doc.createElement('button');
  backBtn.type = 'button';
  backBtn.className = 'action-icon-btn browser-back-btn';
  backBtn.setAttribute('aria-label', 'Back');
  backBtn.title = 'Back';
  backBtn.innerHTML = BACK_SVG;

  const forwardBtn = doc.createElement('button');
  forwardBtn.type = 'button';
  forwardBtn.className = 'action-icon-btn browser-forward-btn';
  forwardBtn.setAttribute('aria-label', 'Forward');
  forwardBtn.title = 'Forward';
  forwardBtn.innerHTML = FORWARD_SVG;

  const reloadBtn = doc.createElement('button');
  reloadBtn.type = 'button';
  reloadBtn.className = 'action-icon-btn browser-reload-btn';
  reloadBtn.setAttribute('aria-label', 'Reload');
  reloadBtn.title = 'Reload';
  reloadBtn.innerHTML = RELOAD_SVG;

  const homeBtn = doc.createElement('button');
  homeBtn.type = 'button';
  homeBtn.className = 'action-icon-btn browser-home-btn';
  homeBtn.setAttribute('aria-label', 'Home');
  homeBtn.title = 'Home';
  homeBtn.innerHTML = HOME_SVG;

  const shieldBtn = doc.createElement('button');
  shieldBtn.type = 'button';
  shieldBtn.className = 'action-icon-btn browser-shield-btn';
  shieldBtn.setAttribute('aria-label', 'Privacy Shield and Site Controls');
  shieldBtn.title = 'Privacy Shield & Site Controls';
  shieldBtn.setAttribute('popovertarget', 'browser-shield-popover');
  shieldBtn.setAttribute('aria-expanded', 'false');
  shieldBtn.setAttribute('aria-pressed', 'true');
  shieldBtn.innerHTML = SHIELD_SVG;

  const shieldBadge = doc.createElement('span');
  shieldBadge.className = 'browser-shield-count';
  shieldBadge.hidden = true;
  shieldBtn.appendChild(shieldBadge);

  navGroup.append(backBtn, forwardBtn, reloadBtn, homeBtn, shieldBtn);

  const addressForm = doc.createElement('form');
  addressForm.className = 'search-bar-form browser-address-form';
  addressForm.setAttribute('role', 'search');

  const addressInput = doc.createElement('input');
  addressInput.type = 'text';
  addressInput.id = 'browser-address-input';
  addressInput.className = 'onboarding-input browser-address-input';
  addressInput.placeholder = 'Search or enter address (github:, arxiv:, hn:, wikipedia:)…';
  addressInput.setAttribute('aria-label', 'Search or enter address');
  addressInput.setAttribute('autocomplete', 'off');
  addressInput.setAttribute('autocorrect', 'off');
  addressInput.setAttribute('autocapitalize', 'none');
  addressInput.setAttribute('spellcheck', 'false');

  addressInput.addEventListener('focus', () => {
    selectAddressOnMouseUp = true;
    addressInput.select?.();
  });
  addressInput.addEventListener('mouseup', (e) => {
    if (!selectAddressOnMouseUp) return;
    selectAddressOnMouseUp = false;
    e.preventDefault?.();
    addressInput.select?.();
  });
  addressInput.addEventListener('input', () => {
    selectAddressOnMouseUp = false;
    isEditingAddress = true;
  });
  addressInput.addEventListener('blur', () => {
    selectAddressOnMouseUp = false;
    isEditingAddress = false;
  });
  addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      isEditingAddress = false;
      const tab = getFocusedTab();
      addressInput.value = !tab || tab.url === NEWTAB_URL ? '' : tab.url;
      addressInput.blur?.();
    }
  });

  addressForm.appendChild(addressInput);

  const BANG_PREFIXES = [
    { prefix: 'github:', label: 'github:', sublabel: 'Search GitHub repositories' },
    { prefix: 'arxiv:', label: 'arxiv:', sublabel: 'Search arXiv papers' },
    { prefix: 'hn:', label: 'hn:', sublabel: 'Search Hacker News' },
    { prefix: 'wikipedia:', label: 'wikipedia:', sublabel: 'Search Wikipedia' },
  ];

  function buildBrowserLocalSuggestions(rawQuery) {
    const q = String(rawQuery || '').trim().toLowerCase();
    if (!q) return [];
    const st = browserStore.get();
    const out = [];

    for (const b of BANG_PREFIXES) {
      if (b.prefix.startsWith(q) || q.startsWith(b.prefix)) {
        out.push({ kind: 'bang', label: b.label, sublabel: b.sublabel, value: b.prefix });
      }
    }
    for (const t of st.tabs || []) {
      if (!t || t.isPrivate || !t.url || t.url === NEWTAB_URL) continue;
      if ((t.title || '').toLowerCase().includes(q) || t.url.toLowerCase().includes(q)) {
        out.push({ kind: 'tab', label: t.title || t.url, sublabel: `Switch to tab · ${t.url}`, value: t.url, tabId: t.id });
      }
    }
    for (const bm of st.bookmarks || []) {
      if (!bm?.url) continue;
      if ((bm.title || '').toLowerCase().includes(q) || bm.url.toLowerCase().includes(q)) {
        out.push({ kind: 'bookmark', label: bm.title || bm.url, sublabel: bm.url, value: bm.url });
      }
    }
    return out;
  }

  async function fetchBrowserRemoteSuggestions(rawQuery, isPrivate = false) {
    const q = String(rawQuery || '').trim();
    if (!q || isPrivate) return [];
    if (/^(?:https?:\/\/|localhost[:/]|about:|github:|arxiv:|hn:|wikipedia:|@)/i.test(q) || /^[^\s]+\.[a-z]{2,}(?:\/|$)/i.test(q)) {
      return [];
    }
    const engine = browserStore.get().searchConfig?.engine;
    if (!engine) return [];
    const suggestions = await fetchSanctuaryBrowserSuggest(q, engine);
    return suggestions.map((s) => ({ kind: 'search', label: s, value: s }));
  }

  function handleBrowserSuggestionSelect(item, inputTarget, targetTabId = null) {
    if (!item) return;
    if (item.kind === 'tab' && item.tabId) {
      selectBrowserTab(item.tabId);
      return;
    }
    if (item.kind === 'bang') {
      inputTarget.value = `${item.value} `;
      inputTarget.focus?.();
      return;
    }
    if (item.kind === 'bookmark') {
      isEditingAddress = false;
      submitQueryOrUrl(item.value, targetTabId);
      return;
    }
    isEditingAddress = false;
    inputTarget.value = item.value;
    submitQueryOrUrl(item.value, targetTabId);
  }

  const addressSuggest = attachSearchSuggestions(addressInput, {
    anchorEl: addressForm,
    getLocalSuggestions: (q) => buildBrowserLocalSuggestions(q),
    fetchRemoteSuggestions: (q) => fetchBrowserRemoteSuggestions(q, Boolean(getFocusedTab()?.isPrivate)),
    onSelect: (item) => handleBrowserSuggestionSelect(item, addressInput, null),
    onOpenChange: () => pushNativeViewportLayout(),
  });

  const actionGroup = doc.createElement('div');
  actionGroup.className = 'browser-toolbar-group';
  actionGroup.setAttribute('role', 'group');
  actionGroup.setAttribute('aria-label', 'Bookmarks and Sanctuary');

  const bookmarkStarBtn = doc.createElement('button');
  bookmarkStarBtn.type = 'button';
  bookmarkStarBtn.className = 'action-icon-btn browser-bookmark-btn';
  bookmarkStarBtn.setAttribute('aria-label', 'Bookmark page');
  bookmarkStarBtn.title = 'Bookmark page';
  bookmarkStarBtn.setAttribute('aria-pressed', 'false');
  bookmarkStarBtn.innerHTML = BOOKMARK_SVG;

  const bookmarksListBtn = doc.createElement('button');
  bookmarksListBtn.type = 'button';
  bookmarksListBtn.className = 'action-icon-btn browser-bookmarks-list-btn';
  bookmarksListBtn.setAttribute('aria-label', 'Open bookmarks');
  bookmarksListBtn.title = 'Bookmarks';
  bookmarksListBtn.innerHTML = STAR_SVG;

  const splitViewBtn = doc.createElement('button');
  splitViewBtn.type = 'button';
  splitViewBtn.className = 'action-icon-btn browser-split-btn';
  splitViewBtn.setAttribute('aria-label', 'Split browser view');
  splitViewBtn.title = 'Split View (2 tabs)';
  splitViewBtn.setAttribute('aria-pressed', 'false');
  splitViewBtn.innerHTML = SPLIT_SVG;

  const askSanctuaryBtn = doc.createElement('button');
  askSanctuaryBtn.type = 'button';
  askSanctuaryBtn.className = 'action-icon-btn browser-ask-sanctuary-btn';
  askSanctuaryBtn.setAttribute('aria-label', 'Ask Sanctuary about this page');
  askSanctuaryBtn.title = 'Ask Sanctuary';
  askSanctuaryBtn.innerHTML = SANCTUARY_SVG;

  const clipDatabankBtn = doc.createElement('button');
  clipDatabankBtn.type = 'button';
  clipDatabankBtn.className = 'action-icon-btn browser-clip-databank-btn';
  clipDatabankBtn.setAttribute('aria-label', 'Save page to Data Bank');
  clipDatabankBtn.title = 'Clip to Data Bank';
  clipDatabankBtn.innerHTML = CLIP_SVG;

  const shareFediverseBtn = doc.createElement('button');
  shareFediverseBtn.type = 'button';
  shareFediverseBtn.className = 'action-icon-btn browser-share-fediverse-btn';
  shareFediverseBtn.setAttribute('aria-label', 'Share page to Fediverse');
  shareFediverseBtn.title = 'Share to Fediverse';
  shareFediverseBtn.innerHTML = SHARE_SVG;

  actionGroup.append(
    bookmarkStarBtn,
    bookmarksListBtn,
    splitViewBtn,
    askSanctuaryBtn,
    clipDatabankBtn,
    shareFediverseBtn
  );

  toolbarEl.append(navGroup, addressForm, actionGroup);
  controlsRow.append(toolbarEl);

  // Live status region placed OUTSIDE role="toolbar"
  const liveStatusEl = doc.createElement('p');
  liveStatusEl.className = 'sr-only browser-live-status';
  liveStatusEl.setAttribute('role', 'status');
  liveStatusEl.setAttribute('aria-live', 'polite');

  function announce(msg) {
    liveStatusEl.textContent = String(msg || '');
  }

  // Privacy Shield Popover (native popover="auto" + manual fallback)
  const shieldPopover = doc.createElement('div');
  shieldPopover.id = 'browser-shield-popover';
  shieldPopover.className = 'browser-shield-popover';
  shieldPopover.setAttribute('popover', 'auto');
  const hasNativePopover = typeof shieldPopover.togglePopover === 'function';
  if (!hasNativePopover) {
    shieldPopover.hidden = true;
  }

  function setShieldPopoverFallback(open) {
    shieldPopover.hidden = !open;
    shieldPopover.classList.toggle('is-fallback-open', Boolean(open));
    shieldBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    pushNativeViewportLayout();
  }

  function closeShieldPopover() {
    if (hasNativePopover) {
      shieldPopover.hidePopover?.();
    } else {
      setShieldPopoverFallback(false);
    }
  }

  if (hasNativePopover) {
    shieldPopover.addEventListener('toggle', (ev) => {
      const open = ev.newState === 'open';
      shieldBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) renderShieldPopover();
      pushNativeViewportLayout();
    });
  } else {
    shieldBtn.addEventListener('click', () => {
      const willOpen = shieldPopover.hidden;
      if (willOpen) renderShieldPopover();
      setShieldPopoverFallback(willOpen);
    });
  }

  // 3. Browser Panes Stage (1-up or 2-up Split View)
  const panesGrid = doc.createElement('div');
  panesGrid.className = 'browser-panes-grid';

  root.append(stageHeader, controlsRow, shieldPopover, liveStatusEl, panesGrid);
  containerEl.appendChild(root);

  function pushNativeViewportLayout(state = browserStore.get()) {
    if (destroyed || getBrowserHostKind() === 'web-companion') return;
    const isStageVisible = !containerEl?.hidden && !root.closest?.('[hidden]');
    const hasOpenPopover = Boolean(
      shieldPopover.classList.contains('is-fallback-open') || shieldPopover.matches?.(':popover-open')
    );
    const hasOpenSuggest = Boolean(
      !addressForm.querySelector('.search-suggest-dropdown')?.hidden && addressForm.classList.contains('is-suggest-open')
    );
    const hasOpenDialog = Boolean(doc.querySelector?.('dialog[open]'));
    const overlayOpen = hasOpenPopover || hasOpenDialog || hasOpenSuggest;
    const panes = Array.from(panesGrid.querySelectorAll('.browser-pane-viewport')).map((el) => {
      const rect = typeof el.getBoundingClientRect === 'function'
        ? el.getBoundingClientRect()
        : { left: 0, top: 0, width: 0, height: 0 };
      return {
        tabId: el.dataset.nativeTabId,
        pane: el.dataset.pane,
        x: Math.round(rect.left || 0),
        y: Math.round(rect.top || 0),
        width: Math.round(rect.width || 0),
        height: Math.round(rect.height || 0),
      };
    });
    if (isStageVisible && !overlayOpen && panes.length > 0 && panes.every((p) => p.width <= 0 || p.height <= 0)) {
      return;
    }
    syncBrowserHostLayout({
      active: Boolean(isStageVisible && !overlayOpen),
      overlayOpen,
      panes,
      focusedPane: state.focusedPane,
    });
  }

  function getFocusedTab(state = browserStore.get()) {
    const targetId = state.focusedPane === 'split' && state.splitTabId
      ? state.splitTabId
      : state.activeTabId;
    return state.tabs.find((t) => t.id === targetId) || state.tabs[0] || null;
  }

  let lastKpRefreshAt = 0;
  let kpActionBusy = false;
  const tabPreviewMap = new Map();
  let lastPreviewWarmAt = 0;

  function applyViewportPreview(tabId, dataUrl) {
    if (!tabId || !dataUrl) return;
    tabPreviewMap.set(tabId, dataUrl);
    for (const vp of panesGrid.querySelectorAll(`.browser-pane-viewport[data-native-tab-id="${tabId}"]`)) {
      let img = vp.querySelector('.browser-pane-snapshot');
      if (!img) {
        img = doc.createElement('img');
        img.className = 'browser-pane-snapshot';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        vp.appendChild(img);
      }
      if (img.src !== dataUrl) {
        img.src = dataUrl;
      }
    }
  }

  function warmVisibleTabPreviews() {
    if (destroyed || getBrowserHostKind() !== 'gecko-desktop') return;
    const now = Date.now();
    if (now - lastPreviewWarmAt < 1200) return;
    lastPreviewWarmAt = now;
    for (const vp of panesGrid.querySelectorAll('.browser-pane-viewport')) {
      const tabId = vp.dataset.nativeTabId;
      if (!tabId) continue;
      void captureBrowserTabPreview(tabId).then((res) => {
        if (!destroyed && res?.ok && res.dataUrl) {
          applyViewportPreview(tabId, res.dataUrl);
        }
      });
    }
  }

  controlsRow.addEventListener('pointerenter', warmVisibleTabPreviews);
  stageHeader.addEventListener('pointerenter', warmVisibleTabPreviews);

  function renderShieldPopover() {
    shieldPopover.replaceChildren();
    const state = browserStore.get();
    const activeTab = getFocusedTab(state);
    const host = extractHostname(activeTab?.url);
    const jsEnabled = isJavaScriptEnabledForUrl(activeTab?.url, state.privacy);

    const heading = doc.createElement('h3');
    heading.className = 'browser-popover-title';
    heading.textContent = host ? `Shield · ${host}` : 'Privacy Shield';

    // Section 1: Tracker & Script Blocking
    const shieldSection = doc.createElement('div');
    shieldSection.className = 'browser-popover-section';

    const levelLabel = doc.createElement('div');
    levelLabel.className = 'browser-popover-label';
    levelLabel.textContent = 'Ad & Tracker Blocking';

    const levelRow = doc.createElement('div');
    levelRow.className = 'browser-shield-levels';
    for (const lvl of [
      { id: 'balanced', label: 'Balanced' },
      { id: 'strict', label: 'Strict' },
      { id: 'off', label: 'Off' },
    ]) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'edit-btn browser-shield-level-btn';
      btn.dataset.shieldLevel = lvl.id;
      btn.setAttribute('aria-pressed', state.privacy.shieldLevel === lvl.id ? 'true' : 'false');
      btn.textContent = lvl.label;
      btn.addEventListener('click', () => {
        setPrivacySettings({ shieldLevel: lvl.id });
        renderShieldPopover();
        announce(`Privacy shield set to ${lvl.label}`);
      });
      levelRow.appendChild(btn);
    }

    const statsRow = doc.createElement('p');
    statsRow.className = 'browser-popover-note';
    const blockedCount = Number(activeTab?.blockedCount || 0);
    statsRow.textContent = `Tracking query parameters stripped · GPC enabled · ${blockedCount} item${blockedCount === 1 ? '' : 's'} stripped on this page`;

    const jsLabel = doc.createElement('label');
    jsLabel.className = 'switch-container browser-js-switch';
    const jsTextGroup = doc.createElement('span');
    jsTextGroup.className = 'switch-label-group';
    const jsTitle = doc.createElement('span');
    jsTitle.className = 'switch-title';
    jsTitle.textContent = host ? `JavaScript on ${host}` : 'JavaScript (Default)';
    const jsSub = doc.createElement('span');
    jsSub.className = 'switch-subtitle';
    jsSub.textContent = jsEnabled ? 'Scripts permitted for this site' : 'Scripts blocked for this site';
    jsTextGroup.append(jsTitle, jsSub);

    const jsInput = doc.createElement('input');
    jsInput.type = 'checkbox';
    jsInput.className = 'switch-input browser-js-toggle-input';
    jsInput.checked = jsEnabled;
    const jsTrack = doc.createElement('span');
    jsTrack.className = 'switch-track';
    const jsThumb = doc.createElement('span');
    jsThumb.className = 'switch-thumb';
    jsTrack.appendChild(jsThumb);
    jsLabel.append(jsTextGroup, jsInput, jsTrack);

    jsInput.addEventListener('change', () => {
      if (host) {
        toggleSiteJavaScript(activeTab.url);
      } else {
        setPrivacySettings({ defaultJsEnabled: jsInput.checked });
      }
      renderShieldPopover();
      renderPanes();
      announce(`JavaScript ${jsInput.checked ? 'enabled' : 'disabled'}`);
    });

    shieldSection.append(levelLabel, levelRow, statsRow, jsLabel);

    // Section 2: Search & History
    const browsingSection = doc.createElement('div');
    browsingSection.className = 'browser-popover-section';

    const browsingLabel = doc.createElement('div');
    browsingLabel.className = 'browser-popover-label';
    browsingLabel.textContent = 'Search & History';

    const searchRow = doc.createElement('div');
    searchRow.className = 'browser-popover-row';
    const searchStatus = doc.createElement('span');
    searchStatus.className = 'browser-popover-note';
    const engineLabel = getSearchEngineLabel(state.searchConfig);
    searchStatus.textContent = engineLabel ? `Search: ${engineLabel}` : 'Search: Not configured';
    const searchCfgBtn = doc.createElement('button');
    searchCfgBtn.type = 'button';
    searchCfgBtn.className = 'edit-btn browser-configure-search-btn';
    searchCfgBtn.textContent = 'Configure…';
    searchCfgBtn.addEventListener('click', () => {
      closeShieldPopover();
      openSearchEngineModal('');
    });
    searchRow.append(searchStatus, searchCfgBtn);

    const privateRow = doc.createElement('div');
    privateRow.className = 'browser-popover-row';
    const privateNote = doc.createElement('span');
    privateNote.className = 'browser-popover-note';
    privateNote.textContent = getBrowserHostKind() === 'gecko-desktop'
      ? 'Isolated browsing & cookies'
      : 'Ephemeral session tab';
    const popoverPrivateBtn = doc.createElement('button');
    popoverPrivateBtn.type = 'button';
    popoverPrivateBtn.className = 'edit-btn browser-private-action-btn';
    popoverPrivateBtn.textContent = getBrowserHostKind() === 'gecko-desktop'
      ? 'Private Window'
      : 'Private Tab';
    popoverPrivateBtn.addEventListener('click', () => {
      closeShieldPopover();
      void launchPrivateSession();
    });
    privateRow.append(privateNote, popoverPrivateBtn);

    const historyRow = doc.createElement('div');
    historyRow.className = 'browser-popover-row';
    const historyNote = doc.createElement('span');
    historyNote.className = 'browser-popover-note browser-history-status';
    historyNote.textContent = 'Browsing & tab history';
    const clearHistoryBtn = doc.createElement('button');
    clearHistoryBtn.type = 'button';
    clearHistoryBtn.className = 'edit-btn browser-clear-history-btn';
    clearHistoryBtn.textContent = 'Clear History';
    clearHistoryBtn.addEventListener('click', async () => {
      clearHistoryBtn.disabled = true;
      await clearBrowserHistory();
      historyNote.textContent = 'History cleared';
      clearHistoryBtn.disabled = false;
      announce('Browsing history cleared');
    });
    historyRow.append(historyNote, clearHistoryBtn);

    browsingSection.append(browsingLabel, searchRow, privateRow, historyRow);

    // Section 3: Password Manager (KeePassXC)
    const kpSection = doc.createElement('div');
    kpSection.className = 'browser-popover-section';

    const kpLabel = doc.createElement('div');
    kpLabel.className = 'browser-popover-label';
    kpLabel.textContent = 'Password Manager';

    const kpInfo = getPasswordManagerStatus();
    const kpMainRow = doc.createElement('div');
    kpMainRow.className = 'browser-popover-row';
    const kpRow = doc.createElement('span');
    kpRow.className = 'browser-popover-note browser-keepass-status';
    kpRow.textContent = kpInfo.detail;

    const kxcActions = doc.createElement('div');
    kxcActions.className = 'browser-popover-actions';
    const tabUrlStr = String(activeTab?.url || '');
    const isHttpTab = tabUrlStr.startsWith('https://') || tabUrlStr.startsWith('http://');
    if (!kpInfo.ready) {
      const kpBtn = doc.createElement('button');
      kpBtn.type = 'button';
      kpBtn.className = 'edit-btn browser-keepass-connect-btn';
      kpBtn.textContent = kpInfo.locked ? 'Unlock' : 'Set Up Vault';
      kpBtn.addEventListener('click', () => {
        closeShieldPopover();
        if (kpInfo.locked) {
          promptUnlockVault({
            onUnlocked: () => {
              renderShieldPopover();
            },
          });
        } else {
          openSettingsModal({
            initialTab: 'project',
            initialVaultUrl: isHttpTab ? activeTab.url : '',
          });
        }
      });
      kxcActions.appendChild(kpBtn);
    } else {
      if (isHttpTab) {
        const fillBtn = doc.createElement('button');
        fillBtn.type = 'button';
        fillBtn.className = 'edit-btn browser-keepass-fill-btn';
        fillBtn.textContent = getBrowserHostKind() === 'gecko-desktop' ? 'Autofill' : 'Copy Login';
        fillBtn.addEventListener('click', async () => {
          try {
            const entries = await fillKeePassXCLoginForUrl(activeTab.url);
            if (!entries.length) {
              closeShieldPopover();
              openKeyBoxModal({
                initialUrl: activeTab.url,
                startCreating: true,
                onAutofill: async (entry) => {
                  if (getBrowserHostKind() === 'gecko-desktop') {
                    await autofillBrowserHostTab(activeTab.id, entry);
                  } else {
                    await globalThis.navigator?.clipboard?.writeText?.(entry.password || '');
                  }
                },
              });
              return;
            }
            const first = entries[0];
            if (getBrowserHostKind() === 'gecko-desktop') {
              const filled = await autofillBrowserHostTab(activeTab.id, first);
              if (filled?.ok && filled.filledCount > 0) {
                closeShieldPopover();
                announce(`Autofilled ${first.login || first.name}`);
                return;
              }
            }
            await globalThis.navigator?.clipboard?.writeText?.(first.password || '');
            kpRow.textContent = `Copied password for ${first.login || first.name}`;
            announce(`Copied password for ${first.login || first.name}`);
          } catch (err) {
            kpRow.textContent = err?.message || 'Unable to query vault logins';
          }
        });
        kxcActions.appendChild(fillBtn);
      }
      const manageBtn = doc.createElement('button');
      manageBtn.type = 'button';
      manageBtn.className = 'edit-btn';
      manageBtn.textContent = 'Vault…';
      manageBtn.addEventListener('click', () => {
        closeShieldPopover();
        openKeyBoxModal({
          initialUrl: isHttpTab ? activeTab.url : '',
          onAutofill: isHttpTab ? async (entry) => {
            if (getBrowserHostKind() === 'gecko-desktop') {
              await autofillBrowserHostTab(activeTab.id, entry);
            } else {
              await globalThis.navigator?.clipboard?.writeText?.(entry.password || '');
            }
          } : null,
        });
      });
      const lockBtn = doc.createElement('button');
      lockBtn.type = 'button';
      lockBtn.className = 'edit-btn';
      lockBtn.textContent = 'Lock';
      lockBtn.addEventListener('click', async () => {
        kpActionBusy = true;
        try {
          await lockKeePassXCVault().catch(() => {});
          await refreshKeePassStatus();
          renderShieldPopover();
        } finally {
          kpActionBusy = false;
        }
      });
      kxcActions.append(manageBtn, lockBtn);
    }

    kpMainRow.append(kpRow);
    if (kxcActions.childNodes.length > 0) {
      kpMainRow.appendChild(kxcActions);
    }
    kpSection.append(kpLabel, kpMainRow);

    shieldPopover.append(heading, shieldSection, browsingSection, kpSection);
    if (!kpActionBusy && connectionStore.get().mode === 'online' && Date.now() - lastKpRefreshAt > 1500) {
      lastKpRefreshAt = Date.now();
      void refreshKeePassStatus().then((st) => {
        if (st && !destroyed && !kpActionBusy) {
          renderShieldPopover();
        }
      });
    }
  }

  function openSearchEngineModal(pendingQuery = '', targetTabId = null) {
    const state = browserStore.get();
    let selectedEngine = normalizeSearchEngineId(state.searchConfig.engine);
    let searxngDraft = state.searchConfig.searxngUrl || '';
    let customDraft = state.searchConfig.customTemplate || '';

    const modal = createClassicModalDialog({
      id: 'browser-search-config-dialog',
      title: 'Search Engine Setup',
      maxWidth: '540px',
      closedBy: 'any',
      onClose: () => {
        modal.dialog.remove();
        pushNativeViewportLayout();
      },
    });

    const desc = doc.createElement('p');
    desc.className = 'classic-modal-desc';
    desc.textContent = pendingQuery
      ? `Choose a search provider to run "${pendingQuery}". Shared with Sanctuary Programs — no provider is pre-selected by default.`
      : 'Choose your search provider for Sanctuary Browser and Sanctuary Programs (web_search). Tip: use @eco, @ddg, @sp, @br, @kagi, @w, or @gh in the address bar.';

    const optionList = doc.createElement('div');
    optionList.className = 'browser-search-engine-list';

    const searxWrap = doc.createElement('div');
    searxWrap.className = 'browser-search-extra-field';
    const searxLbl = doc.createElement('label');
    searxLbl.setAttribute('for', 'browser-searxng-url');
    searxLbl.textContent = 'SearXNG Instance URL';
    const searxInput = doc.createElement('input');
    searxInput.type = 'url';
    searxInput.id = 'browser-searxng-url';
    searxInput.className = 'onboarding-input';
    searxInput.placeholder = 'https://search.example.org';
    searxInput.value = searxngDraft;
    searxWrap.append(searxLbl, searxInput);

    const customWrap = doc.createElement('div');
    customWrap.className = 'browser-search-extra-field';
    const customLbl = doc.createElement('label');
    customLbl.setAttribute('for', 'browser-custom-search-url');
    customLbl.textContent = 'Custom Search Template (include %s)';
    const customInput = doc.createElement('input');
    customInput.type = 'url';
    customInput.id = 'browser-custom-search-url';
    customInput.className = 'onboarding-input';
    customInput.placeholder = 'https://example.org/search?q=%s';
    customInput.value = customDraft;
    customWrap.append(customLbl, customInput);

    const errorEl = doc.createElement('p');
    errorEl.className = 'browser-search-modal-error';
    errorEl.hidden = true;

    const optionButtons = new Map();
    const syncExtras = () => {
      for (const [id, btn] of optionButtons.entries()) {
        btn.setAttribute('aria-pressed', id === selectedEngine ? 'true' : 'false');
      }
      searxWrap.hidden = selectedEngine !== 'searxng';
      customWrap.hidden = selectedEngine !== 'custom';
      errorEl.hidden = true;
    };

    const autofocusTarget = selectedEngine || SEARCH_ENGINES[0]?.id || '';
    for (const eng of SEARCH_ENGINES) {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'edit-btn browser-engine-choice-btn';
      btn.dataset.engineId = eng.id;
      if (eng.id === autofocusTarget) {
        btn.setAttribute('autofocus', '');
      }
      const nameSpan = doc.createElement('span');
      nameSpan.className = 'browser-engine-choice-name';
      nameSpan.textContent = eng.label;
      btn.appendChild(nameSpan);
      if (eng.alias) {
        const aliasKbd = doc.createElement('kbd');
        aliasKbd.className = 'browser-engine-choice-alias';
        aliasKbd.textContent = eng.alias;
        btn.appendChild(aliasKbd);
      }
      btn.addEventListener('click', () => {
        selectedEngine = eng.id;
        syncExtras();
      });
      optionButtons.set(eng.id, btn);
      optionList.appendChild(btn);
    }

    const footer = doc.createElement('div');
    footer.className = 'classic-modal-footer-end';
    const cancelBtn = doc.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'edit-btn edit-cancel-btn';
    cancelBtn.textContent = 'Cancel';
    const saveBtn = doc.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'edit-btn edit-save-btn';
    saveBtn.textContent = pendingQuery ? 'Save & Search' : 'Save';
    footer.append(cancelBtn, saveBtn);

    modal.card.append(desc, optionList, searxWrap, customWrap, errorEl, footer);
    doc.body.appendChild(modal.dialog);
    syncExtras();

    if (!searxngDraft && connectionStore.get().mode === 'online') {
      void fetchProjectSettings()
        .then((cfg) => {
          if (cfg?.searxng_url && !searxInput.value) {
            searxInput.value = String(cfg.searxng_url).trim();
          }
        })
        .catch(() => {});
    }

    cancelBtn.addEventListener('click', () => modal.close());
    saveBtn.addEventListener('click', () => {
      if (!selectedEngine) {
        errorEl.textContent = 'Select a search engine first.';
        errorEl.hidden = false;
        return;
      }
      const nextConfig = {
        engine: selectedEngine,
        searxngUrl: searxInput.value.trim(),
        customTemplate: customInput.value.trim(),
      };
      if (selectedEngine === 'searxng' && !/^https?:\/\/\S+$/i.test(nextConfig.searxngUrl)) {
        errorEl.textContent = 'Enter a valid http:// or https:// SearXNG URL.';
        errorEl.hidden = false;
        return;
      }
      if (selectedEngine === 'custom' && (!/^https?:\/\/\S+$/i.test(nextConfig.customTemplate) || !nextConfig.customTemplate.includes('%s'))) {
        errorEl.textContent = 'Custom template must be http(s):// and include %s.';
        errorEl.hidden = false;
        return;
      }
      setSearchConfig(nextConfig);
      modal.close();
      announce(`Search engine configured: ${getSearchEngineLabel(nextConfig)}`);
      if (pendingQuery) {
        const searchUrl = buildSearchUrl(pendingQuery, nextConfig);
        if (searchUrl) {
          const destId = targetTabId || getFocusedTab()?.id;
          void navigateAndLoad(destId, searchUrl);
        }
      }
    });

    modal.open();
    pushNativeViewportLayout();
  }

  async function launchPrivateSession() {
    const state = browserStore.get();
    if (state.isPrivateWindow) {
      openBrowserTab(NEWTAB_URL, { activate: true, isPrivate: true });
      addressInput.focus?.();
      announce('Opened new private tab');
      return;
    }
    const { openedNative } = await openPrivateBrowserWindow({ searchConfig: state.searchConfig });
    if (openedNative) {
      announce('Opened LM-Sanctuary Private Window');
      return;
    }
    openBrowserTab(NEWTAB_URL, { activate: true, isPrivate: true });
    addressInput.focus?.();
    announce('Opened ephemeral private tab');
  }

  function openBookmarksSheet() {
    const modal = createClassicModalDialog({
      id: 'browser-bookmarks-sheet',
      title: 'Bookmarks',
      maxWidth: '520px',
      closedBy: 'any',
      onClose: () => {
        modal.dialog.remove();
        pushNativeViewportLayout();
      },
    });

    const toolbarWrap = doc.createElement('div');
    toolbarWrap.className = 'browser-bookmarks-toolbar';

    const filterRow = doc.createElement('div');
    filterRow.className = 'browser-bookmarks-filter-row';

    const filterInput = doc.createElement('input');
    filterInput.type = 'search';
    filterInput.className = 'onboarding-input browser-bookmarks-filter';
    filterInput.placeholder = 'Search saved bookmarks…';
    filterInput.setAttribute('aria-label', 'Filter bookmarks');
    filterInput.setAttribute('autocomplete', 'off');
    filterInput.setAttribute('autofocus', '');

    const countBadge = doc.createElement('span');
    countBadge.className = 'browser-bookmarks-count';

    filterRow.append(filterInput, countBadge);
    toolbarWrap.appendChild(filterRow);

    const quickAddRow = doc.createElement('div');
    quickAddRow.className = 'browser-bookmark-current-row';
    quickAddRow.hidden = true;
    const quickAddInfo = doc.createElement('span');
    quickAddInfo.className = 'browser-bookmark-current-label';
    const quickAddBtn = doc.createElement('button');
    quickAddBtn.type = 'button';
    quickAddBtn.className = 'edit-btn edit-save-btn browser-bookmark-current-btn';
    quickAddBtn.textContent = 'Bookmark Page';
    quickAddRow.append(quickAddInfo, quickAddBtn);
    toolbarWrap.appendChild(quickAddRow);

    const listEl = doc.createElement('div');
    listEl.className = 'classic-modal-scroll-body browser-bookmarks-list';

    const syncQuickAdd = () => {
      const state = browserStore.get();
      const tab = getFocusedTab(state);
      const canAdd = Boolean(
        tab &&
        tab.url &&
        tab.url !== NEWTAB_URL &&
        !tab.isPrivate &&
        !isUrlBookmarked(tab.url, state.bookmarks)
      );
      quickAddRow.hidden = !canAdd;
      if (canAdd) {
        const host = extractHostname(tab.url) || tab.url;
        quickAddInfo.textContent = `Save "${tab.title || host}" to bookmarks`;
      }
    };

    const renderList = () => {
      listEl.replaceChildren();
      const state = browserStore.get();
      const allBookmarks = state.bookmarks || [];
      countBadge.textContent = `${allBookmarks.length} saved`;
      syncQuickAdd();

      const q = filterInput.value.trim().toLowerCase();
      const items = allBookmarks.filter((bm) => {
        if (!q) return true;
        return `${bm.title || ''} ${bm.url || ''}`.toLowerCase().includes(q);
      });
      if (items.length === 0) {
        const empty = doc.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = q ? 'No bookmarks match that filter.' : 'No bookmarks saved yet. Star any site in the toolbar to keep it here.';
        listEl.appendChild(empty);
        return;
      }
      for (const bm of items) {
        const row = doc.createElement('div');
        row.className = 'browser-bookmark-row';

        const host = extractHostname(bm.url) || bm.url || '';
        const badgeEl = doc.createElement('span');
        badgeEl.className = 'browser-bookmark-favicon';
        badgeEl.setAttribute('aria-hidden', 'true');
        badgeEl.textContent = (host.replace(/^www\./, '')[0] || '*').toUpperCase();

        const openBtn = doc.createElement('button');
        openBtn.type = 'button';
        openBtn.className = 'browser-bookmark-open-btn';
        const tEl = doc.createElement('strong');
        tEl.className = 'browser-bookmark-row-title';
        tEl.textContent = bm.title || host || bm.url;
        const uEl = doc.createElement('span');
        uEl.className = 'browser-bookmark-row-url';
        uEl.textContent = bm.url;
        openBtn.append(tEl, uEl);
        openBtn.addEventListener('click', () => {
          modal.close();
          const newId = openBrowserTab(bm.url, { activate: true });
          void loadTabIntoStore(newId, bm.url);
        });

        const delBtn = doc.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'action-icon-btn browser-bookmark-delete-btn';
        delBtn.setAttribute('aria-label', `Remove bookmark ${bm.title || bm.url}`);
        delBtn.title = 'Remove bookmark';
        delBtn.innerHTML = CLOSE_SVG;
        delBtn.addEventListener('click', async () => {
          await removeBookmark(bm.id);
          renderList();
        });

        row.append(badgeEl, openBtn, delBtn);
        listEl.appendChild(row);
      }
    };

    quickAddBtn.addEventListener('click', async () => {
      const tab = getFocusedTab();
      if (!tab || tab.url === NEWTAB_URL || tab.isPrivate) return;
      await toggleBookmark({ url: tab.url, title: tab.title });
      renderList();
      announce('Bookmark saved');
    });

    modal.card.append(toolbarWrap, listEl);
    doc.body.appendChild(modal.dialog);
    filterInput.addEventListener('input', renderList);
    renderList();
    modal.open();
    pushNativeViewportLayout();
  }

  async function loadTabIntoStore(tabId, url, { forceReload = false } = {}) {
    if (destroyed || !tabId) return;
    const prevAbort = tabAbortMap.get(tabId);
    prevAbort?.abort();
    if (!url || url === NEWTAB_URL) {
      lastLoadedUrlSig.delete(tabId);
      updateBrowserTabResult(tabId, { loading: false, readerData: null, error: '', blockedCount: 0 });
      return;
    }

    const tab = browserStore.get().tabs.find((t) => t.id === tabId);
    const viewMode = tab?.viewMode || 'frame';
    const sig = `${url}|${viewMode}`;
    lastLoadedUrlSig.set(tabId, sig);

    const controller = new AbortController();
    tabAbortMap.set(tabId, controller);
    updateBrowserTabResult(tabId, { loading: true, error: '' });

    try {
      const privacy = browserStore.get().privacy;
      const result = await loadBrowserTabPage(tabId, url, {
        privacy,
        viewMode,
        forceReload,
        signal: controller.signal,
      });
      if (destroyed || controller.signal.aborted) return;
      const frameAllowed = result?.frameAllowed !== false;
      const frameBlockedReason = String(result?.frameBlockedReason || '');
      const hasReaderData = Boolean(result?.kind === 'reader' || result?.markdown || result?.excerpt);
      updateBrowserTabResult(tabId, {
        loading: false,
        url: result?.url || url,
        title: result?.title || extractHostname(url) || url,
        readerData: hasReaderData ? result : null,
        frameAllowed,
        frameBlockedReason,
        blockedCount: Number(result?.blockedCount || 0),
        error: result?.kind === 'refused' ? (result.error || 'Unable to display page') : '',
      });
    } catch (err) {
      if (destroyed || controller.signal.aborted || err?.name === 'AbortError') return;
      updateBrowserTabResult(tabId, {
        loading: false,
        error: err?.message || 'Unable to load page',
      });
    } finally {
      if (tabAbortMap.get(tabId) === controller) {
        tabAbortMap.delete(tabId);
      }
    }
  }

  async function navigateAndLoad(tabId, targetUrl) {
    const clean = navigateBrowserTab(tabId, targetUrl);
    if (clean) {
      await loadTabIntoStore(tabId, clean);
    }
  }

  function submitQueryOrUrl(rawText, tabId) {
    const state = browserStore.get();
    const resolved = resolveAddressBarInput(rawText, {
      searchConfig: state.searchConfig,
      stripTrackers: state.privacy.stripTrackingParams,
    });
    if (resolved.kind === 'needs_search_engine') {
      openSearchEngineModal(resolved.query, tabId);
      return;
    }
    void navigateAndLoad(tabId, resolved.url);
  }

  function renderTabsStrip(state) {
    tablistEl.replaceChildren();
    const focusedTab = getFocusedTab(state);
    let selectedTabItem = null;
    for (const tab of state.tabs) {
      const isSelected = focusedTab?.id === tab.id;
      const isSecondarySplit = Boolean(state.splitTabId && (state.splitTabId === tab.id || state.activeTabId === tab.id) && !isSelected);
      const tabTitle = tab.title || (tab.isPrivate ? 'Private Tab' : 'New Tab');

      const tabItem = doc.createElement('div');
      tabItem.className = `browser-tab-item${isSelected ? ' is-selected' : ''}${isSecondarySplit ? ' is-in-split' : ''}${tab.isPrivate ? ' is-private' : ''}`;
      tabItem.dataset.tabId = tab.id;
      tabItem.setAttribute('role', 'tab');
      tabItem.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      tabItem.setAttribute('aria-label', tabTitle);
      tabItem.setAttribute('draggable', 'true');

      const tabBtn = doc.createElement('button');
      tabBtn.type = 'button';
      tabBtn.className = `stage-tab-btn browser-tab-btn${isSecondarySplit ? ' is-in-split' : ''}`;
      tabBtn.dataset.tabId = tab.id;
      tabBtn.tabIndex = -1;

      if (tab.isPrivate) {
        const privIcon = doc.createElement('span');
        privIcon.className = 'browser-tab-private-icon';
        privIcon.setAttribute('aria-hidden', 'true');
        privIcon.innerHTML = PRIVATE_SVG;
        tabBtn.appendChild(privIcon);
      }

      const labelEl = doc.createElement('span');
      labelEl.className = 'browser-tab-label';
      labelEl.textContent = tabTitle;
      tabBtn.appendChild(labelEl);

      tabBtn.addEventListener('click', () => selectBrowserTab(tab.id));

      const closeTabBtn = doc.createElement('button');
      closeTabBtn.type = 'button';
      closeTabBtn.className = `browser-tab-close-btn${isSelected ? ' browser-close-tab-btn' : ''}`;
      closeTabBtn.dataset.closeTabId = tab.id;
      closeTabBtn.setAttribute('aria-label', `Close ${tabTitle}`);
      closeTabBtn.title = 'Close tab';
      closeTabBtn.tabIndex = -1;
      closeTabBtn.innerHTML = CLOSE_SVG;
      closeTabBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        tabAbortMap.get(tab.id)?.abort();
        closeBrowserTab(tab.id);
      });

      tabItem.addEventListener('auxclick', (e) => {
        if (e.button === 1) {
          e.preventDefault();
          tabAbortMap.get(tab.id)?.abort();
          closeBrowserTab(tab.id);
        }
      });

      tabItem.append(tabBtn, closeTabBtn);
      tablistEl.appendChild(tabItem);
      if (isSelected) {
        selectedTabItem = tabItem;
        if (typeof tabItem.scrollIntoView === 'function') {
          tabItem.scrollIntoView({ block: 'nearest', inline: 'nearest', container: 'nearest' });
        }
      }
    }

    tablistEl.appendChild(newTabBtn);
    if (selectedTabItem?.focus) {
      if (doc.activeElement && tablistEl.contains?.(doc.activeElement)) {
        selectedTabItem.focus();
      } else {
        selectedTabItem.tabIndex = 0;
      }
    }
  }

  function installTabDragAndDrop() {
    let dragTabId = null;

    tablistEl.addEventListener('dragstart', (event) => {
      const item = event.target?.closest?.('.browser-tab-item');
      if (!item) return;
      dragTabId = item.dataset.tabId || null;
      if (!dragTabId) return;
      item.classList.add('is-dragging');
      event.dataTransfer?.setData?.('text/plain', dragTabId);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
      }
    });

    tablistEl.addEventListener('dragend', () => {
      tablistEl.querySelectorAll('.browser-tab-item.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
      tablistEl.querySelectorAll('.browser-tab-item.drop-before').forEach((el) => el.classList.remove('drop-before'));
      tablistEl.querySelectorAll('.browser-tab-item.drop-after').forEach((el) => el.classList.remove('drop-after'));
      dragTabId = null;
    });

    tablistEl.addEventListener('dragover', (event) => {
      if (!dragTabId) return;
      const item = event.target?.closest?.('.browser-tab-item');
      if (!item || item.dataset.tabId === dragTabId) {
        tablistEl.querySelectorAll('.browser-tab-item.drop-before, .browser-tab-item.drop-after').forEach((el) => {
          el.classList.remove('drop-before', 'drop-after');
        });
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
      const rect = item.getBoundingClientRect?.();
      const after = rect ? event.clientX > rect.left + rect.width / 2 : false;
      tablistEl.querySelectorAll('.browser-tab-item.drop-before, .browser-tab-item.drop-after').forEach((el) => {
        if (el !== item) el.classList.remove('drop-before', 'drop-after');
      });
      item.classList.toggle('drop-before', !after);
      item.classList.toggle('drop-after', after);
    });

    tablistEl.addEventListener('drop', (event) => {
      if (!dragTabId) return;
      const target = event.target?.closest?.('.browser-tab-item');
      const ids = Array.from(tablistEl.querySelectorAll('.browser-tab-item')).map((el) => el.dataset.tabId);
      let targetTabId = target?.dataset.tabId || null;
      if (target && target.dataset.tabId === dragTabId) targetTabId = null;

      if (targetTabId) {
        const rect = target.getBoundingClientRect?.();
        const after = rect ? event.clientX > rect.left + rect.width / 2 : false;
        const targetIdx = ids.indexOf(targetTabId);
        let insertAt = after ? targetIdx + 1 : targetIdx;
        if (ids.indexOf(dragTabId) < insertAt) insertAt -= 1;
        if (insertAt !== ids.indexOf(dragTabId)) {
          event.preventDefault();
          moveBrowserTab(dragTabId, insertAt);
        }
      } else if (event.dataTransfer) {
        event.preventDefault();
      }
      dragTabId = null;
    });
  }

  function renderToolbarState(state) {
    const tab = getFocusedTab(state);
    const isNewTab = !tab || tab.url === NEWTAB_URL;
    const isGeckoHost = getBrowserHostKind() === 'gecko-desktop';
    const canBack = Boolean(tab && (tab.historyIndex > 0 || (isGeckoHost && !isNewTab && tab.nativeCanGoBack)));
    const canForward = Boolean(
      tab && (tab.historyIndex < (tab.history?.length || 1) - 1 || (isGeckoHost && !isNewTab && tab.nativeCanGoForward))
    );

    backBtn.setAttribute('aria-disabled', canBack ? 'false' : 'true');
    forwardBtn.setAttribute('aria-disabled', canForward ? 'false' : 'true');
    reloadBtn.setAttribute('aria-disabled', isNewTab ? 'true' : 'false');
    homeBtn.setAttribute('aria-disabled', isNewTab ? 'true' : 'false');

    const shieldOn = state.privacy.shieldLevel !== 'off';
    shieldBtn.setAttribute('aria-pressed', shieldOn ? 'true' : 'false');
    const blocked = Number(tab?.blockedCount || 0);
    shieldBadge.textContent = blocked > 99 ? '99+' : String(blocked);
    shieldBadge.hidden = blocked <= 0;

    const inPrivWin = Boolean(state.isPrivateWindow);
    privateWindowBtn.classList.toggle('is-private-window-active', inPrivWin);
    privateWindowBtn.setAttribute('aria-pressed', inPrivWin ? 'true' : 'false');
    privateWindowBtn.setAttribute(
      'aria-label',
      inPrivWin ? 'Private browsing active (open new private tab)' : 'New private window'
    );
    privateWindowBtn.title = inPrivWin
      ? 'Private Window — history and site data are discarded on close'
      : 'New Private Window';

    const bookmarked = !isNewTab && isUrlBookmarked(tab.url, state.bookmarks);
    bookmarkStarBtn.setAttribute('aria-pressed', bookmarked ? 'true' : 'false');
    bookmarkStarBtn.setAttribute('aria-disabled', (isNewTab || tab?.isPrivate) ? 'true' : 'false');

    splitViewBtn.setAttribute('aria-pressed', state.splitTabId ? 'true' : 'false');
    askSanctuaryBtn.hidden = inPrivWin;
    clipDatabankBtn.hidden = inPrivWin;
    shareFediverseBtn.hidden = inPrivWin;
    askSanctuaryBtn.setAttribute('aria-disabled', isNewTab ? 'true' : 'false');
    clipDatabankBtn.setAttribute('aria-disabled', isNewTab ? 'true' : 'false');
    shareFediverseBtn.setAttribute('aria-disabled', isNewTab ? 'true' : 'false');

    const docHasFocus = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
    const userActivelyEditing = isEditingAddress && doc.activeElement === addressInput && docHasFocus;
    if (tab && (lastFocusedTabId !== tab.id || (!isSyncingAddress && !userActivelyEditing))) {
      addressInput.value = tab.url === NEWTAB_URL ? '' : tab.url;
      lastFocusedTabId = tab.id;
    }
  }

  function renderNewTabPane(tab, state) {
    const isPrivateTab = Boolean(tab?.isPrivate);
    const wrap = doc.createElement('div');
    wrap.className = `browser-newtab-view${isPrivateTab ? ' is-private' : ''}`;

    const hero = doc.createElement('div');
    hero.className = 'browser-newtab-hero';

    const heading = doc.createElement('h2');
    heading.className = 'browser-newtab-title';
    heading.textContent = isPrivateTab ? 'Sanctuary Private Browser' : 'Sanctuary Browser';

    const searchForm = doc.createElement('form');
    searchForm.className = 'search-bar-form browser-newtab-search-form';
    searchForm.setAttribute('role', 'search');

    const ntInput = doc.createElement('input');
    ntInput.type = 'search';
    ntInput.className = 'onboarding-input browser-newtab-search-input';
    ntInput.placeholder = isPrivateTab ? 'Search privately or enter URL…' : 'Search the web or enter URL…';
    ntInput.setAttribute('aria-label', isPrivateTab ? 'Private tab search or URL' : 'New tab search or URL');

    const ntSubmit = doc.createElement('button');
    ntSubmit.type = 'submit';
    ntSubmit.className = 'edit-btn edit-save-btn';
    ntSubmit.textContent = 'Go';

    searchForm.append(ntInput, ntSubmit);
    attachSearchSuggestions(ntInput, {
      anchorEl: searchForm,
      getLocalSuggestions: (q) => buildBrowserLocalSuggestions(q),
      fetchRemoteSuggestions: (q) => fetchBrowserRemoteSuggestions(q, isPrivateTab),
      onSelect: (item) => handleBrowserSuggestionSelect(item, ntInput, tab.id),
    });
    searchForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = ntInput.value.trim();
      if (!q) return;
      submitQueryOrUrl(q, tab.id);
    });

    const engineMeta = doc.createElement('div');
    engineMeta.className = 'browser-newtab-engine-row';
    const engineLabel = getSearchEngineLabel(state.searchConfig);
    const engineChip = doc.createElement('button');
    engineChip.type = 'button';
    engineChip.className = 'edit-btn browser-engine-pill';
    engineChip.textContent = engineLabel ? `Search: ${engineLabel}` : 'Configure Search Engine';
    engineChip.addEventListener('click', () => openSearchEngineModal('', tab.id));
    engineMeta.appendChild(engineChip);

    hero.append(heading, searchForm, engineMeta);
    if (isPrivateTab) {
      const note = doc.createElement('p');
      note.className = 'browser-private-note';
      note.textContent = 'Visited pages, cookies, and temporary site data are discarded when this private window closes.';
      hero.appendChild(note);
    }
    wrap.appendChild(hero);

    if (!isPrivateTab && state.bookmarks.length > 0) {
      const bmSection = doc.createElement('div');
      bmSection.className = 'browser-newtab-bookmarks';
      const bmTitle = doc.createElement('h3');
      bmTitle.className = 'browser-newtab-section-title';
      bmTitle.textContent = 'Bookmarks';
      const bmGrid = doc.createElement('div');
      bmGrid.className = 'browser-newtab-bookmark-grid';
      for (const bm of state.bookmarks.slice(0, 12)) {
        const card = doc.createElement('button');
        card.type = 'button';
        card.className = 'browser-bookmark-tile';
        const titleSpan = doc.createElement('span');
        titleSpan.className = 'browser-bookmark-tile-title';
        titleSpan.textContent = bm.title || extractHostname(bm.url) || bm.url;
        const hostSpan = doc.createElement('span');
        hostSpan.className = 'browser-bookmark-tile-host';
        hostSpan.textContent = extractHostname(bm.url) || bm.url;
        card.append(titleSpan, hostSpan);
        card.addEventListener('click', () => void navigateAndLoad(tab.id, bm.url));
        bmGrid.appendChild(card);
      }
      bmSection.append(bmTitle, bmGrid);
      wrap.appendChild(bmSection);
    }

    return wrap;
  }

  function dispatchSanctuaryPageShare(tab, extracted = null) {
    const fallbackHost = extractHostname(tab.url) || 'Webpage';
    const effectiveUrl = stripTrackingParams(extracted?.url || tab.url) || tab.url;
    const host = extractHostname(effectiveUrl) || fallbackHost;
    const effectiveTitle = extracted?.title || tab.title || '';
    const siteName = extracted?.siteName || tab.readerData?.siteName || host;
    const snippet =
      extracted?.text?.slice(0, 900) ||
      extracted?.excerpt ||
      tab.readerData?.excerpt ||
      tab.readerData?.markdown?.slice(0, 500) ||
      effectiveTitle ||
      effectiveUrl;
    onAskSanctuaryPage?.({
      authorName: siteName,
      authorHandle: host,
      text: `${effectiveTitle ? `${effectiveTitle}\n` : ''}${snippet}`.slice(0, 1200),
      mediaUrl: '',
      mediaAlt: '',
      url: effectiveUrl,
      network: 'web',
    });
  }

  function shareTabWithSanctuary(tab, { selectionText = '' } = {}) {
    if (!tab || tab.url === NEWTAB_URL) return;
    const cleanSel = String(selectionText || '').trim();
    if (cleanSel) {
      dispatchSanctuaryPageShare(tab, {
        url: tab.url,
        title: tab.title,
        text: cleanSel,
      });
      return;
    }
    const canExtractNative =
      !tab.readerData?.markdown &&
      !tab.readerData?.excerpt &&
      typeof globalThis.sanctuaryBrowserHost?.extractTabContent === 'function';
    if (!canExtractNative) {
      dispatchSanctuaryPageShare(tab);
      return;
    }
    return extractBrowserTabContent(tab.id, { url: tab.url })
      .then((extracted) => dispatchSanctuaryPageShare(tab, extracted))
      .catch(() => dispatchSanctuaryPageShare(tab));
  }

  function renderRefusalPane(tab) {
    const host = extractHostname(tab.url) || tab.url;
    const wrap = doc.createElement('div');
    wrap.className = 'browser-refusal-view';

    const card = doc.createElement('div');
    card.className = 'browser-refusal-card';

    const emblem = doc.createElement('div');
    emblem.className = 'browser-refusal-emblem';
    emblem.innerHTML = REFUSAL_SVG;

    const title = doc.createElement('h3');
    title.className = 'browser-refusal-title';
    const isFramingBlock =
      tab.frameAllowed === false &&
      !tab.error?.startsWith('Connection') &&
      !tab.error?.startsWith('HTTP ');
    title.textContent = isFramingBlock
      ? `Live Embedding Refused by ${host}`
      : `Unable to Display ${host}`;

    const desc = doc.createElement('p');
    desc.className = 'browser-refusal-desc';
    if (tab.frameBlockedReason) {
      const extraErr =
        tab.error && !tab.error.includes(tab.frameBlockedReason) ? ` (${tab.error}).` : '';
      desc.textContent = `${host} blocks embedded WebView frames (${tab.frameBlockedReason}).${extraErr} Running in WebView fallback — launch the native Sanctuary Browser binary (browser-desktop/README.md) for unrestricted tab rendering.`;
    } else {
      desc.textContent = `${tab.error || `${host} refused the connection`}. Running in WebView fallback — launch the native Sanctuary Browser binary (browser-desktop/README.md) for full interactive rendering.`;
    }

    const urlCode = doc.createElement('code');
    urlCode.className = 'browser-refusal-url';
    urlCode.textContent = tab.url;

    card.append(emblem, title, desc, urlCode);

    if (tab.readerData?.excerpt) {
      const preview = doc.createElement('p');
      preview.className = 'browser-refusal-preview';
      preview.textContent = tab.readerData.excerpt;
      card.appendChild(preview);
    }

    const actions = doc.createElement('div');
    actions.className = 'browser-refusal-actions';

    const askBtn = doc.createElement('button');
    askBtn.type = 'button';
    askBtn.className = 'edit-btn browser-refusal-ask-btn';
    const askIcon = doc.createElement('span');
    askIcon.className = 'browser-btn-icon';
    askIcon.innerHTML = SANCTUARY_SVG;
    const askLbl = doc.createElement('span');
    askLbl.textContent = 'Ask Sanctuary';
    askBtn.append(askIcon, askLbl);
    askBtn.addEventListener('click', () => shareTabWithSanctuary(tab));

    const retryBtn = doc.createElement('button');
    retryBtn.type = 'button';
    retryBtn.className = 'edit-btn browser-refusal-retry-btn';
    retryBtn.textContent = 'Retry';
    retryBtn.addEventListener('click', () => void loadTabIntoStore(tab.id, tab.url));

    actions.append(askBtn, retryBtn);
    card.appendChild(actions);
    wrap.appendChild(card);
    return wrap;
  }

  function renderSinglePane(tab, paneKey, state, existingPane = null) {
    const isFocused = (state.focusedPane === paneKey) || (!state.splitTabId && paneKey === 'primary');
    const hostKind = getBrowserHostKind();
    if (
      hostKind !== 'web-companion' &&
      existingPane &&
      existingPane.dataset.tabId === tab.id &&
      (tab.url !== NEWTAB_URL || tab.nativePending) &&
      !tab.error &&
      existingPane.querySelector('.browser-pane-viewport')
    ) {
      existingPane.className = `browser-pane${isFocused ? ' is-focused' : ''}`;
      existingPane.setAttribute('aria-label', tab.title || 'Browser pane');
      const existingPreview = tabPreviewMap.get(tab.id);
      if (existingPreview) {
        applyViewportPreview(tab.id, existingPreview);
      }
      return existingPane;
    }

    const pane = doc.createElement('section');
    pane.className = `browser-pane${isFocused ? ' is-focused' : ''}`;
    pane.dataset.pane = paneKey;
    pane.dataset.tabId = tab.id;
    pane.setAttribute('aria-label', tab.title || 'Browser pane');

    pane.addEventListener('pointerdown', () => {
      const current = browserStore.get();
      if (current.splitTabId && current.focusedPane !== paneKey) {
        focusBrowserPane(paneKey);
      }
    });

    if (tab.url === NEWTAB_URL && !tab.nativePending) {
      pane.appendChild(renderNewTabPane(tab, state));
      return pane;
    }

    if (tab.loading && hostKind === 'web-companion') {
      const status = doc.createElement('p');
      status.className = 'browser-pane-loading';
      status.textContent = `Loading ${extractHostname(tab.url) || tab.url}…`;
      pane.appendChild(status);
      return pane;
    }
    if (tab.viewMode === 'reader' && tab.readerData?.markdown && !tab.error) {
      const article = doc.createElement('article');
      article.className = 'browser-reader-article';
      renderSafeReaderMarkdown(doc, article, tab.readerData, tab.title);
      pane.appendChild(article);
      return pane;
    }

    if (
      tab.error ||
      (hostKind === 'web-companion' &&
        tab.frameAllowed === false &&
        (tab.viewMode === 'frame' || !tab.readerData?.markdown))
    ) {
      pane.appendChild(renderRefusalPane(tab));
      return pane;
    }

    if (hostKind !== 'web-companion') {
      const viewport = doc.createElement('div');
      viewport.className = 'browser-pane-viewport';
      viewport.dataset.nativeTabId = tab.id;
      viewport.dataset.pane = paneKey;
      const previewUrl = tabPreviewMap.get(tab.id);
      if (previewUrl) {
        const img = doc.createElement('img');
        img.className = 'browser-pane-snapshot';
        img.alt = '';
        img.setAttribute('aria-hidden', 'true');
        img.src = previewUrl;
        viewport.appendChild(img);
      }
      pane.appendChild(viewport);
      return pane;
    }

    const frame = doc.createElement('iframe');
    frame.className = 'browser-live-frame';
    frame.title = tab.title || tab.url;
    frame.src = tab.url;
    frame.setAttribute('referrerpolicy', 'no-referrer');
    const jsEnabled = isJavaScriptEnabledForUrl(tab.url, state.privacy);
    frame.setAttribute(
      'sandbox',
      jsEnabled ? 'allow-scripts allow-same-origin allow-forms allow-popups' : 'allow-forms'
    );
    pane.appendChild(frame);
    return pane;
  }

  function renderPanes(state = browserStore.get()) {
    const primary = state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0];
    const secondary = state.splitTabId ? state.tabs.find((t) => t.id === state.splitTabId) : null;
    panesGrid.classList.toggle('is-split', Boolean(secondary));

    const existingPrimary = panesGrid.querySelector('.browser-pane[data-pane="primary"]');
    const existingSplit = panesGrid.querySelector('.browser-pane[data-pane="split"]');
    const nextPrimary = primary ? renderSinglePane(primary, 'primary', state, existingPrimary) : null;
    const nextSplit = secondary ? renderSinglePane(secondary, 'split', state, existingSplit) : null;

    if (
      nextPrimary &&
      nextPrimary === existingPrimary &&
      ((!nextSplit && !existingSplit) || (nextSplit && nextSplit === existingSplit))
    ) {
      return;
    }

    panesGrid.replaceChildren();
    if (nextPrimary) {
      panesGrid.appendChild(nextPrimary);
    }
    if (nextSplit) {
      panesGrid.appendChild(nextSplit);
    }
  }

  function syncAll(state = browserStore.get()) {
    if (destroyed) return;
    renderTabsStrip(state);
    renderToolbarState(state);
    renderPanes(state);

    for (const tab of [
      state.tabs.find((t) => t.id === state.activeTabId),
      state.splitTabId ? state.tabs.find((t) => t.id === state.splitTabId) : null,
    ]) {
      if (!tab || tab.url === NEWTAB_URL) continue;
      const sig = `${tab.url}|${tab.viewMode}`;
      if (tab.loading && lastLoadedUrlSig.get(tab.id) !== sig && !tabAbortMap.has(tab.id)) {
        void loadTabIntoStore(tab.id, tab.url);
      }
    }

    pushNativeViewportLayout(state);
  }

  // Event wiring
  newTabBtn.addEventListener('click', () => {
    openBrowserTab(NEWTAB_URL, { activate: true });
    addressInput.focus?.();
  });

  privateWindowBtn.addEventListener('click', () => {
    void launchPrivateSession();
  });

  addressForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const tab = getFocusedTab();
    if (!tab) return;
    isSyncingAddress = true;
    isEditingAddress = false;
    selectAddressOnMouseUp = false;
    try {
      submitQueryOrUrl(addressInput.value, tab.id);
    } finally {
      isSyncingAddress = false;
      addressInput.blur?.();
    }
  });

  async function stepFocusedHistory(delta) {
    if ((delta < 0 ? backBtn : forwardBtn).getAttribute('aria-disabled') === 'true') return;
    const tab = getFocusedTab();
    if (!tab) return;
    const isGeckoHost = getBrowserHostKind() === 'gecko-desktop';
    const adjacentIdx = (tab.historyIndex ?? 0) + delta;
    const hasAdjacentJsEntry = adjacentIdx >= 0 && adjacentIdx < (tab.history?.length || 0);
    const adjacentUrl = hasAdjacentJsEntry ? tab.history[adjacentIdx] : null;
    const canNativeStep =
      isGeckoHost &&
      tab.url !== NEWTAB_URL &&
      (delta < 0
        ? Boolean(tab.nativeCanGoBack || (hasAdjacentJsEntry && adjacentUrl !== NEWTAB_URL))
        : Boolean(tab.nativeCanGoForward || hasAdjacentJsEntry));

    if (canNativeStep) {
      steppingHistoryTabs.add(tab.id);
      const res = await stepBrowserHostHistory(tab.id, delta);
      if (res?.handled) {
        if (hasAdjacentJsEntry && adjacentUrl !== NEWTAB_URL) {
          const steppedUrl = delta < 0 ? goBackBrowserTab(tab.id) : goForwardBrowserTab(tab.id);
          if (steppedUrl) {
            lastLoadedUrlSig.set(tab.id, `${steppedUrl}|${tab.viewMode || 'frame'}`);
          }
        }
        const patch = {};
        if (typeof res.canGoBack === 'boolean') patch.nativeCanGoBack = res.canGoBack;
        if (typeof res.canGoForward === 'boolean') patch.nativeCanGoForward = res.canGoForward;
        if (Object.keys(patch).length) {
          updateBrowserTabResult(tab.id, patch);
        }
        return;
      }
      steppingHistoryTabs.delete(tab.id);
    }

    const url = delta < 0 ? goBackBrowserTab(tab.id) : goForwardBrowserTab(tab.id);
    if (!url) return;
    void loadTabIntoStore(tab.id, url);
  }

  backBtn.addEventListener('click', () => {
    void stepFocusedHistory(-1);
  });

  forwardBtn.addEventListener('click', () => {
    void stepFocusedHistory(1);
  });

  reloadBtn.addEventListener('click', () => {
    if (reloadBtn.getAttribute('aria-disabled') === 'true') return;
    const tab = getFocusedTab();
    if (!tab || tab.url === NEWTAB_URL) return;
    void loadTabIntoStore(tab.id, tab.url, { forceReload: true });
  });

  homeBtn.addEventListener('click', () => {
    if (homeBtn.getAttribute('aria-disabled') === 'true') return;
    const tab = getFocusedTab();
    if (!tab || tab.url === NEWTAB_URL) return;
    tabAbortMap.get(tab.id)?.abort();
    void navigateAndLoad(tab.id, NEWTAB_URL);
    addressInput.value = '';
  });

  bookmarkStarBtn.addEventListener('click', () => {
    if (bookmarkStarBtn.getAttribute('aria-disabled') === 'true') return;
    const tab = getFocusedTab();
    if (!tab || tab.url === NEWTAB_URL) return;
    void toggleBookmark({ url: tab.url, title: tab.title }).then((res) => {
      announce(res.added ? 'Bookmark saved' : 'Bookmark removed');
    });
  });

  bookmarksListBtn.addEventListener('click', openBookmarksSheet);
  splitViewBtn.addEventListener('click', () => {
    toggleBrowserSplitView();
    const isSplit = Boolean(browserStore.get().splitTabId);
    announce(isSplit ? 'Browser split view enabled' : 'Browser split view closed');
  });

  askSanctuaryBtn.addEventListener('click', () => {
    if (askSanctuaryBtn.getAttribute('aria-disabled') === 'true') return;
    const tab = getFocusedTab();
    void shareTabWithSanctuary(tab);
  });

  async function clipTabToDataBank(tab, { selectionText = '' } = {}) {
    if (clipDatabankBtn.dataset.busy === 'true') return;
    if (!tab || tab.url === NEWTAB_URL) return;
    if (connectionStore.get().mode !== 'online') {
      showAlert('Sanctuary Offline', 'Connect to your Sanctuary node to clip pages to Data Bank.');
      return;
    }
    clipDatabankBtn.dataset.busy = 'true';
    clipDatabankBtn.setAttribute('aria-busy', 'true');
    try {
      const cleanSel = String(selectionText || '').trim();
      let extracted = cleanSel
        ? {
            url: tab.url,
            title: tab.title,
            text: cleanSel,
            isSelection: true,
          }
        : tab.readerData?.markdown
          ? {
              url: tab.url,
              title: tab.title,
              text: tab.readerData.markdown,
              isSelection: false,
            }
          : await extractBrowserTabContent(tab.id, { url: tab.url });
      if (!extracted?.text && tab.readerData?.excerpt) {
        extracted = {
          url: tab.url,
          title: tab.title,
          text: tab.readerData.excerpt,
          isSelection: false,
        };
      }
      const clipUrl = stripTrackingParams(extracted?.url || tab.url) || tab.url;
      const clipTitle = extracted?.title || tab.title || extractHostname(clipUrl) || 'Web Clip';
      if (extracted?.url && clipUrl !== tab.url) {
        navigateBrowserTab(tab.id, clipUrl, { pushHistory: false, title: clipTitle });
      } else if (extracted?.title && extracted.title !== tab.title) {
        updateBrowserTabResult(tab.id, { title: extracted.title });
      }
      const body = String(extracted?.text || '').trim();
      if (!body) {
        showAlert(
          'Nothing to Clip',
          'Could not extract readable text from this page. Try selecting the text you want to clip first.'
        );
        return;
      }
      const docText = `# ${clipTitle}\nSource: ${clipUrl}\n\n${body}`;
      await ingestDatabankText(docText, clipTitle);
      announce(extracted?.isSelection ? 'Selection saved to Program Data Bank' : 'Page saved to Program Data Bank');
    } catch (err) {
      showAlert('Data Bank Error', err?.message || 'Unable to save page to Data Bank.');
    } finally {
      delete clipDatabankBtn.dataset.busy;
      clipDatabankBtn.removeAttribute('aria-busy');
    }
  }

  clipDatabankBtn.addEventListener('click', async () => {
    if (clipDatabankBtn.getAttribute('aria-disabled') === 'true') return;
    await clipTabToDataBank(getFocusedTab());
  });

  shareFediverseBtn.addEventListener('click', () => {
    if (shareFediverseBtn.getAttribute('aria-disabled') === 'true') return;
    const tab = getFocusedTab();
    if (!tab || tab.url === NEWTAB_URL) return;
    const cleanUrl = stripTrackingParams(tab.url);
    onShareToFediverse?.({
      title: tab.title || '',
      url: cleanUrl,
    });
  });

  installRovingFallback(tablistEl, () => Array.from(tablistEl.querySelectorAll('[role="tab"]')));
  installTabDragAndDrop();
  installRovingFallback(toolbarEl, () => Array.from(toolbarEl.querySelectorAll('button')));

  const onWindowResize = () => pushNativeViewportLayout();
  const onDocumentDialogClose = () => pushNativeViewportLayout();
  const onOverlayChange = () => pushNativeViewportLayout();
  globalThis.addEventListener?.('resize', onWindowResize);
  doc.addEventListener?.('close', onDocumentDialogClose, true);
  doc.addEventListener?.('sanctuary:overlay-change', onOverlayChange);

  let dialogMutationObserver = null;
  if (typeof globalThis.MutationObserver === 'function' && doc?.body) {
    const nodeHasDialog = (node) => Boolean(
      node && (node.tagName === 'DIALOG' || node.querySelector?.('dialog'))
    );
    dialogMutationObserver = new globalThis.MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && m.target?.tagName === 'DIALOG') {
          pushNativeViewportLayout();
          return;
        }
        if (m.type === 'childList') {
          for (const n of m.addedNodes || []) {
            if (nodeHasDialog(n)) {
              pushNativeViewportLayout();
              return;
            }
          }
          for (const n of m.removedNodes || []) {
            if (nodeHasDialog(n)) {
              pushNativeViewportLayout();
              return;
            }
          }
        }
      }
    });
    dialogMutationObserver.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['open'],
    });
  }

  let panesResizeObserver = null;
  if (typeof globalThis.ResizeObserver === 'function') {
    panesResizeObserver = new globalThis.ResizeObserver(() => pushNativeViewportLayout());
    panesResizeObserver.observe(panesGrid);
  }

  const unsubHostEvents = subscribeBrowserHostEvents((evt) => {
    if (destroyed || !evt || typeof evt !== 'object') return;
    if (evt.type === 'location-change' && evt.tabId && evt.url) {
      const rawUrl = String(evt.url || '').trim();
      if (!rawUrl || rawUrl === 'about:blank' || rawUrl.startsWith('about:')) {
        steppingHistoryTabs.delete(evt.tabId);
        return;
      }
      const wasStepping = steppingHistoryTabs.delete(evt.tabId);
      const existing = browserStore.get().tabs.find((t) => t.id === evt.tabId);
      const clean = stripTrackingParams(rawUrl);
      if (existing) {
        lastLoadedUrlSig.set(evt.tabId, `${clean}|${existing.viewMode || 'frame'}`);
      }
      navigateBrowserTab(evt.tabId, clean, {
        pushHistory: wasStepping ? false : evt.pushHistory !== false,
        title: evt.title || '',
        nativeCanGoBack: evt.canGoBack,
        nativeCanGoForward: evt.canGoForward,
      });
      updateBrowserTabResult(evt.tabId, { loading: Boolean(evt.loading) });
      return;
    }
    if (evt.type === 'title-change' && evt.tabId && evt.title !== undefined) {
      updateBrowserTabResult(evt.tabId, { title: String(evt.title || '') });
      return;
    }
    if (evt.type === 'loading-change' && evt.tabId) {
      const patch = { loading: Boolean(evt.loading) };
      if (typeof evt.canGoBack === 'boolean') patch.nativeCanGoBack = evt.canGoBack;
      if (typeof evt.canGoForward === 'boolean') patch.nativeCanGoForward = evt.canGoForward;
      updateBrowserTabResult(evt.tabId, patch);
      return;
    }
    if (evt.type === 'blocked-count' && evt.tabId) {
      updateBrowserTabResult(evt.tabId, { blockedCount: Number(evt.blockedCount || 0) });
      return;
    }
    if (evt.type === 'tab-preview' && evt.tabId && evt.dataUrl) {
      applyViewportPreview(evt.tabId, evt.dataUrl);
      return;
    }
    if (evt.type === 'open-tab' && (evt.url || evt.nativeReady)) {
      const rawUrl = String(evt.url || '').trim();
      const clean = rawUrl ? stripTrackingParams(rawUrl) : NEWTAB_URL;
      const hostTabId = evt.tabId ? String(evt.tabId) : '';
      if (evt.nativeReady && hostTabId && clean !== NEWTAB_URL) {
        lastLoadedUrlSig.set(hostTabId, `${clean}|frame`);
      }
      const newId = openBrowserTab(clean, {
        id: hostTabId,
        activate: evt.activate !== false,
        inSplit: Boolean(evt.split),
        nativePending: Boolean(evt.nativeReady && clean === NEWTAB_URL),
      });
      if (evt.nativeReady) {
        if (clean !== NEWTAB_URL) {
          lastLoadedUrlSig.set(newId, `${clean}|frame`);
        }
        pushNativeViewportLayout();
      } else if (clean !== NEWTAB_URL) {
        void loadTabIntoStore(newId, clean);
      }
      return;
    }
    if (evt.type === 'close-tab' && evt.tabId) {
      tabAbortMap.get(evt.tabId)?.abort();
      tabPreviewMap.delete(evt.tabId);
      closeBrowserTab(evt.tabId);
      return;
    }
    if (evt.type === 'vault-unlock-requested' || evt.type === 'vault-open-requested') {
      const focused = getFocusedTab(browserStore.get());
      const targetUrl = String(evt.url || focused?.url || '');
      const targetTabId = String(evt.tabId || focused?.id || '');
      const kpStatus = getPasswordManagerStatus();
      const runAutofillAfterUnlock = async () => {
        await refreshKeePassStatus();
        if (targetUrl && targetTabId) {
          const entries = await fillKeePassXCLoginForUrl(targetUrl).catch(() => []);
          if (entries.length > 0) {
            await autofillBrowserHostTab(targetTabId, entries[0]);
          }
        }
      };
      if (evt.type === 'vault-unlock-requested' && kpStatus.initialized) {
        promptUnlockVault({ onUnlocked: runAutofillAfterUnlock });
      } else {
        openSettingsModal({
          initialTab: 'project',
          initialVaultUrl: targetUrl,
          onVaultAutofill: targetTabId
            ? async (entry) => {
                await autofillBrowserHostTab(targetTabId, entry);
              }
            : null,
        });
      }
    }
  });

  const unsubscribe = browserStore.subscribe((state) => syncAll(state));
  syncAll(browserStore.get());

  return {
    openUrl(rawUrl, opts = {}) {
      const clean = stripTrackingParams(rawUrl);
      const id = openBrowserTab(clean, { activate: true, ...opts });
      void loadTabIntoStore(id, clean);
      return id;
    },
    submitSearchOrUrl(rawQuery) {
      const id = openBrowserTab(NEWTAB_URL, { activate: true });
      submitQueryOrUrl(rawQuery, id);
      return id;
    },
    toggleBookmarkForTab(tabId, { url = '', title = '' } = {}) {
      const state = browserStore.get();
      const tab = (tabId && state.tabs.find((t) => t.id === tabId)) || getFocusedTab(state);
      const targetUrl = tab?.url && tab.url !== NEWTAB_URL ? tab.url : url;
      if (!targetUrl || targetUrl === NEWTAB_URL || tab?.isPrivate) return Promise.resolve({ added: false });
      return toggleBookmark({ url: targetUrl, title: tab?.title || title }).then((res) => {
        announce(res.added ? 'Bookmark saved' : 'Bookmark removed');
        return res;
      });
    },
    askSanctuaryForTab(tabId, { selectionText = '' } = {}) {
      const state = browserStore.get();
      const tab = (tabId && state.tabs.find((t) => t.id === tabId)) || getFocusedTab(state);
      return shareTabWithSanctuary(tab, { selectionText });
    },
    clipTabToDataBankById(tabId, { selectionText = '' } = {}) {
      const state = browserStore.get();
      const tab = (tabId && state.tabs.find((t) => t.id === tabId)) || getFocusedTab(state);
      return clipTabToDataBank(tab, { selectionText });
    },
    openSearchConfig: openSearchEngineModal,
    syncViewport: () => pushNativeViewportLayout(),
    destroy() {
      destroyed = true;
      addressSuggest?.destroy?.();
      unsubscribe();
      unsubHostEvents();
      panesResizeObserver?.disconnect?.();
      dialogMutationObserver?.disconnect?.();
      globalThis.removeEventListener?.('resize', onWindowResize);
      doc.removeEventListener?.('close', onDocumentDialogClose, true);
      doc.removeEventListener?.('sanctuary:overlay-change', onOverlayChange);
      if (getBrowserHostKind() !== 'web-companion') {
        syncBrowserHostLayout({ active: false, overlayOpen: false, panes: [], focusedPane: 'primary' });
      }
      for (const ctrl of tabAbortMap.values()) {
        ctrl.abort();
      }
      tabAbortMap.clear();
    },
  };
}
