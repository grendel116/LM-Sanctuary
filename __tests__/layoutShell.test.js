import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mockMobileHealthOnline } from '../__mocks__/mockProgram.js';
import { createAppShell } from '../web/app/_layout.js';
import { browserStore, resetBrowserStoreForTests } from '../web/state/browserStore.js';
import { composeStore, resetCompose } from '../web/state/composeStore.js';
import { feedStore, resetFeedStoreForTests } from '../web/state/feedStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SHELL_CSS_PATH = path.resolve(__dirname, '..', 'web', 'assets', 'css', 'shell.css');

test('3-column shell boots synchronously into Home, keeps right Sanctuary dock mounted, and wires modals & tabs', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let feedTrendCalls = 0;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v1/trends/statuses')) {
      feedTrendCalls += 1;
      return new Response(
        JSON.stringify([
          {
            id: 'trend_1',
            created_at: '2026-11-19T02:00:00Z',
            content: '<p>Thread preservation test post</p>',
            account: { id: 'a_t1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
            media_attachments: [],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.getFeed')) {
      return new Response(JSON.stringify({ feed: [], cursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/v1/statuses/trend_1/context')) {
      return new Response(JSON.stringify({ ancestors: [], descendants: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/v1/statuses/trend_1')) {
      return new Response(
        JSON.stringify({
          id: 'trend_1',
          created_at: '2026-11-19T02:00:00Z',
          content: '<p>Thread preservation test post</p>',
          account: { id: 'a_t1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
          media_attachments: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('[]', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  let app = null;
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    feedStore.set({
      tuning: {
        version: 2,
        updatedAt: 0,
        updatedBy: 'default',
        discoveryChannels: [],
        discoveryInstances: ['mastodon.social'],
      },
    });
    resetCompose();
    resetBrowserStoreForTests();

    const doc = dom.document;
    const overlay = doc.createElement('div');
    overlay.id = 'chat-loading-overlay';
    const host = doc.createElement('div');
    host.id = 'app-shell';
    doc.body.append(overlay, host);

    const t0 = performance.now();
    app = createAppShell(host, { initialTab: 'home', skipBackgroundInit: true });
    const bootMs = performance.now() - t0;

    // Immediate non-blocking paint dismisses splash and mounts 3-column shell
    assert.ok(bootMs < 50, `Expected <50ms boot, took ${bootMs.toFixed(1)}ms`);
    assert.ok(overlay.classList.contains('fade-out'));
    assert.equal(connectionStore.get().mode, 'dormant');

    const desktopTabs = host.querySelectorAll('.primary-tab-btn:not(.mobile-only-tab)');
    const mobileTabs = host.querySelectorAll('.primary-tab-btn:not(.desktop-only-tab)');
    assert.deepEqual(
      Array.from(desktopTabs).map((b) => b.dataset.tab),
      ['browser', 'home', 'search', 'messages', 'activity']
    );
    assert.deepEqual(
      Array.from(mobileTabs).map((b) => b.dataset.tab),
      ['browser', 'messages', 'home', 'activity', 'profile']
    );
    assert.equal(host.querySelector('[data-tab="sanctuary"]'), null);
    assert.equal(desktopTabs[1].getAttribute('aria-current'), 'page');
    assert.equal(doc.title, 'Home');
    assert.equal(host.querySelector('.rail-brand'), null);
    assert.equal(host.querySelector('.primary-tab-label'), null);
    for (const navBtn of mobileTabs) {
      assert.equal(navBtn.textContent.trim(), '');
      assert.ok(navBtn.getAttribute('aria-label'));
    }

    // Mobile top utility bar holds Search (replacing Profile) and Settings
    const mobileActions = host.querySelector('.mobile-utility-actions');
    const mobileSearchBtn = mobileActions?.querySelector('.mobile-search-btn');
    assert.ok(mobileSearchBtn);
    assert.ok(mobileActions?.querySelector('[aria-label="Settings"]'));
    assert.equal(mobileActions?.querySelector('[aria-label="User & Accounts"]'), null);

    // Home mounts four sleek tabs: Feed, Following, Photos, and Video, plus a manual refresh button beside Video
    const feedTabs = host.querySelectorAll('.feed-stream-tabs .stage-tab-btn');
    assert.equal(feedTabs.length, 4);
    assert.equal(feedTabs[0].textContent, 'Feed');
    assert.equal(feedTabs[1].textContent, 'Following');
    assert.equal(feedTabs[2].textContent, 'Photos');
    assert.equal(feedTabs[3].textContent, 'Video');
    const feedRefreshBtn = host.querySelector('.feed-stream-tabs .feed-refresh-btn');
    assert.ok(feedRefreshBtn);
    const tabRowChildren = Array.from(host.querySelector('.feed-stream-tabs').children);
    assert.equal(tabRowChildren.indexOf(feedRefreshBtn), tabRowChildren.indexOf(feedTabs[3]) + 1);

    const shellCss = fs.readFileSync(SHELL_CSS_PATH, 'utf8');
    assert.equal(shellCss.includes('.primary-tab-btn[aria-current="page"]::after'), false);
    assert.match(shellCss, /\.mobile-compose-fab\s*\{[^}]*inline-size:\s*36px;[^}]*border-radius:\s*50%;/s);
    assert.match(shellCss, /html,\s*body\s*\{[^}]*overflow:\s*hidden;/s);
    assert.match(shellCss, /\.app-shell-frame\s*\{[^}]*position:\s*relative;/s);
    assert.match(shellCss, /\.center-column-wrap\s*\{[^}]*position:\s*relative;/s);
    assert.match(shellCss, /\.sanctuary-right-dock\s*\{[^}]*position:\s*relative;/s);

    // Right Sanctuary dock mounts once with #user-input, 4 header actions (Voice Call, Image Gallery, Quest Log, Memory), and a collapsible toggle
    const rightDock = host.querySelector('.sanctuary-right-dock');
    assert.ok(rightDock);
    const threadRoot = rightDock.querySelector('.sanctuary-thread-view');
    assert.ok(threadRoot);
    assert.ok(rightDock.querySelector('#user-input'));
    assert.ok(rightDock.querySelectorAll('.header-actions button').length >= 4);
    assert.ok(rightDock.querySelector('.header-actions .gallery-btn'));
    assert.equal(rightDock.querySelector('#thread-model-select'), null);

    const collapseBtn = host.querySelector('.sanctuary-dock-toggle');
    const shellFrame = host.querySelector('.app-shell-frame');
    const splitResizer = host.querySelector('.workspace-split-resizer');
    assert.ok(collapseBtn);
    assert.ok(splitResizer);
    assert.equal(collapseBtn.getAttribute('aria-expanded'), 'true');
    splitResizer.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'ArrowLeft' }));
    assert.equal(browserStore.get().sanctuarySplitPct, 44);
    assert.equal(shellFrame.style.getPropertyValue('--sanctuary-dock-w'), '44%');
    collapseBtn.click();
    assert.equal(shellFrame.classList.contains('is-sanctuary-collapsed'), true);
    assert.equal(splitResizer.hidden, true);
    assert.equal(collapseBtn.getAttribute('aria-expanded'), 'false');
    collapseBtn.click();
    assert.equal(shellFrame.classList.contains('is-sanctuary-collapsed'), false);
    assert.equal(splitResizer.hidden, false);
    assert.equal(collapseBtn.getAttribute('aria-expanded'), 'true');

    // Opening a post thread backgrounds the feed without unmounting it, and Back restores scroll without refetching
    await new Promise((r) => setTimeout(r, 35));
    const centerWrap = host.querySelector('.center-column-wrap');
    const screenHost = host.querySelector('.stage-screen-host');
    const feedElBefore = host.querySelector('.feed-screen');
    const card = host.querySelector('.feed-screen article.post-card');
    assert.ok(centerWrap && screenHost && feedElBefore && card);
    const fetchesBeforeThread = feedTrendCalls;
    centerWrap.scrollTop = 320;
    card.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(screenHost.classList.contains('is-backgrounded'), true);
    assert.ok(host.querySelector('.stage-thread-host .post-thread-view'));
    host.querySelector('.stage-thread-host .post-thread-view .edit-cancel-btn').click();
    assert.equal(screenHost.classList.contains('is-backgrounded'), false);
    assert.equal(host.querySelector('.feed-screen'), feedElBefore);
    assert.equal(centerWrap.scrollTop, 320);
    assert.equal(feedTrendCalls, fetchesBeforeThread);

    // Navigating across center views keeps the exact same right-dock thread instance mounted
    mobileSearchBtn.click();
    assert.equal(desktopTabs[2].getAttribute('aria-current'), 'page');
    assert.equal(mobileSearchBtn.getAttribute('aria-current'), 'page');
    assert.equal(desktopTabs[1].getAttribute('aria-current'), null);
    assert.equal(doc.title, 'Search');
    assert.equal(host.querySelector('.sanctuary-right-dock .sanctuary-thread-view'), threadRoot);

    app.navigateToTab('activity');
    assert.equal(desktopTabs[4].getAttribute('aria-current'), 'page');
    assert.equal(doc.title, 'Activity');
    assert.equal(host.querySelector('.sanctuary-right-dock .sanctuary-thread-view'), threadRoot);

    // Returning to Home preserves the mounted feed, scroll offset, and makes zero automatic refreshes
    app.navigateToTab('home');
    assert.equal(desktopTabs[1].getAttribute('aria-current'), 'page');
    assert.equal(host.querySelector('.feed-screen'), feedElBefore);
    assert.equal(centerWrap.scrollTop, 320);
    assert.equal(feedTrendCalls, fetchesBeforeThread);

    // Pressing Home while already on Home scrolls back to the top
    mobileTabs[2].click();
    assert.equal(centerWrap.scrollTop, 0);
    assert.equal(feedTrendCalls, fetchesBeforeThread);

    // Browser tab mounts cleanly in desktop index 0 and mobile index 0, hiding Fediverse bar on mobile
    const mobileBar = host.querySelector('.mobile-utility-bar');
    assert.ok(mobileBar);
    assert.equal(mobileBar.hidden, false);
    desktopTabs[0].click();
    assert.equal(doc.title, 'Browser');
    assert.equal(shellFrame.classList.contains('is-browser-stage-active'), true);
    assert.equal(mobileBar.hidden, true);
    assert.match(
      shellCss,
      /\.app-shell-frame\.is-browser-stage-active\s+\.mobile-utility-bar\s*\{[^}]*display:\s*none/
    );
    assert.match(
      shellCss,
      /\.browser-stage-header\s*\{[^}]*top:\s*0/
    );
    assert.match(shellCss, /safe-area-inset-top/);
    assert.equal(desktopTabs[0].getAttribute('aria-current'), 'page');
    assert.equal(mobileTabs[0].getAttribute('aria-current'), 'page');
    assert.ok(host.querySelector('.stage-browser-host .browser-screen'));
    app.navigateToTab('home');
    assert.equal(shellFrame.classList.contains('is-browser-stage-active'), false);
    assert.equal(mobileBar.hidden, false);

    // Explicit refresh button next to Following triggers a manual refresh
    feedRefreshBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(feedRefreshBtn.classList.contains('is-spinning'), true);
    assert.match(shellCss, /@keyframes\s+classicSpin/);
    assert.match(shellCss, /\.feed-refresh-btn\.is-spinning\s+svg\s*\{[^}]*animation:\s*classicSpin/);
    assert.ok(feedTrendCalls > fetchesBeforeThread);

    // Left-rail circular + Compose FAB opens native <dialog> via showModal()
    const composeFab = host.querySelector('.rail-compose-fab');
    assert.ok(composeFab);
    composeFab.click();
    assert.equal(composeStore.get().isOpen, true);
    assert.equal(app.composeCtrl.dialog.open, true);
    app.composeCtrl.close();

    // Messages separates Direct vs Programs cleanly
    connectionStore.set({ mode: 'offline', programs: mockMobileHealthOnline.programs });
    app.navigateToTab('messages');
    assert.equal(host.querySelector('.convo-row--program'), null, 'Direct tab must not mix AI Programs');
    const programsTabBtn = host.querySelector('[data-messages-tab="programs"]');
    assert.ok(programsTabBtn);
    programsTabBtn.click();
    const progRow = host.querySelector('.convo-row--program');
    assert.ok(progRow);
    assert.ok(progRow.textContent.includes('Sanctuary Offline • Tap to view cached chat'));
    assert.equal(host.querySelector('.convo-row--session'), null, 'Programs tab must remain strictly for Program management');

    // Mobile bottom Profile tab and desktop rail User route to center Profile screen
    mobileTabs[4].click();
    assert.equal(mobileTabs[4].getAttribute('aria-current'), 'page');
    const userBtn = host.querySelector('.rail-utility-btn[data-modal="user"]');
    assert.ok(userBtn);
    assert.equal(userBtn.getAttribute('aria-current'), 'page');
    assert.equal(doc.title, 'Profile');
    userBtn.click();
    assert.equal(doc.title, 'Profile');
    assert.ok(host.querySelector('.profile-screen'));
    assert.ok(host.querySelector('.sanctuary-right-dock'), 'Right Sanctuary dock must remain mounted on Profile view');
    const accountsBtn = host.querySelector('.profile-accounts-btn');
    assert.ok(accountsBtn);
    accountsBtn.click();
    const userDialog = doc.getElementById('user-accounts-dialog');
    assert.ok(userDialog);
    assert.equal(userDialog.open, true);
    userDialog.close();

    const settingsBtn = host.querySelector('.rail-utility-btn[data-modal="settings"]');
    assert.ok(settingsBtn);
    settingsBtn.click();
    const settingsDialog = doc.getElementById('connection-settings-dialog');
    assert.ok(settingsDialog);
    assert.equal(settingsDialog.open, true);
    settingsDialog.close();

    app.destroy();
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    app?.destroy();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});
