/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import {
  NEWTAB_URL,
  extractHostname,
  stripTrackingParams,
} from '../core/urlPrivacy.js';
import {
  associateKeePassXC,
  fetchKeePassXCLogins,
  fetchKeePassXCStatus,
  fetchSanctuaryBrowserReader,
  lockKeePassXC,
  unlockKeePassXC,
} from '../queries/sanctuary.js';
import { authStore, lockSocialVaultSession, setKeePassVaultMode, syncSocialAccountsWithServer } from '../state/authStore.js';
import { connectionStore, emitSanctuaryEvent } from '../state/sanctuary/connection.js';

let cachedKeePassStatus = null;

/**
 * Detect active browser engine host:
 * - 'gecko-desktop': Native Sanctuary Browser Gecko shell (Stage 2)
 * - 'geckoview-android': Sanctuary Browser GeckoView shell (Stage 3)
 * - 'web-companion': Standalone / pywebview / Capacitor Stage 1 shell
 */
export function getBrowserHostKind() {
  if (typeof globalThis.sanctuaryBrowserHost?.loadTab === 'function') {
    return 'gecko-desktop';
  }
  if (typeof globalThis.SanctuaryGeckoBridge?.loadTab === 'function') {
    return 'geckoview-android';
  }
  return 'web-companion';
}

export async function refreshKeePassStatus() {
  if (connectionStore.get().mode !== 'online') return null;
  try {
    const st = await fetchKeePassXCStatus();
    if (st && typeof st === 'object') {
      cachedKeePassStatus = st;
      await setKeePassVaultMode(st.vault_mode === 'keepassxc');
      if (st.vault_mode === 'keepassxc') {
        if (!st.database_unlocked) {
          await lockSocialVaultSession();
        } else if (authStore.get().vaultLocked) {
          authStore.set({ vaultLocked: false });
        }
      }
      return st;
    }
  } catch {
    // Ignore transient status fetch failure
  }
  return null;
}

/**
 * Describe KeePass integration state for the current runtime.
 */
export function getPasswordManagerStatus() {
  const hostKind = getBrowserHostKind();
  if (hostKind === 'geckoview-android') {
    return {
      provider: 'Android Autofill (KeePassDX)',
      extensionId: 'android-autofill',
      ready: true,
      detail: 'Fills .kdbx credentials via Android Autofill Framework',
    };
  }
  if (cachedKeePassStatus) {
    const st = cachedKeePassStatus;
    const initialized = Boolean(st.initialized);
    const ready = Boolean(initialized && st.database_unlocked);
    const locked = Boolean(initialized && !st.database_unlocked);
    const vaultEscrowed = st.vault_mode === 'keepassxc';
    const count = Number(st.entry_count || 0);
    let detail = 'Encrypted .kdbx v4 vault — set a master password or import a .kdbx file';
    if (ready) {
      detail = `Unlocked (.kdbx v4) · ${count} ${count === 1 ? 'entry' : 'entries'}${vaultEscrowed ? ' · Social Vault Active' : ''}`;
    } else if (locked) {
      detail = 'Vault locked — unlock with your master password to autofill';
    }
    return {
      provider: 'Sanctuary Vault (.kdbx)',
      extensionId: 'sanctuary-kdbx-vault',
      cached: true,
      initialized,
      ready,
      locked,
      installed: true,
      running: true,
      associated: initialized,
      needsPairOrEscrow: !initialized || locked,
      entryCount: count,
      vaultMode: st.vault_mode || 'local',
      detail,
    };
  }
  return {
    provider: 'Sanctuary Vault (.kdbx)',
    extensionId: 'sanctuary-kdbx-vault',
    initialized: false,
    ready: false,
    locked: false,
    installed: true,
    running: true,
    detail: 'Checking in-app .kdbx vault status…',
  };
}

export function closeBrowserHostTab(tabId) {
  if (!tabId) return;
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.closeTab === 'function') {
      globalThis.sanctuaryBrowserHost.closeTab(tabId);
    } else if (typeof globalThis.SanctuaryGeckoBridge?.closeTab === 'function') {
      globalThis.SanctuaryGeckoBridge.closeTab(tabId);
    }
  } catch {
    // Best-effort native host notification
  }
}

export function syncBrowserHostLayout(layout) {
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.syncLayout === 'function') {
      globalThis.sanctuaryBrowserHost.syncLayout(layout);
    } else if (typeof globalThis.SanctuaryGeckoBridge?.syncLayout === 'function') {
      globalThis.SanctuaryGeckoBridge.syncLayout(layout);
    }
  } catch {
    // Best-effort viewport geometry sync
  }
}

export function syncBrowserHostPrivacy(privacy) {
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.setPrivacy === 'function') {
      globalThis.sanctuaryBrowserHost.setPrivacy(privacy);
    } else if (typeof globalThis.SanctuaryGeckoBridge?.setPrivacy === 'function') {
      globalThis.SanctuaryGeckoBridge.setPrivacy(privacy);
    }
  } catch {
    // Best-effort privacy sync
  }
}

export function syncBrowserHostProgramTheme(tokens) {
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.setProgramTheme === 'function') {
      globalThis.sanctuaryBrowserHost.setProgramTheme(tokens);
    } else if (typeof globalThis.SanctuaryGeckoBridge?.setProgramTheme === 'function') {
      globalThis.SanctuaryGeckoBridge.setProgramTheme(tokens);
    }
  } catch {
    // Best-effort chrome theme sync
  }
}

export function syncBrowserHostSearchConfig(searchConfig) {
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.setSearchConfig === 'function') {
      globalThis.sanctuaryBrowserHost.setSearchConfig(searchConfig);
    }
  } catch {
    // Best-effort search config sync
  }
}

export async function openPrivateBrowserWindow({ url = '', searchConfig = null } = {}) {
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.openPrivateWindow === 'function') {
      const res = await globalThis.sanctuaryBrowserHost.openPrivateWindow({ url, searchConfig });
      return { openedNative: res?.opened !== false };
    }
  } catch {
    // Fall back to ephemeral private tab in companion UI
  }
  return { openedNative: false };
}

export async function connectKeePassXC() {
  if (connectionStore.get().mode === 'online') {
    try {
      const st = cachedKeePassStatus?.associated && !cachedKeePassStatus?.database_unlocked
        ? await unlockKeePassXC()
        : await associateKeePassXC();
      if (st && typeof st === 'object') {
        cachedKeePassStatus = st;
        await setKeePassVaultMode(st.vault_mode === 'keepassxc');
        if (st.database_unlocked) {
          await syncSocialAccountsWithServer().catch(() => {});
          emitSanctuaryEvent('sanctuary:vault-changed', { unlocked: true });
        }
        return Boolean(st.associated && st.database_unlocked);
      }
    } catch (err) {
      if (err?.status !== 404) {
        throw err;
      }
    }
  }
  if (typeof globalThis.sanctuaryBrowserHost?.installOrOpenKeePassXC === 'function') {
    return globalThis.sanctuaryBrowserHost.installOrOpenKeePassXC();
  }
  return false;
}

export async function lockKeePassXCVault() {
  if (connectionStore.get().mode !== 'online') return null;
  const st = await lockKeePassXC();
  if (st && typeof st === 'object') {
    cachedKeePassStatus = st;
  }
  return st;
}

export async function fillKeePassXCLoginForUrl(url) {
  if (connectionStore.get().mode !== 'online' || !url) return [];
  const res = await fetchKeePassXCLogins(url);
  return Array.isArray(res?.entries) ? res.entries : [];
}

export async function autofillBrowserHostTab(tabId, { login = '', password = '' } = {}) {
  if (!tabId) return null;
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.autofillTab === 'function') {
      return await globalThis.sanctuaryBrowserHost.autofillTab(tabId, { login, password });
    }
  } catch {
    // Ignore host autofill failures
  }
  return null;
}

export async function captureBrowserTabPreview(tabId) {
  if (!tabId) return null;
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.captureTabPreview === 'function') {
      return await globalThis.sanctuaryBrowserHost.captureTabPreview(tabId);
    }
  } catch {
    // Ignore host tab preview failures
  }
  return null;
}

export async function clearBrowserHostHistory() {
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.clearHistory === 'function') {
      return await globalThis.sanctuaryBrowserHost.clearHistory();
    }
  } catch {
    // Ignore host history clear errors
  }
  return { cleared: false };
}

export function subscribeBrowserHostEvents(listener) {
  if (typeof listener !== 'function') return () => {};
  const host = globalThis.sanctuaryBrowserHost || globalThis.SanctuaryGeckoBridge;
  if (typeof host?.onEvent !== 'function') return () => {};
  let active = true;
  const wrapped = (evt) => {
    if (active) listener(evt);
  };
  const unsub = host.onEvent(wrapped);
  return () => {
    active = false;
    if (typeof unsub === 'function') unsub();
  };
}

export async function stepBrowserHostHistory(tabId, delta = 0) {
  if (!tabId || !delta) return { handled: false };
  try {
    if (typeof globalThis.sanctuaryBrowserHost?.stepHistory === 'function') {
      const res = await globalThis.sanctuaryBrowserHost.stepHistory(tabId, delta);
      return { handled: Boolean(res?.handled) };
    }
  } catch {
    // Fall back to tracked URL history
  }
  return { handled: false };
}

export async function extractBrowserTabContent(tabId, { url = '', signal } = {}) {
  const cleanUrl = String(url || '').trim();
  if (tabId && typeof globalThis.sanctuaryBrowserHost?.extractTabContent === 'function') {
    try {
      const res = await globalThis.sanctuaryBrowserHost.extractTabContent(tabId);
      if (res?.ok && res?.text) {
        return {
          url: String(res.url || cleanUrl),
          title: String(res.title || ''),
          siteName: String(res.siteName || ''),
          text: String(res.text),
          excerpt: String(res.excerpt || ''),
          isSelection: Boolean(res.isSelection),
        };
      }
    } catch {
      // Fall through to online Reader fallback
    }
  }
  if (connectionStore.get().mode === 'online' && cleanUrl.startsWith('https://')) {
    try {
      const readerRes = await fetchSanctuaryBrowserReader(cleanUrl, { mode: 'reader', signal });
      const page = readerRes?.page || null;
      if (page?.markdown && !page?.error) {
        return {
          url: String(page.url || cleanUrl),
          title: String(page.title || ''),
          siteName: String(page.siteName || ''),
          text: String(page.markdown),
          excerpt: String(page.excerpt || ''),
          isSelection: false,
        };
      }
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
    }
  }
  return null;
}

/**
 * Load page content or Reader extraction for a Browser tab.
 */
export async function loadBrowserTabPage(tabId, rawUrl, { privacy = {}, viewMode = 'frame', forceReload = false, signal } = {}) {
  const url = privacy.stripTrackingParams !== false ? stripTrackingParams(rawUrl) : String(rawUrl || '').trim();
  if (!url || url === NEWTAB_URL) {
    return { kind: 'newtab', url: NEWTAB_URL, title: 'New Tab', blockedCount: 0 };
  }

  const hostname = extractHostname(url);
  const hostKind = getBrowserHostKind();
  if (hostKind === 'gecko-desktop') {
    const res = await globalThis.sanctuaryBrowserHost.loadTab(tabId, url, { privacy, viewMode, forceReload });
    if (viewMode === 'reader') {
      if (res?.kind === 'reader' && res?.markdown) {
        return res;
      }
      if (connectionStore.get().mode === 'online' && url.startsWith('https://')) {
        try {
          const readerRes = await fetchSanctuaryBrowserReader(url, { mode: 'reader', signal });
          const rPage = readerRes?.page || null;
          if (rPage?.markdown && !rPage?.error) {
            return {
              kind: 'reader',
              url: rPage.url || url,
              title: rPage.title || res?.title || hostname || url,
              siteName: rPage.siteName || hostname,
              excerpt: rPage.excerpt || '',
              markdown: rPage.markdown,
              blockedCount: Number(res?.blockedCount || rPage.blockedCount || 0),
              frameAllowed: true,
              frameBlockedReason: '',
            };
          }
        } catch (err) {
          if (err?.name === 'AbortError') throw err;
        }
      }
    }
    return {
      kind: 'native',
      url: res?.url || url,
      title: res?.title || hostname || url,
      siteName: res?.siteName || hostname,
      blockedCount: Number(res?.blockedCount || 0),
      frameAllowed: true,
      frameBlockedReason: '',
    };
  }
  if (hostKind === 'geckoview-android') {
    return globalThis.SanctuaryGeckoBridge.loadTab(tabId, url, { privacy, viewMode });
  }
  if (connectionStore.get().mode === 'online' && url.startsWith('https://')) {
    const mode = viewMode === 'reader' ? 'reader' : 'probe';
    try {
      const res = await fetchSanctuaryBrowserReader(url, { mode, signal });
      const page = res?.page || null;
      const frameAllowed = (page?.frameAllowed ?? res?.frameAllowed) !== false;
      const frameBlockedReason = String(page?.frameBlockedReason || res?.frameBlockedReason || '');
      const errText = String(page?.error || res?.error || '');

      if (viewMode === 'reader' && page?.markdown && !errText) {
        return {
          kind: 'reader',
          url: page.url || url,
          title: page.title || hostname || url,
          siteName: page.siteName || hostname,
          excerpt: page.excerpt || '',
          markdown: page.markdown,
          blockedCount: Number(page.blockedCount || 0),
          frameAllowed,
          frameBlockedReason,
        };
      }

      if (frameAllowed === false || errText) {
        return {
          kind: 'refused',
          url: page?.url || url,
          title: page?.title || hostname || url,
          siteName: page?.siteName || hostname,
          excerpt: page?.excerpt || '',
          markdown: page?.markdown || '',
          blockedCount: Number(page?.blockedCount || 0),
          frameAllowed: false,
          frameBlockedReason,
          error:
            errText ||
            (frameBlockedReason
              ? `Live embedding blocked (${frameBlockedReason})`
              : 'Page unavailable in companion WebView'),
        };
      }

      return {
        kind: 'frame',
        url: page?.url || url,
        title: page?.title || hostname || url,
        siteName: page?.siteName || hostname,
        blockedCount: Number(page?.blockedCount || 0),
        frameAllowed: true,
        frameBlockedReason: '',
      };
    } catch (err) {
      if (err?.name === 'AbortError') throw err;
      return {
        kind: 'refused',
        url,
        title: hostname || url,
        siteName: hostname,
        frameAllowed: false,
        frameBlockedReason: '',
        error: err?.message || 'Unable to load webpage',
      };
    }
  }

  return {
    kind: 'frame',
    url,
    title: hostname || url,
    siteName: hostname,
    blockedCount: 0,
    frameAllowed: true,
    frameBlockedReason: '',
  };
}

export async function actOnBrowserHostTab(tabId, action, args = {}) {
  if (typeof globalThis.sanctuaryBrowserHost?.actOnTab === 'function') {
    return globalThis.sanctuaryBrowserHost.actOnTab(tabId || '', action || 'snapshot', args || {});
  }
  return null;
}
