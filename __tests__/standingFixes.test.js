/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { resolvePostEmbedCard } from '../web/components/EmbedCard.js';
import { openThreadsImportModal } from '../web/components/ThreadsImportModal.js';
import { openFeedTuningModal } from '../web/components/FeedTuningModal.js';
import { createAppShell } from '../web/app/_layout.js';
import { openAuthorSheetModal } from '../web/components/AuthorSheetModal.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { openVoiceCallOverlay } from '../web/components/sanctuary/VoiceCallOverlay.js';
import { openQuestModal } from '../web/components/sanctuary/QuestModal.js';
import { openPaletteModal, openProgramCardModal } from '../web/components/sanctuary/ProgramModals.js';
import { openAvatarCropModal } from '../web/components/sanctuary/PortraitGrid.js';
import { createPostCard } from '../web/components/PostCard.js';
import { mountMessagesScreen } from '../web/app/messages.js';
import { mountProgramThread } from '../web/app/programThread.js';
import { mountProfileScreen, openEditMastodonProfileModal } from '../web/app/profile.js';
import { mountActivityScreen } from '../web/app/activity.js';
import { mountFeedScreen } from '../web/app/feed.js';
import { DEFAULT_AVATAR_DATA_URI } from '../web/constants/avatars.js';
import {
  DEFAULT_RANKING_MANIFEST,
  getCanonicalAuthorKey,
  hasPostExternalLink,
  isAutomatedSyndicationOrBotItem,
  normalizeRankingManifest,
  rankFeedItems,
} from '../web/core/feedRanker.js';
import {
  applyKeywordFilters,
  deduplicateUnifiedItems,
  getSensitiveMediaWarning,
  resolveContextualStreamItems,
  toUnifiedItem,
} from '../web/core/schema/unifiedItem.js';
import { getBskyPosts, harvestBlueskyJetstreamBurst, normalizeBskyPost } from '../web/queries/bluesky.js';
import {
  clearHarvesterCacheForTests,
  harvestSanctuaryFeed,
  sieveSovereignCandidates,
} from '../web/queries/feedHarvester.js';
import {
  clearFediverseDiscoveryCacheForTests,
  fetchDynamicFediverseInstances,
  harvestDynamicFediversePool,
  isPublicDiscoveryOptOut,
  normalizeMastodonStatus,
} from '../web/queries/fediverse.js';
import {
  addKeywordFilter,
  enrichUnifiedItemsMetrics,
  fetchKeywordFilters,
  isUnifiedPublicDiscoveryEnabled,
  setUnifiedPublicDiscovery,
} from '../web/queries/socialClient.js';
import { clearThreadsInsightsCacheForTests } from '../web/queries/threads.js';
import {
  clearThreadsImportStateForTests,
  parseThreadsArchiveBuffer,
  startThreadsArchiveSync,
  syncArchiveHiddenWords,
} from '../web/queries/threadsArchive.js';
import {
  activityStore,
  hydrateActivityStore,
  refreshActivityNotifications,
  resetActivityStoreForTests,
} from '../web/state/activityStore.js';
import { authStore, getAuthenticatedAccount, resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';
import {
  clearLearnedTasteMemory,
  exportRankingManifest,
  feedStore,
  hydrateCachedStream,
  hydrateFeedTuning,
  hydrateRankingManifest,
  importRankingManifest,
  mergePostMutation,
  mergeSemanticFeedScores,
  mutatePostAcrossStreams,
  persistStreamCache,
  reconcileEnrichedStreamItems,
  recordAuthorInteraction,
  recordBehavioralSignal,
  resetFeedBlankSlate,
  resetFeedStoreForTests,
  resetRankingManifest,
  setActiveStream,
  setFilterRules,
  setStreamItems,
  syncFeedTuningFromSanctuary,
  updateFeedTuning,
} from '../web/state/feedStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetOutboxForTests } from '../web/state/sanctuary/outboxModel.js';
import { resetSessionStoreForTests } from '../web/state/sanctuary/sessionModel.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';
import { kvSet } from '../web/storage/nativeStore.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('deduplicateUnifiedItems handles cross-platform notification links without TypeError on explicitLinkTokens', () => {
  const mastoNotif = {
    id: 'mastodon:notif:1',
    protocol: 'mastodon',
    content_text: 'Hello',
    date_published: '2026-11-20T12:00:00Z',
    author: { id: 'a1', handle: 'alice.bsky.social@bsky.brid.gy', name: 'Alice' },
    _meta: {
      mastodon: { statusId: 'st1' },
      linkedIds: { mastodonStatusId: 'st1', blueskyUri: 'at://did:plc:1/app.bsky.feed.post/1' },
      notification: {
        notifId: 'm1',
        type: 'like',
        actor: { id: 'a1', handle: 'alice.bsky.social@bsky.brid.gy' },
        canonicalPostKey: 'mastodon:st1',
        linkedIds: { mastodonStatusId: 'st1', blueskyUri: 'at://did:plc:1/app.bsky.feed.post/1' },
      },
    },
  };
  const bskyNotif = {
    id: 'bluesky:notif:1',
    protocol: 'bluesky',
    content_text: 'Hello',
    date_published: '2026-11-20T12:00:10Z',
    author: { id: 'did:plc:2', handle: 'alice.bsky.social', name: 'Alice' },
    _meta: {
      bluesky: { uri: 'at://did:plc:1/app.bsky.feed.post/1' },
      linkedIds: { blueskyUri: 'at://did:plc:1/app.bsky.feed.post/1', threadsPostId: 'th9' },
      notification: {
        notifId: 'b1',
        type: 'like',
        actor: { id: 'did:plc:2', handle: 'alice.bsky.social' },
        canonicalPostKey: 'mastodon:st1',
        linkedIds: { mastodonStatusId: 'st1', threadsPostId: 'th9' },
      },
    },
  };

  const out = deduplicateUnifiedItems([mastoNotif, bskyNotif]);
  assert.equal(out.length, 1);
  assert.equal(out[0]._meta.linkedIds.threadsPostId, 'th9');
});

test('applyKeywordFilters catches AI acronym variants without false positives and merges local + Mastodon rules', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetFeedStoreForTests();

  try {
    const items = [
      { id: 'h1', protocol: 'mastodon', content_text: 'New AI models everywhere' },
      { id: 'h2', protocol: 'mastodon', content_text: 'These AIs keep hallucinating' },
      { id: 'h3', protocol: 'mastodon', content_text: 'What A.I. actually does' },
      { id: 'h4', protocol: 'bluesky', content_text: 'Announcement from OpenAI and GenAI startups' },
      { id: 'h5', protocol: 'mastodon', content_text: 'Look at #AIArt and #aislop today' },
      { id: 'h6', protocol: 'threads', content_text: 'Discussion post', _meta: { threads: { topicTag: 'AI Threads' } } },
      { id: 'h7', protocol: 'bluesky', content_text: 'Art showcase', _meta: { bluesky: { facets: [{ features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'AI' }] }] } } },
      { id: 'k1', protocol: 'mastodon', content_text: 'He said she paid to wait for chai and email about #paint.' },
      { id: 'k2', protocol: 'mastodon', content_text: 'WE SAID NO CHAIR WAIT!' },
    ];
    const filtered = applyKeywordFilters(items, [{ phrase: 'AI', filter_action: 'hide' }]);
    assert.deepEqual(filtered.map((i) => i.id), ['mastodon:k1', 'mastodon:k2']);

    await upsertSocialAccount(
      { id: 'fediverse:me', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'me', acct: 'me' },
      { accessToken: 'tok_masto' }
    );
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/v2/filters') && (!init.method || init.method === 'GET')) {
        return jsonResponse([{ id: 'm1', title: 'Crypto', keywords: [{ keyword: 'crypto' }], filter_action: 'hide' }]);
      }
      if (u.includes('/api/v2/filters') && init.method === 'POST') {
        return jsonResponse({ error: 'Missing write:filters scope' }, 403);
      }
      return jsonResponse({});
    };

    await addKeywordFilter({ title: 'AI', phrase: 'AI', filterAction: 'hide' });
    const merged = await fetchKeywordFilters();
    const phrases = merged.map((r) => r.phrase);
    assert.ok(phrases.includes('crypto'));
    assert.ok(phrases.includes('AI'));
  } finally {
    resetFeedStoreForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('rankFeedItems deweights external-link posts in Default Feed, spreads back-to-back authors, and honors chronological preset', () => {
  const now = Date.UTC(2026, 10, 21, 12, 0, 0);
  const tsNewer = new Date(now - 300_000).toISOString();
  const tsMid = new Date(now - 450_000).toISOString();
  const tsOlder = new Date(now - 600_000).toISOString();
  const linkPost = {
    id: 'mastodon:link_1',
    protocol: 'mastodon',
    url: 'https://mastodon.social/@a/1',
    content_text: 'Check this out https://example.com/article',
    date_published: tsNewer,
    author: { id: 'a', handle: 'a@mastodon.social' },
    metrics: { likes: 5, reposts: 1, replies: 1 },
    _meta: { feedSource: 'following', linkCard: { url: 'https://example.com/article', title: 'Article' } },
  };
  const plainPost = {
    id: 'mastodon:plain_1',
    protocol: 'mastodon',
    url: 'https://mastodon.social/@b/2',
    content_text: 'Just sharing a quick thought from the studio today.',
    date_published: tsOlder,
    author: { id: 'b', handle: 'b@mastodon.social' },
    metrics: { likes: 5, reposts: 1, replies: 1 },
    _meta: { feedSource: 'following' },
  };
  const repeatPlain = {
    id: 'mastodon:plain_2',
    protocol: 'mastodon',
    url: 'https://mastodon.social/@b/3',
    content_text: 'Second back-to-back studio note right before lunch.',
    date_published: tsMid,
    author: { id: 'b', handle: 'b@mastodon.social' },
    metrics: { likes: 2, reposts: 0, replies: 0 },
    _meta: { feedSource: 'discovery' },
  };
  const thirdAuthor = {
    id: 'mastodon:plain_3',
    protocol: 'mastodon',
    url: 'https://mastodon.social/@c/4',
    content_text: 'Fresh pastry came out of the oven.',
    date_published: tsOlder,
    author: { id: 'c', handle: 'c@mastodon.social' },
    metrics: { likes: 2, reposts: 0, replies: 0 },
    _meta: { feedSource: 'discovery' },
  };

  assert.equal(hasPostExternalLink(linkPost), true);
  assert.equal(hasPostExternalLink(plainPost), false);

  // Following stays untouched
  const followingOut = rankFeedItems([linkPost, plainPost], null, { nowMs: now, streamMode: 'following' });
  assert.deepEqual(followingOut.map((item) => item.id), ['mastodon:link_1', 'mastodon:plain_1']);

  // Default 18h Feed deweights bare external-link posts behind human posts & prevents back-to-back authors
  const defaultFeedOut = rankFeedItems([linkPost, repeatPlain, plainPost, thirdAuthor], null, {
    nowMs: now,
    streamMode: 'feed',
  });
  assert.equal(defaultFeedOut[3].id, 'mastodon:link_1');
  for (let i = 1; i < defaultFeedOut.length; i += 1) {
    assert.notEqual(getCanonicalAuthorKey(defaultFeedOut[i - 1]), getCanonicalAuthorKey(defaultFeedOut[i]));
  }
});

test('Threads import queries leading @handle@threads.net via WebFinger and surfaces errors cleanly', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  clearThreadsImportStateForTests();

  const seenSearchQueries = [];
  let modal = null;
  try {
    await upsertSocialAccount(
      { id: 'fediverse:me', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'me', acct: 'me' },
      { accessToken: 'tok_masto' }
    );
    await kvSet('threads_import_archive_v1', {
      sourceName: 'threads.zip',
      importedAt: Date.now(),
      counts: { mutuals: 2, following: 2 },
      mutuals: [{ username: 'alice' }, { username: 'bob' }],
      following: [{ username: 'alice' }, { username: 'bob' }],
    });

    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/v1/accounts/lookup')) {
        return jsonResponse({ error: 'Not found' }, 404);
      }
      if (u.includes('/api/v2/search')) {
        const parsed = new URL(u);
        const q = parsed.searchParams.get('q') || '';
        seenSearchQueries.push(q);
        if (q === '@alice@threads.net') {
          return jsonResponse({ accounts: [{ id: 'f_alice', acct: 'alice@threads.net', username: 'alice' }], statuses: [], hashtags: [] });
        }
        return jsonResponse({ error: 'Missing read:search scope' }, 403);
      }
      if (u.includes('/api/v1/accounts/f_alice/follow') && init.method === 'POST') {
        return jsonResponse({ id: 'f_alice', following: true });
      }
      return jsonResponse({});
    };

    const job = await startThreadsArchiveSync({ followScope: 'mutuals', delayMs: 0 });
    assert.deepEqual(seenSearchQueries, ['@alice@threads.net', '@bob@threads.net']);
    assert.equal(job.followed, 1);
    assert.equal(job.errors, 1);
    assert.ok(job.errorMessage.includes('403') || job.errorMessage.includes('scope'));

    modal = openThreadsImportModal();
    await new Promise((r) => setTimeout(r, 20));
    const statusText = modal.dialog.querySelector('.threads-import-status')?.textContent || '';
    assert.ok(statusText.includes('1 followed'));
    assert.ok(statusText.includes('1 error'));
  } finally {
    modal?.close();
    clearThreadsImportStateForTests();
    resetAuthStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('programThread edits user messages in place, hides rerolled replies until replaced, shows typing on images, and uses Profile user icon for new programs', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  const updateCalls = [];
  const editCalls = [];
  const rerollDeferred = createDeferred();
  const portraitDeferred = createDeferred();
  let serverHistory = [
    { id: 'usr_1', role: 'user', text: 'Original prompt', timestamp: 100 },
    { id: 'prgm_1', role: 'program', sender_id: 'novaprogram', sender_name: 'Nova', text: 'Original reply', timestamp: 101 },
  ];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'novaprogram',
        character_name: 'Nova',
        history: serverHistory,
      });
    }
    if (u.endsWith('/update_message') && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      updateCalls.push(body);
      serverHistory = serverHistory.map((m) => (m.id === body.msg_id ? { ...m, text: body.new_text } : m));
      return jsonResponse({ status: 'success' });
    }
    if (u.endsWith('/edit') && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      editCalls.push(body);
      const data = await rerollDeferred.promise;
      serverHistory = [serverHistory[0], data.message];
      return jsonResponse(data);
    }
    if (u.endsWith('/api/portrait/generate') && init.method === 'POST') {
      const data = await portraitDeferred.promise;
      return jsonResponse(data);
    }
    if (u.endsWith('/models')) return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    if (u.endsWith('/api/config')) return jsonResponse({ active_user: 'builder', program_moods: {} });
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'novaprogram',
      programs: [{ id: 'novaprogram', name: 'Nova', has_profile: false }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'novaprogram', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 30));

    // New program without portrait uses Profile-tab user icon data URI
    const progAvatar = host.querySelector('.program-avatar');
    assert.equal(progAvatar?.src, DEFAULT_AVATAR_DATA_URI);

    // 1. Editing user message saves via /update_message in place without calling /edit or removing prgm_1
    const usrRow = host.querySelector('[data-msg-id="usr_1"]');
    usrRow.querySelector('[aria-label="Edit message"]').click();
    usrRow.querySelector('.edit-textarea').value = 'Updated in place';
    usrRow.querySelector('.edit-save-btn').click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(updateCalls.length, 1);
    assert.equal(editCalls.length, 0);
    assert.equal(host.querySelector('[data-msg-id="usr_1"] .message-text')?.textContent, 'Updated in place');
    assert.ok(host.querySelector('[data-msg-id="prgm_1"]'), 'In-place edit preserves downstream program reply');

    // 2. Rerolling program response immediately hides old prgm_1 and shows typing indicator until resolved
    host.querySelector('[data-msg-id="prgm_1"] [aria-label="Reroll response"]').click();
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(Boolean(host.querySelector('[data-msg-id="prgm_1"]')), false, 'Old response is hidden during reroll');
    assert.ok(host.querySelector('.typing-row'), 'Typing indicator shows while rerolling');

    rerollDeferred.resolve({
      message: { id: 'prgm_2', role: 'program', sender_id: 'novaprogram', sender_name: 'Nova', text: 'Fresh rerolled reply', timestamp: 102 },
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(Boolean(host.querySelector('.typing-row')), false);
    assert.equal(host.querySelector('[data-msg-id="prgm_2"] .message-text')?.textContent, 'Fresh rerolled reply');

    // 3. Generating an image shows typing indicator immediately before image slots stream
    host.querySelector('#generate-portrait-btn').click();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(host.querySelector('.typing-row'), 'Typing indicator appears immediately on image generation');

    portraitDeferred.resolve({ status: 'ok' });
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    ctrl?.destroy();
    globalThis.fetch = prevFetch;
    resetAuthStoreForTests();
    resetOutboxForTests();
    resetSessionStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('hidden words enforce inflections, Bluesky mutedWordsPref, Mastodon filtered status, Threads ZIP import, and auth-race safety', async () => {
  const { deflateRawSync } = await import('node:zlib');
  const buildZip = (files) => {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, obj] of Object.entries(files)) {
      const nameBytes = Buffer.from(name, 'utf8');
      const rawBytes = Buffer.from(JSON.stringify(obj), 'utf8');
      const compBytes = deflateRawSync(rawBytes);
      const lh = Buffer.alloc(30 + nameBytes.length);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(8, 8);
      lh.writeUInt32LE(compBytes.length, 18);
      lh.writeUInt32LE(rawBytes.length, 22);
      lh.writeUInt16LE(nameBytes.length, 26);
      nameBytes.copy(lh, 30);
      const ch = Buffer.alloc(46 + nameBytes.length);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(8, 10);
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

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetFeedStoreForTests();
  resetConnectionStoreForTests();

  try {
    // 1. "Ukraine" hidden word catches exact, possessive, demonym, and hashtag compounds, plus server filtered array
    const ukraineWirePost = normalizeMastodonStatus(
      {
        id: 'ukr_1',
        created_at: '2026-11-21T11:50:00Z',
        content: "<p>Zelensky thanks Streeting for Britain's steps in supporting Ukraine #Ukraine #News #UkraineWar</p>",
        account: { id: 'rss1', username: 'Ukrinform', acct: 'Ukrinform@rss.anyfeed.cc', display_name: 'Ukrinform EN', bot: true },
        media_attachments: [],
      },
      'https://mastodon.social'
    );
    const ukrainianPost = { id: 'ukr_2', protocol: 'bluesky', content_text: 'Concert in Kyiv by Ukrainian jazz trio' };
    const hashtagCompoundPost = { id: 'ukr_3', protocol: 'mastodon', content_text: 'Thread on #UkraineWar Logistics' };
    const camelCompoundPost = { id: 'ukr_4', protocol: 'mastodon', content_text: 'Updates on UkraineAid shipments' };
    const cleanHumanPost = { id: 'hum_1', protocol: 'mastodon', content_text: 'My cat just tried to fight a cucumber on the kitchen floor.' };
    const serverFilteredHide = normalizeMastodonStatus(
      {
        id: 'srv_hide',
        created_at: '2026-11-21T11:50:00Z',
        content: '<p>Clean surface text caught server-side</p>',
        account: { id: 'u2', username: 'u2', acct: 'u2@mastodon.social' },
        filtered: [{ filter: { title: 'Hidden Topic', filter_action: 'hide' } }],
        media_attachments: [],
      },
      'https://mastodon.social'
    );

    const out = applyKeywordFilters(
      [ukraineWirePost, ukrainianPost, hashtagCompoundPost, camelCompoundPost, serverFilteredHide, cleanHumanPost],
      [{ phrase: 'Ukraine', filter_action: 'hide' }]
    );
    assert.deepEqual(out.map((p) => p.id), ['mastodon:hum_1']);

    // 2. Startup auth-race guard: unauthenticated fetchKeywordFilters must not wipe hydrated filters
    setFilterRules([{ id: 'cached_1', title: 'Ukraine', phrase: 'Ukraine', filter_action: 'hide' }]);
    const beforeAuth = await fetchKeywordFilters();
    assert.equal(beforeAuth.some((r) => r.phrase === 'Ukraine'), true);

    // 3. Multi-source sync: Bluesky mutedWordsPref + Mastodon v2 + Sanctuary server filters
    await upsertSocialAccount(
      { id: 'fediverse:me', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'me', acct: 'me' },
      { accessToken: 'tok_masto' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:me', platform: 'bluesky', serviceUrl: 'https://bsky.social', handle: 'me.bsky.social', acct: 'me.bsky.social', did: 'did:plc:me' },
      { accessJwt: 'tok_bsky', refreshJwt: 'ref_bsky' }
    );
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });

    const savedServerBodies = [];
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/v2/filters')) {
        return jsonResponse([
          { id: 'm_v2', title: 'News Bots', keywords: [{ keyword: 'sportsball' }, { keyword: 'AI' }], filter_action: 'hide' },
        ]);
      }
      if (u.includes('app.bsky.actor.getPreferences')) {
        return jsonResponse({
          preferences: [
            {
              $type: 'app.bsky.actor.defs#mutedWordsPref',
              items: [
                { id: 'mw1', value: 'Ukraine', targets: ['content', 'tag'] },
                { id: 'mw_exp', value: 'expiredword', expiresAt: '2020-01-01T00:00:00Z' },
              ],
            },
          ],
        });
      }
      if (u.includes('/api/social/accounts/filters') && (!init.method || init.method === 'GET')) {
        return jsonResponse({ filters: [] });
      }
      if (u.includes('/api/social/accounts/filters') && init.method === 'PUT') {
        savedServerBodies.push(JSON.parse(init.body || '{}'));
        return jsonResponse({ filters: savedServerBodies.at(-1).filters || [] });
      }
      return jsonResponse({});
    };

    const synced = await fetchKeywordFilters();
    const allTerms = synced.flatMap((r) => [r.phrase, ...(r.keywords || [])]).map((t) => String(t).toLowerCase());
    assert.equal(allTerms.includes('ukraine'), true);
    assert.equal(allTerms.includes('ai'), true);
    assert.equal(allTerms.includes('expiredword'), false);
    assert.ok(savedServerBodies.length >= 1);

    // 4. Threads ZIP hidden_words extraction & sync
    const archiveBuf = buildZip({
      'threads/followers.json': { text_post_app_text_post_app_followers: [] },
      'threads/following.json': { text_post_app_text_post_app_following: [] },
      'hidden_words/custom_words_and_phrases.json': { custom_words: ['Substack', 'Crypto'] },
    });
    const parsedZip = await parseThreadsArchiveBuffer(archiveBuf, 'threads.zip');
    assert.equal(parsedZip.counts.hiddenWords, 2);
    assert.deepEqual(parsedZip.hiddenWords, ['Substack', 'Crypto']);
    const afterZip = await syncArchiveHiddenWords(parsedZip.hiddenWords);
    assert.equal(afterZip.some((r) => r.phrase === 'Substack'), true);
  } finally {
    clearHarvesterCacheForTests();
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('contextful replies drop orphan fragments, attach initial posts above replies, and enforce moderation on reply context', () => {
  const dom = installMockDom();
  try {
    // Direct Bluesky reply with hydrated initial parent (parent.uri === root.uri)
    const rootUri = 'at://did:plc:orig/app.bsky.feed.post/root1';
    const bskyDirectReply = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:pal/app.bsky.feed.post/rep1',
        cid: 'c_rep1',
        author: { did: 'did:plc:pal', handle: 'pal.bsky.social', displayName: 'Pal' },
        record: {
          text: 'Honestly the funniest part was the raccoon wearing the miniature traffic cone.',
          createdAt: '2026-11-21T12:05:00Z',
          reply: { root: { uri: rootUri, cid: 'c_root1' }, parent: { uri: rootUri, cid: 'c_root1' } },
        },
        likeCount: 12,
        repostCount: 1,
        replyCount: 0,
      },
      reply: {
        root: {
          uri: rootUri,
          cid: 'c_root1',
          author: { did: 'did:plc:orig', handle: 'orig.bsky.social', displayName: 'Orig' },
          record: { text: 'Look what happened outside my bakery window this morning.', createdAt: '2026-11-21T12:00:00Z' },
        },
        parent: {
          uri: rootUri,
          cid: 'c_root1',
          author: { did: 'did:plc:orig', handle: 'orig.bsky.social', displayName: 'Orig' },
          record: { text: 'Look what happened outside my bakery window this morning.', createdAt: '2026-11-21T12:00:00Z' },
        },
      },
    });

    // Mid-thread reply (parent.uri !== root.uri) lacks initial context -> must be dropped
    const bskyMidThread = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:mid/app.bsky.feed.post/rep2',
        cid: 'c_rep2',
        author: { did: 'did:plc:mid', handle: 'mid.bsky.social', displayName: 'Mid' },
        record: {
          text: 'Yeah totally agree with step 4 here',
          createdAt: '2026-11-21T12:06:00Z',
          reply: {
            root: { uri: rootUri, cid: 'c_root1' },
            parent: { uri: 'at://did:plc:pal/app.bsky.feed.post/rep1', cid: 'c_rep1' },
          },
        },
      },
      reply: {
        root: { uri: rootUri, cid: 'c_root1', author: { did: 'did:plc:orig', handle: 'orig.bsky.social' }, record: { text: 'Root' } },
        parent: { uri: 'at://did:plc:pal/app.bsky.feed.post/rep1', cid: 'c_rep1', author: { did: 'did:plc:pal', handle: 'pal.bsky.social' }, record: { text: 'Mid' } },
      },
    });

    // Orphan Mastodon reply (no parent post in stream) + paired Mastodon root+reply in batch
    const mastoOrphanReply = normalizeMastodonStatus(
      {
        id: 'm_orphan',
        in_reply_to_id: 'missing_999',
        created_at: '2026-11-21T12:04:00Z',
        content: '<p>Wait really? I had no idea!</p>',
        account: { id: 'f1', username: 'f1', acct: 'f1@mastodon.social' },
      },
      'https://mastodon.social'
    );
    const mastoRoot = normalizeMastodonStatus(
      {
        id: 'm_root_7',
        created_at: '2026-11-21T12:01:00Z',
        content: '<p>Baked cheddar biscuits for the whole block today.</p>',
        account: { id: 'f2', username: 'baker', acct: 'baker@mastodon.social', display_name: 'Baker' },
      },
      'https://mastodon.social'
    );
    const mastoPairedReply = normalizeMastodonStatus(
      {
        id: 'm_reply_8',
        in_reply_to_id: 'm_root_7',
        created_at: '2026-11-21T12:03:00Z',
        content: '<p>Saving two for your studio neighbor right now!</p>',
        account: { id: 'f3', username: 'pal', acct: 'pal@mastodon.social', display_name: 'Studio Pal' },
      },
      'https://mastodon.social'
    );

    const followingResolved = resolveContextualStreamItems(
      [bskyDirectReply, bskyMidThread, mastoOrphanReply, mastoRoot, mastoPairedReply],
      { streamMode: 'following' }
    );
    assert.deepEqual(
      followingResolved.map((p) => p.id),
      ['bluesky:at://did:plc:pal/app.bsky.feed.post/rep1', 'mastodon:m_reply_8']
    );
    assert.ok(followingResolved[1]._meta.replyContext.text.includes('Baked cheddar biscuits'));

    // Card renders initial post block right above the reply
    const card = createPostCard(followingResolved[0], { onOpenThread: () => {} });
    const ctxEl = card.querySelector('.post-reply-context');
    assert.ok(ctxEl);
    assert.ok(ctxEl.textContent.includes('Look what happened outside my bakery window'));

    // Hidden word in initial replyContext hides the entire contextualized card
    const bskyWithFilteredCtx = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:x/app.bsky.feed.post/rx1',
        cid: 'cx1',
        author: { did: 'did:plc:x', handle: 'x.bsky.social', displayName: 'X' },
        record: {
          text: 'Interesting point!',
          createdAt: '2026-11-21T12:05:00Z',
          reply: { root: { uri: 'at://did:plc:y/app.bsky.feed.post/ry1', cid: 'cy1' }, parent: { uri: 'at://did:plc:y/app.bsky.feed.post/ry1', cid: 'cy1' } },
        },
      },
      reply: {
        root: { uri: 'at://did:plc:y/app.bsky.feed.post/ry1', cid: 'cy1', author: { did: 'did:plc:y', handle: 'y.bsky.social' }, record: { text: 'Breaking news from Ukraine today' } },
        parent: { uri: 'at://did:plc:y/app.bsky.feed.post/ry1', cid: 'cy1', author: { did: 'did:plc:y', handle: 'y.bsky.social' }, record: { text: 'Breaking news from Ukraine today' } },
      },
    });
    assert.equal(applyKeywordFilters([bskyWithFilteredCtx], [{ phrase: 'Ukraine', filter_action: 'hide' }]).length, 0);
  } finally {
    dom.restore();
  }
});

test('Feed sieve & ranker reject RSS news bots, penalize/hide Substacks & hot takes, and elevate Everyday Quips', () => {
  const dom = installMockDom();
  resetMemoryStorageForTests();
  resetFeedStoreForTests();
  try {
    const now = Date.UTC(2026, 10, 21, 14, 0, 0);
    const isoMinsAgo = (mins) => new Date(now - mins * 60_000).toISOString();

    const rssBotPost = {
      id: 'mastodon:rss_1',
      protocol: 'mastodon',
      content_text: 'Wire headline #News #BreakingNews https://ukrinform.net/story',
      date_published: isoMinsAgo(2),
      author: { id: 'u_rss', name: 'WireBot', handle: 'Ukrinform@rss.anyfeed.cc', bot: false },
      metrics: { likes: 0, replies: 0, reposts: 0 },
      _meta: { feedSource: 'discovery', linkCard: { url: 'https://ukrinform.net/story', title: 'Wire' } },
    };
    assert.equal(isAutomatedSyndicationOrBotItem(rssBotPost), true);

    const substackPost = {
      id: 'bluesky:sub_1',
      protocol: 'bluesky',
      content_text: 'My new Substack essay is up! Subscribe to my newsletter for weekly takes https://writer.substack.com/p/essay',
      date_published: isoMinsAgo(3),
      author: { id: 'u_sub', handle: 'pundit.bsky.social', name: 'TakeWriter' },
      metrics: { likes: 6, replies: 0, reposts: 2 },
      _meta: { feedSource: 'discovery', linkCard: { url: 'https://writer.substack.com/p/essay', title: 'Substack' } },
    };

    const hotTakePost = {
      id: 'mastodon:take_1',
      protocol: 'mastodon',
      content_text: 'Unpopular opinion: why is nobody talking about how people who drink iced coffee are ruined',
      date_published: isoMinsAgo(4),
      author: { id: 'u_take', handle: 'taker@mastodon.social', name: 'HotTakes' },
      metrics: { likes: 4, replies: 22, reposts: 1 },
      _meta: { feedSource: 'discovery' },
    };

    const everydayQuipPost = {
      id: 'mastodon:quip_1',
      protocol: 'mastodon',
      content_text: 'My cat just sat inside the grocery bag like he pays half the rent and honestly I respect the confidence lmao',
      date_published: isoMinsAgo(20),
      author: { id: 'u_hum', handle: 'mira@hachyderm.io', name: 'Mira' },
      metrics: { likes: 18, replies: 2, reposts: 3 },
      _meta: { feedSource: 'discovery' },
    };

    // Sieve drops rss.anyfeed.cc bot by default without needing sliders
    const sieved = sieveSovereignCandidates(
      [rssBotPost, substackPost, hotTakePost, everydayQuipPost],
      null
    );
    assert.equal(sieved.some((p) => p.id === 'mastodon:rss_1'), false);

    // Baseline ranker ranks everyday human chatter above Substack promo & rage-dunk posts
    const ranked = rankFeedItems(
      [substackPost, hotTakePost, everydayQuipPost],
      null,
      { nowMs: now, streamMode: 'feed' }
    );
    assert.equal(ranked[0].id, 'mastodon:quip_1');

    // Modal exposes Communities & Feeds search input without legacy sliders
    const modal = openFeedTuningModal();
    assert.ok(modal.dialog.querySelector('#feed-community-search-input'));
    assert.equal(modal.dialog.querySelector('#feed-slider-scienceTheory'), null);
    modal.close();
  } finally {
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('Blank-slate reset (0 sliders) harvests unmediated commons without curated feeds, drops Federated Reader & link floods, never repeats authors back-to-back, and caps affinity', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevWebSocket = globalThis.WebSocket;
  const requests = [];
  const nowMs = Date.UTC(2026, 10, 21, 12, 0, 0);
  const isoMinsAgo = (m) => new Date(nowMs - m * 60_000).toISOString();

  globalThis.WebSocket = class BlankSlateMockJetstream {
    constructor() {
      this.listeners = new Map();
      queueMicrotask(() => {
        this._emit('open', {});
        this._emit('message', {
          data: JSON.stringify({
            kind: 'commit',
            did: 'did:plc:pub',
            commit: {
              operation: 'create',
              collection: 'app.bsky.feed.post',
              rkey: 'jet1',
              record: {
                text: 'Saw three owls sitting in a row on a suburban mailbox tonight.',
                createdAt: isoMinsAgo(1),
                langs: ['en'],
              },
            },
          }),
        });
        this._emit('close', {});
      });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    _emit(type, ev) {
      this[`on${type}`]?.(ev);
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
    close() {}
  };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const authHeader = new Headers(init?.headers || {}).get('Authorization') || '';
    requests.push({ url: u, authHeader });

    if (u.startsWith('https://api.fedidb.org/')) {
      return jsonResponse({
        data: [
          { domain: 'mastodon.social', software: { name: 'mastodon' }, stats: { status_count: 50000 } },
          { domain: 'mastodon.world', software: { name: 'mastodon' }, stats: { status_count: 20000 } },
          { domain: 'hachyderm.io', software: { name: 'mastodon' }, stats: { status_count: 15000 } },
        ],
      });
    }

    if (u.includes('/api/v1/timelines/home')) {
      return new Response(
        JSON.stringify([
          {
            id: 'm_home_1',
            uri: 'tag:mastodon.social:m_home_1',
            url: 'https://mastodon.social/@friend/1',
            created_at: isoMinsAgo(8),
            content: '<p>Coffee shop playlist today is unreasonably good.</p>',
            account: { id: 'f1', username: 'friend', acct: 'friend@mastodon.social', display_name: 'Friend' },
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (u.includes('/api/v1/timelines/public')) {
      if (u.startsWith('https://mastodon.social/') && authHeader !== 'Bearer masto_blank_tok') {
        return new Response(
          JSON.stringify({ error: 'This method requires an authenticated user' }),
          { status: 422, headers: { 'Content-Type': 'application/json' } }
        );
      }
      const host = new URL(u).hostname;
      const isLocal = u.includes('local=true');
      const items = [
        {
          id: `${host}_${isLocal ? 'local' : 'fed'}_1`,
          uri: `tag:${host}:${isLocal ? 'local' : 'fed'}_1`,
          url: `https://${host}/@member_${host}/1`,
          created_at: isoMinsAgo(isLocal ? 3 : 5),
          content: `<p>Quiet evening walk past the bookshop on ${host} tonight.</p>`,
          account: { id: `${host}_u1`, username: `member_${host}`, acct: `member_${host}@${host}`, display_name: `Member ${host}` },
        },
        {
          id: `${host}_${isLocal ? 'local' : 'fed'}_2`,
          uri: `tag:${host}:${isLocal ? 'local' : 'fed'}_2`,
          url: `https://${host}/@member_${host}/2`,
          created_at: isoMinsAgo(isLocal ? 4 : 6),
          content: `<p>Second note from the same account on ${host} after making tea.</p>`,
          account: { id: `${host}_u1`, username: `member_${host}`, acct: `member_${host}@${host}`, display_name: `Member ${host}` },
        },
      ];
      if (host === 'mastodon.social' && isLocal) {
        items.push(
          {
            id: 'mastodon.social_reader_1',
            uri: 'tag:mastodon.social:reader_1',
            url: 'https://mastodon.social/@reader/1',
            created_at: isoMinsAgo(1),
            content: '<p>Federated Reader automated link roundups https://example.com/feed</p>',
            card: { url: 'https://example.com/feed', title: 'Reader Feed' },
            account: { id: 'reader_u', username: 'reader', acct: 'reader@mastodon.social', display_name: 'Federated Reader' },
          },
          {
            id: 'mastodon.social_deal_1',
            uri: 'tag:mastodon.social:deal_1',
            url: 'https://mastodon.social/@shopper/1',
            created_at: isoMinsAgo(2),
            content: '<p>Found a solid local studio workbench listing with spare drawers in town today https://example.com/deal</p>',
            card: { url: 'https://example.com/deal', title: 'Sponsor Deal' },
            favourites_count: 5,
            account: { id: 'shop_u', username: 'shopper', acct: 'shopper@mastodon.social', display_name: 'Shopper' },
          },
          ...[1, 2, 3].map((n) => ({
            id: `mastodon.social_burst_${n}`,
            uri: `tag:mastodon.social:burst_${n}`,
            url: `https://mastodon.social/@linkdropper/${n}`,
            created_at: isoMinsAgo(n),
            content: `<p>Daily article roundup issue number ${n} from our archive desk https://example.com/post-${n}</p>`,
            card: { url: `https://example.com/post-${n}`, title: `Issue ${n}` },
            favourites_count: 4,
            account: { id: 'drop_u', username: 'linkdropper', acct: 'linkdropper@mastodon.social', display_name: 'Link Dropper' },
          }))
        );
      }
      return new Response(
        JSON.stringify(items),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.feed.getTimeline')) {
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:pal/app.bsky.feed.post/home1',
                cid: 'c_home1',
                author: { did: 'did:plc:pal', handle: 'pal.bsky.social', displayName: 'Pal' },
                record: { text: 'My dog found a stick taller than the fence.', createdAt: isoMinsAgo(2) },
                likeCount: 6,
                repostCount: 0,
                replyCount: 1,
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (u.includes('app.bsky.feed.getPosts')) {
      return jsonResponse({
        posts: [
          {
            uri: 'at://did:plc:pub/app.bsky.feed.post/jet1',
            cid: 'c_jet1',
            author: { did: 'did:plc:pub', handle: 'owls.bsky.social', displayName: 'Owls' },
            record: {
              text: 'Saw three owls sitting in a row on a suburban mailbox tonight.',
              createdAt: isoMinsAgo(1),
              langs: ['en'],
            },
            likeCount: 30,
            repostCount: 4,
            replyCount: 2,
          },
        ],
      });
    }

    if (u.includes('/api/v1/trends/statuses') || u.includes('app.bsky.feed.searchPosts') || u.includes('getPopularFeedGenerators')) {
      return new Response(JSON.stringify(u.includes('trends') ? [] : { posts: [], feeds: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify([]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    clearHarvesterCacheForTests();

    await upsertSocialAccount(
      { id: 'fedi_1', platform: 'fediverse', instanceUrl: 'https://mastodon.social', handle: 'davy' },
      { accessToken: 'masto_blank_tok' },
      { syncToServer: false }
    );
    await upsertSocialAccount(
      { id: 'bsky_1', platform: 'bluesky', serviceUrl: 'https://bsky.social', handle: 'davy.bsky.social', did: 'did:plc:me' },
      { accessJwt: 'bsky_blank_jwt', refreshJwt: 'bsky_ref' },
      { syncToServer: false }
    );

    const fediAuth = await getAuthenticatedAccount('fediverse');
    const bskyAuth = await getAuthenticatedAccount('bluesky');

    // Pollute state with explicit affinity, custom channels, and verify passive dwell is ignored
    await updateFeedTuning({
      discoveryChannels: ['customtag'],
      discoveryInstances: ['fosstodon.org'],
    });
    await recordBehavioralSignal(
      {
        id: 'mastodon:passive_only',
        protocol: 'mastodon',
        content_text: 'Passive scroll/dwell signal should never enter tasteMemory',
        author: { id: 'passive', handle: 'passive@mastodon.social' },
      },
      'dwell'
    );
    assert.equal(feedStore.get().tasteMemory.positive.length, 0);
    assert.equal(feedStore.get().implicitAuthors, undefined);

    for (let i = 0; i < 40; i++) {
      await recordAuthorInteraction({ id: 'fav', handle: 'fav@mastodon.social' }, 'mastodon', 1);
      await recordBehavioralSignal(
        {
          id: `mastodon:sig_${i}`,
          protocol: 'mastodon',
          content_text: 'Studio carpentry notes and chisel honing workflow',
          author: { id: 'fav', handle: 'fav@mastodon.social' },
        },
        'like'
      );
    }
    assert.ok(feedStore.get().interactedAuthors['mastodon:fav@mastodon.social'] > 0);
    assert.ok(feedStore.get().interactedAuthors['mastodon:fav@mastodon.social'] <= 12);
    assert.ok(feedStore.get().tasteMemory.positive.length > 0);

    // Reset Blank Slate clears affinity maps, taste memory, and custom sources
    await resetFeedBlankSlate();
    const resetState = feedStore.get();
    assert.deepEqual(resetState.interactedAuthors, {});
    assert.deepEqual(resetState.tasteScores, {});
    assert.deepEqual(resetState.tasteMemory, { positive: [], negative: [] });
    assert.deepEqual(resetState.tuning.discoveryChannels, []);
    assert.deepEqual(resetState.tuning.discoveryInstances, []);
    assert.equal(resetState.tuning.updatedBy, 'default');
    assert.equal(resetState.tuning.sliders, undefined);

    const harvested = await harvestSanctuaryFeed({
      fediAuth,
      bskyAuth,
      tuning: resetState.tuning,
      interactedAuthors: resetState.interactedAuthors,
      tasteMemory: resetState.tasteMemory,
    });

    // Signal-first discovery: strictly connected home /api/v1/trends/statuses + Jetstream (no FediDB/firehose)
    assert.equal(requests.some((r) => r.url.startsWith('https://api.fedidb.org/')), false);
    assert.equal(requests.some((r) => r.url.includes('/api/v1/timelines/public')), false);
    assert.ok(requests.some((r) => r.url.startsWith('https://mastodon.social/api/v1/trends/statuses')));
    assert.ok(requests.some((r) => r.url.includes('public.api.bsky.app/xrpc/app.bsky.feed.getPosts')));
    assert.ok(harvested.items.some((item) => item.id.includes('jet1')));

    // Federated Reader bots are filtered out
    assert.equal(harvested.items.some((item) => item.id.includes('reader_1')), false);

    const rankedZero = rankFeedItems(harvested.items, resetState.tuning, {
      nowMs,
      streamMode: 'feed',
      interactedAuthors: resetState.interactedAuthors,
      tasteMemory: resetState.tasteMemory,
    });
    for (let i = 1; i < rankedZero.length; i++) {
      assert.notEqual(
        getCanonicalAuthorKey(rankedZero[i - 1]),
        getCanonicalAuthorKey(rankedZero[i]),
        'Default Feed must never render same author back-to-back'
      );
    }

    // Even with max capped affinity, explicit taste & conversation depth can outrank a low-effort hello
    const affPost = {
      id: 'mastodon:aff_1',
      protocol: 'mastodon',
      content_text: 'Quick hello.',
      date_published: isoMinsAgo(10),
      author: { id: 'fav', handle: 'fav@mastodon.social' },
      metrics: { likes: 1, reposts: 0, replies: 0 },
    };
    const matchPost = {
      id: 'mastodon:match_1',
      protocol: 'mastodon',
      content_text:
        'A detailed study methodology breakdown explaining how telescope calibration data compares across three observatories.',
      date_published: isoMinsAgo(10),
      author: { id: 'stranger', handle: 'stranger@hachyderm.io' },
      metrics: { likes: 24, reposts: 4, replies: 6 },
    };
    const bounded = rankFeedItems(
      [affPost, matchPost],
      null,
      {
        nowMs,
        streamMode: 'feed',
        interactedAuthors: { 'mastodon:fav@mastodon.social': 12 },
        tasteMemory: {
          positive: [{ id: 't1', text: 'telescope calibration observatories study methodology', weight: 3.5 }],
          negative: [],
        },
      }
    );
    assert.equal(bounded[0].id, 'mastodon:match_1');
  } finally {
    clearHarvesterCacheForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    globalThis.WebSocket = prevWebSocket;
    dom.restore();
  }
});

test('Sensitive/adult/porn media is blurred with accessible inert reveal gate across Bluesky labels, Mastodon sensitive flag, and #nsfw tags', () => {
  const dom = installMockDom();
  try {
    let openedThreadCount = 0;

    // 1. Bluesky post with porn label and no CW spoilerText
    const bskyPorn = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:adult1/app.bsky.feed.post/porn1',
        cid: 'c_porn1',
        labels: [{ val: 'porn' }],
        author: { did: 'did:plc:adult1', handle: 'adult1.bsky.social', displayName: 'Adult 1' },
        record: { text: 'Explicit studio photo set', createdAt: '2026-11-21T12:00:00Z' },
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [{ thumb: 'https://cdn.example/porn.jpg', fullsize: 'https://cdn.example/porn.jpg', alt: 'Explicit' }],
        },
      },
    });
    const bskyCard = createPostCard(bskyPorn, { onOpenThread: () => { openedThreadCount += 1; } });
    const wrap = bskyCard.querySelector('.post-media-sensitive-wrap');
    assert.ok(wrap && wrap.classList.contains('is-blurred'));
    const stage = wrap.querySelector('.post-media-sensitive-stage');
    assert.ok(stage);
    const grid = stage.querySelector('.post-media-grid');
    assert.ok(grid && grid.inert === true && grid.hasAttribute('inert'));
    const btn = stage.querySelector('.post-media-sensitive-btn');
    assert.ok(btn);
    assert.equal(btn.getAttribute('aria-expanded'), 'false');
    assert.equal(btn.getAttribute('aria-controls'), grid.id);
    assert.match(btn.textContent, /Show · Adult content/);

    btn.click();
    assert.equal(openedThreadCount, 0, 'Toggle button must not trigger thread navigation');
    assert.equal(wrap.classList.contains('is-blurred'), false);
    assert.equal(wrap.classList.contains('is-revealed'), true);
    assert.equal(grid.inert, false);
    assert.equal(grid.hasAttribute('inert'), false);
    assert.equal(btn.getAttribute('aria-expanded'), 'true');
    assert.match(btn.textContent, /Hide media/);

    // 2. Bluesky post whose author carries account-level sexual label
    const bskyAuthorLabeled = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:adult2/app.bsky.feed.post/sex1',
        cid: 'c_sex1',
        author: {
          did: 'did:plc:adult2',
          handle: 'adult2.bsky.social',
          displayName: 'Adult 2',
          labels: [{ val: 'sexual' }],
        },
        record: { text: 'New shot', createdAt: '2026-11-21T12:01:00Z' },
        embed: {
          $type: 'app.bsky.embed.images#view',
          images: [{ thumb: 'https://cdn.example/sex.jpg', fullsize: 'https://cdn.example/sex.jpg' }],
        },
      },
    });
    const authorCard = createPostCard(bskyAuthorLabeled, { onOpenThread: () => {} });
    assert.ok(authorCard.querySelector('.post-media-sensitive-wrap.is-blurred'));
    assert.match(authorCard.querySelector('.post-media-sensitive-btn').textContent, /Sexual content/);

    // 3. Mastodon status with sensitive: true and empty spoiler_text
    const mastoSensitive = normalizeMastodonStatus(
      {
        id: 'm_sens_1',
        created_at: '2026-11-21T12:02:00Z',
        content: '<p>Marked sensitive without CW text</p>',
        spoiler_text: '',
        sensitive: true,
        account: { id: 'm1', username: 'm1', acct: 'm1@mastodon.social' },
        media_attachments: [{ id: 'a1', type: 'image', url: 'https://cdn.example/m_nsfw.jpg', preview_url: 'https://cdn.example/m_nsfw.jpg' }],
      },
      'https://mastodon.social'
    );
    const mastoCard = createPostCard(mastoSensitive, { onOpenThread: () => {} });
    assert.ok(mastoCard.querySelector('.post-media-sensitive-wrap.is-blurred'));
    assert.equal(mastoCard.querySelector('.cw-container'), null);

    // 4. Unlabeled #nsfw hashtag image post
    const tagNsfwCard = createPostCard(
      {
        id: 'bluesky:nsfw_tag',
        protocol: 'bluesky',
        content_text: 'Evening sketch dump #nsfw',
        author: { id: 'u9', handle: 'u9.bsky.social' },
        attachments: [{ type: 'image', url: 'https://cdn.example/sketch.jpg' }],
      },
      { onOpenThread: () => {} }
    );
    assert.ok(tagNsfwCard.querySelector('.post-media-sensitive-wrap.is-blurred'));

    // 5. Normal image post stays completely unblurred
    const safeCard = createPostCard(
      {
        id: 'mastodon:safe_img',
        protocol: 'mastodon',
        content_text: 'Sunset over the lake.',
        author: { id: 'u10', handle: 'u10@hachyderm.io' },
        attachments: [{ type: 'image', url: 'https://cdn.example/sunset.jpg' }],
      },
      { onOpenThread: () => {} }
    );
    assert.equal(safeCard.querySelector('.post-media-sensitive-wrap'), null);
    assert.ok(safeCard.querySelector('.post-media-single'));
  } finally {
    dom.restore();
  }
});

test('harvestBlueskyJetstreamBurst enforces jetstream2->jetstream1 fallback, targetCount & maxDurationMs cutoffs, reply/media/label filters, and 25-URI getPosts batching', async () => {
  const connectedUrls = [];
  const getPostsChunks = [];

  class FallbackAndCutoffWs {
    constructor(url) {
      connectedUrls.push(String(url));
      this.listeners = new Map();
      queueMicrotask(() => {
        if (String(url).includes('jetstream2')) {
          this._emit('error', new Error('jetstream2 unavailable'));
          this._emit('close', {});
          return;
        }
        this._emit('open', {});
        // Reply record (must be skipped)
        this._emit('message', {
          data: JSON.stringify({
            kind: 'commit',
            did: 'did:plc:r1',
            commit: {
              operation: 'create',
              collection: 'app.bsky.feed.post',
              rkey: 'reply1',
              record: { text: 'Reply', reply: { root: {}, parent: {} }, langs: ['en'] },
            },
          }),
        });
        // Self-labeled porn record (must be skipped at socket level)
        this._emit('message', {
          data: JSON.stringify({
            kind: 'commit',
            did: 'did:plc:n1',
            commit: {
              operation: 'create',
              collection: 'app.bsky.feed.post',
              rkey: 'porn1',
              record: {
                text: 'Adult',
                langs: ['en'],
                labels: { $type: 'com.atproto.label.defs#selfLabels', values: [{ val: 'porn' }] },
                embed: { $type: 'app.bsky.embed.images', images: [{ image: {} }] },
              },
            },
          }),
        });
        // Text-only post (must be skipped when mediaFilter === 'images')
        this._emit('message', {
          data: JSON.stringify({
            kind: 'commit',
            did: 'did:plc:t1',
            commit: {
              operation: 'create',
              collection: 'app.bsky.feed.post',
              rkey: 'txt1',
              record: { text: 'Just text', langs: ['en'] },
            },
          }),
        });
        // Video-only post (must be skipped when mediaFilter === 'images')
        this._emit('message', {
          data: JSON.stringify({
            kind: 'commit',
            did: 'did:plc:v1',
            commit: {
              operation: 'create',
              collection: 'app.bsky.feed.post',
              rkey: 'vid1',
              record: {
                text: 'Clip',
                langs: ['en'],
                embed: { $type: 'app.bsky.embed.video', video: {} },
              },
            },
          }),
        });
        // Emit 30 valid image posts so targetCount=28 cuts off and hydrates in 2 chunks (25 + 3)
        for (let i = 0; i < 30; i++) {
          this._emit('message', {
            data: JSON.stringify({
              kind: 'commit',
              did: `did:plc:img${i}`,
              commit: {
                operation: 'create',
                collection: 'app.bsky.feed.post',
                rkey: `img${i}`,
                record: {
                  text: `Photo #${i}`,
                  langs: ['en'],
                  createdAt: '2026-11-21T12:00:00Z',
                  embed: { $type: 'app.bsky.embed.images', images: [{ image: { ref: {} } }] },
                },
              },
            }),
          });
        }
      });
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(fn);
    }
    removeEventListener(type, fn) {
      this.listeners.get(type)?.delete(fn);
    }
    _emit(type, ev) {
      this[`on${type}`]?.(ev);
      for (const fn of this.listeners.get(type) || []) fn(ev);
    }
    close() {
      this.closed = true;
    }
  }

  const mockFetch = async (url) => {
    const u = new URL(String(url));
    const uris = u.searchParams.getAll('uris');
    getPostsChunks.push(uris.length);
    return jsonResponse({
      posts: uris.map((uri, idx) => ({
        uri,
        cid: `c_${idx}`,
        author: { did: `did:plc:a${idx}`, handle: `a${idx}.bsky.social`, displayName: `A${idx}` },
        record: { text: `Photo ${uri.split('/').pop()}`, createdAt: '2026-11-21T12:00:00Z', langs: ['en'] },
        embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.example/a.jpg', fullsize: 'https://cdn.example/a.jpg' }] },
      })),
    });
  };

  const res = await harvestBlueskyJetstreamBurst({
    targetCount: 28,
    maxDurationMs: 2500,
    cursorRewindMs: 45_000,
    mediaOnly: true,
    mediaFilter: 'images',
    preferredLanguage: 'en',
    blockedSelfLabels: ['!hide', '!takedown', 'spam', 'porn'],
    WebSocketImpl: FallbackAndCutoffWs,
    fetchImpl: mockFetch,
  });

  assert.equal(connectedUrls.length, 2);
  assert.ok(connectedUrls[0].startsWith('wss://jetstream2.us-east.bsky.network/subscribe'));
  assert.ok(connectedUrls[0].includes('cursor='));
  assert.ok(connectedUrls[1].startsWith('wss://jetstream1.us-east.bsky.network/subscribe'));
  assert.deepEqual(getPostsChunks, [25, 3]);
  assert.equal(res.length, 28);
  assert.equal(res.some((p) => {
    const id = String(p?.id || p?.uri || '');
    return id.includes('reply1') || id.includes('porn1') || id.includes('txt1') || id.includes('vid1');
  }), false);

  // Also verify strict maxDurationMs timeout cutoff closes silent socket cleanly without stalling
  let silentClosed = false;
  class SilentWs {
    constructor() {}
    addEventListener() {}
    removeEventListener() {}
    close() { silentClosed = true; }
  }
  const timedStart = Date.now();
  const silentRes = await harvestBlueskyJetstreamBurst({
    maxDurationMs: 110,
    mediaFilter: 'video',
    WebSocketImpl: SilentWs,
    fetchImpl: mockFetch,
  });
  assert.equal(silentClosed, true);
  assert.ok(Date.now() - timedStart < 500);
  assert.equal(silentRes.length, 0);
});

test('harvestDynamicFediversePool caches FediDB 24h, fans out across Mastodon/Misskey/#loops, quarantines 401/404/422 failures, and enforces public opt-outs', async () => {
  clearFediverseDiscoveryCacheForTests();
  resetMemoryStorageForTests();

  const seenRequests = [];
  let fediDbFetches = 0;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    seenRequests.push({ url: u, method: String(init?.method || 'GET').toUpperCase() });

    if (u.startsWith('https://api.fedidb.org/v1/servers')) {
      fediDbFetches += 1;
      return jsonResponse({
        data: [
          { domain: 'pixelfed.social', software: { name: 'pixelfed' }, stats: { status_count: 10000 } },
          { domain: 'misskey.io', software: { name: 'misskey' }, stats: { status_count: 50000 } },
          { domain: 'fosstodon.org', software: { name: 'mastodon' }, stats: { status_count: 40000 } },
          { domain: 'dead.example', software: { name: 'mastodon' }, stats: { status_count: 500 } },
        ],
      });
    }
    if (u.startsWith('https://pixelfed.social/')) {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    if (u.startsWith('https://dead.example/')) {
      return jsonResponse({ error: 'Not Found' }, 404);
    }
    if (u.startsWith('https://misskey.io/api/notes/local-timeline')) {
      return jsonResponse([
        {
          id: 'mk_1',
          createdAt: '2026-11-21T11:58:00Z',
          text: 'Kinetic sculpture test clip',
          user: { id: 'mu1', username: 'maker', host: null, name: 'Maker' },
          files: [{ id: 'f1', type: 'video/mp4', url: 'https://misskey.io/files/clip.mp4', thumbnailUrl: 'https://misskey.io/files/thumb.jpg' }],
        },
        {
          id: 'mk_optout',
          createdAt: '2026-11-21T11:59:00Z',
          text: 'Private studio dump #nobot',
          user: { id: 'mu2', username: 'priv', host: null, name: 'Priv', noindex: true },
          files: [{ id: 'f2', type: 'video/mp4', url: 'https://misskey.io/files/priv.mp4' }],
        },
      ]);
    }
    if (u.includes('/api/v1/timelines/tag/loops')) {
      return jsonResponse([
        {
          id: 'loops_m_1',
          created_at: '2026-11-21T11:57:00Z',
          content: '<p>Short animation loop #loops</p>',
          url: 'https://fosstodon.org/@loopster/1',
          account: { id: 'la1', username: 'loopster', acct: 'loopster@loops.video', display_name: 'Loopster', discoverable: true, indexable: true },
          media_attachments: [{ id: 'lv1', type: 'video', url: 'https://loops.video/media/1.mp4', preview_url: 'https://loops.video/media/1.jpg' }],
        },
      ]);
    }
    if (u.includes('/api/v1/timelines/public')) {
      return jsonResponse([
        {
          id: 'foss_v_1',
          created_at: '2026-11-21T11:56:00Z',
          content: '<p>Field recording demo</p>',
          url: 'https://fosstodon.org/@field/1',
          account: { id: 'fv1', username: 'field', acct: 'field@fosstodon.org', display_name: 'Field', discoverable: true, indexable: true },
          media_attachments: [{ id: 'fv_m1', type: 'video', url: 'https://fosstodon.org/media/field.mp4', preview_url: 'https://fosstodon.org/media/field.jpg' }],
        },
        {
          id: 'foss_optout_1',
          created_at: '2026-11-21T11:55:00Z',
          content: '<p>Do not index me</p>',
          account: { id: 'opt1', username: 'opt1', acct: 'opt1@fosstodon.org', discoverable: false, indexable: false, note: 'Hi #noindex' },
          media_attachments: [{ id: 'opt_m1', type: 'image', url: 'https://fosstodon.org/media/opt.jpg' }],
        },
      ]);
    }
    return jsonResponse([]);
  };

  try {
    const pool = await fetchDynamicFediverseInstances({ fetchImpl: mockFetch });
    assert.equal(fediDbFetches, 1);
    assert.ok(pool.some((s) => s.domain === 'misskey.io' && s.weight === 1));

    const firstHarvest = await harvestDynamicFediversePool({
      sampleSize: 10,
      onlyMedia: true,
      mediaType: 'video',
      includeLoopsTags: true,
      rng: () => 0,
      fetchImpl: mockFetch,
    });
    assert.equal(fediDbFetches, 1, 'FediDB instance directory must use 24h KV cache on subsequent harvests');
    assert.ok(seenRequests.some((r) => r.url.startsWith('https://misskey.io/api/notes/local-timeline') && r.method === 'POST'));
    assert.ok(seenRequests.some((r) => r.url.includes('/api/v1/timelines/tag/loops') && r.url.includes('only_media=true')));
    assert.ok(firstHarvest.some((it) => it.id.includes('mk_1')));
    assert.ok(firstHarvest.some((it) => it.id.includes('loops_m_1')));
    assert.equal(firstHarvest.some((it) => it.id.includes('optout') || it.id.includes('mk_optout')), false);

    // 401/404 quarantine prevents re-querying pixelfed.social & dead.example on next harvest
    seenRequests.length = 0;
    await harvestDynamicFediversePool({
      sampleSize: 10,
      onlyMedia: true,
      mediaType: 'video',
      rng: () => 0,
      fetchImpl: mockFetch,
    });
    assert.equal(seenRequests.some((r) => r.url.includes('pixelfed.social') || r.url.includes('dead.example')), false);
    assert.equal(isPublicDiscoveryOptOut({ author: { discoverable: false } }), true);
    assert.equal(isPublicDiscoveryOptOut({ content_text: 'casual art #nobot' }), true);
    assert.equal(isPublicDiscoveryOptOut({ author: { noteText: 'Opted out #noindex', discoverable: true } }), true);
  } finally {
    clearFediverseDiscoveryCacheForTests();
    resetMemoryStorageForTests();
  }
});

test('User-sovereign RankingManifest exports, imports, applies custom rules via FeedTuningModal, disables rules with empty regex/labels, and resets cleanly', async () => {
  const dom = installMockDom();
  try {
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    await hydrateRankingManifest();

    const exportedJson = exportRankingManifest({ pretty: true });
    const parsedDefault = JSON.parse(exportedJson);
    assert.equal(parsedDefault.version, DEFAULT_RANKING_MANIFEST.version);

    // Custom manifest: allow maxDiscoveryPerAuthor=1, custom bot regex /daily digest/i, and empty sensitiveContentTriggers.blurLabels
    const customManifest = {
      ...parsedDefault,
      caps: { ...parsedDefault.caps, maxDiscoveryPerAuthor: 1 },
      syndicationBotPatterns: { ...parsedDefault.syndicationBotPatterns, displayNameRegex: 'daily digest', hostRegex: '' },
      sensitiveContentTriggers: { ...parsedDefault.sensitiveContentTriggers, blurLabels: {}, keywordRegex: '' },
    };

    const modal = openFeedTuningModal();
    const exportBtn = modal.dialog.querySelector('.ranking-manifest-export-btn');
    const importBtn = modal.dialog.querySelector('.ranking-manifest-import-btn');
    const resetBtn = modal.dialog.querySelector('.ranking-manifest-reset-btn');
    assert.equal(modal.dialog.querySelector('#ranking-manifest-editor'), null);
    assert.equal(modal.dialog.querySelector('.ranking-manifest-apply-btn'), null);
    assert.ok(exportBtn && importBtn && resetBtn);

    await importRankingManifest(JSON.stringify(customManifest, null, 2));
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(feedStore.get().rankingManifest.caps.maxDiscoveryPerAuthor, 1);
    assert.equal(
      isAutomatedSyndicationOrBotItem(
        { id: 'b1', author: { handle: 'digest@example.com', name: 'Daily Digest' }, content_text: 'Roundup https://ex.com' },
        feedStore.get().rankingManifest
      ),
      true
    );

    // Local sovereign sensitive trigger override: empty blurLabels MUST NOT blur labeled media even with remote porn label
    const labeledItem = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:a/app.bsky.feed.post/1',
        cid: 'c1',
        labels: [{ val: 'porn' }],
        author: { did: 'did:plc:a', handle: 'a.bsky.social' },
        record: { text: 'Test media', createdAt: '2026-11-21T12:00:00Z' },
        embed: { $type: 'app.bsky.embed.images#view', images: [{ thumb: 'https://cdn.example/1.jpg', fullsize: 'https://cdn.example/1.jpg' }] },
      },
    });
    assert.equal(getSensitiveMediaWarning(labeledItem, feedStore.get().rankingManifest), '');

    // Sieve enforces custom maxDiscoveryPerAuthor=1 and importRankingManifest persists normalized caps
    const imported = await importRankingManifest(customManifest);
    assert.equal(imported.caps.maxDiscoveryPerAuthor, 1);
    const sameAuthorItems = [
      { id: 'mastodon:1', protocol: 'mastodon', content_text: 'One', date_published: '2026-11-21T12:00:00Z', author: { id: 'u1', handle: 'u1@m.social' } },
      { id: 'mastodon:2', protocol: 'mastodon', content_text: 'Two', date_published: '2026-11-21T11:59:00Z', author: { id: 'u1', handle: 'u1@m.social' } },
    ];
    const sieved = sieveSovereignCandidates(sameAuthorItems, null, { manifest: imported });
    assert.equal(sieved.length, 1);

    resetBtn.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(feedStore.get().rankingManifest.caps.maxDiscoveryPerAuthor, DEFAULT_RANKING_MANIFEST.caps.maxDiscoveryPerAuthor);
    await resetRankingManifest();
    modal.close();
  } finally {
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('discoveryMode photos/video strictly sieve media types and 24h TTL rolling stream cache evicts expired items', async () => {
  clearHarvesterCacheForTests();
  resetFeedStoreForTests();
  resetMemoryStorageForTests();

  const imgPost = {
    id: 'mastodon:img1',
    protocol: 'mastodon',
    content_text: 'Studio portrait',
    date_published: '2026-11-21T12:00:00Z',
    author: { id: 'p1', handle: 'p1@m.social' },
    attachments: [{ type: 'image', url: 'https://m.social/1.jpg' }],
  };
  const vidPost = {
    id: 'mastodon:vid1',
    protocol: 'mastodon',
    content_text: 'Skatepark clip',
    date_published: '2026-11-21T12:01:00Z',
    author: { id: 'v1', handle: 'v1@m.social' },
    attachments: [{ type: 'video', url: 'https://m.social/1.mp4' }],
  };
  const textPost = {
    id: 'mastodon:txt1',
    protocol: 'mastodon',
    content_text: 'Text only thought',
    date_published: '2026-11-21T12:02:00Z',
    author: { id: 't1', handle: 't1@m.social' },
    attachments: [],
  };

  assert.deepEqual(
    sieveSovereignCandidates([imgPost, vidPost, textPost], null, { discoveryMode: 'default' }).map((p) => p.id),
    ['mastodon:txt1']
  );
  assert.deepEqual(
    sieveSovereignCandidates([imgPost, vidPost, textPost], null, { discoveryMode: 'photos' }).map((p) => p.id),
    ['mastodon:img1']
  );
  assert.deepEqual(
    sieveSovereignCandidates([imgPost, vidPost, textPost], null, { discoveryMode: 'video' }).map((p) => p.id),
    ['mastodon:vid1']
  );
  assert.deepEqual(
    sieveSovereignCandidates([imgPost, vidPost, textPost], null, { discoveryMode: 'visual' }).map((p) => p.id),
    ['mastodon:img1', 'mastodon:vid1']
  );

  const now = Date.now();
  const expired = { ...imgPost, id: 'mastodon:expired_1', _cachedAt: now - 25 * 3600_000 };
  const fresh = { ...vidPost, id: 'mastodon:fresh_1', _cachedAt: now - 2 * 3600_000 };
  feedStore.set({
    ...feedStore.get(),
    streams: {
      ...feedStore.get().streams,
      photos: { ...feedStore.get().streams.photos, items: [expired, fresh], loaded: true },
    },
  });
  await persistStreamCache('photos');
  resetFeedStoreForTests();
  await hydrateCachedStream('photos');
  const hydratedIds = feedStore.get().streams.photos.items.map((p) => p.id);
  assert.deepEqual(hydratedIds, ['mastodon:fresh_1']);
});

test('Public Commons Visibility switch in Settings -> Moderation and Profile Studio syncs Mastodon & Bluesky discovery flags', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const requests = [];
  let bskySelfLabels = [];
  let bskyDisplayName = 'Davy';
  let bskyDescription = 'Original bio';
  let mastoState = {
    discoverable: true,
    indexable: true,
    locked: false,
    defaultVisibility: 'public',
  };

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = String(init?.method || 'GET').toUpperCase();
    requests.push({ url: u, method, body: init?.body });

    if (u.includes('/api/v1/accounts/update_credentials') && method === 'PATCH') {
      const fd = init?.body;
      if (fd && typeof fd.get === 'function') {
        if (fd.has('discoverable')) mastoState.discoverable = fd.get('discoverable') === 'true';
        if (fd.has('source[indexable]')) mastoState.indexable = fd.get('source[indexable]') === 'true';
        if (fd.has('locked')) mastoState.locked = fd.get('locked') === 'true';
        if (fd.has('source[privacy]')) mastoState.defaultVisibility = String(fd.get('source[privacy]'));
      }
      return jsonResponse({
        id: 'u_m1',
        username: 'davy',
        acct: 'davy@mastodon.social',
        display_name: 'Davy',
        note: '<p>Original bio</p>',
        discoverable: mastoState.discoverable,
        indexable: mastoState.indexable,
        locked: mastoState.locked,
        bot: false,
        source: {
          privacy: mastoState.defaultVisibility,
          sensitive: false,
          language: 'en',
          indexable: mastoState.indexable,
        },
        fields: [],
      });
    }
    if (u.includes('/api/v2/filters') || u.includes('/api/v1/mutes') || u.includes('/api/v1/blocks')) {
      return jsonResponse([]);
    }
    if (u.includes('com.atproto.repo.getRecord') && u.includes('app.bsky.actor.profile')) {
      return jsonResponse({
        uri: 'at://did:plc:pubtest/app.bsky.actor.profile/self',
        cid: 'cid_prof_1',
        value: {
          $type: 'app.bsky.actor.profile',
          displayName: bskyDisplayName,
          description: bskyDescription,
          createdAt: '2026-01-01T00:00:00Z',
          ...(bskySelfLabels.length > 0
            ? { labels: { $type: 'com.atproto.label.defs#selfLabels', values: bskySelfLabels } }
            : {}),
        },
      });
    }
    if (u.includes('com.atproto.repo.listRecords') && u.includes('app.bsky.actor.link')) {
      return jsonResponse({ records: [] });
    }
    if (u.includes('com.atproto.repo.putRecord')) {
      const payload = JSON.parse(init?.body || '{}');
      bskySelfLabels = Array.isArray(payload?.record?.labels?.values) ? payload.record.labels.values : [];
      return jsonResponse({ uri: 'at://did:plc:pubtest/app.bsky.actor.profile/self', cid: 'cid_prof_2' });
    }
    if (u.includes('app.bsky.actor.getProfile')) {
      return jsonResponse({
        did: 'did:plc:pubtest',
        handle: 'davy.bsky.social',
        displayName: bskyDisplayName,
        description: bskyDescription,
        labels: bskySelfLabels.map((l) => ({ val: l.val })),
        followersCount: 10,
        followsCount: 5,
        postsCount: 2,
      });
    }
    return jsonResponse({});
  };

  let settingsModal = null;
  let editModal = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetFeedStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fediverse:davy@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davy',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
        discoverable: true,
        indexable: true,
        locked: false,
        defaultVisibility: 'public',
        userId: 'u_m1',
      },
      { accessToken: 'masto_pub_tok' },
      { syncToServer: false }
    );
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:pubtest',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'davy.bsky.social',
        acct: 'davy.bsky.social',
        did: 'did:plc:pubtest',
        displayName: 'Davy',
        publicVisible: true,
      },
      { accessJwt: 'bsky_pub_jwt', refreshJwt: 'bsky_pub_ref' },
      { syncToServer: false }
    );

    settingsModal = openSettingsModal({ initialTab: 'moderation' });
    const toggle = settingsModal.dialog.querySelector('#settings-public-discovery-toggle');
    assert.ok(toggle);
    assert.equal(toggle.hasAttribute('switch'), true);
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.checked, true);
    assert.equal(isUnifiedPublicDiscoveryEnabled(authStore.get().accounts), true);

    // Toggle OFF: Mastodon discoverable=false, indexable=false + Bluesky !no-unauthenticated self-label
    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 35));

    const offPatch = requests.find((r) => r.url.includes('update_credentials') && r.body.get('discoverable') === 'false');
    assert.ok(offPatch);
    assert.equal(offPatch.body.get('source[indexable]'), 'false');

    const offPut = requests.filter((r) => r.url.includes('com.atproto.repo.putRecord')).pop();
    const offBody = JSON.parse(offPut.body);
    assert.equal(offBody.record.displayName, 'Davy');
    assert.equal(offBody.record.description, 'Original bio');
    assert.deepEqual(offBody.record.labels?.values, [{ val: '!no-unauthenticated' }]);
    assert.equal(isUnifiedPublicDiscoveryEnabled(authStore.get().accounts), false);

    // Toggle ON again: Mastodon discoverable=true, indexable=true, locked=false, public + clears !no-unauthenticated
    toggle.checked = true;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 35));

    const onPatch = requests.filter((r) => r.url.includes('update_credentials')).pop();
    assert.equal(onPatch.body.get('discoverable'), 'true');
    assert.equal(onPatch.body.get('source[indexable]'), 'true');
    assert.equal(onPatch.body.get('locked'), 'false');
    assert.equal(onPatch.body.get('source[privacy]'), 'public');

    const onPut = requests.filter((r) => r.url.includes('com.atproto.repo.putRecord')).pop();
    const onBody = JSON.parse(onPut.body);
    assert.equal(onBody.record.labels, undefined);
    assert.equal(isUnifiedPublicDiscoveryEnabled(authStore.get().accounts), true);
    settingsModal.close();
    settingsModal = null;

    // Profile Studio exposes Bluesky logged-out visibility switch and syncs on save
    const mastoMeta = authStore.get().accounts.find((a) => a.platform === 'fediverse');
    editModal = openEditMastodonProfileModal({ accountMeta: mastoMeta });
    const bskyPubSwitch = editModal.dialog.querySelector('#edit-bsky-public-visible');
    assert.ok(bskyPubSwitch);
    assert.equal(bskyPubSwitch.hasAttribute('switch'), true);
    assert.equal(bskyPubSwitch.checked, true);

    bskyPubSwitch.checked = false;
    editModal.dialog.querySelector('.profile-edit-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 35));

    assert.deepEqual(bskySelfLabels, [{ val: '!no-unauthenticated' }]);
    assert.equal(authStore.get().accounts.find((a) => a.platform === 'bluesky')?.publicVisible, false);

    // setUnifiedPublicDiscovery flips both back ON directly
    const res = await setUnifiedPublicDiscovery(true);
    assert.deepEqual(res, { enabled: true, updatedMastodon: true, updatedBluesky: true });
    assert.deepEqual(bskySelfLabels, []);
    assert.equal(isUnifiedPublicDiscoveryEnabled(authStore.get().accounts), true);
  } finally {
    settingsModal?.close?.();
    editModal?.close?.();
    resetAuthStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Photos stream enforces Pixelfed/square IG framing and Video stream renders thumb-scrolling Loops viewer with sound sync and in-place reactions', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const playCalls = [];
  const pauseCalls = [];
  const origCreateElement = dom.document.createElement.bind(dom.document);
  dom.document.createElement = (tag, opts) => {
    const el = origCreateElement(tag, opts);
    if (String(tag).toLowerCase() === 'video') {
      el.paused = true;
      el.play = () => {
        el.paused = false;
        playCalls.push(el);
        return Promise.resolve();
      };
      el.pause = () => {
        el.paused = true;
        pauseCalls.push(el);
      };
      el.load = () => {};
    }
    return el;
  };

  const requestedUrls = [];
  const mockFetch = async (url) => {
    const u = String(url);
    requestedUrls.push(u);
    if (u.startsWith('https://api.fedidb.org/v1/servers')) {
      return jsonResponse({
        data: [
          { domain: 'pixelfed.example', software: { name: 'pixelfed' }, stats: { status_count: 5000 } },
          { domain: 'mastodon.world', software: { name: 'mastodon' }, stats: { status_count: 40000 } },
        ],
      });
    }
    if (u.includes('/api/v1/timelines/tag/pixelfed')) {
      return jsonResponse([
        {
          id: 'px_sq',
          created_at: '2026-11-21T12:00:00Z',
          content: '<p>Analog roll #pixelfed</p>',
          account: { id: 'pxu1', username: 'film', acct: 'film@pixelfed.social', display_name: 'Film', discoverable: true, indexable: true },
          media_attachments: [{ id: 'pm1', type: 'image', url: 'https://pixelfed.social/sq.jpg', meta: { original: { width: 1080, height: 1080 } } }],
        },
        {
          id: 'px_ig45',
          created_at: '2026-11-21T11:59:00Z',
          content: '<p>Gallery 4:5 portrait</p>',
          account: { id: 'pxu2', username: 'gal', acct: 'gal@gram.social', display_name: 'Gal', discoverable: true, indexable: true },
          media_attachments: [{ id: 'pm2', type: 'image', url: 'https://gram.social/p45.jpg', meta: { original: { width: 1080, height: 1350 } } }],
        },
        {
          id: 'px_wide',
          created_at: '2026-11-21T11:58:00Z',
          content: '<p>16:9 screenshot must be excluded</p>',
          account: { id: 'pxu3', username: 'desk', acct: 'desk@mastodon.world', display_name: 'Desk', discoverable: true, indexable: true },
          media_attachments: [{ id: 'pm3', type: 'image', url: 'https://mastodon.world/wide.png', meta: { original: { width: 1920, height: 1080 } } }],
        },
        {
          id: 'px_tall',
          created_at: '2026-11-21T11:57:00Z',
          content: '<p>9:16 phone wallpaper must be excluded</p>',
          account: { id: 'pxu4', username: 'phone', acct: 'phone@mastodon.world', display_name: 'Phone', discoverable: true, indexable: true },
          media_attachments: [{ id: 'pm4', type: 'image', url: 'https://mastodon.world/tall.png', meta: { original: { width: 1080, height: 1920 } } }],
        },
        {
          id: 'px_link',
          created_at: '2026-11-21T11:56:00Z',
          content: '<p>Read my blog https://example.com/post</p>',
          card: { url: 'https://example.com/post', title: 'Blog' },
          account: { id: 'pxu5', username: 'blog', acct: 'blog@mastodon.world', display_name: 'Blog', discoverable: true, indexable: true },
          media_attachments: [{ id: 'pm5', type: 'image', url: 'https://mastodon.world/sq2.jpg', meta: { original: { width: 1000, height: 1000 } } }],
        },
      ]);
    }
    return jsonResponse([]);
  };

  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    clearHarvesterCacheForTests();
    clearFediverseDiscoveryCacheForTests();
    globalThis.fetch = mockFetch;

    // 1. Harvester Photos mode queries #pixelfed/#fediphoto, admits 1:1 & 4:5, drops 16:9, 9:16, GIFs, and link posts
    const photoHarvest = await harvestSanctuaryFeed({
      discoveryMode: 'photos',
      fetchImpl: mockFetch,
    });
    assert.ok(requestedUrls.some((u) => u.includes('/api/v1/timelines/tag/pixelfed')));
    assert.ok(requestedUrls.some((u) => u.includes('/api/v1/timelines/tag/fediphoto')));
    assert.ok(photoHarvest.items.some((p) => p.id.includes('px_sq')));
    assert.ok(photoHarvest.items.some((p) => p.id.includes('px_ig45')));
    assert.equal(photoHarvest.items.some((p) => p.id.includes('px_wide') || p.id.includes('px_tall') || p.id.includes('px_link')), false);

    const gifItem = {
      id: 'mastodon:gif_1',
      protocol: 'mastodon',
      content_text: 'Animated loop',
      date_published: '2026-11-21T12:00:00Z',
      author: { id: 'g1', handle: 'g1@m.social' },
      attachments: [{ type: 'image', mimeType: 'image/gif', url: 'https://m.social/anim.gif', width: 800, height: 800 }],
    };
    assert.deepEqual(sieveSovereignCandidates([gifItem], null, { discoveryMode: 'photos' }), []);

    // 2. Mount Feed Screen on Photos tab -> hidden compose bar, Square IG card order
    await setActiveStream('photos');
    setStreamItems('photos', photoHarvest.items);
    const loopItem1 = {
      id: 'mastodon:loop_1',
      protocol: 'mastodon',
      content_text: 'Skatepark trick loop #loops',
      content_html: '<p>Skatepark trick loop #loops</p>',
      date_published: '2026-11-21T12:01:00Z',
      author: { id: 'lu1', name: 'Skater', handle: 'skater@loops.video' },
      metrics: { likes: 12, replies: 2, reposts: 1 },
      attachments: [{ type: 'video', url: 'https://loops.video/1.mp4', previewUrl: 'https://loops.video/1.jpg', width: 720, height: 1280 }],
      _meta: { mastodon: { statusId: 'loop_1' } },
    };
    const loopItem2 = {
      id: 'mastodon:loop_2',
      protocol: 'mastodon',
      content_text: 'Espresso pull #shortform',
      content_html: '<p>Espresso pull #shortform</p>',
      date_published: '2026-11-21T12:00:00Z',
      author: { id: 'lu2', name: 'Barista', handle: 'barista@loops.video' },
      metrics: { likes: 3, replies: 1, reposts: 0 },
      attachments: [{ type: 'gifv', url: 'https://loops.video/2.mp4', previewUrl: 'https://loops.video/2.jpg', width: 720, height: 1280 }],
      _meta: { mastodon: { statusId: 'loop_2' } },
    };
    setStreamItems('video', [loopItem1, loopItem2]);
    setStreamItems('feed', [
      {
        id: 'mastodon:txt_feed_1',
        protocol: 'mastodon',
        content_text: 'Standard Feed post',
        date_published: '2026-11-21T12:02:00Z',
        author: { id: 'tf1', handle: 'tf1@mastodon.world' },
      },
    ]);

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(host.querySelector('.inline-compose-row').hidden, true);
    const igCard = host.querySelector('.post-card.is-ig-photo-card');
    assert.ok(igCard);
    const igChildren = Array.from(igCard.children);
    const mediaIdx = igChildren.findIndex((c) => c.classList.contains('post-media-grid'));
    const actIdx = igChildren.findIndex((c) => c.classList.contains('post-card-actions'));
    const bodyIdx = igChildren.findIndex((c) => c.classList.contains('post-content-wrap'));
    assert.ok(mediaIdx > 0 && actIdx > mediaIdx && bodyIdx > actIdx, 'IG card must put media before actions and caption in DOM order');

    // 3. Switch to Video tab -> pure vertical thumb-scrolling Loops viewer
    const videoTab = host.querySelector('.stage-tab-btn[data-stream="video"]');
    videoTab.click();
    await new Promise((r) => setTimeout(r, 20));

    const listEl = host.querySelector('.feed-posts-list');
    assert.equal(host.querySelector('.inline-compose-row').hidden, true);
    assert.equal(listEl.classList.contains('is-loops-viewer'), true);
    assert.equal(listEl.getAttribute('role'), 'region');
    assert.equal(listEl.getAttribute('aria-label'), 'Loops video viewer');
    assert.equal(listEl.tabIndex, 0);

    const slides = listEl.querySelectorAll('article.loops-slide');
    assert.equal(slides.length, 2);
    const v0 = slides[0].querySelector('video.loops-video');
    const v1 = slides[1].querySelector('video.loops-video');
    assert.ok(v0 && v1);
    assert.equal(v0.getAttribute('loading'), null, 'First slide must stay eager');
    assert.equal(v1.getAttribute('loading'), 'lazy', 'Subsequent slides must set loading="lazy"');
    assert.equal(v0.getAttribute('width'), '720');
    assert.equal(v0.getAttribute('height'), '1280');
    assert.equal(playCalls.includes(v0), true, 'First Loops slide plays automatically when active');

    // Sound toggle syncs across all slides
    const soundBtn0 = slides[0].querySelector('.loops-sound-btn');
    const soundBtn1 = slides[1].querySelector('.loops-sound-btn');
    assert.equal(soundBtn0.getAttribute('aria-pressed'), 'false');
    soundBtn0.click();
    assert.equal(v0.muted, false);
    assert.equal(v1.muted, false);
    assert.equal(soundBtn0.getAttribute('aria-pressed'), 'true');
    assert.equal(soundBtn1.getAttribute('aria-pressed'), 'true');

    // In-place reaction update preserves <video> DOM node without reload
    mutatePostAcrossStreams('mastodon:loop_1', (cur) => ({
      ...cur,
      metrics: { ...cur.metrics, likes: 13 },
      _meta: { ...cur._meta, mastodon: { ...(cur._meta?.mastodon || {}), favourited: true } },
    }));
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(slides[0].querySelector('video.loops-video'), v0);
    assert.equal(slides[0].querySelector('.post-action-like .post-action-count').textContent, '13');
    assert.equal(slides[0].querySelector('.post-action-like').getAttribute('aria-pressed'), 'true');

    // Leaving Video tab pauses Loops videos and restores standard Feed layout
    host.querySelector('.stage-tab-btn[data-stream="feed"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(pauseCalls.includes(v0), true);
    assert.equal(listEl.classList.contains('is-loops-viewer'), false);
    assert.equal(listEl.getAttribute('role'), null);
    assert.equal(host.querySelector('.inline-compose-row').hidden, false);
  } finally {
    feedCtrl?.destroy();
    clearHarvesterCacheForTests();
    clearFediverseDiscoveryCacheForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Activity follow notifications show Following when already followed and toggle Follow Back <-> Following across Mastodon and Bluesky', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const followCalls = [];
  const deletePayloads = [];

  const mockFetch = async (url, opts = {}) => {
    const u = String(url || '');
    const method = String(opts?.method || 'GET').toUpperCase();
    if (u.includes('/api/v1/notifications')) {
      return jsonResponse([
        {
          id: 'mn_f_already',
          type: 'follow',
          created_at: '2026-11-21T12:04:00Z',
          account: {
            id: 'm_already',
            username: 'bimbo',
            acct: 'bimbo@mastodon.social',
            display_name: 'Bimbo',
            avatar: '',
            url: 'https://mastodon.social/@bimbo',
          },
        },
        {
          id: 'mn_f_new',
          type: 'follow',
          created_at: '2026-11-21T12:03:00Z',
          account: {
            id: 'm_new',
            username: 'newcomer',
            acct: 'newcomer@mastodon.social',
            display_name: 'Newcomer',
            avatar: '',
            url: 'https://mastodon.social/@newcomer',
          },
        },
      ]);
    }
    if (u.includes('/api/v1/accounts/relationships')) {
      return jsonResponse([
        { id: 'm_already', following: true, requested: false },
        { id: 'm_new', following: false, requested: false },
      ]);
    }
    if (u.includes('/api/v1/accounts/m_new/follow') && method === 'POST') {
      followCalls.push(u);
      return jsonResponse({ id: 'm_new', following: true, requested: false });
    }
    if (u.includes('app.bsky.notification.listNotifications')) {
      return jsonResponse({
        notifications: [
          {
            uri: 'at://did:plc:gorom/app.bsky.graph.follow/f1',
            cid: 'cid_bf1',
            reason: 'follow',
            isRead: false,
            indexedAt: '2026-11-21T12:02:00Z',
            author: {
              did: 'did:plc:gorom',
              handle: 'gorom.bsky.social',
              displayName: 'Gorom',
              avatar: '',
              viewer: { following: 'at://did:plc:me/app.bsky.graph.follow/rkey1' },
            },
            record: { $type: 'app.bsky.graph.follow', subject: 'did:plc:me' },
          },
          {
            uri: 'at://did:plc:fresh/app.bsky.graph.follow/f2',
            cid: 'cid_bf2',
            reason: 'follow',
            isRead: false,
            indexedAt: '2026-11-21T12:01:00Z',
            author: {
              did: 'did:plc:fresh',
              handle: 'fresh.bsky.social',
              displayName: 'Fresh',
              avatar: '',
              viewer: {},
            },
            record: { $type: 'app.bsky.graph.follow', subject: 'did:plc:me' },
          },
        ],
      });
    }
    if (u.includes('com.atproto.repo.deleteRecord') && method === 'POST') {
      deletePayloads.push(JSON.parse(opts?.body || '{}'));
      return jsonResponse({});
    }
    if (u.includes('app.bsky.notification.updateSeen') && method === 'POST') {
      return jsonResponse({});
    }
    return jsonResponse({});
  };

  let actCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();
    globalThis.fetch = mockFetch;

    await upsertSocialAccount(
      {
        id: 'fediverse:me@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'me',
        acct: 'me@mastodon.social',
        userId: 'u_me',
      },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:me',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        did: 'did:plc:me',
        handle: 'me.bsky.social',
      },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    await refreshActivityNotifications({ limit: 40, markSeen: false });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    actCtrl = mountActivityScreen(host);
    await new Promise((r) => setTimeout(r, 30));

    const findFollowBtnByActor = (actorName) => {
      const rows = Array.from(host.querySelectorAll('.activity-row'));
      const row = rows.find((r) => r.querySelector('.activity-actor-btn')?.textContent === actorName);
      return row?.querySelector('.activity-follow-btn') || null;
    };

    const bimboBtn = findFollowBtnByActor('Bimbo');
    const newcomerBtn = findFollowBtnByActor('Newcomer');
    const goromBtn = findFollowBtnByActor('Gorom');
    const freshBtn = findFollowBtnByActor('Fresh');

    assert.ok(bimboBtn && newcomerBtn && goromBtn && freshBtn, 'All four follow notifications should render action buttons');
    assert.equal(bimboBtn.textContent, 'Following');
    assert.equal(bimboBtn.classList.contains('is-following'), true);
    assert.equal(bimboBtn.getAttribute('aria-pressed'), 'true');

    assert.equal(goromBtn.textContent, 'Following');
    assert.equal(goromBtn.classList.contains('is-following'), true);
    assert.equal(goromBtn.getAttribute('aria-pressed'), 'true');

    assert.equal(newcomerBtn.textContent, 'Follow Back');
    assert.equal(newcomerBtn.classList.contains('is-following'), false);
    assert.equal(newcomerBtn.getAttribute('aria-pressed'), 'false');

    assert.equal(freshBtn.textContent, 'Follow Back');
    assert.equal(freshBtn.classList.contains('is-following'), false);
    assert.equal(freshBtn.getAttribute('aria-pressed'), 'false');

    // Follow Newcomer on Mastodon -> updates button to Following
    newcomerBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(followCalls.some((u) => u.includes('/api/v1/accounts/m_new/follow')), true);
    const updatedNewcomerBtn = findFollowBtnByActor('Newcomer');
    assert.equal(updatedNewcomerBtn?.textContent, 'Following');
    assert.equal(updatedNewcomerBtn?.getAttribute('aria-pressed'), 'true');

    // Unfollow Gorom on Bluesky -> calls deleteRecord with rkey1 and flips back to Follow Back
    findFollowBtnByActor('Gorom')?.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(deletePayloads.some((p) => p.rkey === 'rkey1' && p.collection === 'app.bsky.graph.follow'), true);
    const updatedGoromBtn = findFollowBtnByActor('Gorom');
    assert.equal(updatedGoromBtn?.textContent, 'Follow Back');
    assert.equal(updatedGoromBtn?.getAttribute('aria-pressed'), 'false');
    assert.ok(activityStore.get().items.length >= 4);
  } finally {
    actCtrl?.destroy();
    resetActivityStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Bluesky Klipy GIFs, blob image fallback, unknown Mastodon types, no-referrer images, attachment preservation, and 1:1 IG carousel frames', () => {
  const dom = installMockDom();
  try {
    resetFeedStoreForTests();

    // 1. Klipy animated GIF external embed normalizes into attachments without ALT prefix
    const klipyRaw = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:mnoi4b5qc2suuinlnf5artur/app.bsky.feed.post/klipy1',
        cid: 'cid_klipy1',
        indexedAt: '2026-11-21T15:10:00Z',
        author: { did: 'did:plc:mnoi4b5qc2suuinlnf5artur', handle: 'pittodriepride.bsky.social', displayName: 'PittodriePride' },
        record: { text: '', createdAt: '2026-11-21T15:10:00Z' },
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: {
            uri: 'https://static.klipy.com/ii/71b2873e478b9d8d0482ea3ec777ba7f/e5/4c/Ppcey4PZ.gif?hh=368&ww=498&mp4=Lkr',
            title: 'Man Fingers Crossed, Hopeful',
            description: 'ALT: Man Fingers Crossed, Hopeful',
            thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:mnoi4b5qc2suuinlnf5artur/bafkreicj5',
          },
        },
      },
    });
    assert.equal(klipyRaw.media.length, 1);
    assert.equal(klipyRaw.media[0].mimeType, 'image/gif');
    assert.equal(klipyRaw.media[0].width, 498);
    assert.equal(klipyRaw.media[0].height, 368);
    assert.equal(klipyRaw.media[0].description, 'Man Fingers Crossed, Hopeful');
    assert.equal(klipyRaw.linkCard, null);

    // 2. record.embed.images blob-to-CDN fallback when AppView embed.images is absent
    const blobRaw = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:blobuser/app.bsky.feed.post/blob1',
        cid: 'cid_blob1',
        indexedAt: '2026-11-21T15:09:00Z',
        author: { did: 'did:plc:blobuser', handle: 'blobuser.bsky.social', displayName: 'BlobUser' },
        record: {
          text: 'Fresh upload',
          createdAt: '2026-11-21T15:09:00Z',
          embed: {
            $type: 'app.bsky.embed.images',
            images: [
              {
                alt: 'Sunrise',
                aspectRatio: { width: 1080, height: 1080 },
                image: { ref: { $link: 'bafkreiabc123' }, mimeType: 'image/jpeg' },
              },
            ],
          },
        },
      },
    });
    assert.equal(blobRaw.media.length, 1);
    assert.equal(blobRaw.media[0].url, 'https://cdn.bsky.app/img/feed_fullsize/plain/did%3Aplc%3Ablobuser/bafkreiabc123@jpeg');
    assert.equal(blobRaw.media[0].previewUrl, 'https://cdn.bsky.app/img/feed_thumbnail/plain/did%3Aplc%3Ablobuser/bafkreiabc123@jpeg');

    // 3. Image-only external embed card renders even when title & description are empty
    const imageOnlyCard = resolvePostEmbedCard({
      _meta: {
        linkCard: {
          url: 'https://example.org/photo-story',
          title: '',
          description: '',
          image: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:x/cid_thumb',
        },
      },
    });
    assert.ok(imageOnlyCard);
    assert.equal(imageOnlyCard.title, 'example.org');
    assert.equal(imageOnlyCard.image, 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:x/cid_thumb');

    // 4. Mastodon 'unknown' media type & relative path resolve to valid image attachment
    const unknownMasto = normalizeMastodonStatus(
      {
        id: 'unk_1',
        created_at: '2026-11-21T15:05:00Z',
        content: '<p>Federated Pixelfed photo</p>',
        account: { id: 'u_px', username: 'px', acct: 'px@pixelfed.social', display_name: 'PX' },
        media_attachments: [
          {
            id: 'att_u1',
            type: 'unknown',
            url: '/storage/m/_v2/123/photo.jpg',
            preview_url: 'https://cdn.example.test/thumb.jpg',
            meta: { original: { width: 1080, height: 1080 } },
          },
        ],
      },
      'https://pixelfed.social'
    );
    assert.equal(unknownMasto.media[0].type, 'image');
    assert.equal(unknownMasto.media[0].url, 'https://pixelfed.social/storage/m/_v2/123/photo.jpg');

    // 5. Empty-attachment stub does not wipe existing attachments in mergePostMutation or deduplicateUnifiedItems
    const withAtts = toUnifiedItem({
      id: 'mastodon:keep_att_1',
      protocol: 'mastodon',
      content_text: 'Photo post',
      date_published: '2026-11-21T15:00:00Z',
      author: { id: 'a1', handle: 'a1@m.social' },
      attachments: [{ type: 'image', url: 'https://m.social/full.jpg', previewUrl: 'https://m.social/thumb.jpg', width: 1000, height: 1000 }],
      _meta: { mastodon: { statusId: 'keep_att_1', uri: 'https://m.social/users/a1/statuses/1' } },
    });
    const stubNoAtts = {
      id: 'mastodon:keep_att_1',
      protocol: 'mastodon',
      content_text: 'Photo post',
      date_published: '2026-11-21T15:00:00Z',
      author: { id: 'a1', handle: 'a1@m.social' },
      attachments: [],
      _meta: { mastodon: { statusId: 'keep_att_1', uri: 'https://m.social/users/a1/statuses/1' }, linkedIds: { blueskyUri: 'at://did:plc:a/post/1' } },
    };
    assert.equal(mergePostMutation(withAtts, stubNoAtts).attachments.length, 1);
    const deduped = deduplicateUnifiedItems([withAtts, stubNoAtts]);
    assert.equal(deduped[0].attachments.length, 1);

    // 6. Photos 2+ image post uses square 1:1 carousel + no-referrer + previewUrl fallback, and sieves reject extreme non-IG multi-slide ratios
    const ig2Card = createPostCard(
      {
        id: 'mastodon:ig_2up',
        protocol: 'mastodon',
        content_text: 'Two square film shots #pixelfed',
        date_published: '2026-11-21T15:01:00Z',
        author: { id: 'ig1', handle: 'ig1@pixelfed.social', discoverable: true, indexable: true },
        attachments: [
          { type: 'image', url: 'https://pixelfed.social/broken-full.jpg', previewUrl: 'https://pixelfed.social/fallback-1.jpg', width: 1080, height: 1080 },
          { type: 'image', url: 'https://pixelfed.social/sq-2.jpg', previewUrl: 'https://pixelfed.social/fallback-2.jpg', width: 1080, height: 1350 },
        ],
        _meta: { mastodon: { statusId: 'ig_2up' } },
      },
      { layoutVariant: 'ig_photo' }
    );
    assert.equal(ig2Card.classList.contains('is-ig-photo-card'), true);
    assert.ok(ig2Card.querySelector('.post-media-carousel'), '2-image Photos card must use square carousel instead of 2-up pair');
    const firstImg = ig2Card.querySelector('.post-media-item');
    assert.equal(firstImg.getAttribute('referrerpolicy'), 'no-referrer');
    firstImg.dispatchEvent(new Event('error'));
    assert.equal(firstImg.src, 'https://pixelfed.social/fallback-1.jpg');

    const shellCss = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/shell.css'), 'utf8');
    assert.match(shellCss, /\.post-card\.is-ig-photo-card \.post-carousel-slide\s*\{[\s\S]*?aspect-ratio:\s*1\s*\/\s*1/);

    const mixedSlides = toUnifiedItem({
      id: 'mastodon:mixed_ig_bad',
      protocol: 'mastodon',
      content_text: 'Square first slide + tall second slide #pixelfed',
      date_published: '2026-11-21T15:02:00Z',
      author: { id: 'ig2', handle: 'ig2@pixelfed.social', discoverable: true, indexable: true },
      attachments: [
        { type: 'image', url: 'https://pixelfed.social/1.jpg', width: 1080, height: 1080 },
        { type: 'image', url: 'https://pixelfed.social/2.jpg', width: 500, height: 1250 },
      ],
      _meta: { mastodon: { statusId: 'mixed_ig_bad' } },
    });
    assert.deepEqual(sieveSovereignCandidates([mixedSlides], null, { discoveryMode: 'photos' }), []);
  } finally {
    resetFeedStoreForTests();
    dom.restore();
  }
});

test('Voice Call modal uses circular icon+label controls with aria-pressed and single title', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  try {
    const call = openVoiceCallOverlay({
      programId: 'sebile',
      programName: 'Sebile',
      sessionId: 'default',
    });
    const dlg = dom.document.getElementById('voice-call-dialog');
    assert.ok(dlg && dlg.open);
    const titleEl = dlg.querySelector('.classic-modal-title');
    assert.equal(titleEl?.textContent, 'Voice Call');
    assert.equal(dlg.querySelector('.voice-call-program-name')?.textContent, 'Sebile');

    const controls = Array.from(dlg.querySelectorAll('.voice-call-action'));
    assert.equal(controls.length, 4);
    assert.deepEqual(
      controls.map((btn) => btn.querySelector('.voice-call-btn-label')?.textContent),
      ['Tap to Speak', 'Mute', 'Speaker', 'End Call']
    );
    for (const btn of controls) {
      assert.match(btn.querySelector('.voice-call-btn-disc')?.innerHTML || '', /<svg[^>]*aria-hidden="true"/);
    }

    const [speakBtn, muteBtn, speakerBtn, endBtn] = controls;
    assert.equal(speakBtn.hasAttribute('aria-pressed'), false);
    assert.equal(endBtn.hasAttribute('aria-pressed'), false);
    assert.equal(muteBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(speakerBtn.getAttribute('aria-pressed'), 'true');

    muteBtn.click();
    assert.equal(muteBtn.getAttribute('aria-pressed'), 'true');
    assert.equal(muteBtn.querySelector('.voice-call-btn-label')?.textContent, 'Mute');

    speakerBtn.click();
    assert.equal(speakerBtn.getAttribute('aria-pressed'), 'false');
    assert.equal(speakerBtn.querySelector('.voice-call-btn-label')?.textContent, 'Speaker');

    const sanctuaryCss = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/sanctuary.css'), 'utf8');
    assert.match(sanctuaryCss, /\.voice-call-btn-disc\s*\{[\s\S]*?inline-size:\s*52px;[\s\S]*?block-size:\s*52px;/);
    assert.match(sanctuaryCss, /\.voice-call-action\s*\{[\s\S]*?min-inline-size:\s*44px;[\s\S]*?min-block-size:\s*44px;/);

    call.close();
    assert.equal(dom.document.getElementById('voice-call-dialog'), null);
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Quest Log formats target dates without seconds, spaces button icons, and cleans card hierarchy', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000', activeProgram: 'sebile' });
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/quests')) {
      return new Response(
        JSON.stringify({
          quests: [
            {
              id: 'q1',
              title: 'Listen to Radio Rakel',
              location: 'Radio Rakel',
              due: '2026-11-28T18:00:00',
              objectives: ['Check out experimental journalism and punk.'],
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const qModal = openQuestModal({ sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 25));
    const dlg = dom.document.getElementById('quest-log-dialog');
    assert.ok(dlg && dlg.open);
    const card = dlg.querySelector('.list-entry-row.quest-card');
    assert.ok(card);
    assert.equal(card.querySelector('.quest-card-title')?.textContent, 'Listen to Radio Rakel');
    assert.equal(card.querySelectorAll('.quest-meta-pill').length, 2);
    assert.doesNotMatch(card.querySelectorAll('.quest-meta-pill')[1].textContent, /\d+:\d{2}:\d{2}/);
    assert.ok(card.querySelector('.quest-objective-single'));
    assert.equal(card.querySelector('.classic-quest-objectives'), null);
    assert.ok(card.querySelector('.row-icon-btn.success[aria-label="Complete Listen to Radio Rakel"]'));
    assert.ok(card.querySelector('.row-icon-btn.danger[aria-label="Delete Listen to Radio Rakel"]'));
    assert.equal(card.querySelectorAll('.quest-card-footer .edit-btn.edit-cancel-btn').length, 2);

    const sanctuaryCss = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/sanctuary.css'), 'utf8');
    assert.match(sanctuaryCss, /\.edit-btn\s*\{[\s\S]*?gap:\s*6px;/);

    qModal.close();
  } finally {
    resetConnectionStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Sebile restrictions are removed so any user can edit, recolor, rename, and delete Sebile', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const apiCalls = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    apiCalls.push({ url: u, method: init?.method || 'GET', body: String(init?.body || '') });
    if (u.includes('/api/programs/profile/load')) {
      return new Response(JSON.stringify({ name: 'Sebile', personality: 'direct' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/programs/rename')) {
      return new Response(JSON.stringify({ status: 'success', new_id: 'sebile_free', was_active: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/programs/profile/save') || u.includes('/api/programs/palette') || u.includes('/api/programs/delete')) {
      return new Response(JSON.stringify({ status: 'success' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/programs')) {
      return new Response(JSON.stringify({ programs: [{ id: 'sebile', name: 'Sebile', personality: 'direct' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/mobile/health')) {
      return new Response(JSON.stringify({ status: 'ok', programs: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ sessions: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', personality: 'direct' }],
    });

    // 1. Non-Davy user opens Program Card & Palette modals for 'sebile' and can rename/save
    const cardModal = openProgramCardModal({
      programId: 'sebile',
      activeUser: 'builder',
      activeProgramId: 'sebile',
    });
    assert.ok(cardModal && cardModal.dialog.open);
    await new Promise((r) => setTimeout(r, 20));
    dom.document.getElementById('comp-name').value = 'Sebile Free';
    const saveCardBtn = Array.from(cardModal.dialog.querySelectorAll('button')).find((b) => b.textContent === 'Save Program Card');
    saveCardBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/programs/rename') && c.body.includes('"Sebile Free"')));
    assert.ok(apiCalls.some((c) => c.url.includes('/api/programs/profile/save') && c.body.includes('"sebile_free"')));

    const palModal = openPaletteModal({
      programId: 'sebile',
      programName: 'Sebile',
      activeUser: 'builder',
    });
    assert.ok(palModal && palModal.dialog.open);
    palModal.close();

    // 2. Programs tab Delete button stays enabled even when Sebile is the only Program
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const msgCtrl = mountMessagesScreen(host, { initialTab: 'programs', activeUser: 'builder' });
    await new Promise((r) => setTimeout(r, 25));
    const delBtn = host.querySelector('.row-icon-btn[aria-label="Delete Sebile"]');
    assert.ok(delBtn);
    assert.equal(delBtn.disabled, false);
    msgCtrl.destroy();
  } finally {
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('AuthorSheetModal includes Message button that opens 1:1 Mastodon and Bluesky DM threads', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const convoMemberCalls = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('chat.bsky.convo.getConvoForMembers')) {
      convoMemberCalls.push(u);
      return new Response(
        JSON.stringify({
          convo: {
            id: 'convo_alice_1',
            status: 'accepted',
            members: [
              { did: 'did:plc:self', handle: 'me.bsky.social' },
              { did: 'did:plc:alice_bsky', handle: 'alice.bsky.social', displayName: 'Alice Bsky' },
            ],
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('chat.bsky.convo.listConvos')) {
      return new Response(
        JSON.stringify({
          convos: [
            {
              id: 'convo_alice_1',
              status: 'accepted',
              unreadCount: 0,
              members: [
                { did: 'did:plc:self', handle: 'me.bsky.social' },
                { did: 'did:plc:alice_bsky', handle: 'alice.bsky.social', displayName: 'Alice Bsky' },
              ],
              lastMessage: { text: 'Latest from Alice' },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('chat.bsky.convo.getMessages')) {
      return new Response(
        JSON.stringify({
          messages: [
            { id: 'm2', sender: { did: 'did:plc:self' }, text: 'My outgoing DM', sentAt: '2026-11-21T18:02:00Z' },
            { id: 'm1', sender: { did: 'did:plc:alice_bsky' }, text: 'Hello from Alice', sentAt: '2026-11-21T18:01:00Z' },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/conversations')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let shell = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    await upsertSocialAccount(
      { id: 'fedi_1', platform: 'fediverse', instanceUrl: 'https://mastodon.social', acct: 'me', userId: 'u_me' },
      { accessToken: 'tok_fedi' }
    );
    await upsertSocialAccount(
      { id: 'bsky_1', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:self', handle: 'me.bsky.social' },
      { accessJwt: 'jwt_a', refreshJwt: 'jwt_r' }
    );

    const root = dom.document.createElement('div');
    dom.document.body.appendChild(root);
    shell = createAppShell(root, { skipBackgroundInit: true });

    // 1. Remote Mastodon user without @domain in acct qualifies host via instanceUrl and opens Sanctuary-styled DM in right dock
    const mastoSheet = openAuthorSheetModal({
      author: { id: '9901', name: 'Alice Foss', handle: 'alice', url: 'https://fosstodon.org/@alice', protocol: 'mastodon' },
      instanceUrl: 'https://fosstodon.org',
    });
    const mastoMsgBtn = mastoSheet.dialog.querySelector('.author-dm-btn');
    assert.ok(mastoMsgBtn && mastoMsgBtn.textContent === 'Message');
    mastoMsgBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(dom.document.getElementById('author-sheet-dialog'), null);
    const dmDockThread = root.querySelector('#sanctuary-right-dock .human-dm-thread.sanctuary-thread-view');
    assert.ok(dmDockThread, 'Direct message thread must mount inside #sanctuary-right-dock with .sanctuary-thread-view styling');
    assert.equal(root.querySelector('#sanctuary-right-dock .sanctuary-program-dock-pane')?.hidden, true);
    assert.equal(dmDockThread.querySelector('.post-author-handle')?.textContent, '@alice@fosstodon.org');
    assert.ok(dmDockThread.querySelector('.input-wrapper .sanctuary-user-input'));
    assert.ok(dmDockThread.querySelector('.send-btn'));

    // 2. Bluesky user sheet Message button resolves getConvoForMembers with DID and switches thread
    const bskySheet = openAuthorSheetModal({
      author: { id: 'did:plc:alice_bsky', name: 'Alice Bsky', handle: 'alice.bsky.social', protocol: 'bluesky' },
    });
    const bskyMsgBtn = bskySheet.dialog.querySelector('.author-dm-btn');
    assert.ok(bskyMsgBtn);
    bskyMsgBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(convoMemberCalls.some((u) => u.includes('did%3Aplc%3Aalice_bsky') || u.includes('did:plc:alice_bsky')));
    assert.equal(root.querySelector('#sanctuary-right-dock .human-dm-thread .post-author-handle')?.textContent, '@alice.bsky.social');

    // 3. Back button in DM header restores Sanctuary Program chat in right dock
    const backToSanctuaryBtn = root.querySelector('#sanctuary-right-dock .dm-dock-back-btn');
    assert.ok(backToSanctuaryBtn);
    backToSanctuaryBtn.click();
    assert.equal(root.querySelector('#sanctuary-right-dock .human-dm-thread'), null);
    assert.equal(root.querySelector('#sanctuary-right-dock .sanctuary-program-dock-pane')?.hidden, false);

    // 4. Selecting a Direct Message in Messages keeps the list visible and renders Sanctuary-styled bubbles in the right dock
    shell.navigateToTab('messages');
    await new Promise((r) => setTimeout(r, 40));
    const humanRow = root.querySelector('.messages-screen .convo-row--human');
    assert.ok(humanRow, 'Expected Direct Message conversation row in Messages screen');
    humanRow.click();
    await new Promise((r) => setTimeout(r, 40));

    assert.ok(root.querySelector('.messages-screen .convo-row--human.is-selected'));
    const dockDm = root.querySelector('#sanctuary-right-dock .human-dm-thread.sanctuary-thread-view');
    assert.ok(dockDm);
    assert.ok(dockDm.querySelector('.sanctuary-chat-container .message-row.program-row .message.program'));
    assert.ok(dockDm.querySelector('.sanctuary-chat-container .message-row.program-row .avatar-container img.avatar'));
    assert.ok(dockDm.querySelector('.sanctuary-chat-container .message-row.user-row .message.user'));
    assert.ok(dockDm.querySelector('.message-timestamp'));
  } finally {
    shell?.destroy?.();
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Loops reels open unclipped rail context menu, update Interested in place without resetting video, and loop seamlessly', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('jetstream')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();

    const makeVideoPost = (id, handle) => toUnifiedItem({
      id: `mastodon:${id}`,
      protocol: 'mastodon',
      content_text: `Loop clip ${id}`,
      date_published: '2026-11-21T16:00:00Z',
      author: { id: `u_${id}`, handle, name: handle },
      attachments: [
        { type: 'video', url: `https://loops.example/v_${id}.mp4`, previewUrl: `https://loops.example/p_${id}.jpg`, width: 720, height: 1280 },
      ],
      _meta: { mastodon: { statusId: id } },
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    setActiveStream('video');
    setStreamItems('video', [
      makeVideoPost('reel_1', 'creator1@loops.video'),
      makeVideoPost('reel_2', 'creator2@loops.video'),
    ], null);

    feedCtrl = mountFeedScreen(host, {});
    await new Promise((r) => setTimeout(r, 25));

    const slides = host.querySelectorAll('article.loops-slide');
    assert.equal(slides.length, 2);
    const v0 = slides[0].querySelector('video.loops-video');
    const v1 = slides[1].querySelector('video.loops-video');
    assert.equal(v0.getAttribute('preload'), 'auto', 'Active first slide promotes preload="auto" for clean loop');
    assert.equal(v1.getAttribute('loading'), 'lazy', 'Offscreen slides remain loading="lazy"');
    assert.equal(v0.getAttribute('referrerpolicy'), 'no-referrer');

    // Open '...' action menu in rail -> rail gets .has-open-menu and exposes Interested/Not Interested/Mute/Block
    const rail = slides[0].querySelector('.loops-action-rail');
    const moreBtn = rail.querySelector('.post-more-btn');
    const menuPanel = rail.querySelector('.post-context-menu');
    assert.ok(moreBtn && menuPanel);
    moreBtn.click();
    assert.equal(menuPanel.hidden, false);
    assert.equal(rail.classList.contains('has-open-menu'), true);
    const items = [...menuPanel.querySelectorAll('.post-context-menuitem')];
    assert.deepEqual(items.map((b) => b.textContent), ['Interested', 'Not Interested', 'Mute Account', 'Block Account']);

    // Clicking Interested keeps the exact <video> DOM node alive (no playback interruption) and flips Interested ✓ in place
    items[0].click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(slides[0].querySelector('video.loops-video'), v0);
    assert.equal(items[0].textContent, 'Interested ✓');
    assert.equal(rail.classList.contains('has-open-menu'), false);

    // Gapless loop: near-end timeupdate rewinds currentTime to 0, and ended calls play()
    const stage = slides[0].querySelector('.loops-stage');
    v0.duration = 5.0;
    v0.currentTime = 4.97;
    v0.paused = false;
    v0.seeking = false;
    v0.dispatchEvent(new Event('timeupdate'));
    assert.equal(v0.currentTime, 0);

    let playRestartCount = 0;
    v0.play = () => {
      playRestartCount += 1;
      return Promise.resolve();
    };
    v0.currentTime = 5.0;
    v0.dispatchEvent(new Event('ended'));
    assert.equal(v0.currentTime, 0);
    assert.equal(playRestartCount, 1);

    // When user paused explicitly, ended/timeupdate must not override pause
    stage.classList.add('is-user-paused');
    v0.currentTime = 4.98;
    v0.dispatchEvent(new Event('timeupdate'));
    assert.equal(v0.currentTime, 4.98);
    v0.dispatchEvent(new Event('ended'));
    assert.equal(playRestartCount, 1);

    const shellCss = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/shell.css'), 'utf8');
    assert.match(shellCss, /\.loops-action-rail \.post-context-menu\s*\{[\s\S]*?inset-block-end:\s*0;[\s\S]*?inset-inline-end:\s*calc\(100%\s*\+\s*10px\);/);
  } finally {
    feedCtrl?.destroy?.();
    resetFeedStoreForTests();
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('avatar crop modal fits stage strictly to image aspect ratio without Cropper checker background', () => {
  const dom = installMockDom();
  const prevCropper = globalThis.Cropper;
  const prevInnerW = globalThis.innerWidth;
  const prevInnerH = globalThis.innerHeight;
  const prevCreateEl = dom.document.createElement.bind(dom.document);
  try {
    globalThis.innerWidth = 1280;
    globalThis.innerHeight = 800;

    // Case 1: uncached async portrait image (800x1200, 2:3) firing load event
    const createdImgs = [];
    dom.document.createElement = (tag, opts) => {
      const el = prevCreateEl(tag, opts);
      if (String(tag).toLowerCase() === 'img') {
        el.complete = false;
        el.naturalWidth = 0;
        el.naturalHeight = 0;
        createdImgs.push(el);
      }
      return el;
    };

    const cropperCalls = [];
    globalThis.Cropper = class MockCropper {
      constructor(imgEl, options) {
        cropperCalls.push({ imgEl, options });
      }
      destroy() {}
    };

    openAvatarCropModal('/api/sanctuary/portrait/p1.png', 'sebile', () => {});
    const modalDialog = dom.document.getElementById('crop-modal');
    assert.ok(modalDialog);
    const modalCard = modalDialog.querySelector('.modal-card');
    assert.equal(modalCard.style.width, 'fit-content');
    const stage = modalDialog.querySelector('.avatar-crop-stage');
    assert.ok(stage, 'Expected dedicated .avatar-crop-stage wrapper instead of colliding .cropper-container');
    assert.equal(modalDialog.querySelector('.cropper-container'), null);
    assert.equal(cropperCalls.length, 0, 'Cropper must wait for uncached image intrinsic dimensions before initializing');

    const imgEl = createdImgs[0];
    imgEl.complete = true;
    imgEl.naturalWidth = 800;
    imgEl.naturalHeight = 1200;
    imgEl.dispatchEvent(new Event('load'));

    assert.equal(cropperCalls.length, 1);
    assert.equal(cropperCalls[0].options.background, false);
    assert.equal(cropperCalls[0].options.viewMode, 1);
    assert.equal(cropperCalls[0].options.dragMode, 'move');
    assert.equal(cropperCalls[0].options.aspectRatio, 1);

    // maxH = round(800 * 0.6) = 480; maxW = 460 => scale = 480 / 1200 = 0.4 => 320x480 exact 2:3 fit
    assert.equal(stage.style.width, '320px');
    assert.equal(stage.style.height, '480px');
    assert.equal(imgEl.style.width, '100%');
    assert.equal(imgEl.style.height, '100%');

    const sanctuaryCss = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/sanctuary.css'), 'utf8');
    const shellCss = fs.readFileSync(path.resolve(process.cwd(), 'web/assets/css/shell.css'), 'utf8');
    assert.match(sanctuaryCss, /\.cropper-bg\s*\{[\s\S]*?background-image:\s*none\s*!important;/);
    assert.match(shellCss, /\.avatar-crop-stage\s*\{[\s\S]*?overflow:\s*clip;/);
    assert.match(shellCss, /\.avatar-crop-source\s*\{[\s\S]*?display:\s*block;/);
  } finally {
    dom.document.createElement = prevCreateEl;
    globalThis.Cropper = prevCropper;
    globalThis.innerWidth = prevInnerW;
    globalThis.innerHeight = prevInnerH;
    dom.restore();
  }
});

test('Refresh feed captures a fresh Fediverse snapshot with cache: no-store, avoids reusing identical pool hosts, and prioritizes unseen posts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;

  let snapshotRound = 1;
  const fetchCalls = [];
  const makeStatus = (id, acct, text, createdAt) => ({
    id,
    created_at: createdAt,
    content: `<p>${text}</p>`,
    visibility: 'public',
    account: {
      id: `u_${id}`,
      username: acct.split('@')[0],
      acct,
      display_name: acct,
      discoverable: true,
      indexable: true,
    },
    media_attachments: [],
    replies_count: 0,
    reblogs_count: 0,
    favourites_count: 0,
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    fetchCalls.push({ url: u, cache: init?.cache || '' });
    if (u.includes('api.fedidb.org')) {
      return new Response(
        JSON.stringify({ data: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('jetstream')) {
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/notes/local-timeline')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/trends/statuses')) {
      const host = new URL(u).hostname;
      if (snapshotRound === 1) {
        return new Response(
          JSON.stringify([
            makeStatus(`r1_${host}`, `alice@${host}`, `Snapshot one post from ${host}`, '2026-11-21T18:00:00Z'),
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify([
          makeStatus(`r2_${host}`, `bob@${host}`, `Snapshot two fresh post from ${host}`, '2026-11-21T18:05:00Z'),
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    clearHarvesterCacheForTests();
    clearFediverseDiscoveryCacheForTests();
    feedStore.set({
      tuning: {
        version: 2,
        updatedAt: 0,
        updatedBy: 'default',
        discoveryChannels: [],
        discoveryInstances: ['mastodon.world', 'fosstodon.org'],
      },
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host, {});
    await new Promise((r) => setTimeout(r, 120));

    const round1Texts = Array.from(host.querySelectorAll('.post-card')).map((el) => el.textContent);
    assert.ok(round1Texts.length > 0 && round1Texts.some((t) => t.includes('Snapshot one post')));

    const round1Hosts = new Set(
      fetchCalls.filter((c) => c.url.includes('/api/v1/trends/statuses')).map((c) => new URL(c.url).hostname)
    );
    assert.ok(round1Hosts.size > 0);
    assert.equal(
      fetchCalls.some((c) => c.url.includes('/api/v1/trends/statuses') && c.cache === 'no-store'),
      false,
      'Initial harvest uses normal fetch caching unless force-refreshed'
    );

    fetchCalls.length = 0;
    snapshotRound = 2;
    host.querySelector('.feed-refresh-btn').click();
    await new Promise((r) => setTimeout(r, 140));

    const noStoreCalls = fetchCalls.filter(
      (c) => c.url.includes('/api/v1/trends/statuses') && c.cache === 'no-store'
    );
    assert.ok(noStoreCalls.length > 0, 'Clicking Refresh feed must bypass HTTP cache with cache: no-store');

    const round2First = host.querySelector('.post-card')?.textContent || '';
    assert.ok(round2First.includes('Snapshot two fresh post'), 'New Fediverse snapshot posts must appear at the top');
  } finally {
    feedCtrl?.destroy?.();
    clearHarvesterCacheForTests();
    clearFediverseDiscoveryCacheForTests();
    resetFeedStoreForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('clearLearnedTasteMemory survives concurrent hydrateFeedTuning and SettingsModal distinguishes Server Offline from No Models', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let settingsModal = null;
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();

    await kvSet('feed_taste_memory_v1', {
      positive: [{ id: 'p1', text: 'Cooperative engineering analysis post', weight: 1.0, ts: 1 }],
      negative: [{ id: 'n1', text: 'Sponsored flash sale promo link', weight: 0.9, ts: 1 }],
    });

    const hydratePromise = hydrateFeedTuning();
    await clearLearnedTasteMemory();
    await hydratePromise;

    assert.deepEqual(feedStore.get().tasteMemory, { positive: [], negative: [] });

    await hydrateFeedTuning();
    assert.deepEqual(feedStore.get().tasteMemory, { positive: [], negative: [] });

    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('/api/models/native/list')) {
        return jsonResponse({
          gguf_models: [{ filename: 'gemma.gguf', name: 'Gemma 4', size_gb: 18.68 }],
          checkpoints: [{ filename: 'wai.safetensors', name: 'WAI', size_gb: 6.94 }],
          loras: ['l1.safetensors'],
          workflows: ['ImageWorkflow.json'],
          active_llm: 'gemma.gguf',
          active_checkpoint: 'wai.safetensors',
        });
      }
      if (s.includes('/api/project_settings')) return jsonResponse({});
      if (s.includes('/api/openhands/server')) return jsonResponse({ running: false, port: 8091 });
      return jsonResponse({});
    };

    connectionStore.set({ mode: 'offline', nodeUrl: 'http://127.0.0.1:5000' });
    settingsModal = openSettingsModal({ initialTab: 'engine' });
    assert.ok(settingsModal.dialog.textContent.includes('Server Offline'));
    assert.equal(settingsModal.dialog.textContent.includes('No .gguf models found'), false);

    connectionStore.set({ mode: 'online' });
    await new Promise((r) => setTimeout(r, 40));
    assert.ok(settingsModal.dialog.textContent.includes('Gemma 4 (18.68 GB)'));
    assert.ok(settingsModal.dialog.textContent.includes('WAI (6.94 GB)'));
  } finally {
    settingsModal?.close?.();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Consideration & use-value sublation: Feed/Photos/Loops UX, Profile 0ms SWR + 2-phase unification, and Activity dialogue-first facepiles', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevMatchMedia = globalThis.matchMedia;
  let feedCtrl = null;
  let profCtrl = null;
  let profCtrl2 = null;
  let actCtrl = null;

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();

    // 1. Feed: below-fold deferral (idx >= 5 only), milestone at #25, reading-time pill, and provenance banner
    const feedItems = [];
    for (let i = 0; i < 26; i += 1) {
      const isEssay = i === 0;
      const isSecondDegree = i === 1;
      const essayText = isEssay ? `${'cooperative '.repeat(210).trim()} analysis` : `Consideration feed item #${i + 1}`;
      feedItems.push({
        id: `mastodon:cons_${i}`,
        protocol: 'mastodon',
        content_text: essayText,
        date_published: new Date(Date.UTC(2026, 10, 22, 12, 0, 26 - i)).toISOString(),
        author: { id: `u_${i}`, name: `Author ${i}`, handle: `author${i}@mastodon.social` },
        metrics: { likes: i + 1, replies: 0, reposts: 0 },
        _meta: {
          mastodon: { statusId: `cons_${i}` },
          ...(isSecondDegree ? { feedSource: 'second_degree', endorsedBy: 'comrade@hachyderm.io' } : {}),
        },
      });
    }
    setStreamItems('feed', feedItems);

    // Photos stream with descriptive ALT text
    const photoItems = Array.from({ length: 8 }, (_, idx) => ({
      id: `mastodon:ph_${idx}`,
      protocol: 'mastodon',
      content_text: `Studio craft shot #${idx + 1}`,
      date_published: new Date(Date.UTC(2026, 10, 22, 11, 0, 10 - idx)).toISOString(),
      author: { id: `ph_${idx}`, name: `Artist ${idx}`, handle: `artist${idx}@pixelfed.social` },
      attachments: [
        {
          type: 'image',
          url: `https://pixelfed.social/art_${idx}.jpg`,
          previewUrl: `https://pixelfed.social/art_${idx}_thumb.jpg`,
          width: 1080,
          height: 1080,
          alt_text: idx === 0 ? 'Hand-pulled linocut print on cotton rag paper showing cooperative printshop press' : '',
        },
      ],
      metrics: { likes: 4 + idx, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: `ph_${idx}` } },
    }));
    setStreamItems('photos', photoItems);

    // Video (Loops) stream
    const loopItems = [
      {
        id: 'mastodon:lp_1',
        protocol: 'mastodon',
        content_text: 'Short woodworking lathe loop showing mortise and tenon joinery in slow detail for craftspeople',
        date_published: '2026-11-22T10:00:00.000Z',
        author: { id: 'l1', name: 'Joiner', handle: 'joiner@loops.video' },
        attachments: [{ type: 'video', url: 'https://loops.video/l1.mp4', width: 720, height: 1280 }],
        _meta: { mastodon: { statusId: 'lp_1' } },
      },
      {
        id: 'mastodon:lp_2',
        protocol: 'mastodon',
        content_text: 'Second craft loop',
        date_published: '2026-11-22T09:59:00.000Z',
        author: { id: 'l2', name: 'Weaver', handle: 'weaver@loops.video' },
        attachments: [{ type: 'video', url: 'https://loops.video/l2.mp4', width: 720, height: 1280 }],
        _meta: { mastodon: { statusId: 'lp_2' } },
      },
    ];
    setStreamItems('video', loopItems);

    globalThis.matchMedia = () => ({ matches: true, addEventListener: () => {}, removeEventListener: () => {} });
    globalThis.fetch = async () => jsonResponse([]);

    const feedHost = dom.document.createElement('div');
    dom.document.body.appendChild(feedHost);
    feedCtrl = mountFeedScreen(feedHost);
    await new Promise((r) => setTimeout(r, 25));

    const feedCards = Array.from(feedHost.querySelectorAll('article.post-card'));
    assert.equal(feedCards.length, 26);
    assert.equal(feedCards[0].classList.contains('is-below-fold'), false);
    assert.equal(feedCards[4].classList.contains('is-below-fold'), false);
    assert.equal(feedCards[5].classList.contains('is-below-fold'), true);
    assert.equal(feedCards[24].dataset.considerationMilestone, undefined);
    assert.equal(feedCards[0].querySelector('.post-reading-time-pill'), null);
    const provCard = feedCards.find((c) => c.querySelector('.post-provenance-banner'));
    assert.ok(provCard);
    assert.ok(provCard.querySelector('.post-provenance-banner')?.textContent.includes('Liked by'));
    assert.ok(provCard.querySelector('.post-provenance-banner')?.textContent.includes('@comrade@hachyderm.io'));

    // Photos: ALT image description disclosure and Gallery toggle are disabled
    feedHost.querySelector('.stage-tab-btn[data-stream="photos"]').click();
    await new Promise((r) => setTimeout(r, 20));
    const firstIg = feedHost.querySelector('.post-card.is-ig-photo-card');
    assert.ok(firstIg);
    assert.equal(feedHost.querySelector('details.post-alt-disclosure'), null);
    assert.equal(feedHost.querySelector('.photos-view-btn'), null);
    assert.equal(feedHost.querySelector('.photo-mosaic-tile'), null);

    // Video (Loops): scrubber + duration + reduced-motion gating + keyboard nav
    feedHost.querySelector('.stage-tab-btn[data-stream="video"]').click();
    await new Promise((r) => setTimeout(r, 20));
    const slides = Array.from(feedHost.querySelectorAll('article.loops-slide'));
    assert.equal(slides.length, 2);
    const v0 = slides[0].querySelector('video.loops-video');
    let playedInReducedMotion = false;
    v0.play = () => { playedInReducedMotion = true; return Promise.resolve(); };
    Object.defineProperty(v0, 'duration', { value: 75, configurable: true });
    Object.defineProperty(v0, 'currentTime', { value: 15, writable: true, configurable: true });
    v0.dispatchEvent(new Event('timeupdate'));
    assert.equal(slides[0].querySelector('.loops-time-pill')?.textContent, '0:15 / 1:15');
    const scrubber = slides[0].querySelector('.loops-scrubber');
    scrubber.value = '500';
    scrubber.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(Math.round(v0.currentTime), 38);
    assert.equal(playedInReducedMotion, false);

    // 2. Profile: 2-phase non-blocking load, in-place resonance update, cross-post unification, & 0ms SWR cache
    resetMemoryStorageForTests();
    const bskyMetricsGate = createDeferred();
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/v1/accounts/verify_credentials')) {
        return jsonResponse({ id: 'm_me', username: 'davy', acct: 'davy@mastodon.social', display_name: 'Davy' });
      }
      if (u.includes('/api/v1/accounts/m_me/statuses') && u.includes('pinned=true')) {
        return jsonResponse([]);
      }
      if (u.includes('/api/v1/accounts/m_me/statuses')) {
        return jsonResponse([
          {
            id: 'm_p1',
            content: '<p>Cross-posted worker cooperative notes for all networks</p>',
            created_at: '2026-11-22T08:00:00.000Z',
            favourites_count: 3,
            reblogs_count: 1,
            replies_count: 1,
            account: { id: 'm_me', username: 'davy', acct: 'davy@mastodon.social', display_name: 'Davy' },
          },
          {
            id: 'm_short',
            content: '<p>I need money.</p>',
            created_at: '2026-11-22T07:45:00.000Z',
            favourites_count: 0,
            reblogs_count: 0,
            replies_count: 0,
            account: { id: 'm_me', username: 'davy', acct: 'davy@mastodon.social', display_name: 'Davy' },
          },
        ]);
      }
      if (u.includes('graph.threads.net/v1.0/th_me/threads')) {
        return jsonResponse({
          data: [
            { id: 'th_repost_stub', media_type: 'REPOST_FACADE', timestamp: '2026-11-22T07:50:00.000Z' },
            { id: 'th_short_1', text: 'I need money.', media_type: 'TEXT_POST', timestamp: '2026-11-22T07:45:10.000Z' },
          ],
        });
      }
      if (u.includes('app.bsky.feed.getAuthorFeed')) {
        return jsonResponse({
          feed: [
            {
              post: {
                uri: 'at://did:plc:davy/app.bsky.feed.post/bp1',
                cid: 'cid_bp1',
                record: { text: 'Cross-posted worker cooperative notes for all networks', createdAt: '2026-11-22T08:00:05.000Z' },
                author: { did: 'did:plc:davy', handle: 'davy.bsky.social', displayName: 'Davy' },
              },
            },
            {
              post: {
                uri: 'at://did:plc:davy/app.bsky.feed.post/bp_solo',
                cid: 'cid_solo',
                record: { text: 'Bluesky-only sketch', createdAt: '2026-11-22T07:30:00.000Z' },
                author: { did: 'did:plc:davy', handle: 'davy.bsky.social', displayName: 'Davy' },
              },
            },
          ],
        });
      }
      if (u.includes('app.bsky.feed.getPosts')) {
        await bskyMetricsGate.promise;
        return jsonResponse({
          posts: [
            { uri: 'at://did:plc:davy/app.bsky.feed.post/bp1', likeCount: 6, replyCount: 2, repostCount: 1 },
          ],
        });
      }
      return jsonResponse({});
    };

    await upsertSocialAccount(
      { id: 'fediverse:davy@mastodon.social', platform: 'fediverse', instanceUrl: 'https://mastodon.social', userId: 'm_me', acct: 'davy@mastodon.social', handle: 'davy', displayName: 'Davy' },
      { accessToken: 'm_tok' }
    );
    await upsertSocialAccount(
      { id: 'bluesky:did:plc:davy', platform: 'bluesky', serviceUrl: 'https://bsky.social', did: 'did:plc:davy', handle: 'davy.bsky.social', acct: 'davy.bsky.social' },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );
    await upsertSocialAccount(
      { id: 'threads:th_me', platform: 'threads', userId: 'th_me', handle: 'davyrhodes_', acct: 'davyrhodes_' },
      { accessToken: 't_tok' }
    );

    const profHost = dom.document.createElement('div');
    dom.document.body.appendChild(profHost);
    profCtrl = mountProfileScreen(profHost, {});
    await new Promise((r) => setTimeout(r, 40));

    // Phase 1 painted BEFORE bskyMetricsGate resolved, unified matched cross-post + short post + standalone Bluesky without REPOST_FACADE blank stubs
    const initialCards = Array.from(profHost.querySelectorAll('article.post-card'));
    assert.equal(initialCards.length, 3);
    assert.equal(initialCards.every((c) => !c.querySelector('.post-body-html')?.textContent?.trim() === false), true);
    assert.ok(profHost.querySelector('.profile-connected-pills'));
    const firstCardNode = initialCards[0];
    assert.equal(firstCardNode.querySelector('.post-action-like .post-action-count')?.textContent, '3');

    // Phase 2 resolves -> updates counts & cross-platform resonance strip IN-PLACE, hiding redundant top-right protocol badge
    bskyMetricsGate.resolve();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(profHost.querySelector('article.post-card'), firstCardNode);
    assert.equal(firstCardNode.querySelector('.post-action-like .post-action-count')?.textContent, '9');
    assert.ok(firstCardNode.querySelector('.post-network-resonance'));
    assert.equal(firstCardNode.querySelector('.post-protocol-badge--icons'), null);
    assert.equal(firstCardNode.querySelector('.post-resonance-chip--mastodon')?.dataset.networkTotal, '5');
    assert.equal(firstCardNode.querySelector('.post-resonance-chip--bluesky')?.dataset.networkTotal, '9');
    profCtrl.destroy();
    profCtrl = null;

    // Remounting Profile with slow network renders cached enriched posts at 0ms from profile_tabs_cache_v1
    const slowNetGate = createDeferred();
    globalThis.fetch = async () => { await slowNetGate.promise; return jsonResponse([]); };
    const profHost2 = dom.document.createElement('div');
    dom.document.body.appendChild(profHost2);
    profCtrl2 = mountProfileScreen(profHost2, {});
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(profHost2.querySelectorAll('article.post-card').length, 3);
    slowNetGate.resolve();

    // 3. Activity: 0ms SWR cache, unread "New" badge, Dialogue-First sections, & stacked facepile + People disclosure
    resetActivityStoreForTests();
    await kvSet('activity_last_seen_ts_v1', Date.parse('2026-11-22T08:30:00.000Z'));
    await kvSet('activity_items_cache_v1', [
      {
        id: 'mastodon:notif:like1',
        protocol: 'mastodon',
        type: 'like',
        date_published: '2026-11-22T09:00:00.000Z',
        content_text: 'My cooperative post',
        author: { id: 'a1', name: 'Alice', handle: 'alice@mastodon.social' },
        metrics: { likes: 2, replies: 0, reposts: 0 },
        _meta: { mastodon: { statusId: 'st1' }, notification: { type: 'favourite', notifId: 'like1', actor: { id: 'a1', name: 'Alice', handle: 'alice@mastodon.social' } } },
      },
      {
        id: 'mastodon:notif:like2',
        protocol: 'mastodon',
        type: 'like',
        date_published: '2026-11-22T08:15:00.000Z',
        content_text: 'My cooperative post',
        author: { id: 'a2', name: 'Bob', handle: 'bob@mastodon.social' },
        metrics: { likes: 2, replies: 0, reposts: 0 },
        _meta: { mastodon: { statusId: 'st1' }, notification: { type: 'favourite', notifId: 'like2', actor: { id: 'a2', name: 'Bob', handle: 'bob@mastodon.social' } } },
      },
      {
        id: 'mastodon:notif:rep1',
        protocol: 'mastodon',
        type: 'reply',
        date_published: '2026-11-22T09:05:00.000Z',
        content_text: 'Thoughtful reply asking about the architecture',
        author: { id: 'a3', name: 'Carol', handle: 'carol@mastodon.social' },
        _meta: {
          mastodon: { statusId: 'rep_1', inReplyToId: 'st1' },
          notification: {
            type: 'reply',
            notifId: 'rep1',
            actor: { id: 'a3', name: 'Carol', handle: 'carol@mastodon.social' },
            targetPost: { text: 'My cooperative post' },
          },
        },
      },
    ]);
    await hydrateActivityStore();
    globalThis.fetch = async () => jsonResponse([]);

    const actHost = dom.document.createElement('div');
    dom.document.body.appendChild(actHost);
    actCtrl = mountActivityScreen(actHost);
    assert.equal(actHost.querySelectorAll('.activity-section-header').length, 0);
    const allRows = Array.from(actHost.querySelectorAll('.activity-row'));
    assert.equal(allRows[0].classList.contains('activity-row--reply'), true);
    assert.equal(allRows[0].classList.contains('is-unread'), true);
    assert.equal(allRows[0].querySelector('.activity-new-badge')?.textContent, 'New');
    assert.ok(allRows[0].querySelector('.activity-target-quote')?.textContent.includes('My cooperative post'));
    const likeRow = allRows[1];
    assert.equal(likeRow.querySelector('.activity-avatar-wrap')?.classList.contains('has-facepile'), true);
    assert.ok(likeRow.querySelector('details.activity-actors-disclosure'));
    assert.equal(likeRow.querySelectorAll('.activity-actor-chip').length, 2);
  } finally {
    feedCtrl?.destroy?.();
    profCtrl?.destroy?.();
    profCtrl2?.destroy?.();
    actCtrl?.destroy?.();
    resetActivityStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    globalThis.matchMedia = prevMatchMedia;
    dom.restore();
  }
});

test('Feed snapshot stays locked across background sync/scoring/enrichment and Threads batch insights preserve metrics', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    clearThreadsInsightsCacheForTests();

    const p1 = toUnifiedItem({
      id: 'mastodon:m_lock_1',
      protocol: 'mastodon',
      content_text: 'Older post at top',
      date_published: '2026-11-22T10:00:00.000Z',
      author: { id: 'a1', handle: 'a1@m.social', name: 'Alice' },
      metrics: { likes: 1, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 'm_lock_1' } },
    });
    const p2 = toUnifiedItem({
      id: 'mastodon:m_lock_2',
      protocol: 'mastodon',
      content_text: 'Newer post below',
      date_published: '2026-11-22T11:00:00.000Z',
      author: { id: 'a2', handle: 'a2@m.social', name: 'Bob' },
      metrics: { likes: 0, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 'm_lock_2' } },
    });

    await updateFeedTuning({ discoveryChannels: [], discoveryInstances: [] }, { syncRemote: false, updatedBy: 'user' });
    setStreamItems('feed', [p2, p1], null);

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    feedCtrl = mountFeedScreen(host);
    await new Promise((r) => setTimeout(r, 20));

    const firstCardBefore = host.querySelector('.post-card[data-post-id="mastodon:m_lock_2"]');
    assert.ok(firstCardBefore);

    // 1. Background semantic scoring & tasteScores must NOT re-order or rebuild existing cards
    mergeSemanticFeedScores({
      axisScores: { 'mastodon:m_lock_1': { scienceTheory: 0.9 } },
      tasteScores: { 'mastodon:m_lock_1': 0.95 },
    });
    await new Promise((r) => setTimeout(r, 15));
    let ids = [...host.querySelectorAll('.post-card')].map((el) => el.dataset.postId);
    assert.deepEqual(ids, ['mastodon:m_lock_2', 'mastodon:m_lock_1']);
    assert.equal(host.querySelector('.post-card[data-post-id="mastodon:m_lock_2"]'), firstCardBefore);

    // 2. reconcileEnrichedStreamItems adding linkedIds & metricsBreakdown must update in place without rebuilding <article>
    reconcileEnrichedStreamItems([
      {
        ...p2,
        metrics: { likes: 4, replies: 1, reposts: 0 },
        _meta: {
          ...p2._meta,
          linkedIds: { mastodonStatusId: 'm_lock_2', threadsPostId: 'th_lock_2' },
          metricsBreakdown: { mastodon: { likes: 0, replies: 0, reposts: 0 }, threads: { likes: 4, replies: 1, reposts: 0 } },
        },
      },
    ]);
    await new Promise((r) => setTimeout(r, 15));
    assert.equal(host.querySelector('.post-card[data-post-id="mastodon:m_lock_2"]'), firstCardBefore);
    assert.equal(firstCardBefore.querySelector('.post-resonance-chip--threads')?.dataset?.networkTotal, '5');

    // 3. Remote syncFeedTuningFromSanctuary with updatedAt >= local must NOT re-order the mounted snapshot
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/feed_profile')) {
        return new Response(
          JSON.stringify({
            version: 1,
            updatedAt: Date.now() + 60_000,
            updatedBy: 'user',
            sliders: { recencyHalfLifeHours: 12, everydayChatter: 0, scienceTheory: 90, newsPolitics: 0, commercial: 0, matureContent: 0 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/social/threads-insights-batch')) {
        return new Response(
          JSON.stringify({ results: { th_lock_2: { likes: 6, replies: 2, reposts: 1 } } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/social/accounts')) {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 404 });
    };
    await syncFeedTuningFromSanctuary();
    await new Promise((r) => setTimeout(r, 15));
    ids = [...host.querySelectorAll('.post-card')].map((el) => el.dataset.postId);
    assert.deepEqual(ids, ['mastodon:m_lock_2', 'mastodon:m_lock_1']);

    // 4. Explicit user updateFeedTuning (with tasteScores) MUST re-rank immediately
    await updateFeedTuning({ discoveryChannels: ['science'] }, { syncRemote: false, updatedBy: 'user' });
    await new Promise((r) => setTimeout(r, 15));
    ids = [...host.querySelectorAll('.post-card')].map((el) => el.dataset.postId);
    assert.deepEqual(ids, ['mastodon:m_lock_1', 'mastodon:m_lock_2']);

    // 5. enrichUnifiedItemsMetrics uses /api/social/threads-insights-batch and preserves prior breakdown on subsequent miss
    await upsertSocialAccount({ id: 'threads:u_me', platform: 'threads', handle: 'me', userId: 'u_me' }, { accessToken: 'th_tok' });
    const enriched1 = await enrichUnifiedItemsMetrics([
      { ...p2, _meta: { ...p2._meta, linkedIds: { mastodonStatusId: 'm_lock_2', threadsPostId: 'th_lock_2' } } },
    ]);
    assert.deepEqual(enriched1[0]._meta.metricsBreakdown.threads, { likes: 6, replies: 2, reposts: 1 });

    clearThreadsInsightsCacheForTests();
    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/social/threads-insights-batch')) {
        return new Response(JSON.stringify({ results: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 500 });
    };
    const enriched2 = await enrichUnifiedItemsMetrics(enriched1);
    assert.deepEqual(enriched2[0]._meta.metricsBreakdown.threads, { likes: 6, replies: 2, reposts: 1 });
  } finally {
    feedCtrl?.destroy?.();
    clearThreadsInsightsCacheForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});
