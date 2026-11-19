import test from 'node:test';
import assert from 'node:assert/strict';

import {
  bskyRequest,
  extractUtf8ByteFacets,
} from '../web/queries/bluesky.js';
import {
  sanitizeFediverseHtmlToString,
} from '../web/queries/fediverse.js';
import {
  publishThreadsPost,
  resolveThreadsMediaUrl,
} from '../web/queries/threads.js';

test('extractUtf8ByteFacets computes exact UTF-8 byte offsets around multi-byte emoji', () => {
  // "Hi 🚀 " -> H(1) i(1) space(1) 🚀(4) space(1) = 8 bytes
  const text = 'Hi 🚀 https://example.org/a @alice.bsky.social #OpenWeb!';
  const facets = extractUtf8ByteFacets(text);
  const bytes = new TextEncoder().encode(text);
  const decodeSlice = (f) => new TextDecoder().decode(bytes.slice(f.index.byteStart, f.index.byteEnd));

  assert.equal(facets.length, 3);
  assert.equal(decodeSlice(facets[0]), 'https://example.org/a');
  assert.equal(facets[0].index.byteStart, 8);
  assert.equal(facets[0].features[0].$type, 'app.bsky.richtext.facet#link');

  assert.equal(decodeSlice(facets[1]), '@alice.bsky.social');
  assert.equal(facets[1]._handle, 'alice.bsky.social');
  assert.equal(facets[1].features[0].$type, 'app.bsky.richtext.facet#mention');

  assert.equal(decodeSlice(facets[2]), '#OpenWeb');
  assert.equal(facets[2].features[0].tag, 'OpenWeb');
});

test('bskyRequest automatically refreshes ExpiredToken JWTs once and persists rotated credentials', async () => {
  const seenTokens = [];
  let savedTokens = null;

  const mockFetch = async (url, init) => {
    const auth = init.headers instanceof Headers
      ? init.headers.get('Authorization')
      : init.headers?.Authorization;
    seenTokens.push(auth);

    if (url.includes('com.atproto.server.refreshSession')) {
      return new Response(
        JSON.stringify({ accessJwt: 'new_access_jwt', refreshJwt: 'new_refresh_jwt' }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (auth === 'Bearer old_access_jwt') {
      return new Response(
        JSON.stringify({ error: 'ExpiredToken', message: 'Token expired' }),
        { status: 400, headers: { 'content-type': 'application/json' } }
      );
    }
    return new Response(
      JSON.stringify({ feed: [], cursor: 'c2' }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  };

  const result = await bskyRequest({
    endpoint: 'app.bsky.feed.getTimeline',
    accessJwt: 'old_access_jwt',
    refreshJwt: 'old_refresh_jwt',
    onSessionRefreshed: async (refreshed) => {
      savedTokens = refreshed;
    },
    fetchImpl: mockFetch,
  });

  assert.deepEqual(result, { feed: [], cursor: 'c2' });
  assert.deepEqual(savedTokens, { accessJwt: 'new_access_jwt', refreshJwt: 'new_refresh_jwt' });
  assert.deepEqual(seenTokens, [
    'Bearer old_access_jwt',
    'Bearer old_refresh_jwt',
    'Bearer new_access_jwt',
  ]);
});

test('sanitizeFediverseHtmlToString strips XSS payloads/attributes while keeping safe links and custom emojis', () => {
  const dirty = [
    '<p onclick="evil()">Hello <script>alert(1)</script>',
    '<a href="javascript:alert(2)">bad link</a>',
    '<a href="https://mastodon.social/@bob" onmouseover="x()">@bob</a>',
    '<img src="http://insecure.local/x.png" class="custom-emoji">',
    ' :cat:</p>',
  ].join('');

  const clean = sanitizeFediverseHtmlToString(dirty, [
    { shortcode: 'cat', url: 'https://cdn.example.org/emojis/cat.png' },
  ]);

  assert.equal(clean.includes('<script'), false);
  assert.equal(clean.includes('alert(1)'), false);
  assert.equal(clean.includes('onclick'), false);
  assert.equal(clean.includes('onmouseover'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.equal(clean.includes('http://insecure.local'), false);
  assert.ok(clean.includes('href="https://mastodon.social/@bob"'));
  assert.ok(clean.includes('rel="noopener noreferrer"'));
  assert.ok(clean.includes('<img class="custom-emoji" src="https://cdn.example.org/emojis/cat.png"'));
});

test('threads cross-post reuses Mastodon HTTPS CDN url and never touches any feed endpoint', async () => {
  assert.equal(
    resolveThreadsMediaUrl(
      { url: '/images/portraits/p1.png' },
      { mastodonUploadedUrl: 'https://cdn.mastodon.social/media/p1.png' }
    ),
    'https://cdn.mastodon.social/media/p1.png'
  );
  assert.equal(
    resolveThreadsMediaUrl(
      { url: '/images/portraits/p1.png' },
      { publicMediaBaseUrl: 'https://media.example.ts.net' }
    ),
    'https://media.example.ts.net/images/portraits/p1.png'
  );
  assert.throws(() => resolveThreadsMediaUrl({ url: '/images/portraits/p1.png' }), Error);

  const calls = [];
  const mockFetch = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body?.toString?.() || '' });
    if (url.endsWith('/threads')) {
      return new Response(JSON.stringify({ id: 'cont_1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('cont_1?fields=id,status')) {
      return new Response(JSON.stringify({ id: 'cont_1', status: 'FINISHED' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify({ id: 'pub_99' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };

  const published = await publishThreadsPost({
    userId: '12345',
    accessToken: 'threads_tok',
    text: 'Cross-post check',
    media: [{ url: '/images/portraits/p1.png', type: 'image', altText: 'Portrait' }],
    mastodonUrls: ['https://cdn.mastodon.social/media/p1.png'],
    pollDelayMs: 0,
    fetchImpl: mockFetch,
  });

  assert.equal(published.id, 'pub_99');
  assert.ok(calls[0].body.includes(encodeURIComponent('https://cdn.mastodon.social/media/p1.png')));
});
