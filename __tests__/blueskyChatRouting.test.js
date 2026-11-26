import test from 'node:test';
import assert from 'node:assert/strict';

import { bskyPdsFromDidDoc } from '../web/constants/endpoints.js';
import {
  acceptBskyConvo,
  describeBskyChatRefusal,
  getBskyConvoForMembers,
  getBskyConvoMessages,
  listBskyConvos,
  sendBskyConvoMessage,
} from '../web/queries/bluesky.js';
import { FetchError, describeFetchError } from '../web/queries/fetch/FetchError.js';

function readHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return String(v);
  }
  return '';
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('all five Bluesky chat methods route to the caller PDS with Atproto-Proxy and Bearer token', async () => {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return jsonResponse({ ok: true });
  };
  const auth = {
    serviceUrl: 'https://pds.example.com',
    accessJwt: 'tok',
    fetchImpl,
  };

  await getBskyConvoForMembers({ ...auth, members: ['did:plc:a', 'did:plc:b'] });
  await listBskyConvos(auth);
  await getBskyConvoMessages({ ...auth, convoId: 'c1' });
  await sendBskyConvoMessage({ ...auth, convoId: 'c1', text: 'hi' });
  await acceptBskyConvo({ ...auth, convoId: 'c1' });

  assert.equal(calls.length, 5);
  for (const call of calls) {
    const parsed = new URL(call.url);
    assert.equal(parsed.origin, 'https://pds.example.com');
    assert.equal(readHeader(call.init.headers, 'Atproto-Proxy'), 'did:web:api.bsky.chat#bsky_chat');
    assert.equal(readHeader(call.init.headers, 'Authorization'), 'Bearer tok');
  }
});

test('sendBskyConvoMessage refreshes expired token on PDS origin without ReferenceError', async () => {
  const calls = [];
  let msgAttempts = 0;
  const fetchImpl = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u.endsWith('/xrpc/com.atproto.server.refreshSession')) {
      return jsonResponse({ accessJwt: 'new', refreshJwt: 'r2' }, 200);
    }
    msgAttempts += 1;
    if (msgAttempts === 1) {
      return jsonResponse({ error: 'ExpiredToken', message: 'Token has expired' }, 401);
    }
    return jsonResponse({ id: 'm1' }, 200);
  };

  const res = await sendBskyConvoMessage({
    serviceUrl: 'https://pds.example.com',
    accessJwt: 'old',
    refreshJwt: 'r1',
    convoId: 'c1',
    text: 'hello',
    fetchImpl,
  });

  assert.equal(res.id, 'm1');
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url, 'https://pds.example.com/xrpc/com.atproto.server.refreshSession');
  assert.equal(readHeader(calls[2].init.headers, 'Authorization'), 'Bearer new');
});

test('bskyPdsFromDidDoc extracts PDS origin or returns empty string', () => {
  const origin = bskyPdsFromDidDoc({
    service: [
      {
        id: '#atproto_pds',
        type: 'AtprotoPersonalDataServer',
        serviceEndpoint: 'https://brittlegill.us-west.host.bsky.network',
      },
    ],
  });
  assert.equal(origin, 'https://brittlegill.us-west.host.bsky.network');
  assert.equal(bskyPdsFromDidDoc(null), '');
});

test('describeFetchError includes HTTP status, host, and pathname for FetchError', () => {
  const err = new FetchError('MethodNotImplemented', {
    status: 501,
    url: 'https://bsky.social/xrpc/chat.bsky.convo.getConvoForMembers?members=x',
  });
  assert.equal(
    describeFetchError(err),
    'MethodNotImplemented (HTTP 501 from bsky.social/xrpc/chat.bsky.convo.getConvoForMembers)'
  );
  assert.equal(describeFetchError(new Error('x')), 'x');
  assert.equal(describeFetchError(null, 'fallback'), 'fallback');
});

test('describeBskyChatRefusal formats known Bluesky chat refusals and ignores unknown errors', () => {
  const err = new FetchError('NotFollowedBySender', {
    status: 400,
    url: 'https://goldenear.us-west.host.bsky.network/xrpc/chat.bsky.convo.getConvoForMembers',
    body: {
      error: 'NotFollowedBySender',
      message: 'recipient requires incoming messages to come from someone they follow',
    },
  });
  assert.equal(
    describeBskyChatRefusal(err, 'plasticmgzn.bsky.social'),
    '@plasticmgzn.bsky.social only accepts messages from people they follow.'
  );

  assert.equal(
    describeBskyChatRefusal(
      { body: { error: 'InvalidRequest', message: 'recipient has disabled incoming messages' } },
      '@alice.bsky.social'
    ),
    '@alice.bsky.social has turned off direct messages.'
  );

  assert.equal(
    describeBskyChatRefusal({ body: { error: 'BlockedActor' } }),
    "You can't message this account because one of you has blocked the other."
  );

  assert.equal(describeBskyChatRefusal({ body: { error: 'InternalServerError' } }), '');
  assert.equal(describeBskyChatRefusal(new Error('x')), '');
  assert.equal(describeBskyChatRefusal(null), '');
});

test('getBskyConvoForMembers preserves parsed JSON body on 400 FetchError for refusal handling', async () => {
  const fetchImpl = async () => jsonResponse(
    { error: 'NotFollowedBySender', message: 'recipient requires incoming messages to come from someone they follow' },
    400
  );
  await assert.rejects(
    () => getBskyConvoForMembers({
      serviceUrl: 'https://goldenear.us-west.host.bsky.network',
      accessJwt: 'tok',
      members: ['did:plc:a', 'did:plc:b'],
      fetchImpl,
    }),
    (err) => {
      assert.ok(err instanceof FetchError);
      assert.equal(err.body?.error, 'NotFollowedBySender');
      return true;
    }
  );
});
