import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cacheProgramHistory,
  deleteVaultSecret,
  enqueueLocalRetry,
  getCachedProgramHistory,
  listLocalFilterRules,
  listLocalRetries,
  listVaultIds,
  loadVaultSecret,
  resetMemoryStorageForTests,
  saveLocalFilterRule,
  saveVaultSecret,
  storeGet,
} from '../web/storage/kvStorage.js';
import {
  authStore,
  getAuthenticatedAccount,
  hydrateAuthStore,
  removeSocialAccount,
  resetAuthStoreForTests,
  updateAccountTokens,
  upsertSocialAccount,
} from '../web/state/authStore.js';
import {
  composeStore,
  computeRemainingCounts,
  prefillFromUserBubble,
  resetCompose,
} from '../web/state/composeStore.js';

test('AES-GCM vault encrypts social credentials without plaintext leakage and roundtrips via authStore', async () => {
  resetMemoryStorageForTests();
  resetAuthStoreForTests();

  const rawSecret = 'secret_mastodon_oauth_token_xyz_9988';
  await saveVaultSecret('fedi_1', { accessToken: rawSecret, clientSecret: 'cs_123' });

  // Inspect persisted storage record directly to ensure ciphertext differs from plaintext.
  const rawStored = await storeGet('social_vault', 'fedi_1');
  assert.ok(rawStored.iv);
  assert.ok(rawStored.ciphertext);
  assert.equal(JSON.stringify(rawStored).includes(rawSecret), false);

  const decrypted = await loadVaultSecret('fedi_1');
  assert.deepEqual(decrypted, { accessToken: rawSecret, clientSecret: 'cs_123' });

  await upsertSocialAccount(
    {
      id: 'bsky_1',
      platform: 'bluesky',
      serviceUrl: 'https://bsky.social',
      handle: 'alice.bsky.social',
      did: 'did:plc:alice123',
    },
    { accessJwt: 'jwt_old', refreshJwt: 'ref_1' }
  );
  await updateAccountTokens('bsky_1', { accessJwt: 'jwt_rotated' });

  // Reset in-memory authStore slice and re-hydrate cleanly from storage.
  resetAuthStoreForTests();
  await hydrateAuthStore();
  assert.equal(authStore.get().activeBlueskyId, 'bsky_1');

  const resolved = await getAuthenticatedAccount('bluesky');
  assert.equal(resolved.meta.handle, 'alice.bsky.social');
  assert.equal(resolved.secrets.accessJwt, 'jwt_rotated');
  assert.equal(resolved.secrets.refreshJwt, 'ref_1');

  await removeSocialAccount('bsky_1');
  assert.equal(await loadVaultSecret('bsky_1'), null);
  assert.equal(authStore.get().accounts.length, 0);
});

test('cacheProgramHistory deep-clones messages so caller mutations do not corrupt stored snapshots', async () => {
  resetMemoryStorageForTests();
  const payload = {
    history: [{ id: 'usr_1', role: 'user', text: 'Original draft' }],
  };
  await cacheProgramHistory('sebile', 'default', payload);
  payload.history[0].text = 'Mutated';

  const cached = await getCachedProgramHistory('sebile', 'default');
  assert.equal(cached.history[0].text, 'Original draft');
});

test('composeStore prefillFromUserBubble populates draft text, turn media, and accurate grapheme budgets', () => {
  resetCompose();
  prefillFromUserBubble({
    messageId: 'usr_share_42',
    text: 'Drafting a post with emoji 🚀🚀',
    media: ['/images/portraits/p1.png'],
  });

  const s = composeStore.get();
  assert.equal(s.isOpen, true);
  assert.equal(s.sourceMessageId, 'usr_share_42');
  assert.equal(s.text, 'Drafting a post with emoji 🚀🚀');
  assert.equal(s.targets.fediverse, true);
  assert.equal(s.mediaAttachments.length, 1);
  assert.equal(s.mediaAttachments[0].url, '/images/portraits/p1.png');

  const counts = computeRemainingCounts(s);
  assert.equal(counts.bluesky, 300 - 29);
  assert.equal(counts.fediverse, 500 - 29);
});

test('enqueueLocalRetry and saveLocalFilterRule persist kv snapshots and vault roundtrips save/load/delete', async () => {
  resetMemoryStorageForTests();

  await enqueueLocalRetry({
    id: 'retry_bsky_1',
    operation: 'publish',
    protocol: 'bluesky',
    payload: { textParts: ['hello'] },
  });
  await saveLocalFilterRule({
    id: 'local_filter_1',
    title: 'crypto',
    phrase: 'crypto',
    filter_action: 'hide',
  });

  const retrySnap = await storeGet('kv', 'local_retries_v1');
  const filterSnap = await storeGet('kv', 'local_filter_rules_v1');
  assert.equal(Array.isArray(retrySnap), true);
  assert.equal(retrySnap.some((r) => r.id === 'retry_bsky_1'), true);
  assert.equal(Array.isArray(filterSnap), true);
  assert.equal(filterSnap.some((f) => f.id === 'local_filter_1'), true);
  assert.equal((await listLocalRetries()).length, 1);
  assert.equal((await listLocalFilterRules()).length, 1);

  await saveVaultSecret('probe_acct', { token: 'abc_123' });
  assert.deepEqual(await loadVaultSecret('probe_acct'), { token: 'abc_123' });
  assert.equal((await listVaultIds()).includes('probe_acct'), true);
  await deleteVaultSecret('probe_acct');
  assert.equal(await loadVaultSecret('probe_acct'), null);
  assert.equal((await listVaultIds()).includes('probe_acct'), false);
});
