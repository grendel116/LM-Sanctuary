import { syncMastodonUserProfileToSanctuary } from '../queries/sanctuary.js';
import {
  deleteVaultSecret,
  kvGet,
  kvSet,
  loadVaultSecret,
  saveVaultSecret,
} from '../storage/nativeStore.js';
import { connectionStore } from './sanctuary/connection.js';
import { createStore } from './store.js';

const ACCOUNTS_META_KV_KEY = 'social_accounts_meta';
const ACTIVE_ACCOUNTS_KV_KEY = 'social_active_accounts';
const PUBLIC_MEDIA_BASE_KV_KEY = 'public_media_base_url';

function computeConnectionFlags(accounts = []) {
  const isMastodonConnected = accounts.some((a) => a.platform === 'fediverse' || a.platform === 'mastodon');
  const isBlueskyConnected = accounts.some((a) => a.platform === 'bluesky');
  const isThreadsConnected = accounts.some((a) => a.platform === 'threads');
  return {
    isMastodonConnected,
    isBlueskyConnected,
    isThreadsConnected,
    tightestCharLimit: isBlueskyConnected ? 300 : 500,
  };
}

function createInitialAuthState() {
  return {
    accounts: [],
    activeFediverseId: null,
    activeBlueskyId: null,
    activeThreadsId: null,
    isMastodonConnected: false,
    isBlueskyConnected: false,
    isThreadsConnected: false,
    tightestCharLimit: 500,
    retryQueue: [],
    publicMediaBaseUrl: '',
    hydrated: false,
  };
}

export const authStore = createStore(createInitialAuthState());

function normalizePlatformKey(platform) {
  return platform === 'mastodon' ? 'fediverse' : platform;
}

function activeFieldForPlatform(platform) {
  const norm = normalizePlatformKey(platform);
  if (norm === 'fediverse') return 'activeFediverseId';
  if (norm === 'bluesky') return 'activeBlueskyId';
  if (norm === 'threads') return 'activeThreadsId';
  throw new TypeError(`Unsupported social platform: ${platform}`);
}

async function persistAuthMetadata() {
  const s = authStore.get();
  await kvSet(ACCOUNTS_META_KV_KEY, s.accounts);
  await kvSet(ACTIVE_ACCOUNTS_KV_KEY, {
    activeFediverseId: s.activeFediverseId,
    activeBlueskyId: s.activeBlueskyId,
    activeThreadsId: s.activeThreadsId,
  });
}

function maybeSyncMastodonIdentity(meta) {
  if (!meta || (meta.platform !== 'fediverse' && meta.platform !== 'mastodon')) return;
  if (connectionStore.get().mode !== 'online') return;
  void syncMastodonUserProfileToSanctuary({
    username: meta.handle || '',
    acct: meta.acct || meta.handle || '',
    display_name: meta.displayName || meta.handle || '',
    note_text: meta.noteText || '',
    note: meta.note || '',
    fields: meta.fields || [],
  }).catch(() => {});
}

/**
 * Load public social account metadata from native SQLite store into authStore.
 * Secrets stay inside OS Credential Manager / Android Keystore until requested.
 */
export async function hydrateAuthStore() {
  const [accounts, activeMap, publicMediaBaseUrl] = await Promise.all([
    kvGet(ACCOUNTS_META_KV_KEY, []),
    kvGet(ACTIVE_ACCOUNTS_KV_KEY, {}),
    kvGet(PUBLIC_MEDIA_BASE_KV_KEY, ''),
  ]);
  const normalizedAccounts = Array.isArray(accounts) ? accounts : [];
  const pickValidActive = (platform, storedId) => {
    const matches = normalizedAccounts.filter((acc) => normalizePlatformKey(acc.platform) === platform);
    if (storedId && matches.some((acc) => acc.id === storedId)) {
      return storedId;
    }
    return matches[0]?.id || null;
  };

  authStore.set({
    accounts: normalizedAccounts,
    activeFediverseId: pickValidActive('fediverse', activeMap?.activeFediverseId),
    activeBlueskyId: pickValidActive('bluesky', activeMap?.activeBlueskyId),
    activeThreadsId: pickValidActive('threads', activeMap?.activeThreadsId),
    ...computeConnectionFlags(normalizedAccounts),
    publicMediaBaseUrl: typeof publicMediaBaseUrl === 'string' ? publicMediaBaseUrl : '',
    hydrated: true,
  });
  return authStore.get();
}

/**
 * Save public metadata to SQLite and secrets to OS Keychain / Android Keystore.
 * @param {object} meta
 * @param {object | null} [secrets]
 */
export async function upsertSocialAccount(meta, secrets = null) {
  if (!meta?.id || !meta?.platform) {
    throw new TypeError('Social account metadata requires id and platform');
  }
  const normPlatform = normalizePlatformKey(meta.platform);
  if (secrets && typeof secrets === 'object') {
    await saveVaultSecret(meta.id, secrets);
  }

  const prev = authStore.get();
  const safeMeta = {
    id: String(meta.id),
    platform: normPlatform,
    instanceUrl: meta.instanceUrl || '',
    serviceUrl: meta.serviceUrl || '',
    handle: meta.handle || meta.username || '',
    acct: meta.acct || meta.handle || '',
    displayName: meta.displayName || meta.display_name || meta.handle || meta.acct || '',
    avatar: meta.avatar || meta.avatar_url || '',
    header: meta.header || meta.header_url || '',
    url: meta.url || '',
    note: meta.note || meta.note_html || '',
    noteText: meta.noteText || meta.note_text || '',
    fields: Array.isArray(meta.fields) ? meta.fields : [],
    locked: Boolean(meta.locked),
    bot: Boolean(meta.bot),
    discoverable: meta.discoverable !== false,
    indexable: meta.indexable !== false,
    hideCollections: Boolean(meta.hideCollections ?? meta.hide_collections),
    defaultVisibility: meta.defaultVisibility || meta.default_visibility || 'public',
    defaultSensitive: Boolean(meta.defaultSensitive ?? meta.default_sensitive),
    defaultLanguage: meta.defaultLanguage || meta.default_language || 'en',
    attributionDomains: Array.isArray(meta.attributionDomains)
      ? meta.attributionDomains
      : (Array.isArray(meta.attribution_domains) ? meta.attribution_domains : []),
    emojis: Array.isArray(meta.emojis) ? meta.emojis : [],
    followersCount: meta.followersCount ?? 0,
    followingCount: meta.followingCount ?? 0,
    statusesCount: meta.statusesCount ?? 0,
    userId: meta.userId || '',
    did: meta.did || '',
    updatedAt: Date.now(),
  };

  const existingIdx = prev.accounts.findIndex((a) => a.id === safeMeta.id);
  const nextAccounts = existingIdx >= 0
    ? prev.accounts.map((a, i) => (i === existingIdx ? safeMeta : a))
    : [...prev.accounts, safeMeta];

  const activeKey = activeFieldForPlatform(normPlatform);
  const nextActiveId = prev[activeKey] || safeMeta.id;

  authStore.set({
    accounts: nextAccounts,
    [activeKey]: nextActiveId,
    ...computeConnectionFlags(nextAccounts),
    hydrated: true,
  });
  await persistAuthMetadata();
  maybeSyncMastodonIdentity(safeMeta);
  return safeMeta;
}

export async function getAccountCredentials(accountId) {
  if (!accountId) return null;
  return loadVaultSecret(accountId);
}

export async function getAuthenticatedAccount(platform, accountId = null) {
  const norm = normalizePlatformKey(platform);
  const s = authStore.get();
  const activeKey = activeFieldForPlatform(norm);
  const targetId = accountId || s[activeKey];
  if (!targetId) return null;
  const meta = s.accounts.find((a) => a.id === targetId && normalizePlatformKey(a.platform) === norm);
  if (!meta) return null;
  const secrets = await loadVaultSecret(meta.id);
  if (!secrets) return null;
  return { meta, secrets };
}

export async function updateAccountTokens(accountId, tokenPatch) {
  const current = (await loadVaultSecret(accountId)) || {};
  const merged = { ...current, ...tokenPatch };
  await saveVaultSecret(accountId, merged);
  return merged;
}

export async function removeSocialAccount(accountId) {
  await deleteVaultSecret(accountId);
  const s = authStore.get();
  const removed = s.accounts.find((a) => a.id === accountId);
  const nextAccounts = s.accounts.filter((a) => a.id !== accountId);

  const patch = {
    accounts: nextAccounts,
    ...computeConnectionFlags(nextAccounts),
  };
  if (removed) {
    const activeKey = activeFieldForPlatform(removed.platform);
    if (s[activeKey] === accountId) {
      patch[activeKey] = nextAccounts.find((a) => normalizePlatformKey(a.platform) === normalizePlatformKey(removed.platform))?.id || null;
    }
  }
  authStore.set(patch);
  await persistAuthMetadata();
}

export async function setActiveAccount(platform, accountId) {
  const norm = normalizePlatformKey(platform);
  const s = authStore.get();
  if (!s.accounts.some((a) => a.id === accountId && normalizePlatformKey(a.platform) === norm)) {
    throw new Error(`Account ${accountId} not found for ${platform}`);
  }
  const activeKey = activeFieldForPlatform(norm);
  authStore.set({ [activeKey]: accountId });
  await persistAuthMetadata();
}

export async function setPublicMediaBaseUrl(url) {
  const cleaned = typeof url === 'string' ? url.trim().replace(/\/+$/, '') : '';
  authStore.set({ publicMediaBaseUrl: cleaned });
  await kvSet(PUBLIC_MEDIA_BASE_KV_KEY, cleaned);
  return cleaned;
}

export function resetAuthStoreForTests() {
  authStore.set(createInitialAuthState());
}
