import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findLocalLinkedPost,
  saveLocalLinkedPost,
  storeGet,
  storePut,
} from '../web/storage/nativeStore.js';

test('concurrent linked-post lookups wait for the persisted index to hydrate', async () => {
  const records = [
    {
      canonicalId: 'mastodon:post-1',
      mastodonStatusId: 'post-1',
      blueskyUri: 'at://user/post-1',
    },
    {
      canonicalId: 'mastodon:post-2',
      mastodonStatusId: 'post-2',
      threadsPostId: 'threads-post-2',
    },
    {
      canonicalId: 'mastodon:post-3',
      mastodonStatusId: 'post-3',
      blueskyUri: 'at://user/post-3',
    },
  ];
  const fullIndex = [
    ...records,
    ...Array.from({ length: 128 }, (_, index) => ({
      canonicalId: `mastodon:older-${index}`,
      mastodonStatusId: `older-${index}`,
      blueskyUri: `at://user/older-${index}`,
    })),
  ];
  await storePut('kv', 'local_linked_posts_v1', fullIndex);

  const found = await Promise.all(
    records.map((record) => findLocalLinkedPost(record.mastodonStatusId))
  );

  assert.deepEqual(found.map((record) => record?.canonicalId), records.map((record) => record.canonicalId));
  const newest = { canonicalId: 'mastodon:newest', mastodonStatusId: 'newest', threadsPostId: 'threads-newest' };
  await saveLocalLinkedPost(newest);
  assert.equal((await storeGet('kv', 'local_linked_posts_v1')).length, fullIndex.length + 1);
});
