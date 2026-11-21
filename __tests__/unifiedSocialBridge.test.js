import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { installMockDom } from '../__mocks__/mockDom.js';
import { detectPostLanguageInfo } from '../web/core/postLanguage.js';
import {
  applyKeywordFilters,
  canonicalizeActorHandle,
  canonicalizeUrlForDedupe,
  deduplicateAppendItems,
  deduplicateUnifiedItems,
  toUnifiedItem,
} from '../web/core/schema/unifiedItem.js';
import {
  addKeywordFilter,
  clearTranslationCacheForTests,
  deleteUnified,
  editUnified,
  enrichUnifiedItemsMetrics,
  fetchAuthorWithRelationship,
  fetchFollowConnections,
  fetchModerationAccounts,
  fetchOwnStatuses,
  fetchPostThread,
  fetchUnifiedNotifications,
  hideReplyUnified,
  likeUnified,
  normalizeAccountRecord,
  pinUnified,
  publishUnified,
  removeFollowerAccount,
  removeModeratedAccount,
  replyUnified,
  repostUnified,
  resetModerationCacheForTests,
  searchAccountsAndPosts,
  toggleBlockAuthor,
  translateUnifiedPost,
} from '../web/queries/socialClient.js';
import { cleanMastodonMediaUrl, getLemmyLocalPosts, normalizeMastodonStatus, renderProfileLinksAndFields } from '../web/queries/fediverse.js';
import { normalizeBskyPost } from '../web/queries/bluesky.js';
import { createAppShell } from '../web/app/_layout.js';
import { mountActivityScreen } from '../web/app/activity.js';
import { mountComposeModal, publishOrganicPost } from '../web/app/composeModal.js';
import { mountFeedScreen } from '../web/app/feed.js';
import { renderPostThreadView } from '../web/app/postThread.js';
import { mountProfileScreen, openEditMastodonProfileModal, openEditPostDialog } from '../web/app/profile.js';
import { composeStore, resetCompose } from '../web/state/composeStore.js';
import { mountSearchScreen } from '../web/app/search.js';
import { openAuthorSheetModal } from '../web/components/AuthorSheetModal.js';
import { createPostCard, getPostActionCapabilities, resolvePostBadgeProtocols, syncPostCardReactions } from '../web/components/PostCard.js';
import { openFeedTuningModal } from '../web/components/FeedTuningModal.js';
import { openFollowGraphModal } from '../web/components/FollowGraphModal.js';
import { openThreadsImportModal } from '../web/components/ThreadsImportModal.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { openUserModal } from '../web/components/sanctuary/UserModal.js';
import { createLoadingState, updateLoadingStateLabel } from '../web/components/ui/index.js';
import {
  DEFAULT_FEED_TUNING,
  FEED_TUNING_PRESETS,
  computeFeedbackSliderNudge,
  extractLearnedTasteTopics,
  isDefaultFeedTuning,
  normalizeFeedTuning,
  rankFeedItems,
  scoreConversationVelocity,
  scorePersonalTasteLexical,
} from '../web/core/feedRanker.js';
import {
  DEFAULT_SANCTUARY_CHANNELS,
  DEFAULT_SANCTUARY_INSTANCES,
  clearHarvesterCacheForTests,
  conceptToHashtag,
  fetchDiscoveryInstanceTimeline,
  harvestSanctuaryFeed,
} from '../web/queries/feedHarvester.js';
import { clearLinkPreviewCacheForTests, extractFirstHttpsUrl, parseVideoEmbedInfo } from '../web/queries/linkPreview.js';
import { cleanThreadsAuthCode, clearThreadsInsightsCacheForTests, publishThreadsPost } from '../web/queries/threads.js';
import {
  buildMastodonImportCsv,
  clearThreadsImportStateForTests,
  decodeMetaMojibake,
  parseThreadsArchiveBuffer,
  startThreadsArchiveSync,
} from '../web/queries/threadsArchive.js';
import {
  activityStore,
  groupActivityNotifications,
  refreshActivityNotifications,
  resetActivityStoreForTests,
} from '../web/state/activityStore.js';
import { authStore, getAuthenticatedAccount, resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import {
  appendStreamItems,
  clearLearnedTasteMemory,
  feedStore,
  hydrateCachedModeration,
  hydrateFeedTuning,
  persistStreamCache,
  reconcileEnrichedStreamItems,
  recordAuthorInteraction,
  recordBehavioralSignal,
  resetFeedStoreForTests,
  setFilterRules,
  setStreamItems,
  setTasteScores,
  updateFeedTuning,
} from '../web/state/feedStore.js';
import {
  enqueueLocalRetry,
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

test('Bluesky author data resolves via native XRPC and upgrades Bridgy handles', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;

  globalThis.fetch = async (url) => {
    const u = String(url);
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
    const sheet = openAuthorSheetModal({
      author: { id: 'masto_bridged_99', handle: 'ruralanarchy.bsky.social@bsky.brid.gy', name: 'Rural Anarchy' },
    });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(sheet.dialog.textContent.includes('10,998 Followers'));
    assert.ok(sheet.dialog.textContent.includes('Morning bird watch'));
    sheet.close();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Centralized Connections modal merges Mastodon & Bluesky with Bridgy dedupe, falls back to public.api.bsky.app on 401, and Own Profile sums counts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevLoc = globalThis.location;
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
    globalThis.location = prevLoc;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('renderPostThreadView loads Bluesky replies with public fallback, preserves nested reply root refs, and supports inline replies', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevLoc = globalThis.location;
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
    if (u.includes('/api/v1/timelines/public') || u.includes('/api/v1/timelines/tag/')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('app.bsky.feed.getFeed')) {
      assert.equal(u.includes('whats-hot'), false, 'Default Feed must never call Bluesky whats-hot');
      if (!u.includes('aaagjqttv5lhi') && !u.includes('aaagd5qfrout4') && !u.includes('aaadx3mkuxx7i')) {
        return new Response(JSON.stringify({ feed: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
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

    // Add Discovery Channel & Instance chips and verify PUT payload + removal
    const chanInput = dlg.querySelector('#feed-channel-input');
    chanInput.value = 'cooperatives';
    chanInput.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));

    const instInput = dlg.querySelector('#feed-instance-input');
    instInput.value = 'https://kolektiva.social/';
    instInput.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));

    assert.deepEqual(feedStore.get().tuning.discoveryChannels, ['cooperatives']);
    assert.deepEqual(feedStore.get().tuning.discoveryInstances, ['kolektiva.social']);
    assert.deepEqual(savedBodies.at(-1).discoveryChannels, ['cooperatives']);
    assert.deepEqual(savedBodies.at(-1).discoveryInstances, ['kolektiva.social']);

    // Non-clobbering check when remote legacy /api/feed_profile omits discoveryChannels/discoveryInstances
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/feed_profile') && init.method === 'PUT') {
        const body = JSON.parse(init.body || '{}');
        return new Response(
          JSON.stringify({
            version: 1,
            updatedAt: Date.now(),
            updatedBy: 'user',
            sliders: body.sliders,
            boostConcepts: body.boostConcepts,
            dampenConcepts: body.dampenConcepts,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await updateFeedTuning({ sliders: { smallWeb: 80 } });
    assert.deepEqual(feedStore.get().tuning.discoveryChannels, ['cooperatives']);
    assert.deepEqual(feedStore.get().tuning.discoveryInstances, ['kolektiva.social']);

    // Remove channel chip cleanly
    dlg.querySelector('button[aria-label="Remove channel cooperatives"]').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.deepEqual(feedStore.get().tuning.discoveryChannels, []);

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

test('Threads 4279009 container lag recovery, unified cross-platform thread replies, Threads comment hide/block, and per-bridge edit controls', async () => {
  // 1. publishThreadsPost survives transient 400 error_subcode 4279009 on container status, publish, and reply_to_id creation
  let lagStatusHits = 0;
  let lagPubHits = 0;
  let lagReplyCreateHits = 0;
  const lagFetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.endsWith('/th_u/threads') && method === 'POST') {
      const bodyStr = init.body?.toString?.() || '';
      if (bodyStr.includes('reply_to_id=th_root_1') && lagReplyCreateHits === 0) {
        lagReplyCreateHits += 1;
        return new Response(
          JSON.stringify({
            error: {
              message: 'The requested resource does not exist',
              code: 24,
              error_subcode: 4279009,
              error_user_msg: 'The media with id th_root_1 cannot be found.',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ id: bodyStr.includes('reply_to_id=') ? 'c_lag_2' : 'c_lag_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/v1.0/c_lag_1?') && method === 'GET') {
      lagStatusHits += 1;
      if (lagStatusHits === 1) {
        return new Response(
          JSON.stringify({ error: { message: 'The requested resource does not exist', code: 24, error_subcode: 4279009 } }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ id: 'c_lag_1', status: 'FINISHED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.endsWith('/th_u/threads_publish') && method === 'POST') {
      const bodyStr = init.body?.toString?.() || '';
      if (bodyStr.includes('creation_id=c_lag_1') && lagPubHits === 0) {
        lagPubHits += 1;
        return new Response(
          JSON.stringify({
            error: {
              message: 'The requested resource does not exist',
              code: 24,
              error_subcode: 4279009,
              error_user_msg: 'The media with id c_lag_1 cannot be found.',
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(JSON.stringify({ id: bodyStr.includes('c_lag_2') ? 'th_child_2' : 'th_root_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const p1 = await publishThreadsPost({ userId: 'th_u', accessToken: 'tok', text: 'Part 1', pollDelayMs: 0, fetchImpl: lagFetch });
  const p2 = await publishThreadsPost({ userId: 'th_u', accessToken: 'tok', text: 'Part 2', replyToId: p1.id, pollDelayMs: 0, fetchImpl: lagFetch });
  assert.equal(p1.id, 'th_root_1');
  assert.equal(p2.id, 'th_child_2');

  // 2. fetchPostThread merges Mastodon + Bluesky + Threads replies, notification targets root post, hide/block purges comments & notifications
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const modCalls = [];
  let hiddenRepliesState = false;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/api/v1/statuses/m_uni_1/context')) {
      return new Response(
        JSON.stringify({
          ancestors: [],
          descendants: [
            {
              id: 'm_rep_1',
              in_reply_to_id: 'm_uni_1',
              created_at: '2026-11-19T14:01:00.000Z',
              content: '<p>Mastodon reply</p>',
              account: { id: 'f1', username: 'fedi_pal', acct: 'fedi_pal@fosstodon.org', display_name: 'Fedi Pal' },
              media_attachments: [],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/statuses/m_uni_1') && method === 'PUT') {
      const parsed = JSON.parse(init.body || '{}');
      return new Response(
        JSON.stringify({
          id: 'm_uni_1',
          created_at: '2026-11-19T14:00:00.000Z',
          content: `<p>${parsed.status}</p>`,
          account: { id: 'u_me', username: 'davy', acct: 'davy@mastodon.social', display_name: 'Davy' },
          media_attachments: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/statuses/m_uni_1')) {
      return new Response(
        JSON.stringify({
          id: 'm_uni_1',
          created_at: '2026-11-19T14:00:00.000Z',
          content: '<p>Root crosspost</p>',
          account: { id: 'u_me', username: 'davy', acct: 'davy@mastodon.social', display_name: 'Davy' },
          media_attachments: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/notifications')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('app.bsky.notification.listNotifications')) {
      return new Response(JSON.stringify({ notifications: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('app.bsky.feed.getPostThread')) {
      return new Response(
        JSON.stringify({
          thread: {
            post: {
              uri: 'at://did:plc:me/app.bsky.feed.post/b_uni_1',
              cid: 'c_b1',
              author: { did: 'did:plc:me', handle: 'davy.bsky.social', displayName: 'Davy' },
              record: { text: 'Root crosspost', createdAt: '2026-11-19T14:00:00.000Z' },
              likeCount: 2,
              repostCount: 0,
              replyCount: 1,
            },
            replies: [
              {
                post: {
                  uri: 'at://did:plc:bskyfan/app.bsky.feed.post/b_rep_1',
                  cid: 'c_br1',
                  author: { did: 'did:plc:bskyfan', handle: 'bskyfan.bsky.social', displayName: 'Bsky Fan' },
                  record: { text: 'Bluesky reply', createdAt: '2026-11-19T14:02:00.000Z' },
                },
                replies: [],
              },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.getPosts')) {
      return new Response(JSON.stringify({ posts: [{ uri: 'at://did:plc:me/app.bsky.feed.post/b_uni_1', likeCount: 2, repostCount: 0, replyCount: 1 }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('com.atproto.repo.deleteRecord') || u.includes('com.atproto.repo.createRecord')) {
      modCalls.push({ kind: 'bsky_op', url: u, method });
      return new Response(JSON.stringify({ uri: 'at://did:plc:me/app.bsky.feed.post/b_uni_2', cid: 'c_b2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('graph.threads.net/v1.0/th_uni_1/conversation') || u.includes('graph.threads.net/v1.0/th_uni_1/replies')) {
      return new Response(
        JSON.stringify({
          data: hiddenRepliesState
            ? []
            : [
                {
                  id: 'th_rep_bad',
                  username: 'bad_troll',
                  text: 'Stupid troll comment',
                  timestamp: '2026-11-19T14:03:00.000Z',
                  replied_to: { id: 'th_uni_1' },
                },
                {
                  id: 'th_rep_nice',
                  username: 'nice_pal',
                  text: 'Great point on Threads',
                  timestamp: '2026-11-19T14:04:00.000Z',
                  replied_to: { id: 'th_uni_1' },
                },
              ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/th_uni_1/insights')) {
      return new Response(JSON.stringify({ data: [{ name: 'likes', values: [{ value: 1 }] }, { name: 'replies', values: [{ value: 2 }] }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('graph.threads.net/v1.0/th_uni_1?')) {
      return new Response(
        JSON.stringify({ id: 'th_uni_1', username: 'davy', text: 'Root crosspost', timestamp: '2026-11-19T14:00:00.000Z' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/manage_reply') && method === 'POST') {
      modCalls.push({ kind: 'manage_reply', url: u, body: init.body?.toString?.() || '' });
      hiddenRepliesState = true;
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/accounts/lookup') && u.includes('bad_troll')) {
      return new Response(JSON.stringify({ id: 'fed_bt_1', username: 'bad_troll', acct: 'bad_troll@threads.net' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/v1/accounts/fed_bt_1/block') && method === 'POST') {
      modCalls.push({ kind: 'masto_block', url: u });
      return new Response(JSON.stringify({ id: 'fed_bt_1', blocking: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('graph.threads.net/v1.0/th_uni_1') && method === 'DELETE') {
      modCalls.push({ kind: 'threads_delete', url: u });
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();

    await upsertSocialAccount(
      { id: 'fediverse:davy@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'davy', acct: 'davy@mastodon.social', userId: 'u_me' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:me', handle: 'davy.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );
    await upsertSocialAccount(
      { id: 'threads:th_u_1', platform: 'threads', userId: 'th_u_1', handle: 'davy', acct: 'davy' },
      { accessToken: 't_tok' }
    );

    await saveLocalLinkedPost({
      canonicalId: 'mastodon:m_uni_1',
      mastodonStatusId: 'm_uni_1',
      mastodonInstance: 'https://mastodon.social',
      blueskyUri: 'at://did:plc:me/app.bsky.feed.post/b_uni_1',
      blueskyCid: 'c_b1',
      threadsPostId: 'th_uni_1',
    });

    const ctx = await fetchPostThread({
      id: 'mastodon:m_uni_1',
      protocol: 'mastodon',
      content_text: 'Root crosspost',
      _meta: {
        mastodon: { statusId: 'm_uni_1', instanceUrl: 'https://mastodon.social' },
        linkedIds: {
          mastodonStatusId: 'm_uni_1',
          blueskyUri: 'at://did:plc:me/app.bsky.feed.post/b_uni_1',
          threadsPostId: 'th_uni_1',
        },
      },
    });
    const descIds = ctx.descendants.map((d) => d.item.id);
    assert.ok(descIds.includes('mastodon:m_rep_1'));
    assert.ok(descIds.includes('bluesky:at://did:plc:bskyfan/app.bsky.feed.post/b_rep_1'));
    assert.ok(descIds.includes('threads:th_rep_bad'));
    assert.ok(descIds.includes('threads:th_rep_nice'));

    // Activity reply notification targeting unified Mastodon root post
    const { items: notifItems } = await fetchUnifiedNotifications({ limit: 20 });
    const badNotif = notifItems.find((n) => n.id === 'threads:notif:th_rep_bad');
    assert.ok(badNotif && badNotif._meta.notification.canonicalPostKey === 'mastodon:m_uni_1');
    const grouped = groupActivityNotifications(notifItems);
    const badGroup = grouped.find((g) => g.primaryItem?.id === 'threads:notif:th_rep_bad');
    assert.equal(badGroup.threadTargetItem.id, 'mastodon:m_uni_1');
    assert.equal(badGroup.threadTargetItem._meta.focusReplyId, 'threads:notif:th_rep_bad');

    // Render postThread view: Hide Comment + Block Account on Threads commenter
    const threadStage = dom.document.createElement('div');
    dom.document.body.appendChild(threadStage);
    const threadCtrl = renderPostThreadView(threadStage, {
      post: badGroup.threadTargetItem,
    });
    await new Promise((r) => setTimeout(r, 30));

    const replyCards = [...threadStage.querySelectorAll('.thread-reply-item .post-card')];
    const badCard = replyCards.find((c) => c.dataset.postId === 'threads:th_rep_bad');
    assert.ok(badCard, 'Threads reply card should render inside unified Mastodon thread');
    const menuItems = [...badCard.querySelectorAll('.post-context-menuitem')].map((b) => b.textContent);
    assert.ok(menuItems.includes('Hide Comment'));
    assert.ok(menuItems.includes('Block Account'));

    await toggleBlockAuthor('bad_troll', false, {
      protocol: 'threads',
      acct: 'bad_troll',
      displayName: 'bad_troll',
      replyPostId: 'th_rep_bad',
    });
    assert.ok(modCalls.some((c) => c.kind === 'manage_reply' && c.url.includes('th_rep_bad')));
    assert.ok(modCalls.some((c) => c.kind === 'masto_block'));
    assert.ok((feedStore.get().moderatedActors || []).includes('threads:bad_troll'));

    await refreshActivityNotifications({ limit: 20 });
    assert.equal(
      (activityStore.get().items || []).some((it) => it?.author?.handle === 'bad_troll'),
      false
    );

    const ctxAfter = await fetchPostThread('mastodon:m_uni_1');
    assert.equal(ctxAfter.descendants.some((d) => d.item.id === 'threads:th_rep_bad'), false);
    threadCtrl.destroy();

    // Per-bridge toggles in openEditPostDialog: unchecking Threads replaces only Bluesky
    modCalls.length = 0;
    const savedSelective = await new Promise((resolve) => {
      openEditPostDialog(
        toUnifiedItem({
          id: 'mastodon:m_uni_1',
          protocol: 'mastodon',
          content_text: 'Root crosspost',
          _meta: {
            mastodon: { statusId: 'm_uni_1' },
            linkedIds: {
              mastodonStatusId: 'm_uni_1',
              blueskyUri: 'at://did:plc:me/app.bsky.feed.post/b_uni_1',
              threadsPostId: 'th_uni_1',
            },
          },
        }),
        { onSaved: resolve }
      );
      const dlg = dom.document.getElementById('edit-post-dialog');
      const bskyCb = dlg.querySelector('#edit-post-replace-bluesky');
      const thrCb = dlg.querySelector('#edit-post-replace-threads');
      assert.ok(bskyCb?.checked && thrCb?.checked);
      thrCb.checked = false;
      thrCb.dispatchEvent(new Event('change', { bubbles: true }));
      dlg.querySelector('textarea').value = 'Edited only Mastodon and Bluesky';
      dlg.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    assert.equal(savedSelective.content_text, 'Edited only Mastodon and Bluesky');
    assert.ok(modCalls.some((c) => c.kind === 'bsky_op' && c.url.includes('createRecord')));
    assert.equal(modCalls.some((c) => c.kind === 'threads_delete'), false);
    assert.equal(savedSelective._meta.linkedIds.threadsPostId, 'th_uni_1');
  } finally {
    resetMemoryStorageForTests();
    resetActivityStoreForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Sovereign Sanctuary Feed harvester replaces whats-hot with topic/instance discovery and enforces dialectical anti-hegemonic sieve', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  clearHarvesterCacheForTests();
  const fetchedUrls = [];
  const nowIso = new Date().toISOString();

  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);

    if (u.includes('whats-hot') || u.includes('/trends/statuses')) {
      throw new Error(`Forbidden mainstream algorithmic endpoint called: ${u}`);
    }
    if (u.includes('example-coop.social/api/v1/timelines/tag/cooperatives')) {
      return new Response(
        JSON.stringify([
          {
            id: 'm_marx_1',
            content: '<p>Democrats, Republicans, and neoliberal capitalism cannot reform away wage-slavery while private owners control the means of production. Build worker cooperatives and class struggle.</p>',
            created_at: nowIso,
            account: { id: 'u_coop', username: 'bakery', acct: 'bakery@example-coop.social', display_name: 'Bakery Collective' },
            favourites_count: 14,
            reblogs_count: 3,
            replies_count: 2,
          },
          {
            id: 'm_nyt_1',
            content: '<p>Must-read column on bipartisan Senate strategy https://www.nytimes.com/story</p>',
            created_at: nowIso,
            account: { id: 'u_nyt', username: 'beltway', acct: 'beltway@example-coop.social', display_name: 'Beltway' },
            card: { url: 'https://www.nytimes.com/2026/11/story.html', title: 'Senate moderates negotiate' },
            favourites_count: 5,
            reblogs_count: 1,
            replies_count: 0,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('kolektiva.social/api/v1/timelines/public')) {
      return new Response(
        JSON.stringify([
          {
            id: 'm_kol_1',
            content: '<p>Mutual aid tool library opened three blocks from the union hall.</p>',
            created_at: nowIso,
            account: { id: 'u_k1', username: 'solidarity', acct: 'solidarity@kolektiva.social', display_name: 'Solidarity' },
            favourites_count: 9,
            reblogs_count: 2,
            replies_count: 1,
          },
          {
            id: 'm_psyop_1',
            content: '<p>Anyone criticizing NATO rules-based international order is just tankies defending authoritarian regimes.</p>',
            created_at: nowIso,
            account: { id: 'u_p1', username: 'nafo_guy', acct: 'nafo@kolektiva.social', display_name: 'NAFO' },
            favourites_count: 40,
            reblogs_count: 5,
            replies_count: 0,
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.getFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:b1/app.bsky.feed.post/comm_1',
                cid: 'c1',
                author: { did: 'did:plc:b1', handle: 'union.bsky.social', displayName: 'Shop Steward' },
                record: { text: 'Rank-and-file shop stewards ratified a democratic strike fund.', createdAt: nowIso },
                likeCount: 18,
                repostCount: 4,
                replyCount: 2,
              },
            },
            {
              post: {
                uri: 'at://did:plc:b2/app.bsky.feed.post/dunk_1',
                cid: 'c2',
                author: { did: 'did:plc:b2', handle: 'dunk.bsky.social', displayName: 'Dunker' },
                record: {
                  text: 'Imagine believing this lmao',
                  createdAt: nowIso,
                  embed: {
                    $type: 'app.bsky.embed.record',
                    record: { uri: 'at://did:plc:other/app.bsky.feed.post/q1', cid: 'cq1' },
                  },
                },
                embed: {
                  $type: 'app.bsky.embed.record#view',
                  record: {
                    $type: 'app.bsky.embed.record#viewRecord',
                    uri: 'at://did:plc:other/app.bsky.feed.post/q1',
                    author: { handle: 'other.bsky.social', displayName: 'Other' },
                    value: { text: 'Original post' },
                  },
                },
                likeCount: 1200,
                repostCount: 240,
                replyCount: 45,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.searchPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:b3/app.bsky.feed.post/search_1',
              cid: 'c3',
              author: { did: 'did:plc:b3', handle: 'praxis.bsky.social', displayName: 'Praxis Notes' },
              record: { text: 'Historical materialism starts from concrete conditions rather than woke mind virus slogans.', createdAt: nowIso },
              likeCount: 7,
              repostCount: 1,
              replyCount: 0,
            },
            {
              uri: 'at://did:plc:b4/app.bsky.feed.post/search_2',
              cid: 'c4',
              author: { did: 'did:plc:b4', handle: 'craft.bsky.social', displayName: 'Coop Foundry' },
              record: { text: 'Open-source lathe controller firmware released for community maker spaces.', createdAt: nowIso },
              likeCount: 11,
              repostCount: 2,
              replyCount: 1,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();

    await upsertSocialAccount(
      { id: 'fediverse:me@example-coop.social', platform: 'fediverse', instanceUrl: 'https://example-coop.social', handle: 'me', acct: 'me@example-coop.social', userId: 'u_me' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', handle: 'me.bsky.social', acct: 'me.bsky.social', did: 'did:plc:me' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );
    await updateFeedTuning({
      sliders: { recencyHalfLifeHours: 10, smallWeb: 80, bourgeoisPolitics: -100, commercial: -100 },
      discoveryChannels: ['cooperatives'],
      discoveryInstances: ['kolektiva.social'],
      boostConcepts: ['class struggle', 'worker cooperatives'],
      dampenConcepts: ['Democrats', 'Republicans', 'neoliberal capitalism'],
    }, { syncRemote: false });

    // Direct harvester verification
    const harvested = await harvestSanctuaryFeed({
      fediAuth: await getAuthenticatedAccount('fediverse'),
      bskyAuth: await getAuthenticatedAccount('bluesky'),
      tuning: feedStore.get().tuning,
    });
    const harvestedTexts = harvested.items.map((p) => p.content_text);
    assert.ok(harvestedTexts.some((t) => t.includes('means of production')));
    assert.ok(harvestedTexts.some((t) => t.includes('Mutual aid tool library')));
    assert.ok(harvestedTexts.some((t) => t.includes('democratic strike fund')));
    assert.ok(harvestedTexts.some((t) => t.includes('Open-source lathe controller')));
    // Strip NYT, NAFO/tankie psyop, reactionary woke mind virus, and viral quote-dunk
    assert.equal(harvestedTexts.some((t) => t.includes('nytimes') || t.includes('Senate')), false);
    assert.equal(harvestedTexts.some((t) => t.includes('rules-based')), false);
    assert.equal(harvestedTexts.some((t) => t.includes('woke mind virus')), false);
    assert.equal(harvestedTexts.some((t) => t.includes('Imagine believing')), false);

    assert.equal(fetchedUrls.some((u) => u.includes('whats-hot') || u.includes('/trends/statuses')), false);
    assert.ok(fetchedUrls.some((u) => u.includes('/api/v1/timelines/tag/cooperatives')));
    assert.ok(fetchedUrls.some((u) => u.includes('kolektiva.social/api/v1/timelines/public')));
    assert.ok(fetchedUrls.some((u) => u.includes('app.bsky.feed.getFeed')));
    assert.ok(fetchedUrls.some((u) => u.includes('app.bsky.feed.searchPosts')));

    // Full Feed screen preserves the Marxist critique post even with bourgeoisPolitics: -100 and dampening Democrats/Republicans
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);
    await new Promise((r) => setTimeout(r, 60));

    assert.ok(host.textContent.includes('means of production'), 'Marxist critique must pass dialectical exemption and rank cleanly');
    assert.ok(host.textContent.includes('Mutual aid tool library'));
    assert.equal(host.textContent.includes('Senate strategy'), false);
    assert.equal(host.textContent.includes('rules-based'), false);
  } finally {
    feedCtrl?.destroy();
    clearHarvesterCacheForTests();
    resetMemoryStorageForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('UserModal formats Threads 5258005 refresh errors and shell.css enforces modal text containment', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('refresh_access_token')) {
      return new Response(
        JSON.stringify({
          error: {
            message: 'API access blocked.',
            code: 200,
            type: 'OAuthException',
            error_subcode: 5258005,
            fbtrace_id: 'A_V9nKjl9qQa06wFPx_F164',
          },
        }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let modal = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    await upsertSocialAccount(
      {
        id: 'threads:th_err_1',
        platform: 'threads',
        userId: 'th_err_1',
        handle: 'davy_threads',
        acct: 'davy_threads',
        expiresAt: Date.now() + 59 * 86_400_000,
      },
      { accessToken: 'fresh_60d_tok' }
    );
    await enqueueLocalRetry({
      id: 'retry_th_1',
      protocol: 'threads',
      operation: 'publish',
      lastError:
        'Threads token refresh failed (400): {"error":{"message":"API access blocked.","code":200,"type":"OAuthException","error_subcode":5258005,"fbtrace_id":"A_V9nKjl9qQa06wFPx_F164"}}',
    });

    modal = openUserModal();
    await new Promise((r) => setTimeout(r, 20));

    const retrySub = modal.dialog.querySelector('.retry-error-subtext');
    assert.ok(retrySub);
    assert.equal(
      retrySub.textContent,
      'Threads token refresh failed (400): API access blocked. 60-day tokens must be at least 24 hours old before refreshing.'
    );
    assert.equal(retrySub.textContent.includes('fbtrace_id'), false);

    const refreshBtn = modal.dialog.querySelector('.threads-refresh-token-btn');
    assert.ok(refreshBtn);
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    const feedback = modal.dialog.querySelector('.user-modal-feedback');
    assert.ok(feedback);
    assert.equal(feedback.hidden, false);
    assert.equal(
      feedback.textContent,
      'API access blocked. 60-day tokens must be at least 24 hours old before refreshing.'
    );
    assert.equal(feedback.textContent.includes('fbtrace_id'), false);
    assert.equal(feedback.textContent.includes('{"error"'), false);

    const css = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/shell.css'), 'utf8');
    const modalStatusBlock = css.slice(css.indexOf('.classic-modal-status {'), css.indexOf('.classic-section-label'));
    assert.ok(modalStatusBlock.includes('overflow-wrap: anywhere;'));
    const feedbackBlock = css.slice(css.indexOf('.user-modal-feedback {'), css.indexOf('.account-connected-row'));
    assert.ok(feedbackBlock.includes('overflow-wrap: anywhere;'));
    assert.ok(feedbackBlock.includes('min-inline-size: 0;'));
    assert.ok(feedbackBlock.includes('max-inline-size: 100%;'));
    const retryBannerBlock = css.slice(css.indexOf('.bridge-retry-msg {'), css.indexOf('.search-landmark'));
    assert.ok(retryBannerBlock.includes('overflow-wrap: break-word;'));
    assert.ok(retryBannerBlock.includes('min-inline-size: 0;'));
    const composeStatusBlock = css.slice(css.indexOf('.modal-card.compose-sheet-card p.compose-status-msg {'), css.indexOf('.compose-footer-left'));
    assert.ok(composeStatusBlock.includes('overflow-wrap: break-word;'));
  } finally {
    modal?.close();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Profile screen replaces Pinned tab with Boosts (merging Mastodon + Bluesky) and pins posts to top of Posts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const calls = [];
  let p2Pinned = false;
  let mastoUnboosted = false;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    calls.push({ url: u, method, body: init.body });

    if (u.includes('/api/v1/accounts/verify_credentials')) {
      return new Response(
        JSON.stringify({
          id: 'u1',
          username: 'alice',
          acct: 'alice',
          display_name: 'Alice',
          note: '<p>Worker coop builder</p>',
          followers_count: 10,
          following_count: 5,
          statuses_count: 12,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/statuses/p_own_2/pin')) {
      p2Pinned = true;
      return new Response(
        JSON.stringify({
          id: 'p_own_2',
          pinned: true,
          content: '<p>Latest thought</p>',
          created_at: '2026-11-20T10:00:00.000Z',
          account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/statuses/rb_target_1/unreblog')) {
      mastoUnboosted = true;
      return new Response(
        JSON.stringify({
          id: 'rb_target_1',
          reblogged: false,
          reblogs_count: 4,
          content: '<p>Mastodon Boosted Post</p>',
          created_at: '2026-11-18T08:00:00.000Z',
          account: { id: 'other_m1', username: 'comrade', acct: 'comrade@mas.to', display_name: 'Comrade' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/accounts/u1/statuses')) {
      const parsed = new URL(u);
      if (parsed.searchParams.get('pinned') === 'true') {
        const pinnedRows = [
          {
            id: 'p_pin_1',
            pinned: true,
            content: '<p>Pinned manifesto</p>',
            created_at: '2026-11-10T10:00:00.000Z',
            account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
          },
        ];
        if (p2Pinned) {
          pinnedRows.push({
            id: 'p_own_2',
            pinned: true,
            content: '<p>Latest thought</p>',
            created_at: '2026-11-20T10:00:00.000Z',
            account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
          });
        }
        return new Response(JSON.stringify(pinnedRows), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (parsed.searchParams.get('only_media') === 'true') {
        return new Response(
          JSON.stringify([
            {
              id: 'p_media_1',
              content: '<p>Authored photo</p>',
              created_at: '2026-11-19T12:00:00.000Z',
              account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
              media_attachments: [{ id: 'm1', type: 'image', url: 'https://cdn.example/own.jpg', preview_url: 'https://cdn.example/own.jpg' }],
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (parsed.searchParams.get('exclude_replies') === 'true') {
        return new Response(
          JSON.stringify([
            {
              id: 'p_own_2',
              pinned: p2Pinned,
              content: '<p>Latest thought</p>',
              created_at: '2026-11-20T10:00:00.000Z',
              account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
            },
            {
              id: 'p_pin_1',
              pinned: true,
              content: '<p>Pinned manifesto</p>',
              created_at: '2026-11-10T10:00:00.000Z',
              account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (parsed.searchParams.get('exclude_reblogs') === 'true') {
        return new Response(
          JSON.stringify([
            {
              id: 'p_rep_1',
              in_reply_to_id: 'other_post_9',
              content: '<p>Mastodon reply note</p>',
              created_at: '2026-11-20T08:30:00.000Z',
              account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
            },
            {
              id: 'p_own_2',
              content: '<p>Latest thought</p>',
              created_at: '2026-11-20T10:00:00.000Z',
              account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify([
          {
            id: 'p_own_2',
            content: '<p>Latest thought</p>',
            created_at: '2026-11-20T10:00:00.000Z',
            account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
          },
          ...(mastoUnboosted
            ? []
            : [
                {
                  id: 'wrap_m1',
                  created_at: '2026-11-20T11:30:00.000Z',
                  account: { id: 'u1', username: 'alice', acct: 'alice@mastodon.social', display_name: 'Alice' },
                  reblog: {
                    id: 'rb_target_1',
                    content: '<p>Mastodon Boosted Post</p>',
                    created_at: '2026-11-18T08:00:00.000Z',
                    reblogged: true,
                    reblogs_count: 5,
                    account: { id: 'other_m1', username: 'comrade', acct: 'comrade@mas.to', display_name: 'Comrade' },
                  },
                },
              ]),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.feed.getAuthorFeed')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:other/app.bsky.feed.post/b1',
                cid: 'c_b1',
                record: { text: 'Bluesky Reposted Post', createdAt: '2026-11-19T05:00:00.000Z' },
                author: { did: 'did:plc:other', handle: 'friend.bsky.social', displayName: 'Friend' },
                viewer: { repost: 'at://did:plc:self_bsky/app.bsky.feed.repost/rp1' },
                repostCount: 3,
              },
              reason: {
                by: { did: 'did:plc:self_bsky', handle: 'alice.bsky.social', displayName: 'Alice' },
                indexedAt: '2026-11-20T12:00:00.000Z',
                uri: 'at://did:plc:self_bsky/app.bsky.feed.repost/rp1',
              },
            },
            {
              post: {
                uri: 'at://did:plc:self_bsky/app.bsky.feed.post/brep1',
                cid: 'c_rep1',
                record: {
                  text: 'Bluesky Reply Note',
                  createdAt: '2026-11-20T09:00:00.000Z',
                  reply: { parent: { uri: 'at://did:plc:x/app.bsky.feed.post/p0' } },
                },
                author: { did: 'did:plc:self_bsky', handle: 'alice.bsky.social', displayName: 'Alice' },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.actor.getProfile')) {
      return new Response(
        JSON.stringify({ did: 'did:plc:self_bsky', handle: 'alice.bsky.social', followersCount: 2, followsCount: 3 }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }

    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let profCtrl = null;
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
        id: 'bluesky:did:plc:self_bsky',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'alice.bsky.social',
        acct: 'alice.bsky.social',
        did: 'did:plc:self_bsky',
      },
      { accessJwt: 'jwt_self', refreshJwt: 'ref_self' }
    );

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    profCtrl = mountProfileScreen(host, {});
    await new Promise((r) => setTimeout(r, 40));

    // Accessible tablist/tab/tabpanel semantics with Boosts instead of Pinned
    const tablist = host.querySelector('.profile-sub-tabs');
    assert.equal(tablist.getAttribute('role'), 'tablist');
    assert.equal(tablist.getAttribute('focusgroup'), 'tablist nomemory');
    const tabs = Array.from(tablist.querySelectorAll('[role="tab"]'));
    assert.deepEqual(tabs.map((t) => t.textContent), ['Posts', 'Replies', 'Media', 'Boosts']);
    assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
    assert.equal(tabs[3].getAttribute('aria-selected'), 'false');

    const panel = host.querySelector('.profile-posts-list');
    assert.equal(panel.getAttribute('role'), 'tabpanel');
    assert.equal(panel.getAttribute('aria-labelledby'), 'profile-tab-posts');

    // Keyboard arrow navigation moves focus across tabs without auto-fetching
    tabs[0].focus();
    tabs[0].dispatchEvent(Object.assign(new Event('keydown', { bubbles: true }), { key: 'ArrowRight' }));
    assert.equal(doc.activeElement, tabs[1]);
    tabs[1].dispatchEvent(Object.assign(new Event('keydown', { bubbles: true }), { key: 'End' }));
    assert.equal(doc.activeElement, tabs[3]);

    // Posts tab places Pinned manifesto first even though Latest thought is newer
    let cards = Array.from(panel.querySelectorAll('article.post-card'));
    assert.equal(cards.length, 2);
    assert.ok(cards[0].textContent.includes('Pinned post'));
    assert.ok(cards[0].textContent.includes('Pinned manifesto'));
    assert.ok(cards[1].textContent.includes('Latest thought'));

    // Pinning Latest thought updates card banner live on Posts
    const pinItemBtn = Array.from(cards[1].querySelectorAll('.post-context-menuitem')).find((b) =>
      b.textContent.includes('Pin to Profile')
    );
    assert.ok(pinItemBtn);
    pinItemBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    cards = Array.from(panel.querySelectorAll('article.post-card'));
    assert.ok(cards.every((c) => c.textContent.includes('Pinned post')));

    // Replies tab merges Mastodon + Bluesky replies and excludes non-reply posts
    tabs[1].click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
    assert.equal(panel.getAttribute('aria-labelledby'), 'profile-tab-replies');
    assert.ok(panel.textContent.includes('Bluesky Reply Note'));
    assert.ok(panel.textContent.includes('Mastodon reply note'));
    assert.equal(panel.textContent.includes('Latest thought'), false);

    // Media tab shows authored media only
    tabs[2].click();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(panel.textContent.includes('Authored photo'));

    // Boosts tab merges Bluesky reposts + Mastodon boosts ordered newest-boosted first
    tabs[3].click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(panel.getAttribute('aria-labelledby'), 'profile-tab-boosts');
    const boostCards = Array.from(panel.querySelectorAll('article.post-card'));
    assert.equal(boostCards.length, 2);
    assert.ok(boostCards[0].textContent.includes('Bluesky Reposted Post'));
    assert.ok(boostCards[1].textContent.includes('Mastodon Boosted Post'));
    assert.equal(panel.textContent.includes('Latest thought'), false);

    // Unboosting Mastodon boost removes it immediately from the Boosts tab
    boostCards[1].querySelector('.post-action-repost').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(calls.some((c) => c.url.includes('/api/v1/statuses/rb_target_1/unreblog')));
    assert.equal(panel.querySelectorAll('article.post-card').length, 1);
    assert.equal(panel.textContent.includes('Mastodon Boosted Post'), false);
    assert.ok(panel.textContent.includes('Bluesky Reposted Post'));
  } finally {
    profCtrl?.destroy();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Unsupported post actions are disabled across Threads, Bluesky, and Mastodon (PostCard, Feed, Thread, Activity, and client guards)', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

  let feedCtrl = null;
  let threadCtrl = null;
  let actCtrl = null;

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();
    resetConnectionStoreForTests();

    const threadsPost = toUnifiedItem({
      id: 'threads:th_post_9',
      protocol: 'threads',
      content_text: 'Threads post with insights',
      date_published: '2026-11-20T09:00:00.000Z',
      author: { id: 'th_other', name: 'Other', handle: 'other_threads' },
      metrics: { likes: 11, replies: 2, reposts: 3 },
      _meta: { threads: { postId: 'th_post_9' } },
    });

    let clicks = 0;
    let opened = 0;
    const thrCardDisconn = createPostCard(threadsPost, {
      onToggleLike: () => { clicks += 1; },
      onReply: () => { clicks += 1; },
      onToggleRepost: () => { clicks += 1; },
      onOpenThread: () => { opened += 1; },
    });
    const thrLikeDisconn = thrCardDisconn.querySelector('.post-action-like');
    const thrReplyDisconn = thrCardDisconn.querySelector('.post-action-reply');
    const thrRepostDisconn = thrCardDisconn.querySelector('.post-action-repost');
    assert.equal(thrLikeDisconn.disabled, true);
    assert.equal(thrLikeDisconn.hasAttribute('disabled'), true);
    assert.ok(thrLikeDisconn.title.includes('Threads API'));
    assert.ok(thrLikeDisconn.getAttribute('aria-description')?.includes('Threads API'));
    assert.equal(thrLikeDisconn.querySelector('.post-action-count').textContent, '11');
    assert.equal(thrReplyDisconn.disabled, true);
    assert.ok(thrReplyDisconn.title.includes('Connect Threads bridge'));
    assert.equal(thrRepostDisconn.disabled, true);
    assert.ok(thrRepostDisconn.title.includes('Threads API'));
    assert.equal(thrRepostDisconn.querySelector('.post-action-count').textContent, '3');

    // Clicking disabled action buttons neither invokes callbacks nor triggers onOpenThread
    thrLikeDisconn.click();
    thrReplyDisconn.click();
    thrRepostDisconn.click();
    assert.equal(clicks, 0);
    assert.equal(opened, 0);

    // Direct client calls to likeUnified/repostUnified reject Threads cleanly
    await assert.rejects(() => likeUnified(threadsPost), /Threads API/);
    await assert.rejects(() => repostUnified(threadsPost), /Threads API/);

    // Connect Threads -> Reply enables (syncPostCardReactions updates live), Like and Boost remain disabled
    await upsertSocialAccount(
      { id: 'threads:th_me', platform: 'threads', userId: 'th_me', handle: 'me_threads', acct: 'me_threads' },
      { accessToken: 't_tok' }
    );
    syncPostCardReactions(thrCardDisconn, threadsPost);
    assert.equal(thrReplyDisconn.disabled, false);
    assert.equal(thrReplyDisconn.hasAttribute('aria-description'), false);
    assert.equal(thrLikeDisconn.disabled, true);
    assert.equal(thrRepostDisconn.disabled, true);

    // Connect Bluesky & Mastodon and mount Feed to verify Follow/Unfollow omitted on Threads and protocol rules apply
    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', userId: 'm_me', acct: 'alice@mastodon.social', handle: 'alice' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:me', handle: 'me.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    const bskyRestrictedPost = toUnifiedItem(normalizeBskyPost({
      post: {
        uri: 'at://did:plc:other/app.bsky.feed.post/gated1',
        cid: 'cid_gated1',
        author: { did: 'did:plc:other', handle: 'gated.bsky.social', displayName: 'Gated' },
        record: { text: 'Replies restricted here', createdAt: '2026-11-20T09:10:00.000Z' },
        likeCount: 5,
        replyCount: 0,
        repostCount: 1,
        viewer: { replyDisabled: true },
      },
    }));
    const mastoDirectPost = toUnifiedItem({
      id: 'mastodon:m_dm_1',
      protocol: 'mastodon',
      content_text: 'Private mention',
      date_published: '2026-11-20T09:20:00.000Z',
      author: { id: 'm_other', name: 'Peer', handle: 'peer@mastodon.social' },
      _meta: { mastodon: { statusId: 'm_dm_1', visibility: 'direct' } },
    });
    const mastoForeignPriv = toUnifiedItem({
      id: 'mastodon:m_priv_foreign',
      protocol: 'mastodon',
      content_text: 'Followers only peer',
      date_published: '2026-11-20T09:21:00.000Z',
      author: { id: 'm_other', name: 'Peer', handle: 'peer@mastodon.social' },
      _meta: { mastodon: { statusId: 'm_priv_foreign', visibility: 'private' } },
    });
    const mastoOwnPriv = toUnifiedItem({
      id: 'mastodon:m_priv_own',
      protocol: 'mastodon',
      content_text: 'Own followers only',
      date_published: '2026-11-20T09:22:00.000Z',
      author: { id: 'm_me', name: 'Alice', handle: 'alice@mastodon.social' },
      _meta: { mastodon: { statusId: 'm_priv_own', visibility: 'private' } },
    });

    setStreamItems('feed', [threadsPost, bskyRestrictedPost, mastoDirectPost, mastoForeignPriv, mastoOwnPriv]);
    const feedHost = dom.document.createElement('div');
    dom.document.body.appendChild(feedHost);
    feedCtrl = mountFeedScreen(feedHost);

    const thrFeedCard = feedHost.querySelector('article.post-card[data-post-id="threads:th_post_9"]');
    assert.ok(thrFeedCard);
    const thrMenuLabels = [...thrFeedCard.querySelectorAll('.post-context-menuitem')].map((el) => el.textContent);
    assert.equal(thrMenuLabels.includes('Follow / Unfollow'), false);

    const dmCard = feedHost.querySelector('article.post-card[data-post-id="mastodon:m_dm_1"]');
    assert.equal(dmCard.querySelector('.post-action-like').disabled, false);
    assert.equal(dmCard.querySelector('.post-action-reply').disabled, false);
    assert.equal(dmCard.querySelector('.post-action-repost').disabled, true);

    const foreignPrivCard = feedHost.querySelector('article.post-card[data-post-id="mastodon:m_priv_foreign"]');
    assert.equal(foreignPrivCard.querySelector('.post-action-repost').disabled, true);

    const ownPrivCard = feedHost.querySelector('article.post-card[data-post-id="mastodon:m_priv_own"]');
    assert.equal(ownPrivCard.querySelector('.post-action-repost').disabled, false);

    const bskyCard = feedHost.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:other/app.bsky.feed.post/gated1"]');
    assert.equal(bskyCard.querySelector('.post-action-like').disabled, false);
    assert.equal(bskyCard.querySelector('.post-action-reply').disabled, true);
    assert.ok(bskyCard.querySelector('.post-action-reply').title.includes('restricted replies'));
    assert.equal(bskyCard.querySelector('.post-action-repost').disabled, false);

    // Inline thread reply form mirrors reply capability (disabled on replyDisabled Bluesky & disconnected Threads)
    const threadHost = dom.document.createElement('div');
    dom.document.body.appendChild(threadHost);
    threadCtrl = renderPostThreadView(threadHost, { post: bskyRestrictedPost });
    assert.equal(threadHost.querySelector('.thread-inline-reply-form .inline-compose-input').disabled, true);
    assert.equal(threadHost.querySelector('.thread-inline-reply-form .inline-compose-submit').disabled, true);
    assert.ok(threadHost.querySelector('.thread-inline-reply-form .inline-compose-input').placeholder.includes('restricted replies'));
    threadCtrl.destroy();
    threadCtrl = null;

    // Disconnecting all accounts disables disconnected protocol controls across capabilities & Activity rows
    resetAuthStoreForTests();
    const disconnBskyCard = createPostCard(toUnifiedItem({
      id: 'bluesky:at://did:plc:pub/app.bsky.feed.post/p1',
      protocol: 'bluesky',
      content_text: 'Public Bluesky post',
      author: { id: 'did:plc:pub', handle: 'pub.bsky.social' },
      _meta: { bluesky: { uri: 'at://did:plc:pub/app.bsky.feed.post/p1', cid: 'c1' } },
    }), { onToggleLike: () => {}, onReply: () => {}, onToggleRepost: () => {} });
    assert.equal(disconnBskyCard.querySelector('.post-action-like').disabled, true);
    assert.equal(disconnBskyCard.querySelector('.post-action-reply').disabled, true);
    assert.equal(disconnBskyCard.querySelector('.post-action-repost').disabled, true);

    activityStore.set({
      items: [
        {
          id: 'threads:notif:rep_disconn',
          protocol: 'threads',
          content_text: 'Threads mention while disconnected',
          date_published: '2026-11-20T09:30:00.000Z',
          author: { id: 'th_x', name: 'X', handle: 'x_threads' },
          _meta: { threads: { postId: 'rep_disconn' }, notification: { kind: 'reply' } },
        },
      ],
      loading: false,
      error: '',
    });
    // Add Mastodon only (no Threads) so Activity list renders rows rather than empty onboarding state
    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', userId: 'm_me', acct: 'alice@mastodon.social' },
      { accessToken: 'm_tok' }
    );
    const actHost = dom.document.createElement('div');
    dom.document.body.appendChild(actHost);
    actCtrl = mountActivityScreen(actHost);
    const actReplyBtn = actHost.querySelector('.activity-inline-action-btn');
    assert.ok(actReplyBtn);
    assert.equal(actReplyBtn.disabled, true);
    assert.ok(actReplyBtn.title.includes('Connect Threads bridge'));
    assert.equal([...actHost.querySelectorAll('.activity-action-item')].some((b) => b.textContent === 'Reply'), false);
    assert.equal(getPostActionCapabilities(threadsPost).reply.enabled, false);

    // Connecting Threads updates Activity Reply button live via authStore subscription
    await upsertSocialAccount(
      { id: 'threads:th_me2', platform: 'threads', userId: 'th_me2', handle: 'me_threads', acct: 'me_threads' },
      { accessToken: 't_tok2' }
    );
    assert.equal(actHost.querySelector('.activity-inline-action-btn').disabled, false);
    assert.equal([...actHost.querySelectorAll('.activity-action-item')].some((b) => b.textContent === 'Reply'), true);
  } finally {
    feedCtrl?.destroy();
    threadCtrl?.destroy();
    actCtrl?.destroy();
    resetActivityStoreForTests();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('PostCard context menu shows Interested, Not Interested, Mute Account, and Block Account (omitting View Profile & Follow/Unfollow) with slight algorithm nudges & keyboard nav', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

  let feedCtrl = null;
  let clickedAuthor = null;

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();

    await upsertSocialAccount(
      { id: 'fediverse:alice@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', userId: 'm_me', acct: 'alice@mastodon.social', handle: 'alice' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:me', handle: 'me.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    const post1 = toUnifiedItem({
      id: 'bluesky:at://did:plc:p1/app.bsky.feed.post/1',
      protocol: 'bluesky',
      content_text: 'Long-form notes on decentralized open infrastructure and worker cooperatives across regions.',
      date_published: '2026-11-20T09:00:00.000Z',
      author: { id: 'did:plc:p1', name: 'Comrade P1', handle: 'p1.bsky.social' },
      attachments: [{ url: 'https://cdn.example/diagram.png', type: 'image', mime_type: 'image/png', alt_text: 'Diagram' }],
      metrics: { likes: 5, replies: 1, reposts: 0 },
      _meta: { bluesky: { uri: 'at://did:plc:p1/app.bsky.feed.post/1', cid: 'c1' } },
    });
    const post2 = toUnifiedItem({
      id: 'bluesky:at://did:plc:mundowav/app.bsky.feed.post/2',
      protocol: 'bluesky',
      content_text: 'Short reactionary outrage rant on cable pundits',
      date_published: '2026-11-20T09:05:00.000Z',
      author: { id: 'did:plc:mundowav', name: 'mundowav', handle: 'mundowav.bsky.social' },
      metrics: { likes: 300, replies: 10, reposts: 50 },
      _meta: { bluesky: { uri: 'at://did:plc:mundowav/app.bsky.feed.post/2', cid: 'c2' } },
    });
    const post3 = toUnifiedItem({
      id: 'mastodon:m_peer_3',
      protocol: 'mastodon',
      content_text: 'Third post for order stability check',
      date_published: '2026-11-20T08:50:00.000Z',
      author: { id: 'm_3', name: 'Peer 3', handle: 'peer3@mastodon.social' },
      _meta: { mastodon: { statusId: 'm_peer_3' } },
    });

    // Verify computeFeedbackSliderNudge nudges slightly without altering concepts/channels
    const nudgedUp = computeFeedbackSliderNudge({ recencyHalfLifeHours: 0, reciprocity: 0, media: 0, smallWeb: 0 }, post1, 'interested');
    assert.equal(nudgedUp.recencyHalfLifeHours, 4);
    assert.equal(nudgedUp.reciprocity, 10);
    assert.equal(nudgedUp.media, 5);
    assert.equal(nudgedUp.smallWeb, 5);

    setStreamItems('feed', [post2, post1, post3]);
    const feedHost = dom.document.createElement('div');
    dom.document.body.appendChild(feedHost);
    feedCtrl = mountFeedScreen(feedHost, {
      onSelectAuthor: (author) => {
        clickedAuthor = author;
      },
    });

    const p1Card = feedHost.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:p1/app.bsky.feed.post/1"]');
    assert.ok(p1Card);
    const menuPanel = p1Card.querySelector('.post-context-menu');
    assert.equal(menuPanel.getAttribute('focusgroup'), 'menu nomemory');
    assert.ok(menuPanel.querySelector('hr.post-context-sep'));
    const labels = [...p1Card.querySelectorAll('.post-context-menuitem')].map((b) => b.textContent);
    assert.deepEqual(labels, ['Interested', 'Not Interested', 'Mute Account', 'Block Account']);
    assert.equal(labels.includes('View Profile'), false);
    assert.equal(labels.includes('Follow / Unfollow'), false);
    assert.equal(labels.includes('Add / Remove from Lists'), false);

    // Author name click still invokes onSelectAuthor
    p1Card.querySelector('.post-author-meta').click();
    assert.equal(clickedAuthor?.handle, 'p1.bsky.social');

    // Keyboard ArrowDown opens menu and focuses first item; Escape closes & restores focus to trigger
    const moreBtn = p1Card.querySelector('.post-more-btn');
    moreBtn.focus();
    moreBtn.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'ArrowDown' }));
    assert.equal(menuPanel.hidden, false);
    assert.equal(moreBtn.getAttribute('aria-expanded'), 'true');
    assert.equal(dom.document.activeElement.textContent, 'Interested');
    menuPanel.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }));
    assert.equal(menuPanel.hidden, true);
    assert.equal(dom.document.activeElement, moreBtn);

    const initialIds = [...feedHost.querySelectorAll('article.post-card')].map((el) => el.dataset.postId);

    // Click Interested on post1 -> boosts affinity (+2.5), nudges sliders, updates label to 'Interested ✓', keeps card order
    const intBtn = [...p1Card.querySelectorAll('.post-context-menuitem')].find((b) => b.textContent === 'Interested');
    intBtn.click();
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(feedStore.get().interactedAuthors['bluesky:p1.bsky.social'], 2.5);
    assert.equal(feedStore.get().tuning.sliders.reciprocity, 10);
    assert.equal(feedStore.get().tuning.sliders.media, 5);
    assert.deepEqual(
      [...feedHost.querySelectorAll('article.post-card')].map((el) => el.dataset.postId),
      initialIds,
      'Interested feedback must not shuffle currently rendered feed cards'
    );
    const updatedP1Card = feedHost.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:p1/app.bsky.feed.post/1"]');
    assert.ok([...updatedP1Card.querySelectorAll('.post-context-menuitem')].some((b) => b.textContent === 'Interested ✓'));

    // Click Not Interested on post2 -> negative affinity (-3), dismisses post2 immediately without shuffling post1/post3
    const p2Card = feedHost.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:mundowav/app.bsky.feed.post/2"]');
    const notIntBtn = [...p2Card.querySelectorAll('.post-context-menuitem')].find((b) => b.textContent === 'Not Interested');
    notIntBtn.click();
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(feedStore.get().interactedAuthors['bluesky:mundowav.bsky.social'], -3);
    assert.ok((feedStore.get().dismissedPostIds || []).includes('bluesky:at://did:plc:mundowav/app.bsky.feed.post/2'));
    assert.equal(
      feedHost.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:mundowav/app.bsky.feed.post/2"]'),
      null
    );
    assert.deepEqual(
      [...feedHost.querySelectorAll('article.post-card')].map((el) => el.dataset.postId),
      ['bluesky:at://did:plc:p1/app.bsky.feed.post/1', 'mastodon:m_peer_3']
    );

    // Hydrate tuning/dismissed state across reload and confirm dismissed post stays hidden & downvoted author ranks lower
    const futureMundowav = toUnifiedItem({
      id: 'bluesky:at://did:plc:mundowav/app.bsky.feed.post/3',
      protocol: 'bluesky',
      content_text: 'New post from mundowav',
      date_published: '2026-11-20T09:10:00.000Z',
      author: { id: 'did:plc:mundowav', name: 'mundowav', handle: 'mundowav.bsky.social' },
      _meta: { bluesky: { uri: 'at://did:plc:mundowav/app.bsky.feed.post/3', cid: 'c3' } },
    });
    const futureP1 = toUnifiedItem({
      id: 'bluesky:at://did:plc:p1/app.bsky.feed.post/4',
      protocol: 'bluesky',
      content_text: 'Follow-up post from Comrade P1',
      date_published: '2026-11-20T09:09:00.000Z',
      author: { id: 'did:plc:p1', name: 'Comrade P1', handle: 'p1.bsky.social' },
      _meta: { bluesky: { uri: 'at://did:plc:p1/app.bsky.feed.post/4', cid: 'c4' } },
    });
    const rankedFuture = rankFeedItems([futureMundowav, futureP1], feedStore.get().tuning, {
      nowMs: Date.parse('2026-11-20T09:11:00.000Z'),
      interactedAuthors: feedStore.get().interactedAuthors,
    });
    assert.equal(rankedFuture[0].id, futureP1.id);

    // Simulated reload keeps dismissedPostIds & hides post2 even if returned again by stream
    feedCtrl.destroy();
    feedCtrl = null;
    resetFeedStoreForTests();
    await hydrateFeedTuning();
    assert.ok((feedStore.get().dismissedPostIds || []).includes('bluesky:at://did:plc:mundowav/app.bsky.feed.post/2'));
    setStreamItems('feed', [post2, futureP1]);
    const feedHost2 = dom.document.createElement('div');
    dom.document.body.appendChild(feedHost2);
    feedCtrl = mountFeedScreen(feedHost2);
    assert.equal(
      feedHost2.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:mundowav/app.bsky.feed.post/2"]'),
      null
    );
    assert.ok(feedHost2.querySelector('article.post-card[data-post-id="bluesky:at://did:plc:p1/app.bsky.feed.post/4"]'));
  } finally {
    feedCtrl?.destroy();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Unified loading states, instant Settings Moderation rendering + scoped mutations, and deduplicated search', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let settingsModal = null;
  let searchCtrl = null;

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetModerationCacheForTests();

    const doc = dom.document;
    // 1. createLoadingState size/inline variants + updateLoadingStateLabel
    const compactLoader = createLoadingState('Loading replies…', { doc, size: 'compact' });
    assert.equal(compactLoader.classList.contains('is-compact'), true);
    assert.equal(compactLoader.classList.contains('is-inline'), false);
    const compactSpinner = compactLoader.querySelector('progress.loading-spinner');
    assert.ok(compactSpinner);
    assert.equal(compactSpinner.getAttribute('value'), null);

    const inlineLoader = createLoadingState('Indexing…', { doc, inline: true });
    assert.equal(inlineLoader.classList.contains('is-inline'), true);
    updateLoadingStateLabel(inlineLoader, 'Scraping URL…');
    assert.equal(inlineLoader.querySelector('.loading-state-label')?.textContent, 'Scraping URL…');
    assert.equal(inlineLoader.querySelector('progress.loading-spinner')?.getAttribute('aria-label'), 'Scraping URL…');

    // 2. SettingsModal -> Moderation renders cached Keyword Filters & Feed Algorithm synchronously (0ms)
    // and keeps Muted/Blocked sections on unified <progress> spinners without blocking or re-fetching on filter edits
    await upsertSocialAccount(
      {
        id: 'fediverse:davy@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davy',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
        userId: 'u_davy',
      },
      { accessToken: 'tok_davy' }
    );
    setFilterRules([{ id: 'flt_pre', phrase: 'crypto', title: 'crypto', filter_action: 'hide' }]);

    let mutesCalls = 0;
    let blocksCalls = 0;
    let releaseModerationNetwork = null;
    const modNetworkGate = new Promise((resolve) => {
      releaseModerationNetwork = resolve;
    });

    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = String(init?.method || 'GET').toUpperCase();
      if (u.includes('/api/v1/mutes')) {
        mutesCalls += 1;
        await modNetworkGate;
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/api/v1/blocks')) {
        blocksCalls += 1;
        await modNetworkGate;
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/api/v2/filters') && method === 'GET') {
        await modNetworkGate;
        return new Response(
          JSON.stringify([{ id: 'flt_pre', title: 'crypto', filter_action: 'hide', keywords: [{ keyword: 'crypto' }] }]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v2/filters') && method === 'POST') {
        return new Response(
          JSON.stringify({ id: 'flt_new', title: 'ads', filter_action: 'hide', keywords: [{ keyword: 'ads' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v2/filters/') && method === 'DELETE') {
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    settingsModal = openSettingsModal({ initialTab: 'moderation' });

    // Synchronous check BEFORE network promises resolve:
    assert.equal(settingsModal.dialog.textContent.includes('Loading Moderation Rules'), false);
    assert.ok(settingsModal.dialog.textContent.includes('Tune Feed...'));
    const syncChips = settingsModal.dialog.querySelectorAll('.moderation-filter-chip');
    assert.equal(syncChips.length, 1);
    assert.equal(syncChips[0].querySelector('.moderation-filter-chip-label')?.textContent, 'crypto');
    assert.equal(settingsModal.dialog.querySelectorAll('.loading-state-card progress.loading-spinner').length, 2);

    releaseModerationNetwork();
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(mutesCalls, 1);
    assert.equal(blocksCalls, 1);
    assert.equal(settingsModal.dialog.querySelectorAll('.loading-state-card progress.loading-spinner').length, 0);
    assert.ok(settingsModal.dialog.textContent.includes('No muted accounts.'));
    assert.ok(settingsModal.dialog.textContent.includes('No blocked accounts.'));

    // Adding & deleting a keyword filter mutates chips in-place without re-fetching mutes/blocks
    const phraseIn = settingsModal.dialog.querySelector('#moderation-filter-phrase');
    phraseIn.value = 'ads';
    phraseIn.parentNode.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(settingsModal.dialog.querySelectorAll('.moderation-filter-chip').length, 2);
    assert.equal(mutesCalls, 1);
    assert.equal(blocksCalls, 1);

    settingsModal.dialog.querySelector('.moderation-filter-chip-remove').click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(settingsModal.dialog.querySelectorAll('.moderation-filter-chip').length, 1);
    assert.equal(mutesCalls, 1);
    assert.equal(blocksCalls, 1);
    settingsModal.close();
    settingsModal = null;

    // 3. mountSearchScreen deduplicates parallel Bluesky actor results without duplicate XRPC search calls
    resetModerationCacheForTests();
    let actorSearchCalls = 0;
    let postSearchCalls = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('app.bsky.actor.searchActors')) {
        actorSearchCalls += 1;
        return new Response(
          JSON.stringify({
            actors: [
              { did: 'did:plc:coop', handle: 'coop.bsky.social', displayName: 'Coop Guild', viewer: {} },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('app.bsky.feed.searchPosts')) {
        postSearchCalls += 1;
        return new Response(JSON.stringify({ posts: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ accounts: [], statuses: [], hashtags: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const searchHost = doc.createElement('div');
    doc.body.appendChild(searchHost);
    searchCtrl = mountSearchScreen(searchHost, {});
    const searchIn = searchHost.querySelector('#global-search-input');
    searchIn.value = 'coop';
    searchHost.querySelector('.search-bar-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(actorSearchCalls, 1);
    assert.equal(postSearchCalls, 1);
    assert.equal(searchHost.querySelectorAll('.search-account-row').length, 1);
    assert.ok(searchHost.textContent.includes('Coop Guild'));
  } finally {
    settingsModal?.close();
    searchCtrl?.destroy();
    resetModerationCacheForTests();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Sovereign Feed v3 blends Following + 2nd-degree graph + learned taste, ranks multi-signal out of the box, tracks dwell/skip signals without DOM shuffle, and resets learned taste', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevIO = globalThis.IntersectionObserver;
  const nowMs = Date.now();
  const isoMinsAgo = (m) => new Date(nowMs - m * 60_000).toISOString();
  const fetchedUrls = [];
  const ioInstances = [];

  class MockIntersectionObserver {
    constructor(callback, options = {}) {
      this.callback = callback;
      this.options = options;
      this.observed = new Set();
      ioInstances.push(this);
    }
    observe(target) {
      this.observed.add(target);
    }
    unobserve(target) {
      this.observed.delete(target);
    }
    disconnect() {
      this.observed.clear();
    }
    trigger(entries) {
      this.callback(entries, this);
    }
  }
  globalThis.IntersectionObserver = MockIntersectionObserver;

  globalThis.fetch = async (url) => {
    const u = String(url);
    fetchedUrls.push(u);

    if (u.includes('/api/v1/timelines/home')) {
      return new Response(
        JSON.stringify([
          {
            id: 'fedi_follow_1',
            uri: 'tag:example-coop.social:fedi_follow_1',
            url: 'https://example-coop.social/users/ally/statuses/fedi_follow_1',
            created_at: isoMinsAgo(6),
            content: '<p>Cooperative foundry machining notes from our followed guild workshop.</p>',
            favourites_count: 3,
            reblogs_count: 1,
            replies_count: 2,
            account: { id: 'acc_ally', username: 'ally', acct: 'ally@example-coop.social', display_name: 'Ally' },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.getTimeline')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:peer1/app.bsky.feed.post/bsky_follow_1',
                cid: 'cid_f1',
                author: { did: 'did:plc:peer1', handle: 'peer1.bsky.social', displayName: 'Peer One' },
                record: { text: 'Direct followed report from agroecology watershed restoration crew.', createdAt: isoMinsAgo(8) },
                likeCount: 6,
                repostCount: 2,
                replyCount: 3,
              },
            },
          ],
          cursor: 'bsky_home_next',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.getActorLikes')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:friend2/app.bsky.feed.post/second_deg_like_1',
                cid: 'cid_sd1',
                author: { did: 'did:plc:friend2', handle: 'friend2.bsky.social', displayName: 'Friend Two' },
                record: { text: 'Community repair cafe schematic repository and parts catalog released.', createdAt: isoMinsAgo(5) },
                likeCount: 9,
                repostCount: 3,
                replyCount: 4,
              },
            },
          ],
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
                uri: 'at://did:plc:peer1/app.bsky.feed.post/bsky_follow_1',
                cid: 'cid_f1',
                author: { did: 'did:plc:peer1', handle: 'peer1.bsky.social', displayName: 'Peer One' },
                record: { text: 'Direct followed report from agroecology watershed restoration crew.', createdAt: isoMinsAgo(8) },
                likeCount: 6,
                repostCount: 2,
                replyCount: 3,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/lookup')) {
      return new Response(
        JSON.stringify({ id: 'acc_ally', acct: 'ally@example-coop.social', username: 'ally', display_name: 'Ally' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/acc_ally/statuses')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/timelines/tag/')) {
      return new Response(
        JSON.stringify([
          {
            id: 'fedi_follow_1',
            uri: 'tag:example-coop.social:fedi_follow_1',
            url: 'https://example-coop.social/users/ally/statuses/fedi_follow_1',
            created_at: isoMinsAgo(6),
            content: '<p>Cooperative foundry machining notes from our followed guild workshop.</p>',
            favourites_count: 3,
            reblogs_count: 1,
            replies_count: 2,
            account: { id: 'acc_ally', username: 'ally', acct: 'ally@example-coop.social', display_name: 'Ally' },
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('app.bsky.feed.searchPosts')) {
      return new Response(
        JSON.stringify({
          posts: [
            {
              uri: 'at://did:plc:disco1/app.bsky.feed.post/taste_disco_1',
              cid: 'cid_d1',
              author: { did: 'did:plc:disco1', handle: 'disco1.bsky.social', displayName: 'Agro Guild' },
              record: { text: 'Practical agroecology soil sensor calibration field logs from cooperative plots.', createdAt: isoMinsAgo(4) },
              likeCount: 8,
              repostCount: 1,
              replyCount: 2,
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let feedCtrl = null;
  let tuningHandle = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    clearHarvesterCacheForTests();

    // 1. Unauthenticated harvest never touches Following endpoints
    const unauthHarvest = await harvestSanctuaryFeed({
      fediAuth: null,
      bskyAuth: null,
      tuning: DEFAULT_FEED_TUNING,
    });
    assert.ok(Array.isArray(unauthHarvest.items));
    assert.equal(fetchedUrls.some((u) => u.includes('/api/v1/timelines/home') || u.includes('app.bsky.feed.getTimeline')), false);

    // 2. Authenticated harvest blends Following + 2nd-degree peer graph + learned taste topics
    fetchedUrls.length = 0;
    clearHarvesterCacheForTests();
    await upsertSocialAccount(
      { id: 'fediverse:me@example-coop.social', platform: 'fediverse', instanceUrl: 'https://example-coop.social', handle: 'me', acct: 'me@example-coop.social', userId: 'u_me' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', handle: 'me.bsky.social', acct: 'me.bsky.social', did: 'did:plc:me' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    const tasteTopics = extractLearnedTasteTopics({
      positive: [
        { text: 'Agroecology soil sensor field calibration notes', weight: 1.0 },
        { text: 'Watershed agroecology cooperative bylaws', weight: 0.9 },
      ],
      negative: [{ text: 'Sponsored celebrity gossip thread', weight: 1.0 }],
    });
    assert.ok(tasteTopics.includes('agroecology'));

    const authHarvest = await harvestSanctuaryFeed({
      fediAuth: await getAuthenticatedAccount('fediverse'),
      bskyAuth: await getAuthenticatedAccount('bluesky'),
      tuning: DEFAULT_FEED_TUNING,
      interactedAuthors: { 'bluesky:peer1.bsky.social': 3.5 },
      implicitAuthors: { 'fediverse:ally@example-coop.social': 2.2 },
      tasteMemory: {
        positive: [{ text: 'Agroecology soil sensor field calibration notes', weight: 1.0 }],
        negative: [],
      },
    });
    const byId = new Map(authHarvest.items.map((it) => [it.id, it]));
    const fediFollow = byId.get('mastodon:fedi_follow_1');
    const bskyFollow = byId.get('bluesky:at://did:plc:peer1/app.bsky.feed.post/bsky_follow_1');
    const secondDeg = byId.get('bluesky:at://did:plc:friend2/app.bsky.feed.post/second_deg_like_1');
    const tasteDisco = byId.get('bluesky:at://did:plc:disco1/app.bsky.feed.post/taste_disco_1');

    assert.ok(fediFollow && fediFollow._meta?.feedSource === 'following', 'Following tag must win priority dedupe over discovery');
    assert.ok(bskyFollow && bskyFollow._meta?.feedSource === 'following');
    assert.ok(secondDeg && secondDeg._meta?.feedSource === 'second_degree');
    assert.ok(tasteDisco, 'Learned taste topic query must yield discovery post');
    assert.ok(fetchedUrls.some((u) => u.includes('/api/v1/timelines/home')));
    assert.ok(fetchedUrls.some((u) => u.includes('app.bsky.feed.getTimeline')));
    assert.ok(fetchedUrls.some((u) => u.includes('app.bsky.feed.getActorLikes')));
    assert.ok(fetchedUrls.some((u) => u.includes('app.bsky.feed.searchPosts')));
    assert.equal(fetchedUrls.some((u) => u.includes('whats-hot') || u.includes('/trends/statuses')), false);

    // 3. Multi-signal ranker out of the box vs strict chronological Following & preset
    const activeThreadPost = toUnifiedItem({
      id: 'mastodon:vel_high',
      protocol: 'mastodon',
      content_text: 'Open-source lathe controller firmware benchmark results and cooperative workshop schematics.',
      date_published: isoMinsAgo(10),
      author: { id: 'a_vel', name: 'Lathe Guild', handle: 'lathe@coop.social' },
      metrics: { likes: 45, replies: 14, reposts: 6 },
    });
    const passivePost = toUnifiedItem({
      id: 'mastodon:vel_low',
      protocol: 'mastodon',
      content_text: 'Quick morning coffee photo on the train.',
      date_published: isoMinsAgo(10),
      author: { id: 'a_pas', name: 'Train Cam', handle: 'train@masto.social' },
      metrics: { likes: 45, replies: 0, reposts: 0 },
    });
    const ratioedPost = toUnifiedItem({
      id: 'mastodon:vel_ratio',
      protocol: 'mastodon',
      content_text: 'Hot take bait designed purely to farm angry replies.',
      date_published: isoMinsAgo(10),
      author: { id: 'a_rat', name: 'Ratio Bait', handle: 'bait@masto.social' },
      metrics: { likes: 3, replies: 24, reposts: 1 },
    });
    assert.ok(scoreConversationVelocity(activeThreadPost, nowMs) > scoreConversationVelocity(passivePost, nowMs));
    assert.ok(scoreConversationVelocity(ratioedPost, nowMs) < 0, 'Ratioed outrage replies must receive negative velocity');

    const tasteMem = {
      positive: [{ text: 'lathe controller firmware cooperative workshop', weight: 1.0 }],
      negative: [{ text: 'sponsored morning commute promo', weight: 1.0 }],
    };
    assert.ok(scorePersonalTasteLexical(activeThreadPost, tasteMem) > scorePersonalTasteLexical(passivePost, tasteMem));

    const coldNewer = toUnifiedItem({
      id: 'bluesky:cold_newer',
      protocol: 'bluesky',
      content_text: 'Newest random status update with zero graph or taste match.',
      date_published: isoMinsAgo(2),
      author: { id: 'did:plc:cold', handle: 'cold.bsky.social', displayName: 'Cold Account' },
      metrics: { likes: 0, replies: 0, reposts: 0 },
    });
    const tasteMatchOlder = toUnifiedItem({
      id: 'bluesky:taste_match',
      protocol: 'bluesky',
      content_text: 'Open-source lathe controller firmware notes with followed workshop details.',
      date_published: isoMinsAgo(12),
      author: { id: 'did:plc:ally', handle: 'ally.bsky.social', displayName: 'Ally Workshop' },
      metrics: { likes: 6, replies: 5, reposts: 2 },
      _meta: { feedSource: 'following' },
    });

    const outOfBoxFeedOrder = rankFeedItems(
      [coldNewer, tasteMatchOlder],
      DEFAULT_FEED_TUNING,
      {
        nowMs,
        streamMode: 'feed',
        implicitAuthors: { 'bluesky:ally.bsky.social': 2.0 },
        tasteScores: { 'bluesky:taste_match': 0.85, 'bluesky:cold_newer': -0.1 },
        tasteMemory: tasteMem,
      }
    );
    assert.equal(outOfBoxFeedOrder[0].id, 'bluesky:taste_match', 'Feed stream must use sovereign multi-signal ranking out of the box');

    const presetChronoOrder = rankFeedItems(
      [tasteMatchOlder, coldNewer],
      { ...DEFAULT_FEED_TUNING, updatedBy: 'preset:chronological' },
      {
        nowMs,
        streamMode: 'feed',
        implicitAuthors: { 'bluesky:ally.bsky.social': 2.0 },
        tasteScores: { 'bluesky:taste_match': 0.85, 'bluesky:cold_newer': -0.1 },
        tasteMemory: tasteMem,
      }
    );
    assert.equal(presetChronoOrder[0].id, 'bluesky:cold_newer', 'Chronological preset on Feed must stay strictly chronological');

    const followingOrder = rankFeedItems(
      [coldNewer, tasteMatchOlder],
      DEFAULT_FEED_TUNING,
      {
        nowMs,
        streamMode: 'following',
        implicitAuthors: { 'bluesky:ally.bsky.social': 2.0 },
        tasteScores: { 'bluesky:taste_match': 0.85, 'bluesky:cold_newer': -0.1 },
        tasteMemory: tasteMem,
      }
    );
    assert.equal(followingOrder[0].id, 'bluesky:cold_newer', 'Following stream must stay strictly chronological by default');

    // 4. Behavioral signals & IntersectionObserver dwell/scroll_past without reshuffling visible DOM
    recordBehavioralSignal(tasteMatchOlder, 'profile_click');
    assert.ok((feedStore.get().implicitAuthors['bluesky:ally.bsky.social'] || 0) > 0);
    assert.deepEqual(feedStore.get().interactedAuthors, {}, 'profile_click must never mutate interactedAuthors');

    setStreamItems('feed', [tasteMatchOlder, coldNewer], null);
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);
    await new Promise((r) => setTimeout(r, 30));

    const cards = Array.from(host.querySelectorAll('article.post-card'));
    assert.equal(cards.length, 2);
    const initialIds = cards.map((el) => el.dataset.postId);
    const firstCard = cards[0];
    const secondCard = cards[1];
    const dwellIo = ioInstances.find((inst) => inst.observed.has(firstCard));
    assert.ok(dwellIo, 'mountFeedScreen must attach dwell IntersectionObserver to Feed cards');

    const posBeforeDwell = feedStore.get().tasteMemory?.positive?.length || 0;
    dwellIo.trigger([{ target: firstCard, isIntersecting: true, intersectionRatio: 0.75, boundingClientRect: { top: 80 }, rootBounds: { top: 0 } }]);
    await new Promise((r) => setTimeout(r, 2900));
    assert.ok((feedStore.get().tasteMemory?.positive?.length || 0) > posBeforeDwell, 'Dwell >= 2800ms must record positive taste exemplar');

    // Fast scroll-past on second card (180..750ms exiting above viewport top)
    const negBeforeSkip = feedStore.get().tasteMemory?.negative?.length || 0;
    dwellIo.trigger([{ target: secondCard, isIntersecting: true, intersectionRatio: 0.7, boundingClientRect: { top: 120 }, rootBounds: { top: 0 } }]);
    await new Promise((r) => setTimeout(r, 240));
    dwellIo.trigger([{ target: secondCard, isIntersecting: false, intersectionRatio: 0, boundingClientRect: { top: -220 }, rootBounds: { top: 0 } }]);
    assert.ok((feedStore.get().tasteMemory?.negative?.length || 0) > negBeforeSkip, 'Fast upward scroll-past must record negative taste exemplar');

    const cardsAfterSignals = Array.from(host.querySelectorAll('article.post-card'));
    assert.deepEqual(cardsAfterSignals.map((el) => el.dataset.postId), initialIds, 'Viewport card order must never jump on dwell or scroll-past');
    assert.ok(cardsAfterSignals[0] === firstCard && cardsAfterSignals[1] === secondCard);

    recordBehavioralSignal(tasteMatchOlder, 'open_thread');
    const savedImplicit = { ...feedStore.get().implicitAuthors };
    const savedTaste = {
      positive: [...(feedStore.get().tasteMemory?.positive || [])],
      negative: [...(feedStore.get().tasteMemory?.negative || [])],
    };
    await new Promise((r) => setTimeout(r, 80));
    resetFeedStoreForTests();
    await hydrateFeedTuning();
    assert.ok((feedStore.get().implicitAuthors['bluesky:ally.bsky.social'] || 0) >= (savedImplicit['bluesky:ally.bsky.social'] || 0));
    assert.equal(feedStore.get().tasteMemory?.positive?.length, savedTaste.positive.length);
    assert.equal(feedStore.get().tasteMemory?.negative?.length, savedTaste.negative.length);

    // 5. FeedTuningModal Learned Taste Memory section & Reset Learned Taste button
    setTasteScores({ 'bluesky:taste_match': 0.85 });
    tuningHandle = openFeedTuningModal();
    await new Promise((r) => setTimeout(r, 20));
    const tuningDlg = dom.document.getElementById('feed-tuning-dialog');
    assert.ok(tuningDlg && tuningDlg.open);
    assert.ok(tuningDlg.textContent.includes('Learned Taste Memory'));
    const resetTasteBtn = Array.from(tuningDlg.querySelectorAll('button')).find((b) =>
      b.textContent.includes('Reset Learned Taste')
    );
    assert.ok(resetTasteBtn, 'Reset Learned Taste button must be present in FeedTuningModal');
    resetTasteBtn.click();
    assert.deepEqual(feedStore.get().tasteMemory, { positive: [], negative: [] });
    assert.deepEqual(feedStore.get().implicitAuthors, {});
    assert.deepEqual(feedStore.get().tasteScores, {});
  } finally {
    tuningHandle?.close();
    feedCtrl?.destroy();
    clearHarvesterCacheForTests();
    resetMemoryStorageForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    globalThis.IntersectionObserver = prevIO;
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Canonical deduplication collapses own mismatched cross-posts, syndicated dlvr.it URL duplicates, federated ActivityPub URIs, append pages, and post-enrichment linked siblings', async () => {
  const prevFetch = globalThis.fetch;
  const nowMs = Date.now();
  const isoMinsAgo = (m) => new Date(nowMs - m * 60_000).toISOString();

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    clearHarvesterCacheForTests();

    assert.equal(
      canonicalizeUrlForDedupe('https://www.Jacobin.com/2026/11/ottoman-history/?utm_source=dlvr.it&utm_medium=mastodon#top'),
      'https://jacobin.com/2026/11/ottoman-history'
    );
    assert.equal(
      canonicalizeUrlForDedupe('nimueblue-share.nimueblue.workers.dev/r/rb-123/?ref=home'),
      'https://nimueblue-share.nimueblue.workers.dev/r/rb-123'
    );

    await upsertSocialAccount(
      {
        id: 'fediverse:davyrhodes_@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davyrhodes_',
        acct: 'davyrhodes_@mastodon.social',
        userId: 'u_davy',
      },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:davyrhodes',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'davyrhodes.bsky.social',
        acct: 'davyrhodes.bsky.social',
        did: 'did:plc:davyrhodes',
      },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    const shareUrl = 'https://nimueblue-share.nimueblue.workers.dev/r/rb-5ce4d41f5afb46048402d10e4ce47721';
    const davyBsky = toUnifiedItem({
      id: 'bluesky:at://did:plc:davyrhodes/app.bsky.feed.post/space1',
      protocol: 'bluesky',
      content_text: shareUrl,
      content_html: `<p><a href="${shareUrl}">${shareUrl}</a></p>`,
      date_published: isoMinsAgo(60),
      author: { id: 'did:plc:davyrhodes', name: 'Davy Rhodes', handle: 'davyrhodes.bsky.social' },
      metrics: { likes: 2, replies: 0, reposts: 1 },
      _meta: {
        bluesky: { uri: 'at://did:plc:davyrhodes/app.bsky.feed.post/space1', cid: 'cid_space1' },
        linkCard: { url: shareUrl, title: 'KMGP-LP "Space 101.1" Seattle, Washington | NIMUEBLUE' },
      },
    });
    const davyMasto = toUnifiedItem({
      id: 'mastodon:m_space1',
      protocol: 'mastodon',
      content_text: shareUrl,
      content_html: `<p><a href="${shareUrl}">${shareUrl}</a></p>`,
      date_published: isoMinsAgo(59),
      author: { id: 'u_davy', name: 'Davy Rhodes', handle: 'davyrhodes_@mastodon.social' },
      metrics: { likes: 1, replies: 0, reposts: 0 },
      _meta: {
        mastodon: { statusId: 'm_space1', instanceUrl: 'https://mastodon.social', uri: 'https://mastodon.social/users/davyrhodes_/statuses/m_space1' },
        linkCard: { url: shareUrl, title: 'KMGP-LP "Space 101.1" Seattle, Washington | NIMUEBLUE' },
      },
    });

    // Screenshot 2: Syndicated dlvr.it article clones vs distinct human commentary
    const jacobinTracked = 'https://jacobin.com/2026/11/ottoman-history-capitalism-colonialism-origins?utm_source=dlvr.it&utm_medium=mastodon';
    const verdantDiscovery = toUnifiedItem({
      id: 'mastodon:m_verdant',
      protocol: 'mastodon',
      content_text: `What the Ottomans Tell Us About Plunder and Capitalism\n${jacobinTracked} #socialism`,
      date_published: isoMinsAgo(39),
      author: { id: 'a_verdant', name: 'Verdant Square Network', handle: 'verdantsquare@mastodon.world' },
      metrics: { likes: 0, replies: 0, reposts: 0 },
      _meta: {
        feedSource: 'discovery',
        mastodon: { statusId: 'm_verdant', instanceUrl: 'https://mastodon.social', uri: 'https://mastodon.world/users/verdantsquare/statuses/1' },
        linkCard: { url: jacobinTracked, title: 'What the Ottomans Tell Us About Plunder and Capitalism' },
      },
    });
    const natalieFollowing = toUnifiedItem({
      id: 'mastodon:m_natalie',
      protocol: 'mastodon',
      content_text: `What the Ottomans Tell Us About Plunder and Capitalism\n${jacobinTracked} #socialism`,
      date_published: isoMinsAgo(38),
      author: { id: 'a_natalie', name: 'Natalie Davis', handle: 'NatalieDavis@journa.host' },
      metrics: { likes: 4, replies: 1, reposts: 2 },
      _meta: {
        feedSource: 'following',
        mastodon: { statusId: 'm_natalie', instanceUrl: 'https://mastodon.social', uri: 'https://journa.host/users/NatalieDavis/statuses/2' },
        linkCard: { url: jacobinTracked, title: 'What the Ottomans Tell Us About Plunder and Capitalism' },
      },
    });
    const scholarCommentary = toUnifiedItem({
      id: 'mastodon:m_scholar',
      protocol: 'mastodon',
      content_text: `Important Ottoman agrarian historiography piece, compare with Brenner:\n${jacobinTracked}`,
      date_published: isoMinsAgo(35),
      author: { id: 'a_scholar', name: 'History Desk', handle: 'scholar@historians.social' },
      _meta: {
        feedSource: 'following',
        mastodon: { statusId: 'm_scholar', instanceUrl: 'https://mastodon.social', uri: 'https://historians.social/users/scholar/statuses/3' },
        linkCard: { url: jacobinTracked, title: 'What the Ottomans Tell Us About Plunder and Capitalism' },
      },
    });

    // Federated copies with different local IDs sharing ActivityPub URI (even 5 hours apart)
    const fedOrig = toUnifiedItem({
      id: 'mastodon:101',
      protocol: 'mastodon',
      content_text: 'Original federated dispatch about cooperative energy microgrids.',
      date_published: isoMinsAgo(300),
      author: { id: 'a_fed', name: 'Grid Lab', handle: 'grid@journa.host' },
      _meta: {
        feedSource: 'following',
        mastodon: { statusId: '101', instanceUrl: 'https://mastodon.social', uri: 'https://journa.host/users/grid/statuses/555' },
      },
    });
    const fedRemoteBoost = toUnifiedItem({
      id: 'mastodon:909',
      protocol: 'mastodon',
      content_text: 'Original federated dispatch about cooperative energy microgrids.',
      date_published: isoMinsAgo(10),
      author: { id: 'a_fed_local', name: 'Grid Lab', handle: 'grid@journa.host' },
      _meta: {
        feedSource: 'discovery',
        mastodon: {
          statusId: '909',
          instanceUrl: 'https://kolektiva.social',
          uri: 'https://journa.host/users/grid/statuses/555',
          rebloggedBy: { id: 'b1', handle: 'pal@kolektiva.social', name: 'Pal' },
        },
      },
    });

    // 1. setStreamItems('following', ...) deduplicates Davy's cross-post, dlvr.it twin, and federated URI clone
    setStreamItems('following', [davyBsky, davyMasto, verdantDiscovery, natalieFollowing, scholarCommentary, fedOrig, fedRemoteBoost]);
    const followingItems = feedStore.get().streams.following.items;
    const followingIds = followingItems.map((it) => it.id);
    assert.equal(followingItems.filter((it) => it.content_text.includes('rb-5ce4d41f')).length, 1);
    const davySurvivor = followingItems.find((it) => it.content_text.includes('rb-5ce4d41f'));
    assert.equal(davySurvivor.id, 'mastodon:m_space1');
    assert.equal(davySurvivor._meta.bluesky.uri, 'at://did:plc:davyrhodes/app.bsky.feed.post/space1');

    const jacobinMatches = followingItems.filter((it) => (it._meta?.linkCard?.url || '').includes('ottoman-history'));
    assert.equal(jacobinMatches.length, 2, 'Syndicated dlvr.it duplicates must collapse to 1 while preserving scholar commentary');
    const syndicatedWinner = jacobinMatches.find((it) => !it.content_text.includes('historiography'));
    assert.equal(syndicatedWinner.id, 'mastodon:m_natalie', 'following must beat discovery on syndicated duplicate');
    assert.equal(syndicatedWinner._meta.mastodon.statusId, 'm_natalie');
    assert.ok(followingIds.includes('mastodon:101') && !followingIds.includes('mastodon:909'));

    // 2. harvestSanctuaryFeed deduplicates cross-posts via ownAccounts + sieveSovereignCandidates
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/timelines/home')) {
        return new Response(
          JSON.stringify([
            {
              id: 'm_space1',
              uri: 'https://mastodon.social/users/davyrhodes_/statuses/m_space1',
              created_at: isoMinsAgo(59),
              content: `<p><a href="${shareUrl}">${shareUrl}</a></p>`,
              card: { url: shareUrl, title: 'KMGP-LP "Space 101.1" Seattle, Washington | NIMUEBLUE' },
              account: { id: 'u_davy', username: 'davyrhodes_', acct: 'davyrhodes_@mastodon.social', display_name: 'Davy Rhodes' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('app.bsky.feed.getTimeline')) {
        return new Response(
          JSON.stringify({
            feed: [
              {
                post: {
                  uri: 'at://did:plc:davyrhodes/app.bsky.feed.post/space1',
                  cid: 'cid_space1',
                  author: { did: 'did:plc:davyrhodes', handle: 'davyrhodes.bsky.social', displayName: 'Davy Rhodes' },
                  record: { text: shareUrl, createdAt: isoMinsAgo(60) },
                  embed: { $type: 'app.bsky.embed.external#view', external: { uri: shareUrl, title: 'KMGP-LP "Space 101.1" Seattle, Washington | NIMUEBLUE' } },
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v1/timelines/tag/')) {
        return new Response(
          JSON.stringify([
            {
              id: 'm_verdant',
              uri: 'https://mastodon.world/users/verdantsquare/statuses/1',
              created_at: isoMinsAgo(39),
              content: `<p>What the Ottomans Tell Us About Plunder and Capitalism <a href="${jacobinTracked}">${jacobinTracked}</a> <a class="mention hashtag" href="https://mastodon.world/tags/socialism">#socialism</a></p>`,
              card: { url: jacobinTracked, title: 'What the Ottomans Tell Us About Plunder and Capitalism' },
              account: { id: 'a_verdant', username: 'verdantsquare', acct: 'verdantsquare@mastodon.world', display_name: 'Verdant Square Network' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v1/timelines/public')) {
        return new Response(
          JSON.stringify([
            {
              id: 'm_natalie',
              uri: 'https://journa.host/users/NatalieDavis/statuses/2',
              created_at: isoMinsAgo(38),
              content: `<p>What the Ottomans Tell Us About Plunder and Capitalism <a href="${jacobinTracked}">${jacobinTracked}</a> <a class="mention hashtag" href="https://journa.host/tags/socialism">#socialism</a></p>`,
              card: { url: jacobinTracked, title: 'What the Ottomans Tell Us About Plunder and Capitalism' },
              account: { id: 'a_natalie', username: 'NatalieDavis', acct: 'NatalieDavis@journa.host', display_name: 'Natalie Davis' },
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const harvested = await harvestSanctuaryFeed({
      fediAuth: await getAuthenticatedAccount('fediverse'),
      bskyAuth: await getAuthenticatedAccount('bluesky'),
      tuning: DEFAULT_FEED_TUNING,
    });
    assert.equal(harvested.items.filter((it) => it.content_text.includes('rb-5ce4d41f')).length, 1);
    assert.equal(harvested.items.filter((it) => (it._meta?.linkCard?.url || '').includes('ottoman-history')).length, 1);

    // 3. appendStreamItems drops cross-post/syndicated duplicates of Page 1 without reordering Page 1
    setStreamItems('feed', [davyMasto, natalieFollowing]);
    appendStreamItems('feed', [davyBsky, verdantDiscovery, scholarCommentary]);
    const appendedIds = feedStore.get().streams.feed.items.map((it) => it.id);
    assert.deepEqual(appendedIds, ['mastodon:m_natalie', 'mastodon:m_space1', 'mastodon:m_scholar']);

    // 4. reconcileEnrichedStreamItems collapses two separate-author/distinct-text items linked via _meta.linkedIds
    const unlinkedMasto = toUnifiedItem({
      id: 'mastodon:link_m1',
      protocol: 'mastodon',
      content_text: 'Full Mastodon essay body version.',
      date_published: isoMinsAgo(5),
      author: { id: 'u_davy', name: 'Davy Rhodes', handle: 'davyrhodes_@mastodon.social' },
      metrics: { likes: 3, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 'link_m1', instanceUrl: 'https://mastodon.social' } },
    });
    const unlinkedBsky = toUnifiedItem({
      id: 'bluesky:at://did:plc:davyrhodes/app.bsky.feed.post/link_b1',
      protocol: 'bluesky',
      content_text: 'Compact Bluesky phrasing.',
      date_published: isoMinsAgo(5),
      author: { id: 'did:plc:davyrhodes', name: 'Davy Rhodes', handle: 'davyrhodes.bsky.social' },
      metrics: { likes: 5, replies: 1, reposts: 2 },
      _meta: { bluesky: { uri: 'at://did:plc:davyrhodes/app.bsky.feed.post/link_b1', cid: 'cid_lb1' } },
    });
    setStreamItems('feed', [unlinkedBsky, unlinkedMasto]);
    assert.equal(feedStore.get().streams.feed.items.length, 2);

    reconcileEnrichedStreamItems([
      {
        ...unlinkedMasto,
        metrics: { likes: 8, replies: 1, reposts: 2 },
        _meta: {
          ...unlinkedMasto._meta,
          linkedIds: { mastodonStatusId: 'link_m1', blueskyUri: 'at://did:plc:davyrhodes/app.bsky.feed.post/link_b1' },
          metricsBreakdown: { mastodon: { likes: 3, replies: 0, reposts: 0 }, bluesky: { likes: 5, replies: 1, reposts: 2 } },
        },
      },
      {
        ...unlinkedBsky,
        metrics: { likes: 8, replies: 1, reposts: 2 },
        _meta: {
          ...unlinkedBsky._meta,
          linkedIds: { mastodonStatusId: 'link_m1', blueskyUri: 'at://did:plc:davyrhodes/app.bsky.feed.post/link_b1' },
          metricsBreakdown: { mastodon: { likes: 3, replies: 0, reposts: 0 }, bluesky: { likes: 5, replies: 1, reposts: 2 } },
        },
      },
    ]);
    const reconciled = feedStore.get().streams.feed.items;
    assert.equal(reconciled.length, 1, 'reconcileEnrichedStreamItems must collapse linked siblings in place');
    assert.equal(reconciled[0].id, 'mastodon:link_m1');
    assert.equal(reconciled[0].metrics.likes, 8);
    assert.ok(reconciled[0]._meta.bluesky?.uri);

    // Explicit direct unit check of deduplicateAppendItems preserving target slot order
    const directAppend = deduplicateAppendItems([unlinkedMasto], [davyBsky]);
    assert.equal(directAppend.nextExisting[0].id, 'mastodon:link_m1');
    assert.equal(directAppend.appended.length, 1);
  } finally {
    clearHarvesterCacheForTests();
    resetMemoryStorageForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
  }
});

test('PostCard renders Mastodon, Bluesky, and Threads logos instead of protocol text with accessible labels', () => {
  const dom = installMockDom();
  try {
    resetAuthStoreForTests();
    const tripleLinked = toUnifiedItem({
      id: 'mastodon:triple_1',
      protocol: 'mastodon',
      content_text: 'Cross-posted everywhere cleanly.',
      date_published: '2026-11-20T10:00:00Z',
      author: { id: 'u1', name: 'Davy Rhodes', handle: 'davy@mastodon.social' },
      _meta: {
        mastodon: { statusId: 'triple_1', instanceUrl: 'https://mastodon.social' },
        linkedIds: {
          mastodonStatusId: 'triple_1',
          blueskyUri: 'at://did:plc:davy/app.bsky.feed.post/1',
          threadsPostId: 'th_1',
        },
      },
    });
    const tripleMergedMeta = toUnifiedItem({
      id: 'bluesky:at://did:plc:davy/app.bsky.feed.post/2',
      protocol: 'bluesky',
      content_text: 'Merged cross-platform metadata post.',
      date_published: '2026-11-20T10:00:00Z',
      author: { id: 'did:plc:davy', name: 'Davy Rhodes', handle: 'davy.bsky.social' },
      _meta: {
        mastodon: { statusId: 'm_merged_2', instanceUrl: 'https://mastodon.social' },
        bluesky: { uri: 'at://did:plc:davy/app.bsky.feed.post/2', cid: 'c2' },
        threads: { postId: 'th_merged_2' },
      },
    });
    const doubleLinked = toUnifiedItem({
      id: 'mastodon:double_1',
      protocol: 'mastodon',
      content_text: 'Two networks only.',
      date_published: '2026-11-20T10:00:00Z',
      author: { id: 'u1', name: 'Davy Rhodes', handle: 'davy@mastodon.social' },
      _meta: {
        mastodon: { statusId: 'double_1', instanceUrl: 'https://mastodon.social' },
        linkedIds: { mastodonStatusId: 'double_1', blueskyUri: 'at://did:plc:davy/app.bsky.feed.post/3' },
      },
    });
    const singleMasto = toUnifiedItem({
      id: 'mastodon:single_m',
      protocol: 'mastodon',
      content_text: 'Mastodon only.',
      date_published: '2026-11-20T10:00:00Z',
      author: { id: 'u2', name: 'M', handle: 'm@mastodon.social' },
    });
    const singleBsky = toUnifiedItem({
      id: 'bluesky:at://did:plc:b/app.bsky.feed.post/4',
      protocol: 'bluesky',
      content_text: 'Bluesky only.',
      date_published: '2026-11-20T10:00:00Z',
      author: { id: 'did:plc:b', name: 'B', handle: 'b.bsky.social' },
    });
    const singleThreads = toUnifiedItem({
      id: 'threads:th_only_5',
      protocol: 'threads',
      content_text: 'Threads only.',
      date_published: '2026-11-20T10:00:00Z',
      author: { id: 'th_u', name: 'T', handle: 't@threads.net' },
    });

    assert.deepEqual(resolvePostBadgeProtocols(tripleLinked), ['mastodon', 'bluesky', 'threads']);
    assert.deepEqual(resolvePostBadgeProtocols(tripleMergedMeta), ['mastodon', 'bluesky', 'threads']);
    assert.deepEqual(resolvePostBadgeProtocols(doubleLinked), ['mastodon', 'bluesky']);
    assert.deepEqual(resolvePostBadgeProtocols(singleMasto), ['mastodon']);
    assert.deepEqual(resolvePostBadgeProtocols(singleBsky), ['bluesky']);
    assert.deepEqual(resolvePostBadgeProtocols(singleThreads), ['threads']);

    const card = createPostCard(tripleLinked, {});
    const badge = card.querySelector('.post-protocol-badge.post-protocol-badge--icons');
    assert.ok(badge, 'PostCard must render icon-based protocol badge');
    assert.equal(badge.getAttribute('role'), 'img');
    assert.equal(badge.getAttribute('aria-label'), 'Mastodon, Bluesky, Threads');
    assert.equal(badge.title, 'Mastodon · Bluesky · Threads');
    assert.equal(badge.dataset.protocols, 'mastodon,bluesky,threads');
    assert.equal(badge.textContent, '', 'Badge must not contain protocol text');

    for (const proto of ['mastodon', 'bluesky', 'threads']) {
      const logoEl = badge.querySelector(`.post-protocol-logo--${proto}`);
      assert.ok(logoEl, `Missing ${proto} logo container`);
      assert.equal(logoEl.getAttribute('aria-hidden'), 'true');
      assert.ok(
        logoEl.innerHTML.includes('<svg') &&
        logoEl.innerHTML.includes('aria-hidden="true"') &&
        logoEl.innerHTML.includes('</svg>'),
        `Missing inline SVG markup for ${proto}`
      );
    }
  } finally {
    resetAuthStoreForTests();
    dom.restore();
  }
});

test('PostCard shows accessible inline translate button only on non-English posts and toggles cached translations cleanly', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    clearTranslationCacheForTests();

    const mastoNormFr = toUnifiedItem(
      normalizeMastodonStatus(
        {
          id: 'm_fr_9',
          content: '<p>Bonjour les camarades de la coopérative.</p>',
          language: 'fr',
          created_at: '2026-11-20T10:00:00Z',
          account: { id: 'u_fr', acct: 'claire@mastodon.social', display_name: 'Claire' },
        },
        'https://mastodon.social'
      )
    );
    assert.equal(mastoNormFr.language, 'fr');

    const bskyNormEs = toUnifiedItem(
      normalizeBskyPost({
        post: {
          uri: 'at://did:plc:es1/app.bsky.feed.post/1',
          cid: 'cid_es1',
          author: { did: 'did:plc:es1', handle: 'diego.bsky.social', displayName: 'Diego' },
          record: {
            text: 'La asamblea de trabajadores comienza hoy por la tarde.',
            langs: ['es'],
            createdAt: '2026-11-20T10:00:00Z',
          },
        },
      })
    );
    assert.equal(bskyNormEs.language, 'es');

    // Language detection cases
    assert.equal(
      detectPostLanguageInfo({ content_text: 'Open-source tooling release notes for Linux.', language: 'en' }).shouldOfferTranslate,
      false
    );
    assert.equal(
      detectPostLanguageInfo({ content_text: 'https://example.org @alice #release 🎉', language: 'fr' }).shouldOfferTranslate,
      false,
      'Non-linguistic URL/mention/emoji posts must not offer translation'
    );
    assert.equal(
      detectPostLanguageInfo({
        content_text: 'The workshop guild decided that this maintenance policy will improve reliability.',
        language: 'fr',
      }).shouldOfferTranslate,
      false,
      'Mis-tagged pure-English prose must not trigger false translate prompts'
    );

    const frInfo = detectPostLanguageInfo(mastoNormFr);
    assert.equal(frInfo.shouldOfferTranslate, true);
    assert.equal(frInfo.langTag, 'fr');
    assert.equal(frInfo.languageName, 'French');

    const esInfo = detectPostLanguageInfo(bskyNormEs);
    assert.equal(esInfo.shouldOfferTranslate, true);
    assert.equal(esInfo.langTag, 'es');
    assert.equal(esInfo.languageName, 'Spanish');

    const misTaggedJa = detectPostLanguageInfo({
      protocol: 'bluesky',
      content_text: '新しい協力工場の案内を公開しました。',
      language: 'en',
    });
    assert.equal(misTaggedJa.shouldOfferTranslate, true);
    assert.equal(misTaggedJa.langTag, 'ja');
    assert.equal(misTaggedJa.languageName, 'Japanese');

    const threadsKo = detectPostLanguageInfo({
      protocol: 'threads',
      content_text: '협동조합 회의가 오늘 오후에 열립니다.',
    });
    assert.equal(threadsKo.shouldOfferTranslate, true);
    assert.equal(threadsKo.langTag, 'ko');
    assert.equal(threadsKo.languageName, 'Korean');

    const threadsUk = detectPostLanguageInfo({
      protocol: 'threads',
      content_text: 'Сьогодні відкривається нова громадська майстерня.',
    });
    assert.equal(threadsUk.shouldOfferTranslate, true);
    assert.equal(threadsUk.langTag, 'uk');
    assert.equal(threadsUk.languageName, 'Ukrainian');

    const untaggedDe = detectPostLanguageInfo({
      protocol: 'threads',
      content_text: 'Unsere Genossenschaft arbeitet heute an der neuen Werkstatt.',
    });
    assert.equal(untaggedDe.shouldOfferTranslate, true);
    assert.equal(untaggedDe.langTag, 'de');
    assert.equal(untaggedDe.languageName, 'German');

    const untaggedEs = detectPostLanguageInfo({
      protocol: 'threads',
      content_text: 'Trabajadores de la cooperativa organizan una reunión mañana.',
    });
    assert.equal(untaggedEs.shouldOfferTranslate, true);
    assert.equal(untaggedEs.langTag, 'es');

    // English PostCard omits translate UI completely
    const englishCard = createPostCard(
      toUnifiedItem({
        id: 'mastodon:m_en_1',
        protocol: 'mastodon',
        language: 'en',
        content_text: 'Just another quiet morning debugging CSS layout rules.',
        date_published: '2026-11-20T10:00:00Z',
        author: { id: 'u_en', name: 'Sam', handle: 'sam@mastodon.social' },
      }),
      {}
    );
    assert.equal(englishCard.querySelector('.post-translate-btn'), null);
    assert.equal(englishCard.querySelector('.post-translate-bar'), null);

    // Non-English PostCard renders accessible inline translate toggle and uses cache on toggle
    let translateRequests = 0;
    let openedThreadCount = 0;
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/statuses/') && u.includes('/translate')) {
        return new Response(JSON.stringify({ error: 'Not supported' }), { status: 404 });
      }
      if (u.includes('translate.googleapis.com/translate_a/single')) {
        translateRequests += 1;
        return new Response(
          JSON.stringify([
            [['Published the new cooperative workshop guide.', '新しい協力工場の案内を公開しました。', null, null]],
            null,
            'ja',
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const jaPost = toUnifiedItem({
      id: 'bluesky:at://did:plc:ja9/app.bsky.feed.post/1',
      protocol: 'bluesky',
      language: 'ja',
      content_text: '新しい協力工場の案内を公開しました。',
      date_published: '2026-11-20T10:05:00Z',
      author: { id: 'did:plc:ja9', name: 'Ken', handle: 'ken.bsky.social' },
      _meta: { bluesky: { uri: 'at://did:plc:ja9/app.bsky.feed.post/1', cid: 'cid_ja9' } },
    });

    const jaCard = createPostCard(jaPost, {
      onOpenThread: () => { openedThreadCount += 1; },
    });
    const origBody = jaCard.querySelector('.post-body-html');
    const trBody = jaCard.querySelector('.post-translated-body');
    const trBtn = jaCard.querySelector('.post-translate-btn');
    const trMeta = jaCard.querySelector('.post-translate-meta');

    assert.equal(origBody.getAttribute('lang'), 'ja');
    assert.ok(trBody && trBody.hidden === true);
    assert.equal(trBody.getAttribute('lang'), 'en');
    assert.ok(trBtn && trBtn.type === 'button');
    assert.ok(trBtn.textContent.includes('Translate from Japanese'));

    trBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(openedThreadCount, 0, 'Clicking translate button must not open thread');
    assert.equal(translateRequests, 1);
    assert.equal(origBody.hidden, true);
    assert.equal(trBody.hidden, false);
    assert.ok(trBody.innerHTML.includes('Published the new cooperative workshop guide.'));
    assert.equal(trMeta.hidden, false);
    assert.ok(trMeta.textContent.includes('Translated from Japanese'));
    assert.ok(trBtn.textContent.includes('Show original'));

    // Toggling back and forth reuses cached result with zero additional fetch calls
    trBtn.click();
    assert.equal(origBody.hidden, false);
    assert.equal(trBody.hidden, true);
    assert.equal(trMeta.hidden, true);
    assert.ok(trBtn.textContent.includes('Translate from Japanese'));

    trBtn.click();
    assert.equal(origBody.hidden, true);
    assert.equal(trBody.hidden, false);
    assert.equal(translateRequests, 1);

    // Direct translateUnifiedPost call with error recovery path
    clearTranslationCacheForTests();
    let failOnce = true;
    const errCard = createPostCard(mastoNormFr, {
      onTranslatePost: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('Network unreachable');
        }
        return translateUnifiedPost({
          id: 'mastodon:mock_err_ok',
          protocol: 'mastodon',
          language: 'fr',
          content_text: 'Bonjour.',
        }).catch(() => ({ text: 'Hello.', html: '<p>Hello.</p>', detectedSourceLanguage: 'fr' }));
      },
    });
    const errBtn = errCard.querySelector('.post-translate-btn');
    const errStatus = errCard.querySelector('.post-translate-error');
    assert.equal(errStatus.getAttribute('role'), 'status');
    errBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(errBtn.textContent.includes('Retry translation'));
    assert.ok(errStatus.textContent.includes('Translation unavailable'));
  } finally {
    clearTranslationCacheForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Visual URL truncation preserves full textContent, stripHtmlToText, and skips human labels or pre-truncated ellipsis', async () => {
  const dom = installMockDom();
  try {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    const {
      MAX_VISIBLE_URL_CHARS,
      renderSanitizedHtml,
    } = await import('../web/queries/fediverse.js');
    const { renderBskyRichTextToHtml } = await import('../web/queries/bluesky.js');
    const { plainTextToHtml, stripHtmlToText } = await import('../web/core/schema/unifiedItem.js');
    const { createPostCard } = await import('../web/components/PostCard.js');

    assert.equal(MAX_VISIBLE_URL_CHARS, 26);
    const longUrl = 'https://docs.google.com/document/d/e/2PACX-1vSM3FIWv7JoAiUECvR9DiukYFePGcUEJILQLyjvokmO2xGBwHCAsMGTpFk8nxVO2bMunZSFpsdcgIVL/pub';

    // 1. plainTextToHtml + renderBskyRichTextToHtml emit .invisible and .ellipsis while preserving stripHtmlToText
    const plainHtml = plainTextToHtml(`Check out ${longUrl} today`);
    assert.ok(plainHtml.includes('class="invisible"'), 'plainTextToHtml must hide scheme via .invisible');
    assert.ok(plainHtml.includes('class="ellipsis"'), 'plainTextToHtml must cap visible portion via .ellipsis');
    assert.equal(stripHtmlToText(plainHtml), `Check out ${longUrl} today`);

    const facetEnd = new TextEncoder().encode(`Check out ${longUrl}`).length;
    const facetStart = new TextEncoder().encode('Check out ').length;
    const bskyHtml = renderBskyRichTextToHtml(`Check out ${longUrl} today`, [
      {
        index: { byteStart: facetStart, byteEnd: facetEnd },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: longUrl }],
      },
    ]);
    assert.ok(bskyHtml.includes('class="invisible"'));
    assert.ok(bskyHtml.includes('class="ellipsis"'));
    assert.equal(stripHtmlToText(bskyHtml), `Check out ${longUrl} today`);

    // 2. Already-truncated Bluesky facet label ending in ... and multi-word human anchor labels are NOT double-truncated
    const preTruncBox = dom.document.createElement('div');
    renderSanitizedHtml(preTruncBox, `<p><a href="${longUrl}">youtu.be/JLjyYDakdXo?...</a></p>`);
    assert.equal(preTruncBox.querySelectorAll('.ellipsis').length, 0);
    assert.equal(preTruncBox.querySelector('a').textContent, 'youtu.be/JLjyYDakdXo?...');

    const humanLabelBox = dom.document.createElement('div');
    renderSanitizedHtml(humanLabelBox, `<p><a href="${longUrl}">Read the full document here</a></p>`);
    assert.equal(humanLabelBox.querySelectorAll('.ellipsis').length, 0);
    assert.equal(humanLabelBox.querySelector('a').textContent, 'Read the full document here');

    // 3. Bare raw URL <a> inside sanitized HTML + Mastodon server spans survive renderSanitizedHtml
    const bareBox = dom.document.createElement('div');
    renderSanitizedHtml(bareBox, `<p><a href="${longUrl}">${longUrl}</a></p>`);
    assert.ok(bareBox.querySelector('a .invisible'));
    assert.ok(bareBox.querySelector('a .ellipsis'));
    assert.equal(bareBox.querySelector('a').textContent, longUrl);

    const mastoSpanBox = dom.document.createElement('div');
    renderSanitizedHtml(
      mastoSpanBox,
      `<p><a href="${longUrl}"><span class="invisible">https://</span><span class="ellipsis">docs.google.com/docum</span><span class="invisible">ent/d/rest</span></a></p>`
    );
    assert.equal(mastoSpanBox.querySelectorAll('a .invisible').length, 2);
    assert.equal(mastoSpanBox.querySelectorAll('a .ellipsis').length, 1);
    assert.equal(mastoSpanBox.querySelector('a').textContent, 'https://docs.google.com/document/d/rest');

    // 4. PostCard body and QuotePostCard render truncated URLs without nesting <a> inside <button>
    const itemWithQuote = toUnifiedItem({
      id: 'bluesky:at://did:plc:u_url/app.bsky.feed.post/1',
      protocol: 'bluesky',
      content_text: `Moon Heart notes: ${longUrl}`,
      date_published: '2026-11-20T12:00:00Z',
      author: { id: 'did:plc:u_url', name: 'Davy', handle: 'davy.bsky.social' },
      _meta: {
        bluesky: { uri: 'at://did:plc:u_url/app.bsky.feed.post/1', cid: 'c_url_1' },
        quotePost: {
          id: 'bluesky:at://did:plc:q1/app.bsky.feed.post/2',
          protocol: 'bluesky',
          url: 'https://bsky.app/profile/q1.bsky.social/post/2',
          author: { name: 'Quoted', handle: 'q1.bsky.social' },
          text: `Quoted doc: ${longUrl}`,
        },
      },
    });
    const card = createPostCard(itemWithQuote);
    const bodyEl = card.querySelector('.post-body-html');
    assert.ok(bodyEl.querySelector('a .ellipsis'), 'PostCard body must visually truncate raw HTTP URL');
    assert.ok(bodyEl.querySelector('a .invisible'));
    assert.ok(bodyEl.textContent.includes(longUrl), 'DOM textContent must preserve complete URL');

    const quoteEl = card.querySelector('.post-quote-card');
    assert.ok(quoteEl);
    assert.equal(quoteEl.querySelectorAll('a').length, 0, 'Quote card button must not contain nested <a>');
    const quoteUrlSpan = quoteEl.querySelector('.post-quote-url');
    assert.ok(quoteUrlSpan, 'Quote card must wrap raw HTTP URL in .post-quote-url');
    assert.ok(quoteUrlSpan.querySelector('.ellipsis'));
    assert.ok(quoteUrlSpan.querySelector('.invisible'));
    assert.ok(quoteUrlSpan.textContent.includes(longUrl));
  } finally {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    dom.restore();
  }
});

test('Account mute and block persist across Feed harvests, AuthorSheet, SettingsModal, and isolate Mastodon instances', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let settingsHandle = null;
  let authorSheetHandle = null;

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetModerationCacheForTests();
    clearHarvesterCacheForTests();

    const { openAuthorSheetModal } = await import('../web/components/AuthorSheetModal.js');
    const { openSettingsModal } = await import('../web/components/sanctuary/SettingsModal.js');
    const { activityStore, removeActivityByActor, resetActivityStoreForTests } = await import('../web/state/activityStore.js');
    const {
      DEFAULT_FEED_TUNING,
      hydrateCachedModeration,
      purgeModeratedAuthorAffinity,
      removePostAcrossStreams,
    } = await import('../web/state/feedStore.js');
    const { harvestSanctuaryFeed } = await import('../web/queries/feedHarvester.js');
    const { toggleMuteAuthor } = await import('../web/queries/socialClient.js');
    const { isUnifiedItemModerated } = await import('../web/core/schema/unifiedItem.js');
    const { getLocalModeratedAccounts } = await import('../web/storage/nativeStore.js');

    resetActivityStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fediverse:davy@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davy',
        acct: 'davy@mastodon.social',
        userId: 'u_davy',
      },
      { accessToken: 'tok_davy' }
    );

    const bskyMillPost = {
      uri: 'at://did:plc:mill123/app.bsky.feed.post/p1',
      cid: 'cid_mill_1',
      author: {
        did: 'did:plc:mill123',
        handle: 'millmessenger.bsky.social',
        displayName: 'MILL MESSENGER',
      },
      record: {
        text: 'Billionaires Always Want to Maintain Control #socialism',
        createdAt: new Date(Date.now() - 120_000).toISOString(),
      },
      indexedAt: new Date(Date.now() - 120_000).toISOString(),
      likeCount: 2,
      repostCount: 0,
      replyCount: 0,
    };
    const bskyKeepPost = {
      uri: 'at://did:plc:keep456/app.bsky.feed.post/k1',
      cid: 'cid_keep_1',
      author: {
        did: 'did:plc:keep456',
        handle: 'coopnews.bsky.social',
        displayName: 'Co-op News',
      },
      record: {
        text: 'Worker cooperative annual report published today.',
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      },
      indexedAt: new Date(Date.now() - 60_000).toISOString(),
      likeCount: 5,
      repostCount: 1,
      replyCount: 0,
    };
    const bridgyMillStatus = {
      id: 'm_bridgy_mill',
      created_at: new Date(Date.now() - 110_000).toISOString(),
      content: '<p>Bridgy mirrored union note</p>',
      url: 'https://bsky.brid.gy/r/mill',
      account: {
        id: 'm_u_bridgy',
        username: 'millmessenger.bsky.social',
        acct: 'millmessenger.bsky.social@bsky.brid.gy',
        display_name: 'MILL MESSENGER (Bridgy)',
      },
    };
    const fosstodonAlice = {
      id: 'm_foss_alice',
      created_at: new Date(Date.now() - 90_000).toISOString(),
      content: '<p>Alice on Fosstodon</p>',
      url: 'https://fosstodon.org/@alice/1',
      account: { id: '9901', username: 'alice', acct: 'alice@fosstodon.org', display_name: 'Alice Foss' },
    };
    const kolektivaAlice = {
      id: 'm_kol_alice',
      created_at: new Date(Date.now() - 80_000).toISOString(),
      content: '<p>Alice on Kolektiva</p>',
      url: 'https://kolektiva.social/@alice/1',
      account: { id: '7701', username: 'alice', acct: 'alice@kolektiva.social', display_name: 'Alice Kol' },
    };

    const mastoLookupCalls = [];
    const mastoMuteCalls = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      const method = String(init?.method || 'GET').toUpperCase();
      if (u.includes('app.bsky.unspecced.getPopularFeedGenerators')) {
        return new Response(
          JSON.stringify({ feeds: [{ uri: 'at://did:plc:gen1/app.bsky.feed.generator/coop-feed', displayName: 'Co-op Mutual Aid' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/app.bsky.feed.getFeed') || u.includes('/app.bsky.feed.searchPosts')) {
        return new Response(
          JSON.stringify({ feed: [{ post: bskyMillPost }, { post: bskyKeepPost }], posts: [bskyMillPost, bskyKeepPost] }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v1/timelines/tag/') || u.includes('/api/v1/timelines/public')) {
        return new Response(
          JSON.stringify([bridgyMillStatus, fosstodonAlice, kolektivaAlice]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v1/accounts/lookup')) {
        mastoLookupCalls.push(u);
        return new Response(
          JSON.stringify({ id: 'remote_9901', acct: 'alice@fosstodon.org' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v1/accounts/') && u.includes('/mute')) {
        mastoMuteCalls.push({ url: u, method });
        return new Response(JSON.stringify({ id: 'remote_9901', muting: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('/api/v1/mutes') || u.includes('/api/v1/blocks') || u.includes('/api/v2/filters')) {
        return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    // 1. Initial harvest includes @millmessenger.bsky.social when unmuted
    const initialHarvest = await harvestSanctuaryFeed({
      fediAuth: await getAuthenticatedAccount('fediverse'),
      bskyAuth: null,
      tuning: DEFAULT_FEED_TUNING,
      moderatedActors: feedStore.get().moderatedActors,
      forceRefresh: true,
    });
    assert.ok(initialHarvest.items.some((p) => p.author?.handle === 'millmessenger.bsky.social'));

    const millUnified = toUnifiedItem({
      id: 'bluesky:at://did:plc:mill123/app.bsky.feed.post/p1',
      protocol: 'bluesky',
      content_text: 'Billionaires Always Want to Maintain Control',
      date_published: '2026-11-20T12:00:00Z',
      author: { id: 'did:plc:mill123', name: 'MILL MESSENGER', handle: 'millmessenger.bsky.social' },
      _meta: { bluesky: { uri: 'at://did:plc:mill123/app.bsky.feed.post/p1', cid: 'cid_mill_1' } },
    });
    setStreamItems('feed', initialHarvest.items);
    activityStore.set({
      ...activityStore.get(),
      items: [
        {
          id: 'act_mill_1',
          protocol: 'bluesky',
          _meta: { notification: { actor: { id: 'did:plc:mill123', handle: 'millmessenger.bsky.social' } } },
          author: { id: 'did:plc:mill123', handle: 'millmessenger.bsky.social' },
        },
      ],
    });
    recordBehavioralSignal(millUnified, 'open_thread');

    // 2. Mute @millmessenger.bsky.social while Bluesky bridge is offline (public AppView case)
    await toggleMuteAuthor(millUnified.author.id, false, {
      protocol: 'bluesky',
      acct: 'millmessenger.bsky.social',
      displayName: 'MILL MESSENGER',
    });
    removePostAcrossStreams((it) => isUnifiedItemModerated(it, feedStore.get().moderatedActors));
    removeActivityByActor(millUnified.author, 'bluesky');
    purgeModeratedAuthorAffinity([
      canonicalizeActorHandle('millmessenger.bsky.social', 'bluesky'),
      'did:plc:mill123',
    ]);

    assert.ok(feedStore.get().moderatedActors.includes('bluesky:millmessenger.bsky.social'));
    assert.ok(feedStore.get().moderatedActors.some((k) => k.includes('did:plc:mill123')));
    assert.equal(
      feedStore.get().streams.feed.items.some((p) => (p.author?.handle || '').includes('millmessenger')),
      false,
      'Native Bluesky and Bridgy mirror posts must be removed from Feed immediately'
    );
    assert.equal(activityStore.get().items.length, 0);
    assert.equal(feedStore.get().implicitAuthors['bluesky:millmessenger.bsky.social'], undefined);

    // 3. Simulated app reload: re-hydrate moderation from nativeStore and re-harvest upstream Feed
    clearHarvesterCacheForTests();
    resetFeedStoreForTests();
    await hydrateCachedModeration();
    const afterReloadHarvest = await harvestSanctuaryFeed({
      fediAuth: await getAuthenticatedAccount('fediverse'),
      bskyAuth: null,
      tuning: DEFAULT_FEED_TUNING,
      moderatedActors: feedStore.get().moderatedActors,
      forceRefresh: true,
    });
    assert.equal(
      afterReloadHarvest.items.some((p) => (p.author?.handle || '').includes('millmessenger')),
      false,
      'Muted Bluesky account must remain filtered after reload and fresh Feed harvest'
    );

    // Also verify upstream Bluesky viewer.muted flag is filtered by applyKeywordFilters
    const viewerMutedItem = toUnifiedItem({
      id: 'bluesky:at://did:plc:vm9/app.bsky.feed.post/1',
      protocol: 'bluesky',
      content_text: 'Server-muted Bluesky post',
      date_published: '2026-11-20T12:00:00Z',
      author: { id: 'did:plc:vm9', handle: 'vm9.bsky.social', viewer: { muted: true } },
      _meta: { bluesky: { uri: 'at://did:plc:vm9/app.bsky.feed.post/1', viewerMuted: true } },
    });
    assert.equal(applyKeywordFilters([viewerMutedItem, millUnified], [], feedStore.get().moderatedActors).length, 0);

    // 4. AuthorSheetModal reflects Muted badge + Unmute button even when disconnected
    authorSheetHandle = openAuthorSheetModal({
      author: { id: 'did:plc:mill123', name: 'MILL MESSENGER', handle: 'millmessenger.bsky.social', protocol: 'bluesky' },
      item: millUnified,
    });
    await new Promise((r) => setTimeout(r, 20));
    const sheetDlg = dom.document.getElementById('author-sheet-dialog');
    assert.ok(sheetDlg);
    assert.ok(sheetDlg.textContent.includes('Muted'));
    assert.ok(sheetDlg.textContent.includes('Unmute'));
    authorSheetHandle?.close?.();
    authorSheetHandle = null;

    // 5. SettingsModal -> Moderation lists locally persisted @millmessenger.bsky.social and Unmute clears it
    settingsHandle = openSettingsModal({ initialTab: 'moderation' });
    await new Promise((r) => setTimeout(r, 30));
    const settingsDlg = dom.document.getElementById('connection-settings-dialog');
    assert.ok(settingsDlg && settingsDlg.textContent.includes('millmessenger.bsky.social'));
    const unmuteBtn = Array.from(settingsDlg.querySelectorAll('button')).find(
      (b) => b.textContent.trim() === 'Unmute'
    );
    assert.ok(unmuteBtn, 'SettingsModal must show Unmute button for locally muted Bluesky account');
    unmuteBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(feedStore.get().moderatedActors.includes('bluesky:millmessenger.bsky.social'), false);
    const localAfterUnmute = await getLocalModeratedAccounts();
    assert.equal(
      localAfterUnmute.mutes.some((m) => String(m.acct || m.username || '').includes('millmessenger')),
      false
    );
    settingsHandle?.close?.();
    settingsHandle = null;

    // 6. Mastodon remote instance mute resolves lookup_account and isolates same username across instances
    const fossUnified = toUnifiedItem({
      network: 'fediverse',
      id: 'm_foss_alice',
      instanceUrl: 'https://fosstodon.org',
      content_text: 'Alice on Fosstodon',
      date_published: '2026-11-20T12:00:00Z',
      author: { id: '9901', name: 'Alice Foss', handle: 'alice@fosstodon.org' },
      _meta: { mastodon: { statusId: 'm_foss_alice', instanceUrl: 'https://fosstodon.org' } },
    });
    const kolUnified = toUnifiedItem({
      network: 'fediverse',
      id: 'm_kol_alice',
      instanceUrl: 'https://kolektiva.social',
      content_text: 'Alice on Kolektiva',
      date_published: '2026-11-20T12:00:00Z',
      author: { id: '7701', name: 'Alice Kol', handle: 'alice@kolektiva.social' },
      _meta: { mastodon: { statusId: 'm_kol_alice', instanceUrl: 'https://kolektiva.social' } },
    });
    await toggleMuteAuthor(fossUnified.author.id, false, {
      protocol: 'mastodon',
      acct: 'alice@fosstodon.org',
      displayName: 'Alice Foss',
      instanceUrl: 'https://fosstodon.org',
    });
    assert.ok(mastoLookupCalls.some((u) => u.includes('alice%40fosstodon.org') || u.includes('alice@fosstodon.org')));
    assert.ok(mastoMuteCalls.some((c) => c.url.includes('/api/v1/accounts/remote_9901/mute')));
    assert.equal(isUnifiedItemModerated(fossUnified, feedStore.get().moderatedActors), true);
    assert.equal(isUnifiedItemModerated(kolUnified, feedStore.get().moderatedActors), false);
  } finally {
    authorSheetHandle?.close?.();
    settingsHandle?.close?.();
    clearHarvesterCacheForTests();
    resetMemoryStorageForTests();
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Default Sanctuary discovery sources, Lemmy v3 post harvesting, and auth-gated Mastodon trends fallback work cleanly', async () => {
  assert.deepEqual([...DEFAULT_SANCTUARY_CHANNELS], [
    'council communism',
    'left communism',
    'workers councils',
    'historical materialism',
    'pannekoek',
    'at://did:plc:b3mupbm5prwiusw43fy7dgwb/app.bsky.feed.generator/aaadx3mkuxx7i',
  ]);
  assert.deepEqual([...DEFAULT_SANCTUARY_INSTANCES], [
    'kolektiva.social',
    'social.coop',
    'union.place',
    'todon.eu',
    'todon.nl',
    'babka.social',
    'lemmy.ml',
    'hexbear.net',
    'lemmygrad.ml',
    'lemmy.dbzer0.com',
  ]);
  assert.equal(conceptToHashtag('workers councils'), 'workerscouncils');
  assert.equal(conceptToHashtag('worker councils'), 'workerscouncils');
  assert.deepEqual(normalizeFeedTuning({ discoveryInstances: ['://lemmy.dbzer0.com'] }).discoveryInstances, ['lemmy.dbzer0.com']);

  const seenUrls = [];
  const mockFetch = async (url) => {
    const u = String(url);
    seenUrls.push(u);
    if (u.startsWith('https://hexbear.net/api/v3/post/list')) {
      return new Response(
        JSON.stringify({
          next_page: 'P99ec80',
          posts: [
            {
              post: {
                id: 10089572,
                name: 'Council communism discussion thread',
                body: 'Notes on workers councils.\n\nSecond paragraph.',
                url: 'https://example.org/essay',
                ap_id: 'https://hexbear.net/post/10089572',
                published: '2026-11-20T19:59:17Z',
                nsfw: false,
              },
              creator: {
                id: 220,
                name: 'wombat',
                display_name: 'wombat',
                actor_id: 'https://hexbear.net/u/wombat',
              },
              community: {
                id: 342883,
                name: 'theory',
                nsfw: false,
              },
              counts: {
                comments: 4,
                upvotes: 19,
                score: 19,
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://lemmy.dbzer0.com/api/v3/post/list')) {
      return new Response(
        JSON.stringify({
          next_page: 'P4b142c4',
          posts: [
            {
              post: {
                id: 78726672,
                name: 'Mutual aid infographic',
                url: 'https://lemmy.dbzer0.com/pictrs/image/sample.webp',
                thumbnail_url: 'https://lemmy.dbzer0.com/pictrs/image/thumb.webp',
                ap_id: 'https://lemmy.dbzer0.com/post/78726672',
                published: '2026-11-20T21:18:11Z',
              },
              creator: {
                id: 15,
                name: 'archivist',
                actor_id: 'https://lemmy.dbzer0.com/u/archivist',
              },
              community: { name: 'anarchism', nsfw: false },
              counts: { comments: 1, upvotes: 7 },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://todon.eu/api/v1/timelines/public')) {
      return new Response(JSON.stringify({ error: 'This method requires an authenticated user' }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.startsWith('https://todon.eu/api/v1/trends/statuses')) {
      return new Response(
        JSON.stringify([
          {
            id: 't_trend_1',
            created_at: '2026-11-20T20:39:43.000Z',
            content: '<p>Trending status on todon.eu</p>',
            url: 'https://todon.eu/@member/1',
            uri: 'https://todon.eu/users/member/statuses/1',
            account: { id: 'm1', username: 'member', acct: 'member', display_name: 'Member' },
            media_attachments: [],
            emojis: [],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const hexbearPage = await getLemmyLocalPosts({ instanceUrl: 'https://hexbear.net', limit: 12, fetchImpl: mockFetch });
  assert.equal(hexbearPage.items.length, 1);
  assert.equal(hexbearPage.nextCursor, 'P99ec80');
  assert.equal(hexbearPage.items[0].linkCard.url, 'https://example.org/essay');
  assert.equal(hexbearPage.items[0].author.acct, 'wombat@hexbear.net');

  const dbzPage = await fetchDiscoveryInstanceTimeline({ host: 'lemmy.dbzer0.com', maxId: 'P100', fetchImpl: mockFetch });
  assert.equal(dbzPage.items.length, 1);
  assert.equal(dbzPage.items[0].media[0].url, 'https://lemmy.dbzer0.com/pictrs/image/sample.webp');
  assert.ok(seenUrls.some((u) => u.includes('lemmy.dbzer0.com/api/v3/post/list') && u.includes('page_cursor=P100')));

  const todonPage = await fetchDiscoveryInstanceTimeline({ host: 'todon.eu', fetchImpl: mockFetch });
  assert.equal(todonPage.items.length, 1);
  assert.equal(todonPage.items[0].id, 't_trend_1');
  assert.ok(seenUrls.some((u) => u.includes('todon.eu/api/v1/trends/statuses')));

  const harvested = await harvestSanctuaryFeed({
    tuning: {
      sliders: { recencyHalfLifeHours: 8 },
      discoveryChannels: ['council communism', 'at://did:plc:b3mupbm5prwiusw43fy7dgwb/app.bsky.feed.generator/aaadx3mkuxx7i'],
      discoveryInstances: ['hexbear.net', 'todon.eu'],
    },
    fetchImpl: mockFetch,
    forceRefresh: true,
  });
  assert.ok(harvested.items.some((it) => it.content_text.includes('Council communism discussion thread')));
  assert.ok(harvested.items.some((it) => it.content_text.includes('Trending status on todon.eu')));
});

test('Threads client relays via /api/social/threads-proxy when Sanctuary node is online and falls back to direct fetch when dormant', async () => {
  const prevFetch = globalThis.fetch;
  const prevLoc = globalThis.location;
  globalThis.location = { origin: 'http://127.0.0.1:5000', protocol: 'http:', hostname: '127.0.0.1', port: '5000' };

  const { verifyThreadsCredentials, deleteThreadsPost, exchangeThreadsLongLivedToken } = await import('../web/queries/threads.js');
  const calls = [];
  let proxyMode = 'ok';

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url: u, method: init?.method || 'GET', body: bodyText });
    if (u === 'http://127.0.0.1:5000/api/social/threads-proxy') {
      const payload = JSON.parse(bodyText);
      if (proxyMode === 'err400') {
        return new Response(
          JSON.stringify({
            status: 400,
            body: { error: { message: 'Invalid OAuth access token', error_user_msg: 'Token expired' } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (payload.method === 'DELETE') {
        return new Response(JSON.stringify({ status: 200, body: { success: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({ status: 200, body: { id: 'th_uid_1', username: 'davy_threads' } }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.startsWith('https://graph.threads.net/access_token')) {
      return new Response(JSON.stringify({ access_token: 'long_tok_1', expires_in: 5184000 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  };

  try {
    resetConnectionStoreForTests();
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });

    const me = await verifyThreadsCredentials({ accessToken: 'th_tok_1' });
    assert.equal(me.username, 'davy_threads');
    assert.equal(calls[0].url, 'http://127.0.0.1:5000/api/social/threads-proxy');
    const firstPayload = JSON.parse(calls[0].body);
    assert.equal(firstPayload.method, 'GET');
    assert.ok(firstPayload.url.startsWith('https://graph.threads.net/v1.0/me?'));

    const delRes = await deleteThreadsPost({ postId: '9988', accessToken: 'th_tok_1' });
    assert.equal(delRes.success, true);
    assert.equal(JSON.parse(calls[1].body).method, 'DELETE');

    proxyMode = 'err400';
    await assert.rejects(
      () => verifyThreadsCredentials({ accessToken: 'bad_tok' }),
      (err) => err?.name === 'FetchError' && err.status === 400 && err.message === 'Token expired'
    );

    // Dormant mode bypasses the desktop proxy and uses direct fetch (for standalone PWA / APK)
    resetConnectionStoreForTests();
    const exchanged = await exchangeThreadsLongLivedToken({ clientSecret: 'sec', accessToken: 'short_tok' });
    assert.equal(exchanged.access_token, 'long_tok_1');
    assert.ok(calls[calls.length - 1].url.startsWith('https://graph.threads.net/access_token?'));
  } finally {
    resetConnectionStoreForTests();
    globalThis.location = prevLoc;
    globalThis.fetch = prevFetch;
  }
});
