export const mockMastodonConvo = {
  id: 'convo_fedi_1',
  unread: true,
  accounts: [
    {
      id: '99',
      username: 'claire',
      acct: 'claire@pixelfed.social',
      display_name: 'Claire',
      avatar: 'https://pixelfed.social/storage/avatars/claire.png',
      url: 'https://pixelfed.social/claire',
    },
  ],
  last_status: {
    id: 'st_dm_1',
    uri: 'https://pixelfed.social/p/claire/1',
    created_at: '2026-11-18T11:45:00.000Z',
    content: '<p>@davy Hey, did the static PWA ship yet?</p>',
    visibility: 'direct',
    account: {
      id: '99',
      username: 'claire',
      acct: 'claire@pixelfed.social',
      display_name: 'Claire',
      avatar: 'https://pixelfed.social/storage/avatars/claire.png',
      url: 'https://pixelfed.social/claire',
    },
  },
};

export const mockBskyConvo = {
  id: 'convo_bsky_1',
  rev: '222',
  unreadCount: 1,
  status: 'accepted',
  members: [
    {
      did: 'did:plc:peer999',
      handle: 'peer.bsky.social',
      displayName: 'Peer',
      avatar: 'https://cdn.bsky.app/img/avatar/plain/did:plc:peer999/cid@jpeg',
    },
  ],
  lastMessage: {
    id: 'msg_bsky_1',
    text: 'Check out Bridgy Fed bridging!',
    sentAt: '2026-11-18T11:50:00.000Z',
  },
};
