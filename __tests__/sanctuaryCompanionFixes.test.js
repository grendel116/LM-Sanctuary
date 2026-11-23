import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mountProgramThread } from '../web/app/programThread.js';
import { syncRecentUserPostsToSanctuary } from '../web/queries/socialClient.js';
import { resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetOutboxForTests } from '../web/state/sanctuary/outboxModel.js';
import { resetSessionStoreForTests } from '../web/state/sanctuary/sessionModel.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

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

test('programThread anchors chat scroll to bottom on load and preserves optimistic user message during generation', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  const chatDeferred = createDeferred();
  let chatCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      const history = chatCalls > 0
        ? [
            { id: 'm_old', role: 'program', sender_id: 'sebile', text: 'Earlier message.', timestamp: 100 },
            { id: 'usr_sent', role: 'user', text: 'Stay visible please', timestamp: 101 },
            { id: 'prgm_done', role: 'program', sender_id: 'sebile', text: 'I stayed right here.', timestamp: 102 },
          ]
        : [
            { id: 'm_1', role: 'user', text: 'Old question', timestamp: 99 },
            { id: 'm_old', role: 'program', sender_id: 'sebile', text: 'Earlier message.', timestamp: 100 },
          ];
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history,
        state: { name: 'baseline' },
      });
    }
    if (u.endsWith('/models')) {
      return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }], status: { temperature: 0.9 } });
    }
    if (u.endsWith('/api/config')) {
      return jsonResponse({ active_user: 'builder', program_moods: {} });
    }
    if (u.endsWith('/chat') && init.method === 'POST') {
      chatCalls += 1;
      const body = await chatDeferred.promise;
      return jsonResponse(body);
    }
    if (u.includes('/api/tool_status')) {
      return jsonResponse({ pending: null });
    }
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#9370db' } }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);

    let scrollValue = 1280;
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    const chatContainer = host.querySelector('#chat-container');
    Object.defineProperty(chatContainer, 'scrollHeight', {
      configurable: true,
      get: () => scrollValue,
    });
    Object.defineProperty(chatContainer, 'clientHeight', {
      configurable: true,
      get: () => 400,
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(chatContainer.scrollTop, 1280);

    // Async image finishing load inside chat must re-anchor scroll when pinned
    scrollValue = 1540;
    chatContainer.dispatchEvent(new Event('load'));
    assert.equal(chatContainer.scrollTop, 1540);

    // Submit a user turn while /chat stays in flight
    const textarea = host.querySelector('#user-input');
    const form = host.querySelector('#input-area');
    textarea.value = 'Stay visible please';
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 15));

    const midTurnUserRows = Array.from(chatContainer.querySelectorAll('.message-row.user-row')).filter(
      (r) => r.dataset.rawText === 'Stay visible please'
    );
    assert.equal(midTurnUserRows.length, 1);

    // Simulate background health poll firing connectionStore.set(...) while LLM generates
    connectionStore.set({ gpuMode: 'llm' });
    await new Promise((r) => setTimeout(r, 15));

    const survivedUserRows = Array.from(chatContainer.querySelectorAll('.message-row.user-row')).filter(
      (r) => r.dataset.rawText === 'Stay visible please'
    );
    assert.equal(survivedUserRows.length, 1);
    assert.ok(chatContainer.querySelector('.typing-row'));

    chatDeferred.resolve({
      message: { id: 'prgm_done', role: 'program', sender_id: 'sebile', text: 'I stayed right here.', timestamp: 102 },
      state: { name: 'warm' },
    });
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(chatContainer.querySelector('.typing-row'), null);
    assert.ok(chatContainer.textContent.includes('I stayed right here.'));
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

test('programThread avatar opens straight to most recent image in classic viewer and gallery button opens full grid', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  let listImagesCalls = 0;
  let cropPayload = null;
  let emptyProgramMode = false;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: emptyProgramMode ? 'empty_prog' : 'sebile' });
    }
    if (u.includes('/api/programs/profile_picture/crop')) {
      cropPayload = init?.body ? JSON.parse(init.body) : {};
      return jsonResponse({ status: 'success', program_id: cropPayload.program_id || 'sebile' });
    }
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: [{ id: 'p1', role: 'program', sender_id: 'sebile', sender_name: 'Sebile', text: 'Ready.', timestamp: 10 }],
      });
    }
    if (u.includes('/list_images')) {
      listImagesCalls += 1;
      if (emptyProgramMode) {
        return jsonResponse({
          images: [],
          images_by_program: { sebile: [] },
          image_owners: {},
          uploads: [],
        });
      }
      return jsonResponse({
        images: ['/images/portraits/sebile_1.png', '/images/portraits/sebile_2.png'],
        images_by_program: {
          sebile: ['/images/portraits/sebile_1.png', '/images/portraits/sebile_2.png'],
          aria: ['/images/portraits/aria_1.png'],
        },
        image_owners: {
          '/images/portraits/sebile_1.png': 'sebile',
          '/images/portraits/sebile_2.png': 'sebile',
          '/images/portraits/aria_1.png': 'aria',
        },
        uploads: ['/images/uploads/u1.png'],
      });
    }
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile' }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 25));

    // Verify Sanctuary header button order: Voice Call, Quests, Gallery, Knowledge
    assert.deepEqual(
      Array.from(host.querySelectorAll('.header-actions button')).map((b) => b.getAttribute('aria-label')),
      ['Voice Call', 'Quest Log', 'Image Gallery', 'Memory / Knowledge']
    );

    // 1. Clicking Program avatar opens classic viewer straight to the most recent image
    const progAvatar = host.querySelector('.program-avatar');
    assert.ok(progAvatar);
    const initialAvatarSrc = progAvatar.src;
    progAvatar.click();
    await new Promise((r) => setTimeout(r, 25));

    assert.equal(listImagesCalls, 1);
    assert.equal(dom.document.getElementById('sanctuary-gallery-dialog'), null);
    const directViewer = dom.document.getElementById('sanctuary-lightbox-dialog');
    assert.ok(directViewer && directViewer.open);
    assert.ok(directViewer.classList.contains('classic-image-viewer-dialog'));
    assert.equal(directViewer.getAttribute('role'), null);

    const modalImg = directViewer.querySelector('#modal-img');
    assert.ok(modalImg.src.includes('/images/portraits/sebile_1.png'));
    assert.equal(directViewer.querySelector('#delete-gallery-btn').hidden, false);
    const avatarBtn = directViewer.querySelector('#set-profile-btn');
    assert.equal(avatarBtn.hidden, false);
    assert.ok(avatarBtn.textContent.includes('Make Avatar'));
    assert.equal(directViewer.textContent.includes('Use as Profile'), false);

    // Step with Next arrow button and ArrowLeft keyboard shortcut
    directViewer.querySelector('.next-btn').click();
    assert.ok(modalImg.src.includes('/images/portraits/sebile_2.png'));
    dom.document.dispatchEvent(Object.assign(new Event('keydown'), { key: 'ArrowLeft' }));
    assert.ok(modalImg.src.includes('/images/portraits/sebile_1.png'));

    // Saving a cropped avatar updates mounted Program avatar <img> immediately without refresh
    avatarBtn.click();
    const cropDialog = dom.document.getElementById('crop-modal');
    assert.ok(cropDialog && cropDialog.open);
    cropDialog.querySelector('.edit-save-btn').click();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(cropPayload?.program_id, 'sebile');
    assert.equal(dom.document.getElementById('crop-modal'), null);
    assert.notEqual(host.querySelector('.program-avatar').src, initialAvatarSrc);
    assert.match(host.querySelector('.program-avatar').src, /\/programs\/sebile\/profile\.png\?t=\d+/);

    // 2. Clicking Program avatar when no generated media exists opens "No Media" alert
    emptyProgramMode = true;
    progAvatar.click();
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(dom.document.getElementById('sanctuary-lightbox-dialog'), null);
    const alertTitle = Array.from(dom.document.querySelectorAll('.classic-dialog-title')).find(
      (el) => el.textContent === 'No Media'
    );
    assert.ok(alertTitle);
    alertTitle.closest('dialog')?.close?.();
    emptyProgramMode = false;

    // 3. Header gallery button still opens the full Image Gallery grid dialog
    const galleryBtn = host.querySelector('.gallery-btn');
    assert.ok(galleryBtn);
    galleryBtn.click();
    await new Promise((r) => setTimeout(r, 25));

    const galleryDialog = dom.document.getElementById('sanctuary-gallery-dialog');
    assert.ok(galleryDialog && galleryDialog.open);
    assert.equal(galleryDialog.querySelectorAll('.sanctuary-gallery-item').length, 2);

    galleryDialog.querySelector('[data-gallery-tab="all"]').click();
    assert.equal(galleryDialog.querySelectorAll('.sanctuary-gallery-item').length, 3);

    galleryDialog.querySelector('[data-gallery-tab="uploads"]').click();
    assert.equal(galleryDialog.querySelectorAll('.sanctuary-gallery-item').length, 1);

    galleryDialog.querySelector('[data-gallery-tab="program"]').click();
    galleryDialog.querySelector('.sanctuary-gallery-item').click();
    await new Promise((r) => setTimeout(r, 20));

    const lightboxFromGrid = dom.document.getElementById('sanctuary-lightbox-dialog');
    assert.ok(lightboxFromGrid && lightboxFromGrid.open);
    assert.ok(lightboxFromGrid.querySelector('#modal-img').src.includes('/images/portraits/sebile_1.png'));
  } finally {
    dom.document.getElementById('sanctuary-lightbox-dialog')?.close?.();
    dom.document.getElementById('sanctuary-gallery-dialog')?.close?.();
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

test('syncRecentUserPostsToSanctuary deduplicates cross-posts, skips boosts, and sends up to 3 posts', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetConnectionStoreForTests();

  const capturedPayloads = [];
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.endsWith('/api/user_profiles/sync_mastodon') && init.method === 'POST') {
      const payload = JSON.parse(init.body || '{}');
      capturedPayloads.push(payload);
      return jsonResponse({ status: 'success', recent_posts_count: (payload.recent_posts || []).length });
    }
    return jsonResponse({});
  };

  try {
    connectionStore.set({ mode: 'online', nodeUrl: 'http://127.0.0.1:5000' });
    await upsertSocialAccount({
      id: 'fediverse:davy@mastodon.social',
      platform: 'fediverse',
      instanceUrl: 'https://mastodon.social',
      handle: 'davy',
      acct: 'davy@mastodon.social',
      displayName: 'Davy',
      userId: '42',
    });

    const preloadedItems = [
      { id: 'mastodon:9', protocol: 'mastodon', content_text: 'Newest thought', date_published: '2026-11-19T08:00:00Z', _meta: { mastodon: { statusId: '9' } } },
      { id: 'bluesky:at://9', protocol: 'bluesky', content_text: 'Newest thought', date_published: '2026-11-19T08:00:01Z', _meta: { bluesky: { uri: 'at://9', cid: 'c9' } } },
      { id: 'mastodon:8', protocol: 'mastodon', content_text: 'Someone else boost', date_published: '2026-11-19T07:00:00Z', _meta: { mastodon: { statusId: '8', rebloggedBy: { handle: 'davy' } } } },
      { id: 'mastodon:7', protocol: 'mastodon', content_text: 'Second post', date_published: '2026-11-19T06:00:00Z', _meta: { mastodon: { statusId: '7' } } },
      { id: 'mastodon:6', protocol: 'mastodon', content_text: 'Third post', date_published: '2026-11-19T05:00:00Z', _meta: { mastodon: { statusId: '6' } } },
      { id: 'mastodon:5', protocol: 'mastodon', content_text: 'Fourth older post', date_published: '2026-11-19T04:00:00Z', _meta: { mastodon: { statusId: '5' } } },
    ];

    const res = await syncRecentUserPostsToSanctuary({ preloadedItems });
    assert.equal(res.synced, true);
    assert.equal(res.count, 3);
    const last = capturedPayloads[capturedPayloads.length - 1];
    assert.deepEqual(
      last.recent_posts.map((p) => p.text),
      ['Newest thought', 'Second post', 'Third post']
    );
  } finally {
    globalThis.fetch = prevFetch;
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('programThread inline edit Cancel, Escape, and Save restore bubbles reliably without stale editors', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  let serverHistory = [
    { id: 'usr_1', role: 'user', text: 'Initial prompt', timestamp: 100 },
    { id: 'prgm_1', role: 'program', sender_id: 'sebile', sender_name: 'Sebile', text: 'Initial reply', timestamp: 101 },
  ];
  let updateCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: serverHistory,
      });
    }
    if (u.endsWith('/update_message') && init.method === 'POST') {
      updateCalls += 1;
      const body = JSON.parse(init.body || '{}');
      serverHistory = serverHistory.map((m) => (m.id === body.msg_id ? { ...m, text: body.new_text.trim() } : m));
      return jsonResponse({ status: 'success' });
    }
    if (u.endsWith('/models')) {
      return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    }
    if (u.endsWith('/api/config')) {
      return jsonResponse({ active_user: 'builder', program_moods: {} });
    }
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile' }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 30));

    // 1. Cancel restores original bubble synchronously even with unchanged history
    const progRow = host.querySelector('[data-msg-id="prgm_1"]');
    progRow.querySelector('[aria-label="Edit response"]').click();
    assert.ok(progRow.querySelector('.message.editing'));
    const ta1 = progRow.querySelector('.edit-textarea');
    ta1.value = 'Discarded draft';
    progRow.querySelector('.edit-cancel-btn').click();
    assert.equal(progRow.querySelector('.message.editing'), null);
    assert.equal(progRow.querySelector('.edit-textarea'), null);
    assert.equal(progRow.querySelector('.message-text').textContent, 'Initial reply');
    assert.ok(progRow.querySelector('[aria-label="Edit response"]'));

    // 2. Escape cancels inline edit cleanly
    progRow.querySelector('[aria-label="Edit response"]').click();
    const ta2 = progRow.querySelector('.edit-textarea');
    ta2.value = 'Escape discard';
    ta2.dispatchEvent(Object.assign(new Event('keydown', { bubbles: true, cancelable: true }), { key: 'Escape' }));
    assert.equal(progRow.querySelector('.edit-textarea'), null);
    assert.equal(progRow.querySelector('.message-text').textContent, 'Initial reply');

    // 3. Save program edit with unchanged text closes editor without calling /update_message
    progRow.querySelector('[aria-label="Edit response"]').click();
    progRow.querySelector('.edit-save-btn').click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(updateCalls, 0);
    assert.equal(progRow.querySelector('.edit-textarea'), null);
    assert.equal(progRow.querySelector('.message-text').textContent, 'Initial reply');

    // 4. Save changed program edit calls /update_message, closes editor, and renders updated text
    progRow.querySelector('[aria-label="Edit response"]').click();
    progRow.querySelector('.edit-textarea').value = 'Updated reply text';
    progRow.querySelector('.edit-save-btn').click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(updateCalls, 1);
    const updatedProgRow = host.querySelector('[data-msg-id="prgm_1"]');
    assert.equal(updatedProgRow.querySelector('.edit-textarea'), null);
    assert.equal(updatedProgRow.querySelector('.message-text').textContent, 'Updated reply text');
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

test('programThread closes user edit immediately, stops active turn before saving user edit, and awaits cancel before refreshing on Stop', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  const events = [];
  let serverHistory = [
    { id: 'usr_1', role: 'user', text: 'Original prompt', timestamp: 100 },
    { id: 'prgm_1', role: 'program', sender_id: 'sebile', sender_name: 'Sebile', text: 'Original reply', timestamp: 101 },
  ];
  let chatDeferred = createDeferred();
  let editDeferred = createDeferred();
  let cancelDeferred = createDeferred();
  let editBodySeen = null;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.includes('/history')) {
      events.push('history');
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: serverHistory,
      });
    }
    if (u.endsWith('/chat') && init.method === 'POST') {
      events.push('chat:start');
      init.signal?.addEventListener?.('abort', () => {
        chatDeferred.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }, { once: true });
      const data = await chatDeferred.promise;
      return jsonResponse(data);
    }
    if (u.endsWith('/edit') && init.method === 'POST') {
      events.push('edit:start');
      editBodySeen = JSON.parse(init.body || '{}');
      init.signal?.addEventListener?.('abort', () => {
        editDeferred.reject(Object.assign(new Error('Aborted'), { name: 'AbortError' }));
      }, { once: true });
      const data = await editDeferred.promise;
      return jsonResponse(data);
    }
    if (u.endsWith('/api/cancel_chat') && init.method === 'POST') {
      events.push('cancel:start');
      await cancelDeferred.promise;
      events.push('cancel:done');
      return jsonResponse({ status: 'success' });
    }
    if (u.includes('/api/session_tool_calls')) {
      return jsonResponse({ call_id: null, tool_calls: [] });
    }
    if (u.endsWith('/models')) {
      return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    }
    if (u.endsWith('/api/config')) {
      return jsonResponse({ active_user: 'builder', program_moods: {} });
    }
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile' }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 30));

    // Start an in-flight /chat generation
    host.querySelector('#user-input').value = 'New ongoing message';
    host.querySelector('#input-area').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert.ok(host.querySelector('#stop-btn').hidden === false);

    // Reroll usr_1 while /chat is still generating
    const usrRow = host.querySelector('[data-msg-id="usr_1"]');
    usrRow.querySelector('[aria-label="Reroll prompt"]').click();
    await new Promise((r) => setTimeout(r, 15));

    // /api/cancel_chat must be initiated before /edit starts
    assert.ok(events.includes('cancel:start'));
    assert.equal(events.includes('edit:start'), false);

    // Finish /api/cancel_chat for the previous turn -> /edit begins cleanly
    cancelDeferred.resolve();
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(editBodySeen?.msg_id, 'usr_1');
    assert.equal(editBodySeen?.new_text, null);
    assert.equal(host.querySelector('.edit-textarea'), null);
    assert.ok(host.querySelector('.typing-row'));

    // Now click #stop-btn while /edit is in flight: /history must NOT fire until /api/cancel_chat completes
    events.length = 0;
    cancelDeferred = createDeferred();
    host.querySelector('#stop-btn').click();
    await new Promise((r) => setTimeout(r, 25));

    assert.deepEqual(events, ['cancel:start']);
    assert.equal(host.querySelector('#stop-btn').hidden, false);

    cancelDeferred.resolve();
    await new Promise((r) => setTimeout(r, 35));

    assert.equal(events[0], 'cancel:start');
    assert.equal(events[1], 'cancel:done');
    assert.equal(events[2], 'history');
    assert.equal(host.querySelector('#stop-btn').hidden, true);
    assert.equal(host.querySelector('.edit-textarea'), null);
    assert.equal(host.querySelector('[data-msg-id="usr_1"] .message-text').textContent, 'Original prompt');
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
