import {
  normalizeNativeUri,
  pickMetrics,
  sumMetricsBreakdown,
} from '../core/schema/unifiedItem.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';

const LEDGER_KV_KEY = 'post_metrics_ledger_v1';
const MAX_ENTRIES = 1500;
const PERSIST_DEBOUNCE_MS = 150;

const ledger = new Map();
let hydrated = false;
let hydratePromise = null;
let persistTimer = null;

function metricsEqual(a, b) {
  if (!a || !b) return false;
  return (
    Number(a.likes || 0) === Number(b.likes || 0)
    && Number(a.replies || 0) === Number(b.replies || 0)
    && Number(a.reposts || 0) === Number(b.reposts || 0)
  );
}

function hasAnyCount(m) {
  return Boolean(m && (Number(m.likes || 0) > 0 || Number(m.replies || 0) > 0 || Number(m.reposts || 0) > 0));
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    if (ledger.size > MAX_ENTRIES) {
      const sorted = [...ledger.entries()].sort((a, b) => (b[1]?.ts || 0) - (a[1]?.ts || 0));
      ledger.clear();
      for (const [k, v] of sorted.slice(0, MAX_ENTRIES)) {
        ledger.set(k, v);
      }
    }
    const payload = {};
    for (const [k, v] of ledger.entries()) {
      payload[k] = v;
    }
    void kvSet(LEDGER_KV_KEY, payload).catch((err) => {
      console.warn('[metricsLedger] Failed to persist metrics ledger:', err);
    });
  }, PERSIST_DEBOUNCE_MS);
  if (typeof persistTimer?.unref === 'function') {
    persistTimer.unref();
  }
}

export async function hydrateMetricsLedger() {
  if (hydrated) return;
  if (hydratePromise) return hydratePromise;
  hydratePromise = (async () => {
    try {
      const saved = await kvGet(LEDGER_KV_KEY, null);
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [key, val] of Object.entries(saved)) {
          if (!key || !val || typeof val !== 'object') continue;
          if (!ledger.has(key)) {
            ledger.set(key, {
              ...pickMetrics(val),
              ts: Number(val.ts || 0) || Date.now(),
            });
          }
        }
      }
    } catch (err) {
      console.warn('[metricsLedger] Failed to hydrate metrics ledger:', err);
    } finally {
      hydrated = true;
      hydratePromise = null;
    }
  })();
  return hydratePromise;
}

export function networkKeysOf(item) {
  if (!item || typeof item !== 'object') return {};
  const meta = item._meta || {};
  const linked = meta.linkedIds || {};
  const keys = {};

  const mastoId = linked.mastodonStatusId
    || meta.mastodon?.statusId
    || (item.source === 'mastodon' ? item.nativeId : null);
  if (mastoId) {
    keys.mastodon = `mastodon:${String(mastoId)}`;
  }

  const rawBsky = linked.blueskyUri
    || meta.bluesky?.uri
    || (item.source === 'bluesky' ? (item.nativeUri || item.nativeId) : null);
  if (rawBsky) {
    const normBsky = normalizeNativeUri(rawBsky) || String(rawBsky);
    if (normBsky) {
      keys.bluesky = `bluesky:${normBsky}`;
    }
  }

  const threadsId = linked.threadsPostId
    || meta.threads?.postId
    || (item.source === 'threads' ? item.nativeId : null);
  if (threadsId) {
    keys.threads = `threads:${String(threadsId)}`;
  }

  return keys;
}

export function getNetworkMetrics(key) {
  if (!key) return null;
  const entry = ledger.get(String(key));
  return entry ? pickMetrics(entry) : null;
}

export function recordNetworkMetrics(key, metrics) {
  if (!key || !metrics || typeof metrics !== 'object') return false;
  const k = String(key);
  const next = pickMetrics(metrics);
  const existing = ledger.get(k);
  if (existing && metricsEqual(existing, next)) {
    existing.ts = Date.now();
    return false;
  }
  ledger.set(k, { ...next, ts: Date.now() });
  schedulePersist();
  return true;
}

export function recordItemMetrics(item) {
  if (!item || typeof item !== 'object') return false;
  const keys = networkKeysOf(item);
  let changed = false;
  const bd = item.metricsBreakdown || item._meta?.metricsBreakdown;

  if (bd && typeof bd === 'object') {
    for (const net of ['mastodon', 'bluesky', 'threads']) {
      if (bd[net] && keys[net]) {
        if (recordNetworkMetrics(keys[net], bd[net])) {
          changed = true;
        }
      }
    }
  }

  const keyEntries = Object.entries(keys);
  if (keyEntries.length === 1 && item.metrics && (!bd || Object.keys(bd).length === 0)) {
    const [, singleKey] = keyEntries[0];
    if (recordNetworkMetrics(singleKey, item.metrics)) {
      changed = true;
    }
  } else if (item.source && keys[item.source] && item.metrics && (!bd || !bd[item.source])) {
    if (recordNetworkMetrics(keys[item.source], item.metrics)) {
      changed = true;
    }
  }

  return changed;
}

export function applyKnownMetrics(item) {
  if (!item || typeof item !== 'object') return item;
  const keys = networkKeysOf(item);
  const netList = ['mastodon', 'bluesky', 'threads'];
  const existingBd = (item.metricsBreakdown && typeof item.metricsBreakdown === 'object')
    ? item.metricsBreakdown
    : (item._meta?.metricsBreakdown && typeof item._meta.metricsBreakdown === 'object'
        ? item._meta.metricsBreakdown
        : null);

  const nextBd = existingBd ? { ...existingBd } : {};
  let bdChanged = false;

  if (!existingBd && item.source && keys[item.source] && item.metrics) {
    const knownForSource = getNetworkMetrics(keys[item.source]);
    if (hasAnyCount(item.metrics) || knownForSource) {
      nextBd[item.source] = hasAnyCount(item.metrics)
        ? pickMetrics(item.metrics)
        : knownForSource;
    }
  }

  for (const net of netList) {
    const key = keys[net];
    if (!key) continue;
    const known = getNetworkMetrics(key);
    if (!known) continue;
    const cur = nextBd[net];
    if (!cur) {
      nextBd[net] = known;
      bdChanged = true;
    } else if (!hasAnyCount(cur) && hasAnyCount(known)) {
      nextBd[net] = known;
      bdChanged = true;
    }
  }

  const bdKeys = Object.keys(nextBd);
  if (bdKeys.length === 0) return item;

  const summed = sumMetricsBreakdown(nextBd);
  const curMetrics = pickMetrics(item.metrics);
  const metricsChanged = !metricsEqual(curMetrics, summed);

  if (!bdChanged && !metricsChanged) {
    return item;
  }

  return {
    ...item,
    metrics: summed,
    metricsBreakdown: nextBd,
  };
}

export function resetMetricsLedgerForTests() {
  ledger.clear();
  hydrated = false;
  hydratePromise = null;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
}
