/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mockMobileHealthOnline } from '../__mocks__/mockProgram.js';
import { getBrowserHostKind } from '../web/adapters/browserBridge.js';
import { createAppShell } from '../web/app/_layout.js';
import { mountProgramThread } from '../web/app/programThread.js';
import { createLoopsSlide, createPostCard } from '../web/components/PostCard.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { applyRootProgramTheme, deriveAccentTokens } from '../web/constants/theme.js';
import {
  browserStore,
  executeBrowserAgentCommand,
  resetBrowserStoreForTests,
  setSearchConfig,
} from '../web/state/browserStore.js';
import { resetCompose } from '../web/state/composeStore.js';
import { resetFeedStoreForTests } from '../web/state/feedStore.js';
import { connectionStore, emitSanctuaryEvent, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetSessionStoreForTests } from '../web/state/sanctuary/sessionModel.js';
import { cacheProgramHistory, purgeCachedProgramData, resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

test('gecko-desktop host bridge drives native viewports, modal suppression, split panes, KeePassXC, host events, and Program themes', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevHost = globalThis.sanctuaryBrowserHost;

  const loadedTabs = [];
  const closedTabs = [];
  const layoutUpdates = [];
  const privacyUpdates = [];
  const themeUpdates = [];
  const searchConfigUpdates = [];
  const privateWindowCalls = [];
  const stepHistoryCalls = [];
  const hostListeners = new Set();
  let kpConnected = false;
  let kpConnectCalls = 0;

  globalThis.sanctuaryBrowserHost = {
    async loadTab(tabId, url, opts) {
      loadedTabs.push({ tabId, url, opts });
      return { kind: 'native', url, title: `Native · ${url}`, blockedCount: 1 };
    },
    closeTab(tabId) {
      closedTabs.push(tabId);
    },
    syncLayout(layout) {
      layoutUpdates.push(layout);
    },
    setPrivacy(privacy) {
      privacyUpdates.push(privacy);
    },
    setProgramTheme(tokens) {
      themeUpdates.push(tokens);
    },
    setSearchConfig(cfg) {
      searchConfigUpdates.push(cfg);
    },
    async openPrivateWindow(opts) {
      privateWindowCalls.push(opts);
      return { opened: true };
    },
    async stepHistory(tabId, delta) {
      stepHistoryCalls.push({ tabId, delta });
      return { handled: true, canGoBack: false, canGoForward: delta < 0 };
    },
    isKeePassConnected() {
      return kpConnected;
    },
    async installOrOpenKeePassXC() {
      kpConnectCalls += 1;
      kpConnected = true;
      return true;
    },
    onEvent(cb) {
      hostListeners.add(cb);
      return () => hostListeners.delete(cb);
    },
  };

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/browser/reader')) {
      const body = JSON.parse(opts.body || '{}');
      return new Response(
        JSON.stringify({
          page: {
            url: body.url,
            title: 'Site Title',
            markdown: '',
            frameAllowed: true,
            frameBlockedReason: '',
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let app = null;
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetCompose();
    resetBrowserStoreForTests();

    assert.equal(getBrowserHostKind(), 'gecko-desktop');
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: mockMobileHealthOnline.programs,
    });

    const doc = dom.document;
    const host = doc.createElement('div');
    host.id = 'app-shell';
    doc.body.appendChild(host);

    app = createAppShell(host, { initialTab: 'browser', skipBackgroundInit: true });

    // 1. Navigating to frame-restricted site mounts .browser-pane-viewport natively (no iframe or Stage 1 refusal card)
    const addrInput = host.querySelector('#browser-address-input');
    const addrForm = host.querySelector('.browser-address-form');
    let addrBlurCalls = 0;
    addrInput.blur = () => {
      addrBlurCalls += 1;
      if (doc.activeElement === addrInput) {
        doc.activeElement = doc.body;
      }
    };
    addrInput.focus?.();
    addrInput.value = 'https://threads.example.org/@user';
    addrForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    assert.equal(addrBlurCalls, 1, 'Submitting address bar blurs it so future location changes update value');
    assert.notEqual(doc.activeElement, addrInput);
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(loadedTabs.some((t) => t.url === 'https://threads.example.org/@user'));
    assert.ok(host.querySelector('.browser-pane-viewport'));
    assert.equal(Boolean(host.querySelector('.browser-live-frame')), false);
    assert.equal(Boolean(host.querySelector('.browser-refusal-card')), false);
    const latestLayout = layoutUpdates.at(-1);
    assert.equal(latestLayout?.active, true);
    assert.equal(latestLayout?.overlayOpen, false);
    assert.equal(latestLayout?.panes?.length, 1);

    // Reload button forwards forceReload: true to native host
    host.querySelector('.browser-reload-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(
      loadedTabs.some((t) => t.url === 'https://threads.example.org/@user' && t.opts?.forceReload === true),
      'Reload button passes forceReload: true to SanctuaryHost.loadTab'
    );

    // 2. Opening modal suppresses active native viewport overlay, and closing restores it
    host.querySelector('.browser-shield-btn').click();
    assert.equal(layoutUpdates.at(-1)?.overlayOpen, true);
    assert.equal(layoutUpdates.at(-1)?.active, false);

    host.querySelector('.browser-configure-search-btn').click();
    const cfgDialog = doc.getElementById('browser-search-config-dialog');
    assert.ok(cfgDialog && cfgDialog.open);
    assert.equal(layoutUpdates.at(-1)?.overlayOpen, true);
    assert.equal(layoutUpdates.at(-1)?.active, false);
    cfgDialog.querySelector('.edit-cancel-btn').click();
    assert.equal(layoutUpdates.at(-1)?.overlayOpen, false);
    assert.equal(layoutUpdates.at(-1)?.active, true);

    // 3. Split View with second URL reports 2 native viewports; closing tab notifies host closeTab
    host.querySelector('.browser-split-btn').click();
    addrInput.value = 'https://example.org/second';
    addrForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(host.querySelectorAll('.browser-pane-viewport').length, 2);
    assert.equal(layoutUpdates.at(-1)?.panes?.length, 2);

    const closingTabId = browserStore.get().splitTabId;
    const focusedTabItem = host.querySelector(`.browser-tab-item[data-tab-id="${closingTabId}"]`);
    assert.ok(focusedTabItem?.querySelector('.browser-tab-close-btn'), 'Each tab has a per-tab close button');
    host.querySelector('.browser-close-tab-btn').click();
    assert.ok(closedTabs.includes(closingTabId));

    // Clicking New Private Window button opens a native Gecko private window without shortcut keys
    host.querySelector('.browser-private-window-btn').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(privateWindowCalls.length, 1);

    // 4. Native Gecko host events synchronize tab URL, title, shield count, address bar, and Back/Forward state
    const activeTabId = browserStore.get().activeTabId;
    addrInput.focus?.();
    for (const cb of hostListeners) {
      cb({
        type: 'location-change',
        tabId: activeTabId,
        url: 'https://threads.example.org/@user/post/9?utm_source=x',
        title: 'Post 9',
        canGoBack: true,
        canGoForward: false,
      });
      cb({ type: 'title-change', tabId: activeTabId, title: 'Updated Native Title' });
      cb({ type: 'blocked-count', tabId: activeTabId, blockedCount: 7 });
    }
    const updatedTab = browserStore.get().tabs.find((t) => t.id === activeTabId);
    assert.equal(updatedTab?.url, 'https://threads.example.org/@user/post/9');
    assert.equal(updatedTab?.title, 'Updated Native Title');
    assert.equal(addrInput.value, 'https://threads.example.org/@user/post/9', 'Focus without editing still updates address bar');
    assert.equal(host.querySelector('.browser-shield-count').textContent, '7');
    assert.equal(host.querySelector('.browser-back-btn').getAttribute('aria-disabled'), 'false');

    host.querySelector('.browser-back-btn').click();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(stepHistoryCalls.length, 1);
    assert.deepEqual(stepHistoryCalls[0], { tabId: activeTabId, delta: -1 });
    assert.equal(host.querySelector('.browser-forward-btn').getAttribute('aria-disabled'), 'false', 'Stepping back preserves forward history');

    // 5. Program theme syncs accents into Gecko window host
    applyRootProgramTheme('#10b981', doc);
    assert.equal(themeUpdates.at(-1)?.primary_accent, '#10b981');
    assert.equal(themeUpdates.at(-1)?.bg_canvas, '#121214');

    // 6. Privacy toggle syncs & KeePassXC connect action invokes host handler
    host.querySelector('.browser-shield-btn').click();
    const shieldPopover = host.querySelector('#browser-shield-popover');
    const kpBtn = shieldPopover.querySelector('.browser-keepass-connect-btn');
    assert.ok(kpBtn);
    await kpBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(kpConnectCalls, 1);

    const jsCheckbox = host.querySelector('#browser-shield-popover .browser-js-toggle-input');
    jsCheckbox.checked = false;
    jsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    assert.ok(privacyUpdates.length >= 1);
    host.querySelector('.browser-shield-btn').click();

    // Opening shell-level Settings modal also suppresses active native viewport overlay, and closing restores it
    host.querySelector('[aria-label="Settings"]').click();
    const settingsDialog = doc.getElementById('connection-settings-dialog');
    assert.ok(settingsDialog && settingsDialog.open);
    assert.equal(layoutUpdates.at(-1)?.overlayOpen, true);
    assert.equal(layoutUpdates.at(-1)?.active, false);
    settingsDialog.querySelector('.close-modal-btn').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(layoutUpdates.at(-1)?.overlayOpen, false);
    assert.equal(layoutUpdates.at(-1)?.active, true);

    // 7. Native host open-tab (nativeReady + pending target="_blank" flow + l.threads.com params preservation)
    const pendingTabId = 'tab_host_blank_1';
    for (const cb of hostListeners) {
      cb({ type: 'open-tab', tabId: pendingTabId, url: '', activate: true, nativeReady: true });
    }
    const pendingTab = browserStore.get().tabs.find((t) => t.id === pendingTabId);
    assert.ok(pendingTab);
    assert.equal(pendingTab.nativePending, true);
    assert.equal(host.querySelector('.browser-pane-viewport')?.dataset.nativeTabId, pendingTabId);
    const loadCountBeforeLocation = loadedTabs.length;

    const redirectUrl = 'https://l.threads.com/?u=https%3A%2F%2Fyoutu.be%2F9wXUE&e=AT_BRkStB8E83nbjc&utm_source=threads';
    for (const cb of hostListeners) {
      cb({ type: 'location-change', tabId: pendingTabId, url: redirectUrl, title: 'Redirect' });
    }
    assert.equal(loadedTabs.length, loadCountBeforeLocation, 'nativeReady tab does not double-call loadTab');
    const updatedBlankTab = browserStore.get().tabs.find((t) => t.id === pendingTabId);
    assert.equal(updatedBlankTab?.nativePending, false);
    assert.equal(
      updatedBlankTab?.url,
      'https://l.threads.com/?u=https%3A%2F%2Fyoutu.be%2F9wXUE&e=AT_BRkStB8E83nbjc',
      'Preserves l.threads.com u/e redirect params while stripping utm_'
    );
    assert.equal(updatedBlankTab?.historyIndex, 0, 'Initial nativePending URL replaces placeholder newtab history');

    // 8. Switching away from Browser tab hides native overlays
    host.querySelector('[data-tab="home"]').click();
    assert.equal(layoutUpdates.at(-1)?.active, false);
  } finally {
    app?.destroy();
    resetBrowserStoreForTests();
    globalThis.sanctuaryBrowserHost = prevHost;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('deriveAccentTokens computes yellow-hued tokens & bubble variables; deleted program syncs to active program; feed suppresses PiP & prioritizes hero media', async () => {
  const yellowTokens = deriveAccentTokens('#eab308');
  assert.equal(yellowTokens.primary_accent, '#eab308');
  assert.notEqual(yellowTokens.action_color.toLowerCase(), '#cbb2e8');
  assert.notEqual(yellowTokens.quote_color.toLowerCase(), '#d6c2ef');
  assert.ok(yellowTokens.program_bubble.startsWith('rgba('));
  assert.ok(yellowTokens.program_bubble_border.includes('234, 179, 8'));
  assert.equal(yellowTokens.user_bubble, undefined);

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();

    // Seed stale cached greeting for deleted program 'sebile'
    await cacheProgramHistory('sebile', 'default', {
      active_program: 'sebile',
      character_name: 'Sebile',
      history: [{ id: 's1', role: 'program', text: 'I sit by the pool, smiling warmly.' }],
    });

    // Even if purge was not yet called or dormant boot started, online transition with only 'robin' loads Robin's greeting
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/history')) {
        return new Response(
          JSON.stringify({
            active_program: 'robin',
            character_name: 'Robin',
            theme: { primary_accent: '#f43f5e' },
            history: [{ id: 'r1', role: 'program', text: '*I smile and give a small, energetic wave.*' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/select_program') || u.includes('/api/config') || u.includes('/models')) {
        return new Response(JSON.stringify({ status: 'success', models: [], program_moods: {} }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const dockHost = dom.document.createElement('div');
    dom.document.body.appendChild(dockHost);
    const threadCtrl = mountProgramThread(dockHost);
    assert.equal(threadCtrl.getCurrentProgramId(), '', 'Does not hardcode deleted sebile while dormant');

    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'robin',
      programs: [{ id: 'robin', name: 'Robin', accent_color: '#f43f5e', theme: { primary_accent: '#f43f5e' } }],
    });
    emitSanctuaryEvent('sanctuary:online', { active_program: 'robin' });
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(threadCtrl.getCurrentProgramId(), 'robin');
    assert.ok(dockHost.textContent.includes('small, energetic wave'));
    assert.equal(dockHost.textContent.includes('sit by the pool'), false);

    await purgeCachedProgramData('sebile');
    threadCtrl.destroy();

    // High-priority hero card omits loading="lazy" and sets fetchpriority="high" + disablepictureinpicture
    const heroCard = createPostCard(
      {
        id: 'p-hero',
        protocol: 'bluesky',
        author: { name: 'A', handle: 'a.bsky.social', avatar_url: 'https://cdn.example/av.jpg' },
        content_text: 'Hero photo',
        attachments: [{ type: 'image', url: 'https://cdn.example/hero.jpg', width: 800, height: 600 }],
      },
      { mediaPriority: 'high' }
    );
    const heroImg = heroCard.querySelector('img.post-media-item');
    assert.equal(heroImg.getAttribute('fetchpriority'), 'high');
    assert.equal(heroImg.getAttribute('loading'), null);

    const videoCard = createLoopsSlide({
      id: 'v-hero',
      protocol: 'mastodon',
      author: { name: 'V', handle: 'v@example.org', avatar_url: 'https://cdn.example/av.jpg' },
      content_text: 'Loop',
      attachments: [{ type: 'video', url: 'https://cdn.example/clip.mp4', width: 720, height: 1280 }],
    });
    const loopVid = videoCard.querySelector('video.loops-video');
    assert.equal(loopVid.hasAttribute('disablepictureinpicture'), true);
  } finally {
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('SanctuaryWindowHost uses real gBrowser tabs with Sval quick-peek panels, pins shellTab, watches progress & TabOpen, and routes target=_blank / openLinkIn / stepHistory', async () => {
  const dom = installMockDom();
  const prevChromeUtils = globalThis.ChromeUtils;
  const prevServices = globalThis.Services;
  const prevCi = globalThis.Ci;

  const reloaded = [];
  const printed = [];
  const gBrowserLinksOpened = [];
  const hostEvents = [];
  let shellPrevented = 0;

  globalThis.ChromeUtils = {
    defineESModuleGetters() {},
    importESModule() {
      throw new Error('moz-src unavailable in node test');
    },
    generateQI() { return {}; },
  };
  globalThis.Ci = {
    nsIWebProgress: { NOTIFY_LOCATION: 1, NOTIFY_STATE_NETWORK: 2 },
    nsIWebProgressListener: {
      LOCATION_CHANGE_SESSION_STORE: 4,
      STATE_IS_NETWORK: 1,
      STATE_START: 2,
      STATE_STOP: 4,
    },
    nsIWebNavigation: { LOAD_FLAGS_NONE: 0, LOAD_FLAGS_BYPASS_CACHE: 256, LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL: 512 },
    nsIBrowserDOMWindow: {
      OPEN_DEFAULTWINDOW: 0,
      OPEN_CURRENTWINDOW: 1,
      OPEN_NEWWINDOW: 2,
      OPEN_NEWTAB: 3,
      OPEN_NEWTAB_BACKGROUND: 4,
      OPEN_NEWTAB_FOREGROUND: 5,
      OPEN_PRINT_BROWSER: 7,
    },
  };
  globalThis.Services = {
    obs: { addObserver() {} },
    io: { newURI: (s) => ({ spec: s }) },
    prefs: { getStringPref: (_k, d) => d || 'http://127.0.0.1:5000' },
    scriptSecurityManager: {
      getSystemPrincipal: () => ({ isSystemPrincipal: true }),
      createNullPrincipal: () => ({ isNullPrincipal: true }),
    },
  };

  try {
    const { SanctuaryWindowHost } = await import('../browser-desktop/chrome/browser/components/sanctuary/SanctuaryWindowHost.sys.mjs');
    const winListeners = new Map();
    const docListeners = new Map();
    const doc = dom.document;
    const browserRoot = doc.createElement('div');
    browserRoot.id = 'browser';
    doc.body.appendChild(browserRoot);

    const statusPanel = doc.createElement('hbox');
    statusPanel.id = 'statuspanel';
    const tabbox = doc.createElement('tabbox');
    tabbox.id = 'tabbrowser-tabbox';
    const tabpanels = doc.createElement('tabpanels');
    tabpanels.id = 'tabbrowser-tabpanels';
    tabbox.append(tabpanels, statusPanel);
    browserRoot.appendChild(tabbox);

    let bcCounter = 0;
    const makeBrowserEl = () => {
      bcCounter += 1;
      const el = doc.createElement('browser');
      el.setAttribute('type', 'content');
      el.loadURI = (uri, opts) => {
        el.currentURI = { spec: uri.spec };
        el._loadOpts = opts;
      };
      el.fixupAndLoadURIString = (spec, opts) => {
        el.currentURI = { spec };
        el._loadOpts = opts;
      };
      el.reload = () => { reloaded.push({ el, bypass: false }); };
      el.reloadWithFlags = (f) => { reloaded.push({ el, bypass: Boolean(f) }); };
      el.browsingContext = { id: `pane-bc-${bcCounter}` };
      el.getContentBlockingLog = () => '';
      return el;
    };

    const shellBrowser = makeBrowserEl();
    shellBrowser.browsingContext = { id: 'shell-bc' };
    shellBrowser.currentURI = { spec: 'http://127.0.0.1:5000/' };
    const shellPanel = doc.createElement('notificationbox');
    shellPanel.className = 'browserSidebarContainer deck-selected';
    shellPanel.id = 'panel-0';
    shellPanel.appendChild(shellBrowser);
    tabpanels.appendChild(shellPanel);

    const shellTab = doc.createElement('tab');
    shellTab.linkedBrowser = shellBrowser;
    shellTab.linkedPanel = 'panel-0';

    const tabs = [shellTab];
    const tabsByBrowser = new Map([[shellBrowser, shellTab]]);
    const panelsByBrowser = new Map([[shellBrowser, shellPanel]]);
    const tabsProgressListeners = new Set();
    const tabContainerListeners = new Map();
    const gBrowserListeners = new Map();

    const emitListenerMap = (map, type, detail) => {
      for (const fn of map.get(type) || []) {
        fn(detail);
      }
    };

    let panelSeq = 0;
    const gBrowser = {
      tabs,
      selectedTab: shellTab,
      get selectedBrowser() {
        return this.selectedTab?.linkedBrowser || shellBrowser;
      },
      tabContainer: {
        addEventListener: (type, fn) => {
          if (!tabContainerListeners.has(type)) tabContainerListeners.set(type, new Set());
          tabContainerListeners.get(type).add(fn);
        },
        removeEventListener: (type, fn) => tabContainerListeners.get(type)?.delete(fn),
      },
      addEventListener: (type, fn) => {
        if (!gBrowserListeners.has(type)) gBrowserListeners.set(type, new Set());
        gBrowserListeners.get(type).add(fn);
      },
      removeEventListener: (type, fn) => gBrowserListeners.get(type)?.delete(fn),
      addTabsProgressListener: (l) => tabsProgressListeners.add(l),
      removeTabsProgressListener: (l) => tabsProgressListeners.delete(l),
      getTabForBrowser: (b) => tabsByBrowser.get(b) || null,
      getBrowserForTab: (t) => t?.linkedBrowser || null,
      getPanel: (b) => panelsByBrowser.get(b) || null,
      hideTab: (tab) => {
        if (tab && !tab.selected) {
          tab.hidden = true;
          tab.setAttribute('hidden', 'true');
        }
      },
      addTab: (uriString, opts = {}) => {
        panelSeq += 1;
        const tab = doc.createElement('tab');
        const panel = doc.createElement('notificationbox');
        panel.id = `panel-${panelSeq}`;
        panel.className = 'browserSidebarContainer';
        const container = doc.createElement('vbox');
        container.className = 'browserContainer';
        const browser = makeBrowserEl();
        if (opts.openWindowInfo) browser.openWindowInfo = opts.openWindowInfo;
        if (!opts.skipLoad && uriString && uriString !== 'about:blank') {
          browser.currentURI = { spec: uriString };
        } else {
          browser.currentURI = { spec: 'about:blank' };
        }
        container.appendChild(browser);
        panel.appendChild(container);
        tabpanels.appendChild(panel);

        tab.linkedBrowser = browser;
        tab.linkedPanel = panel.id;
        tabs.push(tab);
        tabsByBrowser.set(browser, tab);
        panelsByBrowser.set(browser, panel);
        emitListenerMap(tabContainerListeners, 'TabOpen', { target: tab });
        return tab;
      },
      removeTab: (tab) => {
        const idx = tabs.indexOf(tab);
        if (idx !== -1) {
          tab.closing = true;
          tabs.splice(idx, 1);
          tabsByBrowser.delete(tab.linkedBrowser);
          panelsByBrowser.delete(tab.linkedBrowser);
          doc.getElementById(tab.linkedPanel)?.remove?.();
          emitListenerMap(tabContainerListeners, 'TabClose', { target: tab });
        }
      },
      appendStatusPanel: () => tabbox.appendChild(statusPanel),
    };

    const fakeDoc = {
      documentElement: doc.documentElement,
      head: doc.head,
      getElementById: (id) => doc.getElementById(id),
      createXULElement: (tag) => doc.createElement(tag),
      createElementNS: (_ns, tag) => doc.createElement(tag),
      addEventListener: (type, fn) => docListeners.set(type, fn),
      removeEventListener: () => {},
    };
    const fakeWin = {
      innerWidth: 1400,
      innerHeight: 900,
      document: fakeDoc,
      gBrowser,
      browserDOMWindow: {
        QueryInterface: () => ({}),
        createContentWindowInFrame: () => null,
        openURIInFrame: () => null,
        createContentWindow: () => null,
        openURI: () => null,
        canClose: () => true,
        tabCount: 1,
      },
      openLinkIn: (...args) => gBrowserLinksOpened.push(args),
      PrintUtils: { startPrintWindow: (bc) => printed.push(bc.id) },
      addEventListener: (type, fn) => winListeners.set(type, fn),
      removeEventListener: () => {},
    };
    const mockParentActor = {
      browsingContext: { top: { embedderElement: shellBrowser } },
      sendAsyncMessage: (_name, payload) => hostEvents.push(payload),
    };

    SanctuaryWindowHost.mount(fakeWin);
    await SanctuaryWindowHost.loadTab(fakeWin, mockParentActor, { tabId: 'tab-1', url: 'https://www.threads.com/@davyrhodes_' });
    SanctuaryWindowHost.syncLayout(fakeWin, mockParentActor, {
      active: true,
      overlayOpen: false,
      focusedPane: 'primary',
      panes: [{ tabId: 'tab-1', pane: 'primary', x: 70, y: 90, width: 920, height: 800 }],
    });

    assert.equal(gBrowser.tabs.length, 2);
    const primaryTab = gBrowser.tabs[1];
    const primaryBrowser = primaryTab.linkedBrowser;
    const primaryPanel = gBrowser.getPanel(primaryBrowser);
    assert.ok(primaryTab && primaryBrowser && primaryPanel);
    assert.equal(primaryTab.hidden, true);
    assert.equal(primaryTab.getAttribute('sval-quick-peek'), 'true');
    assert.equal(primaryPanel.classList.contains('sanctuary-active-tab-panel'), true);
    assert.equal(primaryPanel.style.left, '70px');
    assert.equal(primaryPanel.style.top, '90px');
    assert.equal(primaryPanel.style.width, '920px');
    assert.equal(primaryPanel.style.height, '800px');
    assert.equal(primaryBrowser.docShellIsActive, true);
    assert.equal(primaryBrowser.renderLayers, true);

    // #statuspanel is reparented into #browser above active panels and bounded to active pane
    assert.equal(statusPanel.parentNode, browserRoot);
    const chromeStyleEl = doc.getElementById('sanctuary-shell-chrome-style');
    assert.ok(chromeStyleEl);
    assert.equal(
      /inset\s*:\s*auto\s*!important/i.test(chromeStyleEl.textContent || ''),
      false,
      'sanctuary-shell-chrome-style must not use inset: auto !important (clobbers inline left/top)'
    );
    assert.equal(doc.documentElement.getAttribute('data-sanctuary-browser-active'), 'true');
    assert.equal(doc.documentElement.style.getPropertyValue('--sanctuary-pane-left'), '78px');
    assert.equal(doc.documentElement.style.getPropertyValue('--sanctuary-pane-bottom'), '18px');
    assert.equal(doc.documentElement.style.getPropertyValue('--sanctuary-pane-max-w'), '904px');

    fakeWin.gBrowser.appendStatusPanel();
    assert.equal(statusPanel.parentNode, browserRoot, 'gBrowser.appendStatusPanel does not pull #statuspanel back into #tabbrowser-tabbox');

    // Inactive / modal layout clears data-sanctuary-browser-active & panel active class/sval-quick-peek
    SanctuaryWindowHost.syncLayout(fakeWin, mockParentActor, { active: true, overlayOpen: true, panes: [] });
    assert.equal(doc.documentElement.getAttribute('data-sanctuary-browser-active'), null);
    assert.equal(primaryPanel.classList.contains('sanctuary-active-tab-panel'), false);
    assert.equal(primaryTab.getAttribute('sval-quick-peek'), null);
    assert.equal(primaryBrowser.docShellIsActive, false);

    SanctuaryWindowHost.syncLayout(fakeWin, mockParentActor, {
      active: true,
      overlayOpen: false,
      focusedPane: 'primary',
      panes: [{ tabId: 'tab-1', pane: 'primary', x: 70, y: 90, width: 920, height: 800 }],
    });
    assert.equal(primaryPanel.classList.contains('sanctuary-active-tab-panel'), true);
    assert.equal(primaryTab.getAttribute('sval-quick-peek'), 'true');

    // TabSelect restores shellTab selection
    gBrowser.selectedTab = primaryTab;
    emitListenerMap(tabContainerListeners, 'TabSelect', { target: primaryTab });
    assert.equal(gBrowser.selectedTab, shellTab, 'TabSelect keeps Sanctuary shellTab selected');

    // target="_blank" / window.open via browserDOMWindow.createContentWindowInFrame creates real gBrowser tab
    const openWindowInfo = { isRemote: true, originAttributes: { userContextId: 0 } };
    const blankBrowser = fakeWin.browserDOMWindow.createContentWindowInFrame(
      null,
      { openerBrowser: primaryBrowser, openWindowInfo },
      globalThis.Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
      0,
      ''
    );
    assert.ok(blankBrowser);
    assert.equal(blankBrowser.openWindowInfo, openWindowInfo);
    assert.ok(gBrowser.getTabForBrowser(blankBrowser));
    const blankEvent = hostEvents.find((e) => e.type === 'open-tab' && e.url === '');
    assert.ok(blankEvent && blankEvent.nativeReady === true && blankEvent.activate === true);

    // Context menu / Ctrl+click via win.openLinkIn routes into real gBrowser Sanctuary tab
    fakeWin.openLinkIn('https://youtu.be/9wXUE', 'tab', { openerBrowser: primaryBrowser });
    assert.equal(gBrowserLinksOpened.length, 0);
    const ytEvent = hostEvents.find((e) => e.type === 'open-tab' && e.url === 'https://youtu.be/9wXUE');
    assert.ok(ytEvent && ytEvent.nativeReady === true);

    // Organic TabOpen outside SanctuaryWindowHost auto-hides tab and registers it
    const organicTab = gBrowser.addTab('https://organic.example/page', {
      triggeringPrincipal: globalThis.Services.scriptSecurityManager.getSystemPrincipal(),
    });
    assert.equal(organicTab.hidden, true);
    const organicEvent = hostEvents.find((e) => e.type === 'open-tab' && e.url === 'https://organic.example/page');
    assert.ok(organicEvent && organicEvent.nativeReady === true);

    const onKeyDown = winListeners.get('keydown');
    assert.ok(onKeyDown);
    onKeyDown({
      key: 'r',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: true,
      preventDefault: () => { shellPrevented += 1; },
      stopPropagation: () => {},
    });
    assert.equal(shellPrevented, 1);
    assert.equal(reloaded.length, 1);
    assert.equal(reloaded[0].bypass, true);

    onKeyDown({
      key: 'p',
      ctrlKey: true,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      preventDefault: () => {},
      stopPropagation: () => {},
    });
    assert.equal(printed.length, 1);

    assert.equal(gBrowser.tabs.length, 5);
    assert.ok(typeof SanctuaryWindowHost.routeContentWindow === 'function');
    assert.ok(typeof SanctuaryWindowHost.routeContentWindowInFrame === 'function');
    assert.ok(typeof SanctuaryWindowHost.routeLinkOpen === 'function');
    assert.ok(typeof SanctuaryWindowHost.extractTabContent === 'function');
    assert.ok(typeof SanctuaryWindowHost.stepHistory === 'function');

    // addTabsProgressListener updates URL even if currentURI lags, ignores subframes, and forwards canGoBack/canGoForward
    primaryBrowser.currentURI = { spec: 'https://openhands.dev/' };
    primaryBrowser.contentTitle = 'OpenHands API docs';
    primaryBrowser.canGoBack = true;
    primaryBrowser.canGoForward = false;
    for (const l of tabsProgressListeners) {
      l.onLocationChange?.(
        primaryBrowser,
        { isTopLevel: false },
        null,
        { spec: 'https://accounts.google.com/preload' },
        0
      );
      l.onLocationChange?.(
        primaryBrowser,
        { isTopLevel: true },
        null,
        { spec: 'https://docs.openhands.dev/api' },
        0
      );
    }
    assert.equal(hostEvents.some((e) => e.url === 'https://accounts.google.com/preload'), false);
    const docsLocEvt = hostEvents.find((e) => e.type === 'location-change' && e.url === 'https://docs.openhands.dev/api');
    assert.ok(docsLocEvt);
    assert.equal(docsLocEvt.canGoBack, true);
    assert.equal(docsLocEvt.canGoForward, false);

    // Step History delegates to Gecko browser.goBack / goForward
    let nativeBackCalls = 0;
    primaryBrowser.goBack = () => { nativeBackCalls += 1; };
    const stepRes = SanctuaryWindowHost.stepHistory(fakeWin, { tabId: 'tab-1', delta: -1 });
    assert.equal(stepRes.handled, true);
    assert.equal(nativeBackCalls, 1);

    // Extract tab content reads live rendered PageExtractor / Docs export & real top-level currentURI
    primaryBrowser.browsingContext.currentWindowGlobal = {
      getActor: (name) => {
        if (name === 'SanctuaryHost') {
          return {
            sendQuery: async () => ({
              url: 'https://docs.google.com/document/d/doc1/edit',
              title: 'Moon Heart - Google Docs',
              siteName: 'Google Docs',
              exportedText: 'Moon Heart full document paragraph extracted securely.',
            }),
          };
        }
        return { getText: async () => ({ text: '' }) };
      },
    };
    primaryBrowser.currentURI = { spec: 'https://docs.google.com/document/d/doc1/edit' };
    primaryBrowser.contentTitle = 'Moon Heart - Google Docs';
    const extractedDoc = await SanctuaryWindowHost.extractTabContent(fakeWin, { tabId: 'tab-1' });
    assert.equal(extractedDoc.ok, true);
    assert.equal(extractedDoc.url, 'https://docs.google.com/document/d/doc1/edit');
    assert.equal(extractedDoc.title, 'Moon Heart - Google Docs');
    assert.ok(extractedDoc.text.includes('Moon Heart full document paragraph'));

    SanctuaryWindowHost.resetPanes(fakeWin, mockParentActor);
    assert.equal(gBrowser.tabs.length, 1);
    assert.equal(gBrowser.tabs[0], shellTab);
    assert.equal(doc.documentElement.getAttribute('data-sanctuary-browser-active'), null);
  } finally {
    globalThis.ChromeUtils = prevChromeUtils;
    globalThis.Services = prevServices;
    globalThis.Ci = prevCi;
    dom.restore();
  }
});

test('gecko-desktop Clip to Data Bank and Ask Sanctuary use extractTabContent and host open-tab auto-switches into Browser', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevHost = globalThis.sanctuaryBrowserHost;

  const databankWrites = [];
  const hostListeners = new Set();
  const extractCalls = [];
  let app = null;

  globalThis.sanctuaryBrowserHost = {
    async loadTab(_tabId, url) {
      return { kind: 'native', url, title: 'Google Drive', blockedCount: 0 };
    },
    closeTab() {},
    syncLayout() {},
    setPrivacy() {},
    setProgramTheme() {},
    setSearchConfig() {},
    isKeePassConnected: () => false,
    async extractTabContent(tabId) {
      extractCalls.push(tabId);
      return {
        ok: true,
        url: 'https://docs.google.com/document/d/doc1/edit',
        title: 'Moon Heart - Google Docs',
        siteName: 'Google Docs',
        text: 'Chapter 1: Full Moon Heart body text extracted from live page.',
        excerpt: 'Chapter 1: Full Moon Heart body text',
        isSelection: false,
      };
    },
    onEvent(cb) {
      hostListeners.add(cb);
      return () => hostListeners.delete(cb);
    },
  };

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('/api/databank/text')) {
      databankWrites.push(JSON.parse(opts.body || '{}'));
      return new Response(JSON.stringify({ ok: true, id: 'db-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetCompose();
    resetBrowserStoreForTests();
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: mockMobileHealthOnline.programs,
    });

    const doc = dom.document;
    const host = doc.createElement('div');
    host.id = 'app-shell';
    doc.body.appendChild(host);

    // Start on home tab, fire host open-tab event -> shell mounts Browser & switches to it
    app = createAppShell(host, { initialTab: 'home', skipBackgroundInit: true });
    for (const cb of [...hostListeners]) {
      cb({
        type: 'open-tab',
        tabId: 'tab_host_new',
        url: 'https://docs.google.com/spreadsheets/u/0/preload?source=drive',
        activate: true,
        nativeReady: true,
      });
    }
    await new Promise((r) => setTimeout(r, 25));

    const clipBtn = host.querySelector('.browser-clip-databank-btn');
    assert.ok(clipBtn, 'Host open-tab mounted Browser screen automatically');
    await clipBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(extractCalls.length, 1);
    assert.equal(databankWrites.length, 1);
    assert.equal(databankWrites[0].title, 'Moon Heart - Google Docs');
    assert.ok(databankWrites[0].text.includes('Source: https://docs.google.com/document/d/doc1/edit'));
    assert.ok(databankWrites[0].text.includes('Chapter 1: Full Moon Heart body text extracted from live page.'));
    assert.equal(host.querySelector('#browser-address-input').value, 'https://docs.google.com/document/d/doc1/edit');
  } finally {
    app?.destroy?.();
    globalThis.fetch = prevFetch;
    globalThis.sanctuaryBrowserHost = prevHost;
    resetBrowserStoreForTests();
    resetCompose();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('executeBrowserAgentCommand drives Sval actOnTab and SettingsModal collapses Search Settings to Browser Search Engine', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevHost = globalThis.sanctuaryBrowserHost;

  const hostActions = [];
  globalThis.sanctuaryBrowserHost = {
    async loadTab(_tabId, url) {
      return { kind: 'native', url, title: 'Ecosia Search', blockedCount: 2 };
    },
    closeTab() {},
    syncLayout() {},
    setPrivacy() {},
    setProgramTheme() {},
    setSearchConfig() {},
    isKeePassConnected: () => false,
    async actOnTab(tabId, action, args) {
      hostActions.push({ tabId, action, args });
      if (action === 'snapshot') {
        return {
          ok: true,
          url: 'https://www.ecosia.org/search?q=greenpt',
          title: 'greenpt - Ecosia',
          snapshot: 'heading "greenpt" [e1]\nlink "Welcome — GreenPT Docs" [e14]\ntextbox "Search" [e3]',
          refs: 3,
          truncated: false,
        };
      }
      if (action === 'click') {
        return {
          ok: true,
          url: 'https://docs.greenpt.ai/',
          title: 'Welcome — GreenPT Docs',
          ref: args.ref,
        };
      }
      return { ok: true };
    },
  };

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/project_settings')) {
      return new Response(
        JSON.stringify({
          folders: ['C:/LLM/LM-Sanctuary'],
          security_preset: 'ask_always',
          browser_search_engine: 'ecosia',
          searxng_url: '',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetBrowserStoreForTests();
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: mockMobileHealthOnline.programs,
    });
    setSearchConfig({ engine: 'ecosia' }, { syncRemote: false });

    // 1. Sebile opens a search in the Browser using the user's configured Ecosia engine
    let activatedBrowser = false;
    const openRes = await executeBrowserAgentCommand(
      { action: 'open', args: { url: 'greenpt' } },
      { onActivateBrowser: () => { activatedBrowser = true; } }
    );
    assert.equal(openRes.ok, true);
    assert.equal(activatedBrowser, true);
    assert.equal(openRes.url, 'https://www.ecosia.org/search?q=greenpt');

    // 2. Sebile inspects live Sval DOM snapshot and clicks [e14]
    const snapRes = await executeBrowserAgentCommand({ action: 'snapshot', args: {} });
    assert.equal(snapRes.ok, true);
    assert.match(snapRes.snapshot, /Welcome — GreenPT Docs.*\[e14\]/);

    const clickRes = await executeBrowserAgentCommand({ action: 'click', args: { ref: 'e14' } });
    assert.equal(clickRes.ok, true);
    assert.equal(clickRes.url, 'https://docs.greenpt.ai/');
    assert.equal(hostActions.length, 2);

    // 3. Verify SettingsModal drops legacy Search Mode and hides SearXNG URL when Ecosia is active
    openSettingsModal({ initialTab: 'project' });
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(dom.document.querySelector('#project-search-engine'), null);
    const providerSel = dom.document.querySelector('#project-browser-search-engine');
    const searxInput = dom.document.querySelector('#project-searxng-url');
    assert.ok(providerSel && searxInput);
    assert.equal(providerSel.value, 'ecosia');
    assert.equal(searxInput.parentElement.hidden, true);

    providerSel.value = 'searxng';
    providerSel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(searxInput.parentElement.hidden, false);
  } finally {
    globalThis.fetch = prevFetch;
    globalThis.sanctuaryBrowserHost = prevHost;
    resetBrowserStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('Private Window mounts Sanctuary shell chrome without legacy Firefox toolbars and inherits Ecosia search', async () => {
  const dom = installMockDom();
  const prevChromeUtils = globalThis.ChromeUtils;
  const prevServices = globalThis.Services;
  const prevCi = globalThis.Ci;
  const prevFetch = globalThis.fetch;

  const principalCalls = [];
  const privDocs = dom.document;
  privDocs.createElementNS = (_ns, tag) => privDocs.createElement(tag);
  const toolbox = privDocs.createElement('toolbox');
  toolbox.id = 'navigator-toolbox';
  const sidebar = privDocs.createElement('vbox');
  sidebar.id = 'sidebar-box';
  const browserRoot = privDocs.createElement('div');
  browserRoot.id = 'browser';
  const tabbox = privDocs.createElement('tabbox');
  tabbox.id = 'tabbrowser-tabbox';
  const tabpanels = privDocs.createElement('tabpanels');
  tabpanels.id = 'tabbrowser-tabpanels';
  tabbox.appendChild(tabpanels);
  browserRoot.appendChild(tabbox);
  privDocs.body.append(toolbox, sidebar, browserRoot);

  const shellBrowser = privDocs.createElement('browser');
  shellBrowser.currentURI = { spec: 'about:privatebrowsing' };
  shellBrowser.loadURI = (uri, opts) => {
    shellBrowser.currentURI = { spec: uri.spec };
    shellBrowser._loadOpts = opts;
  };
  const shellPanel = privDocs.createElement('notificationbox');
  shellPanel.id = 'priv-panel-0';
  shellPanel.appendChild(shellBrowser);
  tabpanels.appendChild(shellPanel);
  const shellTab = privDocs.createElement('tab');
  shellTab.linkedBrowser = shellBrowser;
  shellTab.linkedPanel = 'priv-panel-0';
  const tabs = [shellTab];
  const tabsByBrowser = new Map([[shellBrowser, shellTab]]);
  const panelsByBrowser = new Map([[shellBrowser, shellPanel]]);
  const tabContainerListeners = new Map();

  const privGBrowser = {
    tabs,
    selectedTab: shellTab,
    get selectedBrowser() {
      return this.selectedTab?.linkedBrowser || shellBrowser;
    },
    tabContainer: {
      addEventListener: (type, fn) => {
        if (!tabContainerListeners.has(type)) tabContainerListeners.set(type, new Set());
        tabContainerListeners.get(type).add(fn);
      },
      removeEventListener: () => {},
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    addTabsProgressListener: () => {},
    removeTabsProgressListener: () => {},
    getTabForBrowser: (b) => tabsByBrowser.get(b) || null,
    getBrowserForTab: (t) => t?.linkedBrowser || null,
    getPanel: (b) => panelsByBrowser.get(b) || null,
    hideTab: (tab) => {
      if (tab && !tab.selected) tab.hidden = true;
    },
    addTab: (uriString, opts = {}) => {
      const tab = privDocs.createElement('tab');
      const panel = privDocs.createElement('notificationbox');
      panel.id = `priv-panel-${tabs.length}`;
      const browser = privDocs.createElement('browser');
      browser.currentURI = { spec: uriString || 'about:blank' };
      browser.browsingContext = { id: `priv-bc-${tabs.length}`, originAttributes: { privateBrowsingId: 1 } };
      browser._opts = opts;
      panel.appendChild(browser);
      tabpanels.appendChild(panel);
      tab.linkedBrowser = browser;
      tab.linkedPanel = panel.id;
      tabs.push(tab);
      tabsByBrowser.set(browser, tab);
      panelsByBrowser.set(browser, panel);
      return tab;
    },
    removeTab: () => {},
  };

  privDocs.documentElement.setAttribute('privatebrowsingmode', 'temporary');
  const privWin = {
    innerWidth: 1280,
    innerHeight: 800,
    document: privDocs,
    gBrowser: privGBrowser,
    browserDOMWindow: {
      QueryInterface: () => ({}),
      createContentWindowInFrame: () => null,
      openURIInFrame: () => null,
      createContentWindow: () => null,
      openURI: () => null,
      canClose: () => true,
      tabCount: 1,
    },
    openLinkIn: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const openerWin = {
    OpenBrowserWindow: (opts) => (opts?.private ? privWin : null),
  };

  globalThis.Ci = {
    nsIBrowserDOMWindow: { OPEN_PRINT_BROWSER: 99, OPEN_CURRENTWINDOW: 1, OPEN_NEWTAB: 3, OPEN_NEWTAB_BACKGROUND: 4 },
    nsIWebProgressListener: { STATE_IS_NETWORK: 0x40000, STATE_START: 0x1, STATE_STOP: 0x10 },
    nsIWebNavigation: { LOAD_FLAGS_NONE: 0, LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL: 1, LOAD_FLAGS_BYPASS_CACHE: 2 },
  };
  globalThis.ChromeUtils = {
    defineESModuleGetters: () => {},
    importESModule: () => ({
      PrivateBrowsingUtils: { isWindowPrivate: (w) => w === privWin },
    }),
    generateQI: () => ({}),
  };
  globalThis.Services = {
    prefs: {
      getStringPref: (_k, def) => def,
      setBoolPref: () => {},
    },
    obs: { addObserver: () => {}, removeObserver: () => {} },
    wm: { getMostRecentBrowserWindow: () => openerWin },
    io: { newURI: (spec) => ({ spec }) },
    scriptSecurityManager: {
      getSystemPrincipal: () => ({ isSystemPrincipal: true }),
      createNullPrincipal: (attrs) => {
        principalCalls.push(attrs);
        return { originAttributes: attrs };
      },
    },
  };

  let app = null;
  try {
    const { SanctuaryWindowHost } = await import('../browser-desktop/chrome/browser/components/sanctuary/SanctuaryWindowHost.sys.mjs');
    const res = SanctuaryWindowHost.openPrivateWindow(openerWin, { url: 'https://ecosia.org/' });
    assert.equal(res.opened, true);
    assert.equal(toolbox.collapsed, true, 'Private window must collapse legacy #navigator-toolbox');
    assert.equal(toolbox.style.display, 'none', 'Private window must hide legacy #navigator-toolbox');
    assert.equal(sidebar.collapsed, true, 'Private window must collapse #sidebar-box');
    assert.equal(
      shellBrowser.currentURI.spec,
      'http://127.0.0.1:5000/?privateWindow=1&privateUrl=https%3A%2F%2Fecosia.org%2F',
      'Private window loads Sanctuary shell in ?privateWindow=1 mode'
    );

    const mockParentActor = {
      browsingContext: { top: { embedderElement: shellBrowser } },
      sendAsyncMessage: () => {},
    };
    await SanctuaryWindowHost.loadTab(privWin, mockParentActor, {
      tabId: 'priv-tab-1',
      url: 'https://ecosia.org/search?q=sanctuary',
    });
    const blankBc = privWin.browserDOMWindow.createContentWindowInFrame(
      null,
      { openerBrowser: privGBrowser.tabs[1].linkedBrowser, openWindowInfo: { isRemote: true, originAttributes: { privateBrowsingId: 1 } } },
      globalThis.Ci.nsIBrowserDOMWindow.OPEN_NEWTAB,
      0,
      ''
    );
    assert.ok(blankBc, 'target=_blank inside private window opens a managed private tab instead of spawning another window');
    assert.ok(
      principalCalls.some((attrs) => attrs?.privateBrowsingId === 1),
      'Managed tabs inside private window preserve privateBrowsingId: 1 isolation'
    );

    // Verify standalone privateWindow web shell UI hides social rails/dock, shows Private title, and keeps Ecosia search
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetBrowserStoreForTests();
    setSearchConfig({ engine: 'ecosia' }, { syncRemote: false });

    const host = privDocs.createElement('div');
    host.id = 'app-shell';
    privDocs.body.appendChild(host);
    app = createAppShell(host, { privateWindow: true, skipBackgroundInit: true });
    const shellEl = host.querySelector('.app-shell-frame');
    assert.equal(shellEl.classList.contains('is-private-browser-window'), true);
    assert.equal(host.querySelector('.primary-tab-nav').hidden, true);
    assert.equal(host.querySelector('#sanctuary-right-dock').hidden, true);
    assert.equal(privDocs.title, 'Private Browsing — Sanctuary Browser');
    assert.equal(host.querySelector('.browser-ask-sanctuary-btn').hidden, true);
    assert.equal(host.querySelector('.browser-clip-databank-btn').hidden, true);
    assert.equal(host.querySelector('.browser-share-fediverse-btn').hidden, true);
    assert.equal(host.querySelector('.browser-newtab-title').textContent, 'Sanctuary Private Browser');
    assert.equal(host.querySelector('.browser-engine-pill').textContent, 'Search: Ecosia');
  } finally {
    app?.destroy?.();
    globalThis.fetch = prevFetch;
    globalThis.ChromeUtils = prevChromeUtils;
    globalThis.Services = prevServices;
    globalThis.Ci = prevCi;
    resetBrowserStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('SanctuaryWindowHost curates contentAreaContextMenu, routes Back/Forward/Reload to managed web tabs, and wires context-action events', async () => {
  const dom = installMockDom();
  const prevChromeUtils = globalThis.ChromeUtils;
  const prevServices = globalThis.Services;
  const prevCi = globalThis.Ci;
  const prevFetch = globalThis.fetch;
  const prevHost = globalThis.sanctuaryBrowserHost;

  const doc = dom.document;
  doc.createElementNS = (_ns, tag) => doc.createElement(tag);
  const byExactId = (node, id) => {
    if (!node) return null;
    if (node.id === id) return node;
    for (const child of node.children || []) {
      const found = byExactId(child, id);
      if (found) return found;
    }
    return null;
  };
  doc.getElementById = (id) => byExactId(doc.documentElement, id);
  const docListeners = new Map();
  const origDocAdd = doc.addEventListener.bind(doc);
  doc.addEventListener = (type, fn, opts) => {
    if (!docListeners.has(type)) docListeners.set(type, []);
    docListeners.get(type).push(fn);
    return origDocAdd(type, fn, opts);
  };

  const browserRoot = doc.createElement('div');
  browserRoot.id = 'browser';
  const tabbox = doc.createElement('tabbox');
  tabbox.id = 'tabbrowser-tabbox';
  const tabpanels = doc.createElement('tabpanels');
  tabpanels.id = 'tabbrowser-tabpanels';
  tabbox.appendChild(tabpanels);
  browserRoot.appendChild(tabbox);

  // Mock XUL context menu + navigation commands
  const contextMenu = doc.createElement('menupopup');
  contextMenu.id = 'contentAreaContextMenu';
  for (const id of [
    'context-navigation',
    'context-sep-navigation',
    'context-back',
    'context-forward',
    'context-reload',
    'context-savepage',
    'context-viewsource',
    'context-viewpartialsource-selection',
    'frame',
    'frame-sep',
    'inspect-separator',
    'context-openlinkprivate',
  ]) {
    const el = doc.createElement(id.includes('sep') ? 'menuseparator' : 'menuitem');
    el.id = id;
    contextMenu.appendChild(el);
  }
  const cmdBack = doc.createElement('command');
  cmdBack.id = 'Browser:Back';
  cmdBack.setAttribute('disabled', 'true');
  const cmdForward = doc.createElement('command');
  cmdForward.id = 'Browser:Forward';
  cmdForward.setAttribute('disabled', 'true');
  const cmdReload = doc.createElement('command');
  cmdReload.id = 'Browser:Reload';
  const cmdBackDup = doc.createElement('command');
  cmdBackDup.id = 'Browser:BackOrBackDuplicate';
  doc.body.append(browserRoot, contextMenu, cmdBack, cmdForward, cmdReload, cmdBackDup);

  const shellBrowser = doc.createElement('browser');
  shellBrowser.currentURI = { spec: 'http://127.0.0.1:5000/' };
  shellBrowser.browsingContext = { id: 'shell-ctx-bc' };
  const shellPanel = doc.createElement('notificationbox');
  shellPanel.id = 'ctx-panel-0';
  shellPanel.appendChild(shellBrowser);
  tabpanels.appendChild(shellPanel);
  const shellTab = doc.createElement('tab');
  shellTab.linkedBrowser = shellBrowser;
  shellTab.linkedPanel = 'ctx-panel-0';

  const tabs = [shellTab];
  const tabsByBrowser = new Map([[shellBrowser, shellTab]]);
  const panelsByBrowser = new Map([[shellBrowser, shellPanel]]);
  let goBackCalls = 0;

  const gBrowser = {
    tabs,
    selectedTab: shellTab,
    get selectedBrowser() {
      return this.selectedTab?.linkedBrowser || shellBrowser;
    },
    tabContainer: { addEventListener: () => {}, removeEventListener: () => {} },
    addEventListener: () => {},
    removeEventListener: () => {},
    addTabsProgressListener: () => {},
    removeTabsProgressListener: () => {},
    getTabForBrowser: (b) => tabsByBrowser.get(b) || null,
    getBrowserForTab: (t) => t?.linkedBrowser || null,
    getPanel: (b) => panelsByBrowser.get(b) || null,
    hideTab: () => {},
    addTab: (uriString) => {
      const tab = doc.createElement('tab');
      const panel = doc.createElement('notificationbox');
      panel.id = `ctx-panel-${tabs.length}`;
      const browser = doc.createElement('browser');
      browser.currentURI = { spec: uriString || 'about:blank' };
      browser.browsingContext = { id: `ctx-bc-${tabs.length}` };
      browser.canGoBack = true;
      browser.canGoForward = false;
      browser.goBack = () => { goBackCalls += 1; };
      browser.loadURI = (uri) => { browser.currentURI = { spec: uri.spec }; };
      panel.appendChild(browser);
      tabpanels.appendChild(panel);
      tab.linkedBrowser = browser;
      tab.linkedPanel = panel.id;
      tabs.push(tab);
      tabsByBrowser.set(browser, tab);
      panelsByBrowser.set(browser, panel);
      return tab;
    },
    removeTab: () => {},
  };

  let windowIsPrivate = false;
  const fakeWin = {
    innerWidth: 1280,
    innerHeight: 800,
    document: doc,
    gBrowser,
    gContextMenu: null,
    browserDOMWindow: { QueryInterface: () => ({}), canClose: () => true, tabCount: 1 },
    openLinkIn: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  };

  const hostEvents = [];
  const mockParentActor = {
    browsingContext: { top: { embedderElement: shellBrowser } },
    sendAsyncMessage: (_name, payload) => hostEvents.push(payload),
  };

  globalThis.Ci = {
    nsIBrowserDOMWindow: { OPEN_PRINT_BROWSER: 99, OPEN_CURRENTWINDOW: 1, OPEN_NEWTAB: 3, OPEN_NEWTAB_BACKGROUND: 4 },
    nsIWebProgressListener: { STATE_IS_NETWORK: 0x40000, STATE_START: 0x1, STATE_STOP: 0x10 },
    nsIWebNavigation: { LOAD_FLAGS_NONE: 0, LOAD_FLAGS_DISALLOW_INHERIT_PRINCIPAL: 1, LOAD_FLAGS_BYPASS_CACHE: 2 },
  };
  globalThis.ChromeUtils = {
    defineESModuleGetters: () => {},
    importESModule: () => ({ PrivateBrowsingUtils: { isWindowPrivate: () => windowIsPrivate } }),
    generateQI: () => ({}),
  };
  globalThis.Services = {
    prefs: { getStringPref: (_k, def) => def, setBoolPref: () => {} },
    obs: { addObserver: () => {}, removeObserver: () => {} },
    wm: { getMostRecentBrowserWindow: () => fakeWin },
    io: { newURI: (spec) => ({ spec }) },
    scriptSecurityManager: {
      getSystemPrincipal: () => ({ isSystemPrincipal: true }),
      createNullPrincipal: (attrs) => ({ originAttributes: attrs }),
    },
  };

  const firePopupShowing = () => {
    const evt = {
      target: contextMenu,
      defaultPrevented: false,
      shiftKey: false,
      preventDefault() { this.defaultPrevented = true; },
    };
    for (const fn of docListeners.get('popupshowing') || []) fn(evt);
    return evt;
  };

  let app = null;
  try {
    const { SanctuaryWindowHost } = await import('../browser-desktop/chrome/browser/components/sanctuary/SanctuaryWindowHost.sys.mjs');
    SanctuaryWindowHost.mount(fakeWin);
    await SanctuaryWindowHost.loadTab(fakeWin, mockParentActor, {
      tabId: 'ctx-tab-1',
      url: 'https://docs.greenpt.ai/guide',
    });
    const webBrowser = gBrowser.tabs[1].linkedBrowser;
    webBrowser.contentTitle = 'GreenPT Guide';

    // 1. Blank right-click on Sanctuary shell cancels stock webpage menu
    fakeWin.gContextMenu = { browser: shellBrowser, isContentSelected: false };
    const blankEvt = firePopupShowing();
    assert.equal(blankEvt.defaultPrevented, true, 'Blank right-click on Sanctuary shell suppresses Firefox webpage menu');

    // 2. Selection right-click on Sanctuary shell hides webpage-only chrome & shows Sanctuary search/ask
    fakeWin.gContextMenu = {
      browser: shellBrowser,
      isContentSelected: true,
      selectionInfo: { fullText: 'quantum entanglement', text: 'quantum entanglement' },
    };
    const shellSelEvt = firePopupShowing();
    assert.equal(shellSelEvt.defaultPrevented, false);
    assert.equal(doc.getElementById('context-navigation').hidden, true);
    assert.equal(doc.getElementById('context-savepage').hidden, true);
    assert.equal(doc.getElementById('context-viewsource').hidden, true);
    assert.equal(doc.getElementById('sanctuary-context-search-selection').hidden, false);
    assert.equal(doc.getElementById('sanctuary-context-ask-sanctuary').hidden, false);
    assert.equal(doc.getElementById('sanctuary-context-bookmark-page').hidden, true);

    // 3. Managed web tab right-click enables Browser:Back, routes Back command to webBrowser, and exposes Sanctuary actions
    doc.getElementById('context-navigation').hidden = false;
    fakeWin.gContextMenu = {
      browser: webBrowser,
      isContentSelected: true,
      selectionInfo: { fullText: 'sanctuary browser privacy', text: 'sanctuary browser privacy' },
    };
    const webEvt = firePopupShowing();
    assert.equal(webEvt.defaultPrevented, false);
    assert.equal(cmdBack.getAttribute('disabled'), null, 'Browser:Back enables for managed web tab with canGoBack=true');
    assert.equal(cmdForward.getAttribute('disabled'), 'true');
    assert.equal(doc.getElementById('sanctuary-context-bookmark-page').hidden, false);
    assert.equal(doc.getElementById('sanctuary-context-clip-databank').hidden, false);

    cmdBackDup.dispatchEvent(new Event('command', { bubbles: true, cancelable: true }));
    assert.equal(goBackCalls, 1, 'Context menu Back routes to right-clicked managed web tab');

    // Emit Search Web + Bookmark Page + Clip Selection actions and verify end-to-end wiring in _layout.js + browser.js
    doc.getElementById('sanctuary-context-search-selection').dispatchEvent(new Event('command', { bubbles: true }));
    doc.getElementById('sanctuary-context-bookmark-page').dispatchEvent(new Event('command', { bubbles: true }));
    doc.getElementById('sanctuary-context-clip-databank').dispatchEvent(new Event('command', { bubbles: true }));

    // 4. Private Window hides Bookmark / Ask Sanctuary / Clip items while keeping Search Web
    windowIsPrivate = true;
    doc.documentElement.setAttribute('privatebrowsingmode', 'temporary');
    firePopupShowing();
    assert.equal(doc.getElementById('sanctuary-context-search-selection').hidden, false);
    assert.equal(doc.getElementById('sanctuary-context-bookmark-page').hidden, true);
    assert.equal(doc.getElementById('sanctuary-context-ask-sanctuary').hidden, true);
    assert.equal(doc.getElementById('sanctuary-context-clip-databank').hidden, true);
    doc.documentElement.removeAttribute('privatebrowsingmode');
    windowIsPrivate = false;

    // Verify web UI handles emitted context-action events
    const loadedUrls = [];
    const databankBodies = [];
    const shellListeners = new Set();
    globalThis.sanctuaryBrowserHost = {
      async loadTab(_tabId, url) {
        loadedUrls.push(url);
        return { kind: 'native', url, title: url, blockedCount: 0 };
      },
      closeTab() {},
      syncLayout() {},
      setPrivacy() {},
      setProgramTheme() {},
      setSearchConfig() {},
      isKeePassConnected: () => false,
      onEvent(cb) {
        shellListeners.add(cb);
        return () => shellListeners.delete(cb);
      },
    };
    globalThis.fetch = async (url, opts = {}) => {
      if (String(url).includes('/api/databank/text')) {
        databankBodies.push(JSON.parse(opts.body || '{}'));
        return new Response(JSON.stringify({ ok: true, id: 'db-ctx-1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetBrowserStoreForTests();
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: mockMobileHealthOnline.programs,
    });
    setSearchConfig({ engine: 'ecosia' }, { syncRemote: false });

    const appHost = doc.createElement('div');
    appHost.id = 'app-shell';
    doc.body.appendChild(appHost);
    app = createAppShell(appHost, { initialTab: 'home', skipBackgroundInit: true });

    const searchEvt = hostEvents.find((e) => e.type === 'context-action' && e.action === 'search-selection');
    const clipEvt = hostEvents.find((e) => e.type === 'context-action' && e.action === 'clip-databank');
    assert.ok(searchEvt && clipEvt);

    for (const cb of [...shellListeners]) cb(searchEvt);
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(
      loadedUrls.some((u) => u.startsWith('https://www.ecosia.org/search?q=sanctuary') && u.includes('privacy')),
      `Expected Ecosia search URL, got ${JSON.stringify(loadedUrls)}`
    );

    const clipTabId = browserStore.get().activeTabId;
    for (const cb of [...shellListeners]) cb({ ...clipEvt, tabId: clipTabId });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(databankBodies.length, 1);
    assert.ok(databankBodies[0].text.includes('sanctuary browser privacy'));
  } finally {
    app?.destroy?.();
    globalThis.fetch = prevFetch;
    globalThis.sanctuaryBrowserHost = prevHost;
    globalThis.ChromeUtils = prevChromeUtils;
    globalThis.Services = prevServices;
    globalThis.Ci = prevCi;
    resetBrowserStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('Browser address bar shows search-as-you-type dropdown with bookmarks, prefixes, and /api/browser/suggest results', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const loadedUrls = [];

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/browser/suggest')) {
      return new Response(
        JSON.stringify({ suggestions: ['cooperative computing', 'cooperative economics'] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let ctrl = null;
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetBrowserStoreForTests();
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });
    setSearchConfig({ engine: 'ecosia' }, { syncRemote: false });
    browserStore.set({
      bookmarks: [{ id: 'bm1', title: 'Cooperative Directory', url: 'https://coop.example.org/' }],
    });

    const { mountBrowserScreen } = await import('../web/app/browser.js');
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountBrowserScreen(host, {});

    const addrInput = host.querySelector('#browser-address-input');
    const dropdown = host.querySelector('.browser-address-form .search-suggest-dropdown');
    assert.ok(addrInput && dropdown);
    assert.equal(dropdown.hidden, true);

    addrInput.value = 'coop';
    addrInput.dispatchEvent(new Event('input', { bubbles: true }));
    // Instant local bookmark match appears immediately
    assert.equal(dropdown.hidden, false);
    assert.ok(dropdown.textContent.includes('Cooperative Directory'));

    // Debounced remote suggestions merge in
    await new Promise((r) => setTimeout(r, 230));
    assert.ok(dropdown.textContent.includes('cooperative computing'));
    assert.ok(dropdown.textContent.includes('cooperative economics'));

    // Keyboard ArrowDown + Escape closes cleanly
    addrInput.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'ArrowDown' }));
    assert.ok(dropdown.querySelector('.search-suggest-item.is-active'));
    addrInput.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }));
    assert.equal(dropdown.hidden, true);

    assert.ok(loadedUrls.length === 0);
  } finally {
    ctrl?.destroy?.();
    globalThis.fetch = prevFetch;
    resetBrowserStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});
