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
  addKeywordFilter,
  deleteUnified,
  editUnified,
  enrichUnifiedItemsMetrics,
  fetchAuthorWithRelationship,
  fetchFollowConnections,
  fetchModerationAccounts,
  fetchOwnStatuses,
  fetchUnifiedNotifications,
  normalizeAccountRecord,
  pinUnified,
  publishUnified,
  removeFollowerAccount,
  removeModeratedAccount,
  replyUnified,
} from '../web/queries/socialClient.js';
import { cleanMastodonMediaUrl, renderProfileLinksAndFields } from '../web/queries/fediverse.js';
import { createAppShell } from '../web/app/_layout.js';
import { mountComposeModal, publishOrganicPost } from '../web/app/composeModal.js';
import { mountFeedScreen } from '../web/app/feed.js';
import { renderPostThreadView } from '../web/app/postThread.js';
import { mountProfileScreen, openEditMastodonProfileModal, openEditPostDialog } from '../web/app/profile.js';
import { composeStore, resetCompose } from '../web/state/composeStore.js';
import { mountSearchScreen } from '../web/app/search.js';
import { openAuthorSheetModal } from '../web/components/AuthorSheetModal.js';
import { createPostCard } from '../web/components/PostCard.js';
import { openFeedTuningModal } from '../web/components/FeedTuningModal.js';
import { openFollowGraphModal } from '../web/components/FollowGraphModal.js';
import { openThreadsImportModal } from '../web/components/ThreadsImportModal.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { openUserModal } from '../web/components/sanctuary/UserModal.js';
import { FEED_TUNING_PRESETS, isDefaultFeedTuning, rankFeedItems } from '../web/core/feedRanker.js';
import { clearLinkPreviewCacheForTests, extractFirstHttpsUrl, parseVideoEmbedInfo } from '../web/queries/linkPreview.js';
import { cleanThreadsAuthCode, clearThreadsInsightsCacheForTests, publishThreadsPost } from '../web/queries/threads.js';
import {
  buildMastodonImportCsv,
  clearThreadsImportStateForTests,
  decodeMetaMojibake,
  parseThreadsArchiveBuffer,
  startThreadsArchiveSync,
} from '../web/queries/threadsArchive.js';
import { refreshActivityNotifications, resetActivityStoreForTests } from '../web/state/activityStore.js';
import { authStore, resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import {
  appendStreamItems,
  feedStore,
  hydrateCachedModeration,
  recordAuthorInteraction,
  resetFeedStoreForTests,
  setStreamItems,
  updateFeedTuning,
} from '../web/state/feedStore.js';
import {
  resetMemoryStorageForTests,
  findLocalLinkedPostGroup,
  saveLocalLinkedPost,
  saveLocalModeratedAccounts,
} from '../web/storage/nativeStore.js';
import { deleteThreadsPost } from '../web/queries/threads.js';
import { updateBskyNotificationsSeen } from '../web/queries/bluesky.js';
import { ThreadsAdapter } from '../web/adapters/threads/index.js';

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

    if (u.includes('graph.threads.net/v1.0/th_pub_99/replies')) {
      return new Response(
        JSON.stringify({
          data: [{ id: 'tr1', username: 'carol', text: 'Threads reply', timestamp: '2026-11-18T12:00:00.000Z' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
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
          data: [{ id: 'tr_unlinked', username: 'stranger', text: 'Unlinked Threads reply', timestamp: '2026-11-18T12:05:00.000Z' }],
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

    // 6. Publish a live cross-post so th_pub_99 is tracked in linked_posts, then verify notifications are scoped
    await publishUnified({ text: 'Tracked unified post' });
    calls.length = 0;
    const notifs = await fetchUnifiedNotifications();
    assert.equal(notifs.items.length, 2);
    assert.equal(notifs.items[0].protocol, 'threads');
    assert.equal(notifs.items[0].content_text, 'Threads reply');
    assert.equal(notifs.items[1].content_text, 'Hello bridged world');
    assert.equal(calls.some((c) => c.url.includes('th_1/threads?fields=')), false);
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

    if (u.includes('/api/v1/mutes')) {
      return new Response(
        JSON.stringify([{ id: 'm1', username: 'noisy', acct: 'noisy@mastodon.social', display_name: 'Noisy Masto' }]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/blocks')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('app.bsky.graph.getMutes')) {
      return new Response(
        JSON.stringify({
          mutes: [{ did: 'did:plc:muted1', handle: 'muted.bsky.social', displayName: 'Muted Sky' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.graph.getBlocks')) {
      return new Response(
        JSON.stringify({
          blocks: [{
            did: 'did:plc:blk1',
            handle: 'blocked.bsky.social',
            displayName: 'Blocked Sky',
            viewer: { blocking: 'at://did:plc:me/app.bsky.graph.block/blk123' },
          }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('com.atproto.repo.deleteRecord') && method === 'POST') {
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/api/v2/filters/') && method === 'DELETE') {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }

    if (u.includes('/api/v2/filters') && method === 'POST') {
      return new Response(
        JSON.stringify({ id: 'flt_9', title: 'spoiler', context: ['home', 'public'], filter_action: 'hide', keywords: [{ keyword: 'spoiler' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v2/filters')) {
      return new Response(
        JSON.stringify([
          { id: 'flt_1', title: 'noise', filter_action: 'hide', keywords: [{ keyword: 'noise' }] },
          { id: 'flt_2', title: 'politics', filter_action: 'warn', keywords: [{ keyword: 'politics' }] },
        ]),
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
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:me',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'alice.bsky.social',
        acct: 'alice.bsky.social',
        displayName: 'Alice Sky',
        did: 'did:plc:me',
      },
      { accessJwt: 'bsky_jwt', refreshJwt: 'bsky_ref' }
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
    await new Promise((r) => setTimeout(r, 40));

    const filterChips = settingsModal.dialog.querySelectorAll('.moderation-filter-chip');
    assert.equal(filterChips.length, 2);
    assert.equal(settingsModal.dialog.querySelector('.moderation-filter-chips .list-entry-row'), null);
    assert.equal(filterChips[0].querySelector('.moderation-filter-chip-label')?.textContent, 'noise');
    assert.equal(filterChips[0].querySelector('.moderation-filter-chip-mode'), null);
    assert.equal(filterChips[1].querySelector('.moderation-filter-chip-mode')?.textContent, 'warn');

    const modRows = settingsModal.dialog.querySelectorAll('.moderation-account-row');
    assert.equal(modRows.length, 3);
    assert.ok(settingsModal.dialog.textContent.includes('Muted Accounts (2)'));
    assert.ok(settingsModal.dialog.textContent.includes('Blocked Accounts (1)'));
    assert.ok(settingsModal.dialog.textContent.includes('Noisy Masto'));
    assert.ok(settingsModal.dialog.textContent.includes('Muted Sky'));
    assert.ok(settingsModal.dialog.textContent.includes('Blocked Sky'));

    const unblockBtn = Array.from(modRows[2].querySelectorAll('button')).find((b) => b.textContent === 'Unblock');
    assert.ok(unblockBtn);
    unblockBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    const deleteBlockReq = requests.find((r) => r.method === 'POST' && r.url.includes('com.atproto.repo.deleteRecord'));
    assert.ok(deleteBlockReq);
    assert.equal(JSON.parse(deleteBlockReq.body).rkey, 'blk123');

    const phraseIn = settingsModal.dialog.querySelector('#moderation-filter-phrase');
    assert.ok(phraseIn);
    phraseIn.value = 'spoiler';
    phraseIn.parentNode.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(requests.some((r) => r.method === 'POST' && r.url.includes('/api/v2/filters')));

    settingsModal.dialog.querySelector('.moderation-filter-chip-remove').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(requests.some((r) => r.method === 'DELETE' && r.url.includes('/api/v2/filters/flt_1')));

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

test('Threads OAuth 2.0 wizard exchanges 60-day token, Setup Guide opens cleanly, DM skips bridges, and Threads conversation loads', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevOpen = globalThis.open;
  const openedUrls = [];
  const fetchCalls = [];
  globalThis.open = (u) => {
    openedUrls.push(String(u));
    return {};
  };

  let replyPublished = false;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    const bodyText = init.body?.toString?.() || '';
    fetchCalls.push({ url: u, method, body: bodyText });

    if (u === 'https://graph.threads.net/oauth/access_token' && method === 'POST') {
      assert.ok(bodyText.includes('code=AQ_TEST_CODE'));
      assert.ok(!bodyText.includes('%23_'));
      return new Response(
        JSON.stringify({ access_token: 'short_1h_tok', user_id: 'th_77' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://graph.threads.net/access_token') && u.includes('grant_type=th_exchange_token')) {
      return new Response(
        JSON.stringify({ access_token: 'long_60d_tok', token_type: 'bearer', expires_in: 5184000 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://graph.threads.net/v1.0/me?fields=')) {
      assert.ok(u.includes('threads_biography'));
      assert.ok(u.includes('access_token=long_60d_tok'));
      return new Response(
        JSON.stringify({
          id: 'th_77',
          username: 'davy_threads',
          name: 'Davy Threads',
          threads_profile_picture_url: 'https://threads.net/davy.png',
          threads_biography: 'Building open tools',
          is_verified: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/statuses') && method === 'POST') {
      return new Response(
        JSON.stringify({
          id: 'm_dm_1',
          content: '<p>Private note</p>',
          created_at: new Date().toISOString(),
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social' },
          media_attachments: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://graph.threads.net/v1.0/th_p1?fields=')) {
      return new Response(
        JSON.stringify({
          id: 'th_p1',
          username: 'davy_threads',
          text: 'Carousel update',
          timestamp: '2026-11-19T02:00:00Z',
          link_attachment_url: 'https://example.org/docs',
          children: {
            data: [
              { id: 'c1', media_type: 'IMAGE', media_url: 'https://cdn.example.org/1.jpg', alt_text: 'Slide 1' },
              { id: 'c2', media_type: 'VIDEO', media_url: 'https://cdn.example.org/2.mp4', thumbnail_url: 'https://cdn.example.org/2t.jpg' },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://graph.threads.net/v1.0/th_p1/conversation')) {
      const replies = [
        { id: 'tr_1', username: 'carol', text: 'Great launch!', timestamp: '2026-11-19T02:05:00Z', replied_to: { id: 'th_p1' } },
        { id: 'tr_2', username: 'erin', text: 'Nested reply', timestamp: '2026-11-19T02:06:00Z', replied_to: { id: 'tr_1' } },
      ];
      if (replyPublished) {
        replies.push({ id: 'tr_3', username: 'davy_threads', text: 'Thanks Carol!', timestamp: '2026-11-19T02:07:00Z', replied_to: { id: 'th_p1' } });
      }
      return new Response(JSON.stringify({ data: replies }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/v1.0/th_77/threads') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'th_cont_reply' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('/v1.0/th_77/threads_publish') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'tr_3' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  let threadCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetCompose();

    assert.equal(cleanThreadsAuthCode('https://localhost/?code=AQ_TEST_CODE#_'), 'AQ_TEST_CODE');

    // Open Accounts & Bridges -> UserModal stays free of <details> and opens streamlined Setup & OAuth dialog
    openUserModal({ initialTab: 'accounts' });
    const userDialog = dom.document.getElementById('user-accounts-dialog');
    assert.ok(userDialog);
    assert.equal(userDialog.querySelector('details'), null);
    assert.ok(userDialog.querySelector('.threads-card-footer'));

    const setupTrigger = userDialog.querySelector('.threads-setup-trigger-btn');
    assert.ok(setupTrigger);
    setupTrigger.click();

    const setupDialog = dom.document.getElementById('threads-setup-dialog');
    assert.ok(setupDialog);
    assert.equal(setupDialog.open, true);
    assert.equal(setupDialog.querySelector('#threads-setup-token'), null);
    assert.equal(setupDialog.querySelectorAll('.modal-tab-btn').length, 0);
    assert.ok(setupDialog.textContent.includes('User Token Generator'));

    setupDialog.querySelector('#threads-oauth-client-id').value = '999000111';
    setupDialog.querySelector('#threads-oauth-client-secret').value = 'sec_123';
    setupDialog.querySelector('#threads-oauth-redirect-uri').value = 'https://localhost/';

    setupDialog.querySelector('#threads-oauth-authorize-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(openedUrls.length, 1);
    assert.ok(openedUrls[0].startsWith('https://threads.net/oauth/authorize?'));
    assert.ok(openedUrls[0].includes('client_id=999000111'));
    assert.ok(openedUrls[0].includes('threads_basic'));

    setupDialog.querySelector('#threads-oauth-code-input').value = 'https://localhost/?code=AQ_TEST_CODE#_';
    setupDialog.querySelector('#threads-oauth-exchange-btn').click();
    await new Promise((r) => setTimeout(r, 40));

    const thrAcc = authStore.get().accounts.find((a) => a.platform === 'threads');
    assert.ok(thrAcc);
    assert.equal(thrAcc.userId, 'th_77');
    assert.equal(thrAcc.acct, 'davy_threads');
    assert.ok(thrAcc.expiresAt > Date.now());
    assert.ok(userDialog.querySelector('.threads-refresh-token-btn'));
    userDialog.close();

    // Rich container params: link_attachment + sanitized topic_tag
    fetchCalls.length = 0;
    await publishThreadsPost({
      userId: 'th_77',
      accessToken: 'long_60d_tok',
      text: 'Check https://example.org/post for details.',
      topicTag: '#Open.Source&AI',
    });
    const contCall = fetchCalls.find((c) => c.url.endsWith('/v1.0/th_77/threads') && c.method === 'POST');
    assert.ok(contCall);
    assert.ok(contCall.body.includes(`link_attachment=${encodeURIComponent('https://example.org/post')}`));
    assert.ok(contCall.body.includes('topic_tag=OpenSourceAI'));

    // Direct visibility skips Bluesky & Threads bridges
    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'alice', acct: 'alice@mastodon.social', userId: 'u1' },
      { accessToken: 'm_tok' }
    );
    fetchCalls.length = 0;
    await publishUnified({ text: 'Private Mastodon DM only', visibility: 'direct' });
    assert.equal(fetchCalls.some((c) => c.url.includes('graph.threads.net')), false);

    // Interactive Threads conversation view + inline reply
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    threadCtrl = renderPostThreadView(host, {
      post: {
        id: 'threads:th_p1',
        protocol: 'threads',
        content_text: 'Carousel update',
        author: { id: 'th_77', name: 'Davy Threads', handle: 'davy_threads' },
        _meta: { threads: { postId: 'th_p1' } },
      },
    });
    await new Promise((r) => setTimeout(r, 60));

    assert.equal(host.querySelector('.thread-replies-heading').textContent, 'Replies (2)');
    assert.ok(host.querySelector('.thread-reply-item[data-depth="1"]'));
    assert.ok(host.textContent.includes('Nested reply'));

    const inlineIn = host.querySelector('.thread-inline-reply-form .inline-compose-input');
    inlineIn.value = 'Thanks Carol!';
    replyPublished = true;
    host.querySelector('.thread-inline-reply-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(fetchCalls.some((c) => c.url.endsWith('/v1.0/th_77/threads') && c.body.includes('reply_to_id=th_p1')));
    assert.ok(host.querySelector('.thread-descendants').textContent.includes('Thanks Carol!'));
  } finally {
    threadCtrl?.destroy();
    resetCompose();
    globalThis.open = prevOpen;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('applyKeywordFilters enforces word boundaries & link cards, and Feed tab loads + reacts live to Moderation filter edits', async () => {
  const ts = '2026-11-19T05:00:00.000Z';
  const rules = [
    { id: 'f_trump', phrase: 'trump', filter_action: 'hide' },
    { id: 'f_dem', phrase: 'democrats', filter_action: 'hide' },
    { id: 'f_ai', phrase: 'AI', filter_action: 'hide' },
    { id: 'f_art', phrase: 'art', filter_action: 'hide' },
    { id: 'f_men', phrase: 'men', filter_action: 'hide' },
    { id: 'f_sub', phrase: 'substack', filter_action: 'hide' },
  ];

  const keptAndHidden = applyKeywordFilters(
    [
      toUnifiedItem({
        network: 'bluesky',
        id: 'bsky_trump',
        text: 'Democrats must grow a spine & begin serious investigations into whatever is going on with Trump & Co.',
        linkCard: { url: 'https://www.rawstory.com/a', title: 'Sinister plot sees Trump using outage havoc' },
        createdAt: ts,
        author: { id: 'did:plc:1', handle: 'mary.bsky.social' },
      }),
      toUnifiedItem({
        network: 'bluesky',
        id: 'bsky_singular_dem',
        text: 'Local Democrat candidate announced a transit plan.',
        createdAt: ts,
        author: { id: 'did:plc:2', handle: 'civic.bsky.social' },
      }),
      toUnifiedItem({
        network: 'bluesky',
        id: 'bsky_substack_url',
        text: 'Read my essay today.',
        linkCard: { url: 'https://writer.substack.com/p/essay', title: 'Weekly Notes' },
        createdAt: ts,
        author: { id: 'did:plc:3', handle: 'writer.bsky.social' },
      }),
      toUnifiedItem({
        network: 'bluesky',
        id: 'bsky_short_match',
        text: 'New #AI digital art created by men.',
        createdAt: ts,
        author: { id: 'did:plc:4', handle: 'gen.bsky.social' },
      }),
      toUnifiedItem({
        network: 'bluesky',
        id: 'bsky_safe',
        text: 'She said wait at the department for the government comment on the part she wrote.',
        createdAt: ts,
        author: { id: 'did:plc:5', handle: 'safe.bsky.social' },
      }),
    ],
    rules
  );
  assert.equal(keptAndHidden.length, 1);
  assert.equal(keptAndHidden[0].id, 'bluesky:bsky_safe');

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/api/v2/filters') && method === 'GET') {
      return new Response(
        JSON.stringify([
          { id: 'mf_trump', title: 'Politics', context: ['home', 'public'], filter_action: 'hide', keywords: [{ keyword: 'trump' }] },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v2/filters') && method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      return new Response(
        JSON.stringify({
          id: 'mf_guitar',
          title: body.title,
          context: body.context,
          filter_action: body.filter_action,
          keywords: [{ keyword: body.keywords_attributes?.[0]?.keyword || 'guitar' }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/timelines/public')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('app.bsky.feed.getFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:t/app.bsky.feed.post/1',
                cid: 'cid1',
                author: { did: 'did:plc:t', handle: 'news.bsky.social', displayName: 'News' },
                record: { text: 'Breaking Trump headline today.', createdAt: '2026-11-19T05:00:00Z' },
              },
            },
            {
              post: {
                uri: 'at://did:plc:g/app.bsky.feed.post/2',
                cid: 'cid2',
                author: { did: 'did:plc:g', handle: 'luthier.bsky.social', displayName: 'Luthier' },
                record: { text: 'Guitar of the Day: 1962 Jazzmaster.', createdAt: '2026-11-19T04:59:00Z' },
              },
            },
            {
              post: {
                uri: 'at://did:plc:s/app.bsky.feed.post/3',
                cid: 'cid3',
                author: { did: 'did:plc:s', handle: 'skyrim.bsky.social', displayName: 'ShaderDev' },
                record: { text: 'Morning coffee & shader debugging.', createdAt: '2026-11-19T04:58:00Z' },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    await upsertSocialAccount(
      {
        id: 'fediverse:alice@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'alice',
        acct: 'alice@mastodon.social',
        userId: 'u1',
      },
      { accessToken: 'm_tok' }
    );

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);
    await new Promise((r) => setTimeout(r, 60));

    // "trump" must be hidden automatically on the default Feed tab
    assert.doesNotMatch(host.textContent, /Breaking Trump headline/);
    assert.match(host.textContent, /Guitar of the Day/);
    assert.match(host.textContent, /Morning coffee/);

    // Adding a new filter via SettingsModal / addKeywordFilter updates the live Feed immediately
    await addKeywordFilter({ title: 'guitar', phrase: 'guitar', filterAction: 'hide' });
    await new Promise((r) => setTimeout(r, 20));
    assert.doesNotMatch(host.textContent, /Guitar of the Day/);
    assert.match(host.textContent, /Morning coffee/);
  } finally {
    feedCtrl?.destroy();
    resetFeedStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('rankFeedItems preserves chronological parity when default and enforces all 10 balances plus concept anchors', () => {
  const baseMs = Date.parse('2026-11-19T12:00:00.000Z');
  const isoAgo = (mins) => new Date(baseMs - mins * 60_000).toISOString();

  const items = [
    toUnifiedItem({
      id: 'mastodon:ad_post',
      protocol: 'mastodon',
      content_text: 'FLASH SALE! Limited drop merch — use promo code SAVE20 at checkout!',
      date_published: isoAgo(2),
      author: { id: 'a1', name: 'ShopBrand', handle: 'shop@mastodon.social' },
      metrics: { likes: 5, replies: 0, reposts: 1 },
      _meta: { linkCard: { url: 'https://gumroad.com/l/item', title: 'Buy Now $49' }, mastodon: { statusId: 'ad_post' } },
    }),
    toUnifiedItem({
      id: 'bluesky:at://pundit/1',
      protocol: 'bluesky',
      content_text: 'Democrats and Republicans battle over Senate polling numbers ahead of midterms!',
      date_published: isoAgo(5),
      author: { id: 'a2', name: 'PunditWatch', handle: 'pundit.bsky.social' },
      metrics: { likes: 4500, replies: 6000, reposts: 800 },
      _meta: { linkCard: { url: 'https://www.politico.com/story', title: 'White House race' }, bluesky: { uri: 'at://pundit/1', cid: 'c1' } },
    }),
    toUnifiedItem({
      id: 'mastodon:nsfw_masto',
      protocol: 'mastodon',
      content_text: 'Late night figure study 18+ NSFW',
      date_published: isoAgo(6),
      author: { id: 'a3', name: 'Studio', handle: 'studio@mastodon.social' },
      metrics: { likes: 40, replies: 2, reposts: 3 },
      attachments: [{ url: 'https://img.example/1.jpg', mime_type: 'image/jpeg', alt_text: 'Charcoal sketch' }],
      _meta: { mastodon: { statusId: 'nsfw_masto', sensitive: true, spoilerText: 'NSFW / 18+' } },
    }),
    toUnifiedItem({
      id: 'bluesky:at://art/2',
      protocol: 'bluesky',
      content_text: 'Adult illustration upload',
      date_published: isoAgo(7),
      author: { id: 'a4', name: 'ArtistB', handle: 'artistb.bsky.social' },
      metrics: { likes: 22, replies: 1, reposts: 2 },
      attachments: [{ url: 'https://img.example/2.jpg', mime_type: 'image/jpeg', alt_text: 'Painting' }],
      _meta: { bluesky: { uri: 'at://art/2', cid: 'c2', labels: ['nudity'] } },
    }),
    toUnifiedItem({
      id: 'mastodon:repost_item',
      protocol: 'mastodon',
      content_text: 'Boosted note from yesterday',
      date_published: isoAgo(10),
      author: { id: 'a5', name: 'Booster', handle: 'boost@mastodon.social' },
      metrics: { likes: 15, replies: 1, reposts: 9 },
      _meta: { mastodon: { statusId: 'repost_item', rebloggedBy: { id: 'r1', acct: 'friend@mastodon.social' } } },
    }),
    toUnifiedItem({
      id: 'mastodon:deep_coop',
      protocol: 'mastodon',
      content_text: 'Notes from our neighborhood worker cooperative bakery after six months of open-book accounting and shared scheduling.\nEveryone rotates oven shifts while funding mutual aid loaves for seniors.',
      date_published: isoAgo(90),
      author: { id: 'a6', name: 'CoopBaker', handle: 'coop@mastodon.social' },
      metrics: { likes: 18, replies: 4, reposts: 3 },
      attachments: [{ url: 'https://img.example/bread.jpg', mime_type: 'image/jpeg', alt_text: 'Fresh sourdough loaves on wooden rack' }],
      _meta: {
        linkCard: { url: 'https://institute.coop/handbook', title: 'Cooperative Governance Field Notes', description: 'Open ledger metrics.' },
        mastodon: { statusId: 'deep_coop' },
      },
    }),
    toUnifiedItem({
      id: 'mastodon:quiet_friend',
      protocol: 'mastodon',
      content_text: 'Short hello',
      date_published: isoAgo(30),
      author: { id: 'a7', name: 'Friend', handle: 'pal@mastodon.social' },
      metrics: { likes: 3, replies: 1, reposts: 0 },
      _meta: { mastodon: { statusId: 'quiet_friend' } },
    }),
  ];

  // Default untuned preserves original input array order untouched
  assert.equal(isDefaultFeedTuning(null), true);
  const defaultOut = rankFeedItems(items, null, { nowMs: baseMs });
  assert.deepEqual(defaultOut.map((p) => p.id), items.map((p) => p.id));

  // Hard hides (-100) strip commercial ads, bourgeois politics, reposts, and both Mastodon+Bluesky mature items
  const strictFiltered = rankFeedItems(
    items,
    {
      sliders: {
        recencyHalfLifeHours: 12,
        smallWeb: 80,
        authorDiversity: 60,
        reposts: -100,
        longform: 75,
        media: 40,
        reciprocity: 60,
        commercial: -100,
        bourgeoisPolitics: -100,
        matureContent: -100,
      },
      boostConcepts: ['worker cooperative', 'mutual aid'],
      dampenConcepts: ['promo code'],
    },
    {
      nowMs: baseMs,
      interactedAuthors: { 'mastodon:pal@mastodon.social': 5 },
      semanticScores: { 'mastodon:deep_coop': 0.92 },
    }
  );

  const keptIds = strictFiltered.map((p) => p.id);
  assert.equal(keptIds.includes('mastodon:ad_post'), false);
  assert.equal(keptIds.includes('bluesky:at://pundit/1'), false);
  assert.equal(keptIds.includes('mastodon:nsfw_masto'), false);
  assert.equal(keptIds.includes('bluesky:at://art/2'), false);
  assert.equal(keptIds.includes('mastodon:repost_item'), false);
  assert.equal(keptIds[0], 'mastodon:deep_coop');
  assert.ok(keptIds.includes('mastodon:quiet_friend'));

  // Positive Mature Content + positive Media lifts mature illustrated art rather than hiding it
  const artPositive = rankFeedItems(
    items.filter((it) => !it.id.includes('ad_') && !it.id.includes('pundit')),
    {
      sliders: { recencyHalfLifeHours: 12, media: 80, matureContent: 80 },
    },
    { nowMs: baseMs }
  );
  assert.ok(artPositive.some((p) => p.id === 'mastodon:nsfw_masto'));
  assert.ok(artPositive.some((p) => p.id === 'bluesky:at://art/2'));

  // Author diversity spreads prolific consecutive posts from the same author
  const flooding = [1, 2, 3].map((n) =>
    toUnifiedItem({
      id: `flood_${n}`,
      protocol: 'mastodon',
      content_text: `Flood post ${n}`,
      date_published: isoAgo(n),
      author: { id: 'flooder', name: 'Flooder', handle: 'flood@mastodon.social' },
      metrics: { likes: 50, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: `flood_${n}` } },
    })
  );
  flooding.push(
    toUnifiedItem({
      id: 'other_author',
      protocol: 'mastodon',
      content_text: 'Distinct author post',
      date_published: isoAgo(8),
      author: { id: 'other', name: 'Other', handle: 'other@mastodon.social' },
      metrics: { likes: 10, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 'other_author' } },
    })
  );
  const diverse = rankFeedItems(
    flooding,
    { sliders: { recencyHalfLifeHours: 12, authorDiversity: 100 } },
    { nowMs: baseMs }
  );
  assert.notEqual(diverse[1].author.handle, 'flood@mastodon.social');
});

test('openFeedTuningModal renders 10 sliders, syncs ARIA/CSS vars, edits concept chips, and pushes to Sanctuary /api/feed_profile', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const savedBodies = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/feed_profile') && init.method === 'PUT') {
      const body = JSON.parse(init.body || '{}');
      savedBodies.push(body);
      return new Response(JSON.stringify({ ...body, updatedAt: Date.now() }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });

    const doc = dom.document;
    const modal = openFeedTuningModal();
    const dlg = doc.getElementById('feed-tuning-dialog');
    assert.ok(dlg && dlg.open);

    const sliders = dlg.querySelectorAll('input[type="range"].feed-tuning-slider');
    assert.equal(sliders.length, 10);

    // Adjust Commercial slider to -100 via input + change
    const commSlider = dlg.querySelector('#feed-slider-commercial');
    commSlider.value = '-100';
    commSlider.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(feedStore.get().tuning.sliders.commercial, -100);
    assert.equal(commSlider.getAttribute('aria-valuetext'), 'Commercial: -100 (Hide)');
    assert.equal(commSlider.style.getPropertyValue('--control-value'), '-100');

    // Add Boost concept chip & verify sync PUT reached Sanctuary
    const boostInput = dlg.querySelector('#feed-boost-concept-input');
    boostInput.value = 'union organizing';
    boostInput.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));

    assert.deepEqual(feedStore.get().tuning.boostConcepts, ['union organizing']);
    assert.ok(dlg.textContent.includes('union organizing'));
    assert.ok(savedBodies.length >= 2);
    assert.equal(savedBodies.at(-1).sliders.commercial, -100);
    assert.deepEqual(savedBodies.at(-1).boostConcepts, ['union organizing']);

    // Preset click updates Small Web & Bourgeois Politics
    assert.ok(FEED_TUNING_PRESETS.length >= 5);
    const antiNoisePreset = dlg.querySelector('[data-preset="anti_noise"]');
    antiNoisePreset.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(feedStore.get().tuning.sliders.bourgeoisPolitics, -100);
    assert.equal(feedStore.get().tuning.sliders.smallWeb, 55);

    // Local reciprocity recording + direct updateFeedTuning sync
    await recordAuthorInteraction({ protocol: 'mastodon', author: { handle: 'ally@mastodon.social' } }, 'mastodon', 2);
    assert.equal(feedStore.get().interactedAuthors['mastodon:ally@mastodon.social'], 2);
    await updateFeedTuning({ sliders: { reciprocity: 75 } });
    assert.equal(feedStore.get().tuning.sliders.reciprocity, 75);

    modal.close();
  } finally {
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Own Threads author clicks route to Profile while foreign Threads authors open limited Threads sheet without Mastodon 404 or post leak', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const calls = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: (init.method || 'GET').toUpperCase() });

    if (u.includes('/api/v1/accounts/verify_credentials')) {
      return new Response(
        JSON.stringify({ id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/shinybags.plus') || u.includes('/api/v1/accounts/lookup') || u.includes('/api/v1/accounts/29797930329813883')) {
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/notifications')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('graph.threads.net/v1.0/th_tracked_1/replies')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'r_shiny_1', username: 'shinybags.plus', text: 'well its fascism', timestamp: '2026-11-19T12:00:00.000Z', replied_to: { id: 'th_parent_davy' } },
            { id: 'r_self_1', username: 'davyrhodes_', text: 'Self reply should never appear', timestamp: '2026-11-19T12:01:00.000Z', replied_to: { id: 'th_tracked_1' } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/r_shiny_1?')) {
      return new Response(
        JSON.stringify({ id: 'r_shiny_1', username: 'shinybags.plus', text: 'well its fascism', timestamp: '2026-11-19T12:00:00.000Z', replied_to: { id: 'th_parent_davy' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/th_parent_davy?')) {
      return new Response(
        JSON.stringify({ id: 'th_parent_davy', username: 'davyrhodes_', text: 'Infrastructure ownership post', timestamp: '2026-11-19T11:55:00.000Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/r_shiny_1/conversation') || u.includes('graph.threads.net/v1.0/r_shiny_1/replies')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('graph.threads.net/v1.0/29797930329813883/threads?fields=')) {
      return new Response(
        JSON.stringify({ data: [{ id: 'own_th_1', username: 'davyrhodes_', text: 'Own private Threads timeline leak test', timestamp: '2026-11-19T11:00:00.000Z' }] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/profile_lookup')) {
      return new Response(JSON.stringify({ error: { message: 'Missing scope' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('graph.threads.net/v1.0/me/mentions')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('insights')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let shell = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();

    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'alice', acct: 'alice@mastodon.social', userId: 'u1' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'threads:29797930329813883', platform: 'threads', userId: '29797930329813883', handle: 'davyrhodes_', acct: 'davyrhodes_', displayName: 'Davy Rhodes' },
      { accessToken: 't_tok' }
    );
    await saveLocalLinkedPost({
      canonicalId: 'mastodon:m_linked_1',
      mastodonStatusId: 'm_linked_1',
      threadsPostId: 'th_tracked_1',
    });

    const doc = dom.document;
    const root = doc.createElement('div');
    doc.body.appendChild(root);
    shell = createAppShell(root, { initialTab: 'activity', skipBackgroundInit: true });
    await new Promise((r) => setTimeout(r, 60));

    // Only shinybags.plus reply appears (self-reply excluded; unlinked native timeline not polled)
    assert.ok(root.textContent.includes('shinybags.plus'));
    assert.equal(root.textContent.includes('Self reply should never appear'), false);
    assert.equal(calls.some((c) => c.url.includes('29797930329813883/threads?fields=')), false);

    // Clicking shinybags.plus opens Threads AuthorSheetModal cleanly (no Mastodon 404, no leaked own posts)
    calls.length = 0;
    const authorBtn = root.querySelector('.activity-actor-btn, .post-author-meta');
    assert.ok(Boolean(authorBtn));
    authorBtn.click();
    await new Promise((r) => setTimeout(r, 60));

    const authorDlg = doc.getElementById('author-sheet-dialog');
    assert.ok(Boolean(authorDlg && authorDlg.open));
    assert.equal(authorDlg.querySelector('.post-protocol-badge')?.textContent, 'Threads');
    assert.equal(authorDlg.querySelector('.author-ext-link')?.getAttribute('href'), 'https://www.threads.net/@shinybags.plus');
    assert.equal(authorDlg.textContent.includes('Mastodon API 404'), false);
    assert.equal(authorDlg.textContent.includes('Own private Threads timeline leak test'), false);
    assert.ok(authorDlg.textContent.includes('managed on Threads'));
    assert.equal(calls.some((c) => c.url.includes('/api/v1/accounts/shinybags.plus')), false);
    assert.equal(calls.some((c) => c.url.includes('29797930329813883/threads?fields=')), false);
    const closeBtn = authorDlg.querySelector('.close-modal-btn');
    assert.ok(Boolean(closeBtn));
    closeBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    // Open thread from notification body -> ancestor is own Davy Rhodes Threads post -> clicking Davy Rhodes routes to Profile
    const postBodyEl = root.querySelector('.activity-row .post-body-html');
    assert.ok(Boolean(postBodyEl));
    postBodyEl.click();
    await new Promise((r) => setTimeout(r, 60));

    const threadAuthors = [...root.querySelectorAll('.post-author-meta')];
    const davyAuthorBtn = threadAuthors.find((b) => b.textContent.includes('davyrhodes_') || b.textContent.includes('Davy Rhodes'));
    assert.ok(Boolean(davyAuthorBtn));
    davyAuthorBtn.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(Boolean(doc.getElementById('author-sheet-dialog')), false);
    assert.equal(Boolean(root.querySelector('.rail-utility-btn.is-active') || root.querySelector('[data-tab="profile"]')?.classList.contains('is-active')), true);
  } finally {
    shell?.unmount?.();
    shell?.destroy?.();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('enrichUnifiedItemsMetrics sums Mastodon, Bluesky, and Threads insights without double-counting and PostCard shows breakdown tooltip', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('app.bsky.feed.getPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            { uri: 'at://did:plc:alice/app.bsky.feed.post/agg1', likeCount: 5, replyCount: 2, repostCount: 1, quoteCount: 1 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/th_agg_1/insights')) {
      return new Response(
        JSON.stringify({
          data: [
            { name: 'likes', values: [{ value: 4 }] },
            { name: 'replies', values: [{ value: 1 }] },
            { name: 'reposts', values: [{ value: 2 }] },
            { name: 'quotes', values: [{ value: 1 }] },
          ],
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
      { id: 'bluesky:did:plc:alice', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:alice', handle: 'alice.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );
    await upsertSocialAccount(
      { id: 'threads:th_1', platform: 'threads', userId: 'th_1', handle: 'alice', acct: 'alice' },
      { accessToken: 't_tok' }
    );
    await saveLocalLinkedPost({
      canonicalId: 'mastodon:m_agg_1',
      mastodonStatusId: 'm_agg_1',
      blueskyUri: 'at://did:plc:alice/app.bsky.feed.post/agg1',
      threadsPostId: 'th_agg_1',
    });

    const mastoItem = toUnifiedItem({
      id: 'mastodon:m_agg_1',
      protocol: 'mastodon',
      content_text: 'Crossposted work',
      author: { id: 'u1', name: 'Alice', handle: 'alice@mastodon.social' },
      metrics: { likes: 3, replies: 1, reposts: 2 },
      _meta: { mastodon: { statusId: 'm_agg_1' } },
    });

    const enrichedOnce = await enrichUnifiedItemsMetrics([mastoItem]);
    assert.equal(enrichedOnce[0].metrics.likes, 12);
    assert.equal(enrichedOnce[0].metrics.replies, 4);
    assert.equal(enrichedOnce[0].metrics.reposts, 7);
    assert.deepEqual(enrichedOnce[0]._meta.metricsBreakdown, {
      mastodon: { likes: 3, replies: 1, reposts: 2 },
      bluesky: { likes: 5, replies: 2, reposts: 2 },
      threads: { likes: 4, replies: 1, reposts: 3 },
    });

    const enrichedTwice = await enrichUnifiedItemsMetrics(enrichedOnce);
    assert.equal(enrichedTwice[0].metrics.likes, 12);
    assert.equal(enrichedTwice[0].metrics.replies, 4);
    assert.equal(enrichedTwice[0].metrics.reposts, 7);

    const card = createPostCard(enrichedOnce[0]);
    const likeBtn = [...card.querySelectorAll('button.post-action-btn')].find((b) => b.getAttribute('aria-label')?.startsWith('Favourite'));
    assert.ok(likeBtn);
    assert.ok(likeBtn.textContent.includes('12'));
    assert.ok(likeBtn.getAttribute('title')?.includes('Mastodon: 3'));
    assert.ok(likeBtn.getAttribute('title')?.includes('Bluesky: 5'));
    assert.ok(likeBtn.getAttribute('title')?.includes('Threads: 4'));
  } finally {
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('openEditPostDialog explains Threads API edit constraint and only replaces bridged copies when opted in', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const calls = [];
  let thrCounter = 0;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method });

    if (u.includes('/api/v1/statuses/m_ed_1') && method === 'PUT') {
      const body = JSON.parse(init.body || '{}');
      return new Response(
        JSON.stringify({
          id: 'm_ed_1',
          content: `<p>${body.status}</p>`,
          created_at: '2026-11-19T12:00:00.000Z',
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('com.atproto.repo.deleteRecord') || u.includes('com.atproto.repo.createRecord')) {
      return new Response(
        JSON.stringify({ uri: 'at://did:plc:alice/app.bsky.feed.post/new_bsky_1', cid: 'cid_new_1' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/th_old_1') && method === 'DELETE') {
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('graph.threads.net/v1.0/th_1/threads') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'th_cont_new' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('graph.threads.net/v1.0/th_1/threads_publish') && method === 'POST') {
      thrCounter += 1;
      return new Response(JSON.stringify({ id: `th_new_${thrCounter}` }), { status: 200, headers: { 'content-type': 'application/json' } });
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
    await saveLocalLinkedPost({
      canonicalId: 'mastodon:m_ed_1',
      mastodonStatusId: 'm_ed_1',
      mastodonInstance: 'https://mastodon.social',
      blueskyUri: 'at://did:plc:alice/app.bsky.feed.post/old_bsky_1',
      blueskyCid: 'cid_old',
      threadsPostId: 'th_old_1',
    });

    const post = toUnifiedItem({
      id: 'mastodon:m_ed_1',
      protocol: 'mastodon',
      content_text: 'Original draft',
      _meta: {
        mastodon: { statusId: 'm_ed_1' },
        linkedIds: {
          mastodonStatusId: 'm_ed_1',
          blueskyUri: 'at://did:plc:alice/app.bsky.feed.post/old_bsky_1',
          threadsPostId: 'th_old_1',
        },
      },
    });

    // 1. Default edit has Update bridges checked and compose-sheet layout; unchecking edits Mastodon in place
    const saved1 = await new Promise((resolve) => {
      openEditPostDialog(post, { onSaved: resolve });
      const dlg = dom.document.getElementById('edit-post-dialog');
      assert.ok(dlg.querySelector('.compose-sheet-card'));
      assert.ok(dlg.querySelector('.compose-sheet-header'));
      assert.ok(dlg.querySelector('.compose-seamless-textarea'));
      assert.ok(dlg.querySelector('.compose-bridge-toggle-pill'));
      const cb = dlg.querySelector('#edit-post-replace-bridges');
      assert.ok(cb && cb.checked === true);
      cb.checked = false;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
      dlg.querySelector('textarea').value = 'Mastodon in-place edit';
      dlg.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(saved1.content_text, 'Mastodon in-place edit');
    assert.equal(calls.some((c) => c.url.includes('th_old_1')), false);
    assert.equal(calls.some((c) => c.url.includes('deleteRecord')), false);

    // 2. Default checked Update bridges deletes & republishes both bridged copies
    calls.length = 0;
    const saved2 = await new Promise((resolve) => {
      openEditPostDialog(post, { onSaved: resolve });
      const dlg = dom.document.getElementById('edit-post-dialog');
      const cb = dlg.querySelector('#edit-post-replace-bridges');
      assert.ok(cb && cb.checked === true);
      dlg.querySelector('textarea').value = 'Replaced across bridges';
      dlg.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(saved2.content_text, 'Replaced across bridges');
    assert.ok(calls.some((c) => c.url.includes('com.atproto.repo.deleteRecord')));
    assert.ok(calls.some((c) => c.url.includes('com.atproto.repo.createRecord')));
    assert.ok(calls.some((c) => c.method === 'DELETE' && c.url.includes('th_old_1')));
    assert.ok(calls.some((c) => c.url.includes('threads_publish')));
    assert.equal(saved2._meta.linkedIds.threadsPostId, 'th_new_1');
  } finally {
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('ComposeModal detects embedded YouTube URLs, forwards external embed to Bluesky/Threads, and PostCard loads iframe only on click', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const calls = [];
  let publishedMastoCard = null;

  assert.equal(
    extractFirstHttpsUrl('Check https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB!'),
    'https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB'
  );
  const vInfo = parseVideoEmbedInfo('https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB');
  assert.equal(vInfo?.provider, 'youtube');
  assert.equal(vInfo?.embedUrl, 'https://www.youtube-nocookie.com/embed/j_wrosWPRTc?autoplay=1&rel=0');

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body });

    if (u.includes('youtube.com/oembed')) {
      return new Response(
        JSON.stringify({
          title: 'Workers Solidarity Session',
          author_name: 'Studio Collective',
          provider_name: 'YouTube',
          thumbnail_url: 'https://i.ytimg.com/vi/j_wrosWPRTc/hqdefault.jpg',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('i.ytimg.com')) {
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
    }
    if (u.includes('com.atproto.repo.uploadBlob')) {
      return new Response(
        JSON.stringify({ blob: { $type: 'blob', ref: { $link: 'bafk_embed_thumb' }, mimeType: 'image/jpeg', size: 4 } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('com.atproto.repo.createRecord')) {
      return new Response(JSON.stringify({ uri: 'at://did:plc:alice/app.bsky.feed.post/emb1', cid: 'cid_emb1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/statuses') && method === 'POST') {
      const parsed = JSON.parse(init.body || '{}');
      return new Response(
        JSON.stringify({
          id: 'm_emb_1',
          content: `<p>${parsed.status}</p>`,
          created_at: '2026-11-19T12:00:00.000Z',
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.endsWith('graph.threads.net/v1.0/th_1/threads') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'th_cont_emb' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('graph.threads.net/v1.0/th_1/threads_publish') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'th_pub_emb' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let composeCtrl = null;
  try {
    clearLinkPreviewCacheForTests();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetCompose();
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

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    composeCtrl = mountComposeModal(host, {
      onPublished: (results) => {
        publishedMastoCard = results?.[0] || null;
      },
    });

    composeStore.set({
      isOpen: true,
      text: 'https://youtu.be/j_wrosWPRTc?is=38GtLIIGCGc06tEB',
    });
    await new Promise((r) => setTimeout(r, 260));

    const previewHost = host.querySelector('.compose-link-preview-host');
    assert.ok(Boolean(previewHost?.querySelector('.post-embed-card')));
    assert.ok(previewHost.textContent.includes('Workers Solidarity Session'));
    assert.equal(Boolean(previewHost.querySelector('iframe')), false);

    // Dismissing preview hides it; re-enabling via another video URL shows new embed and publishes it
    previewHost.querySelector('.compose-embed-dismiss-btn')?.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(Boolean(previewHost.querySelector('.post-embed-card')), false);

    composeStore.set({ text: 'https://youtu.be/dQw4w9WgXcQ' });
    await new Promise((r) => setTimeout(r, 260));
    assert.ok(Boolean(previewHost.querySelector('.post-embed-card')));

    host.querySelector('.compose-publish-btn')?.click();
    await new Promise((r) => setTimeout(r, 90));

    const bskyCreate = calls.find((c) => c.url.includes('com.atproto.repo.createRecord'));
    assert.ok(bskyCreate);
    const bskyPayload = JSON.parse(bskyCreate.body);
    assert.equal(bskyPayload.record.embed.$type, 'app.bsky.embed.external');
    assert.equal(bskyPayload.record.embed.external.uri, 'https://youtu.be/dQw4w9WgXcQ');
    assert.equal(bskyPayload.record.embed.external.thumb.ref.$link, 'bafk_embed_thumb');

    const thrCreate = calls.find((c) => c.url.endsWith('graph.threads.net/v1.0/th_1/threads'));
    assert.ok(thrCreate && String(thrCreate.body).includes('link_attachment=https%3A%2F%2Fyoutu.be%2FdQw4w9WgXcQ'));

    assert.ok(publishedMastoCard);
    const cardEl = createPostCard(publishedMastoCard);
    assert.equal(Boolean(cardEl.querySelector('iframe')), false);
    const playBtn = cardEl.querySelector('.post-embed-play-btn');
    assert.ok(Boolean(playBtn));
    playBtn.click();
    const iframe = cardEl.querySelector('iframe.post-embed-iframe');
    assert.ok(Boolean(iframe));
    assert.equal(iframe.getAttribute('src'), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?autoplay=1&rel=0');
  } finally {
    composeCtrl?.destroy?.();
    clearLinkPreviewCacheForTests();
    resetCompose();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('ThreadsImportModal parses deflated ZIP with mojibake, builds Mastodon CSVs, enforces local moderation, and verifies @threads.net follows', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const crcTable = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    crcTable[i] = c >>> 0;
  }
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i += 1) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const buildDeflateZip = (files) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, obj] of Object.entries(files)) {
      const nameBytes = Buffer.from(name, 'utf8');
      const rawBytes = Buffer.from(JSON.stringify(obj), 'utf8');
      const compBytes = deflateRawSync(rawBytes);
      const crc = crc32(rawBytes);

      const lh = Buffer.alloc(30 + nameBytes.length);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(crc, 14);
      lh.writeUInt32LE(compBytes.length, 18);
      lh.writeUInt32LE(rawBytes.length, 22);
      lh.writeUInt16LE(nameBytes.length, 26);
      nameBytes.copy(lh, 30);

      const ch = Buffer.alloc(46 + nameBytes.length);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(8, 10);
      ch.writeUInt32LE(crc, 16);
      ch.writeUInt32LE(compBytes.length, 20);
      ch.writeUInt32LE(rawBytes.length, 24);
      ch.writeUInt16LE(nameBytes.length, 28);
      ch.writeUInt32LE(offset, 42);
      nameBytes.copy(ch, 46);

      locals.push(lh, compBytes);
      centrals.push(ch);
      offset += lh.length + compBytes.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(centrals.length, 8);
    eocd.writeUInt16LE(centrals.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, cd, eocd]);
  };

  assert.equal(decodeMetaMojibake('Free \u00f0\u009f\u0087\u00b5\u00f0\u009f\u0087\u00b8'), 'Free 🇵🇸');
  const zipBuf = buildDeflateZip({
    'threads/followers.json': {
      text_post_app_text_post_app_followers: [
        { title: 'Jos\u00c3\u00a9', string_list_data: [{ value: '_jaoga_', timestamp: 100 }] },
        { title: 'Mutual Alice', string_list_data: [{ value: 'mutual_alice', timestamp: 101 }] },
      ],
    },
    'threads/following.json': {
      text_post_app_text_post_app_following: [
        { title: '', string_list_data: [{ value: 'mutual_alice', timestamp: 102 }] },
        { title: '', string_list_data: [{ value: 'only_following', timestamp: 103 }] },
      ],
    },
    'threads/blocked_profiles.json': [
      { timestamp: 200, label_values: [{ label: 'Name', value: 'Troll \u00f0\u009f\u0091\u008d' }, { label: 'Username', value: 'blocked_troll' }] },
    ],
    'threads/restricted_profiles.json': [
      { timestamp: 201, label_values: [{ label: 'Name', value: 'Noisy' }, { label: 'Username', value: 'muted_noise' }] },
    ],
  });

  const parsed = await parseThreadsArchiveBuffer(zipBuf, 'threads-export.zip');
  assert.deepEqual(parsed.counts, { mutuals: 1, following: 2 });
  assert.equal(parsed.mutuals[0].displayName, 'Mutual Alice');
  assert.equal(parsed.following[0].username, 'mutual_alice');

  const csvMutuals = buildMastodonImportCsv('mutuals', parsed.mutuals);
  assert.ok(csvMutuals.startsWith('Account address,Show boosts,Notify on new posts,Languages\n'));
  assert.ok(csvMutuals.includes('mutual_alice@threads.net,true,false,\n'));

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const followCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/api/v1/accounts/lookup')) {
      const acct = new URL(u).searchParams.get('acct');
      if (acct === 'mutual_alice@threads.net') {
        return new Response(JSON.stringify({ id: 'fed_alice', username: 'mutual_alice', acct: 'mutual_alice@threads.net' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (acct === 'only_following@threads.net') {
        return new Response(JSON.stringify({ id: 'wrong_domain', username: 'only_following', acct: 'only_following@elsewhere.social' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/follow') && method === 'POST') {
      followCalls.push(u);
      return new Response(JSON.stringify({ id: 'fed_alice', following: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/mutes') || u.includes('/api/v1/blocks') || u.includes('/api/v1/filters')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    clearThreadsImportStateForTests();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'alice', acct: 'alice@mastodon.social', userId: 'u1' },
      { accessToken: 'm_tok' }
    );

    // Local moderation store helpers still work independently when explicitly invoked
    await saveLocalModeratedAccounts({
      blocks: [{ username: 'blocked_troll', displayName: 'Troll 👍' }],
      mutes: [{ username: 'muted_noise', displayName: 'Noisy' }],
    });
    const modActors = await hydrateCachedModeration();
    const filtered = applyKeywordFilters(
      [
        toUnifiedItem({ id: 'm1', protocol: 'mastodon', content_text: 'Blocked fediverse mirror', author: { id: 'x1', handle: 'blocked_troll@threads.net' } }),
        toUnifiedItem({ id: 't1', protocol: 'threads', content_text: 'Muted native', author: { id: 'x2', handle: 'muted_noise' } }),
        toUnifiedItem({ id: 'm2', protocol: 'mastodon', content_text: 'Keep mutual', author: { id: 'x3', handle: 'mutual_alice@threads.net' } }),
      ],
      [],
      modActors
    );
    assert.deepEqual(filtered.map((p) => p.id), ['mastodon:m2']);

    // Settings -> Moderation omits archive importer and uses stoic Feed Algorithm copy
    const settingsModal = openSettingsModal({ initialTab: 'moderation' });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(settingsModal.dialog.querySelector('.threads-import-settings-btn'), null);
    assert.ok(settingsModal.dialog.textContent.includes('Adjust local ranking weights and concept filters.'));
    settingsModal.close();

    // Open modal, verify only 2 follow radio options & 2 CSV buttons, load file, and run @threads.net follow sync
    const modal = openThreadsImportModal();
    const dlg = dom.document.getElementById('threads-import-dialog');
    assert.ok(Boolean(dlg && dlg.open));
    assert.equal(dlg.querySelectorAll('fieldset input[type="radio"][name="threads_follow_scope"]').length, 2);
    assert.equal(dlg.querySelectorAll('.threads-import-csv-btn').length, 2);
    assert.equal(dlg.querySelector('#threads-apply-local-mod'), null);
    assert.ok(Boolean(dlg.querySelector('progress.threads-import-progress')));

    const fileInput = dlg.querySelector('#threads-archive-file-input');
    const mockFile = { name: 'threads-export.zip', async arrayBuffer() { return zipBuf; } };
    Object.defineProperty(fileInput, 'files', { value: [mockFile], configurable: true });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(dlg.textContent.includes('Mutuals: 1'));
    assert.ok(dlg.textContent.includes('Following: 2'));

    const job = await startThreadsArchiveSync({
      followScope: 'following',
      delayMs: 0,
    });
    assert.equal(job.status, 'completed');
    assert.equal(job.followed, 1);
    assert.equal(job.notFederated, 1);
    assert.equal(followCalls.length, 1);
    assert.ok(followCalls[0].includes('/api/v1/accounts/fed_alice/follow'));
    modal.close();
  } finally {
    clearThreadsImportStateForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('feed removes top tune button (stays in Settings), updates likes in place without moving posts, and appends infinite scroll at tail', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let feedCtrl = null;
  let favCalls = 0;

  const baseMs = Date.now();
  const isoMinsAgo = (m) => new Date(baseMs - m * 60_000).toISOString();

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/api/v1/filters') || u.includes('/api/v1/mutes') || u.includes('/api/v1/blocks')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/statuses/s_boost/favourite') && method === 'POST') {
      favCalls += 1;
      // Mastodon returns unwrapped original status (without `reblog` wrapper) and per-instance favourites_count=3
      return new Response(
        JSON.stringify({
          id: 's_boost',
          uri: 'https://mastodon.social/users/quiet/statuses/s_boost',
          url: 'https://mastodon.social/users/quiet/statuses/s_boost',
          created_at: isoMinsAgo(40),
          content: '<p>Boosted note kept in place</p>',
          favourited: true,
          favourites_count: 3,
          reblogs_count: 1,
          replies_count: 1,
          reblogged: false,
          account: { id: 'q1', username: 'quiet', acct: 'quiet@mastodon.social', display_name: 'Quiet Author' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/timelines/public')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fediverse:alice@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'alice',
        acct: 'alice@mastodon.social',
        userId: 'u1',
      },
      { accessToken: 'm_tok' }
    );

    await updateFeedTuning(
      {
        sliders: {
          recencyHalfLifeHours: 8,
          smallWeb: 75,
          authorDiversity: 60,
          reposts: -35,
          reciprocity: 50,
          longform: 25,
          commercial: -70,
          bourgeoisPolitics: -50,
        },
      },
      { syncRemote: false }
    );

    const pTop = toUnifiedItem({
      id: 'mastodon:s_top',
      protocol: 'mastodon',
      content_html: '<p>Top small web post</p>',
      content_text: 'Top small web post',
      date_published: isoMinsAgo(1),
      author: { id: 'a_top', name: 'TopAuthor', handle: 'topauthor@mastodon.social' },
      metrics: { likes: 4, replies: 1, reposts: 0 },
      _meta: { mastodon: { statusId: 's_top', instanceUrl: 'https://mastodon.social' } },
    });
    const pBoost = toUnifiedItem({
      id: 'mastodon:s_boost',
      protocol: 'mastodon',
      url: 'https://mastodon.social/users/quiet/statuses/s_boost',
      content_html: '<p>Boosted note kept in place</p>',
      content_text: 'Boosted note kept in place',
      date_published: isoMinsAgo(40),
      author: { id: 'q1', name: 'Quiet Author', handle: 'quiet@mastodon.social' },
      metrics: { likes: 7, replies: 1, reposts: 2 },
      _meta: {
        mastodon: {
          statusId: 's_boost',
          instanceUrl: 'https://mastodon.social',
          favourited: false,
          rebloggedBy: { id: 'b1', name: 'Booster', handle: 'booster@mastodon.social' },
        },
        metricsBreakdown: {
          mastodon: { likes: 2, replies: 1, reposts: 1 },
          bluesky: { likes: 5, replies: 0, reposts: 1 },
        },
      },
    });
    const pMid = toUnifiedItem({
      id: 'mastodon:s_mid',
      protocol: 'mastodon',
      content_html: '<p>Mid chronological note</p>',
      content_text: 'Mid chronological note',
      date_published: isoMinsAgo(15),
      author: { id: 'a_mid', name: 'MidAuthor', handle: 'mid@mastodon.social' },
      metrics: { likes: 2, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 's_mid', instanceUrl: 'https://mastodon.social' } },
    });

    setStreamItems('feed', [pTop, pMid, pBoost], { fedi: 'cursor_p2' });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);
    await new Promise((r) => setTimeout(r, 20));

    // Top bar keeps Refresh and omits top Tune button; Settings -> Moderation still opens Tune Feed modal
    assert.ok(host.querySelector('.feed-stream-tabs .feed-refresh-btn'));
    assert.equal(host.querySelector('.feed-tune-btn'), null);

    const settingsModal = openSettingsModal({ initialTab: 'moderation' });
    await new Promise((r) => setTimeout(r, 30));
    const settingsDlg = dom.document.getElementById('connection-settings-dialog');
    const tuneInSettingsBtn = Array.from(settingsDlg.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Tune Feed')
    );
    assert.ok(tuneInSettingsBtn, 'Settings -> Moderation must retain Tune Feed button');
    tuneInSettingsBtn.click();
    const tuningDlg = dom.document.getElementById('feed-tuning-dialog');
    assert.ok(tuningDlg && tuningDlg.open);
    tuningDlg.close();
    settingsModal.close();

    const initialOrder = Array.from(host.querySelectorAll('article.post-card')).map((el) => el.dataset.postId);
    assert.equal(initialOrder.length, 3);

    const boostArticle = host.querySelector('article.post-card[data-post-id="mastodon:s_boost"]');
    const likeBtn = boostArticle.querySelector('.post-action-like');
    assert.ok(boostArticle.querySelector('.post-reblog-banner'));
    assert.equal(likeBtn.getAttribute('aria-pressed'), 'false');

    likeBtn.click();
    // Immediate optimistic update without losing node identity or order
    assert.equal(likeBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(likeBtn.querySelector('.post-action-count').textContent, '8');

    await new Promise((r) => setTimeout(r, 35));
    assert.equal(favCalls, 1);
    assert.ok(
      host.querySelector('article.post-card[data-post-id="mastodon:s_boost"]') === boostArticle,
      'Card DOM node must stay in place'
    );
    assert.ok(
      boostArticle.querySelector('.post-action-like') === likeBtn,
      'Like button DOM node must stay in place'
    );
    assert.equal(likeBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(likeBtn.querySelector('.post-action-count').textContent, '8');
    assert.ok(boostArticle.querySelector('.post-reblog-banner'), 'Boost banner must survive Like update');
    assert.deepEqual(
      Array.from(host.querySelectorAll('article.post-card')).map((el) => el.dataset.postId),
      initialOrder,
      'Liking a post must never shuffle feed order'
    );

    // Infinite scroll append places new page strictly after initial rendered items even if newly appended post scores higher
    const pOlderHighScore = toUnifiedItem({
      id: 'mastodon:s_older_page2',
      protocol: 'mastodon',
      content_html: '<p>Older post from Quiet Author with high reciprocity + smallWeb score</p>',
      content_text: 'Older post from Quiet Author with high reciprocity + smallWeb score',
      date_published: isoMinsAgo(3),
      author: { id: 'q1', name: 'Quiet Author', handle: 'quiet@mastodon.social' },
      metrics: { likes: 1, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 's_older_page2', instanceUrl: 'https://mastodon.social' } },
    });
    appendStreamItems('feed', [pOlderHighScore], null);
    await new Promise((r) => setTimeout(r, 20));

    assert.deepEqual(
      Array.from(host.querySelectorAll('article.post-card')).map((el) => el.dataset.postId),
      [...initialOrder, 'mastodon:s_older_page2'],
      'Appended page items must render strictly after already-visible items'
    );
  } finally {
    feedCtrl?.destroy();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Activity unread nav badge, cross-platform grouped notifications with totals, and persistent notification deletion', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const dismissCalls = [];
  let clearCalls = 0;
  let updateSeenCalls = 0;
  let threadsInsightLikes = 4;

  const isoAgo = (mins) => new Date(Date.now() - mins * 60_000).toISOString();
  const bskyPostUri = 'at://did:plc:me/app.bsky.feed.post/p_act_1';

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init?.method || 'GET').toUpperCase();

    if (u.includes('/api/v1/timelines/home') || u.includes('/api/v1/trends/statuses')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/notifications/clear') && method === 'POST') {
      clearCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (/\/api\/v1\/notifications\/[^/]+\/dismiss/.test(u) && method === 'POST') {
      dismissCalls.push(u);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/notifications')) {
      return new Response(
        JSON.stringify([
          {
            id: 'mn_like_1',
            type: 'favourite',
            created_at: isoAgo(1),
            account: { id: 'u_m1', username: 'hammer_of_the_proles', acct: 'hammer_of_the_proles@mastodon.social', display_name: 'hammer_of_the_proles', avatar: '' },
            status: {
              id: 'm_act_1',
              created_at: isoAgo(30),
              content: '<p>Capitalism will kill you act accordingly</p>',
              favourites_count: 2,
              reblogs_count: 1,
              replies_count: 1,
              account: { id: 'u_me', username: 'davyrhodes_', acct: 'davyrhodes_@mastodon.social', display_name: 'Davy' },
              media_attachments: [
                { id: 'att1', type: 'image', preview_url: 'https://cdn.example.test/thumb_act.jpg', url: 'https://cdn.example.test/full_act.jpg' },
              ],
            },
          },
          {
            id: 'mn_like_2',
            type: 'favourite',
            created_at: isoAgo(2),
            account: { id: 'u_m2', username: 'semiamniotic', acct: 'semiamniotic@mastodon.social', display_name: 'semiamniotic', avatar: '' },
            status: {
              id: 'm_act_1',
              created_at: isoAgo(30),
              content: '<p>Capitalism will kill you act accordingly</p>',
              favourites_count: 2,
              reblogs_count: 1,
              replies_count: 1,
              account: { id: 'u_me', username: 'davyrhodes_', acct: 'davyrhodes_@mastodon.social', display_name: 'Davy' },
              media_attachments: [
                { id: 'att1', type: 'image', preview_url: 'https://cdn.example.test/thumb_act.jpg', url: 'https://cdn.example.test/full_act.jpg' },
              ],
            },
          },
          {
            id: 'mn_reblog_1',
            type: 'reblog',
            created_at: isoAgo(5),
            account: { id: 'u_m3', username: 'guymontout', acct: 'guymontout@mastodon.social', display_name: 'guymontout', avatar: '' },
            status: {
              id: 'm_act_1',
              created_at: isoAgo(30),
              content: '<p>Capitalism will kill you act accordingly</p>',
              favourites_count: 2,
              reblogs_count: 1,
              replies_count: 1,
              account: { id: 'u_me', username: 'davyrhodes_', acct: 'davyrhodes_@mastodon.social', display_name: 'Davy' },
              media_attachments: [],
            },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.notification.updateSeen') && method === 'POST') {
      updateSeenCalls += 1;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('app.bsky.notification.listNotifications')) {
      return new Response(
        JSON.stringify({
          notifications: [
            {
              uri: 'at://did:plc:fan/app.bsky.feed.like/l1',
              cid: 'cid_bl1',
              reason: 'like',
              reasonSubject: bskyPostUri,
              isRead: false,
              indexedAt: isoAgo(3),
              author: { did: 'did:plc:fan', handle: 'bsky_fan.bsky.social', displayName: 'bsky_fan', avatar: '' },
              record: { $type: 'app.bsky.feed.like', subject: { uri: bskyPostUri, cid: 'cid_p_act_1' } },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.getPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: bskyPostUri,
              cid: 'cid_p_act_1',
              indexedAt: isoAgo(30),
              author: { did: 'did:plc:me', handle: 'me.bsky.social', displayName: 'Davy' },
              record: { text: 'Capitalism will kill you act accordingly' },
              likeCount: 3,
              repostCount: 2,
              replyCount: 1,
              quoteCount: 0,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/th_act_1/insights')) {
      return new Response(
        JSON.stringify({
          data: [
            { name: 'likes', total_value: { value: threadsInsightLikes } },
            { name: 'replies', total_value: { value: 2 } },
            { name: 'reposts', total_value: { value: 1 } },
            { name: 'quotes', total_value: { value: 0 } },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/th_act_1/replies')) {
      return new Response(
        JSON.stringify({
          data: [
            { id: 'th_rep_1', username: 'threads_commenter', text: 'Great point across all networks', timestamp: isoAgo(4) },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/me/mentions')) {
      return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('graph.threads.net/v1.0/profile_lookup')) {
      return new Response(JSON.stringify({ error: { message: 'Missing scope' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let shell = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();
    clearThreadsInsightsCacheForTests();

    await upsertSocialAccount(
      { id: 'fediverse:davyrhodes_@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'davyrhodes_', acct: 'davyrhodes_@mastodon.social', userId: 'u_me' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:me', handle: 'me.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );
    await upsertSocialAccount(
      { id: 'threads:th_me', platform: 'threads', userId: 'th_me', handle: 'davyrhodes_', acct: 'davyrhodes_' },
      { accessToken: 't_tok' }
    );
    await saveLocalLinkedPost({
      canonicalId: 'mastodon:m_act_1',
      mastodonStatusId: 'm_act_1',
      mastodonInstance: 'https://mastodon.social',
      blueskyUri: bskyPostUri,
      blueskyCid: 'cid_p_act_1',
      threadsPostId: 'th_act_1',
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    shell = createAppShell(host, { initialTab: 'home', skipBackgroundInit: true });

    // Unread red dot illuminates on Heart icon in nav while on Home
    await refreshActivityNotifications({ limit: 40, background: true });
    const actBtn = host.querySelector('.primary-tab-btn[data-tab="activity"]');
    const dotEl = actBtn?.querySelector('.nav-unread-dot');
    assert.ok(actBtn && dotEl);
    assert.equal(dotEl.hidden, false);
    assert.equal(actBtn.classList.contains('has-unread-activity'), true);
    assert.equal(actBtn.getAttribute('aria-label'), 'Activity (unread notifications)');
    assert.equal(actBtn.textContent.trim(), '');

    // Opening Activity clears the unread red dot and marks Bluesky seen
    shell.navigateToTab('activity');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(dotEl.hidden, true);
    assert.equal(actBtn.classList.contains('has-unread-activity'), false);
    assert.ok(updateSeenCalls >= 1);

    // Cross-platform likes collapse into one grouped row ("hammer_of_the_proles and 6 others": 2 Masto + 1 Bsky + 4 Threads)
    const likeRows = host.querySelectorAll('.activity-row--like');
    assert.equal(likeRows.length, 1);
    const likeRow = likeRows[0];
    assert.ok(likeRow.querySelector('.activity-kind-badge--like'));
    assert.equal(likeRow.querySelector('.activity-actor-btn')?.textContent, 'hammer_of_the_proles');
    assert.equal(likeRow.querySelector('.activity-others-label')?.textContent, 'and 6 others');
    assert.equal(likeRow.querySelector('.activity-media-thumb')?.getAttribute('src'), 'https://cdn.example.test/thumb_act.jpg');
    assert.ok(likeRow.querySelector('.activity-post-metrics')?.textContent.includes('♥ 9'));
    assert.ok(likeRow.querySelector('.activity-post-metrics')?.textContent.includes('↻ 4'));
    assert.ok(likeRow.querySelector('.activity-post-metrics')?.textContent.includes('💬 4'));

    // Totals summary bar shows aggregated likes, reposts, comments across all platforms
    const totalsText = host.querySelector('.activity-totals-bar')?.textContent || '';
    assert.ok(totalsText.includes('♥ 9'));
    assert.ok(totalsText.includes('↻ 4'));
    assert.ok(totalsText.includes('💬 4'));

    // Deleting the grouped Like row dismisses Mastodon notifications and persists Bluesky + Threads watermarks
    const moreBtn = likeRow.querySelector('.activity-more-btn');
    const delBtn = likeRow.querySelector('.activity-action-item.is-danger');
    assert.ok(moreBtn && delBtn);
    moreBtn.click();
    delBtn.click();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(host.querySelectorAll('.activity-row--like').length, 0);
    assert.equal(dismissCalls.length, 2);

    // Re-fetching with unchanged Threads insights does not resurrect any dismissed notification
    await refreshActivityNotifications({ limit: 40, markSeen: true });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(host.querySelectorAll('.activity-row--like').length, 0);

    // New Threads likes above watermark (4 -> 6) surface cleanly with delta count
    threadsInsightLikes = 6;
    clearThreadsInsightsCacheForTests();
    await refreshActivityNotifications({ limit: 40, background: true });
    await new Promise((r) => setTimeout(r, 30));
    const newLikeRows = host.querySelectorAll('.activity-row--like');
    assert.equal(newLikeRows.length, 1);
    assert.ok(newLikeRows[0].textContent.includes('2 people on Threads'));

    // Clear all removes remaining rows and calls Mastodon clear
    const clearBtn = host.querySelector('.activity-clear-all-btn');
    assert.ok(clearBtn && !clearBtn.hidden);
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(host.querySelectorAll('.activity-row').length, 0);
    assert.ok(clearCalls >= 1);
    assert.ok(host.textContent.includes('No notifications.'));
  } finally {
    shell?.destroy();
    resetActivityStoreForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    clearThreadsInsightsCacheForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Bridge resilience: Threads 403 permission warning, 400 subcode 33 idempotency, split-post cleanup, and Bluesky updateSeen JSON', async () => {
  const prevFetch = globalThis.fetch;
  const calls = [];
  let bskyCreateIdx = 0;

  // 1. deleteThreadsPost handles 400 subcode 33 idempotently when GET returns 404
  const goneRes = await deleteThreadsPost({
    postId: 'th_gone_1',
    accessToken: 'tok',
    fetchImpl: async (url, init = {}) => {
      if ((init.method || 'GET').toUpperCase() === 'DELETE') {
        return new Response(
          JSON.stringify({ error: { message: 'Unsupported delete request', code: 100, error_subcode: 33 } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  assert.equal(goneRes?.success, true);

  // 2. updateBskyNotificationsSeen serializes JSON body properly
  let seenReq = null;
  await updateBskyNotificationsSeen({
    serviceUrl: 'https://bsky.social',
    seenAt: '2026-11-19T12:00:00.000Z',
    accessJwt: 'b_jwt',
    fetchImpl: async (url, init = {}) => {
      seenReq = { url: String(url), headers: init.headers, body: init.body };
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  assert.ok(seenReq && JSON.parse(seenReq.body).seenAt === '2026-11-19T12:00:00.000Z');

  // 3. Threads 403 surfaces threads_delete warning on editUnified & deleteUnified; overflow :part:1 split rows delete cleanly
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method });
    if (u.includes('/api/v1/statuses') && method === 'POST') {
      const parsed = JSON.parse(init.body || '{}');
      return new Response(
        JSON.stringify({
          id: 'm_split_1',
          content: `<p>${parsed.status}</p>`,
          created_at: '2026-11-19T12:00:00.000Z',
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/statuses/m_split_1') && method === 'PUT') {
      const parsed = JSON.parse(init.body || '{}');
      return new Response(
        JSON.stringify({
          id: 'm_split_1',
          content: `<p>${parsed.status}</p>`,
          created_at: '2026-11-19T12:00:00.000Z',
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/statuses/m_split_1') && method === 'DELETE') {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('com.atproto.repo.createRecord')) {
      bskyCreateIdx += 1;
      return new Response(
        JSON.stringify({ uri: `at://did:plc:alice/app.bsky.feed.post/sp_${bskyCreateIdx}`, cid: `cid_${bskyCreateIdx}` }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('com.atproto.repo.deleteRecord')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('graph.threads.net/v1.0/th_1/threads') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'th_c_sp' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.endsWith('graph.threads.net/v1.0/th_1/threads_publish') && method === 'POST') {
      return new Response(JSON.stringify({ id: 'th_sp_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('graph.threads.net/v1.0/th_sp_1') && method === 'DELETE') {
      return new Response(
        JSON.stringify({ error: { message: 'Application does not have permission for this action', code: 10 } }),
        { status: 403, headers: { 'content-type': 'application/json' } }
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

    const longText = `${'solidarity '.repeat(35).trim()} end`;
    const pub = await publishUnified({ text: longText });
    const grp = await findLocalLinkedPostGroup(pub.canonicalId);
    assert.equal(grp.length, 2);
    assert.ok(grp[1].blueskyUri.endsWith('/sp_2'));

    const ed = await editUnified('m_split_1', 'Edited short text', '', { replaceBridges: true });
    assert.ok(Array.isArray(ed._bridgeWarnings) && ed._bridgeWarnings.some((w) => w.includes('threads_delete')));
    assert.equal(ed._meta.linkedIds.threadsPostId, 'th_sp_1');

    const del = await deleteUnified('mastodon:m_split_1');
    assert.equal(calls.filter((c) => c.url.includes('com.atproto.repo.deleteRecord')).length >= 1, true);
    assert.ok(Array.isArray(del.warnings) && del.warnings.some((w) => w.includes('threads_delete')));
    assert.equal((authStore.get().retryQueue || []).some((r) => r.protocol === 'threads' && r.operation === 'delete'), true);
  } finally {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
  }
});
