import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import {
  applyKeywordFilters,
  canonicalizeActorHandle,
  deduplicateUnifiedItems,
  toUnifiedItem,
} from '../web/core/schema/unifiedItem.js';
import {
  deleteUnified,
  editUnified,
  fetchAuthorWithRelationship,
  fetchFollowConnections,
  fetchOwnStatuses,
  fetchUnifiedNotifications,
  normalizeAccountRecord,
  pinUnified,
  publishUnified,
  removeFollowerAccount,
  replyUnified,
} from '../web/queries/socialClient.js';
import { cleanMastodonMediaUrl, renderProfileLinksAndFields } from '../web/queries/fediverse.js';
import { publishOrganicPost } from '../web/app/composeModal.js';
import { renderPostThreadView } from '../web/app/postThread.js';
import { mountProfileScreen, openEditMastodonProfileModal } from '../web/app/profile.js';
import { composeStore, resetCompose } from '../web/state/composeStore.js';
import { mountSearchScreen } from '../web/app/search.js';
import { openAuthorSheetModal } from '../web/components/AuthorSheetModal.js';
import { openFollowGraphModal } from '../web/components/FollowGraphModal.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { openUserModal } from '../web/components/sanctuary/UserModal.js';
import { authStore, resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';
import { resetMemoryStorageForTests } from '../web/storage/nativeStore.js';

test('UnifiedItem normalizes protocols, deduplicates Bridgy/Threads mirrors, and applies keyword filters', () => {
  assert.equal(canonicalizeActorHandle('@alice.bsky.social@bsky.brid.gy', 'mastodon'), 'bluesky:alice.bsky.social');
  assert.equal(canonicalizeActorHandle('@bob@threads.net', 'mastodon'), 'threads:bob');

  const ts = '2026-11-18T12:00:00.000Z';
  const mastoMirror = toUnifiedItem({
    network: 'fediverse',
    id: 'm1',
    instanceUrl: 'https://mastodon.social',
    contentHtml: '<p>Crossposted note from bridge</p>',
    text: 'Crossposted note from bridge',
    createdAt: ts,
    author: { id: '99', acct: 'alice.bsky.social@bsky.brid.gy', displayName: 'Alice Mirror' },
  });
  const nativeBsky = {
    id: 'bluesky:at://did:plc:alice/app.bsky.feed.post/1',
    protocol: 'bluesky',
    url: 'https://bsky.app/profile/alice.bsky.social/post/1',
    content_html: '<p>Crossposted note from bridge</p>',
    content_text: 'Crossposted note from bridge',
    date_published: ts,
    author: { id: 'did:plc:alice', name: 'Alice', handle: 'alice.bsky.social' },
    attachments: [],
    metrics: { replies: 1, reposts: 2, likes: 3 },
    _meta: { bluesky: { uri: 'at://did:plc:alice/app.bsky.feed.post/1', cid: 'bafy1' } },
  };

  const deduped = deduplicateUnifiedItems([nativeBsky, mastoMirror]);
  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].protocol, 'mastodon');
  assert.ok(deduped[0]._meta.bluesky?.uri);

  const filtered = applyKeywordFilters(
    [
      toUnifiedItem({ network: 'fediverse', id: 'p1', text: 'Spoiler movie ending', createdAt: ts, author: { acct: 'a' } }),
      toUnifiedItem({ network: 'fediverse', id: 'p2', text: 'Muted crypto spam link', createdAt: ts, author: { acct: 'b' } }),
      toUnifiedItem({ network: 'fediverse', id: 'p3', text: 'Morning coffee', createdAt: ts, author: { acct: 'c' } }),
    ],
    [
      { id: 'f1', title: 'Movie Spoilers', phrase: 'spoiler', filter_action: 'warn' },
      { id: 'f2', title: 'Crypto Spam', phrase: 'crypto', filter_action: 'hide' },
    ]
  );
  assert.equal(filtered.length, 2);
  assert.equal(filtered[0]._meta.mastodon.spoilerText, 'Movie Spoilers');
  assert.equal(filtered[1].content_text, 'Morning coffee');
});

test('publishUnified fans out concurrently with >300 smart split, saves linkedIds, handles partial bridge failure, deletes and replies by protocol', async () => {
  const calls = [];
  const prevFetch = globalThis.fetch;
  let mastoCounter = 100;
  let bskyCounter = 1;
  let threadsFail = false;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body });

    if (u.endsWith('/api/v1/statuses') && method === 'POST') {
      mastoCounter += 1;
      const id = String(mastoCounter);
      return new Response(
        JSON.stringify({
          id,
          uri: `https://mastodon.social/users/alice/statuses/${id}`,
          url: `https://mastodon.social/@alice/${id}`,
          content: `<p>${JSON.parse(init.body).status}</p>`,
          created_at: new Date().toISOString(),
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
          media_attachments: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/statuses/') && method === 'DELETE') {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/api/v1/statuses/') && method === 'PUT') {
      const id = u.split('/').pop();
      return new Response(
        JSON.stringify({
          id,
          content: `<p>${JSON.parse(init.body).status}</p>`,
          created_at: new Date().toISOString(),
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/pin')) {
      return new Response(
        JSON.stringify({ id: '101', pinned: true, content: '<p>Pinned</p>', account: { id: 'u1', acct: 'alice@mastodon.social' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('com.atproto.repo.createRecord')) {
      bskyCounter += 1;
      return new Response(
        JSON.stringify({ uri: `at://did:plc:alice/app.bsky.feed.post/b${bskyCounter}`, cid: `cid_${bskyCounter}` }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('com.atproto.repo.deleteRecord')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.endsWith('graph.threads.net/v1.0/th_1/threads_publish')) {
      return new Response(JSON.stringify({ id: 'th_pub_99' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.endsWith('graph.threads.net/v1.0/th_1/threads') && method === 'POST') {
      if (threadsFail) return new Response('rate limited', { status: 429 });
      return new Response(JSON.stringify({ id: 'th_cont_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('graph.threads.net/v1.0/th_pub_99')) {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/api/v1/notifications')) {
      return new Response(
        JSON.stringify([
          {
            id: 'mn1',
            type: 'mention',
            created_at: '2026-11-18T11:00:00.000Z',
            account: { id: 'u2', acct: 'alice.bsky.social@bsky.brid.gy', display_name: 'Alice Bsky' },
            status: { id: 's2', content: '<p>Hello bridged world</p>', created_at: '2026-11-18T11:00:00.000Z', account: { id: 'u2', acct: 'alice.bsky.social@bsky.brid.gy' } },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.notification.listNotifications')) {
      return new Response(
        JSON.stringify({
          notifications: [
            {
              uri: 'at://did:plc:alice/app.bsky.feed.post/n1',
              cid: 'cn1',
              reason: 'mention',
              indexedAt: '2026-11-18T11:00:05.000Z',
              author: { did: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
              record: { text: 'Hello bridged world' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('graph.threads.net/v1.0/th_1/threads?fields=')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'tp1' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('graph.threads.net/v1.0/tp1/replies')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'tr1', username: 'carol', text: 'Threads reply', timestamp: '2026-11-18T12:00:00.000Z' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();

    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'alice', acct: 'alice@mastodon.social', userId: 'u1' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:alice', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:alice', handle: 'alice.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );
    await upsertSocialAccount(
      { id: 'threads:th_1', platform: 'threads', userId: 'th_1', handle: 'alice', acct: 'alice' },
      { accessToken: 't_tok' }
    );

    // 1. >300 char post auto-splits on Bluesky while succeeding once on Mastodon & Threads
    const longDraft = `${'mastodon '.repeat(42)}ending`;
    const pubRes = await publishUnified({ text: longDraft });
    assert.equal(pubRes.items.length, 1);
    assert.ok(pubRes.linkedIds.mastodonStatusId);
    assert.ok(pubRes.linkedIds.blueskyUri);
    assert.equal(pubRes.linkedIds.threadsPostId, 'th_pub_99');
    assert.equal(calls.filter((c) => c.url.includes('com.atproto.repo.createRecord')).length, 2);

    // 2. Synchronized delete hits Mastodon, Bluesky, and Threads in parallel
    calls.length = 0;
    const delRes = await deleteUnified(pubRes.items[0]);
    assert.equal(delRes.deleted, true);
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('/api/v1/statuses/')));
    assert.ok(calls.some((c) => c.url.includes('com.atproto.repo.deleteRecord')));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('th_pub_99')));

    // 3. Partial Threads failure queues retry without failing primary Mastodon publish
    threadsFail = true;
    const partialRes = await publishUnified({ text: 'Resilient fan-out test' });
    assert.equal(partialRes.items.length, 1);
    assert.equal(partialRes.warnings.length, 1);
    assert.equal(partialRes.retryQueue.length, 1);
    assert.equal(partialRes.retryQueue[0].protocol, 'threads');
    threadsFail = false;

    // 4. Protocol-routed reply
    calls.length = 0;
    const bskyReply = await replyUnified({
      targetItem: {
        id: 'bluesky:at://did:plc:bob/app.bsky.feed.post/xyz',
        protocol: 'bluesky',
        _meta: { bluesky: { uri: 'at://did:plc:bob/app.bsky.feed.post/xyz', cid: 'cid_bob' } },
      },
      text: 'Reply staying on ATProto',
    });
    assert.equal(bskyReply.protocol, 'bluesky');
    assert.equal(calls.filter((c) => c.url.includes('mastodon.social')).length, 0);

    // 5. Edit & Pin on Mastodon
    const edited = await editUnified(partialRes.items[0].id, 'Edited post');
    assert.equal(edited.content_text, 'Edited post');
    const pinned = await pinUnified(partialRes.items[0], false);
    assert.equal(pinned._meta.mastodon.pinned, true);

    // 6. Unified merged notifications deduplicate Bridgy mirror + include Threads reply
    const notifs = await fetchUnifiedNotifications();
    assert.equal(notifs.items.length, 2);
    assert.equal(notifs.items[0].protocol, 'threads');
    assert.equal(notifs.items[1].content_text, 'Hello bridged world');
  } finally {
    globalThis.fetch = prevFetch;
  }
});

test('Profile screen edits credentials and SettingsModal Moderation manages keyword filters', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ url: u, method, body: init.body });

    if (u.includes('/api/v1/accounts/verify_credentials')) {
      return new Response(
        JSON.stringify({
          id: 'u1',
          username: 'alice',
          acct: 'alice@mastodon.social',
          display_name: 'Alice',
          note: '<p>Don&#39;t you ever give up.</p>',
          url: 'https://mastodon.social/@alice',
          avatar: 'https://mastodon.social/a.png',
          header: 'https://mastodon.social/h.png',
          fields: [{ name: 'Institute coop', value: 'https://institute.coop/', verified_at: '2026-11-18T00:00:00Z' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/accounts/update_credentials') && method === 'PATCH') {
      return new Response(
        JSON.stringify({
          id: 'u1',
          username: 'alice',
          acct: 'alice@mastodon.social',
          display_name: 'Alice Updated',
          note: '<p>Updated bio</p>',
          url: 'https://mastodon.social/@alice',
          avatar: 'https://mastodon.social/a.png',
          header: 'https://mastodon.social/h.png',
          bot: true,
          indexable: false,
          hide_collections: true,
          source: {
            privacy: 'unlisted',
            sensitive: true,
            language: 'fr',
            attribution_domains: ['institute.coop'],
          },
          fields: [{ name: 'Site', value: 'https://example.org', verified_at: '2026-11-18T00:00:00Z' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/accounts/u1/statuses')) {
      return new Response(
        JSON.stringify([
          {
            id: 'p_own_1',
            content: '<p>My Mastodon Post</p>',
            created_at: '2026-11-18T10:00:00.000Z',
            account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice Updated' },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v2/filters') && method === 'POST') {
      return new Response(
        JSON.stringify({ id: 'flt_9', title: 'spoiler', context: ['home', 'public'], filter_action: 'hide', keywords: [{ keyword: 'spoiler' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v2/filters')) {
      return new Response(
        JSON.stringify([{ id: 'flt_1', title: 'noise', filter_action: 'hide', keywords: [{ keyword: 'noise' }] }]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    await upsertSocialAccount(
      {
        id: 'fediverse:alice@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'alice',
        acct: 'alice@mastodon.social',
        displayName: 'Alice',
        userId: 'u1',
      },
      { accessToken: 'tok_u1' }
    );

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const profCtrl = mountProfileScreen(host, {});
    await new Promise((r) => setTimeout(r, 30));

    assert.ok(host.textContent.includes('Alice'));
    assert.ok(host.textContent.includes("Don't you ever give up."));
    assert.equal(host.textContent.includes('&#39;'), false);
    const fieldLink = host.querySelector('.profile-links-row .profile-link-chip');
    assert.ok(fieldLink);
    assert.equal(fieldLink.getAttribute('href'), 'https://institute.coop/');
    assert.equal(fieldLink.getAttribute('target'), '_blank');
    assert.equal(fieldLink.getAttribute('rel'), 'noopener noreferrer');
    assert.ok(host.querySelector('.profile-verified-check'));
    assert.ok(host.textContent.includes('My Mastodon Post'));

    const editModal = openEditMastodonProfileModal({ accountMeta: authStore.get().accounts[0] });
    const editTabs = Array.from(editModal.dialog.querySelectorAll('[data-profile-edit-tab]')).map((b) => b.textContent);
    assert.deepEqual(editTabs, ['Profile & Media', 'Privacy & Posting']);
    assert.ok(editModal.dialog.querySelector('.profile-edit-banner-wrap'));
    assert.ok(editModal.dialog.querySelector('.profile-edit-avatar-preview'));

    const nameIn = editModal.dialog.querySelector('#edit-masto-display-name');
    nameIn.value = 'Alice Updated';
    const attrIn = editModal.dialog.querySelector('#edit-masto-attribution-domains');
    attrIn.value = 'institute.coop';
    const langSel = editModal.dialog.querySelector('#edit-masto-language');
    langSel.value = 'fr';
    const botChk = editModal.dialog.querySelector('#edit-masto-bot');
    botChk.checked = true;
    const hideCollChk = editModal.dialog.querySelector('#edit-masto-hide-collections');
    hideCollChk.checked = true;
    const sensChk = editModal.dialog.querySelector('#edit-masto-sensitive');
    sensChk.checked = true;

    editModal.dialog.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));

    const patchReq = requests.find((r) => r.method === 'PATCH' && r.url.includes('/api/v1/accounts/update_credentials'));
    assert.ok(patchReq);
    assert.equal(patchReq.body.get('bot'), 'true');
    assert.equal(patchReq.body.get('hide_collections'), 'true');
    assert.equal(patchReq.body.get('source[sensitive]'), 'true');
    assert.equal(patchReq.body.get('source[language]'), 'fr');
    assert.equal(patchReq.body.get('attribution_domains[]'), 'institute.coop');
    assert.equal(authStore.get().accounts[0].displayName, 'Alice Updated');
    assert.equal(authStore.get().accounts[0].bot, true);
    assert.equal(authStore.get().accounts[0].hideCollections, true);

    const settingsModal = openSettingsModal({ initialTab: 'moderation' });
    await new Promise((r) => setTimeout(r, 30));
    const phraseIn = settingsModal.dialog.querySelector('#moderation-filter-phrase');
    assert.ok(phraseIn);
    phraseIn.value = 'spoiler';
    phraseIn.parentNode.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(requests.some((r) => r.method === 'POST' && r.url.includes('/api/v2/filters')));

    settingsModal.close();
    profCtrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('AuthorSheetModal renders Bluesky profile, graph actions, and Recent Posts, and Search uses <progress> spinner', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const requests = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    requests.push({ url: u, method, body: init.body });

    if (u.includes('app.bsky.actor.getProfile')) {
      return new Response(
        JSON.stringify({
          did: 'did:plc:mikey',
          handle: 'mrmikeymonster.bsky.social',
          displayName: 'michael monster',
          avatar: 'https://cdn.bsky.app/a.png',
          banner: 'https://cdn.bsky.app/b.png',
          description: 'Creator of indie things',
          followersCount: 412,
          followsCount: 88,
          postsCount: 19,
          viewer: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.feed.getAuthorFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:mikey/app.bsky.feed.post/p1',
                cid: 'c1',
                record: { text: 'Latest Bluesky post from Mike', createdAt: '2026-11-18T11:00:00.000Z' },
                author: { did: 'did:plc:mikey', handle: 'mrmikeymonster.bsky.social', displayName: 'michael monster' },
                replyCount: 1,
                repostCount: 2,
                likeCount: 5,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('com.atproto.repo.createRecord')) {
      const payload = JSON.parse(String(init.body || '{}'));
      const rtype = payload.collection === 'app.bsky.graph.block' ? 'app.bsky.graph.block' : 'app.bsky.graph.follow';
      return new Response(
        JSON.stringify({ uri: `at://did:plc:self/${rtype}/rec1`, cid: 'c_rec1' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.graph.muteActor')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('app.bsky.actor.searchActors')) {
      await new Promise((r) => setTimeout(r, 25));
      return new Response(
        JSON.stringify({
          actors: [
            {
              did: 'did:plc:mikey',
              handle: 'mrmikeymonster.bsky.social',
              displayName: 'michael monster',
              avatar: 'https://cdn.bsky.app/a.png',
              viewer: {},
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.feed.searchPosts')) {
      return new Response(JSON.stringify({ posts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    return new Response(JSON.stringify({ accounts: [], statuses: [], hashtags: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:self',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        did: 'did:plc:self',
        handle: 'self.bsky.social',
        displayName: 'Self',
        userId: 'did:plc:self',
      },
      { accessJwt: 'jwt_self', refreshJwt: 'ref_self' }
    );

    const sheet = openAuthorSheetModal({
      author: {
        id: 'did:plc:mikey',
        name: 'michael monster',
        handle: 'mrmikeymonster.bsky.social',
        protocol: 'bluesky',
      },
    });
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(sheet.dialog.querySelector('.profile-hero-card'));
    assert.ok(sheet.dialog.querySelector('.author-recent-section'));
    assert.equal(sheet.dialog.querySelector('.profile-display-name').textContent, 'michael monster');
    assert.equal(sheet.dialog.querySelector('.profile-hero-names .post-author-handle').textContent, '@mrmikeymonster.bsky.social');
    const statsRow = sheet.dialog.querySelector('.profile-stats-row');
    assert.ok(statsRow.textContent.includes('19 Posts'));
    assert.ok(statsRow.textContent.includes('88 Following'));
    assert.ok(statsRow.textContent.includes('412 Followers'));
    assert.equal(statsRow.querySelectorAll('.profile-stat-btn').length, 2);
    assert.ok(sheet.dialog.textContent.includes('Creator of indie things'));
    assert.ok(sheet.dialog.textContent.includes('Latest Bluesky post from Mike'));

    const actionButtons = Array.from(sheet.dialog.querySelectorAll('.author-sheet-actions button'));
    assert.deepEqual(actionButtons.map((b) => b.textContent), ['Follow', 'Mute', 'Block']);

    actionButtons[0].dispatchEvent(new Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(sheet.dialog.querySelectorAll('.author-sheet-actions button')[0].textContent, 'Following');

    sheet.dialog.querySelectorAll('.author-sheet-actions button')[1].dispatchEvent(new Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(sheet.dialog.querySelectorAll('.author-sheet-actions button')[1].textContent, 'Unmute');
    assert.ok(sheet.dialog.textContent.includes('Muted'));

    sheet.dialog.querySelectorAll('.author-sheet-actions button')[2].dispatchEvent(new Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(sheet.dialog.querySelectorAll('.author-sheet-actions button')[2].textContent, 'Unblock');
    assert.ok(sheet.dialog.textContent.includes('Blocked'));
    sheet.close();

    const doc = dom.document;
    const searchHost = doc.createElement('div');
    doc.body.appendChild(searchHost);
    let pickedAuthor = null;
    const searchCtrl = mountSearchScreen(searchHost, {
      onSelectAuthor: (a) => {
        pickedAuthor = a;
      },
    });
    const searchIn = searchHost.querySelector('#global-search-input');
    searchIn.value = 'mikey';
    searchHost.querySelector('.search-bar-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const spinner = searchHost.querySelector('.loading-state-card progress.loading-spinner');
    assert.ok(spinner);
    assert.equal(spinner.getAttribute('value'), null);

    await new Promise((r) => setTimeout(r, 45));
    const acctBtn = searchHost.querySelector('.search-account-meta-btn');
    assert.ok(acctBtn);
    assert.ok(acctBtn.textContent.includes('Bluesky'));
    acctBtn.dispatchEvent(new Event('click', { bubbles: true }));
    assert.equal(pickedAuthor?.protocol, 'bluesky');
    assert.equal(pickedAuthor?.id, 'did:plc:mikey');
    searchCtrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('normalizeAccountRecord harmonizes snake_case backend accounts and Search renders truncated Mastodon rows', async () => {
  const emptyNameAcc = normalizeAccountRecord({
    id: '88',
    username: 'koalicja_las_jest_nasz',
    acct: 'koalicja_las_jest_nasz@mastodon.com.pl',
    display_name: '',
    avatar_url: 'https://mastodon.com.pl/av.png',
    followers_count: 14,
  });
  assert.equal(emptyNameAcc.displayName, 'koalicja_las_jest_nasz');
  assert.equal(emptyNameAcc.avatar, 'https://mastodon.com.pl/av.png');
  assert.equal(emptyNameAcc.followersCount, 14);

  const entityAcc = normalizeAccountRecord({
    id: '89',
    username: 'tylersaunders',
    acct: 'tylersaunders@fosstodon.org',
    display_name: 'Tyler &#39;Dev&#39; Saunders',
    avatar_url: 'https://fosstodon.org/t.png',
  });
  assert.equal(entityAcc.displayName, "Tyler 'Dev' Saunders");
  assert.equal(entityAcc.avatar, 'https://fosstodon.org/t.png');

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v2/search')) {
      return new Response(
        JSON.stringify({
          accounts: [
            {
              id: '88',
              username: 'koalicja_las_jest_nasz',
              acct: 'koalicja_las_jest_nasz@mastodon.com.pl',
              display_name: '',
              avatar: 'https://mastodon.com.pl/av.png',
            },
          ],
          statuses: [],
          hashtags: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/relationships')) {
      return new Response(JSON.stringify([{ id: '88', following: false }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ actors: [], posts: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    await upsertSocialAccount(
      {
        id: 'fediverse:alice@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'alice',
        acct: 'alice@mastodon.social',
        displayName: 'Alice',
        userId: 'u1',
      },
      { accessToken: 'tok_u1' }
    );

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const searchCtrl = mountSearchScreen(host, {});
    const searchIn = host.querySelector('#global-search-input');
    searchIn.value = 'koalicja';
    host.querySelector('.search-bar-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    await new Promise((r) => setTimeout(r, 35));
    const nameEl = host.querySelector('.search-account-name');
    const avatarEl = host.querySelector('.search-account-row .post-avatar');
    const followBtn = host.querySelector('.search-account-follow-btn');
    assert.ok(nameEl);
    assert.equal(nameEl.textContent, 'koalicja_las_jest_nasz');
    assert.equal(avatarEl.getAttribute('src'), 'https://mastodon.com.pl/av.png');
    assert.ok(followBtn);
    assert.equal(followBtn.textContent, 'Follow');
    searchCtrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('2-tab Profile Editor syncs links/bio to Bluesky, renders compact link chips, and opens interactive Following/Followers manager', async () => {
  assert.equal(cleanMastodonMediaUrl('https://mastodon.social/avatars/original/missing.png'), '');
  assert.equal(cleanMastodonMediaUrl('https://mastodon.social/media/avatar.png'), 'https://mastodon.social/media/avatar.png');

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const bskyCalls = [];
  let removedFollowerId = '';
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/v1/accounts/update_credentials')) {
      return new Response(
        JSON.stringify({
          id: 'u1',
          username: 'davy',
          acct: 'davy',
          display_name: 'Davy Updated',
          note: '<p>Building open bridges</p>',
          avatar: 'https://mastodon.social/avatars/original/missing.png',
          header: 'https://mastodon.social/headers/original/missing.png',
          fields: [
            { name: 'Institute coop', value: '<a href="https://institute.coop/">institute.coop</a>', verified_at: '2026-11-19T00:00:00Z' },
          ],
          followers_count: 12,
          following_count: 4,
          statuses_count: 3,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/com.atproto.repo.getRecord')) {
      return new Response(JSON.stringify({ value: { $type: 'app.bsky.actor.profile', displayName: 'Old' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/xrpc/com.atproto.repo.listRecords')) {
      return new Response(
        JSON.stringify({
          records: [
            {
              uri: 'at://did:plc:davy/app.bsky.actor.link/old1',
              cid: 'cid_old',
              value: { $type: 'app.bsky.actor.link', url: 'https://stale.example/', title: 'Stale' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/com.atproto.repo.createRecord')) {
      bskyCalls.push(['createRecord', JSON.parse(init.body)]);
      return new Response(
        JSON.stringify({ uri: 'at://did:plc:davy/app.bsky.actor.link/new1', cid: 'cid_new1' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/com.atproto.repo.deleteRecord')) {
      bskyCalls.push(['deleteRecord', JSON.parse(init.body)]);
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/xrpc/com.atproto.repo.putRecord')) {
      bskyCalls.push(['putRecord', JSON.parse(init.body)]);
      return new Response(JSON.stringify({ uri: 'at://did:plc:davy/app.bsky.actor.profile/self' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/xrpc/app.bsky.graph.getFollows')) {
      return new Response(JSON.stringify({ follows: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/xrpc/app.bsky.graph.getFollowers')) {
      return new Response(JSON.stringify({ followers: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/xrpc/app.bsky.actor.getProfile')) {
      return new Response(
        JSON.stringify({
          did: 'did:plc:davy',
          handle: 'davy.bsky.social',
          displayName: 'Davy Updated',
          description: 'Building open bridges',
          links: [{ uri: 'at://did:plc:davy/app.bsky.actor.link/new1', cid: 'cid_new1', url: 'https://institute.coop/', title: 'Institute coop' }],
          followersCount: 5,
          followsCount: 2,
          postsCount: 9,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/u1/following')) {
      return new Response(
        JSON.stringify([{ id: 'p1', username: 'peer', acct: 'peer@mastodon.social', display_name: 'Peer Dev' }]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/u1/followers')) {
      return new Response(
        JSON.stringify([{ id: 'f1', username: 'fan', acct: 'fan@mastodon.social', display_name: 'Fan User' }]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/relationships')) {
      return new Response(JSON.stringify([{ id: 'p1', following: true, followed_by: true }, { id: 'f1', following: false }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/v1/follow_requests')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/accounts/f1/remove_from_followers')) {
      removedFollowerId = 'f1';
      return new Response(JSON.stringify({ id: 'f1', followed_by: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    const doc = dom.document;

    // 1. Compact link chip renderer hides raw https:// URL behind label while keeping href and checkmark
    const chipsHost = doc.createElement('div');
    renderProfileLinksAndFields(chipsHost, [
      { name: 'Institute coop', value: 'https://institute.coop/', verified_at: '2026-11-19T00:00:00Z' },
      { name: 'Pronouns', value: 'they/them' },
    ]);
    const chipAnchor = chipsHost.querySelector('.profile-link-chip');
    assert.ok(chipAnchor);
    assert.equal(chipAnchor.getAttribute('href'), 'https://institute.coop/');
    assert.equal(chipAnchor.querySelector('.profile-link-chip-label').textContent, 'Institute coop');
    assert.ok(chipAnchor.querySelector('.profile-verified-check'));
    assert.equal(chipAnchor.textContent.includes('https://'), false);
    assert.ok(chipsHost.querySelector('.profile-meta-chip'));

    // 2. Connect both Mastodon & Bluesky, then submit 2-tab Profile Studio modal
    const mastoMeta = await upsertSocialAccount(
      {
        id: 'fediverse:davy@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davy',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
        fields: [{ name: 'Institute coop', value: 'https://institute.coop/' }],
        followersCount: 12,
        followingCount: 4,
        statusesCount: 3,
        userId: 'u1',
      },
      { accessToken: 'tok_u1' }
    );
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:davy',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'davy.bsky.social',
        acct: 'davy.bsky.social',
        did: 'did:plc:davy',
      },
      { accessJwt: 'bsky_jwt', refreshJwt: 'bsky_ref' }
    );

    const editModal = openEditMastodonProfileModal({ accountMeta: mastoMeta });
    const tabs = [...editModal.dialog.querySelectorAll('[data-profile-edit-tab]')];
    assert.equal(tabs.length, 2);
    assert.ok(editModal.dialog.querySelector('details.profile-advanced-disclosure'));

    editModal.dialog.querySelector('#edit-masto-display-name').value = 'Davy Updated';
    editModal.dialog.querySelector('#edit-masto-note').value = 'Building open bridges';
    editModal.dialog.querySelector('.profile-edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(bskyCalls.some(([kind, body]) => kind === 'createRecord' && body.collection === 'app.bsky.actor.link' && body.record?.url === 'https://institute.coop/'), true);
    assert.equal(bskyCalls.some(([kind]) => kind === 'deleteRecord'), true);
    const putCall = bskyCalls.find(([kind]) => kind === 'putRecord');
    assert.ok(putCall);
    assert.equal(putCall[1].record.links[0].cid, 'cid_new1');
    assert.equal(putCall[1].record.displayName, 'Davy Updated');

    // 3. Interactive Following/Followers modal & remove follower
    const graphModal = openFollowGraphModal({
      accountId: 'u1',
      acct: 'davy@mastodon.social',
      displayName: 'Davy',
      instanceUrl: 'https://mastodon.social',
      protocol: 'mastodon',
      initialTab: 'following',
      isOwnProfile: true,
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(graphModal.dialog.querySelectorAll('.follow-graph-net-btn').length, 0);
    assert.ok(graphModal.dialog.querySelector('.modal-tab-btn[aria-selected="true"]'));
    assert.equal(graphModal.dialog.querySelector('.search-account-name').textContent, 'Peer Dev');
    assert.ok(graphModal.dialog.querySelector('.follow-mutual-pill'));

    const followerPage = await fetchFollowConnections('u1', { kind: 'followers', instanceUrl: 'https://mastodon.social' });
    assert.equal(followerPage.accounts[0].acct, 'fan@mastodon.social');
    await removeFollowerAccount('f1');
    assert.equal(removedFollowerId, 'f1');
    graphModal.close();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Bluesky author data falls back to native XRPC when desktop host lacks Bluesky profile route and upgrades Bridgy handles', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevForceHttp = globalThis.__SANCTUARY_FORCE_HTTP_STORE__;
  const prevLoc = globalThis.location;
  globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = true;
  globalThis.location = { origin: 'http://127.0.0.1:5000', protocol: 'http:', hostname: '127.0.0.1', port: '5000' };

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('http://127.0.0.1:5000/api/social/storage/kv')) {
      return new Response(JSON.stringify({ found: false, value: null }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('http://127.0.0.1:5000/api/social/storage/secret')) {
      return new Response(JSON.stringify({ secret: { accessJwt: 'b_jwt', refreshJwt: 'b_ref' } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('http://127.0.0.1:5000/api/social/accounts/did%3Aplc%3Arural/profile')) {
      return new Response(
        JSON.stringify({ error: 'Mastodon API 404 (/api/v1/accounts/did:plc:rural): Record not found' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('http://127.0.0.1:5000/api/social/accounts/did%3Aplc%3Arural/statuses')) {
      return new Response(
        JSON.stringify({ error: 'Mastodon API 404 (/api/v1/accounts/did:plc:rural/statuses)' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/app.bsky.graph.getFollows')) {
      return new Response(JSON.stringify({ follows: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/xrpc/app.bsky.graph.getFollowers')) {
      return new Response(JSON.stringify({ followers: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/xrpc/app.bsky.actor.getProfile')) {
      return new Response(
        JSON.stringify({
          did: 'did:plc:rural',
          handle: 'ruralanarchy.bsky.social',
          displayName: 'Rural Anarchy',
          description: 'Birds and mutual aid.',
          followersCount: 10998,
          followsCount: 6548,
          postsCount: 16872,
          viewer: {},
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/app.bsky.feed.getAuthorFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:rural/app.bsky.feed.post/p1',
                cid: 'cid1',
                author: { did: 'did:plc:rural', handle: 'ruralanarchy.bsky.social', displayName: 'Rural Anarchy' },
                record: { text: 'Morning bird watch', createdAt: '2026-11-19T00:00:00Z' },
                replyCount: 1,
                repostCount: 2,
                likeCount: 5,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:davy',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'davy.bsky.social',
        acct: 'davy.bsky.social',
        did: 'did:plc:davy',
      },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    const detail = await fetchAuthorWithRelationship('did:plc:rural', 'https://mastodon.social', {
      protocol: 'bluesky',
      acct: 'ruralanarchy.bsky.social',
    });
    assert.equal(detail.profile.displayName, 'Rural Anarchy');
    assert.equal(detail.profile.followersCount, 10998);
    assert.equal(detail.profile.statusesCount, 16872);

    const posts = await fetchOwnStatuses('did:plc:rural', { protocol: 'bluesky', acct: 'ruralanarchy.bsky.social' });
    assert.equal(posts.length, 1);
    assert.equal(posts[0].content_text, 'Morning bird watch');

    // Bridgy Fed @bsky.brid.gy author opens native Bluesky lookup cleanly
    globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = false;
    const sheet = openAuthorSheetModal({
      author: { id: 'masto_bridged_99', handle: 'ruralanarchy.bsky.social@bsky.brid.gy', name: 'Rural Anarchy' },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(sheet.dialog.textContent.includes('10,998 Followers'));
    assert.ok(sheet.dialog.textContent.includes('Morning bird watch'));
    sheet.close();
  } finally {
    globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = prevForceHttp;
    globalThis.location = prevLoc;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Centralized Connections modal merges Mastodon & Bluesky with Bridgy dedupe, falls back to public.api.bsky.app on 401, and Own Profile sums counts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevForceHttp = globalThis.__SANCTUARY_FORCE_HTTP_STORE__;
  const prevLoc = globalThis.location;
  globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = false;
  globalThis.location = { origin: 'http://127.0.0.1:5000', protocol: 'http:', hostname: '127.0.0.1', port: '5000' };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const hdrs = init?.headers || {};
    const hasAuthHeader = Boolean(hdrs.Authorization || hdrs.authorization);
    if (u.includes('/api/v1/accounts/verify_credentials')) {
      return new Response(
        JSON.stringify({
          id: 'u_masto',
          username: 'davy',
          acct: 'davy',
          display_name: 'Davy Rhodes',
          followers_count: 2,
          following_count: 3,
          statuses_count: 5,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/u_masto/statuses')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/accounts/u_masto/following')) {
      return new Response(
        JSON.stringify([
          { id: 'm1', acct: 'peer@mastodon.social', username: 'peer', display_name: 'Mastodon Peer', avatar: '' },
          { id: 'm_bridged', acct: 'camleone.bsky.social@bsky.brid.gy', username: 'cam', display_name: 'Cam Mirror', avatar: '' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/u_masto/followers')) {
      return new Response(
        JSON.stringify([
          { id: 'm_fan', acct: 'fan@mastodon.social', username: 'fan', display_name: 'Masto Fan', avatar: '' },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/relationships')) {
      return new Response(
        JSON.stringify([
          { id: 'm1', following: true, followed_by: false },
          { id: 'm_bridged', following: true, followed_by: false },
          { id: 'm_fan', following: false, followed_by: true },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/follow_requests')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.startsWith('https://bsky.social/xrpc/')) {
      return new Response(
        JSON.stringify({ error: 'AuthMissing', message: 'Authentication Required' }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://public.api.bsky.app/xrpc/')) {
      assert.equal(hasAuthHeader, false);
      if (u.includes('app.bsky.actor.getProfile')) {
        return new Response(
          JSON.stringify({
            did: 'did:plc:davy',
            handle: 'davy.bsky.social',
            displayName: 'Davy Rhodes',
            description: 'Local builder',
            followersCount: 12,
            followsCount: 1,
            postsCount: 9,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('app.bsky.graph.getFollows')) {
        return new Response(
          JSON.stringify({
            follows: [
              { did: 'did:plc:cam', handle: 'camleone.bsky.social', displayName: 'Cam Native', avatar: '' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('app.bsky.graph.getFollowers')) {
        return new Response(
          JSON.stringify({
            followers: [
              { did: 'did:plc:cam', handle: 'camleone.bsky.social', displayName: 'Cam Native', avatar: '' },
              { did: 'did:plc:b2', handle: 'friend2.bsky.social', displayName: 'Bsky Fan', avatar: '' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  let profileCtrl = null;
  let graphModal = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    await upsertSocialAccount(
      {
        id: 'fediverse:davy@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davy',
        acct: 'davy@mastodon.social',
        displayName: 'Davy Rhodes',
        userId: 'u_masto',
        followersCount: 1,
        followingCount: 1,
        statusesCount: 5,
      },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:davy',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'davy.bsky.social',
        acct: 'davy.bsky.social',
        displayName: 'Davy Rhodes',
        did: 'did:plc:davy',
        followersCount: 0,
        followingCount: 0,
        statusesCount: 0,
      },
      { accessJwt: 'stale_jwt', refreshJwt: '' }
    );

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    profileCtrl = mountProfileScreen(host, {});
    await new Promise((r) => setTimeout(r, 60));

    const statTexts = Array.from(host.querySelectorAll('.profile-stat-btn')).map((b) => b.textContent);
    assert.deepEqual(statTexts, ['4 Following', '14 Followers']);
    assert.equal(host.textContent.includes('Bridge Active'), false);

    const userModal = openUserModal();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(userModal.dialog.textContent.includes('Auto-Active'), false);
    assert.equal(userModal.dialog.textContent.includes('Auto-Bridge'), false);
    assert.equal(userModal.dialog.textContent.includes('Bluesky · Connected'), true);
    assert.equal(userModal.dialog.querySelectorAll('.status-badge.status-online').length, 2);
    userModal.close();

    graphModal = openFollowGraphModal({
      accountId: 'u_masto',
      acct: 'davy@mastodon.social',
      displayName: 'Davy Rhodes',
      instanceUrl: 'https://mastodon.social',
      protocol: 'mastodon',
      initialTab: 'followers',
      isOwnProfile: true,
    });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(graphModal.dialog.querySelector('#follow-graph-title').textContent, 'Connections');
    assert.equal(graphModal.dialog.querySelectorAll('.follow-graph-net-btn').length, 0);
    const tabList = graphModal.dialog.querySelector('[role="tablist"]');
    assert.equal(tabList.getAttribute('focusgroup'), 'tablist nomemory');
    assert.equal(graphModal.dialog.querySelector('#follow-graph-tab-followers').getAttribute('aria-selected'), 'true');
    assert.equal(graphModal.dialog.querySelector('#follow-graph-tab-following').getAttribute('aria-selected'), 'false');

    const followerNames = Array.from(graphModal.dialog.querySelectorAll('.search-account-name')).map((el) => el.textContent);
    assert.deepEqual(followerNames, ['Masto Fan', 'Cam Native', 'Bsky Fan']);
    const followerBadges = Array.from(graphModal.dialog.querySelectorAll('.follow-graph-proto-pill')).map((el) => el.textContent);
    assert.deepEqual(followerBadges, ['Fediverse', 'Bluesky', 'Bluesky']);

    graphModal.dialog.querySelector('#follow-graph-tab-following').click();
    await new Promise((r) => setTimeout(r, 60));

    const followingNames = Array.from(graphModal.dialog.querySelectorAll('.search-account-name')).map((el) => el.textContent);
    assert.deepEqual(followingNames, ['Mastodon Peer', 'Cam Native']);
    const followingBtns = Array.from(graphModal.dialog.querySelectorAll('.search-account-follow-btn')).map((el) => el.textContent);
    assert.deepEqual(followingBtns, ['Following', 'Following']);
  } finally {
    graphModal?.close();
    profileCtrl?.destroy();
    globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = prevForceHttp;
    globalThis.location = prevLoc;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('renderPostThreadView loads Bluesky replies with public fallback, preserves nested reply root refs, and supports inline replies', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevForceHttp = globalThis.__SANCTUARY_FORCE_HTTP_STORE__;
  const prevLoc = globalThis.location;
  globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = false;
  globalThis.location = { origin: 'http://127.0.0.1:5000', protocol: 'http:', hostname: '127.0.0.1', port: '5000' };

  const createdRecords = [];
  let inlineReplied = false;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://bsky.social/xrpc/app.bsky.feed.getPostThread')) {
      return new Response(
        JSON.stringify({ error: 'AuthMissing', message: 'Authentication Required' }),
        { status: 401, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://public.api.bsky.app/xrpc/app.bsky.feed.getPostThread')) {
      const hdrs = init?.headers || {};
      assert.equal(Boolean(hdrs.Authorization || hdrs.authorization), false);
      const replies = [
        {
          post: {
            uri: 'at://did:plc:alice/app.bsky.feed.post/r1',
            cid: 'cid_r1',
            author: { did: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
            record: {
              text: 'First reply to Yaroslava',
              createdAt: '2026-11-19T01:10:00Z',
              reply: {
                root: { uri: 'at://did:plc:root/app.bsky.feed.post/root1', cid: 'cid_root1' },
                parent: { uri: 'at://did:plc:yaro/app.bsky.feed.post/focal1', cid: 'cid_focal1' },
              },
            },
            replyCount: 1,
            likeCount: 3,
          },
          replies: [
            {
              post: {
                uri: 'at://did:plc:bob/app.bsky.feed.post/r2',
                cid: 'cid_r2',
                author: { did: 'did:plc:bob', handle: 'bob.bsky.social', displayName: 'Bob' },
                record: {
                  text: 'Nested reply to Alice',
                  createdAt: '2026-11-19T01:12:00Z',
                  reply: {
                    root: { uri: 'at://did:plc:root/app.bsky.feed.post/root1', cid: 'cid_root1' },
                    parent: { uri: 'at://did:plc:alice/app.bsky.feed.post/r1', cid: 'cid_r1' },
                  },
                },
                replyCount: 0,
                likeCount: 1,
              },
              replies: [],
            },
          ],
        },
      ];
      if (inlineReplied) {
        replies.push({
          post: {
            uri: 'at://did:plc:me/app.bsky.feed.post/r_inline',
            cid: 'cid_inline',
            author: { did: 'did:plc:me', handle: 'me.bsky.social', displayName: 'Me' },
            record: { text: 'Inline reply from thread view', createdAt: '2026-11-19T01:20:00Z' },
            replyCount: 0,
          },
          replies: [],
        });
      }
      return new Response(
        JSON.stringify({
          thread: {
            post: {
              uri: 'at://did:plc:yaro/app.bsky.feed.post/focal1',
              cid: 'cid_focal1',
              author: { did: 'did:plc:yaro', handle: 'strategywoman.bsky.social', displayName: 'Yaroslava' },
              record: {
                text: 'Morning in Kyiv.',
                createdAt: '2026-11-19T01:05:00Z',
                reply: {
                  root: { uri: 'at://did:plc:root/app.bsky.feed.post/root1', cid: 'cid_root1' },
                  parent: { uri: 'at://did:plc:root/app.bsky.feed.post/root1', cid: 'cid_root1' },
                },
              },
              replyCount: 2,
              likeCount: 152,
            },
            parent: {
              post: {
                uri: 'at://did:plc:root/app.bsky.feed.post/root1',
                cid: 'cid_root1',
                author: { did: 'did:plc:root', handle: 'root.bsky.social', displayName: 'Root Author' },
                record: { text: 'Original thread starter', createdAt: '2026-11-19T01:00:00Z' },
              },
            },
            replies,
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/com.atproto.repo.createRecord')) {
      const parsed = JSON.parse(init.body || '{}');
      createdRecords.push(parsed);
      return new Response(
        JSON.stringify({
          uri: `at://did:plc:me/app.bsky.feed.post/new_${createdRecords.length}`,
          cid: `cid_new_${createdRecords.length}`,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  let threadCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetCompose();
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:me',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'me.bsky.social',
        acct: 'me.bsky.social',
        displayName: 'Me',
        did: 'did:plc:me',
      },
      { accessJwt: 'stale_jwt', refreshJwt: '' }
    );

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    threadCtrl = renderPostThreadView(host, {
      post: {
        id: 'bluesky:at://did:plc:yaro/app.bsky.feed.post/focal1',
        protocol: 'bluesky',
        content_text: 'Morning in Kyiv.',
        author: { id: 'did:plc:yaro', name: 'Yaroslava', handle: 'strategywoman.bsky.social' },
        _meta: { bluesky: { uri: 'at://did:plc:yaro/app.bsky.feed.post/focal1', cid: 'cid_focal1' } },
      },
    });

    await new Promise((r) => setTimeout(r, 60));

    assert.ok(host.querySelector('.thread-ancestors .post-card'));
    assert.ok(host.textContent.includes('Original thread starter'));
    assert.equal(host.querySelector('.thread-replies-heading').textContent, 'Replies (2)');

    const nestedCard = host.querySelector('.thread-reply-item[data-depth="1"] .post-card');
    assert.ok(nestedCard);
    assert.ok(nestedCard.textContent.includes('Nested reply to Alice'));

    // Clicking Reply on a nested reply prefills composeStore and preserves thread root URI/CID
    const nestedReplyBtn = nestedCard.querySelector('button[title="Reply"]');
    assert.ok(nestedReplyBtn);
    nestedReplyBtn.click();
    const cs = composeStore.get();
    assert.equal(cs.isOpen, true);
    assert.equal(cs.text, '@bob.bsky.social ');
    assert.equal(cs.replyTo.id, 'bluesky:at://did:plc:bob/app.bsky.feed.post/r2');

    await publishOrganicPost({ text: 'Replying to Bob inside thread', replyTo: cs.replyTo });
    assert.equal(createdRecords.length, 1);
    assert.deepEqual(createdRecords[0].record.reply, {
      root: { uri: 'at://did:plc:root/app.bsky.feed.post/root1', cid: 'cid_root1' },
      parent: { uri: 'at://did:plc:bob/app.bsky.feed.post/r2', cid: 'cid_r2' },
    });

    // Submitting inline reply form sends reply to focal post and renders immediately
    resetCompose();
    const inlineIn = host.querySelector('.thread-inline-reply-form .inline-compose-input');
    inlineIn.value = 'Inline reply from thread view';
    inlineReplied = true;
    host.querySelector('.thread-inline-reply-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(createdRecords.length, 2);
    assert.deepEqual(createdRecords[1].record.reply, {
      root: { uri: 'at://did:plc:root/app.bsky.feed.post/root1', cid: 'cid_root1' },
      parent: { uri: 'at://did:plc:yaro/app.bsky.feed.post/focal1', cid: 'cid_focal1' },
    });
    assert.ok(host.querySelector('.thread-descendants').textContent.includes('Inline reply from thread view'));
  } finally {
    threadCtrl?.destroy();
    resetCompose();
    globalThis.__SANCTUARY_FORCE_HTTP_STORE__ = prevForceHttp;
    globalThis.location = prevLoc;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});
