import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mockMobileHealthOnline } from '../__mocks__/mockProgram.js';
import { BlueskyAdapter } from '../web/adapters/bluesky/index.js';
import { createAppShell } from '../web/app/_layout.js';
import { mountActivityScreen } from '../web/app/activity.js';
import { mountBrowserScreen } from '../web/app/browser.js';
import { mountComposeModal, publishOrganicPost } from '../web/app/composeModal.js';
import { mountFeedScreen } from '../web/app/feed.js';
import { mountMessagesScreen } from '../web/app/messages.js';
import { renderPostThreadView } from '../web/app/postThread.js';
import { mountProfileScreen } from '../web/app/profile.js';
import { mountProgramThread } from '../web/app/programThread.js';
import { createPostCard, parseSocialPostItemFromUrl } from '../web/components/PostCard.js';
import { attachSearchSuggestions } from '../web/components/SearchSuggestions.js';
import { openKnowledgeModal } from '../web/components/sanctuary/KnowledgeModal.js';
import { buildMessageRow, createSharedPostEmbedCard } from '../web/components/sanctuary/MessageRow.js';
import { createMoodHeart } from '../web/components/sanctuary/MoodHeart.js';
import { showConfirm } from '../web/components/sanctuary/SanctuaryDialog.js';
import { openSettingsModal } from '../web/components/sanctuary/SettingsModal.js';
import { openUserModal } from '../web/components/sanctuary/UserModal.js';
import { deduplicateUnifiedItems, toUnifiedItem } from '../web/core/schema/unifiedItem.js';
import { resolveMentionFacets } from '../web/queries/bluesky.js';
import { likeUnified, publishUnified } from '../web/queries/socialClient.js';
import { activityStore, hydrateActivityStore, resetActivityStoreForTests } from '../web/state/activityStore.js';
import { browserStore, navigateBrowserTab, resetBrowserStoreForTests } from '../web/state/browserStore.js';
import {
  applyViewerInteractionsToItem,
  feedStore,
  resetFeedStoreForTests,
  setActiveStream,
  setStreamItems,
} from '../web/state/feedStore.js';
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
import { resetSessionStoreForTests } from '../web/state/sanctuary/sessionModel.js';
import { kvSet, resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

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
    if (u.includes('/api/openhands/server')) {
      return new Response(
        JSON.stringify({
          running: false,
          port: 8091,
          openai_base_url: 'http://127.0.0.1:8091/v1',
          model_id: 'openhands_greenpt',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.includes('/api/project_settings')) {
      return new Response(
        JSON.stringify({
          folders: ['/tmp/ws'],
          security_preset: 'ask_always',
          artifact_review_policy: 'ask_always',
          greenpt_api_key: '',
          greenpt_base_url: 'https://api.greenpt.ai/v1',
          openhands_model: 'glm-5.3',
          openhands_mode: 'cli',
          openhands_server_port: 8091,
          openhands_auto_start_server: false,
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
    assert.deepEqual(modalTabLabels, ['Models', 'Project', 'Moderation']);

    const projectTabBtn = Array.from(settingsDialog.querySelectorAll('.modal-tab-btn'))
      .find((b) => b.textContent === 'Project');
    assert.ok(projectTabBtn);
    projectTabBtn.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(settingsDialog.textContent.includes('/tmp/ws'));
    assert.ok(settingsDialog.querySelector('#node-url-input'));
    assert.equal(settingsDialog.querySelector('#project-gemini-api-key'), null);
    const apiKeyInput = settingsDialog.querySelector('#project-greenpt-api-key');
    const baseUrlInput = settingsDialog.querySelector('#project-greenpt-base-url');
    const modelInput = settingsDialog.querySelector('#project-openhands-model');
    const modeSelect = settingsDialog.querySelector('#project-openhands-mode');
    assert.ok(apiKeyInput && baseUrlInput && modelInput && modeSelect);
    assert.equal(apiKeyInput.type, 'password');

    apiKeyInput.value = 'sk_greenpt_test_saved_key';
    apiKeyInput.dispatchEvent(new Event('change'));
    baseUrlInput.value = 'https://api.us.greenpt.ai/v1';
    baseUrlInput.dispatchEvent(new Event('change'));
    modelInput.value = 'glm-5.3-flash';
    modelInput.dispatchEvent(new Event('change'));
    modeSelect.value = 'server';
    modeSelect.dispatchEvent(new Event('change'));
    await new Promise((r) => setTimeout(r, 25));

    const projectBodies = savedBodies
      .filter((b) => b.url.includes('/api/project_settings'))
      .map((b) => JSON.parse(b.body));
    assert.ok(projectBodies.some((p) => p.greenpt_api_key === 'sk_greenpt_test_saved_key'));
    assert.ok(projectBodies.some((p) => p.greenpt_base_url === 'https://api.us.greenpt.ai/v1'));
    assert.ok(projectBodies.some((p) => p.openhands_model === 'glm-5.3-flash'));
    assert.ok(
      projectBodies.some(
        (p) => p.openhands_mode === 'server' && !Object.prototype.hasOwnProperty.call(p, 'greenpt_api_key')
      )
    );

    // Typing a new key without firing 'change' flushes on modal close
    apiKeyInput.value = 'sk_greenpt_flush_on_close';
    apiKeyInput.dispatchEvent(new Event('input'));
    settingsDialog.close();

    await new Promise((r) => setTimeout(r, 15));
    const flushedBodies = savedBodies
      .filter((b) => b.url.includes('/api/project_settings'))
      .map((b) => JSON.parse(b.body));
    assert.ok(flushedBodies.some((p) => p.greenpt_api_key === 'sk_greenpt_flush_on_close'));
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
            account: { id: 'u1', acct: 'alice@kolektiva.social', display_name: 'Alice', avatar: '' },
            media_attachments: [],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (u.includes('/api/v1/timelines/tag/')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
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
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    feedStore.set({
      tuning: {
        version: 2,
        updatedAt: 0,
        updatedBy: 'default',
        discoveryChannels: [],
        discoveryInstances: ['mastodon.world'],
      },
    });
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
    assert.equal(tabBtns.length, 4);
    assert.deepEqual(Array.from(tabBtns).map((b) => b.textContent), ['Feed', 'Following', 'Photos', 'Video']);
    assert.ok(host.textContent.includes('Trending open post'));
    assert.equal(calledUrls.some((u) => u.includes('/api/v1/timelines/tag/')), false);

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

    // Legacy / rerolled message without shared_post dict recovers card + user note from formatted text
    const recoveredRow = buildMessageRow({
      id: 'usr_shared_legacy_1',
      role: 'user',
      text: '[Shared post by Rev Mike (@mike@social.thegreens.uk)]\nSelf-hosting my own corner of the Fediverse!\n\nThis was Mike\'s original message.\n\nSecond paragraph.',
      timestamp: Date.now() / 1000,
    });
    assert.ok(recoveredRow.querySelector('.shared-post-card'));
    assert.equal(recoveredRow.querySelector('.shared-post-author').textContent, 'Rev Mike');
    assert.equal(recoveredRow.querySelector('.shared-post-handle').textContent, '@mike@social.thegreens.uk');
    assert.equal(recoveredRow.querySelector('.shared-post-text').textContent, 'Self-hosting my own corner of the Fediverse!');
    assert.equal(
      recoveredRow.querySelector('.message.user').dataset.rawText,
      "This was Mike's original message.\n\nSecond paragraph."
    );
    assert.equal(recoveredRow.querySelector('.message-text').textContent.includes('[Shared post by'), false);

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
    resetSessionStoreForTests();
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

test('Single, 2-up pair, and 3+ image PostCards preserve full aspect ratio height, uniform sizing, and carousel navigation', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const fetchedUrls = [];
  globalThis.fetch = async (url) => {
    fetchedUrls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) };
  };

  try {
    // 1. Single portrait image preserves full aspect ratio without carousel or cover crop
    const singleCard = createPostCard({
      id: 'mastodon:single_portrait',
      protocol: 'mastodon',
      content_html: '<p>Full portrait art</p>',
      content_text: 'Full portrait art',
      date_published: '2026-11-19T01:00:00Z',
      author: { id: 'a1', name: 'Painter', handle: 'painter@mastodon.social' },
      attachments: [
        { type: 'image', url: 'https://cdn.example/full-portrait.jpg', previewUrl: 'https://cdn.example/small-portrait.jpg', description: 'Portrait painting', width: 900, height: 1200 },
      ],
    });
    const singleWrap = singleCard.querySelector('.post-media-single');
    assert.ok(singleWrap);
    assert.equal(singleCard.querySelector('.post-media-carousel'), null);
    assert.equal(singleWrap.dataset.hasRatio, 'true');
    assert.equal(singleWrap.dataset.portrait, 'true');
    assert.equal(singleWrap.style.getPropertyValue('--media-ratio'), '0.7500');
    assert.equal(singleWrap.style.getPropertyValue('--media-aspect'), '900 / 1200');
    const singleImg = singleWrap.querySelector('img.post-media-item');
    assert.equal(singleImg.src, 'https://cdn.example/full-portrait.jpg');
    assert.equal(singleImg.getAttribute('width'), '900');
    assert.equal(singleImg.getAttribute('height'), '1200');

    // Landscape and square single images do not set data-portrait
    for (const [label, w, h] of [
      ['landscape', 1600, 900],
      ['square', 1000, 1000],
    ]) {
      const nonPortraitCard = createPostCard({
        id: `mastodon:single_${label}`,
        protocol: 'mastodon',
        content_html: `<p>${label}</p>`,
        date_published: '2026-11-19T01:05:00Z',
        author: { id: `a_${label}`, name: 'Shooter', handle: 'shooter@mastodon.social' },
        attachments: [
          { type: 'image', url: `https://cdn.example/${label}.jpg`, width: w, height: h },
        ],
      });
      const wrap = nonPortraitCard.querySelector('.post-media-single');
      assert.equal(wrap.dataset.hasRatio, 'true');
      assert.equal(wrap.dataset.portrait, undefined, `${label} single image must not set portrait flag`);
    }

    // Verify shell.css defines uniform 320px feed media cap and 175% single-portrait cap (images + videos) without 16/10 or cover crops
    const shellCssPath = new URL('../web/assets/css/shell.css', import.meta.url);
    const fs = await import('node:fs');
    const shellCss = fs.readFileSync(shellCssPath, 'utf8');
    assert.ok(shellCss.includes('--feed-media-max-h: 320px;'));
    assert.ok(shellCss.includes('.post-media-single[data-portrait="true"]:not(.has-audio)'));
    assert.ok(shellCss.includes('calc(var(--feed-media-max-h, 320px) * 1.75)'));
    const mediaBlockMatch = shellCss.match(/\.post-media-single\s*\{[\s\S]*?\.post-media-audio\s*\{[^}]*\}/);
    assert.ok(mediaBlockMatch);
    assert.equal(mediaBlockMatch[0].includes('aspect-ratio: 16 / 10'), false);
    assert.equal(mediaBlockMatch[0].includes('object-fit: cover'), false);
    assert.equal(mediaBlockMatch[0].includes('object-fit: contain'), true);
    assert.equal(mediaBlockMatch[0].includes('var(--feed-media-max-h, 320px)'), true);
    const videoRuleMatch = mediaBlockMatch[0].match(/\.post-media-video\s*\{[^}]*\}/);
    assert.ok(videoRuleMatch);
    assert.equal(videoRuleMatch[0].includes('inline-size: 100%'), false);
    const slideItemMatch = mediaBlockMatch[0].match(/\.post-carousel-slide \.post-media-item\s*\{[^}]*\}/);
    assert.ok(slideItemMatch);
    assert.equal(slideItemMatch[0].includes('inline-size: auto;'), true);
    assert.equal(slideItemMatch[0].includes('block-size: 100%;'), true);
    const slideRuleMatch = mediaBlockMatch[0].match(/\.post-carousel-slide\s*\{[^}]*\}/);
    assert.ok(slideRuleMatch);
    assert.equal(slideRuleMatch[0].includes('max-inline-size: 100%'), false);

    // Single portrait video (576 x 1024), landscape video (1280 x 720), dimensionless portrait video, and Shorts embed
    const portraitVideoCard = createPostCard({
      id: 'bluesky:at://did:plc:hockey/app.bsky.feed.post/v_portrait',
      protocol: 'bluesky',
      content_text: 'Faceoffs vs Possession portrait clip',
      date_published: '2026-11-20T07:50:00Z',
      author: { id: 'did:plc:hockey', name: 'Flying Mitts Hockey', handle: 'flyingmittshockey.bsky.social' },
      attachments: [
        { type: 'video', mime_type: 'video/mp4', url: 'https://cdn.example/portrait.mp4', width: 576, height: 1024 },
      ],
    });
    const pvWrap = portraitVideoCard.querySelector('.post-media-single.has-video');
    assert.ok(pvWrap);
    assert.equal(pvWrap.dataset.hasRatio, 'true');
    assert.equal(pvWrap.dataset.portrait, 'true');
    assert.equal(pvWrap.style.getPropertyValue('--media-ratio'), '0.5625');
    assert.equal(pvWrap.style.getPropertyValue('--media-aspect'), '576 / 1024');

    const landscapeVideoCard = createPostCard({
      id: 'mastodon:v_landscape',
      protocol: 'mastodon',
      content_html: '<p>Landscape clip</p>',
      date_published: '2026-11-20T07:51:00Z',
      author: { id: 'a_vid', name: 'Videographer', handle: 'vid@mastodon.social' },
      attachments: [
        { type: 'video', mime_type: 'video/mp4', url: 'https://cdn.example/wide.mp4', width: 1280, height: 720 },
      ],
    });
    const lvWrap = landscapeVideoCard.querySelector('.post-media-single.has-video');
    assert.ok(lvWrap);
    assert.equal(lvWrap.dataset.hasRatio, 'true');
    assert.equal(lvWrap.dataset.portrait, undefined);

    const dimlessVideoCard = createPostCard({
      id: 'mastodon:v_dimless',
      protocol: 'mastodon',
      content_html: '<p>Dimensionless clip</p>',
      date_published: '2026-11-20T07:52:00Z',
      author: { id: 'a_vid2', name: 'ScannerVideo', handle: 'svid@mastodon.social' },
      attachments: [
        { type: 'video', mime_type: 'video/mp4', url: 'https://cdn.example/dimless.mp4' },
      ],
    });
    const dvWrap = dimlessVideoCard.querySelector('.post-media-single.has-video');
    const dvEl = dvWrap.querySelector('video.post-media-video');
    assert.equal(dvWrap.dataset.hasRatio, undefined);
    dvEl.videoWidth = 540;
    dvEl.videoHeight = 960;
    dvEl.dispatchEvent(new Event('loadedmetadata'));
    assert.equal(dvWrap.dataset.hasRatio, 'true');
    assert.equal(dvWrap.dataset.portrait, 'true');
    assert.equal(dvWrap.style.getPropertyValue('--media-ratio'), '0.5625');
    assert.equal(dvWrap.style.getPropertyValue('--media-aspect'), '540 / 960');

    const shortsCard = createPostCard({
      id: 'bluesky:at://did:plc:hockey/app.bsky.feed.post/shorts1',
      protocol: 'bluesky',
      content_text: 'Watch https://www.youtube.com/shorts/EoQR59d45Pw',
      date_published: '2026-11-20T07:53:00Z',
      author: { id: 'did:plc:hockey', name: 'Flying Mitts Hockey', handle: 'flyingmittshockey.bsky.social' },
      attachments: [],
      _meta: {},
    });
    assert.equal(shortsCard.querySelector('.post-embed-card')?.dataset?.portrait, 'true');

    // Dimensionless single image resolves aspect ratio, portrait flag, and data-loaded="true" on load
    const dimlessCard = createPostCard({
      id: 'mastodon:dimless_single',
      protocol: 'mastodon',
      content_html: '<p>Dimensionless paper scan</p>',
      content_text: 'Dimensionless paper scan',
      date_published: '2026-11-19T01:10:00Z',
      author: { id: 'a1b', name: 'Scanner', handle: 'scanner@mastodon.social' },
      attachments: [
        { type: 'image', url: 'https://cdn.example/paper-scan.jpg', description: 'Paper scan' },
      ],
    });
    const dimlessWrap = dimlessCard.querySelector('.post-media-single');
    const dimlessImg = dimlessWrap.querySelector('img.post-media-item');
    assert.equal(dimlessWrap.dataset.hasRatio, undefined);
    dimlessImg.naturalWidth = 650;
    dimlessImg.naturalHeight = 1000;
    dimlessImg.dispatchEvent(new Event('load'));
    assert.equal(dimlessImg.dataset.loaded, 'true');
    assert.equal(dimlessWrap.dataset.hasRatio, 'true');
    assert.equal(dimlessWrap.dataset.portrait, 'true');
    assert.equal(dimlessWrap.style.getPropertyValue('--media-ratio'), '0.6500');
    assert.equal(dimlessWrap.style.getPropertyValue('--media-aspect'), '650 / 1000');

    // 2. Exactly 2 images render as uniform-height side-by-side pair (not carousel)
    const pairCard = createPostCard({
      id: 'mastodon:pair_photos',
      protocol: 'mastodon',
      content_html: '<p>Two mixed aspect photos</p>',
      content_text: 'Two mixed aspect photos',
      date_published: '2026-11-19T01:30:00Z',
      author: { id: 'a2', name: 'Shooter', handle: 'shooter@mastodon.social' },
      attachments: [
        { type: 'image', url: 'https://cdn.example/pair-1.jpg', previewUrl: 'https://cdn.example/pair-thumb-1.jpg', description: 'Pair one', width: 800, height: 1000 },
        { type: 'image', url: 'https://cdn.example/pair-2.jpg', previewUrl: 'https://cdn.example/pair-thumb-2.jpg', description: 'Pair two', width: 1200, height: 800 },
      ],
    });
    dom.document.body.appendChild(pairCard);
    const pairEl = pairCard.querySelector('.post-media-pair.post-media-count-2');
    assert.ok(pairEl);
    assert.equal(pairCard.querySelector('.post-media-carousel'), null);
    assert.equal(pairEl.dataset.hasRatios, 'true');
    assert.equal(pairEl.style.getPropertyValue('--pair-ratio-sum'), '2.3000');
    const pairSlots = pairEl.querySelectorAll('.post-media-pair-slot');
    assert.equal(pairSlots.length, 2);
    assert.equal(pairSlots[0].style.getPropertyValue('--slot-aspect'), '800 / 1000');
    assert.equal(pairSlots[1].style.getPropertyValue('--slot-aspect'), '1200 / 800');
    pairSlots[1].querySelector('.post-media-thumb-btn').click();
    const pairViewer = dom.document.getElementById('sanctuary-lightbox-dialog');
    assert.ok(pairViewer && pairViewer.open);
    assert.equal(pairViewer.querySelector('#modal-img').src, 'https://cdn.example/pair-2.jpg');
    pairViewer.close();

    // 3. More than two images (>2) render accessible uniform-height scrolling carousel + lightbox
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
          { type: 'image', url: 'https://cdn.example/img-1.jpg', previewUrl: 'https://cdn.example/thumb-1.jpg', description: 'First photo', width: 800, height: 1000 },
          { type: 'image', url: 'https://cdn.example/img-2.jpg', previewUrl: 'https://cdn.example/thumb-2.jpg', description: 'Second photo', width: 1600, height: 1000 },
          { type: 'image', url: 'https://cdn.example/img-3.jpg', previewUrl: 'https://cdn.example/thumb-3.jpg', description: 'Third photo', width: 1000, height: 1000 },
          { type: 'image', url: 'https://cdn.example/img-4.jpg', previewUrl: 'https://cdn.example/thumb-4.jpg', description: 'Fourth photo', width: 900, height: 1200 },
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
    assert.equal(track.style.getPropertyValue('--max-slide-ratio'), '');
    const slides = carousel.querySelectorAll('.post-carousel-slide');
    assert.equal(slides.length, 4);
    assert.equal(slides[1].getAttribute('aria-label'), '2 of 4');
    assert.equal(slides[0].style.getPropertyValue('--slide-aspect'), '800 / 1000');
    assert.equal(slides[1].style.getPropertyValue('--slide-aspect'), '1600 / 1000');

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

    // Variable-width slide tracking clamps to maxScroll and resolves end slide on scroll
    slides[0].offsetLeft = 0;
    slides[1].offsetLeft = 240;
    slides[2].offsetLeft = 700;
    slides[3].offsetLeft = 980;
    track.clientWidth = 460;
    track.scrollWidth = 1220;
    const scrolledLefts = [];
    track.scrollTo = ({ left }) => {
      scrolledLefts.push(left);
      track.scrollLeft = left;
      track.dispatchEvent(new Event('scrollend'));
    };
    dots[0].click();
    assert.equal(scrolledLefts.at(-1), 0);
    assert.equal(counter.textContent, '1 / 4');
    dots[3].click();
    assert.equal(scrolledLefts.at(-1), 760);
    assert.equal(counter.textContent, '4 / 4');

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

    // Terminal tool log summary skips leading `cd <workspace>;` boilerplate
    const termRow = buildMessageRow({
      id: 'prgm_term_cd_1',
      role: 'program',
      text: 'Checked feed.',
      tool_calls: [
        {
          type: 'call',
          id: 'tc_cd_1',
          name: 'openhands:terminal',
          args: { command: 'cd C:\\LLM\\LM-Sanctuary; git grep -n "feed"' },
        },
        {
          type: 'response',
          id: 'tc_cd_1',
          name: 'openhands:terminal',
          response: 'web/app/feed.js:1:...',
        },
      ],
      timestamp: Date.now() / 1000,
    });
    const termTarget = termRow.querySelector('.ag-log-target')?.textContent || '';
    assert.equal(termTarget.includes('git grep'), true, termTarget);
    assert.equal(termTarget.includes('cd C:\\LLM\\LM-Sanctuary'), false, termTarget);
  } finally {
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('ComposeModal renders original parent message when replying and clears stale reply state on close/new post', async () => {
  const { closeCompose, openCompose } = await import('../web/state/composeStore.js');
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

  try {
    resetCompose();
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const ctrl = mountComposeModal(host);

    prefillReply({
      id: 'mastodon:orig_42',
      protocol: 'mastodon',
      content_text: 'Original post asking for feedback on cooperative infrastructure.',
      date_published: '2026-11-23T07:00:00.000Z',
      author: {
        id: 'u_mike',
        name: 'Rev Mike',
        handle: 'mike@social.thegreens.uk',
        avatar_url: 'https://cdn.example/mike.png',
      },
      _meta: { mastodon: { statusId: 'orig_42', instanceUrl: 'https://mastodon.social' } },
    });

    const banner = host.querySelector('.compose-reply-banner');
    assert.equal(banner.hidden, false);
    assert.ok(banner.querySelector('.compose-reply-label')?.textContent.includes('Replying to @mike@social.thegreens.uk'));
    assert.ok(banner.querySelector('.post-reply-context-text')?.textContent.includes('Original post asking for feedback'));
    assert.equal(host.querySelector('.compose-publish-btn')?.textContent, 'Reply');

    // Closing the modal clears replyTo and untouched mention prefix so next openCompose({}) is standalone
    closeCompose();
    assert.equal(composeStore.get().replyTo, null);
    assert.equal(composeStore.get().text, '');

    openCompose({});
    assert.equal(host.querySelector('.compose-reply-banner').hidden, true);
    assert.equal(host.querySelector('.compose-publish-btn')?.textContent, 'Post');

    // Clicking the inline clear button detaches a reply back to standalone New post
    prefillReply({
      id: 'bluesky:at://did:plc:x/app.bsky.feed.post/1',
      protocol: 'bluesky',
      content_text: 'Original Bluesky message',
      author: { id: 'did:plc:x', name: 'Alice', handle: 'alice.bsky.social' },
      _meta: { bluesky: { uri: 'at://did:plc:x/app.bsky.feed.post/1', cid: 'cid1' } },
    });
    assert.equal(host.querySelector('.compose-reply-banner').hidden, false);
    host.querySelector('.compose-reply-clear-btn').click();
    assert.equal(composeStore.get().replyTo, null);
    assert.equal(host.querySelector('.compose-reply-banner').hidden, true);
    assert.equal(host.querySelector('.compose-publish-btn')?.textContent, 'Post');

    ctrl.destroy();
  } finally {
    resetCompose();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Activity refresh icon button dismisses prior New badges and highlights newly arrived notifications', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  let round = 1;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fedi_act_1',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
      },
      { accessToken: 'masto_tok' }
    );

    await kvSet('activity_last_seen_ts_v1', Date.parse('2026-11-23T10:00:00.000Z'));
    const notif1 = {
      id: 'n1',
      type: 'mention',
      created_at: '2026-11-23T10:05:00.000Z',
      account: { id: 'a1', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
      status: {
        id: 'st_1',
        content: '<p>First mention</p>',
        created_at: '2026-11-23T10:05:00.000Z',
        account: { id: 'a1', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
      },
    };
    const notif2 = {
      id: 'n2',
      type: 'mention',
      created_at: '2026-11-23T10:15:00.000Z',
      account: { id: 'a2', acct: 'bob@mastodon.social', display_name: 'Bob', avatar: '' },
      status: {
        id: 'st_2',
        content: '<p>Newer mention</p>',
        created_at: '2026-11-23T10:15:00.000Z',
        account: { id: 'a2', acct: 'bob@mastodon.social', display_name: 'Bob', avatar: '' },
      },
    };

    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/v1/notifications')) {
        return new Response(JSON.stringify(round === 1 ? [notif1] : [notif2, notif1]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await hydrateActivityStore();
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const actCtrl = mountActivityScreen(host);
    await new Promise((r) => setTimeout(r, 40));

    const refreshBtn = host.querySelector('.stage-title-group .feed-refresh-btn.activity-refresh-btn');
    assert.ok(refreshBtn, 'Activity header must render the circular icon refresh button');
    assert.equal(host.querySelectorAll('.activity-row.is-unread').length, 1);
    assert.equal(host.querySelectorAll('.activity-new-badge').length, 1);

    // Clicking Refresh with no newer notifications dismisses "New"
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(host.querySelectorAll('.activity-row.is-unread').length, 0);
    assert.equal(host.querySelectorAll('.activity-new-badge').length, 0);

    // Wait for 550ms minimum spin to finish, then refresh with a newer notification arriving
    await new Promise((r) => setTimeout(r, 560));
    round = 2;
    refreshBtn.click();
    await new Promise((r) => setTimeout(r, 40));
    const unreadRows = host.querySelectorAll('.activity-row.is-unread');
    assert.equal(unreadRows.length, 1);
    assert.ok(unreadRows[0].textContent.includes('Bob'));

    const actionLabels = Array.from(unreadRows[0].querySelectorAll('.activity-action-item')).map((b) => b.textContent);
    assert.ok(actionLabels.includes('Delete notification'), 'Single notification uses singular Delete notification label');
    assert.equal(actionLabels.some((t) => t.includes('Delete notifications (2)')), false);

    actCtrl.destroy();
  } finally {
    resetActivityStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Composer uses compact bridge note, offers @mention typeahead, and linkifies @handle.tld across Bluesky & Mastodon', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetCompose();

    await upsertSocialAccount(
      {
        id: 'fedi_act_1',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
      },
      { accessToken: 'masto_tok' }
    );
    await upsertSocialAccount(
      {
        id: 'bsky_comp_1',
        platform: 'bluesky',
        serviceUrl: 'https://pds.example.social',
        did: 'did:plc:me123',
        handle: 'davy.bsky.social',
      },
      { accessJwt: 'jwt_1', refreshJwt: 'ref_1' }
    );

    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('app.bsky.actor.searchActors')) {
        return new Response(
          JSON.stringify({
            actors: [
              { did: 'did:plc:socnyc', handle: 'socialists.nyc', displayName: 'NYC Socialists', avatar: '' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      if (u.includes('/api/v2/search')) {
        return new Response(JSON.stringify({ accounts: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('com.atproto.identity.resolveHandle')) {
        if (u.startsWith('https://pds.example.social')) {
          return new Response(JSON.stringify({ error: 'InvalidRequest' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ did: 'did:plc:socnyc' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('com.atproto.repo.createRecord')) {
        return new Response(JSON.stringify({ uri: 'at://did:plc:me123/app.bsky.feed.post/p1', cid: 'cid_p1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/v1/statuses')) {
        return new Response(
          JSON.stringify({
            id: 'masto_1',
            content: '<p>Hello @socialists.nyc today</p>',
            created_at: '2026-11-23T12:00:00.000Z',
            account: { id: 'a1', acct: 'davy@mastodon.social', display_name: 'Davy' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const ctrl = mountComposeModal(host);
    openCompose({ text: 'x'.repeat(315) });

    const statusLine = host.querySelector('.compose-status-msg');
    assert.equal(statusLine?.textContent, 'Auto-splits on bridges');
    assert.equal(statusLine?.classList.contains('is-info'), true);

    // Typeahead triggers on @soc
    const textarea = host.querySelector('#compose-main-textarea');
    textarea.value = 'Hello @soc';
    textarea.selectionStart = 10;
    textarea.selectionEnd = 10;
    textarea.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 230));

    const opt = host.querySelector('.compose-mention-option');
    assert.ok(opt, 'Mention autocomplete option must render');
    assert.ok(opt.textContent.includes('@socialists.nyc'));

    // resolveMentionFacets falls back to public.api.bsky.app when PDS fails
    const resolved = await resolveMentionFacets(
      [{ index: { byteStart: 6, byteEnd: 21 }, features: [{ $type: 'app.bsky.richtext.facet#mention', did: '' }], _handle: 'socialists.nyc' }],
      { serviceUrl: 'https://pds.example.social' }
    );
    assert.equal(resolved.length, 1);
    assert.equal(resolved[0].features[0].did, 'did:plc:socnyc');

    // BlueskyAdapter.publish passes resolved facets into content_html
    const bskyAdapter = new BlueskyAdapter({
      serviceUrl: 'https://pds.example.social',
      did: 'did:plc:me123',
      handle: 'davy.bsky.social',
      accessJwt: 'jwt_1',
      refreshJwt: 'ref_1',
    });
    const bskyPub = await bskyAdapter.publish('Hello @socialists.nyc');
    assert.ok(bskyPub.content_html.includes('href="https://bsky.app/profile/did%3Aplc%3Asocnyc"'));

    // publishUnified enriches unlinked Mastodon HTML with resolved Bluesky DID mention link
    const uni = await publishUnified({ text: 'Hello @socialists.nyc today' });
    const card = createPostCard(uni.results[0]);
    const mentionLink = card.querySelector('.post-body-html a.mention');
    assert.ok(mentionLink, 'Canonical Mastodon post card must render clickable @socialists.nyc mention link');
    assert.equal(mentionLink.getAttribute('href'), 'https://bsky.app/profile/did%3Aplc%3Asocnyc');
    assert.equal(mentionLink.textContent, '@socialists.nyc');

    ctrl.destroy();
  } finally {
    resetCompose();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('SearchSuggestions dropdown uses solid opaque background and proper browser controls stacking', async () => {
  const { readFileSync } = await import('node:fs');
  const shellCss = readFileSync(new URL('../web/assets/css/shell.css', import.meta.url), 'utf8');
  assert.match(shellCss, /\.search-suggest-dropdown\s*\{[^}]*background-color:\s*#18171f/s);
  assert.match(shellCss, /\.browser-controls-row\s*\{[^}]*position:\s*relative;[^}]*z-index:\s*30;/s);

  const dom = installMockDom();
  try {
    const doc = dom.document;
    const form = doc.createElement('form');
    const input = doc.createElement('input');
    form.appendChild(input);
    doc.body.appendChild(form);

    const openEvents = [];
    const ctrl = attachSearchSuggestions(input, {
      anchorEl: form,
      getLocalSuggestions: (q) => (q ? [{ kind: 'search', label: `Result for ${q}`, value: q }] : []),
      onOpenChange: (open) => openEvents.push(open),
    });

    input.value = 'o';
    input.dispatchEvent(new Event('input'));
    assert.equal(form.classList.contains('is-suggest-open'), true);
    assert.deepEqual(openEvents, [true]);

    ctrl.close();
    assert.equal(form.classList.contains('is-suggest-open'), false);
    assert.deepEqual(openEvents, [true, false]);
    ctrl.destroy();
  } finally {
    dom.restore();
  }
});

test('Privacy Shield popover groups sections cleanly, omits "zero", and clears browser history', async () => {
  const dom = installMockDom();
  const prevHost = globalThis.sanctuaryBrowserHost;
  let hostClearCalls = 0;
  globalThis.sanctuaryBrowserHost = {
    loadTab: () => {},
    closeTab: () => {},
    syncLayout: () => {},
    onEvent: () => () => {},
    clearHistory: async () => {
      hostClearCalls += 1;
      return { cleared: true };
    },
  };
  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetBrowserStoreForTests();

    const doc = dom.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const ctrl = mountBrowserScreen(host);

    const tabId = browserStore.get().activeTabId;
    navigateBrowserTab(tabId, 'https://example.org/a');
    navigateBrowserTab(tabId, 'https://example.org/b');
    assert.equal(browserStore.get().tabs.find((t) => t.id === tabId).history.length, 3);

    const shieldBtn = host.querySelector('.browser-shield-btn');
    assert.ok(shieldBtn);
    shieldBtn.click();

    const popover = host.querySelector('#browser-shield-popover');
    assert.ok(popover);
    assert.equal(popover.querySelectorAll('.browser-popover-section').length, 3);
    assert.equal(popover.textContent.toLowerCase().includes('zero'), false);

    const clearBtn = popover.querySelector('.browser-clear-history-btn');
    assert.ok(clearBtn);
    assert.equal(clearBtn.textContent, 'Clear History');
    clearBtn.click();
    await new Promise((r) => setTimeout(r, 20));

    const updatedTab = browserStore.get().tabs.find((t) => t.id === tabId);
    assert.deepEqual(updatedTab.history, ['https://example.org/b']);
    assert.equal(updatedTab.historyIndex, 0);
    assert.equal(hostClearCalls, 1);
    assert.equal(popover.querySelector('.browser-history-status')?.textContent, 'History cleared');

    ctrl.destroy();
  } finally {
    resetBrowserStoreForTests();
    globalThis.sanctuaryBrowserHost = prevHost;
    dom.restore();
  }
});

test('Profile screen paginates older posts on scroll while preserving existing card DOM and enriching cross-post metrics', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const maxIdsSeen = [];

  const makeMastoStatus = (idx) => ({
    id: `m_${1000 - idx}`,
    created_at: new Date(Date.parse('2026-11-23T12:00:00.000Z') - idx * 3600000).toISOString(),
    content: `<p>Profile post #${idx}</p>`,
    url: `https://mastodon.social/@davy/${1000 - idx}`,
    favourites_count: idx,
    reblogs_count: 1,
    replies_count: 0,
    account: {
      id: 'u_prof_1',
      acct: 'davy@mastodon.social',
      username: 'davy',
      display_name: 'Davy',
      avatar: '',
    },
  });

  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();

    const jsonRes = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      if (u.includes('/api/v1/accounts/verify_credentials')) {
        return jsonRes({ id: 'u_prof_1', username: 'davy', acct: 'davy@mastodon.social', display_name: 'Davy' });
      }
      if (u.includes('/api/v1/accounts/u_prof_1/statuses')) {
        const parsed = new URL(u);
        if (parsed.searchParams.get('pinned') === 'true') {
          return jsonRes([]);
        }
        const maxId = parsed.searchParams.get('max_id') || '';
        maxIdsSeen.push(maxId);
        if (!maxId) {
          const page1 = Array.from({ length: 20 }, (_, i) => makeMastoStatus(i));
          return jsonRes(page1);
        }
        if (maxId === 'm_981') {
          return jsonRes([makeMastoStatus(20), makeMastoStatus(21)]);
        }
        return jsonRes([]);
      }
      if (u.includes('app.bsky.feed.getAuthorFeed')) {
        return jsonRes({ feed: [], cursor: '' });
      }
      if (u.includes('app.bsky.actor.getProfile')) {
        return jsonRes({ did: 'did:plc:prof1', handle: 'davy.bsky.social' });
      }
      if (u.includes('/api/social/linked-posts')) {
        if ((init.method || 'GET').toUpperCase() === 'GET') {
          return jsonRes({
            links: [
              {
                canonicalId: 'mastodon:m_980',
                mastodonStatusId: 'm_980',
                blueskyUri: 'at://did:plc:prof1/app.bsky.feed.post/older980',
              },
            ],
          });
        }
        return jsonRes({ ok: true });
      }
      if (u.includes('app.bsky.feed.getPosts')) {
        return jsonRes({
          posts: [
            {
              uri: 'at://did:plc:prof1/app.bsky.feed.post/older980',
              likeCount: 9,
              repostCount: 2,
              replyCount: 1,
              record: { text: 'Profile post #20' },
              author: { did: 'did:plc:prof1', handle: 'davy.bsky.social' },
            },
          ],
        });
      }
      return jsonRes({});
    };

    await upsertSocialAccount(
      {
        id: 'fedi_prof_1',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        handle: 'davy',
        displayName: 'Davy',
        userId: 'u_prof_1',
      },
      { accessToken: 'masto_tok' }
    );
    await upsertSocialAccount(
      {
        id: 'bsky_prof_1',
        platform: 'bluesky',
        serviceUrl: 'https://bsky.social',
        did: 'did:plc:prof1',
        handle: 'davy.bsky.social',
        acct: 'davy.bsky.social',
      },
      { accessJwt: 'bsky_jwt' }
    );
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });

    const scrollWrap = dom.document.createElement('div');
    scrollWrap.className = 'center-column-wrap';
    const host = dom.document.createElement('div');
    scrollWrap.appendChild(host);
    dom.document.body.appendChild(scrollWrap);

    const profCtrl = mountProfileScreen(host);
    await new Promise((r) => setTimeout(r, 40));

    const firstCards = Array.from(host.querySelectorAll('.profile-posts-list article'));
    assert.equal(firstCards.length, 20);
    const card0Ref = firstCards[0];

    scrollWrap.scrollHeight = 2000;
    scrollWrap.clientHeight = 700;
    scrollWrap.scrollTop = 1200;
    scrollWrap.dispatchEvent(new Event('scroll'));
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(maxIdsSeen.includes('m_981'), 'Scroll near bottom requests page 2 with max_id=m_981');
    const allCards = Array.from(host.querySelectorAll('.profile-posts-list article'));
    assert.equal(allCards.length, 22);
    assert.equal(allCards[0], card0Ref, 'Existing profile post DOM node preserved on append');
    assert.ok(allCards[20].textContent.includes('Profile post #20'));

    profCtrl.destroy();
  } finally {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('Liked posts never read as 0 likes across async Mastodon counter lag, deduplication, viewer overlay, and resonance chips', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fedi_like_1',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        handle: 'davy',
        userId: 'u_like_1',
      },
      { accessToken: 'masto_tok' }
    );

    const remotePost = toUnifiedItem({
      id: 'mastodon:st_remote_1',
      protocol: 'mastodon',
      url: 'https://goose.directory/@FrogAndToadBot/1',
      content_text: 'Toad went back to bed.',
      date_published: '2026-11-23T10:00:00.000Z',
      author: { id: 'a_frog', name: 'Frog & Toad Bot', handle: 'FrogAndToadBot@goose.directory' },
      metrics: { likes: 0, replies: 1, reposts: 36 },
      _meta: { mastodon: { statusId: 'st_remote_1', instanceUrl: 'https://goose.directory' } },
    });
    setStreamItems('feed', [remotePost]);

    // Mastodon /favourite often returns favourites_count: 0 before async Sidekiq counter updates
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/api/v2/search')) {
        return new Response(JSON.stringify({ statuses: [{ id: 'st_local_resolved' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/api/v1/statuses/st_local_resolved/favourite')) {
        return new Response(
          JSON.stringify({
            id: 'st_local_resolved',
            url: 'https://goose.directory/@FrogAndToadBot/1',
            created_at: '2026-11-23T10:00:00.000Z',
            content: '<p>Toad went back to bed.</p>',
            favourited: true,
            favourites_count: 0,
            replies_count: 1,
            reblogs_count: 36,
            account: { id: 'a_frog', acct: 'FrogAndToadBot@goose.directory', display_name: 'Frog & Toad Bot' },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const updated = await likeUnified(remotePost);
    assert.equal(updated._meta.mastodon.favourited, true);
    assert.equal(updated.metrics.likes, 1);
    assert.equal(feedStore.get().streams.feed.items[0].metrics.likes, 1);

    // toUnifiedItem & applyViewerInteractionsToItem enforce likes >= 1 whenever liked
    const zeroFloor = toUnifiedItem({
      id: 'mastodon:st_zero',
      protocol: 'mastodon',
      date_published: '2026-11-23T10:00:00.000Z',
      metrics: { likes: 0, replies: 0, reposts: 0 },
      _meta: { mastodon: { statusId: 'st_zero', favourited: true } },
    });
    assert.equal(zeroFloor.metrics.likes, 1);

    const overlaid = applyViewerInteractionsToItem({
      id: 'mastodon:st_remote_1',
      protocol: 'mastodon',
      date_published: '2026-11-23T10:00:00.000Z',
      metrics: { likes: 0, replies: 1, reposts: 36 },
      _meta: { mastodon: { statusId: 'st_remote_1' } },
    });
    assert.equal(overlaid._meta.mastodon.favourited, true);
    assert.equal(overlaid.metrics.likes, 1);

    // deduplicateUnifiedItems keeps max metric across duplicate copies
    const deduped = deduplicateUnifiedItems([
      {
        id: 'mastodon:dup1',
        protocol: 'mastodon',
        date_published: '2026-11-23T10:00:00.000Z',
        content_text: 'Same post across sources',
        metrics: { likes: 0, replies: 0, reposts: 0 },
        _meta: { mastodon: { statusId: 'dup1' } },
      },
      {
        id: 'mastodon:dup1',
        protocol: 'mastodon',
        date_published: '2026-11-23T10:00:00.000Z',
        content_text: 'Same post across sources',
        metrics: { likes: 4, replies: 1, reposts: 2 },
        _meta: { mastodon: { statusId: 'dup1', favourited: true } },
      },
    ]);
    assert.equal(deduped[0].metrics.likes, 4);

    // Multi-network PostCard shows primary protocol total immediately before background enrichment
    const linkedCard = createPostCard({
      id: 'mastodon:m_cross_1',
      protocol: 'mastodon',
      date_published: '2026-11-23T10:00:00.000Z',
      content_text: 'Cross-posted item',
      author: { id: 'u1', name: 'Davy', handle: 'davy@mastodon.social' },
      metrics: { likes: 1, replies: 1, reposts: 36 },
      _meta: {
        mastodon: { statusId: 'm_cross_1', favourited: true },
        linkedIds: { mastodonStatusId: 'm_cross_1', blueskyUri: 'at://did:plc:x/app.bsky.feed.post/1' },
      },
    });
    assert.equal(linkedCard.querySelector('.post-resonance-chip--mastodon')?.dataset.networkTotal, '38');
  } finally {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('quoted post cards on focal posts and social post URLs open in-app instead of browser', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();

    const parsedBsky = parseSocialPostItemFromUrl('https://bsky.app/profile/junlper.beer/post/3labc123', {
      authorName: 'union person',
      text: 'the economy is fake',
    });
    assert.equal(parsedBsky.protocol, 'bluesky');
    assert.equal(parsedBsky._meta.bluesky.uri, 'at://junlper.beer/app.bsky.feed.post/3labc123');

    const parsedMasto = parseSocialPostItemFromUrl('https://mastodon.social/@alice/114000123');
    assert.equal(parsedMasto.protocol, 'mastodon');
    assert.equal(parsedMasto._meta.mastodon.statusId, '114000123');
    assert.equal(parsedMasto._meta.mastodon.instanceUrl, 'https://mastodon.social');

    const requestedUris = [];
    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('app.bsky.feed.getPostThread')) {
        const u = new URL(s);
        const reqUri = u.searchParams.get('uri') || '';
        requestedUris.push(reqUri);
        const isQuoted = reqUri.includes('quotedrkey');
        return new Response(JSON.stringify({
          thread: {
            post: {
              uri: reqUri,
              cid: isQuoted ? 'cid_quoted' : 'cid_outer',
              author: {
                did: isQuoted ? 'did:plc:quoted' : 'did:plc:outer',
                handle: isQuoted ? 'junlper.beer' : 'madmarxfury.bsky.social',
                displayName: isQuoted ? 'union person' : 'Mad Marx',
              },
              record: {
                text: isQuoted ? 'the economy is fake' : 'Fake economy',
                createdAt: '2026-11-23T12:00:00.000Z',
              },
              ...(isQuoted ? {} : {
                embed: {
                  $type: 'app.bsky.embed.record#view',
                  record: {
                    $type: 'app.bsky.embed.record#viewRecord',
                    uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedrkey',
                    cid: 'cid_quoted',
                    author: {
                      did: 'did:plc:quoted',
                      handle: 'junlper.beer',
                      displayName: 'union person',
                    },
                    value: {
                      text: 'the economy is fake',
                      createdAt: '2026-11-23T11:55:00.000Z',
                    },
                  },
                },
              }),
            },
          },
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const focalPost = toUnifiedItem({
      id: 'bluesky:at://did:plc:outer/app.bsky.feed.post/outerrkey',
      protocol: 'bluesky',
      url: 'https://bsky.app/profile/madmarxfury.bsky.social/post/outerrkey',
      content_text: 'Fake economy',
      date_published: '2026-11-23T12:00:00.000Z',
      author: { id: 'did:plc:outer', name: 'Mad Marx', handle: 'madmarxfury.bsky.social' },
      _meta: {
        bluesky: { uri: 'at://did:plc:outer/app.bsky.feed.post/outerrkey', cid: 'cid_outer' },
        quotePost: {
          id: 'bluesky:at://did:plc:quoted/app.bsky.feed.post/quotedrkey',
          protocol: 'bluesky',
          uri: 'at://did:plc:quoted/app.bsky.feed.post/quotedrkey',
          cid: 'cid_quoted',
          authorDid: 'did:plc:quoted',
          authorName: 'union person',
          authorHandle: 'junlper.beer',
          text: 'the economy is fake',
          url: 'https://bsky.app/profile/junlper.beer/post/quotedrkey',
        },
      },
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    renderPostThreadView(host, { post: focalPost });
    await new Promise((r) => setTimeout(r, 20));

    const quoteEl = host.querySelector('.thread-focal .post-quote-card');
    assert.ok(quoteEl);
    assert.equal(quoteEl.tagName, 'BUTTON');

    quoteEl.click();
    await new Promise((r) => setTimeout(r, 20));

    assert.ok(requestedUris.includes('at://did:plc:quoted/app.bsky.feed.post/quotedrkey'));
    assert.match(host.querySelector('.thread-focal')?.textContent || '', /union person/);

    // Back button returns to the outer focal post
    host.querySelector('.thread-stage-header .edit-cancel-btn')?.click();
    await new Promise((r) => setTimeout(r, 10));
    assert.match(host.querySelector('.thread-focal')?.textContent || '', /Mad Marx/);
  } finally {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('programThread speak button shows loading/playing indicator and prevents overlapping audio on double press', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  const prevAudio = globalThis.Audio;
  try {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();

    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'nova',
      programs: [{ id: 'nova', name: 'Nova' }],
    });

    let resolveTts = null;
    let ttsCalls = 0;
    const audioInstances = [];
    globalThis.Audio = class MockAudio {
      constructor(src) {
        this.src = src;
        this.paused = false;
        this.playCount = 0;
        this.onended = null;
        this.onerror = null;
        audioInstances.push(this);
      }
      pause() {
        this.paused = true;
      }
      async play() {
        this.playCount += 1;
      }
    };

    globalThis.fetch = async (url) => {
      const s = String(url);
      if (s.includes('/history')) {
        return new Response(JSON.stringify({
          active_program: 'nova',
          character_name: 'Nova',
          history: [
            { id: 'm_prog_1', role: 'program', sender_id: 'nova', text: 'Hello from Nova', timestamp: 1700000000 },
          ],
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (s.includes('/api/tts')) {
        ttsCalls += 1;
        return await new Promise((resolve) => {
          resolveTts = () => resolve(new Response(JSON.stringify({
            audio_url: '/speech_cache/nova_1.wav',
          }), { status: 200, headers: { 'content-type': 'application/json' } }));
        });
      }
      return new Response(JSON.stringify({ models: [], programs: [{ id: 'nova', name: 'Nova' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const handle = mountProgramThread(host, { programId: 'nova', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 25));

    const speakBtn = host.querySelector('.speak-btn');
    const bubble = speakBtn.closest('.message');
    assert.ok(speakBtn);

    // 1. First click while TTS is synthesizing -> immediate loading state
    speakBtn.click();
    assert.equal(ttsCalls, 1);
    assert.equal(speakBtn.classList.contains('is-loading'), true);
    assert.equal(speakBtn.getAttribute('aria-busy'), 'true');
    assert.equal(bubble.classList.contains('is-tts-active'), true);

    // 2. Second click during in-flight synthesis -> cancels cleanly without firing a 2nd request or playing late audio
    speakBtn.click();
    assert.equal(ttsCalls, 1);
    assert.equal(speakBtn.classList.contains('is-loading'), false);
    assert.equal(speakBtn.classList.contains('is-speaking'), false);
    assert.equal(bubble.classList.contains('is-tts-active'), false);
    resolveTts?.();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(audioInstances.length, 0);

    // 3. Single click -> resolves to playing state; clicking again pauses audio and resets UI
    speakBtn.click();
    assert.equal(ttsCalls, 2);
    assert.equal(speakBtn.classList.contains('is-loading'), true);
    resolveTts?.();
    await new Promise((r) => setTimeout(r, 15));

    assert.equal(audioInstances.length, 1);
    assert.equal(audioInstances[0].playCount, 1);
    assert.equal(speakBtn.classList.contains('is-loading'), false);
    assert.equal(speakBtn.classList.contains('is-speaking'), true);
    assert.equal(speakBtn.getAttribute('aria-pressed'), 'true');

    speakBtn.click();
    assert.equal(audioInstances[0].paused, true);
    assert.equal(speakBtn.classList.contains('is-speaking'), false);
    assert.equal(bubble.classList.contains('is-tts-active'), false);

    handle.destroy();
  } finally {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    globalThis.Audio = prevAudio;
    dom.restore();
  }
});

test('Project Settings places Credential Vault at the top, creates/unlocks .kdbx vault, and locks cleanly', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();

    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
    });

    let vaultInitialized = false;
    let vaultUnlocked = false;
    const logins = [];
    const apiKeys = [];
    globalThis.fetch = async (url, init = {}) => {
      const s = String(url);
      if (s.includes('/api/keepassxc/status')) {
        return new Response(JSON.stringify({
          provider: 'sanctuary-kdbx',
          installed: true,
          running: true,
          initialized: vaultInitialized,
          associated: vaultInitialized,
          database_unlocked: vaultUnlocked,
          version: 'KDBX 4.0',
          entry_count: logins.length,
          vault_mode: vaultInitialized ? 'keepassxc' : 'local',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (s.includes('/api/keepassxc/setup')) {
        vaultInitialized = true;
        vaultUnlocked = true;
        return new Response(JSON.stringify({
          provider: 'sanctuary-kdbx',
          installed: true,
          running: true,
          initialized: true,
          associated: true,
          database_unlocked: true,
          version: 'KDBX 4.0',
          entry_count: 0,
          vault_mode: 'keepassxc',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (s.includes('/api/keepassxc/entries')) {
        return new Response(JSON.stringify({
          entries: logins.map((l) => ({
            uuid: l.uuid,
            title: l.title || l.name,
            name: l.title || l.name,
            login: l.login,
            url: l.url,
            group: l.group || 'Browser Logins',
            notes_preview: l.notes || '',
            kind: 'login',
          })),
          groups: ['Browser Logins', 'API Keys'],
          logins,
          api_keys: apiKeys,
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (s.includes('/api/keepassxc/entry')) {
        const body = JSON.parse(init.body || '{}');
        const found = logins.find((l) => l.uuid === body.uuid) || logins[0];
        return new Response(JSON.stringify({ entry: found }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (s.includes('/api/keepassxc/save-entry')) {
        const body = JSON.parse(init.body || '{}');
        const existing = body.uuid ? logins.find((l) => l.uuid === body.uuid) : null;
        if (existing) {
          Object.assign(existing, body, { name: body.title || body.login });
          return new Response(JSON.stringify({ saved: true, entry: existing }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        const created = {
          uuid: `u_${logins.length + 1}`,
          title: body.title || 'bsky.app',
          name: body.title || 'bsky.app',
          login: body.login,
          password: body.password || '',
          url: body.url || '',
          group: body.group || 'Browser Logins',
          notes: body.notes || '',
          kind: body.kind || 'login',
        };
        logins.push(created);
        return new Response(JSON.stringify({ saved: true, entry: created }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (s.includes('/api/keepassxc/save-login')) {
        const body = JSON.parse(init.body || '{}');
        logins.push({ uuid: 'u1', name: 'bsky.app', login: body.login, url: body.url });
        return new Response(JSON.stringify({ saved: true, uuid: 'u1' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (s.includes('/api/keepassxc/lock')) {
        vaultUnlocked = false;
        return new Response(JSON.stringify({
          provider: 'sanctuary-kdbx',
          installed: true,
          running: true,
          initialized: true,
          associated: true,
          database_unlocked: false,
          version: 'KDBX 4.0',
          entry_count: 0,
          vault_mode: 'keepassxc',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (s.includes('/api/project_settings')) {
        return new Response(JSON.stringify({ folders: ['C:/LLM/LM-Sanctuary'] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    };

    const modal = openSettingsModal({ initialTab: 'project', initialVaultUrl: 'https://bsky.app/login' });
    await new Promise((r) => setTimeout(r, 25));

    const firstHeading = modal.card.querySelector('.form-card-container .modal-sub-header');
    assert.equal(firstHeading?.textContent, 'Credential Vault (.kdbx)');

    const p1 = modal.card.querySelector('#vault-setup-pw1');
    const p2 = modal.card.querySelector('#vault-setup-pw2');
    assert.ok(p1 && p2);
    p1.value = 'master-123';
    p2.value = 'master-123';
    p1.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(vaultInitialized, true);
    assert.equal(vaultUnlocked, true);

    const openKeyBoxBtn = modal.card.querySelector('#open-keybox-modal-btn');
    assert.ok(openKeyBoxBtn, 'Settings -> Project renders Open Key Box button when unlocked');
    openKeyBoxBtn.click();
    await new Promise((r) => setTimeout(r, 25));

    const keyBoxDialog = dom.document.querySelector('#keybox-vault-dialog');
    assert.ok(keyBoxDialog, 'Key Box modal opens');

    // Create a new entry via Key Box modal
    keyBoxDialog.querySelector('#keybox-new-entry-btn').click();
    keyBoxDialog.querySelector('#keybox-field-title').value = 'Bluesky';
    keyBoxDialog.querySelector('#keybox-field-login').value = 'alice.bsky.social';
    keyBoxDialog.querySelector('#keybox-field-password').value = 'secret-pass-1';
    keyBoxDialog.querySelector('#keybox-field-url').value = 'https://bsky.app/login';
    keyBoxDialog.querySelector('#keybox-field-notes').value = 'Main account';
    keyBoxDialog.querySelector('#keybox-entry-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(logins.length, 1);
    const searchInput = keyBoxDialog.querySelector('#keybox-search-input');
    searchInput.value = 'alice';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(keyBoxDialog.querySelectorAll('#keybox-entries-list .list-entry-row').length, 1);

    searchInput.value = 'nonexistent-query';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    assert.equal(keyBoxDialog.querySelectorAll('#keybox-entries-list .list-entry-row').length, 0);

    searchInput.value = '';
    searchInput.dispatchEvent(new Event('input', { bubbles: true }));
    keyBoxDialog.querySelector('.keybox-edit-btn').click();
    await new Promise((r) => setTimeout(r, 25));

    keyBoxDialog.querySelector('#keybox-field-title').value = 'Bluesky Personal';
    keyBoxDialog.querySelector('#keybox-field-notes').value = 'Edited note';
    keyBoxDialog.querySelector('#keybox-entry-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(logins[0].title, 'Bluesky Personal');
    assert.equal(logins[0].notes, 'Edited note');

    keyBoxDialog.close();

    const lockBtn = modal.card.querySelector('#lock-vault-btn');
    assert.ok(lockBtn);
    assert.equal(lockBtn.getAttribute('aria-label'), 'Lock Vault');
    lockBtn.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(vaultUnlocked, false);
    assert.ok(modal.card.querySelector('#vault-unlock-pw'));

    modal.close();
  } finally {
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    globalThis.fetch = prevFetch;
    dom.restore();
  }
});

test('PostCard grays out and disables reaction and share buttons when authStore vaultLocked is true', async () => {
  const dom = installMockDom();
  try {
    resetAuthStoreForTests();
    authStore.set({
      accounts: [{ id: 'masto_1', platform: 'fediverse', acct: 'alice@mastodon.social' }],
      isMastodonConnected: true,
      vaultLocked: true,
    });

    const { createPostCard, syncPostCardReactions } = await import('../web/components/PostCard.js');
    const post = {
      id: 'mastodon:123',
      protocol: 'mastodon',
      url: 'https://mastodon.social/@bob/123',
      content_text: 'Hello world',
      author: { id: 'bob', name: 'Bob', handle: '@bob@mastodon.social' },
      metrics: { likes: 2, replies: 1, reposts: 0 },
      _meta: { mastodon: { statusId: '123', visibility: 'public' } },
    };

    const card = createPostCard(post, {
      onToggleLike: () => {},
      onReply: () => {},
      onToggleRepost: () => {},
      onAskSanctuary: () => {},
      showSanctuaryAction: true,
    });

    assert.equal(card.querySelector('.post-action-like').dataset.needsUnlock, '1');
    assert.equal(card.querySelector('.post-action-reply').dataset.needsUnlock, '1');
    assert.equal(card.querySelector('.post-action-repost').dataset.needsUnlock, '1');
    assert.equal(card.querySelector('.post-action-sanctuary').dataset.needsUnlock, '1');

    authStore.set({ vaultLocked: false });
    syncPostCardReactions(card, post);
    assert.equal(card.querySelector('.post-action-like').dataset.needsUnlock, undefined);
    assert.equal(card.querySelector('.post-action-reply').dataset.needsUnlock, undefined);
    assert.equal(card.querySelector('.post-action-repost').dataset.needsUnlock, undefined);
    assert.equal(card.querySelector('.post-action-sanctuary').dataset.needsUnlock, undefined);
  } finally {
    resetAuthStoreForTests();
    dom.restore();
  }
});
