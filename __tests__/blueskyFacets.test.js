import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { createAppShell } from '../web/app/_layout.js';
import { createPostCard } from '../web/components/PostCard.js';
import {
  bskyRequest,
  extractUtf8ByteFacets,
  normalizeBskyPost,
  renderBskyRichTextToHtml,
} from '../web/queries/bluesky.js';
import {
  sanitizeFediverseHtmlToString,
} from '../web/queries/fediverse.js';
import {
  publishThreadsPost,
  resolveThreadsMediaUrl,
} from '../web/queries/threads.js';
import { browserStore, resetBrowserStoreForTests } from '../web/state/browserStore.js';
import { resetCompose } from '../web/state/composeStore.js';
import { feedStore, resetFeedStoreForTests, setStreamItems } from '../web/state/feedStore.js';
import { resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

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

test('normalizeBskyPost and PostCard convert UTF-8 record.facets and external link cards into clickable links without triggering thread navigation', () => {
  const dom = installMockDom();
  try {
    const postText = 'Good morning 🌹 🎶 🕊️\n\nyoutu.be/JLjyYDakdXo?...';
    const encoder = new TextEncoder();
    const bytes = encoder.encode(postText);
    const token = 'youtu.be/JLjyYDakdXo?...';
    const prefix = 'Good morning 🌹 🎶 🕊️\n\n';
    const byteStart = encoder.encode(prefix).byteLength;
    const byteEnd = byteStart + encoder.encode(token).byteLength;
    assert.equal(new TextDecoder().decode(bytes.subarray(byteStart, byteEnd)), token);

    const html = renderBskyRichTextToHtml(postText, [
      {
        index: { byteStart, byteEnd },
        features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://youtu.be/JLjyYDakdXo?si=test123' }],
      },
    ]);
    assert.ok(html.includes('href="https://youtu.be/JLjyYDakdXo?si=test123"'));
    assert.ok(html.includes('>youtu.be/JLjyYDakdXo?...</a>'));

    const normalized = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:abc/app.bsky.feed.post/xyz',
        cid: 'bafy123',
        author: {
          did: 'did:plc:abc',
          handle: 'redheaddeadhead.bsky.social',
          displayName: 'redheaddeadhead.bsky.social',
        },
        record: {
          text: postText,
          createdAt: '2026-11-19T10:00:00Z',
          facets: [
            {
              index: { byteStart, byteEnd },
              features: [{ $type: 'app.bsky.richtext.facet#link', uri: 'https://youtu.be/JLjyYDakdXo?si=test123' }],
            },
          ],
        },
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: {
            uri: 'https://youtu.be/JLjyYDakdXo?si=test123',
            title: 'Morning Song',
            description: 'Live acoustic session',
            thumb: 'https://cdn.bsky.app/img/thumb.jpg',
          },
        },
      },
    });

    let openedThread = 0;
    const card = createPostCard(normalized, {
      onOpenThread: () => {
        openedThread += 1;
      },
    });

    const bodyLink = card.querySelector('.post-body-html a');
    assert.ok(bodyLink);
    assert.equal(bodyLink.getAttribute('href'), 'https://youtu.be/JLjyYDakdXo?si=test123');
    assert.equal(bodyLink.getAttribute('target'), '_blank');
    assert.equal(bodyLink.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(bodyLink.textContent, 'youtu.be/JLjyYDakdXo?...');

    const previewCard = card.querySelector('.post-link-card.post-embed-card');
    assert.ok(previewCard);
    const metaLink = previewCard.querySelector('a.post-embed-meta-link');
    assert.ok(metaLink);
    assert.equal(metaLink.getAttribute('href'), 'https://youtu.be/JLjyYDakdXo?si=test123');
    assert.equal(previewCard.querySelector('.post-link-card-title')?.textContent, 'Morning Song');
    assert.ok(previewCard.querySelector('button.post-embed-play-btn'));

    bodyLink.click();
    assert.equal(openedThread, 0, 'Clicking an inline link inside PostCard must not open the post thread');
  } finally {
    dom.restore();
  }
});

test('createAppShell opens external post links straight into a new Browser tab (no Quick Peek and no OS browser fallback)', async () => {
  const dom = installMockDom();
  const prevPywebview = globalThis.pywebview;
  const prevOpen = globalThis.open;
  const openedFallback = [];
  const pywebviewCalls = [];
  let app = null;
  let pywebviewReturn = true;

  globalThis.pywebview = {
    api: {
      open_external: async (url) => {
        pywebviewCalls.push(url);
        return pywebviewReturn;
      },
    },
  };
  globalThis.open = (url, target, features) => {
    openedFallback.push({ url, target, features });
    return null;
  };

  try {
    resetMemoryStorageForTests();
    resetConnectionStoreForTests();
    resetFeedStoreForTests();
    resetCompose();
    resetBrowserStoreForTests();

    const doc = dom.document;
    const host = doc.createElement('div');
    host.id = 'app-shell';
    doc.body.appendChild(host);

    setStreamItems('feed', [
      normalizeBskyPost({
        post: {
          uri: 'at://did:plc:abc/app.bsky.feed.post/link1',
          cid: 'bafy_link1',
          author: { did: 'did:plc:abc', handle: 'alice.bsky.social', displayName: 'Alice' },
          record: {
            text: 'Check https://example.org/watch?utm_source=bsky&v=1',
            createdAt: '2026-11-19T10:30:00Z',
          },
        },
      }),
    ], null);

    app = createAppShell(host, { initialTab: 'home', skipBackgroundInit: true });
    const link = host.querySelector('.post-body-html a');
    assert.ok(link);
    assert.equal(link.getAttribute('href'), 'https://example.org/watch?utm_source=bsky&v=1');

    // Regular external post link opens straight into a new Browser tab with tracking params stripped and no OS browser fallback
    link.click();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(doc.title, 'Browser');
    assert.equal(host.querySelector('.quick-peek-overlay'), null);
    assert.equal(host.querySelector('.browser-os-link-btn'), null);
    const activeTab = browserStore.get().tabs.find((t) => t.id === browserStore.get().activeTabId);
    assert.equal(activeTab?.url, 'https://example.org/watch?v=1');
    assert.equal(pywebviewCalls.length, 0);
    assert.equal(openedFallback.length, 0);
  } finally {
    app?.destroy();
    resetBrowserStoreForTests();
    globalThis.pywebview = prevPywebview;
    globalThis.open = prevOpen;
    dom.restore();
  }
});

test('normalizeBskyPost and PostCard render Bluesky native videos, recordWithMedia quote cards, and inline Tenor GIFs', () => {
  const dom = installMockDom();
  try {
    // 1. Standalone app.bsky.embed.video#view (matching Jonathan Slater's 576x1024 portrait clip)
    const videoPost = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:lzsxyxqebfmpx6jia6wjqgtx/app.bsky.feed.post/vid1',
        cid: 'bafy_vid_post',
        author: {
          did: 'did:plc:lzsxyxqebfmpx6jia6wjqgtx',
          handle: 'jonathanslater.bsky.social',
          displayName: 'Jonathan Slater',
        },
        record: {
          text: 'These two are awesome',
          createdAt: '2026-11-19T13:05:50.945Z',
        },
        embed: {
          $type: 'app.bsky.embed.video#view',
          cid: 'bafkreieoxbiq5jk4ps4v2h7y5kre3nreok3hg2mn4rgluw2lqlujttce7i',
          playlist: 'https://video.bsky.app/watch/did%3Aplc%3Alzsxyxqebfmpx6jia6wjqgtx/bafkreieoxbiq5jk4ps4v2h7y5kre3nreok3hg2mn4rgluw2lqlujttce7i/playlist.m3u8',
          thumbnail: 'https://video.bsky.app/watch/did%3Aplc%3Alzsxyxqebfmpx6jia6wjqgtx/bafkreieoxbiq5jk4ps4v2h7y5kre3nreok3hg2mn4rgluw2lqlujttce7i/thumbnail.jpg',
          aspectRatio: { width: 576, height: 1024 },
          presentation: 'default',
        },
      },
    });

    const videoCard = createPostCard(videoPost, { onOpenThread: () => {} });
    const videoEl = videoCard.querySelector('video.post-media-video');
    assert.ok(videoEl, 'Bluesky video post must render <video>');
    assert.equal(videoEl.getAttribute('width'), '576');
    assert.equal(videoEl.getAttribute('height'), '1024');
    assert.equal(videoEl.getAttribute('loading'), 'lazy');
    assert.equal(videoEl.getAttribute('preload'), 'metadata');
    assert.equal(
      videoEl.getAttribute('poster'),
      'https://video.bsky.app/watch/did%3Aplc%3Alzsxyxqebfmpx6jia6wjqgtx/bafkreieoxbiq5jk4ps4v2h7y5kre3nreok3hg2mn4rgluw2lqlujttce7i/thumbnail.jpg'
    );
    assert.equal(
      videoEl.getAttribute('src'),
      'https://bsky.social/xrpc/com.atproto.sync.getBlob?did=did%3Aplc%3Alzsxyxqebfmpx6jia6wjqgtx&cid=bafkreieoxbiq5jk4ps4v2h7y5kre3nreok3hg2mn4rgluw2lqlujttce7i'
    );
    assert.ok(videoCard.querySelector('.post-media-single.has-video'));

    // 2. recordWithMedia combining a GIF video + quoted post opens quoted thread on click
    const openedTargets = [];
    const quoteVideoPost = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:abc/app.bsky.feed.post/qw1',
        cid: 'bafy_qw1',
        author: { did: 'did:plc:abc', handle: 'quoter.bsky.social', displayName: 'Quoter' },
        record: { text: 'Look at this clip', createdAt: '2026-11-19T14:00:00Z' },
        embed: {
          $type: 'app.bsky.embed.recordWithMedia#view',
          media: {
            $type: 'app.bsky.embed.video#view',
            cid: 'bafk_clip2',
            thumbnail: 'https://video.bsky.app/watch/did%3Aplc%3Aabc/bafk_clip2/thumbnail.jpg',
            aspectRatio: { width: 480, height: 270 },
            presentation: 'gif',
          },
          record: {
            record: {
              $type: 'app.bsky.embed.record#viewRecord',
              uri: 'at://did:plc:orig/app.bsky.feed.post/orig99',
              cid: 'bafy_orig99',
              author: { did: 'did:plc:orig', handle: 'orig.bsky.social', displayName: 'Orig Author' },
              value: { text: 'Original statement being quoted', createdAt: '2026-11-19T12:00:00Z' },
            },
          },
        },
      },
    });
    const quoteCard = createPostCard(quoteVideoPost, {
      onOpenThread: (target) => openedTargets.push(target),
    });
    assert.ok(quoteCard.querySelector('video.post-media-video'));
    const quoteBtn = quoteCard.querySelector('button.post-quote-card');
    assert.ok(quoteBtn, 'Quoted record must render inside .post-quote-card');
    assert.ok(quoteBtn.textContent.includes('Orig Author'));
    assert.ok(quoteBtn.textContent.includes('Original statement being quoted'));
    quoteBtn.click();
    assert.equal(openedTargets.length, 1);
    assert.equal(openedTargets[0].id, 'bluesky:at://did:plc:orig/app.bsky.feed.post/orig99');

    // 3. Animated Tenor .gif external embed renders inline as GIF image rather than link card
    const gifPost = normalizeBskyPost({
      post: {
        uri: 'at://did:plc:abc/app.bsky.feed.post/gif1',
        cid: 'bafy_gif1',
        author: { did: 'did:plc:abc', handle: 'gifuser.bsky.social', displayName: 'GifUser' },
        record: { text: 'Celebration', createdAt: '2026-11-19T14:05:00Z' },
        embed: {
          $type: 'app.bsky.embed.external#view',
          external: {
            uri: 'https://media.tenor.com/abc123/party.gif?ww=498&hh=280',
            title: 'Party',
            description: 'ALT: confetti',
            thumb: 'https://cdn.bsky.app/img/feed_thumbnail/plain/did:plc:abc/thumb@jpeg',
          },
        },
      },
    });
    assert.equal(gifPost.linkCard, null);
    assert.equal(gifPost.media.length, 1);
    assert.equal(gifPost.media[0].mimeType, 'image/gif');
    const gifDom = createPostCard(gifPost, { onOpenThread: () => {} });
    const gifImg = gifDom.querySelector('img.post-media-item');
    assert.ok(gifImg);
    assert.equal(gifImg.getAttribute('src'), 'https://media.tenor.com/abc123/party.gif?ww=498&hh=280');
  } finally {
    dom.restore();
  }
});
