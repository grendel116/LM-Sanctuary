/**
 * Native OS storage facade replacing browser IDB completely:
 *  1) Capacitor Android: routes to SanctuaryNativeStorePlugin (SQLiteOpenHelper + AndroidKeyStore)
 *  2) Desktop / LAN Python Host: routes to /api/social/* (disk SQLite WAL + OS Credential Manager)
 *  3) Isolated Test Harness (node --test) or unconfigured browser: AES-GCM WebCrypto encrypted in-memory vault
 */

export const STORE_NAMES = Object.freeze([
  'kv',
  'social_vault',
  'programs',
  'chat_history',
  'journals_quests',
  'outbox_queue',
  'timeline_cache',
  'drafts',
]);

const VAULT_KEY_KV_ID = 'vault_aes_key';

let vaultKeyPromise = null;
const memoryStores = new Map(STORE_NAMES.map((name) => [name, new Map()]));
const memoryLinkedPosts = new Map();
const memoryFilters = new Map();
const memoryRetries = new Map();

function assertStoreName(storeName) {
  if (!STORE_NAMES.includes(storeName)) {
    throw new TypeError(`Unknown store name: ${storeName}`);
  }
}

function isCryptoKeyObject(value) {
  if (!value || typeof value !== 'object') return false;
  if (typeof CryptoKey !== 'undefined' && value instanceof CryptoKey) return true;
  return (
    value.constructor?.name === 'CryptoKey' ||
    (typeof value.type === 'string' && typeof value.algorithm === 'object' && Array.isArray(value.usages))
  );
}

function safeClone(value) {
  if (value === undefined || value === null || typeof value !== 'object') {
    return value;
  }
  if (isCryptoKeyObject(value)) {
    return value;
  }
  return structuredClone(value);
}

function getAndroidPlugin() {
  const plugin = globalThis.Capacitor?.Plugins?.SanctuaryNativeStore;
  return plugin && typeof plugin.kvGet === 'function' ? plugin : null;
}

function isNodeTestEnvironment() {
  return typeof globalThis.process?.versions?.node === 'string' && !globalThis.__SANCTUARY_FORCE_HTTP_STORE__;
}

function getPythonSocialOrigin() {
  if (getAndroidPlugin()) return '';
  if (isNodeTestEnvironment()) return '';
  const forced = globalThis.__SANCTUARY_SOCIAL_ORIGIN__;
  if (typeof forced === 'string' && forced) return forced.replace(/\/+$/, '');
  const loc = globalThis.location;
  if (!loc || !loc.origin || loc.origin === 'null') return '';
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return '';
  if (loc.hostname === 'localhost' && loc.port === '') return '';
  return loc.origin.replace(/\/+$/, '');
}

let pythonHostReachable = null;

async function httpSocialJson(path, init = {}) {
  const origin = getPythonSocialOrigin();
  if (!origin || pythonHostReachable === false) return { available: false };
  try {
    const res = await fetch(`${origin}${path}`, {
      ...init,
      headers: {
        ...(init.json !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers || {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
    });
    if (res.status === 404 || res.status === 502 || res.status === 503) {
      pythonHostReachable = false;
      return { available: false };
    }
    pythonHostReachable = true;
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return { available: true, ok: res.ok, status: res.status, data };
  } catch {
    pythonHostReachable = false;
    return { available: false };
  }
}

export function resetMemoryStorageForTests() {
  for (const store of memoryStores.values()) {
    store.clear();
  }
  memoryLinkedPosts.clear();
  memoryFilters.clear();
  memoryRetries.clear();
  vaultKeyPromise = null;
  pythonHostReachable = null;
}

export async function storeGet(storeName, key) {
  assertStoreName(storeName);
  const strKey = String(key);

  const android = getAndroidPlugin();
  if (android) {
    const res = await android.kvGet({ storeName, key: strKey });
    return res?.value ? JSON.parse(res.value) : null;
  }

  if (storeName !== 'kv' || strKey !== VAULT_KEY_KV_ID) {
    const remote = await httpSocialJson(
      `/api/social/storage/kv?store=${encodeURIComponent(storeName)}&key=${encodeURIComponent(strKey)}`
    );
    if (remote.available && remote.ok) {
      return remote.data?.found ? remote.data.value : null;
    }
  }

  const entry = memoryStores.get(storeName).get(strKey);
  return entry === undefined ? null : safeClone(entry);
}

export async function storePut(storeName, key, value) {
  assertStoreName(storeName);
  const strKey = String(key);
  memoryStores.get(storeName).set(strKey, safeClone(value));

  const android = getAndroidPlugin();
  if (android) {
    await android.kvPut({ storeName, key: strKey, value: JSON.stringify(value ?? null) });
    return;
  }

  if (storeName !== 'kv' || strKey !== VAULT_KEY_KV_ID) {
    await httpSocialJson('/api/social/storage/kv', {
      method: 'PUT',
      json: { storeName, key: strKey, value },
    });
  }
}

export async function storeDelete(storeName, key) {
  assertStoreName(storeName);
  const strKey = String(key);
  memoryStores.get(storeName).delete(strKey);

  const android = getAndroidPlugin();
  if (android) {
    await android.kvDelete({ storeName, key: strKey });
    return;
  }

  await httpSocialJson(
    `/api/social/storage/kv?store=${encodeURIComponent(storeName)}&key=${encodeURIComponent(strKey)}`,
    { method: 'DELETE' }
  );
}

export async function storeGetAll(storeName) {
  assertStoreName(storeName);

  const android = getAndroidPlugin();
  if (android) {
    const res = await android.kvGetAll({ storeName });
    const rows = Array.isArray(res?.entries) ? res.entries : [];
    return rows.map((r) => ({ key: String(r.key), value: r.value ? JSON.parse(r.value) : null }));
  }

  const remote = await httpSocialJson(`/api/social/storage/kv/all?store=${encodeURIComponent(storeName)}`);
  if (remote.available && remote.ok && Array.isArray(remote.data?.entries)) {
    return remote.data.entries;
  }

  const out = [];
  for (const [key, value] of memoryStores.get(storeName).entries()) {
    out.push({ key, value: safeClone(value) });
  }
  return out;
}

export async function storeClear(storeName) {
  assertStoreName(storeName);
  memoryStores.get(storeName).clear();

  const android = getAndroidPlugin();
  if (android) {
    await android.kvClear({ storeName });
    return;
  }

  await httpSocialJson(`/api/social/storage/kv/all?store=${encodeURIComponent(storeName)}`, {
    method: 'DELETE',
  });
}

export async function kvGet(key, fallback = null) {
  const value = await storeGet('kv', key);
  return value === null ? fallback : value;
}

export async function kvSet(key, value) {
  await storePut('kv', key, value);
}

export async function kvDelete(key) {
  await storeDelete('kv', key);
}

function getCryptoApi() {
  const cryptoObj = globalThis.crypto;
  if (!cryptoObj?.subtle || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Web Crypto AES-GCM is unavailable in this environment');
  }
  return cryptoObj;
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function getOrCreateVaultKey() {
  if (vaultKeyPromise) return vaultKeyPromise;
  vaultKeyPromise = (async () => {
    const { subtle } = getCryptoApi();
    const existing = await storeGet('kv', VAULT_KEY_KV_ID);
    if (isCryptoKeyObject(existing)) {
      return existing;
    }
    const key = await subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    memoryStores.get('kv').set(VAULT_KEY_KV_ID, key);
    return key;
  })().catch((err) => {
    vaultKeyPromise = null;
    throw err;
  });
  return vaultKeyPromise;
}

/**
 * Store social credential in Android Keystore (mobile), OS Credential Manager (Desktop),
 * or WebCrypto AES-GCM memory cipher store (tests). Never uses browser IDB.
 */
export async function saveVaultSecret(accountId, secretObj) {
  const android = getAndroidPlugin();
  if (android) {
    await android.setSecret({ key: String(accountId), value: JSON.stringify(secretObj ?? {}) });
    return;
  }

  const remote = await httpSocialJson('/api/social/storage/secret', {
    method: 'PUT',
    json: { key: String(accountId), secret: secretObj ?? {} },
  });
  if (remote.available && remote.ok) {
    return;
  }

  const cryptoObj = getCryptoApi();
  const key = await getOrCreateVaultKey();
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(secretObj ?? {}));
  const encryptedBuffer = await cryptoObj.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  memoryStores.get('social_vault').set(String(accountId), {
    id: String(accountId),
    iv: bytesToBase64(iv),
    ciphertext: bytesToBase64(new Uint8Array(encryptedBuffer)),
    updatedAt: Date.now(),
  });
}

export async function loadVaultSecret(accountId) {
  const android = getAndroidPlugin();
  if (android) {
    const res = await android.getSecret({ key: String(accountId) });
    return res?.value ? JSON.parse(res.value) : null;
  }

  const remote = await httpSocialJson(`/api/social/storage/secret?key=${encodeURIComponent(String(accountId))}`);
  if (remote.available && remote.ok) {
    return remote.data?.secret || null;
  }

  const record = memoryStores.get('social_vault').get(String(accountId));
  if (!record || !record.iv || !record.ciphertext) {
    return null;
  }
  const cryptoObj = getCryptoApi();
  const key = await getOrCreateVaultKey();
  const decryptedBuffer = await cryptoObj.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(record.iv) },
    key,
    base64ToBytes(record.ciphertext)
  );
  const jsonText = new TextDecoder().decode(new Uint8Array(decryptedBuffer));
  return JSON.parse(jsonText);
}

export async function deleteVaultSecret(accountId) {
  memoryStores.get('social_vault').delete(String(accountId));

  const android = getAndroidPlugin();
  if (android) {
    await android.deleteSecret({ key: String(accountId) });
    return;
  }

  await httpSocialJson(`/api/social/storage/secret?key=${encodeURIComponent(String(accountId))}`, {
    method: 'DELETE',
  });
}

export async function listVaultIds() {
  const android = getAndroidPlugin();
  if (android) {
    const res = await android.listSecretIds();
    return Array.isArray(res?.ids) ? res.ids : [];
  }
  const remote = await httpSocialJson('/api/social/storage/secret/ids');
  if (remote.available && remote.ok && Array.isArray(remote.data?.ids)) {
    return remote.data.ids;
  }
  return [...memoryStores.get('social_vault').keys()];
}

// ── Cross-Post Linked IDs, Filter Rules, and Retry Queue (Android / Client Bridge) ──

const LINKED_POSTS_KV_KEY = 'local_linked_posts_v1';

async function syncLinkedPostsKvSnapshot() {
  const android = getAndroidPlugin();
  if (android && typeof android.listLinkedPosts === 'function') return;
  const rows = [...memoryLinkedPosts.values()].slice(-120);
  await storePut('kv', LINKED_POSTS_KV_KEY, rows).catch(() => {});
}

export async function listLocalLinkedPosts(limit = 50) {
  const android = getAndroidPlugin();
  if (android && typeof android.listLinkedPosts === 'function') {
    const res = await android.listLinkedPosts({ limit });
    return Array.isArray(res?.records) ? res.records : [];
  }
  if (memoryLinkedPosts.size === 0) {
    const saved = await storeGet('kv', LINKED_POSTS_KV_KEY).catch(() => null);
    if (Array.isArray(saved)) {
      for (const rec of saved) {
        if (rec?.canonicalId) {
          memoryLinkedPosts.set(String(rec.canonicalId), { ...rec });
        }
      }
    }
  }
  return [...memoryLinkedPosts.values()].reverse().slice(0, Math.max(1, limit));
}

export async function saveLocalLinkedPost(record) {
  if (!record?.canonicalId) return;
  memoryLinkedPosts.set(record.canonicalId, { ...record });
  const android = getAndroidPlugin();
  if (android) {
    await android.saveLinkedPost({
      canonicalId: record.canonicalId,
      mastodonStatusId: record.mastodonStatusId || '',
      mastodonInstance: record.mastodonInstance || '',
      blueskyUri: record.blueskyUri || '',
      blueskyCid: record.blueskyCid || '',
      threadsPostId: record.threadsPostId || '',
      parentCanonicalId: record.parentCanonicalId || '',
    });
  }
  await syncLinkedPostsKvSnapshot();
}

export async function findLocalLinkedPost(anyId) {
  const clean = String(anyId || '').trim();
  if (!clean) return null;
  const android = getAndroidPlugin();
  if (android) {
    const res = await android.findLinkedPost({ id: clean });
    return res?.record || null;
  }
  if (memoryLinkedPosts.size === 0) {
    await listLocalLinkedPosts(120);
  }
  const bareMasto = clean.replace(/^mastodon:/, '');
  const bareBsky = clean.replace(/^bluesky:/, '');
  const bareThreads = clean.replace(/^threads:/, '');
  for (const rec of memoryLinkedPosts.values()) {
    if (
      rec.canonicalId === clean ||
      rec.mastodonStatusId === bareMasto ||
      rec.blueskyUri === bareBsky ||
      rec.threadsPostId === bareThreads
    ) {
      return { ...rec };
    }
  }
  return null;
}

export async function findLocalLinkedPostGroup(anyId) {
  const root = await findLocalLinkedPost(anyId);
  if (!root) return [];
  const rootCanon = root.canonicalId || root.canonical_id || '';
  if (!rootCanon) return [root];
  const parentCanon = root.parentCanonicalId || '';
  let resolvedRoot = root;
  if (parentCanon && parentCanon !== rootCanon) {
    const parentRec = await findLocalLinkedPost(parentCanon);
    if (parentRec) resolvedRoot = parentRec;
  }
  const trueRootId = resolvedRoot.canonicalId || resolvedRoot.canonical_id || rootCanon;
  const android = getAndroidPlugin();
  if (android && typeof android.findLinkedPost === 'function') {
    const group = [resolvedRoot];
    for (let idx = 1; idx <= 20; idx += 1) {
      const partRec = await findLocalLinkedPost(`${trueRootId}:part:${idx}`);
      if (!partRec) break;
      group.push(partRec);
    }
    return group;
  }
  if (memoryLinkedPosts.size === 0) {
    await listLocalLinkedPosts(120);
  }
  const out = [resolvedRoot];
  for (const rec of memoryLinkedPosts.values()) {
    if (rec.parentCanonicalId === trueRootId && rec.canonicalId !== trueRootId) {
      out.push({ ...rec });
    }
  }
  return out;
}

export async function deleteLocalLinkedChildren(parentCanonicalId) {
  const clean = String(parentCanonicalId || '').trim();
  if (!clean) return 0;
  const android = getAndroidPlugin();
  let deleted = 0;
  if (android && typeof android.deleteLinkedPost === 'function') {
    for (let idx = 1; idx <= 20; idx += 1) {
      await android.deleteLinkedPost({ id: `${clean}:part:${idx}` }).catch(() => {});
    }
  }
  if (memoryLinkedPosts.size === 0) {
    await listLocalLinkedPosts(120);
  }
  for (const [k, rec] of [...memoryLinkedPosts.entries()]) {
    if (rec.parentCanonicalId === clean) {
      memoryLinkedPosts.delete(k);
      deleted += 1;
    }
  }
  if (deleted > 0) {
    await syncLinkedPostsKvSnapshot();
  }
  return deleted;
}

export async function deleteLocalLinkedPost(anyId) {
  const clean = String(anyId || '').trim();
  const android = getAndroidPlugin();
  if (android) {
    await android.deleteLinkedPost({ id: clean });
  }
  if (memoryLinkedPosts.size === 0) {
    await listLocalLinkedPosts(120);
  }
  const group = await findLocalLinkedPostGroup(clean);
  const groupIds = new Set(group.map((g) => g.canonicalId || g.canonical_id).filter(Boolean));
  const bare = clean.replace(/^(?:mastodon|bluesky|threads):/, '');
  for (const [k, rec] of [...memoryLinkedPosts.entries()]) {
    if (
      groupIds.has(k) ||
      k === clean ||
      rec.mastodonStatusId === bare ||
      rec.blueskyUri === bare ||
      rec.threadsPostId === bare ||
      rec.parentCanonicalId === clean
    ) {
      memoryLinkedPosts.delete(k);
    }
  }
  await syncLinkedPostsKvSnapshot();
}

export async function listLocalFilterRules() {
  return [...memoryFilters.values()];
}

export async function saveLocalFilterRule(rule) {
  if (rule?.id) memoryFilters.set(String(rule.id), { ...rule });
}

export async function deleteLocalFilterRule(id) {
  memoryFilters.delete(String(id));
}

export async function enqueueLocalRetry(entry) {
  if (entry?.id) memoryRetries.set(String(entry.id), { ...entry });
}

export async function listLocalRetries() {
  return [...memoryRetries.values()];
}

export async function deleteLocalRetry(id) {
  memoryRetries.delete(String(id));
}

function historyCacheKey(programId, sessionId = 'default') {
  return `${programId}::${sessionId || 'default'}`;
}

export async function cacheProgramHistory(programId, sessionId = 'default', payload = {}) {
  await storePut('chat_history', historyCacheKey(programId, sessionId), {
    ...safeClone(payload),
    programId,
    sessionId: sessionId || 'default',
    cachedAt: Date.now(),
  });
}

export async function getCachedProgramHistory(programId, sessionId = 'default') {
  return storeGet('chat_history', historyCacheKey(programId, sessionId));
}

export async function cacheProgramsDirectory(programs) {
  await storePut('programs', 'directory', {
    programs: safeClone(Array.isArray(programs) ? programs : []),
    cachedAt: Date.now(),
  });
}

export async function getCachedProgramsDirectory() {
  const rec = await storeGet('programs', 'directory');
  return Array.isArray(rec?.programs) ? rec.programs : [];
}

export async function cacheJournalsAndQuests(programId, sessionId = 'default', payload = {}) {
  await storePut('journals_quests', historyCacheKey(programId, sessionId), {
    ...safeClone(payload),
    programId,
    sessionId: sessionId || 'default',
    cachedAt: Date.now(),
  });
}

export async function getCachedJournalsAndQuests(programId, sessionId = 'default') {
  return storeGet('journals_quests', historyCacheKey(programId, sessionId));
}

function normalizeModEntry(raw) {
  const username = String(raw?.username || raw?.handle || '').trim().replace(/^@/, '').split('@')[0].toLowerCase();
  if (!username) return null;
  const proto = String(raw?.protocol || 'threads').trim().toLowerCase();
  return {
    username,
    displayName: String(raw?.displayName || raw?.display_name || ''),
    acct: String(raw?.acct || (proto === 'threads' ? `${username}@threads.net` : username)),
    protocol: proto,
    canonicalActor: String(raw?.canonicalActor || `${proto}:${username}`),
  };
}

export async function getLocalModeratedAccounts() {
  const raw = await kvGet('local_moderated_accounts_v1', null);
  return {
    blocks: Array.isArray(raw?.blocks) ? raw.blocks : [],
    mutes: Array.isArray(raw?.mutes) ? raw.mutes : [],
  };
}

export async function saveLocalModeratedAccounts({ blocks = null, mutes = null } = {}) {
  const cur = await getLocalModeratedAccounts();
  const next = {
    blocks: Array.isArray(blocks) ? blocks.map(normalizeModEntry).filter(Boolean) : cur.blocks,
    mutes: Array.isArray(mutes) ? mutes.map(normalizeModEntry).filter(Boolean) : cur.mutes,
  };
  await kvSet('local_moderated_accounts_v1', next);
  return next;
}

export async function removeLocalModeratedAccount(kind, actorOrHandle) {
  const key = kind === 'mutes' || kind === 'mute' ? 'mutes' : 'blocks';
  const cur = await getLocalModeratedAccounts();
  const raw = String(actorOrHandle || '').trim().toLowerCase();
  const bare = raw.replace(/^(?:threads|bluesky|mastodon):/, '').replace(/^@/, '').split('@')[0];
  const nextList = cur[key].filter((row) => {
    const u = String(row?.username || '').toLowerCase();
    const c = String(row?.canonicalActor || '').toLowerCase();
    const a = String(row?.acct || '').toLowerCase();
    return u !== bare && c !== raw && a !== raw;
  });
  const next = { ...cur, [key]: nextList };
  await kvSet('local_moderated_accounts_v1', next);
  return next;
}
