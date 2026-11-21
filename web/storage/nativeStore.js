/**
 * Local persistence facade across three runtimes:
 *  1) Capacitor Android: routes to SanctuaryNativeStorePlugin (SQLiteOpenHelper + AndroidKeyStore)
 *  2) Browser / Desktop WebView2: IndexedDB (sanctuary_pwa_db) + Web Crypto non-extractable AES-GCM vault
 *  3) Isolated Test Harness (node --test): AES-GCM WebCrypto encrypted in-memory vault
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

const IDB_NAME = 'sanctuary_pwa_db';
const IDB_VERSION = 1;
const VAULT_KEY_KV_ID = 'vault_aes_key';
const LINKED_POSTS_KV_KEY = 'local_linked_posts_v1';
const FILTER_RULES_KV_KEY = 'local_filter_rules_v1';
const RETRIES_KV_KEY = 'local_retries_v1';

let idbPromise = null;
let vaultKeyPromise = null;
let linkedPostsHydrated = false;
let filtersHydrated = false;
let retriesHydrated = false;
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

function openIdb() {
  if (getAndroidPlugin()) return Promise.resolve(null);
  if (typeof globalThis.indexedDB?.open !== 'function') return Promise.resolve(null);
  if (idbPromise) return idbPromise;

  idbPromise = new Promise((resolve) => {
    try {
      const req = globalThis.indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const name of STORE_NAMES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name);
          }
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        db.onversionchange = () => {
          db.close();
          idbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => {
        idbPromise = null;
        resolve(null);
      };
      req.onblocked = () => {
        idbPromise = null;
        resolve(null);
      };
    } catch {
      idbPromise = null;
      resolve(null);
    }
  });
  return idbPromise;
}

function idbRun(db, storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    let result;
    let settled = false;
    tx.oncomplete = () => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };
    tx.onerror = () => {
      if (!settled) {
        settled = true;
        reject(tx.error || new Error('IndexedDB transaction failed'));
      }
    };
    tx.onabort = () => {
      if (!settled) {
        settled = true;
        reject(tx.error || new Error('IndexedDB transaction aborted'));
      }
    };
    fn(store, (val) => {
      result = val;
    });
  });
}

export function resetMemoryStorageForTests() {
  for (const store of memoryStores.values()) {
    store.clear();
  }
  memoryLinkedPosts.clear();
  memoryFilters.clear();
  memoryRetries.clear();
  linkedPostsHydrated = false;
  filtersHydrated = false;
  retriesHydrated = false;
  vaultKeyPromise = null;
  idbPromise = null;
}

export async function storeGet(storeName, key) {
  assertStoreName(storeName);
  const strKey = String(key);

  const android = getAndroidPlugin();
  if (android) {
    const res = await android.kvGet({ storeName, key: strKey });
    return res?.value ? JSON.parse(res.value) : null;
  }

  const db = await openIdb();
  if (db) {
    return idbRun(db, storeName, 'readonly', (store, setResult) => {
      const req = store.get(strKey);
      req.onsuccess = () => {
        setResult(req.result === undefined ? null : req.result);
      };
    });
  }

  const entry = memoryStores.get(storeName).get(strKey);
  return entry === undefined ? null : safeClone(entry);
}

export async function storePut(storeName, key, value) {
  assertStoreName(storeName);
  const strKey = String(key);

  const android = getAndroidPlugin();
  if (android) {
    await android.kvPut({ storeName, key: strKey, value: JSON.stringify(value ?? null) });
    return;
  }

  const db = await openIdb();
  if (db) {
    await idbRun(db, storeName, 'readwrite', (store) => {
      store.put(value === undefined ? null : value, strKey);
    });
    return;
  }

  memoryStores.get(storeName).set(strKey, safeClone(value));
}

export async function storeDelete(storeName, key) {
  assertStoreName(storeName);
  const strKey = String(key);

  const android = getAndroidPlugin();
  if (android) {
    await android.kvDelete({ storeName, key: strKey });
    return;
  }

  const db = await openIdb();
  if (db) {
    await idbRun(db, storeName, 'readwrite', (store) => {
      store.delete(strKey);
    });
    return;
  }

  memoryStores.get(storeName).delete(strKey);
}

export async function storeGetAll(storeName) {
  assertStoreName(storeName);

  const android = getAndroidPlugin();
  if (android) {
    const res = await android.kvGetAll({ storeName });
    const rows = Array.isArray(res?.entries) ? res.entries : [];
    return rows.map((r) => ({ key: String(r.key), value: r.value ? JSON.parse(r.value) : null }));
  }

  const db = await openIdb();
  if (db) {
    return idbRun(db, storeName, 'readonly', (store, setResult) => {
      const keysReq = store.getAllKeys();
      const valsReq = store.getAll();
      let keys = null;
      let vals = null;
      const finish = () => {
        if (keys !== null && vals !== null) {
          setResult(keys.map((k, i) => ({ key: String(k), value: vals[i] })));
        }
      };
      keysReq.onsuccess = () => {
        keys = keysReq.result || [];
        finish();
      };
      valsReq.onsuccess = () => {
        vals = valsReq.result || [];
        finish();
      };
    });
  }

  const out = [];
  for (const [key, value] of memoryStores.get(storeName).entries()) {
    out.push({ key, value: safeClone(value) });
  }
  return out;
}

export async function storeClear(storeName) {
  assertStoreName(storeName);

  const android = getAndroidPlugin();
  if (android) {
    await android.kvClear({ storeName });
    return;
  }

  const db = await openIdb();
  if (db) {
    await idbRun(db, storeName, 'readwrite', (store) => {
      store.clear();
    });
    return;
  }

  memoryStores.get(storeName).clear();
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
    await storePut('kv', VAULT_KEY_KV_ID, key);
    return key;
  })().catch((err) => {
    vaultKeyPromise = null;
    throw err;
  });
  return vaultKeyPromise;
}

/**
 * Store social credential in Android Keystore (mobile) or WebCrypto AES-GCM cipher store
 * backed by IndexedDB (browser / desktop WebView2) or memory (tests).
 */
export async function saveVaultSecret(accountId, secretObj) {
  const android = getAndroidPlugin();
  if (android) {
    await android.setSecret({ key: String(accountId), value: JSON.stringify(secretObj ?? {}) });
    return;
  }

  const cryptoObj = getCryptoApi();
  const key = await getOrCreateVaultKey();
  const iv = cryptoObj.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(secretObj ?? {}));
  const encryptedBuffer = await cryptoObj.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  await storePut('social_vault', String(accountId), {
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

  const record = await storeGet('social_vault', String(accountId));
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
  const android = getAndroidPlugin();
  if (android) {
    await android.deleteSecret({ key: String(accountId) });
    return;
  }

  await storeDelete('social_vault', String(accountId));
}

export async function listVaultIds() {
  const android = getAndroidPlugin();
  if (android) {
    const res = await android.listSecretIds();
    return Array.isArray(res?.ids) ? res.ids : [];
  }
  const entries = await storeGetAll('social_vault');
  return entries.map((e) => e.key);
}

// ── Cross-Post Linked IDs, Filter Rules, and Retry Queue ──

async function ensureLinkedPostsHydrated() {
  if (linkedPostsHydrated) return;
  linkedPostsHydrated = true;
  const saved = await storeGet('kv', LINKED_POSTS_KV_KEY).catch(() => null);
  if (Array.isArray(saved)) {
    for (const rec of saved) {
      if (rec?.canonicalId && !memoryLinkedPosts.has(String(rec.canonicalId))) {
        memoryLinkedPosts.set(String(rec.canonicalId), { ...rec });
      }
    }
  }
}

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
  await ensureLinkedPostsHydrated();
  return [...memoryLinkedPosts.values()].reverse().slice(0, Math.max(1, limit));
}

export async function saveLocalLinkedPost(record) {
  if (!record?.canonicalId) return;
  const android = getAndroidPlugin();
  if (!android || typeof android.listLinkedPosts !== 'function') {
    await ensureLinkedPostsHydrated();
  }
  memoryLinkedPosts.set(record.canonicalId, { ...record });
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
  await ensureLinkedPostsHydrated();
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
  await ensureLinkedPostsHydrated();
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
  if (!android || typeof android.listLinkedPosts !== 'function') {
    await ensureLinkedPostsHydrated();
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
  if (!android || typeof android.listLinkedPosts !== 'function') {
    await ensureLinkedPostsHydrated();
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

async function ensureFiltersHydrated() {
  if (filtersHydrated) return;
  filtersHydrated = true;
  const saved = await storeGet('kv', FILTER_RULES_KV_KEY).catch(() => null);
  if (Array.isArray(saved)) {
    for (const rule of saved) {
      if (rule?.id && !memoryFilters.has(String(rule.id))) {
        memoryFilters.set(String(rule.id), { ...rule });
      }
    }
  }
}

async function syncFiltersKvSnapshot() {
  await storePut('kv', FILTER_RULES_KV_KEY, [...memoryFilters.values()]).catch(() => {});
}

export async function listLocalFilterRules() {
  await ensureFiltersHydrated();
  return [...memoryFilters.values()];
}

export async function saveLocalFilterRule(rule) {
  if (!rule?.id) return;
  await ensureFiltersHydrated();
  memoryFilters.set(String(rule.id), { ...rule });
  await syncFiltersKvSnapshot();
}

export async function deleteLocalFilterRule(id) {
  await ensureFiltersHydrated();
  if (memoryFilters.delete(String(id))) {
    await syncFiltersKvSnapshot();
  }
}

async function ensureRetriesHydrated() {
  if (retriesHydrated) return;
  retriesHydrated = true;
  const saved = await storeGet('kv', RETRIES_KV_KEY).catch(() => null);
  if (Array.isArray(saved)) {
    for (const entry of saved) {
      if (entry?.id && !memoryRetries.has(String(entry.id))) {
        memoryRetries.set(String(entry.id), { ...entry });
      }
    }
  }
}

async function syncRetriesKvSnapshot() {
  await storePut('kv', RETRIES_KV_KEY, [...memoryRetries.values()]).catch(() => {});
}

export async function enqueueLocalRetry(entry) {
  if (!entry?.id) return;
  await ensureRetriesHydrated();
  memoryRetries.set(String(entry.id), { ...entry });
  await syncRetriesKvSnapshot();
}

export async function listLocalRetries() {
  await ensureRetriesHydrated();
  return [...memoryRetries.values()];
}

export async function deleteLocalRetry(id) {
  await ensureRetriesHydrated();
  if (memoryRetries.delete(String(id))) {
    await syncRetriesKvSnapshot();
  }
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

function normalizeModProtocol(rawProto, rawHandle = '', rawId = '') {
  const cleanP = String(rawProto || '').trim().toLowerCase();
  if (cleanP === 'fediverse' || cleanP === 'mastodon') return 'mastodon';
  if (cleanP === 'bluesky') return 'bluesky';
  if (cleanP === 'threads') return 'threads';
  const lowH = String(rawHandle || '').trim().toLowerCase();
  const lowId = String(rawId || '').trim().toLowerCase();
  if (lowH.endsWith('@bsky.brid.gy') || lowId.startsWith('did:') || lowId.startsWith('bluesky:')) return 'bluesky';
  if (lowH.includes('@') && !lowH.endsWith('@threads.net')) return 'mastodon';
  return 'threads';
}

function normalizeModEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawHandleInput = String(raw.acct || raw.username || raw.handle || '').trim().replace(/^@/, '');
  const rawId = String(raw.id || raw.did || '').trim();
  const proto = normalizeModProtocol(raw.protocol, rawHandleInput, rawId);
  const lowH = rawHandleInput.toLowerCase();
  const lowId = rawId.toLowerCase();

  let username = '';
  let acct = '';
  let canonicalActor = String(raw.canonicalActor || '').trim().toLowerCase();

  if (proto === 'threads') {
    username = lowH.replace(/^threads:/, '').replace(/@threads\.net$/, '').split('@')[0];
    if (!username && lowId) username = lowId.replace(/^threads:/, '').split('@')[0];
    acct = username ? `${username}@threads.net` : '';
    if (!canonicalActor && username) canonicalActor = `threads:${username}`;
  } else if (proto === 'bluesky') {
    const cleanBsky = lowH.replace(/^bluesky:/, '').replace(/@bsky\.brid\.gy$/, '');
    username = cleanBsky || lowId.replace(/^bluesky:/, '');
    acct = cleanBsky || rawId;
    if (!canonicalActor) {
      canonicalActor = cleanBsky
        ? `bluesky:${cleanBsky}`
        : (lowId ? (lowId.startsWith('bluesky:') ? lowId : `bluesky:${lowId}`) : '');
    }
  } else {
    const cleanMasto = lowH.replace(/^(?:mastodon|fediverse):/, '');
    username = cleanMasto ? cleanMasto.split('@')[0] : lowId.replace(/^mastodon:/, '');
    acct = cleanMasto || rawId;
    if (!canonicalActor) {
      canonicalActor = cleanMasto
        ? `mastodon:${cleanMasto}`
        : (lowId ? (lowId.startsWith('mastodon:') ? lowId : `mastodon:${lowId}`) : '');
    }
  }

  if (!username && !rawId && !acct) return null;
  return {
    ...(rawId ? { id: rawId } : {}),
    username,
    displayName: String(raw.displayName || raw.display_name || acct || username || rawId),
    acct: acct || username || rawId,
    protocol: proto,
    canonicalActor,
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
  const targetObj = actorOrHandle && typeof actorOrHandle === 'object' ? actorOrHandle : null;
  const targetId = String(targetObj ? (targetObj.id || targetObj.did || '') : actorOrHandle || '').trim().toLowerCase();
  const targetHandle = String(targetObj ? (targetObj.acct || targetObj.username || targetObj.handle || '') : actorOrHandle || '')
    .trim()
    .replace(/^@/, '')
    .toLowerCase();
  const targetCanon = String(targetObj?.canonicalActor || '').trim().toLowerCase();
  const targetBareThreads = targetHandle.replace(/^threads:/, '').replace(/@threads\.net$/, '').split('@')[0];
  const targetCleanBsky = targetHandle.replace(/^bluesky:/, '').replace(/@bsky\.brid\.gy$/, '');
  const targetCleanMasto = targetHandle.replace(/^(?:mastodon|fediverse):/, '');
  const rawCanonCandidates = new Set(
    [
      targetId,
      targetCanon,
      targetHandle,
      targetBareThreads ? `threads:${targetBareThreads}` : '',
      targetBareThreads ? `${targetBareThreads}@threads.net` : '',
      targetCleanBsky ? `bluesky:${targetCleanBsky}` : '',
      targetCleanMasto ? `mastodon:${targetCleanMasto}` : '',
    ].filter(Boolean)
  );

  const nextList = cur[key].filter((row) => {
    const rowProto = String(row?.protocol || 'threads').toLowerCase();
    const rowId = String(row?.id || '').trim().toLowerCase();
    const rowU = String(row?.username || '').trim().replace(/^@/, '').toLowerCase();
    const rowC = String(row?.canonicalActor || '').trim().toLowerCase();
    const rowA = String(row?.acct || '').trim().replace(/^@/, '').toLowerCase();
    if (rowC && rawCanonCandidates.has(rowC)) return false;
    if (rowId && (rowId === targetId || rawCanonCandidates.has(rowId) || rawCanonCandidates.has(`${rowProto}:${rowId}`))) return false;
    if (rowA && (rowA === targetHandle || rawCanonCandidates.has(rowA) || rawCanonCandidates.has(`${rowProto}:${rowA}`))) return false;
    if (rowProto === 'threads' && rowU && targetBareThreads && rowU === targetBareThreads && !targetCleanMasto.includes('@')) {
      return false;
    }
    if (rowProto === 'bluesky' && rowU && targetCleanBsky && rowU === targetCleanBsky) {
      return false;
    }
    return true;
  });
  const next = { ...cur, [key]: nextList };
  await kvSet('local_moderated_accounts_v1', next);
  return next;
}
