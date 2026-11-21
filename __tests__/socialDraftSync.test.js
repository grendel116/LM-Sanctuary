import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deleteComposeDraft,
  listLocalComposeDrafts,
  syncComposeDraftsWithServer,
} from '../web/state/composeStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests, storePut } from '../web/storage/nativeStore.js';

test('social drafts merge across devices and replay deletions after the server returns', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();
  connectionStore.set({
    mode: 'offline',
    nodeUrl: 'http://100.120.44.39:5000',
  });

  const localNewer = { id: 'shared-newer', text: 'local newer', updatedAt: 20 };
  const localStale = { id: 'deleted-remotely', text: 'stale copy', updatedAt: 30 };
  const remoteNewer = { id: 'shared-remote', text: 'remote newer', updatedAt: 40 };
  const remoteOnly = { id: 'remote-only', text: 'phone draft', updatedAt: 10 };
  let drafts = [remoteNewer, remoteOnly];
  const deletedIds = ['deleted-remotely'];
  const calls = [];
  let serverReady = true;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const method = options.method || 'GET';
    calls.push({ path, method });
    if (!serverReady) {
      return new Response(JSON.stringify({ error: 'server unavailable' }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path === '/api/social/drafts' && method === 'GET') {
      return new Response(JSON.stringify({ drafts, deletedIds }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.startsWith('/api/social/drafts/') && method === 'PUT') {
      const saved = JSON.parse(options.body).draft;
      drafts = [...drafts.filter((draft) => draft.id !== saved.id), saved];
      return new Response(JSON.stringify({ draft: saved }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.startsWith('/api/social/drafts/') && method === 'DELETE') {
      const draftId = decodeURIComponent(path.split('/').pop());
      drafts = drafts.filter((draft) => draft.id !== draftId);
      if (!deletedIds.includes(draftId)) deletedIds.push(draftId);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  try {
    await storePut('drafts', localNewer.id, localNewer);
    await storePut('drafts', localStale.id, localStale);
    assert.equal(await syncComposeDraftsWithServer(), true);

    let localDrafts = await listLocalComposeDrafts();
    assert.equal(localDrafts.find((draft) => draft.id === localNewer.id).text, 'local newer');
    assert.equal(localDrafts.find((draft) => draft.id === remoteNewer.id).text, 'remote newer');
    assert.equal(localDrafts.find((draft) => draft.id === remoteOnly.id).text, 'phone draft');
    assert.equal(localDrafts.some((draft) => draft.id === localStale.id), false);
    assert.equal(drafts.find((draft) => draft.id === localNewer.id).text, 'local newer');

    serverReady = false;
    await assert.rejects(deleteComposeDraft(remoteOnly.id), /server unavailable/);
    assert.equal((await listLocalComposeDrafts()).some((draft) => draft.id === remoteOnly.id), false);
    serverReady = true;
    assert.equal(await syncComposeDraftsWithServer(), true);
    localDrafts = await listLocalComposeDrafts();
    assert.equal(localDrafts.some((draft) => draft.id === remoteOnly.id), false);
    assert.equal(drafts.some((draft) => draft.id === remoteOnly.id), false);
    assert.ok(deletedIds.includes(remoteOnly.id));
    assert.deepEqual(calls.slice(-2).map((call) => call.method), ['DELETE', 'GET']);
  } finally {
    globalThis.fetch = originalFetch;
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
  }
});
