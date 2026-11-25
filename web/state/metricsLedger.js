import {
  normalizeNativeUri,
  pickMetrics,
  sumMetricsBreakdown,
} from '../core/schema/unifiedItem.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';

const LEDGER_KV_KEY = 'post_metrics_ledger_v2';
const NETWORKS = ['mastodon', 'bluesky', 'threads'];
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
    || (item.protocol === 'mastodon' && item.id ? String(item.id).replace(/^mastodon:/, '') : '');
  if (mastoId) keys.mastodon = `mastodon:${String(mastoId)}`;
  const rawBsky = linked.blueskyUri || meta.bluesky?.uri || '';
  if (rawBsky) keys.bluesky = `bluesky:${normalizeNativeUri(rawBsky) || String(rawBsky)}`;
  const threadsId = linked.threadsPostId || meta.threads?.postId || '';
  if (threadsId) keys.threads = `threads:${String(threadsId)}`;
  return keys;
}

function breakdownOf(item) {
  const bd = item?._meta?.metricsBreakdown;
  return bd && typeof bd === 'object' ? bd : null;
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
  const bd = breakdownOf(item);
  let changed = false;
  if (bd) {
    for (const net of NETWORKS) {
      if (bd[net] && keys[net] && recordNetworkMetrics(keys[net], bd[net])) changed = true;
    }
    return changed;
  }
  const proto = item.protocol || '';
  if (proto && keys[proto] && item.metrics) changed = recordNetworkMetrics(keys[proto], item.metrics);
  return changed;
}

export function applyKnownMetrics(item) {
  if (!item || typeof item !== 'object') return item;
  const keys = networkKeysOf(item);
  const proto = item.protocol || '';
  const existingBd = breakdownOf(item);
  const nextBd = existingBd
    ? { ...existingBd }
    : (proto && keys[proto] ? { [proto]: pickMetrics(item.metrics) } : {});
  let changed = false;
  for (const net of NETWORKS) {
    const known = getNetworkMetrics(keys[net]);
    if (!known) continue;
    const cur = nextBd[net];
    if (!cur || (!hasAnyCount(cur) && hasAnyCount(known))) {
      nextBd[net] = known;
      changed = true;
    }
  }
  if (!changed) return item;
  const metrics = sumMetricsBreakdown(nextBd);
  if (Object.keys(nextBd).length < 2) return { ...item, metrics };
  return { ...item, metrics, _meta: { ...(item._meta || {}), metricsBreakdown: nextBd } };
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
