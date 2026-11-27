/* SPDX-License-Identifier: AGPL-3.0-or-later */

import test from 'node:test';
import assert from 'node:assert/strict';

import { installMockDom } from '../__mocks__/mockDom.js';
import { mountActivityScreen } from '../web/app/activity.js';
import {
  activityStore,
  groupActivityNotifications,
  hydrateActivityStore,
  resetActivityStoreForTests,
} from '../web/state/activityStore.js';
import { authStore, resetAuthStoreForTests, upsertSocialAccount } from '../web/state/authStore.js';
import { resetFeedStoreForTests } from '../web/state/feedStore.js';
import { resetConnectionStoreForTests } from '../web/state/sanctuary/connection.js';
import { resetSessionStoreForTests } from '../web/state/sanctuary/sessionModel.js';
import { kvSet, resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

function makeFollowItem(id, name, handle, isoDate) {
  return {
    id: `mastodon:notif:${id}`,
    protocol: 'mastodon',
    type: 'follow',
    date_published: isoDate,
    author: { id: `u_${id}`, name, handle },
    _meta: {
      notification: {
        type: 'follow',
        notifId: id,
        actor: { id: `u_${id}`, name, handle },
      },
    },
  };
}

function makeMentionItem(id, name, handle, isoDate, text = 'Hello!') {
  return {
    id: `mastodon:notif:${id}`,
    protocol: 'mastodon',
    type: 'mention',
    date_published: isoDate,
    content_text: text,
    author: { id: `u_${id}`, name, handle },
    _meta: {
      mastodon: { statusId: `st_${id}` },
      notification: {
        type: 'mention',
        notifId: id,
        actor: { id: `u_${id}`, name, handle },
      },
    },
  };
}

function makeReplyItem(id, name, handle, isoDate, text = 'Reply') {
  return {
    id: `mastodon:notif:${id}`,
    protocol: 'mastodon',
    type: 'reply',
    date_published: isoDate,
    content_text: text,
    author: { id: `u_${id}`, name, handle },
    _meta: {
      mastodon: { statusId: `rep_${id}`, inReplyToId: 'st_root' },
      notification: {
        type: 'reply',
        notifId: id,
        actor: { id: `u_${id}`, name, handle },
      },
    },
  };
}

test('groupActivityNotifications groups same-day follows while keeping replies individual', () => {
  const items = [
    makeFollowItem('f1', 'Alice', 'alice@mastodon.social', new Date(2026, 10, 23, 9, 0, 0).toISOString()),
    makeFollowItem('f2', 'Bob', 'bob@mastodon.social', new Date(2026, 10, 23, 10, 0, 0).toISOString()),
    makeFollowItem('f3', 'Carol', 'carol@mastodon.social', new Date(2026, 10, 23, 11, 0, 0).toISOString()),
    makeFollowItem('f4', 'Dan', 'dan@mastodon.social', new Date(2026, 10, 21, 9, 0, 0).toISOString()),
    makeReplyItem('r1', 'Eve', 'eve@mastodon.social', new Date(2026, 10, 23, 12, 0, 0).toISOString(), 'First reply'),
    makeReplyItem('r2', 'Frank', 'frank@mastodon.social', new Date(2026, 10, 23, 13, 0, 0).toISOString(), 'Second reply'),
  ];

  const groups = groupActivityNotifications(items);
  const followGroups = groups.filter((g) => g.kind === 'follow');
  const replyGroups = groups.filter((g) => g.kind === 'reply');

  assert.equal(followGroups.length, 2);
  assert.equal(followGroups[0].actors.length, 3);
  assert.equal(followGroups[0].totalActorCount, 3);
  assert.equal(followGroups[1].actors.length, 1);
  assert.equal(replyGroups.length, 2);
});

test('Opening Activity clears unread dot synchronously, shows New badges, and clears New on leave', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fedi_act_visit',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
      },
      { accessToken: 'masto_tok' }
    );

    await kvSet('activity_last_seen_ts_v1', Date.parse('2026-11-23T10:00:00.000Z'));
    await kvSet('activity_items_cache_v1', [
      makeMentionItem('m1', 'Alice', 'alice@mastodon.social', '2026-11-23T10:05:00.000Z', 'Unread mention'),
    ]);

    globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

    await hydrateActivityStore();
    assert.equal(activityStore.get().hasUnread, true);

    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const ctrl = mountActivityScreen(host);

    // Synchronously cleared dot + New badge shown
    assert.equal(activityStore.get().hasUnread, false);
    assert.equal(host.querySelectorAll('.activity-new-badge').length, 1);

    // Leaving tab clears visitCutoffTs
    ctrl.destroy();
    assert.equal(activityStore.get().visitCutoffTs, null);
    await new Promise((r) => setTimeout(r, 60));

    // Re-opening tab has no New badges
    const ctrl2 = mountActivityScreen(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(host.querySelectorAll('.activity-new-badge').length, 0);
    ctrl2.destroy();
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    globalThis.fetch = prevFetch;
    resetActivityStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('Reloading after visiting Activity clears New markers', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fedi_act_reload',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
      },
      { accessToken: 'masto_tok' }
    );

    const notif1 = {
      id: 'm1',
      type: 'mention',
      created_at: '2026-11-23T10:05:00.000Z',
      account: { id: 'a1', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
      status: {
        id: 'st_m1',
        content: '<p>Unread mention</p>',
        created_at: '2026-11-23T10:05:00.000Z',
        account: { id: 'a1', acct: 'alice@mastodon.social', display_name: 'Alice', avatar: '' },
      },
    };
    await kvSet('activity_last_seen_ts_v1', Date.parse('2026-11-23T10:00:00.000Z'));

    globalThis.fetch = async (url) => {
      if (String(url).includes('/api/v1/notifications')) {
        return new Response(JSON.stringify([notif1]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
    };

    await hydrateActivityStore();
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const ctrl = mountActivityScreen(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(host.querySelectorAll('.activity-new-badge').length, 1);
    ctrl.destroy();
    await new Promise((r) => setTimeout(r, 60));

    // Simulate reload (in-memory store reset, kv storage kept)
    resetActivityStoreForTests();
    await hydrateActivityStore();
    assert.equal(activityStore.get().hasUnread, false);

    const ctrl2 = mountActivityScreen(host);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(host.querySelectorAll('.activity-new-badge').length, 0);
    assert.equal(activityStore.get().hasUnread, false);
    ctrl2.destroy();
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    globalThis.fetch = prevFetch;
    resetActivityStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});

test('Grouped follow row renders "and 2 others followed you" with People disclosure and per-actor Follow Back buttons', async () => {
  const dom = installMockDom();
  const prevFetch = globalThis.fetch;
  try {
    resetMemoryStorageForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetActivityStoreForTests();

    await upsertSocialAccount(
      {
        id: 'fedi_act_follow',
        platform: 'fediverse',
        instanceUrl: 'https://mastodon.social',
        acct: 'davy@mastodon.social',
        displayName: 'Davy',
      },
      { accessToken: 'masto_tok' }
    );

    const baseDay = new Date(2026, 10, 23, 8, 0, 0).getTime();
    await kvSet('activity_last_seen_ts_v1', baseDay);
    await kvSet('activity_items_cache_v1', [
      makeFollowItem('f1', 'Alice', 'alice@mastodon.social', new Date(2026, 10, 23, 9, 0, 0).toISOString()),
      makeFollowItem('f2', 'Bob', 'bob@mastodon.social', new Date(2026, 10, 23, 10, 0, 0).toISOString()),
      makeFollowItem('f3', 'Carol', 'carol@mastodon.social', new Date(2026, 10, 23, 11, 0, 0).toISOString()),
    ]);

    globalThis.fetch = async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });

    await hydrateActivityStore();
    const host = dom.document.createElement('div');
    dom.document.body.appendChild(host);
    const ctrl = mountActivityScreen(host);

    const followRows = host.querySelectorAll('.activity-row--follow');
    assert.equal(followRows.length, 1);
    const row = followRows[0];
    assert.equal(row.querySelector('.activity-others-label')?.textContent, 'and 2 others');
    assert.equal(row.querySelector('.activity-verb-label')?.textContent, 'followed you');
    const disclosure = row.querySelector('details.activity-actors-disclosure');
    assert.ok(disclosure);
    assert.equal(disclosure.open, true);
    assert.equal(row.querySelectorAll('.activity-actor-chip').length, 3);
    const followBtns = Array.from(row.querySelectorAll('.activity-follow-btn'));
    assert.equal(followBtns.length, 3);
    assert.deepEqual(
      followBtns.map((b) => b.dataset.actorName).sort(),
      ['Alice', 'Bob', 'Carol']
    );

    await new Promise((r) => setTimeout(r, 60));
    ctrl.destroy();
    await new Promise((r) => setTimeout(r, 60));
  } finally {
    globalThis.fetch = prevFetch;
    resetActivityStoreForTests();
    resetAuthStoreForTests();
    resetConnectionStoreForTests();
    resetSessionStoreForTests();
    resetFeedStoreForTests();
    resetMemoryStorageForTests();
    dom.restore();
  }
});
