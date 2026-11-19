import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mockMobileHealthOnline } from '../__mocks__/mockProgram.js';
import { createAppShell } from '../web/app/_layout.js';
import { mountComposeModal, publishOrganicPost } from '../web/app/composeModal.js';
import { mountFeedScreen } from '../web/app/feed.js';
import { mountMessagesScreen } from '../web/app/messages.js';
import { createPostCard } from '../web/components/PostCard.js';
import { openKnowledgeModal } from '../web/components/sanctuary/KnowledgeModal.js';
import { buildMessageRow, createSharedPostEmbedCard } from '../web/components/sanctuary/MessageRow.js';
import { createMoodHeart } from '../web/components/sanctuary/MoodHeart.js';
import { showConfirm } from '../web/components/sanctuary/SanctuaryDialog.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { openUserModal } from '../web/components/sanctuary/UserModal.js';
import { feedStore, resetFeedStoreForTests, setActiveStream } from '../web/state/feedStore.js';
import { authStore, resetAuthStoreForTests, updateAccountTokens, upsertSocialAccount } from '../web/state/authStore.js';
import {
  addMediaAttachment,
  addThreadItem,
  composeStore,
  listComposeDrafts,
  openCompose,
  prefillReply,
  resetCompose,
} from '../web/state/composeStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

test('composeModal removes per-post toggle clutter and publishes organically across connected accounts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), method: init?.method || 'GET', body: String(init?.body || '') });
    if (String(url).includes('/api/v1/statuses')) {
      return new Response(JSON.stringify({ id: 'fedi_1', content: '<p>Hi</p>', account: { id: 'a1', acct: 'alice@mastodon.social' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('com.atproto.repo.createRecord')) {
      return new Response(JSON.stringify({ uri: 'at://did:plc:123/app.bsky.feed.post/1', cid: 'cid_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetCompose();

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);

    const ctrl = mountComposeModal(host);
    openCompose({ text: 'Hello open social web' });

    assert.equal(host.querySelector('.compose-targets-row'), null);
    assert.equal(host.querySelector('.compose-cw-row'), null);
    assert.equal(host.querySelector('#compose-visibility-select'), null);
    assert.ok(ctrl.dialog.querySelector('.compose-seamless-textarea'));
    assert.ok(ctrl.dialog.querySelector('.compose-cancel-btn'));
    const addToPostBtn = ctrl.dialog.querySelector('.compose-add-thread-btn');
    assert.ok(addToPostBtn);
    assert.equal(addToPostBtn.textContent, 'Add to post');
    assert.equal(ctrl.dialog.getAttribute('role'), null);
    assert.equal(ctrl.dialog.getAttribute('aria-modal'), null);
    assert.equal(ctrl.dialog.querySelector('.compose-publish-btn')?.textContent, 'Post');

    // Clicking "Add to post" over character limit auto-splits overflow into a follow-up comment
    const longDraft = `${'word '.repeat(110)}overflowPart`;
    openCompose({ text: longDraft });
    addToPostBtn.click();
    assert.equal(ctrl.dialog.querySelector('.compose-sheet-title')?.textContent, 'New post');
    assert.equal(composeStore.get().threadItems.length, 1);
    assert.ok(composeStore.get().text.length <= 500);
    assert.ok(composeStore.get().threadItems[0].text.includes('overflowPart'));
    openCompose({ text: 'Hello open social web', threadItems: [] });

    await upsertSocialAccount(
      {
        id: 'fediverse:alice@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'alice',
        acct: 'alice@mastodon.social',
        displayName: 'Alice',
        userId: '1',
      },
      { accessToken: 'tok_fedi' }
    );
    await upsertSocialAccount(
      {
        id: 'bluesky:did:plc:123',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        did: 'did:plc:123',
        handle: 'alice.bsky.social',
        displayName: 'Alice Bsky',
      },
      { accessJwt: 'jwt_a', refreshJwt: 'jwt_r' }
    );

    const topRes = await publishOrganicPost({ text: 'Broadcast to connected networks' });
    assert.equal(topRes.results.length, 2);
    assert.ok(requests.some((r) => r.url.includes('mastodon.social/api/v1/statuses')));
    assert.ok(requests.some((r) => r.url.includes('com.atproto.repo.createRecord')));

    requests.length = 0;
    const threadRes = await publishOrganicPost({
      text: 'Thread opener',
      threadItems: [{ id: 't1', text: 'Second post in thread' }],
    });
    assert.equal(threadRes.results.length, 4);
    assert.equal(requests.filter((r) => r.url.includes('mastodon.social/api/v1/statuses')).length, 2);
    assert.equal(requests.filter((r) => r.url.includes('com.atproto.repo.createRecord')).length, 2);

    requests.length = 0;
    prefillReply({ id: '99', network: 'fediverse', author: { acct: 'bob@pixelfed.social' } });
    const replyRes = await publishOrganicPost({
      text: composeStore.get().text + 'reply text',
      replyTo: composeStore.get().replyTo,
    });
    assert.equal(replyRes.results.length, 1);
    assert.equal(requests.filter((r) => r.url.includes('createRecord')).length, 0);

    ctrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    authStore.set({ hydrated: false, accounts: [], publicMediaBaseUrl: '' });
    dom.restore();
  }
});

test('UserModal and SettingsModal use classic native <dialog> without ARIA dialog overrides and send expected payloads', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const savedBodies = [];

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === 'POST') {
      savedBodies.push({ url: u, body: String(init.body || '') });
    }
    if (u.includes('/api/user_profiles')) {
      return new Response(JSON.stringify({ profiles: [{ id: 'Davy', filename: 'Davy.txt', content: 'Stoic' }], active: 'Davy' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/models/native/list')) {
      return new Response(
        JSON.stringify({
          gguf_models: [{ filename: 'qwen.gguf', name: 'Qwen 7B', size_gb: 4.5 }],
          active_llm: 'qwen.gguf',
          checkpoints: [{ filename: 'flux.safetensors', name: 'Flux', size_gb: 11.2 }],
          active_checkpoint: 'flux.safetensors',
          workflows: [{ filename: 'portrait.json', name: 'portrait.json', size_kb: 12 }],
          active_workflow: 'portrait.json',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/project_settings')) {
      return new Response(
        JSON.stringify({
          folders: ['/tmp/ws'],
          security_preset: 'ask_always',
          artifact_review_policy: 'ask_always',
          search_engine: 'web_crawling',
          tts_voice: 'af_heart',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/accounts/verify_credentials')) {
      return new Response(
        JSON.stringify({
          id: 'u_fedi_1',
          username: 'alice',
          acct: 'alice@mastodon.social',
          display_name: 'Alice',
          avatar: 'https://mastodon.social/avatar.png',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('graph.threads.net/v1.0/me')) {
      return new Response(
        JSON.stringify({
          id: 'th_999',
          username: 'alice.threads',
          name: 'Alice Threads',
          threads_profile_picture_url: 'https://threads.net/avatar.png',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000', programs: mockMobileHealthOnline.programs });

    const doc = dom.document;

    openUserModal({ initialTab: 'accounts' });
    await new Promise((r) => setTimeout(r, 20));
    const userDialog = doc.getElementById('user-accounts-dialog');
    assert.ok(userDialog);
    assert.equal(userDialog.open, true);
    assert.equal(userDialog.getAttribute('role'), null);
    assert.equal(userDialog.getAttribute('aria-modal'), null);
    assert.equal(userDialog.querySelector('details'), null);
    assert.ok(userDialog.querySelector('#user-fedi-instance'));
    assert.ok(userDialog.querySelector('#user-fedi-token'));
    assert.ok(userDialog.querySelector('#user-bsky-handle'));
    assert.ok(userDialog.querySelector('#user-bsky-pass'));
    assert.ok(userDialog.querySelector('#user-threads-token'));
    assert.equal(userDialog.querySelector('#user-threads-uid'), null);
    assert.equal(userDialog.querySelector('#user-threads-media'), null);

    // Connect Fediverse via @user@instance + token bar
    const fediInst = userDialog.querySelector('#user-fedi-instance');
    const fediTok = userDialog.querySelector('#user-fedi-token');
    const fediForm = fediInst.parentNode.parentNode.parentNode;
    fediInst.value = '@alice@mastodon.social';
    fediTok.value = 'tok_direct_123';
    fediForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(authStore.get().accounts.some((a) => a.platform === 'fediverse' && a.acct === 'alice@mastodon.social'));

    // Connect Threads via single token bar resolving /me automatically
    const thTok = userDialog.querySelector('#user-threads-token');
    const thForm = thTok.parentNode.parentNode;
    thTok.value = 'th_tok_456';
    thForm.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));
    assert.ok(authStore.get().accounts.some((a) => a.platform === 'threads' && a.userId === 'th_999' && a.acct === 'alice.threads'));
    userDialog.close();

    openSettingsModal({ initialTab: 'engine', temperature: 0.9 });
    await new Promise((r) => setTimeout(r, 30));
    const settingsDialog = doc.getElementById('connection-settings-dialog');
    assert.ok(settingsDialog);
    assert.equal(settingsDialog.open, true);
    assert.equal(settingsDialog.getAttribute('role'), null);
    assert.equal(settingsDialog.getAttribute('aria-modal'), null);
    assert.ok(settingsDialog.textContent.includes('Qwen 7B'));

    const modalTabLabels = Array.from(settingsDialog.querySelectorAll('.modal-tab-btn')).map((b) => b.textContent);
    assert.deepEqual(modalTabLabels, ['Models', 'Project Settings', 'Moderation']);

    const projectTabBtn = Array.from(settingsDialog.querySelectorAll('.modal-tab-btn'))
      .find((b) => b.textContent === 'Project Settings');
    assert.ok(projectTabBtn);
    projectTabBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(settingsDialog.textContent.includes('/tmp/ws'));
    assert.ok(settingsDialog.querySelector('#node-url-input'));
    settingsDialog.close();

    await new Promise((r) => setTimeout(r, 15));
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Messages lists all Program chats under Program Chats in Direct and restricts Programs tab to Program management', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const progFixtures = mockMobileHealthOnline.programs.map((p) => ({
    ...p,
    personality: 'Luminous',
    idle_thought: 'Hidden idle message preview',
    last_snippet: 'Should not appear on program card',
  }));
  let activeProgInHealth = 'sebile';
  const createRequests = [];
  const nowSec = Math.floor(Date.now() / 1000);

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/api/sessions/create')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      createRequests.push(body);
      return new Response(
        JSON.stringify({
          status: 'success',
          active_session: 'chat_999',
          session: { id: 'chat_999', title: 'New Chat', snippet: 'Hello again', message_count: 1, updated_at: nowSec },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/mobile/health')) {
      return new Response(JSON.stringify({ ...mockMobileHealthOnline, active_program: activeProgInHealth, programs: progFixtures }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/programs/select') || u.includes('/api/programs')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (body.program_id) activeProgInHealth = body.program_id;
      return new Response(JSON.stringify({ status: 'success', active: activeProgInHealth }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes(`program_id=${progFixtures[1]?.id || 'rin'}`)) {
      return new Response(
        JSON.stringify({
          sessions: [
            { id: 'default', title: 'Rin Primary', snippet: 'Rin session note', message_count: 1, updated_at: nowSec - 30 },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/conversations')) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('chat.bsky.convo.listConvos')) {
      return new Response(JSON.stringify({ convos: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        sessions: [
          { id: 'default', title: 'Primary Chat', snippet: '*I lean closer.* Latest reply.', message_count: 4, updated_at: nowSec },
          { id: 'chat_1', title: 'Theory Notes', snippet: 'You: Discuss dialectic', message_count: 2, updated_at: nowSec - 60 },
        ],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: progFixtures,
    });

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);

    const switched = [];
    const ctrl = mountMessagesScreen(host, {
      initialTab: 'direct',
      onSwitchProgram: (pid, sid) => switched.push({ pid, sid }),
    });
    await new Promise((r) => setTimeout(r, 25));

    // Direct tab displays Program Chats across all Programs + human DM controls (no Program management cards)
    assert.equal(host.querySelector('.convo-row--program'), null);
    assert.equal(host.querySelectorAll('.conversations-header').length, 1);
    assert.equal(host.querySelector('.conversations-header .messages-section-label')?.textContent, 'Program Chats');
    const sessionRows = host.querySelectorAll('.convo-row--session');
    assert.equal(sessionRows.length, 3);
    assert.equal(sessionRows[0].dataset.programId, 'sebile');
    assert.equal(sessionRows[1].dataset.programId, 'rin');
    assert.equal(sessionRows[2].dataset.programId, 'sebile');
    assert.ok(sessionRows[0].querySelector('.convo-snippet em'));
    assert.equal(sessionRows[0].querySelector('.convo-snippet em')?.textContent, 'I lean closer.');
    assert.ok(host.textContent.includes('Rin Primary'));
    assert.ok(host.textContent.includes('Rin session note'));
    assert.ok(host.textContent.includes('Theory Notes'));
    assert.ok(host.textContent.includes('You: Discuss dialectic'));
    assert.equal(host.querySelector('#messages-session-select'), null);
    assert.ok(host.textContent.includes('Connect Mastodon or Bluesky under Profile'));

    // Connecting Mastodon & Bluesky removes the connect prompt even with 0 active DM threads
    await upsertSocialAccount(
      {
        id: 'fedi_msg_test',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'davy',
        acct: 'davy@mastodon.social',
      },
      { accessToken: 'tok_fedi' }
    );
    await upsertSocialAccount(
      {
        id: 'bsky_msg_test',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        did: 'did:plc:davy',
        handle: 'davy.bsky.social',
        acct: 'davy.bsky.social',
      },
      { accessJwt: 'jwt_a', refreshJwt: 'jwt_r' }
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(host.textContent.includes('Connect Mastodon or Bluesky'), false);
    assert.ok(host.textContent.includes('No direct messages yet.'));

    // Clicking Rin's session row in Direct switches directly to Rin
    sessionRows[1].querySelector('.convo-row-main').click();
    assert.equal(switched.length, 1);
    assert.deepEqual(switched[0], { pid: 'rin', sid: 'default' });

    // Selecting Rin in Program picker and clicking New Chat creates a session on Rin
    const progPicker = host.querySelector('.messages-program-picker');
    assert.ok(progPicker);
    progPicker.value = 'rin';
    progPicker.dispatchEvent(new Event('change'));
    const newChatBtn = host.querySelector('[data-action="new-session"]');
    assert.ok(newChatBtn);
    newChatBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(createRequests[createRequests.length - 1]?.program_id, 'rin');
    assert.deepEqual(switched[switched.length - 1], { pid: 'rin', sid: 'chat_999' });

    // Programs tab is strictly for Program management (no session list or New Chat button)
    ctrl.setTab('programs');
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(host.textContent.includes('🎨'), false);
    const progRows = host.querySelectorAll('.convo-row--program');
    assert.equal(progRows.length, progFixtures.length);
    assert.equal(progRows[0].textContent.includes('Should not appear on program card'), false);
    assert.equal(progRows[0].textContent.includes('Hidden idle message preview'), false);
    const progActionBtns = host.querySelectorAll('.convo-row--program .row-icon-btn');
    assert.equal(progActionBtns.length, progFixtures.length * 3);
    assert.ok(Array.from(progActionBtns).every((btn) => btn.innerHTML.includes('<svg')));
    assert.equal(host.querySelector('.convo-row--session'), null);
    assert.equal(host.querySelector('[data-action="new-session"]'), null);

    ctrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Feed & Following render two clean tabs and avoid unauthenticated home timeline calls', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const calledUrls = [];

  globalThis.fetch = async (url) => {
    const u = String(url);
    calledUrls.push(u);
    if (u.includes('/api/v1/trends/statuses')) {
      return new Response(
        JSON.stringify([
          {
            id: 'trend_1',
            content: '<p>Trending open post</p>',
            created_at: new Date().toISOString(),
            account: { id: 'u1', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
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
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    setActiveStream('feed');

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);

    let accountsOpened = false;
    const feedCtrl = mountFeedScreen(host, {
      onOpenAccounts: () => { accountsOpened = true; },
    });

    await new Promise((r) => setTimeout(r, 30));
    const tabBtns = host.querySelectorAll('.feed-stream-tabs .stage-tab-btn');
    assert.equal(tabBtns.length, 2);
    assert.ok(host.textContent.includes('Trending open post'));

    calledUrls.length = 0;
    tabBtns[1].click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(feedStore.get().activeStream, 'following');
    assert.equal(calledUrls.some((u) => u.includes('/timelines/home')), false);
    const connectBtn = host.querySelector('.following-connect-btn');
    assert.ok(connectBtn && connectBtn.textContent.includes('Connect Accounts'));
    connectBtn.click();
    assert.equal(accountsOpened, true);

    feedCtrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('MoodHeart renders authentic emotional telemetry card without raw JSON state dumps', () => {
  const dom = installMockDom();
  try {
    const doc = dom.document;
    const heart = createMoodHeart({ programName: 'Sebile' });
    heart.setMoodMetadata({
      base_color: '#9370db',
      moods: {
        intimate: { emoji: '💜', label: 'Intimate', color: '#ec4899', glow: 'rgba(236,72,153,0.85)' },
      },
    });
    heart.updateMood(
      { name: 'intimate', color: '#ec4899', glow: 'rgba(236,72,153,0.85)', speed: '0.6s', intensity: 0.65 },
      'intimate',
      { active_inversion: 'intimate', inversion_consecutive_turns: 2, mood_tally: { excited: 1 } },
      'Sebile',
      [
        { id: 'p1', role: 'program', text: 'Hello', mood: { name: 'intimate', color: '#ec4899', intensity: 0.65 } },
      ]
    );

    heart.openModal();
    const dlg = doc.getElementById('program-mood-dialog');
    assert.ok(dlg && dlg.open);
    const modalCard = dlg.querySelector('.modal-card');
    assert.notEqual(modalCard.style.background, 'transparent');
    assert.equal(dlg.querySelector('.close-modal-btn')?.hidden, false);
    assert.ok(dlg.textContent.includes('Emotional State & Inversion'));
    assert.ok(dlg.textContent.includes("Sebile's State"));
    assert.ok(dlg.textContent.includes('Intimate'));
    assert.ok(dlg.textContent.includes('65%'));
    assert.ok(dlg.textContent.includes('Inversion Active:'));
    assert.equal(dlg.textContent.includes('inversion_consecutive_turns'), false);
    assert.equal(dlg.querySelectorAll('.mood-trail-dot').length, 5);
    dlg.close();
  } finally {
    dom.restore();
  }
});

test('KnowledgeModal expands/edits Lorebooks and stacked showConfirm preserves parent modal', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const savedLorePayloads = [];

  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/lorebooks') && !u.includes('/entries') && !u.includes('/save')) {
      return new Response(
        JSON.stringify({
          lorebooks: [{ id: 'test.json', filename: 'test.json', name: 'Theory', source: 'file', entry_count: 1 }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/lorebooks/test.json/entries')) {
      return new Response(
        JSON.stringify({
          name: 'Theory',
          entries: [{ name: 'Base Entry', keys: ['dialectic'], content: 'Concrete analysis.', constant: false, enabled: true }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/lorebooks/test.json/save') && init?.method === 'POST') {
      savedLorePayloads.push(JSON.parse(String(init.body || '{}')));
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (u.includes('/api/programs/journals')) {
      return new Response(
        JSON.stringify({
          epic_chronicle: 'Full chronicle summary.',
          recent_chapters: ['Recent chapter 1'],
          journals: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    connectionStore.set({
      mode: 'online',
      activeProgram: 'sebile',
      nodeUrl: 'http://127.0.0.1:5000',
      programs: mockMobileHealthOnline.programs,
    });

    const doc = dom.document;
    const kbModal = openKnowledgeModal({
      programId: 'sebile',
      programName: 'Sebile',
      sessionId: 'default',
      initialTab: 'lorebooks',
    });

    await new Promise((r) => setTimeout(r, 30));
    const kbDialog = doc.getElementById('databank-dialog');
    assert.ok(kbDialog && kbDialog.open);
    assert.equal(kbDialog.getAttribute('closedby'), 'any');
    assert.equal(kbDialog.querySelectorAll('.classic-section-divider').length, 1);

    const toggleBtn = kbDialog.querySelector('.classic-lorebook-toggle');
    assert.ok(toggleBtn);
    toggleBtn.click();
    await new Promise((r) => setTimeout(r, 30));

    const panel = kbDialog.querySelector('.classic-lorebook-panel');
    assert.ok(panel && !panel.hidden);
    const addEntryBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === '+ Add Entry');
    assert.ok(addEntryBtn);
    addEntryBtn.click();
    assert.equal(panel.querySelectorAll('.classic-lore-entry-row').length, 2);

    const saveBtn = Array.from(panel.querySelectorAll('button')).find((b) => b.textContent === 'Save');
    assert.ok(saveBtn);
    saveBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(savedLorePayloads.length, 1);
    assert.equal(savedLorePayloads[0].entries.length, 2);

    // Journals tab separates Full Summary, Recent Summary, and Log Journals with section dividers
    const journalsTabBtn = Array.from(kbDialog.querySelectorAll('.modal-tab-btn')).find((b) => b.textContent === 'Journals');
    assert.ok(journalsTabBtn);
    journalsTabBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(kbDialog.querySelectorAll('.classic-modal-section').length, 1);
    assert.equal(kbDialog.querySelectorAll('.classic-section-divider').length, 2);

    // Stacked confirmation dialog temporarily suspends parent closedby and keeps parent open
    const confirmModal = showConfirm('Confirm Action', 'Proceed?', () => {});
    assert.equal(confirmModal.dialog.open, true);
    assert.equal(kbDialog.getAttribute('closedby'), 'none');
    assert.equal(kbDialog.open, true);
    confirmModal.close();
    assert.equal(kbDialog.getAttribute('closedby'), 'any');
    assert.equal(kbDialog.open, true);

    kbModal.close();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('PostCard Share-to-Program uses distinct send symbol, stages a compact post card, and renders cleanly in chat', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    connectionStore.set({
      mode: 'offline',
      activeProgram: 'sebile',
      programs: mockMobileHealthOnline.programs,
    });

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);

    const samplePost = {
      id: 'post_42',
      network: 'fediverse',
      url: 'https://mastodon.social/@avlcharlie/42',
      author: {
        displayName: 'Asheville Charlie',
        acct: 'avlcharlie@mastodon.social',
        avatar: 'https://mastodon.social/avatar.png',
      },
      text: 'And it was everything I hoped.. #life',
      media: [{ previewUrl: 'https://mastodon.social/thumb.png', description: 'Castle poster', type: 'image' }],
      counts: { likes: 30, replies: 1, reposts: 15 },
      viewerState: {},
    };

    let sharedPayload = null;
    const copiedTexts = [];
    const prevClipboardDesc = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard');
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text) => {
          copiedTexts.push(text);
        },
      },
    });
    const cardEl = createPostCard(samplePost, {
      showSanctuaryAction: true,
      onAskSanctuary: (p) => { sharedPayload = p; },
    });
    const shareBtn = cardEl.querySelector('.post-action-sanctuary');
    assert.ok(shareBtn);
    assert.equal(shareBtn.getAttribute('aria-label'), 'Share to Program');
    const shareSvgMarkup = shareBtn._innerHtml || shareBtn.innerHTML || '';
    assert.ok(shareSvgMarkup.includes('22 2 11 13'));
    shareBtn.click();
    assert.equal(sharedPayload.id, 'post_42');

    // 3-connected-circles share link button copies post URL and announces in outside role="status" tip
    const copyLinkBtn = cardEl.querySelector('.post-action-copy-link');
    assert.ok(copyLinkBtn);
    const copyIconMarkup = copyLinkBtn.querySelector('.post-copy-icon')?.innerHTML || copyLinkBtn.innerHTML || '';
    assert.equal((copyIconMarkup.match(/<circle/g) || []).length, 3);
    const copyTip = copyLinkBtn.nextElementSibling;
    assert.equal(copyTip?.getAttribute('role'), 'status');
    copyLinkBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(copiedTexts, ['https://mastodon.social/@avlcharlie/42']);
    assert.equal(copyLinkBtn.hasAttribute('data-copied'), true);
    assert.ok(copyTip.textContent.startsWith('Copied'));
    if (prevClipboardDesc) Object.defineProperty(globalThis.navigator, 'clipboard', prevClipboardDesc);
    else delete globalThis.navigator.clipboard;

    // Mobile bottom bar omits Sanctuary tab, bottom-left mobile FAB stays independent, and Share-to-Program expands collapsed Sanctuary dock
    const overlay = doc.createElement('div');
    overlay.id = 'chat-loading-overlay';
    doc.body.appendChild(overlay);
    const app = createAppShell(host, { initialTab: 'home', skipBackgroundInit: true });
    assert.equal(host.querySelector('[data-tab="sanctuary"]'), null);
    assert.equal(host.querySelector('.mobile-utility-title')?.textContent, 'Fediverse');
    assert.ok(host.querySelector('.mobile-compose-fab'));
    assert.equal(host.querySelector('.mobile-utility-actions .mobile-compose-fab'), null);
    host.querySelector('.sanctuary-dock-toggle').click();
    assert.equal(host.querySelector('.app-shell-frame').classList.contains('is-sanctuary-collapsed'), true);
    app.sanctuaryCtrl.attachSharedPost(samplePost);
    host.querySelector('.sanctuary-dock-toggle').click();
    assert.equal(host.querySelector('.app-shell-frame').classList.contains('is-sanctuary-collapsed'), false);

    const previewArea = host.querySelector('#preview-area');
    const userInput = host.querySelector('#user-input');
    assert.ok(previewArea && !previewArea.hidden);
    assert.ok(previewArea.querySelector('.shared-post-card.is-composer-preview'));
    assert.equal(userInput.value, '');
    assert.equal(userInput.value.includes('Review this post'), false);

    // Bubble rendering renders compact shared post card + optional user note separately
    const row = buildMessageRow({
      id: 'usr_shared_1',
      role: 'user',
      text: '[Shared post by Asheville Charlie (@avlcharlie@mastodon.social)]\nAnd it was everything I hoped..\n\nThoughts on this?',
      shared_post: {
        authorName: 'Asheville Charlie',
        authorHandle: '@avlcharlie@mastodon.social',
        authorAvatar: 'https://mastodon.social/avatar.png',
        text: 'And it was everything I hoped.. #life',
        mediaUrl: 'https://mastodon.social/thumb.png',
        mediaAlt: 'Castle poster',
        url: 'https://mastodon.social/@avlcharlie/42',
        network: 'fediverse',
      },
      user_note: 'Thoughts on this?',
      timestamp: Date.now() / 1000,
    });
    assert.ok(row.querySelector('.shared-post-card'));
    assert.equal(row.querySelector('.message.user').dataset.rawText, 'Thoughts on this?');
    assert.ok(row.querySelector('.message-text').textContent.includes('Thoughts on this?'));
    assert.equal(row.querySelector('.message-text').textContent.includes('[Shared post by'), false);

    app.destroy();
    await new Promise((r) => setTimeout(r, 15));
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('composeModal simplifies media previews without alt inputs, provides emoji picker, and saves/loads/clears drafts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/api/v2/media')) {
      return new Response(JSON.stringify({ id: 'med_1', url: 'https://mastodon.social/m1.png' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (String(url).includes('/api/v1/statuses')) {
      return new Response(JSON.stringify({ id: 'st_1', content: '<p>Draft sent</p>', account: { id: 'a1', acct: 'alice@mastodon.social' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetCompose();
    await upsertSocialAccount(
      {
        id: 'fediverse:alice@mastodon.social',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        handle: 'alice',
        acct: 'alice@mastodon.social',
        displayName: 'Alice',
        userId: '1',
      },
      { accessToken: 'tok_fedi' }
    );

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const ctrl = mountComposeModal(host);
    openCompose({ text: 'Draft note ' });

    // 1. Simplified image preview has zero alt-text inputs and corner remove works
    const fakeImgBlob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' });
    addMediaAttachment({
      blob: fakeImgBlob,
      url: 'blob:local-preview',
      previewUrl: 'blob:local-preview',
      mimeType: 'image/png',
      source: 'local-file',
    });
    assert.ok(ctrl.dialog.querySelector('.composer-media-strip .composer-media-card.is-single'));
    assert.equal(ctrl.dialog.querySelector('.composer-alt-input'), null);
    assert.equal(ctrl.dialog.textContent.includes('Alt description'), false);
    const remBtn = ctrl.dialog.querySelector('.composer-media-remove');
    assert.ok(remBtn);
    remBtn.click();
    assert.equal(composeStore.get().mediaAttachments.length, 0);

    // Re-attach media and add thread item for draft roundtrip
    addMediaAttachment({
      blob: fakeImgBlob,
      url: 'blob:local-preview-2',
      previewUrl: 'blob:local-preview-2',
      mimeType: 'image/png',
      source: 'local-file',
    });
    addThreadItem('Follow-up draft line');

    // 2. Emoji picker sits next to Attach Media, searches keywords, and inserts emoji at caret
    const emojiBtn = ctrl.dialog.querySelector('.compose-emoji-btn');
    assert.ok(emojiBtn);
    assert.equal(emojiBtn.getAttribute('aria-haspopup'), null);
    emojiBtn.click();
    const popover = ctrl.dialog.querySelector('.emoji-picker-popover');
    assert.ok(popover && !popover.hidden);
    const searchIn = popover.querySelector('.emoji-picker-search');
    assert.equal(searchIn.getAttribute('autocorrect'), 'off');
    assert.equal(searchIn.getAttribute('autocapitalize'), 'none');
    assert.equal(searchIn.getAttribute('spellcheck'), 'false');
    searchIn.value = 'fire';
    searchIn.dispatchEvent(new Event('input', { bubbles: true }));
    const cells = [...popover.querySelectorAll('.emoji-picker-cell')];
    const fireCell = cells.find((c) => c.textContent === '🔥');
    assert.ok(fireCell);
    fireCell.click();
    assert.ok(composeStore.get().text.includes('🔥'));
    assert.equal(popover.hidden, true);

    // 3. Each "Save draft" click snapshots a new draft without overwriting older drafts; loading + saving adds a third, and publishing removes only the active snapshot
    const mainTextarea = ctrl.dialog.querySelector('#compose-main-textarea');
    const saveDraftBtn = ctrl.dialog.querySelector('.compose-draft-btn');
    assert.ok(saveDraftBtn);
    saveDraftBtn.click();
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(ctrl.dialog.open, true);
    assert.equal(ctrl.dialog.querySelector('.compose-status-msg').textContent, 'Draft saved.');
    assert.equal(ctrl.dialog.querySelector('.compose-drafts-toggle-btn').textContent, 'Drafts (1)');
    assert.ok(composeStore.get().text.includes('Draft note '));
    const afterFirstSave = await listComposeDrafts();
    assert.equal(afterFirstSave.length, 1);

    mainTextarea.value = `${composeStore.get().text} snapshot-2`;
    mainTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    saveDraftBtn.click();
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(ctrl.dialog.querySelector('.compose-drafts-toggle-btn').textContent, 'Drafts (2)');
    const afterSecondSave = await listComposeDrafts();
    assert.equal(afterSecondSave.length, 2);
    assert.notEqual(afterSecondSave[0].id, afterFirstSave[0].id);
    assert.ok(afterSecondSave[0].text.includes('snapshot-2'));
    assert.equal(afterSecondSave[1].text.includes('snapshot-2'), false);

    ctrl.dialog.querySelector('.compose-cancel-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(ctrl.dialog.open, false);
    assert.equal(composeStore.get().text, '');

    openCompose();
    await new Promise((r) => setTimeout(r, 25));
    const draftsToggle = ctrl.dialog.querySelector('.compose-drafts-toggle-btn');
    assert.equal(draftsToggle.textContent, 'Drafts (2)');
    draftsToggle.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(ctrl.dialog.querySelector('.compose-sheet-title').textContent, 'Drafts');
    const composeBody = ctrl.dialog.querySelector('.compose-sheet-body');
    Object.defineProperty(mainTextarea, 'scrollHeight', {
      get: () => (composeBody.hidden ? 0 : 220),
      configurable: true,
    });

    const draftSelectBtns = [...ctrl.dialog.querySelectorAll('.compose-draft-select-btn')];
    assert.equal(draftSelectBtns.length, 2);
    assert.ok(draftSelectBtns[1].querySelector('.compose-draft-thumb'));
    draftSelectBtns[1].click();
    assert.equal(mainTextarea.style.height, '220px');

    const restored = composeStore.get();
    assert.ok(restored.text.includes('Draft note '));
    assert.ok(restored.text.includes('🔥'));
    assert.equal(restored.text.includes('snapshot-2'), false);
    assert.equal(restored.threadItems.length, 1);
    assert.equal(restored.mediaAttachments.length, 1);
    assert.ok(restored.mediaAttachments[0].blob instanceof Blob);

    mainTextarea.value = `${restored.text} snapshot-3`;
    mainTextarea.dispatchEvent(new Event('input', { bubbles: true }));
    saveDraftBtn.click();
    await new Promise((r) => setTimeout(r, 35));
    assert.equal(ctrl.dialog.querySelector('.compose-drafts-toggle-btn').textContent, 'Drafts (3)');
    assert.equal((await listComposeDrafts()).length, 3);

    ctrl.dialog.querySelector('.compose-publish-btn').click();
    await new Promise((r) => setTimeout(r, 45));
    const remainingAfterPublish = await listComposeDrafts();
    assert.equal(remainingAfterPublish.length, 2);
    assert.equal(remainingAfterPublish.some((d) => d.text.includes('snapshot-3')), false);
    assert.equal(remainingAfterPublish.some((d) => d.text.includes('snapshot-2')), true);
    ctrl.destroy();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('feed infinite scroll, DOM stability across health/token updates, and single-line author header truncation', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let mastoHomeCalls = 0;
  const bskyCursors = [];

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/api/v1/lists') || u.includes('/api/v1/filters')) {
      return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.includes('/api/v1/timelines/home')) {
      mastoHomeCalls += 1;
      return new Response(
        JSON.stringify([
          {
            id: 'm_1',
            created_at: '2026-11-19T02:00:00Z',
            content: '<p>Mastodon page one post</p>',
            account: { id: 'a1', username: 'mpeer', acct: 'mpeer@mastodon.social', display_name: 'Mastodon Peer', avatar: '' },
            media_attachments: [],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/xrpc/app.bsky.feed.getTimeline')) {
      const parsed = new URL(u);
      const cursor = parsed.searchParams.get('cursor') || '';
      bskyCursors.push(cursor);
      if (!cursor) {
        return new Response(
          JSON.stringify({
            cursor: 'bsky_page2',
            feed: [
              {
                post: {
                  uri: 'at://did:plc:b1/app.bsky.feed.post/1',
                  cid: 'cid_b1',
                  author: { did: 'did:plc:b1', handle: 'b1.bsky.social', displayName: 'Bluesky Page One' },
                  record: { text: 'Bluesky page one post', createdAt: '2026-11-19T01:55:00Z' },
                },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          feed: [
            {
              post: {
                uri: 'at://did:plc:b2/app.bsky.feed.post/2',
                cid: 'cid_b2',
                author: { did: 'did:plc:b2', handle: 'b2.bsky.social', displayName: 'Bluesky Page Two' },
                record: { text: 'Bluesky page two post', createdAt: '2026-11-19T02:30:00Z' },
              },
            },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(JSON.stringify({}), { status: 404 });
  };

  let feedCtrl = null;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
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
        id: 'bluesky:did:plc:u',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        handle: 'u.bsky.social',
        acct: 'u.bsky.social',
        did: 'did:plc:u',
      },
      { accessJwt: 'b_jwt', refreshJwt: 'b_ref' }
    );

    setActiveStream('following');
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);

    feedCtrl = mountFeedScreen(host, {});
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(host.textContent.includes('Load Older Posts'), false);
    assert.equal(mastoHomeCalls, 1);
    assert.deepEqual(bskyCursors, ['']);

    const firstCardBefore = host.querySelector('article.post-card[data-post-id="mastodon:m_1"]');
    assert.ok(firstCardBefore);

    // Health tick & token refresh must not replace/flash existing post cards in DOM
    connectionStore.set({ lastCheckedAt: Date.now(), gpuMode: 'llm' });
    await updateAccountTokens('bluesky:did:plc:u', { accessJwt: 'b_jwt_2', refreshJwt: 'b_ref_2' });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(host.querySelector('article.post-card[data-post-id="mastodon:m_1"]'), firstCardBefore);
    assert.equal(mastoHomeCalls, 1);

    // Clicking Following again does NOT trigger an automatic refresh
    host.querySelector('.stage-tab-btn[data-stream="following"]').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(mastoHomeCalls, 1);

    // Near-bottom scroll triggers infinite append without re-fetching exhausted Mastodon cursor
    host.scrollHeight = 900;
    host.clientHeight = 500;
    host.scrollTop = 450;
    host.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(mastoHomeCalls, 1);
    assert.deepEqual(bskyCursors, ['', 'bsky_page2']);
    assert.equal(host.querySelector('article.post-card[data-post-id="mastodon:m_1"]'), firstCardBefore);
    const renderedIds = Array.from(host.querySelectorAll('article.post-card')).map((el) => el.dataset.postId);
    assert.deepEqual(renderedIds, [
      'mastodon:m_1',
      'bluesky:at://did:plc:b1/app.bsky.feed.post/1',
      'bluesky:at://did:plc:b2/app.bsky.feed.post/2',
    ]);

    // Explicit refresh button next to Following triggers a manual refresh
    const refreshBtn = host.querySelector('.feed-stream-tabs .feed-refresh-btn');
    assert.ok(refreshBtn);
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mastoHomeCalls, 2);

    // Pull-down gesture at scrollTop === 0 also refreshes manually (horizontal swipe does not)
    host.scrollTop = 0;
    const horizStart = new Event('touchstart');
    horizStart.touches = [{ clientX: 40, clientY: 100 }];
    host.dispatchEvent(horizStart);
    const horizEnd = new Event('touchend');
    horizEnd.changedTouches = [{ clientX: 220, clientY: 180 }];
    host.dispatchEvent(horizEnd);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(mastoHomeCalls, 2);

    const pullStart = new Event('touchstart');
    pullStart.touches = [{ clientX: 120, clientY: 80 }];
    host.dispatchEvent(pullStart);
    const pullEnd = new Event('touchend');
    pullEnd.changedTouches = [{ clientX: 124, clientY: 185 }];
    host.dispatchEvent(pullEnd);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(mastoHomeCalls, 3);

    // Single-line author header & boost banner markup keeps untruncated full text in DOM
    const longAuthorCard = createPostCard(
      {
        id: 'bluesky:at://did:plc:long/app.bsky.feed.post/9',
        protocol: 'bluesky',
        content_html: '<p>Long author header test</p>',
        content_text: 'Long author header test',
        date_published: '2026-11-19T01:00:00Z',
        author: {
          id: 'did:plc:long',
          name: 'Jaime Novembernickname Christl Very Long Name',
          handle: 'rohmersimpson.verylonghandle.bsky.social',
        },
        _meta: {
          bluesky: {
            uri: 'at://did:plc:long/app.bsky.feed.post/9',
            rebloggedBy: {
              id: 'did:plc:booster',
              name: 'Booster With An Exceedingly Long Display Name',
              handle: 'booster.bsky.social',
            },
          },
        },
      },
      { onSelectAuthor: () => {} }
    );
    assert.equal(
      longAuthorCard.querySelector('.post-author-name').textContent,
      'Jaime Novembernickname Christl Very Long Name'
    );
    assert.equal(
      longAuthorCard.querySelector('.post-author-handle').textContent,
      '@rohmersimpson.verylonghandle.bsky.social'
    );
    assert.ok(longAuthorCard.querySelector('.post-author-row .post-time'));
    assert.equal(
      longAuthorCard.querySelector('.post-reblog-banner .post-reblog-author-btn').textContent,
      'Booster With An Exceedingly Long Display Name'
    );
  } finally {
    feedCtrl?.destroy();
    setActiveStream('feed');
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Multi-image PostCard renders accessible carousel and opens social images in shared classic lightbox viewer', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    let threadOpenCount = 0;
    const postCard = createPostCard(
      {
        id: 'bluesky:at://did:plc:gallery/app.bsky.feed.post/1',
        protocol: 'bluesky',
        content_html: '<p>Magnum behind the scenes</p>',
        content_text: 'Magnum behind the scenes',
        date_published: '2026-11-19T02:00:00Z',
        author: {
          id: 'did:plc:gallery',
          name: 'Michael Warburton',
          handle: 'michaelwarburton.bsky.social',
        },
        attachments: [
          { type: 'image', url: 'https://cdn.example/img-1.jpg', previewUrl: 'https://cdn.example/thumb-1.jpg', description: 'First photo' },
          { type: 'image', url: 'https://cdn.example/img-2.jpg', previewUrl: 'https://cdn.example/thumb-2.jpg', description: 'Second photo' },
          { type: 'image', url: 'https://cdn.example/img-3.jpg', previewUrl: 'https://cdn.example/thumb-3.jpg', description: 'Third photo' },
          { type: 'image', url: 'https://cdn.example/img-4.jpg', previewUrl: 'https://cdn.example/thumb-4.jpg', description: 'Fourth photo' },
        ],
      },
      { onOpenThread: () => { threadOpenCount += 1; } }
    );
    dom.document.body.appendChild(postCard);

    const carousel = postCard.querySelector('.post-media-carousel');
    assert.ok(carousel);
    assert.equal(carousel.getAttribute('aria-roledescription'), 'carousel');
    const viewport = carousel.querySelector('.post-carousel-viewport');
    assert.ok(viewport.children[0].classList.contains('post-carousel-controls'));
    const track = carousel.querySelector('.post-carousel-track');
    assert.equal(track.getAttribute('tabindex'), '0');
    const slides = carousel.querySelectorAll('.post-carousel-slide');
    assert.equal(slides.length, 4);
    assert.equal(slides[1].getAttribute('aria-label'), '2 of 4');

    const prevBtn = carousel.querySelector('.post-carousel-prev');
    const nextBtn = carousel.querySelector('.post-carousel-next');
    const counter = carousel.querySelector('.post-carousel-counter');
    const status = carousel.querySelector('.post-carousel-status');
    const dots = carousel.querySelectorAll('.post-carousel-dot');

    assert.equal(counter.textContent, '1 / 4');
    assert.equal(prevBtn.disabled, true);
    assert.equal(nextBtn.disabled, false);
    assert.equal(status.textContent, '');
    assert.equal(dots.length, 4);
    assert.equal(dots[0].getAttribute('aria-current'), 'true');
    assert.equal(dots[1].getAttribute('aria-current'), null);

    // Next arrow advances carousel without navigating thread
    nextBtn.click();
    assert.equal(threadOpenCount, 0);
    assert.equal(counter.textContent, '2 / 4');
    assert.equal(prevBtn.disabled, false);
    assert.equal(dots[0].getAttribute('aria-current'), null);
    assert.equal(dots[1].getAttribute('aria-current'), 'true');
    assert.equal(status.textContent, 'Image 2 of 4');

    // Focusing Next and advancing to final slide disables Next and redirects focus to Previous
    dots[2].click();
    assert.equal(counter.textContent, '3 / 4');
    nextBtn.focus();
    assert.equal(dom.document.activeElement, nextBtn);
    nextBtn.click();
    assert.equal(counter.textContent, '4 / 4');
    assert.equal(nextBtn.disabled, true);
    assert.equal(dom.document.activeElement, prevBtn);

    // Clicking slide 2 opens classic shared lightbox viewer at full-res img-2 without Sanctuary API calls
    const slide2Btn = slides[1].querySelector('.post-media-thumb-btn');
    assert.ok(slide2Btn);
    slide2Btn.click();
    assert.equal(threadOpenCount, 0);

    const viewer = dom.document.getElementById('sanctuary-lightbox-dialog');
    assert.ok(viewer && viewer.open);
    assert.ok(viewer.classList.contains('classic-image-viewer-dialog'));
    assert.equal(viewer.querySelector('.gallery-actions').hidden, true);
    const modalImg = viewer.querySelector('#modal-img');
    assert.equal(modalImg.src, 'https://cdn.example/img-2.jpg');

    viewer.querySelector('.next-btn').click();
    assert.equal(modalImg.src, 'https://cdn.example/img-3.jpg');
    viewer.querySelector('.close-modal').click();
    assert.equal(dom.document.getElementById('sanctuary-lightbox-dialog'), null);
    assert.equal(fetchedUrls.some((u) => u.includes('/api/list_images')), false);

    // Shared-from-feed embed card image also opens shared classic lightbox viewer
    const sharedCard = createSharedPostEmbedCard({
      author: { name: 'Alice', handle: 'alice.bsky.social' },
      text: 'Shared art',
      attachments: [
        { type: 'image', url: 'https://cdn.example/shared-1.jpg', previewUrl: 'https://cdn.example/shared-thumb-1.jpg', description: 'Shared 1' },
        { type: 'image', url: 'https://cdn.example/shared-2.jpg', previewUrl: 'https://cdn.example/shared-thumb-2.jpg', description: 'Shared 2' },
      ],
      url: 'https://bsky.app/profile/alice/post/1',
    });
    dom.document.body.appendChild(sharedCard);
    const sharedThumbBtn = sharedCard.querySelector('.shared-post-thumb-btn');
    assert.ok(sharedThumbBtn);
    sharedThumbBtn.click();
    const sharedViewer = dom.document.getElementById('sanctuary-lightbox-dialog');
    assert.ok(sharedViewer && sharedViewer.open);
    assert.equal(sharedViewer.querySelector('.gallery-actions').hidden, true);
    assert.equal(sharedViewer.querySelector('#modal-img').src, 'https://cdn.example/shared-1.jpg');
    sharedViewer.querySelector('.next-btn').click();
    assert.equal(sharedViewer.querySelector('#modal-img').src, 'https://cdn.example/shared-2.jpg');
    sharedViewer.close();
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});
