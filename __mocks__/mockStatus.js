export const mockMastodonStatus = {
  id: '1122334455',
  uri: 'https://mastodon.social/users/alice/statuses/1122334455',
  url: 'https://mastodon.social/@alice/1122334455',
  created_at: '2026-11-18T12:00:00.000Z',
  content: '<p>Hello <span class="h-card"><a href="https://mastodon.social/@bob" class="u-url mention">@<span>bob</span></a></span>! Check :blobcat:</p>',
  spoiler_text: '',
  visibility: 'public',
  in_reply_to_id: null,
  replies_count: 2,
  reblogs_count: 4,
  favourites_count: 9,
  favourited: false,
  reblogged: false,
  bookmarked: false,
  emojis: [
    {
      shortcode: 'blobcat',
      url: 'https://files.mastodon.social/custom_emojis/blobcat.png',
      static_url: 'https://files.mastodon.social/custom_emojis/blobcat.png',
    },
  ],
  media_attachments: [
    {
      id: 'att_1',
      type: 'image',
      url: 'https://files.mastodon.social/media/sample.png',
      preview_url: 'https://files.mastodon.social/media/sample_small.png',
      description: 'Test landscape image',
    },
  ],
  account: {
    id: '42',
    username: 'alice',
    acct: 'alice',
    display_name: 'Alice',
    avatar: 'https://files.mastodon.social/avatars/alice.png',
    url: 'https://mastodon.social/@alice',
  },
};

export const mockBskyFeedItem = {
  post: {
    uri: 'at://did:plc:alice123/app.bsky.feed.post/3ktest',
    cid: 'bafyreitestcid',
    indexedAt: '2026-11-18T12:05:00.000Z',
    author: {
      did: 'did:plc:alice123',
      handle: 'alice.bsky.social',
      displayName: 'Alice Bsky',
      avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:alice123/cid@jpeg',
    },
    record: {
      text: 'Shipping the pure-static SPA today!',
      createdAt: '2026-11-18T12:05:00.000Z',
    },
    replyCount: 1,
    repostCount: 3,
    likeCount: 12,
    viewer: {},
  },
};
