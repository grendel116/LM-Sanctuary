/* SPDX-License-Identifier: AGPL-3.0-only WITH AdditionRef-sval-app-store */

import test from 'node:test';
import assert from 'node:assert/strict';

import { toUnifiedItem } from '../web/core/schema/unifiedItem.js';
import {
  feedStore,
  reconcileEnrichedStreamItems,
  resetFeedStoreForTests,
  setStreamItems,
} from '../web/state/feedStore.js';
import {
  applyKnownMetrics,
  getNetworkMetrics,
  hydrateMetricsLedger,
  networkKeysOf,
  recordItemMetrics,
  recordNetworkMetrics,
  resetMetricsLedgerForTests,
} from '../web/state/metricsLedger.js';
import { kvSet } from '../web/storage/nativeStore.js';
import { resetMemoryStorageForTests } from '../web/storage/kvStorage.js';

function resetAll() {
  resetMetricsLedgerForTests();
  resetFeedStoreForTests();
  resetMemoryStorageForTests();
}

test('networkKeysOf extracts mastodon, bluesky, and threads keys', () => {
  resetAll();
  const item = {
    source: 'mastodon',
    nativeId: 'm-123',
    _meta: {
      linkedIds: {
        blueskyUri: 'at://did:plc:abc/app.bsky.feed.post/xyz',
        threadsPostId: 'th-456',
      },
    },
  };
  assert.deepEqual(networkKeysOf(item), {
    mastodon: 'mastodon:m-123',
    bluesky: 'bluesky:at://did:plc:abc/app.bsky.feed.post/xyz',
    threads: 'threads:th-456',
  });
});

test('recordItemMetrics and applyKnownMetrics prevent single-network count flash on refresh', () => {
  resetAll();
  const enriched = {
    id: 'masto:m-1',
    source: 'mastodon',
    nativeId: 'm-1',
    metrics: { likes: 15, replies: 3, reposts: 6 },
    _meta: {
      linkedIds: {
        mastodonStatusId: 'm-1',
        blueskyUri: 'at://did:plc:alice/app.bsky.feed.post/1',
      },
      metricsBreakdown: {
        mastodon: { likes: 5, replies: 1, reposts: 2 },
        bluesky: { likes: 10, replies: 2, reposts: 4 },
      },
    },
  };
  recordItemMetrics(enriched);

  const freshSingleNetwork = {
    id: 'masto:m-1',
    source: 'mastodon',
    nativeId: 'm-1',
    metrics: { likes: 5, replies: 1, reposts: 2 },
    _meta: {
      linkedIds: {
        mastodonStatusId: 'm-1',
        blueskyUri: 'at://did:plc:alice/app.bsky.feed.post/1',
      },
    },
  };

  const hydrated = applyKnownMetrics(freshSingleNetwork);
  assert.deepEqual(hydrated.metrics, { likes: 15, replies: 3, reposts: 6 });
  assert.deepEqual(hydrated.metricsBreakdown, {
    mastodon: { likes: 5, replies: 1, reposts: 2 },
    bluesky: { likes: 10, replies: 2, reposts: 4 },
  });
});

test('applyKnownMetrics restores non-zero counts when incoming breakdown has zeros', () => {
  resetAll();
  recordNetworkMetrics('bluesky:at://did:plc:bob/app.bsky.feed.post/9', {
    likes: 20,
    replies: 4,
    reposts: 7,
  });

  const zeroed = {
    id: 'bsky:9',
    source: 'bluesky',
    nativeUri: 'at://did:plc:bob/app.bsky.feed.post/9',
    metrics: { likes: 0, replies: 0, reposts: 0 },
    metricsBreakdown: {
      bluesky: { likes: 0, replies: 0, reposts: 0 },
    },
  };

  const restored = applyKnownMetrics(zeroed);
  assert.deepEqual(restored.metrics, { likes: 20, replies: 4, reposts: 7 });
});

test('hydrateMetricsLedger loads persisted counts from KV storage', async () => {
  resetAll();
  await kvSet('post_metrics_ledger_v1', {
    'mastodon:999': { likes: 42, replies: 8, reposts: 11, ts: Date.now() },
  });

  await hydrateMetricsLedger();
  assert.deepEqual(getNetworkMetrics('mastodon:999'), {
    likes: 42,
    replies: 8,
    reposts: 11,
  });
});

test('feedStore setStreamItems and reconcileEnrichedStreamItems round-trip metrics via ledger', () => {
  resetAll();
  const ts = '2026-11-24T12:00:00.000Z';
  const base = toUnifiedItem({
    network: 'fediverse',
    id: 'm-555',
    instanceUrl: 'https://mastodon.social',
    contentHtml: '<p>Ledger round-trip</p>',
    text: 'Ledger round-trip',
    createdAt: ts,
    author: { id: '1', acct: 'user@mastodon.social', displayName: 'User' },
  });
  base.metrics = { likes: 2, replies: 0, reposts: 1 };

  setStreamItems('feed', [base]);

  const enriched = {
    ...base,
    metrics: { likes: 12, replies: 3, reposts: 5 },
    _meta: {
      ...base._meta,
      linkedIds: {
        mastodonStatusId: 'm-555',
        blueskyUri: 'at://did:plc:user/app.bsky.feed.post/555',
      },
      metricsBreakdown: {
        mastodon: { likes: 2, replies: 0, reposts: 1 },
        bluesky: { likes: 10, replies: 3, reposts: 4 },
      },
    },
  };
  reconcileEnrichedStreamItems([enriched]);

  const refreshed = toUnifiedItem({
    network: 'fediverse',
    id: 'm-555',
    instanceUrl: 'https://mastodon.social',
    contentHtml: '<p>Ledger round-trip</p>',
    text: 'Ledger round-trip',
    createdAt: ts,
    author: { id: '1', acct: 'user@mastodon.social', displayName: 'User' },
  });
  refreshed.metrics = { likes: 2, replies: 0, reposts: 1 };
  refreshed._meta = {
    ...refreshed._meta,
    linkedIds: {
      mastodonStatusId: 'm-555',
      blueskyUri: 'at://did:plc:user/app.bsky.feed.post/555',
    },
  };

  setStreamItems('feed', [refreshed]);
  const stored = feedStore.get().streams.feed.items[0];
  assert.deepEqual(stored.metrics, { likes: 12, replies: 3, reposts: 5 });
});
