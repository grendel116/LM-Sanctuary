import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mountFeedScreen } from '../web/app/feed.js';
import { mountSearchScreen } from '../web/app/search.js';
import { createPostCard } from '../web/components/PostCard.js';
import { openUserModal } from '../web/components/sanctuary/UserModal.js';
import { toUnifiedItem } from '../web/core/schema/unifiedItem.js';
import { clearFediverseDiscoveryCacheForTests, normalizeMastodonStatus } from '../web/queries/fediverse.js';
import { clearHarvesterCacheForTests } from '../web/queries/feedHarvester.js';
import { resetAuthStoreForTests } from '../web/state/authStore.js';
import {
  feedStore,
  mutatePostAcrossStreams,
  resetFeedStoreForTests,
  setActiveStream,
} from '../web/state/feedStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import {
  clearAllLocalVaultSecrets,
  loadVaultSecret,
  resetMemoryStorageForTests,
  saveVaultSecret,
  storePut,
} from '../web/storage/nativeStore.js';

function makeMastoPhotoStatus(id, { width = 1080, height = 1080, likes = 4, acct = `u_${id}@pixelfed.social` } = {}) {
  return {
    id,
    created_at: '2026-11-23T12:00:00Z',
    content: `<p>Photo ${id}</p>`,
    favourites_count: likes,
    reblogs_count: 0,
    replies_count: 0,
    account: {
      id: `acc_${id}`,
      username: `u_${id}`,
      acct,
      display_name: `User ${id}`,
      discoverable: true,
      indexable: true,
    },
    media_attachments: [
      {
        id: `m_${id}`,
        type: 'image',
        url: `https://pixelfed.social/${id}.jpg`,
        preview_url: `https://pixelfed.social/${id}_thumb.jpg`,
        meta: { original: { width, height } },
      },
    ],
  };
}

test('Photos stream has no Gallery toggle, appends on scroll, shows Load more, and updates likes in place', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let feedCtrl = null;

  const page1 = [];
  for (let i = 1; i <= 40; i += 1) {
    page1.push(makeMastoPhotoStatus(`p1_${i}`, { likes: i }));
  }
  // Page 2 has 40 wide 16:9 items so sieveSovereignCandidates drops all of them on page 2,
  // forcing loadStream(true) to advance one more page to page 3 automatically.
  const page2 = [];
  for (let i = 1; i <= 40; i += 1) {
    page2.push(makeMastoPhotoStatus(`p2_${i}`, { width: 1920, height: 1080 }));
  }
  const page3 = [];
  for (let i = 1; i <= 40; i += 1) {
    page3.push(makeMastoPhotoStatus(`p3_${i}`, { likes: 50 + i }));
  }
  const page4 = [];
  for (let i = 1; i <= 40; i += 1) {
    page4.push(makeMastoPhotoStatus(`p4_${i}`, { likes: 80 + i }));
  }
  const page5 = [];
  for (let i = 1; i <= 10; i += 1) {
    page5.push(makeMastoPhotoStatus(`p5_${i}`, { likes: 90 + i }));
  }

  const requestedUrls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.includes('/api/v1/timelines/tag/pixelfed')) {
      let body = [];
      let nextCursor = '';
      if (u.includes('max_id=cur_p4')) {
        body = page5;
      } else if (u.includes('max_id=cur_p3')) {
        body = page4;
        nextCursor = 'cur_p4';
      } else if (u.includes('max_id=cur_p2')) {
        body = page3;
        nextCursor = 'cur_p3';
      } else if (u.includes('max_id=cur_p1')) {
        body = page2;
        nextCursor = 'cur_p2';
      } else {
        body = page1;
        nextCursor = 'cur_p1';
      }
      const headers = { 'content-type': 'application/json' };
      if (nextCursor) {
        headers.link = `<https://mastodon.world/api/v1/timelines/tag/pixelfed?max_id=${nextCursor}>; rel="next"`;
      }
      return new Response(JSON.stringify(body), { status: 200, headers });
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    clearHarvesterCacheForTests();
    clearFediverseDiscoveryCacheForTests();

    setActiveStream('photos');
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);

    await new Promise((r) => setTimeout(r, 80));

    const listEl = host.querySelector('.feed-posts-list');
    assert.ok(listEl);
    assert.ok(requestedUrls.some((u) => u.includes('only_media=true')));
    assert.equal(host.querySelector('.photos-view-btn'), null);
    assert.equal(listEl.querySelectorAll('.photo-mosaic-tile').length, 0);
    const initialCards = listEl.querySelectorAll('article.post-card').length;
    assert.ok(initialCards > 0);

    // Trigger infinite scroll near bottom in Photos stream
    host.scrollHeight = 1200;
    host.clientHeight = 500;
    host.scrollTop = 650;
    host.dispatchEvent(new globalThis.Event('scroll'));

    await new Promise((r) => setTimeout(r, 140));

    const afterScrollCards = listEl.querySelectorAll('article.post-card').length;
    assert.ok(afterScrollCards > initialCards, `Expected more post cards after scroll (${afterScrollCards} > ${initialCards})`);
    assert.equal(host.querySelector('.feed-retry-more-btn'), null, 'Retry button must not appear on successful scroll');
    assert.ok(feedStore.get().streams.photos.items.some((p) => p.id === 'mastodon:p3_1'));

    // Load more posts button is visible when nextCursor remains, and clicking it fetches & appends page 5
    const loadMoreBtn = host.querySelector('.feed-load-more-btn');
    assert.ok(loadMoreBtn, 'Expected Load more posts button when nextCursor is present');
    const reqCountBeforeClick = requestedUrls.length;
    loadMoreBtn.click();
    await new Promise((r) => setTimeout(r, 140));
    assert.ok(requestedUrls.length > reqCountBeforeClick, 'Clicking Load more posts must fetch next page');
    assert.ok(feedStore.get().streams.photos.items.some((p) => p.id === 'mastodon:p5_1'));

    // In-place like count update on a post card
    const firstCard = listEl.querySelector('article.post-card');
    const targetKey = firstCard.dataset.postKey || firstCard.dataset.postId;
    mutatePostAcrossStreams(targetKey, (cur) => ({
      ...cur,
      metrics: { ...cur.metrics, likes: 777 },
    }));
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(firstCard.querySelector('.post-action-like .post-action-count')?.textContent, '777');
  } finally {
    feedCtrl?.destroy?.();
    globalThis.fetch = prevFetch;
    resetFeedStoreForTests();
    dom.restore();
  }
});

test('loadVaultSecret returns null and cleans up stale record when vault key rotates', async () => {
  resetMemoryStorageForTests();
  await saveVaultSecret('acct_1', { accessToken: 'tok' });
  await clearAllLocalVaultSecrets();
  await storePut('social_vault', 'acct_1', {
    id: 'acct_1',
    iv: 'AAAAAAAAAAAAAAAA',
    ciphertext: 'AAAA',
    updatedAt: Date.now(),
  });
  const res = await loadVaultSecret('acct_1');
  assert.equal(res, null);
  resetMemoryStorageForTests();
});

test('Search screen shows instant preview dropdown on typing', async () => {
  const dom = installMockDom();
  let searchCtrl = null;
  globalThis.fetch = async () => new Response(JSON.stringify({ actors: [], accounts: [], hashtags: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    searchCtrl = mountSearchScreen(host);
    const input = host.querySelector('#global-search-input');
    assert.ok(input);
    input.value = 'fewafewa';
    input.dispatchEvent(new globalThis.Event('input'));
    const dropdown = host.querySelector('.search-suggest-dropdown');
    assert.ok(dropdown);
    assert.equal(dropdown.hidden, false);
    assert.ok(dropdown.textContent.includes('Search "fewafewa"'));
  } finally {
    searchCtrl?.destroy?.();
    dom.restore();
  }
});

test('UserModal resolves kxcStatus instead of hanging on checking message', async () => {
  const dom = installMockDom();
  let modal = null;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/keepassxc/status')) {
      return new Response(
        JSON.stringify({
          initialized: true,
          associated: true,
          database_unlocked: true,
          vault_mode: 'keepassxc',
          vault_filename: 'Keys.kdbx',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });
    modal = openUserModal();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(modal.dialog.textContent.includes('Checking in-app .kdbx vault status'), false);
    assert.ok(modal.dialog.textContent.includes('Keys.kdbx'));
  } finally {
    modal?.close?.();
    resetConnectionStoreForTests();
    dom.restore();
  }
});

test('Photos ig_photo card renders captionless image posts without throwing', () => {
  const dom = installMockDom();
  try {
    const raw = { ...makeMastoPhotoStatus('captionless_1'), content: '' };
    const item = toUnifiedItem(normalizeMastodonStatus(raw, 'https://pixelfed.social'));
    let card = null;
    assert.doesNotThrow(() => {
      card = createPostCard(item, { layoutVariant: 'ig_photo' });
    });
    assert.ok(card);
    assert.equal(card.classList.contains('is-ig-photo-card'), true);
  } finally {
    dom.restore();
  }
});
