/* SPDX-License-Identifier: AGPL-3.0-or-later */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { MastodonAdapter } from '../web/adapters/mastodon/index.js';
import { createPostCard } from '../web/components/PostCard.js';
import { deduplicateUnifiedItems, toUnifiedItem } from '../web/core/schema/unifiedItem.js';
import { authStore, resetAuthStoreForTests } from '../web/state/authStore.js';
import { feedStore, mutatePostAcrossStreams, resetFeedStoreForTests, setStreamItems } from '../web/state/feedStore.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

test('deduplicateUnifiedItems preserves per-network metricsBreakdown and sums metrics across linked protocols', () => {
  const ts = '2026-11-24T12:00:00.000Z';
  const masto = {
    ...toUnifiedItem({
      network: 'fediverse',
      id: 'm100',
      instanceUrl: 'https://mastodon.social',
      contentHtml: '<p>Crossposted note</p>',
      text: 'Crossposted note',
      createdAt: ts,
      author: { id: '99', acct: 'alice.bsky.social@bsky.brid.gy', displayName: 'Alice Mirror' },
    }),
    metrics: { likes: 4, replies: 1, reposts: 2 },
  };
  const bsky = {
    id: 'bluesky:at://did:plc:alice/app.bsky.feed.post/100',
    protocol: 'bluesky',
    url: 'https://bsky.app/profile/alice.bsky.social/post/100',
    content_html: '<p>Crossposted note</p>',
    content_text: 'Crossposted note',
    date_published: ts,
    author: { id: 'did:plc:alice', name: 'Alice', handle: 'alice.bsky.social' },
    attachments: [],
    metrics: { likes: 12, replies: 3, reposts: 5 },
    _meta: { bluesky: { uri: 'at://did:plc:alice/app.bsky.feed.post/100', cid: 'bafy100' } },
  };

  const deduped = deduplicateUnifiedItems([bsky, masto]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0]._meta.metricsBreakdown.mastodon.likes, 4);
  assert.equal(deduped[0]._meta.metricsBreakdown.bluesky.likes, 12);
  assert.equal(deduped[0].metrics.likes, 16);
  assert.equal(deduped[0].metrics.replies, 4);
  assert.equal(deduped[0].metrics.reposts, 7);
});

test('mutatePostAcrossStreams sums metricsBreakdown instead of adding onto inflated totals', () => {
  resetMemoryStorageForTests();
  resetFeedStoreForTests();

  const item = {
    id: 'mastodon:m200',
    protocol: 'mastodon',
    date_published: '2026-11-24T12:00:00.000Z',
    author: { id: 'u1', name: 'Alice', handle: 'alice@mastodon.social' },
    content_text: 'Hello world',
    metrics: { likes: 16, replies: 0, reposts: 0 },
    _meta: {
      mastodon: { statusId: 'm200', instanceUrl: 'https://mastodon.social' },
      metricsBreakdown: {
        mastodon: { likes: 4, replies: 0, reposts: 0 },
        bluesky: { likes: 12, replies: 0, reposts: 0 },
      },
    },
  };

  setStreamItems('feed', [item]);
  mutatePostAcrossStreams('mastodon:m200', (prev) => ({
    ...prev,
    metrics: { ...prev.metrics, likes: 5 },
  }));

  const updated = feedStore.get().streams.feed.items[0];
  assert.equal(updated.metrics.likes, 17);
  assert.equal(updated._meta.metricsBreakdown.mastodon.likes, 5);
  assert.equal(updated._meta.metricsBreakdown.bluesky.likes, 12);
  resetFeedStoreForTests();
  resetMemoryStorageForTests();
});

test('MastodonAdapter.like reads base count from metricsBreakdown.mastodon instead of summed total', async () => {
  const adapter = new MastodonAdapter({
    instanceUrl: 'https://mastodon.social',
    accessToken: 'tok',
    fetchImpl: async () => new Response(
      JSON.stringify({
        id: 'm300',
        content: '<p>Hi</p>',
        created_at: '2026-11-24T12:00:00.000Z',
        favourites_count: 4,
        reblogs_count: 0,
        replies_count: 0,
        favourited: true,
        account: { id: '1', acct: 'alice', display_name: 'Alice', avatar: '' },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    ),
  });

  const item = {
    id: 'mastodon:m300',
    protocol: 'mastodon',
    date_published: '2026-11-24T12:00:00.000Z',
    author: { id: '1', name: 'Alice', handle: 'alice@mastodon.social' },
    content_text: 'Hi',
    metrics: { likes: 16, replies: 0, reposts: 0 },
    _meta: {
      mastodon: { statusId: 'm300', instanceUrl: 'https://mastodon.social', favourited: false },
      metricsBreakdown: {
        mastodon: { likes: 4, replies: 0, reposts: 0 },
        bluesky: { likes: 12, replies: 0, reposts: 0 },
      },
    },
  };

  const res = await adapter.like(item, false);
  assert.equal(res.metrics.likes, 5);
});

test('Locked vault actions show needs-unlock and dispatch sanctuary:request-unlock before running action', async () => {
  const dom = installMockDom();
  const prevAdd = globalThis.addEventListener;
  const prevRemove = globalThis.removeEventListener;
  const prevDispatch = globalThis.dispatchEvent;
  const eventTarget = new EventTarget();
  globalThis.addEventListener = eventTarget.addEventListener.bind(eventTarget);
  globalThis.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
  globalThis.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);

  let muteCalls = 0;
  let unlockEvents = 0;
  const onReqUnlock = (e) => {
    unlockEvents += 1;
    void e?.detail?.onUnlocked?.();
  };
  globalThis.addEventListener('sanctuary:request-unlock', onReqUnlock);

  try {
    resetAuthStoreForTests();
    authStore.set({
      vaultLocked: true,
      accounts: [{ id: 'fedi_1', platform: 'fediverse', acct: 'me@mastodon.social' }],
      isMastodonConnected: true,
    });

    const card = createPostCard(
      {
        id: 'mastodon:m400',
        protocol: 'mastodon',
        date_published: '2026-11-24T12:00:00.000Z',
        author: { id: 'u9', name: 'Bob', handle: 'bob@mastodon.social' },
        content_text: 'Test post',
        metrics: { likes: 0, replies: 0, reposts: 0 },
        _meta: { mastodon: { statusId: 'm400', instanceUrl: 'https://mastodon.social' } },
      },
      {
        onToggleLike: () => {},
        onReply: () => {},
        onToggleRepost: () => {},
        onMuteAuthor: () => { muteCalls += 1; },
      }
    );

    const likeBtn = card.querySelector('.post-action-like');
    assert.ok(likeBtn);
    assert.equal(likeBtn.disabled, false);
    assert.equal(likeBtn.dataset.needsUnlock, '1');

    const moreBtn = card.querySelector('.post-more-btn');
    moreBtn.click();
    const muteItem = Array.from(card.querySelectorAll('.post-context-menuitem'))
      .find((b) => b.textContent.includes('Mute Account'));
    assert.ok(muteItem);
    assert.equal(muteItem.disabled, false);
    assert.equal(muteItem.classList.contains('needs-unlock'), true);

    muteItem.click();
    assert.equal(unlockEvents, 1);
    assert.equal(muteCalls, 1);
  } finally {
    globalThis.removeEventListener('sanctuary:request-unlock', onReqUnlock);
    globalThis.addEventListener = prevAdd;
    globalThis.removeEventListener = prevRemove;
    globalThis.dispatchEvent = prevDispatch;
    resetAuthStoreForTests();
    dom.restore();
  }
});

test('Unlocking authStore clears lock markers on already-rendered PostCard controls and skips unlock prompt', async () => {
  const dom = installMockDom();
  const prevAdd = globalThis.addEventListener;
  const prevRemove = globalThis.removeEventListener;
  const prevDispatch = globalThis.dispatchEvent;
  const eventTarget = new EventTarget();
  globalThis.addEventListener = eventTarget.addEventListener.bind(eventTarget);
  globalThis.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
  globalThis.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);

  let muteCalls = 0;
  let likeCalls = 0;
  let unlockEvents = 0;
  const onReqUnlock = (e) => {
    unlockEvents += 1;
    void e?.detail?.onUnlocked?.();
  };
  globalThis.addEventListener('sanctuary:request-unlock', onReqUnlock);

  try {
    resetAuthStoreForTests();
    authStore.set({
      vaultLocked: true,
      accounts: [{ id: 'fedi_1', platform: 'fediverse', acct: 'me@mastodon.social' }],
      isMastodonConnected: true,
    });

    const card = createPostCard(
      {
        id: 'mastodon:m401',
        protocol: 'mastodon',
        date_published: '2026-11-24T12:00:00.000Z',
        author: { id: 'u9', name: 'Bob', handle: 'bob@mastodon.social' },
        content_text: 'Test post',
        metrics: { likes: 0, replies: 0, reposts: 0 },
        _meta: { mastodon: { statusId: 'm401', instanceUrl: 'https://mastodon.social' } },
      },
      {
        onToggleLike: () => { likeCalls += 1; },
        onReply: () => {},
        onToggleRepost: () => {},
        onMuteAuthor: () => { muteCalls += 1; },
      }
    );

    const likeBtn = card.querySelector('.post-action-like');
    const moreBtn = card.querySelector('.post-more-btn');
    moreBtn.click();
    const muteItem = Array.from(card.querySelectorAll('.post-context-menuitem'))
      .find((b) => b.textContent.includes('Mute Account'));
    assert.ok(likeBtn);
    assert.ok(muteItem);
    assert.equal(muteItem.classList.contains('needs-unlock'), true);
    assert.equal(likeBtn.dataset.needsUnlock, '1');

    authStore.set({ vaultLocked: false });

    assert.equal(muteItem.classList.contains('needs-unlock'), false);
    assert.equal(likeBtn.dataset.needsUnlock, undefined);

    muteItem.click();
    assert.equal(muteCalls, 1);
    assert.equal(unlockEvents, 0);

    likeBtn.click();
    assert.equal(likeCalls, 1);
    assert.equal(unlockEvents, 0);
  } finally {
    globalThis.removeEventListener('sanctuary:request-unlock', onReqUnlock);
    globalThis.addEventListener = prevAdd;
    globalThis.removeEventListener = prevRemove;
    globalThis.dispatchEvent = prevDispatch;
    resetAuthStoreForTests();
    dom.restore();
  }
});
