import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mountMessagesScreen } from '../web/app/messages.js';
import { resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function setupAccounts() {
  resetAuthStoreForTests();
  await upsertSocialAccount(
    {
      id: 'fedi_dm_1',
      platform: 'fediverse',
      instanceUrl: 'https://mastodon.social',
      userId: 'u_me',
      handle: 'me',
      acct: 'me@mastodon.social',
    },
    { accessToken: 'tok_fedi' }
  );
  await upsertSocialAccount(
    {
      id: 'bsky_dm_1',
      platform: 'bluesky',
      serviceUrl: 'https://pds.example.com',
      did: 'did:plc:me',
      handle: 'me.bsky.social',
      acct: 'me.bsky.social',
    },
    { accessJwt: 'jwt_bsky', refreshJwt: 'ref_bsky' }
  );
}

test('Direct Messages: local suggestions, unread badges, mark-as-read, getLog polling, and Mastodon-only media upload', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;

  let bskyLogs = [];
  let bskyCursor = 'c1';
  let bskyConvosList = [
    {
      id: 'b_convo_1',
      status: 'accepted',
      unreadCount: 2,
      members: [
        { did: 'did:plc:me', handle: 'me.bsky.social', displayName: 'Me' },
        { did: 'did:plc:alice', handle: 'alice.bsky.social', displayName: 'Alice' },
      ],
      lastMessage: { text: 'Hey from Bluesky' },
    },
  ];
  let listConvosCount = 0;
  let updateReadCalls = [];
  let fediReadCalls = [];
  let uploadCalls = 0;
  let statusPayloads = [];

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = (init.method || 'GET').toUpperCase();
    if (u.includes('/api/v1/conversations/') && u.endsWith('/read') && method === 'POST') {
      fediReadCalls.push(u);
      return jsonResponse({ id: 'f_convo_1', unread: false });
    }
    if (u.includes('/api/v1/conversations')) {
      return jsonResponse([
        {
          id: 'f_convo_1',
          unread: true,
          accounts: [
            {
              id: 'u_bob',
              username: 'bob',
              acct: 'bob@mastodon.social',
              display_name: 'Bob',
              avatar: '',
            },
          ],
          last_status: {
            id: 'st_1',
            content: '<p>Hi from Mastodon</p>',
            created_at: '2026-11-25T10:00:00.000Z',
            account: { id: 'u_bob', acct: 'bob@mastodon.social', username: 'bob', display_name: 'Bob' },
          },
        },
      ]);
    }
    if (u.includes('/api/v1/statuses/st_1/context')) {
      return jsonResponse({ ancestors: [], descendants: [] });
    }
    if (u.includes('/api/v2/media') && method === 'POST') {
      uploadCalls += 1;
      return jsonResponse({ id: 'm_up_1', url: 'https://mastodon.social/media/1.png', type: 'image' });
    }
    if (u.includes('/api/v1/statuses') && method === 'POST') {
      statusPayloads.push(JSON.parse(init.body || '{}'));
      return jsonResponse({
        id: 'st_2',
        content: '<p>pic</p>',
        created_at: '2026-11-25T10:01:00.000Z',
        media_attachments: [{ id: 'm_up_1', url: 'https://mastodon.social/media/1.png', type: 'image' }],
        account: { id: 'u_me', acct: 'me@mastodon.social', username: 'me', display_name: 'Me' },
      });
    }
    if (u.includes('/xrpc/chat.bsky.convo.listConvos')) {
      listConvosCount += 1;
      return jsonResponse({ convos: bskyConvosList });
    }
    if (u.includes('/xrpc/chat.bsky.convo.getLog')) {
      return jsonResponse({ cursor: bskyCursor, logs: bskyLogs });
    }
    if (u.includes('/xrpc/chat.bsky.convo.updateRead') && method === 'POST') {
      updateReadCalls.push(JSON.parse(init.body || '{}'));
      return jsonResponse({ convo: { id: 'b_convo_1', unreadCount: 0 } });
    }
    if (u.includes('/xrpc/chat.bsky.convo.getMessages')) {
      return jsonResponse({ messages: [] });
    }
    return jsonResponse({});
  };

  let ctrl = null;
  try {
    await setupAccounts();
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    ctrl = mountMessagesScreen(host, {
      onOpenCompose: () => {},
      onOpenAccounts: () => {},
    });
    await new Promise((r) => setTimeout(r, 40));

    // 1. Unread badges rendered inside avatarWrap
    const humanRows = Array.from(host.querySelectorAll('.convo-row--human'));
    assert.equal(humanRows.length, 2);
    assert.ok(humanRows.every((r) => r.classList.contains('is-unread')));
    assert.ok(humanRows.every((r) => r.querySelector('.convo-avatar-wrap .convo-badge')));

    // 2. Local handle suggestions match both Bluesky (handle/displayName) and Fediverse
    const handleInput = host.querySelector('input[aria-label="Recipient handle"]');
    assert.ok(handleInput);
    handleInput.dispatchEvent(new Event('focus'));
    handleInput.value = 'ali';
    handleInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 270));
    let suggestText = Array.from(host.querySelectorAll('.search-suggest-item')).map((el) => el.textContent).join(' | ');
    assert.ok(suggestText.includes('Alice') && suggestText.includes('@alice.bsky.social'), suggestText);

    handleInput.value = 'bob';
    handleInput.dispatchEvent(new Event('input'));
    await new Promise((r) => setTimeout(r, 270));
    suggestText = Array.from(host.querySelectorAll('.search-suggest-item')).map((el) => el.textContent).join(' | ');
    assert.ok(suggestText.includes('Bob') && suggestText.includes('@bob@mastodon.social'), suggestText);

    // 3. Delta polling via getLog skips listConvos when logs are empty, refreshes when non-empty
    const countBefore = listConvosCount;
    await ctrl.pollNow();
    assert.equal(listConvosCount, countBefore);

    bskyCursor = 'c2';
    bskyLogs = [{ $type: 'chat.bsky.convo.defs#logCreateMessage', convoId: 'b_convo_2' }];
    bskyConvosList = [
      ...bskyConvosList,
      {
        id: 'b_convo_2',
        status: 'accepted',
        unreadCount: 1,
        members: [
          { did: 'did:plc:me', handle: 'me.bsky.social', displayName: 'Me' },
          { did: 'did:plc:carol', handle: 'carol.bsky.social', displayName: 'Carol' },
        ],
        lastMessage: { text: 'New DM' },
      },
    ];
    await ctrl.pollNow();
    assert.equal(listConvosCount, countBefore + 1);
    assert.equal(host.querySelectorAll('.convo-row--human').length, 3);

    // 4. Clicking Bluesky unread row marks read and sends updateRead; Bluesky DM has no Attach media
    const bskyRow = Array.from(host.querySelectorAll('.convo-row--human')).find((r) => r.textContent.includes('Alice'));
    bskyRow.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(updateReadCalls.length, 1);
    assert.equal(updateReadCalls[0].convoId, 'b_convo_1');
    assert.equal(host.querySelector('[aria-label="Attach media"]'), null);

    // Go back, verify badge cleared, open Fediverse row, verify /read + Mastodon media attach
    host.querySelector('.back-nav-btn')?.click();
    await new Promise((r) => setTimeout(r, 20));
    const refreshedBskyRow = Array.from(host.querySelectorAll('.convo-row--human')).find((r) => r.textContent.includes('Alice'));
    assert.equal(refreshedBskyRow.classList.contains('is-unread'), false);

    const fediRow = Array.from(host.querySelectorAll('.convo-row--human')).find((r) => r.textContent.includes('Bob'));
    fediRow.click();
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(fediReadCalls.length, 1);

    const attachBtn = host.querySelector('[aria-label="Attach media"]');
    assert.ok(attachBtn);
    const fileIn = host.querySelector('input[type="file"]');
    assert.ok(fileIn);
    const fakeFile = new File(['abc'], 'photo.png', { type: 'image/png' });
    Object.defineProperty(fileIn, 'files', { value: [fakeFile], configurable: true });
    fileIn.dispatchEvent(new Event('change'));

    const form = host.querySelector('.human-dm-reply-form');
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise((r) => setTimeout(r, 40));

    assert.equal(uploadCalls, 1);
    assert.equal(statusPayloads.length, 1);
    assert.equal(statusPayloads[0].visibility, 'direct');
    assert.deepEqual(statusPayloads[0].media_ids, ['m_up_1']);
  } finally {
    ctrl?.destroy?.();
    globalThis.fetch = prevFetch;
    resetAuthStoreForTests();
    dom.restore();
  }
});
