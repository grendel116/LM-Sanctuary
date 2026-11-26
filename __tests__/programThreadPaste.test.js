/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mountProgramThread } from '../web/app/programThread.js';
import { connectionStore, emitSanctuaryEvent, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { enqueueTurn, flushOutbox, outboxStore, removeQueuedTurn, resetOutboxForTests } from '../web/state/sanctuary/outboxModel.js';
import { loadProgramSession, resetSessionStoreForTests, sessionStore } from '../web/state/sanctuary/sessionModel.js';
import { resetAuthStoreForTests } from '../web/state/authStore.js';
import { resolveSanctuaryMediaUrl } from '../web/queries/sanctuary.js';
import { cacheProgramHistory, getCachedProgramHistory, resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function pastedClipboardFile(file) {
  return {
    kind: 'file',
    type: file.type,
    getAsFile: () => file,
  };
}

function dispatchPaste(textarea, { files = [], text = '' } = {}) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  event.clipboardData = {
    items: files.map(pastedClipboardFile),
    getData: (mime) => (mime === 'text/plain' ? text : ''),
  };
  textarea.dispatchEvent(event);
  return event;
}

function makeImageFile(name = 'pasted.png', type = 'image/png') {
  return { name, type, size: 256 };
}

test('paste event captures clipboard image, uploads it, and sends media_path to chat handler', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  const uploadCalls = [];
  const chatCalls = [];
  let chatDeferred = null;

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('data:') || u.startsWith('blob:')) return new Response('', { status: 200 });
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: [
          { id: 'm_1', role: 'program', sender_id: 'sebile', text: 'Ready.', timestamp: 100 },
        ],
      });
    }
    if (u.endsWith('/models')) return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    if (u.endsWith('/api/config')) return jsonResponse({ active_user: 'builder', program_moods: {} });
    if (u.endsWith('/upload_media') && init.method === 'POST') {
      uploadCalls.push({ body: init.body });
      return jsonResponse({ file_path: '/images/uploads/pasted_1.png' });
    }
    if (u.endsWith('/chat') && init.method === 'POST') {
      const deferred = chatDeferred;
      if (!deferred) return jsonResponse({ cancelled: true });
      const body = JSON.parse(init.body || '{}');
      chatCalls.push(body);
      return deferred.promise.then((reply) => jsonResponse(reply));
    }
    if (u.includes('/api/tool_status')) return jsonResponse({ pending: null });
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 30));

    const textarea = host.querySelector('#user-input');
    assert.ok(textarea, 'composer textarea is mounted');

    // 1. Image-only paste: staged locally in compact .preview-item card, NOT uploaded to gallery yet
    const pasteEvent = dispatchPaste(textarea, { files: [makeImageFile()] });
    assert.equal(pasteEvent.defaultPrevented, true, 'image-only paste is captured and default prevented');
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(uploadCalls.length, 0, 'paste does NOT upload to gallery before message is sent');
    assert.equal(textarea.value, '', 'image paste does not corrupt composer text');
    const previewStrip = host.querySelector('#preview-area');
    assert.equal(previewStrip.hidden, false, 'attachment preview strip becomes visible');
    const card = previewStrip.querySelector('.preview-item');
    assert.ok(card, 'compact preview card renders');
    const thumb = card.querySelector('img');
    assert.ok(thumb, 'image thumbnail renders in attachment preview card');
    assert.equal(thumb.getAttribute('alt'), 'pasted.png');
    assert.equal(card.querySelector('.preview-item-name')?.textContent, 'pasted.png');

    // Removing staged attachment clears the card with zero uploads
    const rmBtn = card.querySelector('.remove-preview');
    assert.ok(rmBtn, 'remove button renders inside preview card');
    rmBtn.click();
    assert.equal(previewStrip.hidden, true, 'removing staged attachment hides preview strip');
    assert.equal(uploadCalls.length, 0, 'removing staged attachment triggers no upload');

    // Re-paste and send: upload happens once on submitTurn, then forwards media_path to /chat
    dispatchPaste(textarea, { files: [makeImageFile()] });
    assert.equal(previewStrip.hidden, false);
    assert.equal(uploadCalls.length, 0);

    // 2. Sending the pasted image uploads it once and forwards media_path through the chat handler
    chatDeferred = Promise.withResolvers();
    textarea.value = 'What is in this screenshot?';
    host.querySelector('#input-area').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(uploadCalls.length, 1, 'submit uploads staged image to /upload_media');
    assert.ok(uploadCalls[0].body instanceof FormData, 'clipboard image is POSTed as multipart FormData');
    assert.equal(chatCalls.length, 1, 'submit posts exactly one /chat turn');
    assert.equal(chatCalls[0].media_path, '/images/uploads/pasted_1.png', 'pasted image is sent to chat handler');
    assert.equal(chatCalls[0].image_mime, 'image/png');
    assert.equal(chatCalls[0].message, 'What is in this screenshot?');
    chatDeferred.resolve({
      message: { id: 'prgm_1', role: 'program', sender_id: 'sebile', text: 'Acknowledged the screenshot.', timestamp: 101 },
    });
    await new Promise((r) => setTimeout(r, 30));

    // 3. Text-only paste falls through natively with no upload or preview
    const textPasteEvent = dispatchPaste(textarea, { text: 'just words' });
    assert.equal(textPasteEvent.defaultPrevented, false, 'text paste is not intercepted');
    assert.equal(uploadCalls.length, 1, 'text paste triggers no upload');
    assert.equal(host.querySelector('#preview-area').hidden, true, 'preview strip hidden after clean send');

    // 4. Image-with-caption paste stages image while preserving native text insertion (zero upload until send)
    const captionEvent = dispatchPaste(textarea, {
      files: [makeImageFile('second.jpg', 'image/jpeg')],
      text: 'caption',
    });
    assert.equal(captionEvent.defaultPrevented, false, 'text-bearing paste preserves native text insertion');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(previewStrip.hidden, false, 'captioned paste stages preview card');
    assert.equal(previewStrip.querySelector('.preview-item-name')?.textContent, 'second.jpg');
    assert.equal(uploadCalls.length, 1, 'captioned paste does not upload until send');

    // 5. Offline paste does nothing (no queued upload)
    connectionStore.set({ mode: 'offline' });
    const offlineEvent = dispatchPaste(textarea, { files: [makeImageFile('third.png')] });
    assert.equal(offlineEvent.defaultPrevented, false, 'offline paste stays native');
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(uploadCalls.length, 1, 'offline paste triggers no upload');
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

test('deleting staged, queued, or sent attachment messages never sends the deleted attachment', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  const chatCalls = [];
  const deleteCalls = [];
  let serverHistory = [
    { id: 'm_1', role: 'program', sender_id: 'sebile', text: 'Ready.', timestamp: 100 },
  ];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('data:') || u.startsWith('blob:')) return new Response('', { status: 200 });
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: serverHistory,
      });
    }
    if (u.endsWith('/models')) return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    if (u.endsWith('/api/config')) return jsonResponse({ active_user: 'builder', program_moods: {} });
    if (u.endsWith('/upload_media') && init.method === 'POST') {
      return jsonResponse({ file_path: '/images/uploads/staged_should_clear.png' });
    }
    if (u.endsWith('/delete') && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      deleteCalls.push(body);
      serverHistory = serverHistory.filter((m) => m.id !== body.msg_id);
      return jsonResponse({ status: 'ok' });
    }
    if (u.endsWith('/chat') && init.method === 'POST') {
      const body = JSON.parse(init.body || '{}');
      chatCalls.push(body);
      serverHistory = [
        ...serverHistory,
        {
          id: body.msg_id,
          role: 'user',
          text: body.message,
          ...(body.media_path ? { media: [{ url: body.media_path, type: 'image' }] } : {}),
          ...(body.shared_post ? { shared_post: body.shared_post } : {}),
          timestamp: 101,
        },
      ];
      return jsonResponse({
        message: { id: `prgm_${chatCalls.length}`, role: 'program', sender_id: 'sebile', text: 'OK', timestamp: 102 },
      });
    }
    if (u.includes('/api/tool_status')) return jsonResponse({ pending: null });
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 30));

    // 1. Removing staged attachment clears it completely before sending plain text
    const textarea = host.querySelector('#user-input');
    dispatchPaste(textarea, { files: [makeImageFile('removed.png')] });
    host.querySelector('.remove-preview').click();
    textarea.value = 'Plain follow-up only';
    host.querySelector('#input-area').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 30));

    assert.equal(chatCalls.length, 1);
    assert.equal(chatCalls[0].media_path, null);
    assert.equal(chatCalls[0].message, 'Plain follow-up only');

    // 2. Deleting a queued offline attachment turn removes it from outboxStore so flushOutbox sends nothing
    const queued = await enqueueTurn({
      programId: 'sebile',
      sessionId: 'default',
      message: '[Shared post by Alice]\nDeleted offline attachment',
      sharedPost: { authorName: 'Alice', text: 'Deleted offline attachment', network: 'fediverse' },
      mediaPath: '/images/uploads/offline_gone.png',
    });
    assert.equal(outboxStore.get().items.length, 1);
    await removeQueuedTurn('sebile', 'default', queued.msgId);
    assert.equal(outboxStore.get().items.length, 0);
    const flushRes = await flushOutbox();
    assert.equal(flushRes.flushedCount, 0);
    assert.equal(chatCalls.length, 1);

    // 3. Deleting a sent shared-post attachment message removes it via POST /delete and subsequent turns have no shared_post
    ctrl.attachSharedPost({
      authorName: 'Bob',
      text: 'Shared post to delete',
      url: 'https://example.com/bob',
      network: 'web',
    });
    textarea.value = 'Look at Bob';
    host.querySelector('#input-area').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(chatCalls.length, 2);
    assert.ok(chatCalls[1].shared_post);
    const deleteBtns = host.querySelectorAll('.action-icon-btn[aria-label="Delete message"]');
    assert.ok(deleteBtns.length >= 1, 'user message renders Delete message action');
    deleteBtns[deleteBtns.length - 1].click();
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(deleteCalls.length, 1);
    assert.equal(deleteCalls[0].msg_id, chatCalls[1].msg_id);
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

test('programThread hides cached chat and disables composer on 503 locked history, then restores on unlock', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  // Seed a stale cached history that MUST NOT display while vault is locked
  await cacheProgramHistory('sebile', 'default', {
    history: [
      { id: 'cached_1', role: 'user', text: 'Leaked cached message' },
      { id: 'cached_2', role: 'program', text: 'Leaked cached reply' },
    ],
  });

  let vaultLocked = true;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('data:') || u.startsWith('blob:')) return new Response('', { status: 200 });
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      if (vaultLocked) {
        return jsonResponse({ error: 'Vault locked', locked: true, vault: 'keepassxc' }, 503);
      }
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: [
          { id: 'm_1', role: 'program', sender_id: 'sebile', text: 'First greeting', timestamp: 100 },
          { id: 'u_1', role: 'user', text: 'Full restored conversation', timestamp: 101 },
        ],
      });
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
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 35));

    assert.match(host.textContent, /Unlock/);
    assert.doesNotMatch(host.textContent, /Unlock Vault/);
    assert.doesNotMatch(host.textContent, /Leaked cached message/);
    assert.equal(host.querySelectorAll('.message-row').length, 0);
    assert.equal(host.querySelector('#user-input').disabled, true);
    assert.equal(host.querySelector('#send-btn').disabled, true);
    assert.equal(await getCachedProgramHistory('sebile', 'default'), null);

    vaultLocked = false;
    emitSanctuaryEvent('sanctuary:vault-changed', { unlocked: true });
    await new Promise((r) => setTimeout(r, 40));

    assert.doesNotMatch(host.textContent, /Vault locked/);
    assert.match(host.textContent, /Full restored conversation/);
    assert.equal(host.querySelector('#user-input').disabled, false);
    assert.equal(host.querySelector('#send-btn').disabled, false);
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

test('loadProgramSession ignores stale connecting load when online 503 locked completes first', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  let vaultLocked = true;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('data:') || u.startsWith('blob:')) return new Response('', { status: 200 });
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      if (vaultLocked) {
        return jsonResponse({ error: 'Vault locked', locked: true, vault: 'keepassxc' }, 503);
      }
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: [
          { id: 'm_1', role: 'program', sender_id: 'sebile', text: 'First greeting', timestamp: 100 },
          { id: 'u_1', role: 'user', text: 'Restored after race', timestamp: 101 },
        ],
      });
    }
    if (u.endsWith('/models')) return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    if (u.endsWith('/api/config')) return jsonResponse({ active_user: 'builder', program_moods: {} });
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({ mode: 'dormant', nodeUrl: '', programs: [] });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { sessionId: 'default' });

    connectionStore.set({
      mode: 'connecting',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });
    const staleConnectingLoad = loadProgramSession('sebile', 'default');

    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });
    emitSanctuaryEvent('sanctuary:online', {});
    const onlineLoad = loadProgramSession('sebile', 'default');

    await Promise.all([staleConnectingLoad, onlineLoad]);
    await new Promise((r) => setTimeout(r, 35));

    assert.equal(sessionStore.get().vaultLocked, true);
    assert.match(host.textContent, /Unlock/);
    assert.equal(host.querySelector('#user-input').disabled, true);

    vaultLocked = false;
    emitSanctuaryEvent('sanctuary:vault-changed', { unlocked: true });
    await new Promise((r) => setTimeout(r, 40));

    assert.match(host.textContent, /Restored after race/);
    assert.equal(host.querySelector('#user-input').placeholder, 'Ask Sebile');
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

test('programThread renders external http(s) media URLs without throwing cross-origin error', async () => {
  assert.equal(
    resolveSanctuaryMediaUrl('https://onlabor.org/x.jpg', { nodeUrl: 'http://127.0.0.1:5000' }),
    'https://onlabor.org/x.jpg'
  );
  assert.equal(
    resolveSanctuaryMediaUrl('/images/a.png', { nodeUrl: 'http://127.0.0.1:5000' }),
    'http://127.0.0.1:5000/images/a.png'
  );

  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.startsWith('data:') || u.startsWith('blob:')) return new Response('', { status: 200 });
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: [
          { id: 'u_ext', role: 'user', text: 'Show me labour news', timestamp: 101 },
          {
            id: 'p_ext',
            role: 'program',
            sender_id: 'sebile',
            text: 'Labour news digest',
            media: [
              {
                type: 'image',
                url: 'https://onlabor.org/wp-content/uploads/2026/11/Reuters_Building.jpg',
                program_id: 'sebile',
              },
            ],
            timestamp: 102,
          },
        ],
      });
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
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 40));

    assert.match(host.textContent, /Labour news digest/);
    assert.doesNotMatch(host.textContent, /Could not load chat history/);
    assert.equal(sessionStore.get().error, null);
    assert.equal(sessionStore.get().messages.length, 2);
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

test('impersonate locks composer and shows generating indicator while pending', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();
  resetConnectionStoreForTests();

  const impDeferred = Promise.withResolvers();
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('data:') || u.startsWith('blob:')) return new Response('', { status: 200 });
    if (u.endsWith('/select_program') || u.endsWith('/api/select_program')) {
      return jsonResponse({ status: 'ok', active_program: 'sebile' });
    }
    if (u.includes('/history')) {
      return jsonResponse({
        active_program: 'sebile',
        character_name: 'Sebile',
        history: [
          { id: 'm_1', role: 'program', sender_id: 'sebile', text: 'Ready.', timestamp: 100 },
        ],
      });
    }
    if (u.endsWith('/models')) return jsonResponse({ models: [{ value: 'local-llm', label: 'Local LLM' }] });
    if (u.endsWith('/api/config')) return jsonResponse({ active_user: 'builder', program_moods: {} });
    if (u.endsWith('/api/generate_user_message') && init.method === 'POST') {
      return impDeferred.promise.then((reply) => jsonResponse(reply));
    }
    if (u.includes('/api/tool_status')) return jsonResponse({ pending: null });
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    connectionStore.set({
      mode: 'online',
      nodeUrl: 'http://127.0.0.1:5000',
      activeProgram: 'sebile',
      programs: [{ id: 'sebile', name: 'Sebile', theme: { primary_accent: '#38bdf8' } }],
    });

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountProgramThread(host, { programId: 'sebile', sessionId: 'default' });
    await new Promise((r) => setTimeout(r, 30));

    const textarea = host.querySelector('#user-input');
    const sendBtn = host.querySelector('#send-btn');
    const impBtn = host.querySelector('#auto-generate-user-btn');
    assert.ok(impBtn, 'impersonate button is mounted');
    assert.equal(impBtn.getAttribute('aria-label'), 'Impersonate');
    assert.equal(impBtn.title, 'Impersonate');

    impBtn.click();
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(textarea.disabled, true, 'textarea is locked while impersonating');
    assert.equal(sendBtn.disabled, true, 'send button is locked while impersonating');
    assert.equal(impBtn.disabled, true, 'impersonate button is disabled while impersonating');
    assert.equal(impBtn.classList.contains('is-generating'), true, 'impersonate button has is-generating class');
    assert.equal(impBtn.getAttribute('aria-busy'), 'true', 'impersonate button sets aria-busy=true');
    assert.equal(textarea.placeholder, 'Writing your reply…', 'textarea placeholder indicates generation');

    impDeferred.resolve({ message: 'Drafted reply' });
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(textarea.value, 'Drafted reply', 'textarea receives drafted reply');
    assert.equal(textarea.disabled, false, 'textarea unlocks after impersonating');
    assert.equal(sendBtn.disabled, false, 'send button unlocks after impersonating');
    assert.equal(impBtn.disabled, false, 'impersonate button re-enables after impersonating');
    assert.equal(impBtn.classList.contains('is-generating'), false, 'is-generating class is cleared');
    assert.equal(impBtn.getAttribute('aria-busy'), 'false', 'aria-busy resets to false');
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
