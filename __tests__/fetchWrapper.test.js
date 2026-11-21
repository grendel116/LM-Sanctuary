import test from 'node:test';
import assert from 'node:assert/strict';

import { FetchError } from '../web/queries/fetch/FetchError.js';
import { fetchWrapper, formatApiErrorMessage } from '../web/queries/fetch/fetchWrapper.js';

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

test('formatApiErrorMessage and fetchWrapper strip raw OAuth JSON/trace IDs and clarify Threads subcode 5258005', async () => {
  const raw5258005 =
    'Threads token refresh failed (400): {"error":{"message":"API access blocked.","code":200,"type":"OAuthException","error_subcode":5258005,"fbtrace_id":"A_V9nKjl9qQa06wFPx_F164"}}';
  assert.equal(
    formatApiErrorMessage(raw5258005),
    'Threads token refresh failed (400): API access blocked. 60-day tokens must be at least 24 hours old before refreshing.'
  );

  const truncatedRaw =
    'Threads publish failed (400): {"error":{"message":"The requested resource does not exist","code":24,"type":"OAuthException","error_subcode":4279009,"is_transient":false,"error_user_msg":"The media with id 17993710425118777 cannot be found.","error_user_title":"Media Not Found","f';
  assert.equal(
    formatApiErrorMessage(truncatedRaw),
    'Threads publish failed (400): The media with id 17993710425118777 cannot be found.'
  );

  const mockFetch = async () => new Response(
    JSON.stringify({ error: raw5258005 }),
    { status: 400, headers: { 'content-type': 'application/json' } }
  );

  await assert.rejects(
    () => fetchWrapper('/api/social/accounts/threads/oauth/refresh', { method: 'POST', fetchImpl: mockFetch }),
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.equal(
        err.message,
        'Threads token refresh failed (400): API access blocked. 60-day tokens must be at least 24 hours old before refreshing.'
      );
      assert.equal(err.message.includes('fbtrace_id'), false);
      return true;
    }
  );
});
