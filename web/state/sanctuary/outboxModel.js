import { FetchError } from '../../queries/fetch/FetchError.js';
import { selectProgram, sendChat } from '../../queries/sanctuary.js';
import {
  cacheProgramHistory,
  getCachedProgramHistory,
  storeDelete,
  storeGetAll,
  storePut,
} from '../../storage/kvStorage.js';
import { createStore } from '../store.js';
import { connectionStore, onSanctuaryEvent } from './connection.js';
import { createUserMessageId } from './types.js';

function createInitialOutboxState() {
  return {
    items: [],
    flushing: false,
    lastError: null,
  };
}

export const outboxStore = createStore(createInitialOutboxState());

let lastSeq = 0;
let activeFlushPromise = null;

function nextSequenceNumber() {
  const nowMicros = Date.now() * 1000;
  lastSeq = Math.max(nowMicros, lastSeq + 1);
  return lastSeq;
}

function sortOutboxRecords(records) {
  return [...records].sort((a, b) => (a.seq - b.seq) || (a.createdAt - b.createdAt));
}

async function readSortedQueue() {
  const entries = await storeGetAll('outbox_queue');
  return sortOutboxRecords(entries.map((e) => e.value).filter(Boolean));
}

async function setQueuedMessageFlag(programId, sessionId, msgId, queued) {
  const cached = await getCachedProgramHistory(programId, sessionId);
  if (!cached || !Array.isArray(cached.history)) return;
  let changed = false;
  const nextHistory = cached.history.map((m) => {
    if (m.id !== msgId) return m;
    changed = true;
    const copy = { ...m };
    if (queued) {
      copy.queued = true;
    } else {
      delete copy.queued;
    }
    return copy;
  });
  if (changed) {
    await cacheProgramHistory(programId, sessionId, { ...cached, history: nextHistory });
  }
}

async function appendQueuedMessageToCache(record) {
  const cached = (await getCachedProgramHistory(record.programId, record.sessionId)) || {
    history: [],
  };
  const history = Array.isArray(cached.history) ? [...cached.history] : [];
  if (!history.some((m) => m.id === record.msgId)) {
    const mediaUrl = record.mediaPath || record.imageData || null;
    history.push({
      id: record.msgId,
      role: 'user',
      text: record.message,
      image_url: mediaUrl,
      media: mediaUrl ? [{ url: mediaUrl, type: 'image' }] : [],
      timestamp: record.createdAt / 1000,
      queued: true,
      ...(record.sharedPost ? { shared_post: record.sharedPost, user_note: record.userNote ?? '' } : {}),
    });
    await cacheProgramHistory(record.programId, record.sessionId, { ...cached, history });
  }
}

/**
 * Load persisted outbox queue entries into outboxStore.
 */
export async function hydrateOutbox() {
  const items = await readSortedQueue();
  outboxStore.set({ items });
  return items;
}

/**
 * Return queued outbox entries belonging to a specific Program session.
 * @param {string} programId
 * @param {string} [sessionId]
 */
export async function getOutboxForSession(programId, sessionId = 'default') {
  const all = await readSortedQueue();
  return all.filter((item) => item.programId === programId && item.sessionId === (sessionId || 'default'));
}

/**
 * Queue an outgoing Program message locally with a deterministic usr_* ID
 * and append it immediately to the cached session log.
 */
export async function enqueueTurn({
  programId,
  sessionId = 'default',
  message = '',
  imageData = null,
  imageMime = null,
  mediaPath = null,
  model = null,
  speakerId = null,
  msgId = null,
  sharedPost = null,
  userNote = '',
} = {}) {
  const targetProgram = programId || connectionStore.get().activeProgram || 'sebile';
  const resolvedMsgId = msgId || createUserMessageId();
  const record = {
    msgId: resolvedMsgId,
    programId: targetProgram,
    sessionId: sessionId || 'default',
    message: String(message ?? ''),
    imageData,
    imageMime,
    mediaPath,
    model,
    speakerId,
    seq: nextSequenceNumber(),
    createdAt: Date.now(),
    ...(sharedPost ? { sharedPost, userNote: String(userNote ?? '') } : {}),
  };

  await storePut('outbox_queue', resolvedMsgId, record);
  await appendQueuedMessageToCache(record);

  const items = await readSortedQueue();
  outboxStore.set({ items });
  return record;
}

function isRetryableOfflineError(err) {
  if (err instanceof FetchError) {
    return err.status === 0 || err.isTimeout || err.isAborted || err.status === 502 || err.status === 503 || err.status === 504;
  }
  return err?.name === 'TypeError' || err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

/**
 * Mutex-serialized FIFO replay of queued user turns via POST /chat,
 * preserving client-generated usr_* msg_id values for backend deduplication.
 * @param {{ transport?: { selectProgram: Function, sendChat: Function } }} [options]
 */
export async function flushOutbox(options = {}) {
  if (activeFlushPromise) {
    return activeFlushPromise;
  }

  const transport = options.transport || { selectProgram, sendChat };

  activeFlushPromise = (async () => {
    const queue = await readSortedQueue();
    if (queue.length === 0) {
      outboxStore.set({ items: [], flushing: false });
      return { flushedCount: 0, remainingCount: 0, haltedOffline: false };
    }

    outboxStore.set({ items: queue, flushing: true, lastError: null });
    let flushedCount = 0;
    let selectedProgramId = connectionStore.get().activeProgram || null;

    for (const item of queue) {
      try {
        if (item.programId && item.programId !== selectedProgramId) {
          await transport.selectProgram(item.programId);
          selectedProgramId = item.programId;
        }
        await transport.sendChat({
          session_id: item.sessionId,
          message: item.message,
          msg_id: item.msgId,
          image_data: item.imageData,
          image_mime: item.imageMime,
          media_path: item.mediaPath,
          model: item.model,
          speaker_id: item.speakerId,
          ...(item.sharedPost ? { shared_post: item.sharedPost, user_note: item.userNote ?? '' } : {}),
        });
        await storeDelete('outbox_queue', item.msgId);
        await setQueuedMessageFlag(item.programId, item.sessionId, item.msgId, false);
        flushedCount += 1;
      } catch (err) {
        const remaining = await readSortedQueue();
        const haltedOffline = isRetryableOfflineError(err);
        outboxStore.set({
          items: remaining,
          flushing: false,
          lastError: err?.message || 'Outbox replay failed',
        });
        return {
          flushedCount,
          remainingCount: remaining.length,
          haltedOffline,
          error: err,
        };
      }
    }

    const remaining = await readSortedQueue();
    outboxStore.set({ items: remaining, flushing: false, lastError: null });
    return {
      flushedCount,
      remainingCount: remaining.length,
      haltedOffline: false,
    };
  })();

  try {
    return await activeFlushPromise;
  } finally {
    activeFlushPromise = null;
  }
}

/**
 * Automatically replay queued offline turns whenever sanctuary:online fires.
 */
export function attachOutboxAutoFlush(options = {}) {
  return onSanctuaryEvent('sanctuary:online', () => {
    void flushOutbox(options);
  });
}

export function resetOutboxForTests() {
  activeFlushPromise = null;
  lastSeq = 0;
  outboxStore.set(createInitialOutboxState());
}
