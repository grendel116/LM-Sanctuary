import { getAuthenticatedAccount } from '../state/authStore.js';
import { kvGet, kvSet } from '../storage/nativeStore.js';
import { followAccount, lookupAccountByAcct, searchFediverse } from './fediverse.js';

const THREADS_HANDLE_RE = /^[A-Za-z0-9_.][A-Za-z0-9._-]{0,63}$/;
const utf8FatalDecoder = new TextDecoder('utf-8', { fatal: true });
const utf8LossyDecoder = new TextDecoder('utf-8');
const latin1BytesBuf = (str) => {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i += 1) bytes[i] = str.charCodeAt(i) & 0xff;
  return bytes;
};

let clientJobState = {
  status: 'idle',
  total: 0,
  processed: 0,
  followed: 0,
  notFederated: 0,
  errors: 0,
  currentHandle: '',
  startedAt: 0,
  finishedAt: 0,
  errorMessage: '',
};
let clientJobCancelled = false;
let clientJobPromise = null;

export function clearThreadsImportStateForTests() {
  clientJobCancelled = true;
  clientJobPromise = null;
  clientJobState = {
    status: 'idle',
    total: 0,
    processed: 0,
    followed: 0,
    notFederated: 0,
    errors: 0,
    currentHandle: '',
    startedAt: 0,
    finishedAt: 0,
    errorMessage: '',
  };
}

/**
 * Fix Meta Threads export JSON strings encoded as Latin-1 UTF-8 bytes.
 */
export function decodeMetaMojibake(raw) {
  const text = String(raw ?? '');
  if (!text) return '';
  let hasHighByte = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    if (c > 0xff) return text;
    if (c >= 0x80) hasHighByte = true;
  }
  if (!hasHighByte) return text;
  try {
    return utf8FatalDecoder.decode(latin1BytesBuf(text));
  } catch {
    return text;
  }
}

function normalizeHandle(raw) {
  const clean = decodeMetaMojibake(raw).trim().replace(/^@/, '').toLowerCase();
  return THREADS_HANDLE_RE.test(clean) ? clean : '';
}

function parseStringListEntries(payload, wrapperKey) {
  const rows = Array.isArray(payload?.[wrapperKey])
    ? payload[wrapperKey]
    : (Array.isArray(payload) ? payload : []);
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const title = decodeMetaMojibake(row.title || '').trim();
    const sdata = Array.isArray(row.string_list_data) ? row.string_list_data : [];
    for (const entry of sdata) {
      const handle = normalizeHandle(entry?.value || '');
      if (!handle || seen.has(handle)) continue;
      seen.add(handle);
      out.push({
        username: handle,
        displayName: title,
        timestamp: Number(entry?.timestamp || 0),
      });
    }
  }
  return out;
}

async function decompressZipBytes(compressedBytes, method) {
  if (method === 0) return compressedBytes;
  if (method !== 8) {
    throw new Error(`Unsupported ZIP compression method (${method})`);
  }
  if (typeof globalThis.DecompressionStream !== 'function') {
    throw new Error('DecompressionStream is unavailable for compressed ZIP archives.');
  }
  const stream = new globalThis.Blob([compressedBytes]).stream().pipeThrough(
    new globalThis.DecompressionStream('deflate-raw')
  );
  const ab = await new globalThis.Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

/**
 * Extract following and mutuals (intersected with followers.json) from a Threads ZIP buffer.
 */
export async function parseThreadsArchiveBuffer(arrayBuffer, sourceName = 'threads-export.zip') {
  const bytes = arrayBuffer instanceof Uint8Array ? arrayBuffer : new Uint8Array(arrayBuffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate End of Central Directory (PK\x05\x06 = 0x06054b50)
  let eocdPos = -1;
  const minScan = Math.max(0, bytes.length - 65558);
  for (let i = bytes.length - 22; i >= minScan; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdPos = i;
      break;
    }
  }
  if (eocdPos < 0) {
    throw new Error('Invalid ZIP file (End of Central Directory missing).');
  }

  const cdCount = view.getUint16(eocdPos + 10, true);
  let cdOffset = view.getUint32(eocdPos + 16, true);

  let followers = [];
  let following = [];

  for (let idx = 0; idx < cdCount && cdOffset + 46 <= bytes.length; idx += 1) {
    if (view.getUint32(cdOffset, true) !== 0x02014b50) break;
    const method = view.getUint16(cdOffset + 10, true);
    const compSize = view.getUint32(cdOffset + 20, true);
    const nameLen = view.getUint16(cdOffset + 28, true);
    const extraLen = view.getUint16(cdOffset + 30, true);
    const commentLen = view.getUint16(cdOffset + 32, true);
    const localOff = view.getUint32(cdOffset + 42, true);
    const rawName = utf8LossyDecoder.decode(bytes.subarray(cdOffset + 46, cdOffset + 46 + nameLen)).replace(/\\/g, '/').replace(/^\/+/, '');
    cdOffset += 46 + nameLen + extraLen + commentLen;

    let slot = '';
    if (rawName.endsWith('threads/followers.json') || rawName === 'followers.json') slot = 'followers';
    else if (rawName.endsWith('threads/following.json') || rawName === 'following.json') slot = 'following';
    if (!slot) continue;

    if (localOff + 30 > bytes.length || view.getUint32(localOff, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOff + 26, true);
    const lExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const slice = bytes.subarray(dataStart, dataStart + compSize);
    const plainBytes = await decompressZipBytes(slice, method);
    const jsonData = JSON.parse(utf8LossyDecoder.decode(plainBytes));

    if (slot === 'followers') followers = parseStringListEntries(jsonData, 'text_post_app_text_post_app_followers');
    else if (slot === 'following') following = parseStringListEntries(jsonData, 'text_post_app_text_post_app_following');
  }

  const followerMap = new Map(followers.map((r) => [r.username, r]));
  const mutuals = [];
  for (const row of following) {
    const fRow = followerMap.get(row.username);
    if (!fRow) continue;
    mutuals.push({
      username: row.username,
      displayName: row.displayName || fRow.displayName,
      timestamp: row.timestamp || fRow.timestamp,
    });
  }

  return {
    sourceName: String(sourceName || 'threads-export.zip'),
    importedAt: Date.now(),
    counts: {
      mutuals: mutuals.length,
      following: following.length,
    },
    mutuals,
    following,
  };
}

export function buildMastodonImportCsv(_kind, accounts = []) {
  const lines = ['Account address,Show boosts,Notify on new posts,Languages'];
  const seen = new Set();
  for (const row of Array.isArray(accounts) ? accounts : []) {
    const handle = normalizeHandle(typeof row === 'string' ? row : row?.username);
    if (!handle || seen.has(handle)) continue;
    seen.add(handle);
    lines.push(`${handle}@threads.net,true,false,`);
  }
  return `${lines.join('\n')}\n`;
}

function getBackendOriginIfAvailable() {
  if (globalThis.Capacitor?.Plugins?.SanctuaryNativeStore) return '';
  if (typeof globalThis.process?.versions?.node === 'string' && !globalThis.__SANCTUARY_FORCE_HTTP_STORE__) {
    return '';
  }
  const loc = globalThis.location;
  if (!loc || !loc.origin || loc.origin === 'null') return '';
  if (loc.protocol !== 'http:' && loc.protocol !== 'https:') return '';
  return loc.origin.replace(/\/+$/, '');
}

async function resolveStrictFederatedThreadsAccount({ instanceUrl, accessToken, username }) {
  const handle = normalizeHandle(username);
  if (!handle) return null;
  const targetAcct = `${handle}@threads.net`;
  let acc = null;
  try {
    acc = await lookupAccountByAcct({ instanceUrl, accessToken, acct: targetAcct });
  } catch (err) {
    if (err?.status === 429 || String(err?.message || '').includes('429')) throw err;
    const res = await searchFediverse({
      instanceUrl,
      accessToken,
      query: targetAcct,
      type: 'accounts',
      resolve: true,
      limit: 3,
    }).catch(() => ({ accounts: [] }));
    acc = (res?.accounts || []).find((a) => {
      const acct = String(a?.acct || '').trim().replace(/^@/, '').toLowerCase();
      return acct === targetAcct || acct === `${handle}@threads.com`;
    }) || null;
  }
  if (!acc?.id) return null;
  const cleanAcct = String(acc.acct || '').trim().replace(/^@/, '').toLowerCase();
  if (cleanAcct !== targetAcct && cleanAcct !== `${handle}@threads.com`) return null;
  return acc;
}

export async function getThreadsImportState() {
  const origin = getBackendOriginIfAvailable();
  if (origin && typeof globalThis.fetch === 'function') {
    try {
      const res = await globalThis.fetch(`${origin}/api/social/threads/import-state`);
      if (res.ok) return res.json();
    } catch {
      // Fallback to local KV storage
    }
  }
  const archive = await kvGet('threads_import_archive_v1', null);
  const summary = archive?.counts
    ? {
        sourceName: archive.sourceName || '',
        importedAt: archive.importedAt || 0,
        counts: {
          mutuals: Number(archive.counts.mutuals || 0),
          following: Number(archive.counts.following || 0),
        },
      }
    : null;
  return { archive: summary, job: { ...clientJobState } };
}

export async function parseThreadsArchiveFile(file) {
  if (!file) throw new Error('Select a Threads export .zip file first.');
  const origin = getBackendOriginIfAvailable();
  if (origin && typeof globalThis.FormData === 'function' && typeof globalThis.fetch === 'function') {
    const form = new globalThis.FormData();
    form.append('file', file, file.name || 'threads-export.zip');
    const res = await globalThis.fetch(`${origin}/api/social/threads/import-parse`, {
      method: 'POST',
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Import parse failed (${res.status})`);
    return data;
  }

  const ab = await file.arrayBuffer();
  const parsed = await parseThreadsArchiveBuffer(ab, file.name || 'threads-export.zip');
  await kvSet('threads_import_archive_v1', parsed);
  return {
    sourceName: parsed.sourceName,
    importedAt: parsed.importedAt,
    counts: parsed.counts,
    job: { ...clientJobState },
  };
}

export async function downloadThreadsArchiveCsv(kind) {
  const cleanKind = String(kind || '').trim().toLowerCase();
  if (cleanKind !== 'mutuals' && cleanKind !== 'following') {
    throw new Error('Only mutuals and following CSV exports are supported.');
  }
  const origin = getBackendOriginIfAvailable();
  if (origin && globalThis.location && typeof globalThis.document?.createElement === 'function') {
    const doc = globalThis.document;
    const a = doc.createElement('a');
    a.href = `${origin}/api/social/threads/import-csv/${encodeURIComponent(cleanKind)}`;
    a.download = `mastodon_threads_${cleanKind}.csv`;
    doc.body?.appendChild(a);
    a.click();
    a.remove();
    return { filename: a.download };
  }

  const archive = await kvGet('threads_import_archive_v1', null);
  if (!archive || !Array.isArray(archive[cleanKind])) {
    throw new Error('No imported Threads archive found.');
  }
  const csv = buildMastodonImportCsv(cleanKind, archive[cleanKind]);
  const filename = `mastodon_threads_${cleanKind}.csv`;
  const doc = globalThis.document;
  if (doc && typeof URL?.createObjectURL === 'function') {
    const blob = new globalThis.Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = doc.createElement('a');
    a.href = url;
    a.download = filename;
    doc.body?.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }
  return { filename, csv };
}

export async function startThreadsArchiveSync({
  followScope = 'mutuals',
  delayMs = 1100,
} = {}) {
  const scope = followScope === 'following' ? 'following' : 'mutuals';
  const origin = getBackendOriginIfAvailable();
  if (origin && typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(`${origin}/api/social/threads/import-sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        followScope: scope,
        delaySec: Math.max(0, Number(delayMs) / 1000),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error || `Sync failed (${res.status})`);
    return data.job || clientJobState;
  }

  const archive = await kvGet('threads_import_archive_v1', null);
  if (!archive) throw new Error('Import a Threads data export ZIP first.');

  const followList = Array.isArray(archive[scope]) ? archive[scope] : [];
  const queueHandles = followList.map((r) => normalizeHandle(r?.username ?? r)).filter(Boolean);
  if (queueHandles.length === 0) {
    return { ...clientJobState, status: 'completed', total: 0, processed: 0 };
  }

  const mastoAuth = await getAuthenticatedAccount('fediverse');
  if (!mastoAuth?.secrets?.accessToken) {
    throw new Error('Connect Mastodon first to follow @threads.net accounts.');
  }

  if (clientJobState.status === 'running' && clientJobPromise) {
    return { ...clientJobState };
  }

  clientJobCancelled = false;
  clientJobState = {
    status: 'running',
    total: queueHandles.length,
    processed: 0,
    followed: 0,
    notFederated: 0,
    errors: 0,
    currentHandle: '',
    startedAt: Date.now(),
    finishedAt: 0,
    errorMessage: '',
  };

  clientJobPromise = (async () => {
    const instanceUrl = mastoAuth.meta.instanceUrl;
    const accessToken = mastoAuth.secrets.accessToken;
    for (let i = 0; i < queueHandles.length; i += 1) {
      if (clientJobCancelled) {
        clientJobState = { ...clientJobState, status: 'cancelled', finishedAt: Date.now() };
        return;
      }
      const username = queueHandles[i];
      clientJobState = { ...clientJobState, currentHandle: `${username}@threads.net` };
      try {
        const acc = await resolveStrictFederatedThreadsAccount({ instanceUrl, accessToken, username });
        if (!acc) {
          clientJobState.notFederated += 1;
        } else {
          await followAccount({ instanceUrl, accessToken, accountId: acc.id, unfollow: false });
          clientJobState.followed += 1;
        }
      } catch (err) {
        if ((err?.status === 429 || String(err?.message || '').includes('429')) && !clientJobCancelled) {
          await new Promise((r) => setTimeout(r, Math.max(delayMs, 30_000)));
        }
        clientJobState.errors += 1;
      }
      clientJobState.processed += 1;
      if (delayMs > 0 && i + 1 < queueHandles.length && !clientJobCancelled) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    clientJobState = {
      ...clientJobState,
      currentHandle: '',
      status: clientJobCancelled ? 'cancelled' : 'completed',
      finishedAt: Date.now(),
    };
  })();

  if (delayMs === 0) {
    await clientJobPromise;
  }
  return { ...clientJobState };
}

export async function cancelThreadsArchiveSync() {
  const origin = getBackendOriginIfAvailable();
  if (origin && typeof globalThis.fetch === 'function') {
    const res = await globalThis.fetch(`${origin}/api/social/threads/import-cancel`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data?.job) return data.job;
  }
  clientJobCancelled = true;
  if (clientJobState.status === 'running') {
    clientJobState = { ...clientJobState, status: 'cancelled', finishedAt: Date.now() };
  }
  return { ...clientJobState };
}
