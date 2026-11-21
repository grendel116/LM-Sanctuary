import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authStore,
  getAccountCredentials,
  hydrateAuthStore,
  removeSocialAccount,
  resetAuthStoreForTests,
  syncSocialAccountsWithServer,
  updateAccountTokens,
  upsertSocialAccount,
} from '../web/state/authStore.js';
import { connectionStore, resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests, storeGet } from '../web/storage/kvStorage.js';

test('Sanctuary server sync shares social accounts and token updates without app credentials', async () => {
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetConnectionStoreForTests();

  await upsertSocialAccount(
    { id: 'bluesky:local', platform: 'bluesky', handle: 'local.test' },
    { refreshJwt: 'local-refresh' }
  );
  connectionStore.set({
    mode: 'online',
    nodeUrl: 'http://127.0.0.1:5000',
    authHeaders: { Authorization: 'Basic dXNlcjpwYXNz' },
  });

  const remoteRecord = {
    meta: { id: 'threads:remote', platform: 'threads', handle: 'remote_user', updatedAt: 1 },
    secrets: { accessToken: 'remote-access' },
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    const method = options.method || 'GET';
    calls.push({ url: String(url), method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET') {
      return new Response(JSON.stringify({ accounts: [remoteRecord] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'PUT') {
      return new Response(JSON.stringify(options.body ? JSON.parse(options.body) : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request method ${method}`);
  };

  try {
    assert.equal(await syncSocialAccountsWithServer(), true);
    assert.deepEqual(
      authStore.get().accounts.map((account) => account.id).sort(),
      ['bluesky:local', 'threads:remote']
    );
    assert.equal((await getAccountCredentials('threads:remote')).accessToken, 'remote-access');
    assert.equal(calls[1].method, 'PUT');
    assert.equal(calls[1].body.secrets.refreshJwt, 'local-refresh');

    await updateAccountTokens('threads:remote', { accessToken: 'rotated-access' });
    assert.equal(calls[2].method, 'PUT');
    assert.equal(calls[2].body.secrets.accessToken, 'rotated-access');

    await removeSocialAccount('threads:remote');
    assert.equal(calls[3].method, 'DELETE');
    assert.equal(await getAccountCredentials('threads:remote'), null);
  } finally {
    globalThis.fetch = originalFetch;
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    resetMemoryStorageForTests();
  }
});

test('server-synced credentials stay memory-only and reload from the server without Web Crypto', async () => {
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetConnectionStoreForTests();
  connectionStore.set({
    mode: 'offline',
    nodeUrl: 'http://100.120.44.39:5000',
  });

  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    enumerable: cryptoDescriptor?.enumerable || false,
    writable: true,
    value: { getRandomValues() {} },
  });

  let serverRecord = {
    meta: { id: 'bluesky:remote-http', platform: 'bluesky', handle: 'remote.test', updatedAt: 1 },
    secrets: { accessJwt: 'initial-token', refreshJwt: 'refresh-token' },
  };
  const methods = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const method = options.method || 'GET';
    methods.push(method);
    if (method === 'GET') {
      return new Response(JSON.stringify({ accounts: [serverRecord] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'PUT') {
      serverRecord = JSON.parse(options.body);
      return new Response(JSON.stringify(serverRecord), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request method ${method}`);
  };

  try {
    assert.equal(await syncSocialAccountsWithServer(), true);
    assert.equal((await getAccountCredentials('bluesky:remote-http')).accessJwt, 'initial-token');
    assert.equal(await storeGet('social_vault', 'bluesky:remote-http'), null);

    await updateAccountTokens('bluesky:remote-http', { accessJwt: 'rotated-token' });
    assert.equal(serverRecord.secrets.accessJwt, 'rotated-token');

    resetAuthStoreForTests();
    await hydrateAuthStore();
    assert.equal(await syncSocialAccountsWithServer(), true);
    assert.equal((await getAccountCredentials('bluesky:remote-http')).accessJwt, 'rotated-token');
    assert.deepEqual(methods, ['GET', 'PUT', 'GET']);
  } finally {
    globalThis.fetch = originalFetch;
    if (cryptoDescriptor) {
      Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    } else {
      delete globalThis.crypto;
    }
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    resetMemoryStorageForTests();
  }
});

test('social account deletions queue while the server is unavailable and replay after recovery', async () => {
  resetMemoryStorageForTests();
  resetAuthStoreForTests();
  resetConnectionStoreForTests();

  const accountId = 'bluesky:removed';
  await upsertSocialAccount(
    { id: accountId, platform: 'bluesky', handle: 'removed.test' },
    { refreshJwt: 'refresh-token' }
  );
  connectionStore.set({
    mode: 'online',
    nodeUrl: 'http://127.0.0.1:5000',
    authHeaders: { Authorization: 'Basic dXNlcjpwYXNz' },
  });

  const calls = [];
  let serverReady = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, options = {}) => {
    const method = options.method || 'GET';
    calls.push(method);
    if (!serverReady) {
      return new Response(JSON.stringify({
        error: 'Social vault temporarily unavailable.',
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (method === 'GET') {
      return new Response(JSON.stringify({ accounts: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`Unexpected request method ${method}`);
  };

  try {
    await removeSocialAccount(accountId);
    assert.equal(await getAccountCredentials(accountId), null);
    serverReady = true;
    assert.equal(await syncSocialAccountsWithServer(), true);
    assert.deepEqual(calls, ['DELETE', 'DELETE', 'GET']);
  } finally {
    globalThis.fetch = originalFetch;
    resetConnectionStoreForTests();
    resetAuthStoreForTests();
    resetMemoryStorageForTests();
  }
});
