/* SPDX-License-Identifier: AGPL-3.0-or-later */

import {
  actOnBrowserHostTab,
  clearBrowserHostHistory,
  closeBrowserHostTab,
  extractBrowserTabContent,
  loadBrowserTabPage,
  stepBrowserHostHistory,
  syncBrowserHostPrivacy,
  syncBrowserHostSearchConfig,
} from '../adapters/browserBridge.js';
import {
  NEWTAB_URL,
  extractHostname,
  normalizeSearchEngineId,
  resolveAddressBarInput,
  stripTrackingParams,
} from '../core/urlPrivacy.js';
import {
  deleteSanctuaryBrowserBookmark,
  fetchProjectSettings,
  fetchSanctuaryBrowserBookmarks,
  saveProjectSettings,
  saveSanctuaryBrowserBookmark,
} from '../queries/sanctuary.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
import { connectionStore } from './sanctuary/connection.js';
import { createStore } from './store.js';

const SEARCH_CONFIG_KV_KEY = 'browser_search_config_v1';
const PRIVACY_KV_KEY = 'browser_privacy_v1';
const BOOKMARKS_KV_KEY = 'browser_bookmarks_v1';
const BOOKMARK_DELETIONS_KV_KEY = 'browser_bookmark_deletions_v1';
const SPLIT_PCT_KV_KEY = 'sanctuary_split_pct_v1';

export const DEFAULT_SANCTUARY_SPLIT_PCT = 42;
export const MIN_SANCTUARY_SPLIT_PCT = 28;
export const MAX_SANCTUARY_SPLIT_PCT = 60;

let seqCounter = 0;
let serverBookmarkSyncPromise = null;

function createTabId() {
  seqCounter += 1;
  return `tab_${Date.now().toString(36)}_${seqCounter}`;
}

function createBookmarkId() {
  seqCounter += 1;
  return `bm_${Date.now().toString(36)}_${seqCounter}`;
}

function createTabRecord(
  url = NEWTAB_URL,
  { id = '', title = '', viewMode = 'frame', isPrivate = false, nativePending = false } = {}
) {
  const cleanUrl = url && url !== NEWTAB_URL ? String(url) : NEWTAB_URL;
  const host = extractHostname(cleanUrl);
  const priv = Boolean(isPrivate);
  const pending = Boolean(nativePending && cleanUrl === NEWTAB_URL);
  return {
    id: id ? String(id) : createTabId(),
    url: cleanUrl,
    title: title || (cleanUrl === NEWTAB_URL ? (pending ? 'Loading…' : (priv ? 'Private Tab' : 'New Tab')) : host || cleanUrl),
    isPrivate: priv,
    nativePending: pending,
    nativeCanGoBack: false,
    nativeCanGoForward: false,
    loading: cleanUrl !== NEWTAB_URL || pending,
    history: [cleanUrl],
    historyIndex: 0,
    viewMode: viewMode === 'reader' ? 'reader' : 'frame',
    readerData: null,
    frameAllowed: true,
    frameBlockedReason: '',
    error: '',
    blockedCount: 0,
  };
}

export function isStandalonePrivateWindow() {
  try {
    return new URLSearchParams(globalThis.location?.search || '').get('privateWindow') === '1';
  } catch {
    return false;
  }
}

export function getInitialPrivateWindowUrl(stripTrackers = true) {
  try {
    const raw = String(new URLSearchParams(globalThis.location?.search || '').get('privateUrl') || '').trim();
    if (!/^https?:\/\//i.test(raw)) return NEWTAB_URL;
    return stripTrackers ? stripTrackingParams(raw) : raw;
  } catch {
    return NEWTAB_URL;
  }
}

function createInitialBrowserState() {
  const privateWindow = isStandalonePrivateWindow();
  const initialUrl = privateWindow ? getInitialPrivateWindowUrl(true) : NEWTAB_URL;
  const firstTab = createTabRecord(initialUrl, { isPrivate: privateWindow });
  return {
    isPrivateWindow: privateWindow,
    tabs: [firstTab],
    activeTabId: firstTab.id,
    splitTabId: null,
    focusedPane: 'primary',
    sanctuarySplitPct: DEFAULT_SANCTUARY_SPLIT_PCT,
    bookmarks: [],
    deletedBookmarkIds: [],
    searchConfig: {
      engine: '',
      searxngUrl: '',
      customTemplate: '',
    },
    privacy: {
      shieldLevel: 'balanced',
      stripTrackingParams: true,
      sendGpc: true,
      defaultJsEnabled: true,
      siteOverrides: {},
    },
  };
}

export const browserStore = createStore(createInitialBrowserState());

export function clampSanctuarySplitPct(pct) {
  const n = Number(pct);
  if (!Number.isFinite(n)) return DEFAULT_SANCTUARY_SPLIT_PCT;
  return Math.min(MAX_SANCTUARY_SPLIT_PCT, Math.max(MIN_SANCTUARY_SPLIT_PCT, Math.round(n)));
}

function normalizeUrlForStorage(rawUrl, stripTrackers = true) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed || trimmed === NEWTAB_URL || trimmed === 'about:blank') return NEWTAB_URL;
  return stripTrackers ? stripTrackingParams(trimmed) : trimmed;
}

export function resetBrowserStoreForTests() {
  seqCounter = 0;
  serverBookmarkSyncPromise = null;
  browserStore.set(createInitialBrowserState());
}

export async function hydrateBrowserStore() {
  const [savedSearch, savedPrivacy, savedBookmarks, savedDeletedIds, savedSplitPct] = await Promise.all([
    kvGet(SEARCH_CONFIG_KV_KEY, null),
    kvGet(PRIVACY_KV_KEY, null),
    kvGet(BOOKMARKS_KV_KEY, null),
    kvGet(BOOKMARK_DELETIONS_KV_KEY, null),
    kvGet(SPLIT_PCT_KV_KEY, null),
  ]);

  browserStore.set((prev) => ({
    sanctuarySplitPct: savedSplitPct !== null ? clampSanctuarySplitPct(savedSplitPct) : prev.sanctuarySplitPct,
    searchConfig: savedSearch && typeof savedSearch === 'object'
      ? {
          engine: normalizeSearchEngineId(savedSearch.engine),
          searxngUrl: String(savedSearch.searxngUrl || ''),
          customTemplate: String(savedSearch.customTemplate || ''),
        }
      : prev.searchConfig,
    privacy: savedPrivacy && typeof savedPrivacy === 'object'
      ? {
          shieldLevel: ['balanced', 'strict', 'off'].includes(savedPrivacy.shieldLevel)
            ? savedPrivacy.shieldLevel
            : prev.privacy.shieldLevel,
          stripTrackingParams: savedPrivacy.stripTrackingParams !== false,
          sendGpc: savedPrivacy.sendGpc !== false,
          defaultJsEnabled: savedPrivacy.defaultJsEnabled !== false,
          siteOverrides:
            savedPrivacy.siteOverrides && typeof savedPrivacy.siteOverrides === 'object'
              ? { ...savedPrivacy.siteOverrides }
              : {},
        }
      : prev.privacy,
    bookmarks: Array.isArray(savedBookmarks) ? savedBookmarks : prev.bookmarks,
    deletedBookmarkIds: Array.isArray(savedDeletedIds) ? savedDeletedIds : prev.deletedBookmarkIds,
  }));

  syncBrowserHostSearchConfig(browserStore.get().searchConfig);
  return browserStore.get();
}

export function setSanctuarySplitPct(pct) {
  const next = clampSanctuarySplitPct(pct);
  browserStore.set({ sanctuarySplitPct: next });
  void kvSet(SPLIT_PCT_KV_KEY, next);
  return next;
}

export function setSearchConfig(patch = {}, { syncRemote = true } = {}) {
  let nextConfig;
  browserStore.set((prev) => {
    nextConfig = {
      engine:
        patch.engine !== undefined
          ? normalizeSearchEngineId(patch.engine)
          : normalizeSearchEngineId(prev.searchConfig.engine),
      searxngUrl: patch.searxngUrl !== undefined ? String(patch.searxngUrl || '').trim() : prev.searchConfig.searxngUrl,
      customTemplate:
        patch.customTemplate !== undefined ? String(patch.customTemplate || '').trim() : prev.searchConfig.customTemplate,
    };
    return { searchConfig: nextConfig };
  });
  void kvSet(SEARCH_CONFIG_KV_KEY, nextConfig);
  syncBrowserHostSearchConfig(nextConfig);
  if (syncRemote && connectionStore.get().mode === 'online') {
    void saveProjectSettings({
      browser_search_engine: nextConfig.engine,
      searxng_url: nextConfig.searxngUrl,
      browser_custom_search_url: nextConfig.customTemplate,
    }).catch(() => {});
  }
  return nextConfig;
}

export async function syncSearchConfigWithServer() {
  if (connectionStore.get().mode !== 'online') {
    return browserStore.get().searchConfig;
  }
  let cfg = null;
  try {
    cfg = await fetchProjectSettings();
  } catch {
    return browserStore.get().searchConfig;
  }
  if (!cfg || typeof cfg !== 'object') {
    return browserStore.get().searchConfig;
  }

  const local = browserStore.get().searchConfig;
  const remoteEngine = normalizeSearchEngineId(cfg.browser_search_engine);
  const remoteSearx = String(cfg.searxng_url || '').trim();
  const remoteCustom = String(cfg.browser_custom_search_url || '').trim();

  if ((remoteEngine || (remoteSearx && !local.searxngUrl)) && !local.engine) {
    return setSearchConfig(
      {
        engine: remoteEngine,
        searxngUrl: remoteSearx || local.searxngUrl,
        customTemplate: remoteCustom || local.customTemplate,
      },
      { syncRemote: false }
    );
  }
  if (local.engine && !remoteEngine) {
    void saveProjectSettings({
      browser_search_engine: local.engine,
      searxng_url: local.searxngUrl || remoteSearx,
      browser_custom_search_url: local.customTemplate || remoteCustom,
    }).catch(() => {});
  }
  return browserStore.get().searchConfig;
}

export function setPrivacySettings(patch = {}) {
  let nextPrivacy;
  browserStore.set((prev) => {
    nextPrivacy = {
      ...prev.privacy,
      ...patch,
      siteOverrides:
        patch.siteOverrides && typeof patch.siteOverrides === 'object'
          ? { ...patch.siteOverrides }
          : prev.privacy.siteOverrides,
    };
    return { privacy: nextPrivacy };
  });
  if (!browserStore.get().isPrivateWindow) {
    void kvSet(PRIVACY_KV_KEY, nextPrivacy);
  }
  syncBrowserHostPrivacy(nextPrivacy);
  return nextPrivacy;
}

export function isJavaScriptEnabledForUrl(rawUrl, privacyState = browserStore.get().privacy) {
  const host = extractHostname(rawUrl);
  const override = host ? privacyState?.siteOverrides?.[host] : null;
  if (override && typeof override.jsEnabled === 'boolean') {
    return override.jsEnabled;
  }
  return privacyState?.defaultJsEnabled !== false;
}

export function toggleSiteJavaScript(rawUrl) {
  const host = extractHostname(rawUrl);
  if (!host) return browserStore.get().privacy.defaultJsEnabled;
  const currentPrivacy = browserStore.get().privacy;
  const nextVal = !isJavaScriptEnabledForUrl(rawUrl, currentPrivacy);
  const nextOverrides = {
    ...(currentPrivacy.siteOverrides || {}),
    [host]: {
      ...(currentPrivacy.siteOverrides?.[host] || {}),
      jsEnabled: nextVal,
    },
  };
  setPrivacySettings({ siteOverrides: nextOverrides });
  return nextVal;
}

export function openBrowserTab(
  url = NEWTAB_URL,
  { id = '', activate = true, inSplit = false, title = '', isPrivate = false, nativePending = false } = {}
) {
  const state = browserStore.get();
  const explicitId = id ? String(id) : '';
  if (explicitId) {
    const existing = state.tabs.find((t) => t.id === explicitId);
    if (existing) {
      if (activate) {
        selectBrowserTab(explicitId);
      }
      return explicitId;
    }
  }
  const cleanUrl = normalizeUrlForStorage(url, state.privacy.stripTrackingParams);
  const effectivePrivate = Boolean(isPrivate || state.isPrivateWindow);
  const tab = createTabRecord(cleanUrl, { id: explicitId, title, isPrivate: effectivePrivate, nativePending });

  browserStore.set((prev) => {
    const nextTabs = [...prev.tabs, tab];
    if (inSplit) {
      const nextPrimary = prev.activeTabId || nextTabs[0].id;
      return {
        tabs: nextTabs,
        activeTabId: nextPrimary,
        splitTabId: tab.id,
        focusedPane: activate ? 'split' : prev.focusedPane,
      };
    }
    return {
      tabs: nextTabs,
      activeTabId: activate ? tab.id : prev.activeTabId,
      focusedPane: activate ? 'primary' : prev.focusedPane,
    };
  });

  return tab.id;
}

export function moveBrowserTab(tabId, toIndex) {
  browserStore.set((prev) => {
    const from = prev.tabs.findIndex((t) => t.id === tabId);
    if (from === -1) return {};
    const count = prev.tabs.length;
    let to = Math.trunc(Number(toIndex));
    if (!Number.isFinite(to)) return {};
    to = Math.max(0, Math.min(count - 1, to));
    if (to === from) return {};
    const tabs = [...prev.tabs];
    const [moved] = tabs.splice(from, 1);
    tabs.splice(to, 0, moved);
    return { tabs };
  });
}

export function selectBrowserTab(tabId, { pane = null } = {}) {
  browserStore.set((prev) => {
    const exists = prev.tabs.some((t) => t.id === tabId);
    if (!exists) return {};
    if (pane === 'split' || (pane === null && prev.splitTabId === tabId)) {
      return {
        splitTabId: tabId,
        focusedPane: 'split',
      };
    }
    return {
      activeTabId: tabId,
      focusedPane: 'primary',
    };
  });
}

export function focusBrowserPane(pane) {
  browserStore.set((prev) => {
    if (pane === 'split' && prev.splitTabId) {
      return { focusedPane: 'split' };
    }
    return { focusedPane: 'primary' };
  });
}

export function navigateBrowserTab(
  tabId,
  rawUrl,
  { pushHistory = true, title = '', nativeCanGoBack, nativeCanGoForward } = {}
) {
  const state = browserStore.get();
  const targetId = tabId || state.activeTabId || state.tabs[0]?.id;
  if (!targetId) return '';
  const cleanUrl = normalizeUrlForStorage(rawUrl, state.privacy.stripTrackingParams);
  const host = extractHostname(cleanUrl);

  browserStore.set((prev) => ({
    tabs: prev.tabs.map((tab) => {
      if (tab.id !== targetId) return tab;
      let nextHistory = tab.history || [tab.url];
      let nextIndex = Number.isInteger(tab.historyIndex) ? tab.historyIndex : nextHistory.length - 1;
      if (tab.nativePending && nextHistory.length === 1 && nextHistory[0] === NEWTAB_URL && cleanUrl !== NEWTAB_URL) {
        nextHistory = [cleanUrl];
        nextIndex = 0;
      } else if (pushHistory && nextHistory[nextIndex] !== cleanUrl) {
        nextHistory = [...nextHistory.slice(0, nextIndex + 1), cleanUrl];
        nextIndex = nextHistory.length - 1;
      }
      const prevHost = tab.url && tab.url !== NEWTAB_URL ? extractHostname(tab.url) : '';
      const fallbackTitle =
        cleanUrl === NEWTAB_URL
          ? tab.isPrivate
            ? 'Private Tab'
            : 'New Tab'
          : tab.title && prevHost && prevHost === host
            ? tab.title
            : host || cleanUrl;
      const nextNativeBack =
        typeof nativeCanGoBack === 'boolean'
          ? nativeCanGoBack
          : cleanUrl === NEWTAB_URL && tab.url === NEWTAB_URL
            ? false
            : Boolean(tab.nativeCanGoBack);
      const nextNativeForward =
        typeof nativeCanGoForward === 'boolean'
          ? nativeCanGoForward
          : cleanUrl === NEWTAB_URL && tab.url === NEWTAB_URL
            ? false
            : Boolean(tab.nativeCanGoForward);
      return {
        ...tab,
        url: cleanUrl,
        nativePending: false,
        nativeCanGoBack: nextNativeBack,
        nativeCanGoForward: nextNativeForward,
        title: title || fallbackTitle,
        loading: cleanUrl !== NEWTAB_URL,
        history: nextHistory,
        historyIndex: nextIndex,
        readerData: null,
        frameAllowed: true,
        frameBlockedReason: '',
        error: '',
      };
    }),
  }));

  return cleanUrl;
}

export function updateBrowserTabResult(tabId, patch = {}) {
  browserStore.set((prev) => ({
    tabs: prev.tabs.map((tab) => (tab.id === tabId ? { ...tab, ...patch } : tab)),
  }));
}

function stepBrowserHistory(tabId, delta) {
  const tab = browserStore.get().tabs.find((t) => t.id === tabId);
  const nextIndex = (tab?.historyIndex ?? -1) + delta;
  if (!tab || nextIndex < 0 || nextIndex >= (tab.history?.length || 0)) return null;
  const nextUrl = tab.history[nextIndex] || NEWTAB_URL;
  const host = extractHostname(nextUrl);
  browserStore.set((prev) => ({
    tabs: prev.tabs.map((t) =>
      t.id === tabId
        ? {
            ...t,
            url: nextUrl,
            historyIndex: nextIndex,
            loading: nextUrl !== NEWTAB_URL,
            readerData: null,
            frameAllowed: true,
            frameBlockedReason: '',
            error: '',
            title: nextUrl === NEWTAB_URL ? (t.isPrivate ? 'Private Tab' : 'New Tab') : host || nextUrl,
          }
        : t
    ),
  }));
  return nextUrl;
}

export function goBackBrowserTab(tabId) {
  return stepBrowserHistory(tabId, -1);
}

export function goForwardBrowserTab(tabId) {
  return stepBrowserHistory(tabId, 1);
}

export async function clearBrowserHistory() {
  browserStore.set((prev) => ({
    tabs: prev.tabs.map((t) => ({
      ...t,
      history: [t.url || NEWTAB_URL],
      historyIndex: 0,
      nativeCanGoBack: false,
      nativeCanGoForward: false,
    })),
  }));
  await clearBrowserHostHistory();
  return { cleared: true };
}

export function closeBrowserTab(tabId) {
  let removed = false;
  browserStore.set((prev) => {
    const idx = prev.tabs.findIndex((t) => t.id === tabId);
    if (idx === -1) return {};
    removed = true;
    const remaining = prev.tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      const fresh = createTabRecord(NEWTAB_URL, { isPrivate: Boolean(prev.isPrivateWindow) });
      return {
        tabs: [fresh],
        activeTabId: fresh.id,
        splitTabId: null,
        focusedPane: 'primary',
      };
    }

    let nextActive = prev.activeTabId;
    let nextSplit = prev.splitTabId;
    let nextFocus = prev.focusedPane;

    if (nextSplit === tabId) {
      nextSplit = null;
      nextFocus = 'primary';
    }
    if (nextActive === tabId) {
      const candidate = remaining[Math.min(idx, remaining.length - 1)] || remaining[0];
      if (nextSplit && candidate.id === nextSplit) {
        const other = remaining.find((t) => t.id !== nextSplit);
        if (other) {
          nextActive = other.id;
        } else {
          nextActive = nextSplit;
          nextSplit = null;
          nextFocus = 'primary';
        }
      } else {
        nextActive = candidate.id;
      }
    }

    return {
      tabs: remaining,
      activeTabId: nextActive,
      splitTabId: nextSplit,
      focusedPane: nextFocus,
    };
  });
  if (removed) {
    closeBrowserHostTab(tabId);
  }
}

export function toggleBrowserSplitView() {
  browserStore.set((prev) => {
    if (prev.splitTabId) {
      return {
        splitTabId: null,
        focusedPane: 'primary',
      };
    }
    const existingOther = prev.tabs.find((t) => t.id !== prev.activeTabId);
    if (existingOther) {
      return {
        splitTabId: existingOther.id,
        focusedPane: 'split',
      };
    }
    const newTab = createTabRecord(NEWTAB_URL, { isPrivate: Boolean(prev.isPrivateWindow) });
    return {
      tabs: [...prev.tabs, newTab],
      splitTabId: newTab.id,
      focusedPane: 'split',
    };
  });
}

export function setTabViewMode(tabId, viewMode) {
  const mode = viewMode === 'frame' ? 'frame' : 'reader';
  browserStore.set((prev) => ({
    tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, viewMode: mode } : t)),
  }));
}

export function isUrlBookmarked(rawUrl, bookmarks = browserStore.get().bookmarks) {
  const cleanUrl = normalizeUrlForStorage(rawUrl, true);
  if (!cleanUrl || cleanUrl === NEWTAB_URL) return false;
  return bookmarks.some((b) => b?.url === cleanUrl);
}

async function persistBookmarksLocal(bookmarks, deletedIds) {
  await Promise.all([
    kvSet(BOOKMARKS_KV_KEY, bookmarks),
    kvSet(BOOKMARK_DELETIONS_KV_KEY, deletedIds),
  ]);
}

export async function toggleBookmark({ url, title = '', folder = '' } = {}) {
  const state = browserStore.get();
  const cleanUrl = normalizeUrlForStorage(url, state.privacy.stripTrackingParams);
  if (!cleanUrl || cleanUrl === NEWTAB_URL) return { added: false, bookmark: null };

  const existing = state.bookmarks.find((b) => b?.url === cleanUrl);
  if (existing) {
    await removeBookmark(existing.id);
    return { added: false, bookmark: null };
  }

  const now = Date.now();
  const record = {
    id: createBookmarkId(),
    url: cleanUrl,
    title: String(title || extractHostname(cleanUrl) || cleanUrl).trim().slice(0, 300),
    folder: String(folder || '').trim().slice(0, 120),
    createdAt: now,
    updatedAt: now,
  };
  const nextBookmarks = [record, ...state.bookmarks];
  browserStore.set({ bookmarks: nextBookmarks });
  await persistBookmarksLocal(nextBookmarks, browserStore.get().deletedBookmarkIds);

  if (connectionStore.get().mode === 'online') {
    void saveSanctuaryBrowserBookmark(record.id, record).catch(() => {});
  }
  return { added: true, bookmark: record };
}

export async function removeBookmark(bookmarkId) {
  const id = String(bookmarkId || '').trim();
  if (!id) return;
  let nextBookmarks = [];
  let nextDeleted = [];
  browserStore.set((prev) => {
    nextBookmarks = prev.bookmarks.filter((b) => b.id !== id);
    nextDeleted = prev.deletedBookmarkIds.includes(id)
      ? prev.deletedBookmarkIds
      : [...prev.deletedBookmarkIds, id];
    return {
      bookmarks: nextBookmarks,
      deletedBookmarkIds: nextDeleted,
    };
  });
  await persistBookmarksLocal(nextBookmarks, nextDeleted);

  if (connectionStore.get().mode === 'online') {
    void deleteSanctuaryBrowserBookmark(id).catch(() => {});
  }
}

export async function syncBrowserBookmarksWithServer() {
  if (connectionStore.get().mode !== 'online') {
    return browserStore.get().bookmarks;
  }
  if (serverBookmarkSyncPromise) {
    return serverBookmarkSyncPromise;
  }

  serverBookmarkSyncPromise = (async () => {
    const localState = browserStore.get();
    const deletedSet = new Set(localState.deletedBookmarkIds || []);
    for (const delId of [...deletedSet]) {
      await deleteSanctuaryBrowserBookmark(delId).catch(() => {});
    }

    const remote = await fetchSanctuaryBrowserBookmarks();
    const serverDeletedSet = new Set(Array.isArray(remote?.deletedIds) ? remote.deletedIds : []);
    const allDeleted = new Set([...deletedSet, ...serverDeletedSet]);

    const mergedById = new Map();
    for (const bm of Array.isArray(remote?.bookmarks) ? remote.bookmarks : []) {
      if (bm?.id && !allDeleted.has(bm.id)) {
        mergedById.set(bm.id, bm);
      }
    }

    const toUpload = [];
    for (const bm of localState.bookmarks || []) {
      if (!bm?.id || allDeleted.has(bm.id)) continue;
      const prevRemote = mergedById.get(bm.id);
      if (!prevRemote || Number(bm.updatedAt || 0) > Number(prevRemote.updatedAt || 0)) {
        mergedById.set(bm.id, bm);
        toUpload.push(bm);
      }
    }

    for (const bm of toUpload) {
      await saveSanctuaryBrowserBookmark(bm.id, bm).catch(() => {});
    }

    const nextBookmarks = [...mergedById.values()].sort(
      (a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0)
    );
    const nextDeletedIds = [...allDeleted];
    browserStore.set({
      bookmarks: nextBookmarks,
      deletedBookmarkIds: nextDeletedIds,
    });
    await persistBookmarksLocal(nextBookmarks, nextDeletedIds);
    return nextBookmarks;
  })();

  try {
    return await serverBookmarkSyncPromise;
  } finally {
    serverBookmarkSyncPromise = null;
  }
}

export async function executeBrowserAgentCommand(cmd = {}, { onActivateBrowser } = {}) {
  const action = String(cmd?.action || 'snapshot').trim().toLowerCase();
  const args = cmd?.args && typeof cmd.args === 'object' ? cmd.args : {};
  const state = browserStore.get();

  const defaultTabId =
    (state.focusedPane === 'split' && state.splitTabId) ||
    state.activeTabId ||
    state.tabs[0]?.id ||
    '';
  const targetTabId = String(args.tab_id || defaultTabId || '').trim();
  const targetTab = state.tabs.find((t) => t.id === targetTabId) || state.tabs[0] || null;

  if (action === 'list_tabs') {
    return {
      ok: true,
      activeTabId: state.activeTabId,
      splitTabId: state.splitTabId,
      tabs: state.tabs.map((t) => ({
        id: t.id,
        title: t.title || 'Tab',
        url: t.url || NEWTAB_URL,
        active: t.id === targetTabId,
      })),
    };
  }

  if (action === 'open' || action === 'navigate') {
    const rawTarget = String(args.url || args.text || '').trim();
    if (!rawTarget) {
      return { ok: false, error: 'missing_url', message: 'Provide `url` or search query for `open`.' };
    }
    const resolved = resolveAddressBarInput(rawTarget, {
      searchConfig: state.searchConfig,
      stripTrackers: state.privacy.stripTrackingParams !== false,
    });
    if (resolved.kind === 'needs_search_engine') {
      return {
        ok: false,
        error: 'needs_search_engine',
        message: 'No Browser Search Engine is configured in Settings -> Browser Search Engine (or prefix with @eco / @ddg).',
      };
    }
    const destUrl = resolved.url || rawTarget;
    onActivateBrowser?.();
    let destTabId = targetTabId;
    if (args.new_tab || args.split || !destTabId) {
      destTabId = openBrowserTab(destUrl, { activate: true, inSplit: Boolean(args.split) });
    } else {
      navigateBrowserTab(destTabId, destUrl, { pushHistory: true });
    }
    const loaded = await loadBrowserTabPage(destTabId, destUrl, { privacy: state.privacy }).catch(() => null);
    if (loaded) {
      updateBrowserTabResult(destTabId, {
        url: loaded.url || destUrl,
        title: loaded.title || extractHostname(destUrl) || destUrl,
        loading: false,
        blockedCount: Number(loaded.blockedCount || 0),
      });
    }
    return {
      ok: true,
      tabId: destTabId,
      url: loaded?.url || destUrl,
      title: loaded?.title || extractHostname(destUrl) || destUrl,
    };
  }

  if (action === 'close_tab') {
    if (!targetTabId) return { ok: false, error: 'no_tab', message: 'No tab to close.' };
    closeBrowserHostTab(targetTabId);
    closeBrowserTab(targetTabId);
    return { ok: true, tabId: targetTabId };
  }

  if (action === 'back' || action === 'forward') {
    const delta = action === 'back' ? -1 : 1;
    const hostRes = await stepBrowserHostHistory(targetTabId, delta);
    const nextUrl = hostRes?.handled
      ? (browserStore.get().tabs.find((t) => t.id === targetTabId)?.url || '')
      : (delta < 0 ? goBackBrowserTab(targetTabId) : goForwardBrowserTab(targetTabId));
    if (!hostRes?.handled && !nextUrl) {
      return { ok: false, error: 'no_history', message: `Cannot step ${action} in this tab.` };
    }
    const updatedTab = browserStore.get().tabs.find((t) => t.id === targetTabId);
    return { ok: true, tabId: targetTabId, url: updatedTab?.url || nextUrl || '', title: updatedTab?.title || '' };
  }

  const hostResult = await actOnBrowserHostTab(targetTabId, action, args);
  if (hostResult && typeof hostResult === 'object') {
    return hostResult;
  }

  if (action === 'read' || action === 'snapshot') {
    if (!targetTab || !targetTab.url || targetTab.url === NEWTAB_URL) {
      return { ok: false, error: 'empty_tab', message: 'The active Browser tab is currently on New Tab.' };
    }
    const extracted = await extractBrowserTabContent(targetTabId, { url: targetTab.url }).catch(() => null);
    if (extracted?.text) {
      return {
        ok: true,
        url: extracted.url || targetTab.url,
        title: extracted.title || targetTab.title,
        text: extracted.text,
        snapshot: extracted.text,
      };
    }
    return { ok: false, error: 'read_failed', message: `Could not read content from ${targetTab.url}.` };
  }

  return {
    ok: false,
    error: 'gecko_required',
    message: `Interactive '${action}' requires the native Sanctuary Browser desktop window.`,
  };
}
