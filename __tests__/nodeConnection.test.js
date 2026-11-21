import test from 'node:test';
import assert from 'node:assert/strict';

import { mockMobileHealthOnline, mockRuntimeConfig } from '../__mocks__/mockProgram.js';
import {
  checkSanctuaryHealth,
  connectionStore,
  initSanctuaryConnection,
  onSanctuaryEvent,
  resetConnectionStoreForTests,
  setSanctuaryBasicAuth,
  setSanctuaryNodeUrl,
  stopSanctuaryConnection,
} from '../web/state/sanctuary/connection.js';
import {
  kvGet,
  kvSet,
  loadVaultSecret,
  resetMemoryStorageForTests,
} from '../web/storage/kvStorage.js';

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
    const onlineState = await setSanctuaryNodeUrl('https://100.64.0.10:5000', {
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

test('network Sanctuary connections reject ordinary LAN HTTP before sending requests', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();
  let fetchCalls = 0;

  await assert.rejects(
    () => setSanctuaryNodeUrl('http://192.168.1.10:5000', {
      pollIntervalMs: 0,
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error('HTTP request should not be sent');
      },
    }),
    /HTTPS is required/
  );
  assert.equal(fetchCalls, 0);

  await kvSet('sanctuary_node_url', 'http://192.168.1.10:5000');
  const savedState = await initSanctuaryConnection({
    pollIntervalMs: 0,
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('HTTP request should not be sent');
    },
  });
  assert.equal(savedState.mode, 'offline');
  assert.equal(savedState.nodeUrl, '');
  assert.match(savedState.error, /HTTPS is required/);
  assert.equal(fetchCalls, 0);
});

test('Sanctuary Basic Auth is encrypted in the local vault and legacy plaintext migrates', async () => {
  resetMemoryStorageForTests();
  resetConnectionStoreForTests();

  const username = 'sanctuary-user';
  const password = 'sanctuary-password';
  const authHeader = `Basic ${btoa(`${username}:${password}`)}`;
  await setSanctuaryBasicAuth(username, password);
  assert.equal(connectionStore.get().authHeaders.Authorization, authHeader);
  assert.equal(await kvGet('sanctuary_auth_header', ''), '');
  assert.deepEqual(await loadVaultSecret('sanctuary_server_basic_auth'), {
    authorization: authHeader,
  });

  await kvSet('sanctuary_node_url', 'http://127.0.0.1:5000');
  await kvSet('sanctuary_auth_header', authHeader);
  const mockFetch = async (url, options = {}) => {
    assert.equal(new Headers(options.headers).get('Authorization'), authHeader);
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
  await initSanctuaryConnection({
    pollIntervalMs: 0,
    fetchImpl: mockFetch,
  });
  assert.equal(await kvGet('sanctuary_auth_header', ''), '');
  assert.deepEqual(await loadVaultSecret('sanctuary_server_basic_auth'), {
    authorization: authHeader,
  });
  stopSanctuaryConnection();
});
