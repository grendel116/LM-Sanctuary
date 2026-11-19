import test from 'node:test';
import assert from 'node:assert/strict';

import { FetchError } from '../web/queries/fetch/FetchError.js';
import { fetchWrapper } from '../web/queries/fetch/fetchWrapper.js';

test('fetchWrapper distinguishes deadline timeout from user AbortController cancellation', async () => {
  const hangingFetch = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
  });

  await assert.rejects(
    () => fetchWrapper('https://mastodon.social/api/v1/instance', {
      timeoutMs: 25,
      fetchImpl: hangingFetch,
    }),
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.equal(err.isTimeout, true);
      assert.equal(err.isAborted, false);
      assert.equal(err.cause?.name, 'TimeoutError');
      return true;
    }
  );

  const userController = new AbortController();
  const promise = fetchWrapper('https://mastodon.social/api/v1/instance', {
    signal: userController.signal,
    timeoutMs: 5000,
    fetchImpl: hangingFetch,
  });
  userController.abort();

  await assert.rejects(
    () => promise,
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.equal(err.isAborted, true);
      assert.equal(err.isTimeout, false);
      assert.equal(err.cause?.name, 'AbortError');
      return true;
    }
  );
});

test('fetchWrapper sets priority: "low" for background requests and targetAddressSpace on https->LAN', async () => {
  let capturedInit = null;
  const mockFetch = async (_url, init) => {
    capturedInit = init;
    return new Response(JSON.stringify({ status: 'online' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const data = await fetchWrapper('http://192.168.1.42:5000/api/mobile/health', {
    background: true,
    locationObj: { protocol: 'https:' },
    fetchImpl: mockFetch,
  });

  assert.deepEqual(data, { status: 'online' });
  assert.equal(capturedInit.priority, 'low');
  assert.equal(capturedInit.targetAddressSpace, 'local');
  assert.equal('importance' in capturedInit, false);

  await fetchWrapper('http://127.0.0.1:5000/api/health', {
    locationObj: { protocol: 'https:' },
    fetchImpl: mockFetch,
  });
  assert.equal(capturedInit.targetAddressSpace, 'loopback');
});

test('fetchWrapper parses HTTP error JSON payloads into FetchError status and body', async () => {
  const mockFetch = async () => new Response(
    JSON.stringify({ error: 'Token expired' }),
    { status: 401, headers: { 'content-type': 'application/json' } }
  );

  await assert.rejects(
    () => fetchWrapper('https://bsky.social/xrpc/app.bsky.feed.getTimeline', { fetchImpl: mockFetch }),
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.equal(err.status, 401);
      assert.equal(err.message, 'Token expired');
      assert.deepEqual(err.body, { error: 'Token expired' });
      return true;
    }
  );
});
