/* SPDX-License-Identifier: AGPL-3.0-or-later */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mockMobileHealthOnline } from '../__mocks__/mockProgram.js';
import { createAppShell } from '../web/app/_layout.js';
import {
  NEWTAB_URL,
  SEARCH_ENGINES,
  resolveAddressBarInput,
  stripTrackingParams,
} from '../web/core/urlPrivacy.js';
import {
  browserStore,
  isJavaScriptEnabledForUrl,
  resetBrowserStoreForTests,
} from '../web/state/browserStore.js';
import { composeStore, resetCompose } from '../web/state/composeStore.js';
import { resetFeedStoreForTests } from '../web/state/feedStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_CSS_PATH = path.resolve(__dirname, '..', 'web', 'assets', 'css', 'shell.css');

test('urlPrivacy resolves prefixes, strips trackers, and enforces no-default search configuration', () => {
  assert.equal(
    stripTrackingParams('https://example.org/post?utm_source=fediverse&fbclid=abc&page=2#top'),
    'https://example.org/post?page=2#top'
  );
  assert.equal(
    stripTrackingParams('https://www.youtube.com/watch?v=dQw4w9WgXcQ&si=tracking123'),
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ'
  );

  // Prefix shortcuts work without configuring a general search engine
  assert.deepEqual(
    resolveAddressBarInput('github:grendel116/LM-Sanctuary', { searchConfig: { engine: '' } }),
    {
      kind: 'prefix_search',
      prefix: 'github',
      query: 'grendel116/LM-Sanctuary',
      url: 'https://github.com/search?q=grendel116%2FLM-Sanctuary',
    }
  );
  assert.equal(
    resolveAddressBarInput('arxiv:attention is all you need', { searchConfig: { engine: '' } }).url,
    'https://arxiv.org/search/?query=attention%20is%20all%20you%20need&searchtype=all'
  );
  assert.equal(
    resolveAddressBarInput('localhost:5000/api/health', { searchConfig: { engine: '' } }).url,
    'http://localhost:5000/api/health'
  );
  assert.equal(
    resolveAddressBarInput('example.org/features/?utm_medium=social', { searchConfig: { engine: '' } }).url,
    'https://example.org/features/'
  );

  // Plain search queries require explicit search engine configuration
  assert.deepEqual(
    resolveAddressBarInput('dialectical materialism', { searchConfig: { engine: '' } }),
    { kind: 'needs_search_engine', query: 'dialectical materialism' }
  );
  const engineIds = SEARCH_ENGINES.map((e) => e.id);
  for (const required of ['ecosia', 'startpage', 'kagi', 'qwant', 'perplexity', 'wikipedia']) {
    assert.ok(engineIds.includes(required), `SEARCH_ENGINES includes ${required}`);
  }
  assert.equal(
    resolveAddressBarInput('@eco renewable web', { searchConfig: { engine: '' } }).url,
    'https://www.ecosia.org/search?q=renewable%20web'
  );
  assert.equal(
    resolveAddressBarInput('@gh sanctuary', { searchConfig: { engine: '' } }).url,
    'https://github.com/search?q=sanctuary'
  );
  assert.deepEqual(
    resolveAddressBarInput('dialectical materialism', {
      searchConfig: { engine: 'searxng', searxngUrl: 'https://search.local.invalid' },
    }),
    {
      kind: 'search',
      engine: 'searxng',
      query: 'dialectical materialism',
      url: 'https://search.local.invalid/search?q=dialectical%20materialism',
    }
  );
});

test('Browser stage handles no-default search setup, 2-pane split view, JS shield, bookmarks sync, Ask Sanctuary, Share, Refusal card, and open_in_browser tool actions', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const savedBookmarks = [];
  const deletedBookmarks = [];
  const savedProjectSettings = [];
  let toolPollActionSent = false;

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = String(opts.method || 'GET').toUpperCase();
    if (u.includes('/api/browser/reader') && method === 'POST') {
      const payload = JSON.parse(opts.body || '{}');
      if (String(payload.url || '').includes('threads.example.org')) {
        return new Response(
          JSON.stringify({
            page: {
              url: payload.url,
              title: 'Threads',
              siteName: 'threads.example.org',
              excerpt: 'Join Threads to share ideas.',
              markdown: '',
              blockedCount: 0,
              frameAllowed: false,
              frameBlockedReason: 'X-Frame-Options: DENY',
              error: 'HTTP 403 from threads.example.org',
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          page: {
            url: payload.url,
            title: 'Sovereign Browser Article',
            siteName: 'example.org',
            excerpt: 'Clean reader summary without trackers.',
            markdown: '# Sovereign Browser Article\n\nClean reader summary without trackers.',
            blockedCount: 3,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/browser/bookmarks/') && method === 'PUT') {
      const payload = JSON.parse(opts.body || '{}');
      savedBookmarks.push(payload.bookmark);
      return new Response(JSON.stringify({ bookmark: payload.bookmark }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/browser/bookmarks/') && method === 'DELETE') {
      deletedBookmarks.push(u.split('/').pop());
      return new Response('', { status: 204 });
    }
    if (u.includes('/api/browser/bookmarks') && method === 'GET') {
      return new Response(JSON.stringify({ bookmarks: savedBookmarks, deletedIds: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/project_settings')) {
      if (method === 'POST') {
        const body = JSON.parse(opts.body || '{}');
        savedProjectSettings.push(body);
        return new Response(JSON.stringify({ status: 'success', settings: body }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ searxng_url: '' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/session_tool_calls')) {
      const calls = toolPollActionSent
        ? []
        : [{
            id: 'call_open_1',
            name: 'open_in_browser',
            status: 'completed',
            client_action: {
              type: 'open_browser_tab',
              url: 'https://example.org/from-sebile?utm_campaign=chat',
              split: true,
            },
          }];
      toolPollActionSent = true;
      return new Response(JSON.stringify({ tool_calls: calls }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/chat') && method === 'POST') {
      return new Response(
        JSON.stringify({
          response: 'Opened that page in split view for us.',
          message: {
            id: 'msg_prog_open',
            role: 'program',
            sender_id: 'sebile',
            text: 'Opened that page in split view for us.',
            tool_calls: [],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/history')) {
      return new Response(JSON.stringify({ history: [], character_name: 'Sebile', theme: { primary_accent: '#A855F7' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
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
    assert.equal(doc.title, 'Browser');
    assert.equal(browserStore.get().searchConfig.engine, '');
    assert.equal(browserStore.get().tabs[0].url, NEWTAB_URL);

    process.stdout.write("START-1\n");
    // 1. Plain search query prompts user to choose a search engine, then executes search on Save
    const addrInput = host.querySelector('#browser-address-input');
    const addrForm = host.querySelector('.browser-address-form');
    addrInput.value = 'open source browser';
    addrForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const cfgDialog = doc.getElementById('browser-search-config-dialog');
    assert.ok(cfgDialog);
    assert.equal(cfgDialog.open, true);
    assert.ok(cfgDialog.querySelector('.modal-card'), 'Search dialog uses classic .modal-card wrapper');
    assert.ok(cfgDialog.querySelector('[data-engine-id="ecosia"]'), 'Search dialog includes Ecosia');
    const ddgBtn = cfgDialog.querySelector('[data-engine-id="duckduckgo"]');
    assert.ok(ddgBtn);
    ddgBtn.click();
    cfgDialog.querySelector('.edit-save-btn').click();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(browserStore.get().searchConfig.engine, 'duckduckgo');
    assert.ok(
      savedProjectSettings.some((s) => s.browser_search_engine === 'duckduckgo'),
      'Saving Browser search config syncs browser_search_engine to /api/project_settings'
    );
    const activeTab = browserStore.get().tabs.find((t) => t.id === browserStore.get().activeTabId);
    assert.equal(activeTab.url, 'https://duckduckgo.com/?q=open%20source%20browser');
    assert.equal(activeTab.blockedCount, 3);
    assert.equal(activeTab.viewMode, 'frame');
    assert.equal(host.querySelector('.browser-reader-btn'), null, 'Reader View button is omitted from toolbar');
    const homeBtn = host.querySelector('.browser-home-btn');
    assert.ok(homeBtn, 'Toolbar includes Home button');
    assert.equal(homeBtn.getAttribute('aria-disabled'), 'false');
    assert.ok(host.querySelector('.browser-live-frame'), 'New tabs default to live view');

    // Home button returns tab to Sanctuary Browser Home / New Tab and Back button steps cleanly back & forward
    homeBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(browserStore.get().tabs[0].url, NEWTAB_URL);
    assert.ok(host.querySelector('.browser-newtab-view'));
    assert.equal(host.querySelector('.browser-newtab-private-btn'), null, 'New Tab hero omits duplicate Private Window button');
    const stageHeader = host.querySelector('.browser-stage-header');
    const stripActions = stageHeader?.querySelector('.browser-tabstrip-actions');
    const tablistEl = stageHeader?.querySelector('.browser-tablist');
    assert.ok(stripActions && tablistEl);
    assert.equal(stageHeader.children[1] === stripActions, true, 'Private Window button sits after tabs');
    assert.equal(
      host.querySelector('.browser-new-tab-btn').parentElement === tablistEl,
      true,
      'New Tab button lives inside the tab strip, right after the most recent tab'
    );
    host.querySelector('.browser-back-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(browserStore.get().tabs[0].url, 'https://duckduckgo.com/?q=open%20source%20browser');

    process.stdout.write("OK-1\n");
    // 2. Bookmark button saves locally and pushes to /api/browser/bookmarks (ribbon icon on bookmark page, star on bookmarks list, paper-plane on Ask Sanctuary, no OS browser button)
    const bmStar = host.querySelector('.browser-bookmark-btn');
    const bmListBtn = host.querySelector('.browser-bookmarks-list-btn');
    const askSanctuaryBtn = host.querySelector('.browser-ask-sanctuary-btn');
    assert.ok(bmStar.innerHTML.includes('M19 21l-7-5-7 5V5'), 'Bookmark page button uses bookmark ribbon icon');
    assert.ok(bmListBtn.innerHTML.includes('12 2 15.09 8.26'), 'Open bookmarks button uses star icon');
    assert.ok(askSanctuaryBtn.innerHTML.includes('M22 2 11 13'), 'Ask Sanctuary button uses send paper plane icon');
    assert.equal(host.querySelector('.browser-os-link-btn'), null);
    process.stdout.write("S2a\n");
    bmStar.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(bmStar.getAttribute('aria-pressed'), 'true');
    assert.equal(savedBookmarks.length, 1);
    process.stdout.write("S2b\n");

    // Bookmarks classic Sanctuary modal opens, filters, and lists the styled bookmark row
    host.querySelector('.browser-bookmarks-list-btn').click();
    const bmSheet = doc.getElementById('browser-bookmarks-sheet');
    assert.ok(bmSheet && bmSheet.open);
    assert.ok(bmSheet.classList.contains('classic-modal-dialog'), 'Bookmarks opens as styled classic-modal-dialog');
    assert.ok(bmSheet.querySelector('.modal-card'), 'Bookmarks dialog contains Sanctuary .modal-card');
    assert.ok(bmSheet.querySelector('.browser-bookmark-favicon'), 'Bookmark row shows host monogram badge');
    assert.equal(bmSheet.querySelectorAll('.browser-bookmark-row').length, 1);
    bmSheet.close();

    // Per-tab close buttons live on each tab item (not nested inside [role="tab"]), and Private Window button opens an ephemeral Private Tab without shortcut keys
    process.stdout.write("S2c\n");
    const privBtn = host.querySelector('.browser-private-window-btn');
    assert.ok(privBtn, 'Toolbar includes New Private Window button');
    process.stdout.write("S2c-click\n");
    privBtn.click();
    process.stdout.write("S2c-clicked\n");
    try {
      await new Promise((r) => setTimeout(r, 20));
    } catch (e) {
      process.stdout.write("S2c-wait-threw: " + (e && e.stack ? e.stack.split("\n").slice(0, 5).join(" | ") : String(e)) + "\n");
      throw e;
    }
    process.stdout.write("S2c-waited\n");
    assert.equal(browserStore.get().tabs.length, 2);
    const privTab = browserStore.get().tabs.find((t) => t.id === browserStore.get().activeTabId);
    assert.equal(privTab?.isPrivate, true);
    process.stdout.write("S2c-a\n");
    assert.ok(host.querySelector('.browser-newtab-view.is-private'), 'Companion mode renders Private Tab card');
    process.stdout.write("S2c-b\n");
    assert.equal(host.querySelector('.browser-private-pill'), null, 'Private tab omits ephemeral pill above search bar');
    process.stdout.write("S2c-c\n");
    const privTabItem = host.querySelector(`.browser-tab-item[data-tab-id="${privTab.id}"]`);
    assert.ok(privTabItem, 'Tab item wraps tab button and per-tab close button as siblings');
const mem = (tag) => process.stdout.write(`${tag} heap=${(process.memoryUsage().heapUsed / 1048576).toFixed(1)}MB tabs=${browserStore.get().tabs.length}\n`);
    process.stdout.write("S2c-d\n");
    mem("M-d");
    assert.equal(privTabItem.querySelector('[role="tab"] .browser-tab-close-btn'), null, 'Close button is not nested inside [role="tab"] button');
    process.stdout.write("S2c-e\n");

    // Tabs are draggable and reorderable: dragging a tab onto another's left half inserts before it
    process.stdout.write("S2d\n");
    const reorderStrip = host.querySelector('.browser-tablist');
    const before = browserStore.get().tabs.map((t) => t.id);
    assert.equal(reorderStrip.querySelectorAll('.browser-tab-item').length, before.length);
    const dragItem = reorderStrip.querySelector(`.browser-tab-item[data-tab-id="${before[1]}"]`);
    const overItem = reorderStrip.querySelector(`.browser-tab-item[data-tab-id="${before[0]}"]`);
    assert.ok(dragItem && overItem, 'Private tab test left two tabs in the strip');
    assert.equal(dragItem.getAttribute('draggable'), 'true', 'Tab items are draggable');
    assert.equal(overItem.getAttribute('role'), 'tab', 'Tab items carry [role="tab"] semantics');
    const stripChildren = Array.from(reorderStrip.children);
    assert.equal(
      stripChildren[stripChildren.length - 1] === reorderStrip.querySelector('.browser-new-tab-btn'),
      true,
      'New Tab button is the immediate sibling after the most recent tab'
    );

    const dnd = (type, target, props = {}) => {
      const ev = new Event(type, { bubbles: true, cancelable: true });
      Object.assign(ev, props);
      target.dispatchEvent(ev);
      return ev;
    };
    dnd('dragstart', dragItem);
    assert.ok(dragItem.classList.contains('is-dragging'), 'dragstart flags the dragged tab');
    const overEv = dnd('dragover', overItem, { clientX: 50, dataTransfer: null });
    assert.equal(overEv.defaultPrevented, true, 'dragover is allowed on tab targets');
    assert.ok(overItem.classList.contains('drop-before'), 'Insert-before indicator appears on the left half');
    const dropEv = dnd('drop', overItem, { clientX: 50, dataTransfer: null });
    assert.equal(dropEv.defaultPrevented, true, 'drop is accepted');
    dnd('dragend', dragItem);
    const after = browserStore.get().tabs.map((t) => t.id);
    assert.deepEqual(after, [before[1], before[0]], 'Drop reorders tabs in the store');

    privTabItem.querySelector('.browser-tab-close-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(browserStore.get().tabs.length, 1);

    process.stdout.write("OK-2\n");
    // 3. Per-site JavaScript toggle updates site override and iframe sandbox
    let frame = host.querySelector('.browser-live-frame');
    assert.ok(frame);
    assert.ok(frame.getAttribute('sandbox').includes('allow-scripts'));

    const shieldBtn = host.querySelector('.browser-shield-btn');
    shieldBtn.click();
    const shieldPopover = host.querySelector('#browser-shield-popover');
    const jsCheckbox = shieldPopover.querySelector('.browser-js-toggle-input');
    assert.ok(jsCheckbox);
    jsCheckbox.checked = false;
    jsCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
    assert.equal(isJavaScriptEnabledForUrl(activeTab.url), false);
    frame = host.querySelector('.browser-live-frame');
    assert.equal(frame.getAttribute('sandbox').includes('allow-scripts'), false);

    process.stdout.write("OK-3\n");
    // 4. Ask Sanctuary attaches a 'web' shared page card, and Share to Fediverse prefills composeStore
    host.querySelector('.browser-ask-sanctuary-btn').click();
    const previewCard = host.querySelector('.sanctuary-right-dock .shared-post-card');
    assert.ok(previewCard);
    assert.ok(previewCard.textContent.includes('Sovereign Browser Article'));

    host.querySelector('.browser-share-fediverse-btn').click();
    assert.equal(composeStore.get().isOpen, true);
    assert.ok(composeStore.get().text.includes('https://duckduckgo.com/?q=open%20source%20browser'));
    app.composeCtrl.close();

    process.stdout.write("OK-4\n");
    // 5. Split View creates 2 side-by-side Browser panes
    host.querySelector('.browser-split-btn').click();
    assert.equal(host.querySelectorAll('.browser-pane').length, 2);
    assert.equal(host.querySelector('.browser-panes-grid').classList.contains('is-split'), true);

    process.stdout.write("OK-5\n");
    // 6. Program open_in_browser tool action opens clean URL in split pane
    const userInput = host.querySelector('#user-input');
    const chatForm = host.querySelector('#input-area');
    userInput.value = 'Open this link with me';
    chatForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 80));

    const splitTab = browserStore.get().tabs.find((t) => t.id === browserStore.get().splitTabId);
    assert.equal(splitTab?.url, 'https://example.org/from-sebile');

    process.stdout.write("OK-6\n");
    // 7. Refusal card renders on frame-blocked or 403/failed responses instead of raw iframe error
    addrInput.value = 'https://threads.example.org/@user';
    addrForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    const loadingSplitPane = host.querySelector('.browser-pane[data-pane="split"]');
    assert.ok(loadingSplitPane?.querySelector('.browser-pane-loading'), 'Shows obsidian loading state while probing');
    assert.equal(Boolean(loadingSplitPane?.querySelector('.browser-live-frame')), false, 'Never mounts raw iframe before frameAllowed probe finishes');
    await new Promise((r) => setTimeout(r, 40));
    const splitPane = host.querySelector('.browser-pane[data-pane="split"]');
    const refusalCard = splitPane?.querySelector('.browser-refusal-card');
    assert.ok(refusalCard, 'Refusal card renders for X-Frame-Options/HTTP errors');
    assert.ok(refusalCard.textContent.includes('X-Frame-Options: DENY'));
    assert.equal(Boolean(splitPane?.querySelector('.browser-live-frame')), false);

    process.stdout.write("OK-7\n");
    // 8. Verify shell.css applies modern-web-guidance popover & overflow safeguards + Sanctuary toggle clearance
    const shellCss = fs.readFileSync(SHELL_CSS_PATH, 'utf8');
    assert.ok(shellCss.includes('@supports (position-area: block-end)'));
    assert.ok(shellCss.includes('.browser-tab-label'));
    assert.ok(shellCss.includes('--sanctuary-dock-w'));
    assert.ok(shellCss.includes('#app-shell:has(.sanctuary-dock-toggle:not([hidden])) .browser-stage-header'));
  } finally {
    app?.destroy();
    resetBrowserStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Native Gecko host keeps .browser-pane-viewport mounted across loading ticks and ignores about:blank / subframe hijacking', async () => {
  const dom = installMockDom();
  const prevHost = globalThis.sanctuaryBrowserHost;
  const hostEventListeners = new Set();
  const loadedUrls = [];

  globalThis.sanctuaryBrowserHost = {
    loadTab: async (tabId, url) => {
      loadedUrls.push({ tabId, url });
      return { kind: 'native', url, title: 'Ecosia', blockedCount: 0 };
    },
    closeTab: () => {},
    syncLayout: () => {},
    setPrivacy: () => {},
    setProgramTheme: () => {},
    onEvent: (cb) => {
      hostEventListeners.add(cb);
      return () => hostEventListeners.delete(cb);
    },
  };

  let app = null;
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetCompose();
    resetBrowserStoreForTests();

    const doc = dom.document;
    const host = doc.createElement('div');
    host.id = 'app-shell';
    doc.body.appendChild(host);

    app = createAppShell(host, { initialTab: 'browser', skipBackgroundInit: true });
    const addrInput = host.querySelector('#browser-address-input');
    const addrForm = host.querySelector('.browser-address-form');

    addrInput.value = 'https://www.ecosia.org/search?q=batman';
    addrForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));

    const firstViewport = host.querySelector('.browser-pane-viewport');
    assert.ok(firstViewport, 'Native viewport mounts for active tab');
    const tabId = browserStore.get().activeTabId;

    // Emit loading-change and title-change events -> must NOT destroy/recreate .browser-pane-viewport or show text banner
    for (const cb of hostEventListeners) {
      cb({ type: 'loading-change', tabId, loading: true });
      cb({ type: 'title-change', tabId, title: 'batman - Ecosia' });
      cb({ type: 'loading-change', tabId, loading: false });
      // Emit spurious about:blank event -> must be ignored completely
      cb({ type: 'location-change', tabId, url: 'about:blank', pushHistory: true });
    }
    assert.equal(host.querySelector('.browser-pane-viewport'), firstViewport, 'Native viewport DOM node is preserved in place without flicker');
    assert.equal(host.querySelector('.browser-pane-loading'), null, 'No DOM loading text banner flashes behind native viewport');
    assert.equal(browserStore.get().tabs[0].url, 'https://www.ecosia.org/search?q=batman');

    // Navigate to Wikipedia via top-level location-change, then click Back -> returns to Ecosia
    for (const cb of hostEventListeners) {
      cb({
        type: 'location-change',
        tabId,
        url: 'https://en.wikipedia.org/wiki/Batman',
        title: 'Batman - Wikipedia',
        loading: false,
        pushHistory: true,
      });
    }
    assert.equal(browserStore.get().tabs[0].url, 'https://en.wikipedia.org/wiki/Batman');
    host.querySelector('.browser-back-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(browserStore.get().tabs[0].url, 'https://www.ecosia.org/search?q=batman');
  } finally {
    app?.destroy();
    resetBrowserStoreForTests();
    globalThis.sanctuaryBrowserHost = prevHost;
    dom.restore();
  }
});
