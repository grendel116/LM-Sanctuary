import { getAuthenticatedAccount, upsertSocialAccount } from '../state/authStore.js';
import { kvGet, kvSet, saveLocalFilterRule } from '../storage/nativeStore.js';
import { followAccount, lookupAccountByAcct, searchFediverse, verifyCredentials } from './fediverse.js';
import { fetchKeywordFilters } from './socialClient.js';

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
  requested: 0,
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
    requested: 0,
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

function extractHiddenWordsFromJson(payload) {
  const words = [];
  const seen = new Set();
  const pushWord = (raw) => {
    const clean = decodeMetaMojibake(String(raw ?? '')).trim();
    const low = clean.toLowerCase();
    if (!clean || seen.has(low)) return;
    seen.add(low);
    words.push(clean);
  };

  const scanNode = (node) => {
    if (!node) return;
    if (typeof node === 'string') {
      pushWord(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) scanNode(item);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.value === 'string') pushWord(node.value);
      if (Array.isArray(node.string_list_data)) scanNode(node.string_list_data);
      for (const key of ['custom_words', 'hidden_words', 'relationships_hidden_words', 'words', 'custom_words_and_phrases']) {
        if (node[key] !== undefined) scanNode(node[key]);
      }
      if (typeof node.title === 'string' && !node.string_list_data && !node.href) {
        pushWord(node.title);
      }
    }
  };

  scanNode(payload);
  return words;
}

/**
 * Extract following, mutuals (intersected with followers.json), and hidden words from a Threads ZIP buffer.
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
  const hiddenWords = [];
  const seenHidden = new Set();

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

    const lowName = rawName.toLowerCase();
    let slot = '';
    if (lowName.endsWith('threads/followers.json') || lowName === 'followers.json') slot = 'followers';
    else if (lowName.endsWith('threads/following.json') || lowName === 'following.json') slot = 'following';
    else if (/(?:^|\/)(?:hidden_words[^/]*|custom_words_and_phrases)\.json$/.test(lowName)) slot = 'hiddenWords';
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
    else if (slot === 'hiddenWords') {
      for (const word of extractHiddenWordsFromJson(jsonData)) {
        const low = word.toLowerCase();
        if (seenHidden.has(low)) continue;
        seenHidden.add(low);
        hiddenWords.push(word);
      }
    }
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
      ...(hiddenWords.length > 0 ? { hiddenWords: hiddenWords.length } : {}),
    },
    mutuals,
    following,
    hiddenWords,
  };
}

export async function syncArchiveHiddenWords(hiddenWords = []) {
  const words = (Array.isArray(hiddenWords) ? hiddenWords : [])
    .map((w) => String(w || '').trim())
    .filter(Boolean);
  if (words.length === 0) return [];
  for (const phrase of words) {
    await saveLocalFilterRule({
      id: `local_threads_${phrase.toLowerCase()}`,
      title: phrase,
      phrase,
      keywords: [phrase],
      filter_action: 'hide',
    }).catch(() => {});
  }
  return fetchKeywordFilters().catch(() => []);
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

async function resolveStrictFederatedThreadsAccount({ instanceUrl, accessToken, username }) {
  const handle = normalizeHandle(username);
  if (!handle) return null;
  const targetAcct = `${handle}@threads.net`;
  let acc = null;
  try {
    acc = await lookupAccountByAcct({ instanceUrl, accessToken, acct: targetAcct, timeoutMs: 20_000 });
  } catch (err) {
    if (err?.status === 401 || err?.status === 403 || err?.status === 429 || String(err?.message || '').includes('429')) {
      throw err;
    }
    try {
      const res = await searchFediverse({
        instanceUrl,
        accessToken,
        query: `@${targetAcct}`,
        type: 'accounts',
        resolve: true,
        limit: 5,
        timeoutMs: 20_000,
      });
      acc = (res?.accounts || []).find((a) => {
        const acct = String(a?.acct || '').trim().replace(/^@/, '').toLowerCase();
        return acct === targetAcct || acct === `${handle}@threads.com`;
      }) || null;
    } catch (searchErr) {
      if (searchErr?.status === 404 || searchErr?.status === 410 || searchErr?.status === 422) {
        return null;
      }
      throw searchErr;
    }
  }
  if (!acc?.id) return null;
  const cleanAcct = String(acc.acct || '').trim().replace(/^@/, '').toLowerCase();
  if (cleanAcct !== targetAcct && cleanAcct !== `${handle}@threads.com`) return null;
  return acc;
}

export async function getThreadsImportState() {
  const archive = await kvGet('threads_import_archive_v1', null);
  const summary = archive?.counts
    ? {
        sourceName: archive.sourceName || '',
        importedAt: archive.importedAt || 0,
        counts: {
          mutuals: Number(archive.counts.mutuals || 0),
          following: Number(archive.counts.following || 0),
          ...(Number(archive.counts.hiddenWords || 0) > 0 ? { hiddenWords: Number(archive.counts.hiddenWords) } : {}),
        },
      }
    : null;
  return { archive: summary, job: { ...clientJobState } };
}

export async function parseThreadsArchiveFile(file) {
  if (!file) throw new Error('Select a Threads export .zip file first.');
  const ab = await file.arrayBuffer();
  const parsed = await parseThreadsArchiveBuffer(ab, file.name || 'threads-export.zip');
  await kvSet('threads_import_archive_v1', parsed);
  if (Array.isArray(parsed.hiddenWords) && parsed.hiddenWords.length > 0) {
    await syncArchiveHiddenWords(parsed.hiddenWords);
  }
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

async function refreshConnectedMastodonAccountCounts(mastoAuth) {
  if (!mastoAuth?.meta?.id || !mastoAuth?.meta?.instanceUrl || !mastoAuth?.secrets?.accessToken) {
    return;
  }
  try {
    const fresh = await verifyCredentials({
      instanceUrl: mastoAuth.meta.instanceUrl,
      accessToken: mastoAuth.secrets.accessToken,
    });
    if (fresh?.id && (fresh?.username || fresh?.acct)) {
      await upsertSocialAccount(
        {
          ...mastoAuth.meta,
          ...fresh,
          id: mastoAuth.meta.id,
          platform: 'fediverse',
          instanceUrl: mastoAuth.meta.instanceUrl,
          handle: fresh.username || mastoAuth.meta.handle,
          userId: fresh.id || mastoAuth.meta.userId,
        },
        null,
        { syncToServer: false }
      );
    }
  } catch {
    // Keep cached Mastodon counts if credential refresh fails
  }
}

export async function startThreadsArchiveSync({
  followScope = 'mutuals',
  delayMs = 1100,
} = {}) {
  const scope = followScope === 'following' ? 'following' : 'mutuals';
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
    requested: 0,
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
        if (clientJobState.followed > 0) {
          await refreshConnectedMastodonAccountCounts(mastoAuth);
        }
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
          const rel = await followAccount({ instanceUrl, accessToken, accountId: acc.id, unfollow: false });
          const isFollowing = Boolean(rel?.following);
          const isRequested = Boolean(rel?.requested && !isFollowing);
          if (isFollowing || isRequested) {
            clientJobState.followed += 1;
            if (isRequested) {
              clientJobState.requested = (clientJobState.requested || 0) + 1;
            }
          }
        }
      } catch (err) {
        if ((err?.status === 429 || String(err?.message || '').includes('429')) && !clientJobCancelled) {
          await new Promise((r) => setTimeout(r, Math.max(delayMs, 30_000)));
        }
        clientJobState.errors += 1;
        clientJobState.errorMessage = err?.message || 'Follow request failed';
      }
      clientJobState.processed += 1;
      if (delayMs > 0 && i + 1 < queueHandles.length && !clientJobCancelled) {
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    if (clientJobState.followed > 0) {
      await refreshConnectedMastodonAccountCounts(mastoAuth);
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
  clientJobCancelled = true;
  if (clientJobState.status === 'running') {
    clientJobState = { ...clientJobState, status: 'cancelled', finishedAt: Date.now() };
  }
  return { ...clientJobState };
}
