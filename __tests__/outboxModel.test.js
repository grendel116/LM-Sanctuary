import test from 'node:test';
import assert from 'node:assert/strict';

import { generatePortraitStream } from '../web/queries/sanctuary.js';
import {
  attachOutboxAutoFlush,
  enqueueTurn,
  flushOutbox,
  outboxStore,
  resetOutboxForTests,
} from '../web/state/sanctuary/outboxModel.js';
import {
  connectionStore,
  emitSanctuaryEvent,
  resetConnectionStoreForTests,
} from '../web/state/sanctuary/connection.js';
import {
  loadProgramSession,
  resetSessionStoreForTests,
  sessionStore,
} from '../web/state/sanctuary/sessionModel.js';
import {
  getCachedProgramHistory,
  resetMemoryStorageForTests,
} from '../web/storage/kvStorage.js';
import { FetchError } from '../web/queries/fetch/FetchError.js';

test('enqueueTurn assigns usr_* client IDs, caches optimistically, and replays FIFO across Programs', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();
  resetOutboxForTests();
  resetSessionStoreForTests();

  connectionStore.set({ mode: 'offline', activeProgram: 'sebile' });

  const turn1 = await enqueueTurn({ programId: 'sebile', sessionId: 'default', message: 'First offline turn' });
  const turn2 = await enqueueTurn({ programId: 'rin', sessionId: 'default', message: 'Second turn for Rin' });
  const turn3 = await enqueueTurn({ programId: 'sebile', sessionId: 'default', message: 'Third turn back on Sebile' });

  assert.match(turn1.msgId, /^usr_[a-f0-9]+$/);
  assert.equal(outboxStore.get().items.length, 3);

  // Loading cached session offline renders optimistic queued turn immediately.
  const offlineSession = await loadProgramSession('sebile', 'default');
  assert.equal(offlineSession.fromCache, true);
  assert.equal(offlineSession.messages.length, 2);
  assert.equal(offlineSession.messages[0].id, turn1.msgId);
  assert.equal(offlineSession.messages[0].queued, true);

  const ops = [];
  const transport = {
    selectProgram: async (programId) => {
      ops.push(`select:${programId}`);
    },
    sendChat: async (payload) => {
      ops.push(`chat:${payload.msg_id}:${payload.message}`);
      return { status: 'success', user_msg_id: payload.msg_id };
    },
  };

  const result = await flushOutbox({ transport });
  assert.deepEqual(result, { flushedCount: 3, remainingCount: 0, haltedOffline: false });
  assert.deepEqual(ops, [
    `chat:${turn1.msgId}:First offline turn`,
    'select:rin',
    `chat:${turn2.msgId}:Second turn for Rin`,
    'select:sebile',
    `chat:${turn3.msgId}:Third turn back on Sebile`,
  ]);
  assert.equal(outboxStore.get().items.length, 0);

  const cachedAfter = await getCachedProgramHistory('sebile', 'default');
  assert.equal(Boolean(cachedAfter.history[0].queued), false);
});

test('flushOutbox halts cleanly preserving FIFO tail on mid-flush Tailscale drop and auto-flushes on sanctuary:online', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();
  resetOutboxForTests();

  connectionStore.set({ mode: 'offline', activeProgram: 'sebile' });

  const t1 = await enqueueTurn({ programId: 'sebile', message: 'One' });
  const t2 = await enqueueTurn({ programId: 'sebile', message: 'Two' });

  let failSecond = true;
  const sentIds = [];
  const transport = {
    selectProgram: async () => {},
    sendChat: async (payload) => {
      if (failSecond && payload.msg_id === t2.msgId) {
        throw new FetchError('Tunnel lost', { status: 0, isTimeout: true });
      }
      sentIds.push(payload.msg_id);
      return { status: 'success' };
    },
  };

  const firstRun = await flushOutbox({ transport });
  assert.equal(firstRun.flushedCount, 1);
  assert.equal(firstRun.remainingCount, 1);
  assert.equal(firstRun.haltedOffline, true);
  assert.deepEqual(sentIds, [t1.msgId]);
  assert.equal(outboxStore.get().items[0].msgId, t2.msgId);

  failSecond = false;
  const detach = attachOutboxAutoFlush({ transport });
  try {
    emitSanctuaryEvent('sanctuary:online', { status: 'online' });
    // Yield microtasks so async flushOutbox resolves.
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(sentIds, [t1.msgId, t2.msgId]);
    assert.equal(outboxStore.get().items.length, 0);
  } finally {
    detach();
  }
});

test('generatePortraitStream decodes split multi-byte UTF-8 NDJSON chunks accurately', async () => {
  const evt1 = JSON.stringify({ type: 'slot', index: 0, image_url: '/images/portraits/s0.png', sender_name: 'Sebilé 🚀' });
  const evt2 = JSON.stringify({ type: 'done', status: 'success', image_urls: ['/images/portraits/s0.png'] });
  const allBytes = new TextEncoder().encode(`${evt1}\n${evt2}\n`);
  // Split right inside the multi-byte emoji sequence to verify streaming TextDecoder.
  const splitIdx = allBytes.indexOf(0xf0) + 2;
  const partA = allBytes.slice(0, splitIdx);
  const partB = allBytes.slice(splitIdx);

  const mockFetch = async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(partA);
        controller.enqueue(partB);
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'application/x-ndjson' },
    });
  };

  const received = [];
  const last = await generatePortraitStream(
    { session_id: 'default', prompt: 'neon rain' },
    {
      nodeUrl: 'http://127.0.0.1:5000',
      fetchImpl: mockFetch,
      onEvent: (evt) => received.push(evt),
    }
  );

  assert.equal(received.length, 2);
  assert.equal(received[0].sender_name, 'Sebilé 🚀');
  assert.equal(last.type, 'done');
});
