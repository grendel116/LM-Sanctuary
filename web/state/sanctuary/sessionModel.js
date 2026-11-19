import { fetchHistory, selectProgram } from '../../queries/sanctuary.js';
import {
  cacheProgramHistory,
  getCachedProgramHistory,
} from '../../storage/kvStorage.js';
import { createStore } from '../store.js';
import { connectionStore } from './connection.js';
import { getOutboxForSession } from './outboxModel.js';

function createInitialSessionState() {
  return {
    activeProgramId: '',
    activeSessionId: 'default',
    characterName: '',
    messages: [],
    moodState: null,
    inversionActive: '',
    inversionState: null,
    theme: null,
    welcomeMessage: '',
    groupMeta: null,
    generating: false,
    pendingToolCall: null,
    fromCache: false,
    loading: false,
    error: null,
  };
}

export const sessionStore = createStore(createInitialSessionState());

function mergeQueuedOutbox(messages, queuedRecords) {
  const base = Array.isArray(messages) ? [...messages] : [];
  if (!Array.isArray(queuedRecords) || queuedRecords.length === 0) {
    return base;
  }
  const existingIds = new Set(base.map((m) => m?.id).filter(Boolean));
  for (const rec of queuedRecords) {
    if (existingIds.has(rec.msgId)) continue;
    const mediaUrl = rec.mediaPath || rec.imageData || null;
    base.push({
      id: rec.msgId,
      role: 'user',
      text: rec.message,
      image_url: mediaUrl,
      media: mediaUrl ? [{ url: mediaUrl, type: 'image' }] : [],
      timestamp: rec.createdAt / 1000,
      queued: true,
      ...(rec.sharedPost ? { shared_post: rec.sharedPost, user_note: rec.userNote ?? '' } : {}),
    });
  }
  return base;
}

/**
 * Load a Program DM session from the Sanctuary node when online, falling back
 * cleanly to locally cached history + queued offline turns when unreachable.
 */
export async function loadProgramSession(programId, sessionId = 'default', options = {}) {
  const transport = options.transport || { selectProgram, fetchHistory };
  const targetSession = sessionId || 'default';
  const targetProgram = programId || connectionStore.get().activeProgram || 'sebile';

  sessionStore.set({
    activeProgramId: targetProgram,
    activeSessionId: targetSession,
    loading: true,
    error: null,
  });

  const conn = connectionStore.get();
  const queued = await getOutboxForSession(targetProgram, targetSession);

  if (conn.mode === 'online') {
    try {
      if (targetProgram && targetProgram !== conn.activeProgram) {
        await transport.selectProgram(targetProgram);
        connectionStore.set({ activeProgram: targetProgram });
      }
      const data = await transport.fetchHistory(targetSession);
      await cacheProgramHistory(targetProgram, targetSession, data);

      const mergedMessages = mergeQueuedOutbox(data?.history, queued);
      sessionStore.set({
        activeProgramId: data?.active_program || targetProgram,
        activeSessionId: targetSession,
        characterName: data?.character_name || targetProgram,
        messages: mergedMessages,
        moodState: data?.state || null,
        inversionActive: data?.inversion_active || '',
        inversionState: data?.inversion_state || null,
        theme: data?.theme || null,
        welcomeMessage: data?.welcome_message || '',
        groupMeta: data?.group_meta || null,
        generating: Boolean(data?.generating),
        fromCache: false,
        loading: false,
        error: null,
      });
      return sessionStore.get();
    } catch (err) {
      const cached = await getCachedProgramHistory(targetProgram, targetSession);
      const mergedMessages = mergeQueuedOutbox(cached?.history, queued);
      sessionStore.set({
        activeProgramId: cached?.active_program || targetProgram,
        activeSessionId: targetSession,
        characterName: cached?.character_name || targetProgram,
        messages: mergedMessages,
        moodState: cached?.state || null,
        inversionActive: cached?.inversion_active || '',
        inversionState: cached?.inversion_state || null,
        theme: cached?.theme || null,
        welcomeMessage: cached?.welcome_message || '',
        groupMeta: cached?.group_meta || null,
        generating: false,
        fromCache: true,
        loading: false,
        error: err?.message || 'Unable to refresh session history',
      });
      return sessionStore.get();
    }
  }

  const cached = await getCachedProgramHistory(targetProgram, targetSession);
  const mergedMessages = mergeQueuedOutbox(cached?.history, queued);
  sessionStore.set({
    activeProgramId: cached?.active_program || targetProgram,
    activeSessionId: targetSession,
    characterName: cached?.character_name || targetProgram,
    messages: mergedMessages,
    moodState: cached?.state || null,
    inversionActive: cached?.inversion_active || '',
    inversionState: cached?.inversion_state || null,
    theme: cached?.theme || null,
    welcomeMessage: cached?.welcome_message || '',
    groupMeta: cached?.group_meta || null,
    generating: false,
    fromCache: true,
    loading: false,
    error: null,
  });
  return sessionStore.get();
}

export function resetSessionStoreForTests() {
  sessionStore.set(createInitialSessionState());
}
