import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { TASTE_HIDE_THRESHOLD } from '../web/core/feedRanker.js';
import { fetchDiscoveryInstanceTimeline } from '../web/queries/feedHarvester.js';
import { applyPostInterestFeedback } from '../web/state/feedStore.js';

test('TASTE_HIDE_THRESHOLD is exported as -0.4', () => {
  assert.equal(TASTE_HIDE_THRESHOLD, -0.4);
});

test('fetchDiscoveryInstanceTimeline falls back to local timeline when trends returns empty', async () => {
  const requestedUrls = [];
  const sampleStatus = {
    id: '113500000000000001',
    created_at: '2026-11-25T20:00:00.000Z',
    content: '<p>Hello from seattle.pink local timeline</p>',
    url: 'https://seattle.pink/@alice/113500000000000001',
    uri: 'https://seattle.pink/users/alice/statuses/113500000000000001',
    account: {
      id: '1',
      username: 'alice',
      acct: 'alice',
      display_name: 'Alice',
      url: 'https://seattle.pink/@alice',
      avatar: 'https://seattle.pink/avatars/alice.png',
    },
    media_attachments: [],
    mentions: [],
    tags: [],
    reblogs_count: 1,
    favourites_count: 2,
    replies_count: 0,
  };

  const fetchImpl = async (url) => {
    const urlStr = String(url);
    requestedUrls.push(urlStr);
    if (urlStr.includes('/api/v1/trends/statuses')) {
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (urlStr.includes('/api/v1/timelines/public') && urlStr.includes('local=true')) {
      return new Response(JSON.stringify([sampleStatus]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('[]', { status: 404, headers: { 'content-type': 'application/json' } });
  };

  const res = await fetchDiscoveryInstanceTimeline({
    host: 'seattle.pink',
    stream: 'trends',
    fetchImpl,
  });

  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].id, '113500000000000001');
  assert.ok(requestedUrls.some((u) => u.includes('/api/v1/trends/statuses')));
  assert.ok(requestedUrls.some((u) => u.includes('/api/v1/timelines/public') && u.includes('local=true')));
});

test('applyPostInterestFeedback dispatches sanctuary:taste-changed for not_interested', async () => {
  const dom = installMockDom();
  const dispatched = [];
  const origDispatch = globalThis.dispatchEvent;
  globalThis.dispatchEvent = (evt) => {
    dispatched.push(evt?.type);
    return typeof origDispatch === 'function' ? origDispatch.call(globalThis, evt) : true;
  };

  try {
    await applyPostInterestFeedback(
      {
        id: 'bsky:at://did:plc:sportsfan/app.bsky.feed.post/123',
        protocol: 'bluesky',
        content_text: 'Big Seahawks football game touchdown tonight in Seattle!',
        date_published: '2026-11-25T20:00:00.000Z',
        author: {
          id: 'did:plc:sportsfan',
          handle: 'sportsfan.bsky.social',
          name: 'Sports Fan',
        },
      },
      'not_interested'
    );
    assert.ok(dispatched.includes('sanctuary:taste-changed'));
  } finally {
    globalThis.dispatchEvent = origDispatch;
    dom.restore?.();
  }
});
