import test from 'node:test';
import assert from 'node:assert/strict';

import { mockMobileHealthOnline, mockRuntimeConfig } from '../__mocks__/mockProgram.js';
import {
  checkSanctuaryHealth,
  connectionStore,
  initSanctuaryConnection,
  onSanctuaryEvent,
  resetConnectionStoreForTests,
  setSanctuaryNodeUrl,
  stopSanctuaryConnection,
} from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

test('initSanctuaryConnection stays completely dormant with zero network calls on standalone installs', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();

  let fetchCalls = 0;
  const spyFetch = async () => {
    fetchCalls += 1;
    throw new Error('Should never be called when dormant');
  };

  const state = await initSanctuaryConnection({
    fetchImpl: spyFetch,
    locationObj: { protocol: 'https:', origin: 'https://client.example.org' },
  });

  assert.equal(state.mode, 'dormant');
  assert.equal(state.nodeUrl, '');
  assert.equal(fetchCalls, 0);
  stopSanctuaryConnection();
});

test('connectionStore emits sanctuary:online and sanctuary:offline across node reachability transitions', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();

  const events = [];
  const offOnline = onSanctuaryEvent('sanctuary:online', (e) => events.push({ type: 'online', detail: e.detail }));
  const offOffline = onSanctuaryEvent('sanctuary:offline', (e) => events.push({ type: 'offline', detail: e.detail }));

  let nodeOnline = true;
  const mockFetch = async (url) => {
    if (!nodeOnline) {
      throw new TypeError('Failed to fetch');
    }
    if (url.endsWith('/api/mobile/health')) {
      return new Response(JSON.stringify(mockMobileHealthOnline), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/api/config')) {
      return new Response(JSON.stringify(mockRuntimeConfig), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected URL ${url}`);
  };

  try {
    const onlineState = await setSanctuaryNodeUrl('http://100.64.0.10:5000', {
      pollIntervalMs: 0,
      fetchImpl: mockFetch,
    });
    assert.equal(onlineState.mode, 'online');
    assert.equal(onlineState.programs.length, 2);
    assert.equal(onlineState.runtimeConfig.local_ip, '192.168.1.42');
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'online');

    // Transition -> offline preserves cached programs list
    nodeOnline = false;
    await checkSanctuaryHealth({ fetchImpl: mockFetch });
    assert.equal(connectionStore.get().mode, 'offline');
    assert.equal(connectionStore.get().programs.length, 2);
    assert.equal(events.length, 2);
    assert.equal(events[1].type, 'offline');

    // Recover -> online fires sanctuary:online again
    nodeOnline = true;
    await checkSanctuaryHealth({ fetchImpl: mockFetch });
    assert.equal(connectionStore.get().mode, 'online');
    assert.equal(events.length, 3);
    assert.equal(events[2].type, 'online');
  } finally {
    offOnline();
    offOffline();
    stopSanctuaryConnection();
  }
});
