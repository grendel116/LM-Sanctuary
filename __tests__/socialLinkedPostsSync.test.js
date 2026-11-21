import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findUniqueCrossPostMatches,
  syncLinkedPostsWithSanctuary,
} from '../web/queries/socialClient.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import {
  findLocalLinkedPost,
  resetMemoryStorageForTests,
  saveLocalLinkedPost,
} from '../web/storage/nativeStore.js';

test('cross-post recovery matches only unique exact-text posts within ten minutes', () => {
  const primary = [
    { id: 'm1', content_text: 'A uniquely identifying post shared across networks.', date_published: '2026-11-20T10:00:00Z' },
    { id: 'm2', content_text: 'Repeated identical text that should remain ambiguous.', date_published: '2026-11-20T10:01:00Z' },
    { id: 'm3', content_text: 'Repeated identical text that should remain ambiguous.', date_published: '2026-11-20T10:02:00Z' },
  ];
  const secondary = [
    { id: 'b1', content_text: 'A uniquely identifying post shared across networks.', date_published: '2026-11-20T10:03:00Z' },
    { id: 'b2', content_text: 'Repeated identical text that should remain ambiguous.', date_published: '2026-11-20T10:02:00Z' },
  ];

  const matches = findUniqueCrossPostMatches(primary, secondary);
  assert.deepEqual([...matches.keys()], ['m1']);
  assert.equal(matches.get('m1').id, 'b1');
});

test('linked-post sync merges local and server mappings and imports remote-only records', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();
  connectionStore.set({
    mode: 'offline',
    nodeUrl: 'http://127.0.0.1:5000',
  });

  const localRecord = {
    canonicalId: 'mastodon:shared',
    mastodonStatusId: 'shared',
    mastodonInstance: 'https://mastodon.social',
    threadsPostId: 'threads-shared',
    updatedAt: 2,
  };
  const remoteRecord = {
    canonicalId: 'mastodon:shared',
    mastodonStatusId: 'shared',
    mastodonInstance: 'https://mastodon.social',
    blueskyUri: 'at://did:plc:user/app.bsky.feed.post/shared',
    blueskyCid: 'shared-cid',
    updatedAt: 1,
  };
  const remoteOnly = {
    canonicalId: 'mastodon:remote',
    mastodonStatusId: 'remote',
    blueskyUri: 'at://did:plc:user/app.bsky.feed.post/remote',
  };
  const localOnly = {
    canonicalId: 'mastodon:local',
    mastodonStatusId: 'local',
    threadsPostId: 'threads-local',
  };
  let serverRecords = [remoteRecord, remoteOnly];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const path = new URL(String(url)).pathname;
    const method = options.method || 'GET';
    if (path === '/api/social/linked-posts' && method === 'GET') {
      return new Response(JSON.stringify({ records: serverRecords, deletedIds: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.startsWith('/api/social/linked-posts/') && method === 'PUT') {
      const saved = JSON.parse(options.body).record;
      serverRecords = [...serverRecords.filter((record) => record.canonicalId !== saved.canonicalId), saved];
      return new Response(JSON.stringify({ record: saved }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (path.startsWith('/api/social/linked-posts/') && method === 'DELETE') {
      const id = decodeURIComponent(path.split('/').pop());
      serverRecords = serverRecords.filter((record) => record.canonicalId !== id);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  };

  try {
    await saveLocalLinkedPost(localRecord);
    await saveLocalLinkedPost(localOnly);
    assert.equal(await syncLinkedPostsWithSanctuary(), true);

    const merged = await findLocalLinkedPost(localRecord.canonicalId);
    assert.equal(merged.blueskyUri, remoteRecord.blueskyUri);
    assert.equal(merged.threadsPostId, localRecord.threadsPostId);
    assert.ok(serverRecords.some((record) => record.canonicalId === localOnly.canonicalId));
    assert.equal((await findLocalLinkedPost(remoteOnly.canonicalId)).blueskyUri, remoteOnly.blueskyUri);
  } finally {
    globalThis.fetch = originalFetch;
    resetConnectionStoreForTests();
    resetMemoryStorageForTests();
  }
});
