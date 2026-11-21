import {
  deleteSanctuarySocialAccount,
  fetchSanctuarySocialAccounts,
  saveSanctuarySocialAccount,
  syncMastodonUserProfileToSanctuary,
} from '../queries/sanctuary.js';
import {
  canPersistVaultSecretsLocally,
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
const SERVER_DELETIONS_KV_KEY = 'social_server_deletions_v1';
let serverSyncPromise = null;
const warnedServerVaultContexts = new Set();
const serverSyncedSecrets = new Map();

async function loadAccountSecrets(accountId) {
  const id = String(accountId);
  if (serverSyncedSecrets.has(id)) return serverSyncedSecrets.get(id);
  return loadVaultSecret(id);
}

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

function getServerVaultContext({ allowOffline = false } = {}) {
  const connection = connectionStore.get();
  if ((!allowOffline && connection.mode !== 'online') || !connection.nodeUrl) {
    return null;
  }
  return {
    nodeUrl: connection.nodeUrl,
    cacheKey: `${connection.nodeUrl}\n${connection.authHeaders?.Authorization || ''}`,
  };
}

async function requestServerVault(method, accountId = '', json = undefined, options = {}) {
  const context = getServerVaultContext(options);
  if (!context) return null;
  try {
    let result;
    if (method === 'GET') {
      result = await fetchSanctuarySocialAccounts({ nodeUrl: context.nodeUrl });
    } else if (method === 'PUT') {
      result = await saveSanctuarySocialAccount(accountId, json, { nodeUrl: context.nodeUrl });
    } else if (method === 'DELETE') {
      await deleteSanctuarySocialAccount(accountId, { nodeUrl: context.nodeUrl });
      result = true;
    } else {
      throw new TypeError(`Unsupported social vault method: ${method}`);
    }
    warnedServerVaultContexts.delete(context.cacheKey);
    return result;
  } catch (err) {
    if (err?.status === 503) {
      if (!warnedServerVaultContexts.has(context.cacheKey)) {
        warnedServerVaultContexts.add(context.cacheKey);
        console.warn('[social vault] Server returned HTTP 503; queued changes will retry after recovery.');
      }
      return null;
    }
    throw err;
  }
}

async function setAccountMetadata(meta) {
  const state = authStore.get();
  authStore.set({
    accounts: state.accounts.map((account) => (account.id === meta.id ? meta : account)),
  });
  await persistAuthMetadata();
}

async function queueServerDeletion(accountId) {
  const pending = await kvGet(SERVER_DELETIONS_KV_KEY, []);
  const next = Array.isArray(pending) ? pending.map(String) : [];
  if (!next.includes(String(accountId))) next.push(String(accountId));
  await kvSet(SERVER_DELETIONS_KV_KEY, next);
}

/**
 * Reconcile this device's accounts with the configured Sanctuary server.
 * The server copy wins equal or newer timestamps; local-only and newer local
 * accounts are uploaded. Deletions made while offline are replayed first.
 */
export async function syncSocialAccountsWithServer() {
  if (serverSyncPromise) return serverSyncPromise;
  if (!getServerVaultContext({ allowOffline: true })) return false;

  serverSyncPromise = (async () => {
    const serverOnlySecrets = !canPersistVaultSecretsLocally();
    const pendingDeletes = await kvGet(SERVER_DELETIONS_KV_KEY, []);
    for (const accountId of Array.isArray(pendingDeletes) ? pendingDeletes : []) {
      const deleted = await requestServerVault('DELETE', String(accountId), undefined, { allowOffline: true });
      if (!deleted) return false;
    }
    await kvSet(SERVER_DELETIONS_KV_KEY, []);

    const response = await requestServerVault('GET', '', undefined, { allowOffline: true });
    if (!response) return false;
    const remoteAccounts = Array.isArray(response?.accounts) ? response.accounts : [];
    const remoteById = new Map(remoteAccounts.map((account) => [account?.meta?.id, account]));
    const localAccounts = authStore.get().accounts || [];
    const localIds = new Set(localAccounts.map((account) => account.id));

    for (const localMeta of localAccounts) {
      const localSecrets = await loadAccountSecrets(localMeta.id);
      const remote = remoteById.get(localMeta.id);
      if (!remote) {
        if (localSecrets) {
          const saved = await requestServerVault('PUT', localMeta.id, {
            meta: localMeta,
            secrets: localSecrets,
          }, { allowOffline: true });
          if (saved?.meta) {
            await upsertSocialAccount(saved.meta, saved.secrets, {
              syncToServer: false,
              preserveUpdatedAt: true,
              serverOnlySecrets,
            });
          }
        }
      } else if (localSecrets && Number(localMeta.updatedAt || 0) > Number(remote.meta?.updatedAt || 0)) {
        const saved = await requestServerVault('PUT', localMeta.id, {
          meta: localMeta,
          secrets: localSecrets,
        }, { allowOffline: true });
        if (saved?.meta) {
          await upsertSocialAccount(saved.meta, saved.secrets, {
            syncToServer: false,
            preserveUpdatedAt: true,
            serverOnlySecrets,
          });
        }
      } else if (remote.meta && remote.secrets) {
        await upsertSocialAccount(remote.meta, remote.secrets, {
          syncToServer: false,
          preserveUpdatedAt: true,
          serverOnlySecrets,
        });
      }
    }

    for (const remote of remoteAccounts) {
      const id = remote?.meta?.id;
      if (id && !localIds.has(id) && remote.meta && remote.secrets) {
        await upsertSocialAccount(remote.meta, remote.secrets, {
          syncToServer: false,
          preserveUpdatedAt: true,
          serverOnlySecrets,
        });
      }
    }
    return true;
  })().finally(() => {
    serverSyncPromise = null;
  });
  return serverSyncPromise;
}

/**
 * Load local social account metadata into authStore. Secrets stay in the local
 * credential vault and sync with the configured Sanctuary server when reachable.
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
 * Save account metadata and secrets locally, then sync them to an authenticated
 * Sanctuary server when one is connected.
 * @param {object} meta
 * @param {object | null} [secrets]
 */
export async function upsertSocialAccount(meta, secrets = null, options = {}) {
  if (!meta?.id || !meta?.platform) {
    throw new TypeError('Social account metadata requires id and platform');
  }
  const normPlatform = normalizePlatformKey(meta.platform);
  const serverOnlySecrets = options.serverOnlySecrets === true
    || !canPersistVaultSecretsLocally();
  if (secrets && typeof secrets === 'object') {
    if (serverOnlySecrets) {
      serverSyncedSecrets.set(String(meta.id), secrets);
    } else {
      await saveVaultSecret(meta.id, secrets);
      serverSyncedSecrets.delete(String(meta.id));
    }
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
    isVerified: Boolean(meta.isVerified),
    expiresAt: Number(meta.expiresAt || 0),
    updatedAt: options.preserveUpdatedAt && Number(meta.updatedAt)
      ? Number(meta.updatedAt)
      : Date.now(),
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
  if (options.syncToServer !== false) {
    const accountSecrets = secrets || await loadAccountSecrets(safeMeta.id);
    if (accountSecrets) {
      const saved = await requestServerVault('PUT', safeMeta.id, {
        meta: safeMeta,
        secrets: accountSecrets,
      }, { allowOffline: serverOnlySecrets });
      if (serverOnlySecrets && !saved?.meta) {
        throw new Error('This browser cannot persist social credentials locally; connect to the Sanctuary server to save them.');
      }
      if (saved?.meta && Number(saved.meta.updatedAt) !== safeMeta.updatedAt) {
        safeMeta.updatedAt = Number(saved.meta.updatedAt) || safeMeta.updatedAt;
        await setAccountMetadata(safeMeta);
      }
    }
  }
  maybeSyncMastodonIdentity(safeMeta);
  return safeMeta;
}

export async function getAccountCredentials(accountId) {
  if (!accountId) return null;
  return loadAccountSecrets(accountId);
}

export async function getAuthenticatedAccount(platform, accountId = null) {
  const norm = normalizePlatformKey(platform);
  const s = authStore.get();
  const activeKey = activeFieldForPlatform(norm);
  const targetId = accountId || s[activeKey];
  if (!targetId) return null;
  const meta = s.accounts.find((a) => a.id === targetId && normalizePlatformKey(a.platform) === norm);
  if (!meta) return null;
  const secrets = await loadAccountSecrets(meta.id);
  if (!secrets) return null;
  return { meta, secrets };
}

export async function updateAccountTokens(accountId, tokenPatch) {
  const current = (await loadAccountSecrets(accountId)) || {};
  const merged = { ...current, ...tokenPatch };
  const serverOnlySecrets = !canPersistVaultSecretsLocally();
  if (serverOnlySecrets) {
    serverSyncedSecrets.set(String(accountId), merged);
  } else {
    await saveVaultSecret(accountId, merged);
    serverSyncedSecrets.delete(String(accountId));
  }
  const currentMeta = authStore.get().accounts.find((account) => account.id === accountId);
  if (currentMeta) {
    const meta = { ...currentMeta, updatedAt: Date.now() };
    await setAccountMetadata(meta);
    const saved = await requestServerVault('PUT', accountId, { meta, secrets: merged }, {
      allowOffline: serverOnlySecrets,
    });
    if (serverOnlySecrets && !saved?.meta) {
      throw new Error('The refreshed social credentials could not be saved to the Sanctuary server.');
    }
    if (saved?.meta && Number(saved.meta.updatedAt) !== meta.updatedAt) {
      meta.updatedAt = Number(saved.meta.updatedAt) || meta.updatedAt;
      await setAccountMetadata(meta);
    }
  }
  return merged;
}

export async function removeSocialAccount(accountId) {
  serverSyncedSecrets.delete(String(accountId));
  if (getServerVaultContext()) {
    const deleted = await requestServerVault('DELETE', accountId);
    if (!deleted) await queueServerDeletion(accountId);
  } else {
    const connection = connectionStore.get();
    if (connection.nodeUrl) {
      await queueServerDeletion(accountId);
    }
  }
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
  serverSyncPromise = null;
  serverSyncedSecrets.clear();
  authStore.set(createInitialAuthState());
}
