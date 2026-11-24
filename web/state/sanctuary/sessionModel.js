import { fetchHistory, selectProgram } from '../../queries/sanctuary.js';
import {
  cacheProgramHistory,
  clearAllCachedProgramHistory,
  getCachedProgramHistory,
} from '../../storage/kvStorage.js';
import { isKeePassVaultMode } from '../authStore.js';
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
    vaultLocked: false,
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
  const conn = connectionStore.get();
  const roster = Array.isArray(conn.programs) ? conn.programs : [];
  let targetProgram = programId || conn.activeProgram || roster[0]?.id || '';
  if (roster.length > 0 && targetProgram && conn.mode === 'online' && !roster.some((p) => p.id === targetProgram)) {
    targetProgram = conn.activeProgram || roster[0]?.id || targetProgram;
  }
  if (!targetProgram) {
    if (conn.mode === 'dormant') {
      sessionStore.set({
        activeProgramId: '',
        activeSessionId: targetSession,
        messages: [],
        loading: true,
        error: null,
      });
      return sessionStore.get();
    }
    targetProgram = 'sebile';
  }

  sessionStore.set({
    activeProgramId: targetProgram,
    activeSessionId: targetSession,
    loading: true,
    error: null,
  });

  const queued = await getOutboxForSession(targetProgram, targetSession);

  if (conn.mode === 'online') {
    try {
      if (targetProgram && targetProgram !== conn.activeProgram) {
        await transport.selectProgram(targetProgram);
        connectionStore.set({ activeProgram: targetProgram });
      }
      const data = await transport.fetchHistory(targetSession);
      if (!isKeePassVaultMode()) {
        await cacheProgramHistory(targetProgram, targetSession, data);
      }

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
        vaultLocked: false,
        fromCache: false,
        loading: false,
        error: null,
      });
      return sessionStore.get();
    } catch (err) {
      const errMsg = String(err?.message || '');
      const isVaultLocked =
        err?.status === 503 &&
        (err?.body?.locked === true ||
          errMsg.toLowerCase().includes('locked') ||
          errMsg.toLowerCase().includes('keepassxc'));
      if (isVaultLocked) {
        await clearAllCachedProgramHistory();
        sessionStore.set({
          activeProgramId: targetProgram,
          activeSessionId: targetSession,
          characterName: targetProgram,
          messages: [],
          moodState: null,
          inversionActive: '',
          inversionState: null,
          theme: null,
          welcomeMessage: '',
          groupMeta: null,
          generating: false,
          vaultLocked: true,
          fromCache: false,
          loading: false,
          error: err?.message || 'Vault is locked',
        });
        return sessionStore.get();
      }
      const cached = await getCachedProgramHistory(targetProgram, targetSession);
      const cachedHist = Array.isArray(cached?.history) ? cached.history : [];
      const mergedMessages = mergeQueuedOutbox(cachedHist, queued);
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
        vaultLocked: isVaultLocked,
        fromCache: true,
        loading: false,
        error: err?.message || 'Unable to refresh session history',
      });
      return sessionStore.get();
    }
  }

  const cached = isKeePassVaultMode() ? null : await getCachedProgramHistory(targetProgram, targetSession);
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
    vaultLocked: false,
    fromCache: true,
    loading: false,
    error: null,
  });
  return sessionStore.get();
}

export function resetSessionStoreForTests() {
  sessionStore.set(createInitialSessionState());
}
