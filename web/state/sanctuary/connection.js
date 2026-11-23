import {
  detectDefaultNodeUrl,
  isSecureSanctuaryNodeUrl,
  normalizeNodeUrl,
  resolveNodeUrl,
} from '../../constants/endpoints.js';
import { applyRootProgramTheme } from '../../constants/theme.js';
import { fetchWrapper } from '../../queries/fetch/fetchWrapper.js';
import {
  cacheProgramsDirectory,
  deleteVaultSecret,
  getCachedProgramsDirectory,
  kvDelete,
  kvGet,
  kvSet,
  loadVaultSecret,
  saveVaultSecret,
} from '../../storage/kvStorage.js';
import { createStore } from '../store.js';

const NODE_URL_KV_KEY = 'sanctuary_node_url';
const NODE_AUTH_KV_KEY = 'sanctuary_auth_header';
const NODE_AUTH_SECRET_ID = 'sanctuary_server_basic_auth';
const INSECURE_NODE_ERROR = 'HTTPS is required for Sanctuary connections over the network. HTTP is allowed only on localhost.';

const fallbackEventTarget = new EventTarget();

function createInitialConnectionState() {
  return {
    mode: 'dormant',
    nodeUrl: '',
    authHeaders: {},
    gpuMode: 'idle',
    activeModel: '',
    activeProgram: '',
    generatingSessions: [],
    programs: [],
    avatarVersions: {},
    runtimeConfig: null,
    lastCheckedAt: 0,
    error: null,
  };
}

export const connectionStore = createStore(createInitialConnectionState());

let pollTimer = null;
let connectionGeneration = 0;
let lastAvatarStamp = 0;
let lastCachedProgramsJson = '';

export function getProgramAvatarVersion(programId = '') {
  const id = String(programId || '').trim();
  const map = connectionStore.get().avatarVersions || {};
  return Number((id && map[id]) || map.__default || 0);
}

export function bumpProgramAvatarVersion(programId = '') {
  const id = String(programId || connectionStore.get().activeProgram || '').trim();
  const stamp = Math.max(Date.now(), lastAvatarStamp + 1);
  lastAvatarStamp = stamp;
  connectionStore.set((prev) => {
    const nextVersions = { ...(prev.avatarVersions || {}) };
    if (id) nextVersions[id] = stamp;
    else nextVersions.__default = stamp;
    const nextPrograms = Array.isArray(prev.programs)
      ? prev.programs.map((p) => (id && p?.id === id ? { ...p, has_profile: true } : p))
      : prev.programs;
    if (Array.isArray(nextPrograms) && nextPrograms.length > 0) {
      void cacheProgramsDirectory(nextPrograms);
    }
    return { avatarVersions: nextVersions, programs: nextPrograms };
  });
  return stamp;
}

/**
 * Emit a Sanctuary connection lifecycle event on window/globalThis (or internal target in Node).
 * @param {'sanctuary:online' | 'sanctuary:offline' | 'sanctuary:health'} eventName
 * @param {any} detail
 */
export function emitSanctuaryEvent(eventName, detail) {
  const event = new CustomEvent(eventName, { detail });
  if (typeof globalThis.dispatchEvent === 'function') {
    globalThis.dispatchEvent(event);
  } else {
    fallbackEventTarget.dispatchEvent(event);
  }
}

/**
 * Subscribe to a Sanctuary lifecycle event and return an unsubscribe callback.
 * @param {'sanctuary:online' | 'sanctuary:offline' | 'sanctuary:health'} eventName
 * @param {(event: CustomEvent) => void} handler
 * @returns {() => void}
 */
export function onSanctuaryEvent(eventName, handler) {
  const target = typeof globalThis.addEventListener === 'function'
    ? globalThis
    : fallbackEventTarget;
  target.addEventListener(eventName, handler);
  return () => target.removeEventListener(eventName, handler);
}

/**
 * @returns {string}
 */
export function getSanctuaryNodeUrl() {
  return connectionStore.get().nodeUrl;
}

/**
 * @returns {Record<string, string>}
 */
export function getSanctuaryAuthHeaders() {
  return connectionStore.get().authHeaders || {};
}

/**
 * @param {string} username
 * @param {string} password
 * @returns {Promise<void>}
 */
export async function setSanctuaryBasicAuth(username, password) {
  const user = String(username || '').trim();
  const pass = String(password || '');
  if (!user && !pass) {
    await deleteVaultSecret(NODE_AUTH_SECRET_ID);
    await kvDelete(NODE_AUTH_KV_KEY);
    connectionStore.set({ authHeaders: {} });
    return;
  }
  const encoded = btoa(String.fromCharCode(...new TextEncoder().encode(`${user}:${pass}`)));
  const headerValue = `Basic ${encoded}`;
  await saveVaultSecret(NODE_AUTH_SECRET_ID, { authorization: headerValue });
  await kvDelete(NODE_AUTH_KV_KEY);
  connectionStore.set({ authHeaders: { Authorization: headerValue } });
}

export function stopSanctuaryConnection() {
  connectionGeneration += 1;
  lastCachedProgramsJson = '';
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * Run a single background /api/mobile/health check against the configured Sanctuary node.
 * Does nothing when nodeUrl is empty (dormant mode).
 * @param {{ fetchImpl?: typeof fetch, locationObj?: Location }} [options]
 */
export async function checkSanctuaryHealth(options = {}) {
  const snapshot = connectionStore.get();
  if (!snapshot.nodeUrl) {
    return null;
  }
  const gen = connectionGeneration;
  if (!isSecureSanctuaryNodeUrl(snapshot.nodeUrl)) {
    connectionStore.set({
      mode: 'offline',
      lastCheckedAt: Date.now(),
      error: INSECURE_NODE_ERROR,
    });
    return null;
  }
  const healthUrl = resolveNodeUrl('/api/mobile/health', snapshot.nodeUrl);

  try {
    const reqOpts = {
      timeoutMs: 8000,
      headers: snapshot.authHeaders,
      locationObj: options.locationObj,
      fetchImpl: options.fetchImpl,
    };
    let health;
    try {
      health = await fetchWrapper(healthUrl, reqOpts);
    } catch {
      if (gen !== connectionGeneration) {
        return null;
      }
      health = await fetchWrapper(healthUrl, reqOpts);
    }
    if (gen !== connectionGeneration) {
      return null;
    }

    const wasOnline = connectionStore.get().mode === 'online';
    const programs = Array.isArray(health?.programs) ? health.programs : [];
    const nextProgramsJson = JSON.stringify(programs);
    if (nextProgramsJson !== lastCachedProgramsJson) {
      lastCachedProgramsJson = nextProgramsJson;
      await cacheProgramsDirectory(programs);
    }

    let runtimeConfig = connectionStore.get().runtimeConfig;
    if (!wasOnline) {
      try {
        const configUrl = resolveNodeUrl('/api/config', snapshot.nodeUrl);
        runtimeConfig = await fetchWrapper(configUrl, {
          timeoutMs: 3000,
          background: true,
          headers: snapshot.authHeaders,
          locationObj: options.locationObj,
          fetchImpl: options.fetchImpl,
        });
      } catch {
        // Keep existing runtimeConfig if /api/config is temporarily unavailable.
      }
      if (gen !== connectionGeneration) {
        return null;
      }
    }

    connectionStore.set({
      mode: 'online',
      gpuMode: health?.gpu_mode || 'idle',
      activeModel: health?.active_model || '',
      activeProgram: health?.active_program || '',
      generatingSessions: Array.isArray(health?.generating_sessions) ? health.generating_sessions : [],
      programs,
      runtimeConfig,
      lastCheckedAt: Date.now(),
      error: null,
    });

    const activeProg = programs.find((p) => p?.id === health?.active_program) || programs[0];
    if (activeProg) {
      applyRootProgramTheme(activeProg.theme || activeProg.accent_color || activeProg.theme_color);
    }

    emitSanctuaryEvent('sanctuary:health', health);
    if (!wasOnline) {
      emitSanctuaryEvent('sanctuary:online', health);
    }
    return health;
  } catch (err) {
    if (gen !== connectionGeneration) {
      return null;
    }
    const prev = connectionStore.get();
    const cachedPrograms = prev.programs.length > 0 ? prev.programs : await getCachedProgramsDirectory();
    const errMsg = err?.message || 'Sanctuary node unreachable';

    connectionStore.set({
      mode: 'offline',
      programs: cachedPrograms,
      lastCheckedAt: Date.now(),
      error: errMsg,
    });

    if (prev.mode !== 'offline') {
      emitSanctuaryEvent('sanctuary:offline', { error: errMsg });
    }
    return null;
  }
}

function startPollingLoop(pollIntervalMs, options) {
  if (pollIntervalMs > 0) {
    pollTimer = setInterval(() => {
      void checkSanctuaryHealth(options);
    }, pollIntervalMs);
    pollTimer?.unref?.();
  }
}

/**
 * Initialize Sanctuary companion connection monitoring.
 * Remains completely dormant (zero timers, zero fetches) on unconfigured standalone installs.
 * @param {{
 *   pollIntervalMs?: number,
 *   fetchImpl?: typeof fetch,
 *   locationObj?: Location,
 *   capacitorObj?: { isNativePlatform?: () => boolean },
 * }} [options]
 */
export async function initSanctuaryConnection(options = {}) {
  const {
    pollIntervalMs = 10000,
    fetchImpl,
    locationObj,
    capacitorObj,
  } = options;

  stopSanctuaryConnection();

  const [savedUrl, legacyAuthHeader, savedAuthSecret, cachedPrograms] = await Promise.all([
    kvGet(NODE_URL_KV_KEY, null),
    kvGet(NODE_AUTH_KV_KEY, ''),
    loadVaultSecret(NODE_AUTH_SECRET_ID),
    getCachedProgramsDirectory(),
  ]);

  let savedAuthHeader = String(savedAuthSecret?.authorization || '');
  if (legacyAuthHeader) {
    if (!savedAuthHeader) {
      savedAuthHeader = String(legacyAuthHeader);
      await saveVaultSecret(NODE_AUTH_SECRET_ID, { authorization: savedAuthHeader });
    }
    await kvDelete(NODE_AUTH_KV_KEY);
  }

  let resolvedUrl = '';
  if (savedUrl !== null && savedUrl !== undefined) {
    resolvedUrl = normalizeNodeUrl(String(savedUrl));
  } else {
    resolvedUrl = detectDefaultNodeUrl({ locationObj, capacitorObj });
  }

  const authHeaders = savedAuthHeader ? { Authorization: savedAuthHeader } : {};

  if (resolvedUrl && !isSecureSanctuaryNodeUrl(resolvedUrl)) {
    connectionStore.set({
      ...createInitialConnectionState(),
      authHeaders,
      programs: cachedPrograms,
      mode: 'offline',
      nodeUrl: '',
      error: INSECURE_NODE_ERROR,
    });
    return connectionStore.get();
  }

  if (!resolvedUrl) {
    connectionStore.set({
      ...createInitialConnectionState(),
      authHeaders,
      programs: cachedPrograms,
      mode: 'dormant',
      nodeUrl: '',
    });
    return connectionStore.get();
  }

  connectionStore.set({
    ...createInitialConnectionState(),
    mode: 'connecting',
    nodeUrl: resolvedUrl,
    authHeaders,
    programs: cachedPrograms,
  });

  await checkSanctuaryHealth({ fetchImpl, locationObj });
  startPollingLoop(pollIntervalMs, { fetchImpl, locationObj });
  return connectionStore.get();
}

/**
 * Validate, persist, and immediately connect to (or disconnect from) a Sanctuary node URL.
 * @param {string} rawUrl
 * @param {{ pollIntervalMs?: number, fetchImpl?: typeof fetch, locationObj?: Location }} [options]
 */
export async function setSanctuaryNodeUrl(rawUrl, options = {}) {
  const { pollIntervalMs = 10000, fetchImpl, locationObj } = options;
  const normalized = normalizeNodeUrl(rawUrl || '');
  if (normalized && !isSecureSanctuaryNodeUrl(normalized)) {
    throw new TypeError(INSECURE_NODE_ERROR);
  }

  stopSanctuaryConnection();
  await kvSet(NODE_URL_KV_KEY, normalized);

  if (!normalized) {
    connectionStore.set({
      mode: 'dormant',
      nodeUrl: '',
      gpuMode: 'idle',
      activeModel: '',
      activeProgram: '',
      generatingSessions: [],
      runtimeConfig: null,
      error: null,
    });
    return connectionStore.get();
  }

  connectionStore.set({
    mode: 'connecting',
    nodeUrl: normalized,
    error: null,
  });
  await checkSanctuaryHealth({ fetchImpl, locationObj });
  startPollingLoop(pollIntervalMs, { fetchImpl, locationObj });
  return connectionStore.get();
}

export function resetConnectionStoreForTests() {
  stopSanctuaryConnection();
  connectionStore.set(createInitialConnectionState());
}
