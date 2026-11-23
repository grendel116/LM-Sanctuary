/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mountProgramThread } from '../web/app/programThread.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetOutboxForTests } from '../web/state/sanctuary/outboxModel.js';
import { resetSessionStoreForTests } from '../web/state/sanctuary/sessionModel.js';
import { resetAuthStoreForTests } from '../web/state/authStore.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

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
