import { isSecureSanctuaryNodeUrl, resolveNodeUrl } from '../constants/endpoints.js';
import {
  connectionStore,
  getProgramAvatarVersion,
  getSanctuaryAuthHeaders,
  getSanctuaryNodeUrl,
} from '../state/sanctuary/connection.js';
import { fetchWrapper } from './fetch/fetchWrapper.js';

function nodeUrlFor(path, opts = {}) {
  const base = opts.nodeUrl ?? getSanctuaryNodeUrl();
  const url = resolveNodeUrl(path, base);
  if (!isSecureSanctuaryNodeUrl(url)) {
    throw new Error('HTTPS is required for Sanctuary connections over the network. HTTP is allowed only on localhost.');
  }
  return url;
}

function requestNode(path, opts = {}) {
  const { nodeUrl, headers = {}, ...rest } = opts;
  return fetchWrapper(nodeUrlFor(path, { nodeUrl }), {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...getSanctuaryAuthHeaders(),
      ...headers,
    },
  });
}

/**
 * Resolve any Sanctuary media path (/images/..., /programs/..., /speech_cache/...)
 * against the active or provided node URL.
 * @param {string} mediaPath
 * @param {{ nodeUrl?: string }} [opts]
 * @returns {string}
 */
export function resolveSanctuaryMediaUrl(mediaPath, opts = {}) {
  if (!mediaPath) return '';
  if (typeof mediaPath === 'string' && (mediaPath.startsWith('data:') || mediaPath.startsWith('blob:'))) {
    return mediaPath;
  }
  const base = opts.nodeUrl ?? getSanctuaryNodeUrl();
  if (!base) return mediaPath;
  const url = resolveNodeUrl(mediaPath, base);
  if (!isSecureSanctuaryNodeUrl(url)) {
    throw new Error('HTTPS is required for Sanctuary connections over the network. HTTP is allowed only on localhost.');
  }
  return url;
}

export function resolveProgramAvatarUrl(programId, opts = {}) {
  const id = String(programId || '').trim();
  if (!id) return '';
  const ver = opts.cacheBuster ?? getProgramAvatarVersion(id);
  const suffix = ver ? `?t=${encodeURIComponent(ver)}` : '';
  return resolveSanctuaryMediaUrl(`/programs/${id}/profile.png${suffix}`, opts);
}

// Health, config, and status SSE

export function fetchMobileHealth(opts = {}) {
  return requestNode('/api/mobile/health', { timeoutMs: 2000, background: true, ...opts });
}

export function fetchRuntimeConfig(opts = {}) {
  return requestNode('/api/config', { timeoutMs: 3000, background: true, ...opts });
}

export function createStatusEventSource(opts = {}) {
  if (typeof globalThis.EventSource !== 'function') {
    throw new Error('EventSource is unavailable in this environment');
  }
  return new globalThis.EventSource(nodeUrlFor('/api/events/status', opts));
}

// Chat & tool approval lifecycle

export function fetchHistory(sessionId = 'default', opts = {}) {
  const qs = new URLSearchParams({ session_id: sessionId }).toString();
  return requestNode(`/history?${qs}`, opts);
}

export function fetchGenerationStatus(sessionId = 'default', opts = {}) {
  const qs = new URLSearchParams({ session_id: sessionId }).toString();
  return requestNode(`/api/generation_status?${qs}`, { background: true, ...opts });
}

export function sendChat(payload, opts = {}) {
  return requestNode('/chat', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    timeoutMs: 0,
    ...opts,
  });
}

export function editTurn(payload, opts = {}) {
  return requestNode('/edit', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    timeoutMs: 0,
    ...opts,
  });
}

export function generateUserImpersonation(payload = {}, opts = {}) {
  return requestNode('/api/generate_user_message', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    timeoutMs: 0,
    ...opts,
  });
}

export function updateMessageText(payload, opts = {}) {
  return requestNode('/update_message', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    ...opts,
  });
}

export function deleteMessage(payload, opts = {}) {
  return requestNode('/delete', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    ...opts,
  });
}

export function continueGeneration(payload = {}, opts = {}) {
  return requestNode('/continue', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    timeoutMs: 0,
    ...opts,
  });
}

export function resetSession(sessionId = 'default', opts = {}) {
  return requestNode('/reset', {
    method: 'POST',
    json: { session_id: sessionId },
    ...opts,
  });
}

export function triggerProactiveThought(payload = {}, opts = {}) {
  return requestNode('/api/proactive_action', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    timeoutMs: 35000,
    ...opts,
  });
}

export function fetchSessionToolCalls(sessionId = 'default', opts = {}) {
  const qs = new URLSearchParams({ session_id: sessionId }).toString();
  return requestNode(`/api/session_tool_calls?${qs}`, { background: true, ...opts });
}

export function cancelChat(sessionId = 'default', opts = {}) {
  return requestNode('/api/cancel_chat', {
    method: 'POST',
    json: { session_id: sessionId },
    ...opts,
  });
}

export function approveToolCall(callId, status, opts = {}) {
  const { optionIndex, answerText, ...reqOpts } = opts || {};
  const payload = { call_id: callId, status };
  if (optionIndex !== undefined && optionIndex !== null) {
    payload.option_index = optionIndex;
  }
  if (answerText !== undefined) {
    payload.answer_text = String(answerText);
  }
  return requestNode('/approve_tool', {
    method: 'POST',
    json: payload,
    ...reqOpts,
  });
}

// Media, portrait NDJSON streaming, video animation, and avatar crop

export function uploadSanctuaryMedia(file, opts = {}) {
  const form = new FormData();
  form.append('file', file);
  return requestNode('/upload_media', {
    method: 'POST',
    body: form,
    timeoutMs: 60000,
    ...opts,
  });
}

export function deleteSanctuaryImage(payload, opts = {}) {
  return requestNode('/delete_image', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    ...opts,
  });
}

export function regenerateImage(payload, opts = {}) {
  return requestNode('/regenerate_image', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    timeoutMs: 0,
    ...opts,
  });
}

/**
 * Invoke /api/portrait/generate with NDJSON streaming and chunk-safe UTF-8 decoding.
 * @param {object} payload
 * @param {{ onEvent?: (evt: object) => void, signal?: AbortSignal, nodeUrl?: string, fetchImpl?: typeof fetch }} [opts]
 */
export async function generatePortraitStream(payload = {}, opts = {}) {
  const { onEvent, ...reqOpts } = opts;
  const res = await requestNode('/api/portrait/generate', {
    method: 'POST',
    json: { session_id: 'default', stream: true, ...payload },
    responseType: 'raw',
    timeoutMs: 0,
    ...reqOpts,
  });

  const contentType = res.headers?.get?.('content-type') || '';
  if (contentType.includes('application/json') && !contentType.includes('ndjson')) {
    const single = await res.json();
    if (typeof onEvent === 'function') onEvent(single);
    return single;
  }

  if (!res.body || typeof res.body.getReader !== 'function') {
    const text = await res.text();
    const events = [];
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = JSON.parse(trimmed);
      events.push(parsed);
      if (typeof onEvent === 'function') onEvent(parsed);
    }
    return events[events.length - 1] || null;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let lastEvent = null;

  const emitBufferedLines = () => {
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const evt = JSON.parse(trimmed);
      lastEvent = evt;
      if (typeof onEvent === 'function') onEvent(evt);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    emitBufferedLines();
  }

  if (buffer.trim()) {
    const evt = JSON.parse(buffer.trim());
    lastEvent = evt;
    if (typeof onEvent === 'function') onEvent(evt);
  }
  return lastEvent;
}

export function animateImage(payload, opts = {}) {
  return requestNode('/api/animate_image', {
    method: 'POST',
    json: { session_id: 'default', ...payload },
    ...opts,
  });
}

export function fetchGenerations(opts = {}) {
  return requestNode('/api/generations', { background: true, ...opts });
}

export function listProgramImages(programId = '', opts = {}) {
  const qs = programId ? `?${new URLSearchParams({ program_id: programId }).toString()}` : '';
  return requestNode(`/list_images${qs}`, opts);
}

export function fetchImagePrompt(imageUrl, programId = '', opts = {}) {
  const params = new URLSearchParams({ image_url: imageUrl });
  if (programId) params.set('program_id', programId);
  return requestNode(`/api/get_image_prompt?${params.toString()}`, opts);
}

export function cropProfilePicture(payload, opts = {}) {
  return requestNode('/api/programs/profile_picture/crop', {
    method: 'POST',
    json: payload,
    ...opts,
  });
}

// Programs, Sessions, Groups, Themes, Card Import/Export, and User Profiles

export function fetchSessions(programId = '', opts = {}) {
  const qs = programId ? `?${new URLSearchParams({ program_id: programId }).toString()}` : '';
  return requestNode(`/api/sessions${qs}`, opts);
}

export function createSession({ programId = '', title = '' } = {}, opts = {}) {
  return requestNode('/api/sessions/create', {
    method: 'POST',
    json: { program_id: programId, title },
    ...opts,
  });
}

export function renameSession({ sessionId, title, programId = '' }, opts = {}) {
  return requestNode('/api/sessions/rename', {
    method: 'POST',
    json: { session_id: sessionId, title, program_id: programId },
    ...opts,
  });
}

export function deleteSession({ sessionId, programId = '' }, opts = {}) {
  return requestNode('/api/sessions/delete', {
    method: 'POST',
    json: { session_id: sessionId, program_id: programId },
    ...opts,
  });
}

export function fetchPrograms(opts = {}) {
  return requestNode('/api/programs', opts);
}

export function selectProgram(programId, opts = {}) {
  return requestNode('/api/programs/select', {
    method: 'POST',
    json: { program_id: programId },
    ...opts,
  });
}

export function startGroupSession(hostId, guestIds = [], opts = {}) {
  return requestNode('/api/programs/group_session/start', {
    method: 'POST',
    json: { host_id: hostId, guest_ids: guestIds },
    ...opts,
  });
}

export function updateGroupMembers(payload, opts = {}) {
  return requestNode('/api/programs/group_session/members', {
    method: 'POST',
    json: payload,
    ...opts,
  });
}

export function fetchProgramTheme(programId = '', opts = {}) {
  const qs = programId ? `?${new URLSearchParams({ program_id: programId }).toString()}` : '';
  return requestNode(`/api/programs/theme${qs}`, opts);
}

export function updateProgramPalette(programId, color, opts = {}) {
  return requestNode('/api/programs/palette', {
    method: 'POST',
    json: { program_id: programId, color },
    ...opts,
  });
}

export function fetchProgramProfile(programId = '', opts = {}) {
  const qs = programId ? `?${new URLSearchParams({ program_id: programId }).toString()}` : '';
  return requestNode(`/api/programs/profile${qs}`, opts);
}

export function saveProgramProfile(payload, opts = {}) {
  return requestNode('/api/programs/profile/save', {
    method: 'POST',
    json: payload,
    ...opts,
  });
}

export function deleteProgram(programId, opts = {}) {
  return requestNode('/api/programs/delete', {
    method: 'POST',
    json: { program_id: programId },
    ...opts,
  });
}

export function renameProgram(programId, newName, opts = {}) {
  return requestNode('/api/programs/rename', {
    method: 'POST',
    json: { program_id: programId, new_name: newName },
    ...opts,
  });
}

export function importTavernCard(file, opts = {}) {
  const form = new FormData();
  form.append('card', file);
  return requestNode('/api/programs/import/tavern', {
    method: 'POST',
    body: form,
    timeoutMs: 60000,
    ...opts,
  });
}

export function createProgramFromDescription(payload, opts = {}) {
  return requestNode('/api/programs/import/describe', {
    method: 'POST',
    json: payload,
    timeoutMs: 0,
    ...opts,
  });
}

export function getExportCardUrl(programId, opts = {}) {
  return nodeUrlFor(`/api/programs/${encodeURIComponent(programId)}/export/card`, opts);
}

export function getExportLorebookUrl(programId, opts = {}) {
  return nodeUrlFor(`/api/programs/${encodeURIComponent(programId)}/export/lorebook`, opts);
}

export function fetchUserProfiles(opts = {}) {
  return requestNode('/api/user_profiles', opts);
}

export function selectUserProfile(profileId, opts = {}) {
  return requestNode('/api/user_profiles/select', {
    method: 'POST',
    json: { profile_id: profileId },
    ...opts,
  });
}

export function saveUserProfile(profileId, content, opts = {}) {
  return requestNode('/api/user_profiles/save', {
    method: 'POST',
    json: { profile_id: profileId, content },
    ...opts,
  });
}

export function deleteUserProfile(profileId, opts = {}) {
  return requestNode('/api/user_profiles/delete', {
    method: 'POST',
    json: { profile_id: profileId },
    ...opts,
  });
}

export function renameUserProfile(oldProfileId, newName, opts = {}) {
  return requestNode('/api/user_profiles/rename', {
    method: 'POST',
    json: { old_profile_id: oldProfileId, new_profile_name: newName },
    ...opts,
  });
}

// Knowledge: RAG Data Bank, World Info Lorebooks, Journals, and Quests

export function fetchDatabankFiles(opts = {}) {
  return requestNode('/api/databank/files', opts);
}

export function uploadDatabankFile(file, opts = {}) {
  const form = new FormData();
  form.append('file', file);
  return requestNode('/api/databank/upload', {
    method: 'POST',
    body: form,
    timeoutMs: 120000,
    ...opts,
  });
}

export function ingestDatabankText(text, title = '', opts = {}) {
  return requestNode('/api/databank/text', {
    method: 'POST',
    json: { text, title },
    timeoutMs: 60000,
    ...opts,
  });
}

export function scrapeDatabankUrl(url, opts = {}) {
  return requestNode('/api/databank/scrape', {
    method: 'POST',
    json: { url },
    timeoutMs: 60000,
    ...opts,
  });
}

export function deleteDatabankDoc(docId, opts = {}) {
  return requestNode('/api/databank/delete', {
    method: 'POST',
    json: { id: docId },
    ...opts,
  });
}

export function purgeDatabank(opts = {}) {
  return requestNode('/api/databank/purge', {
    method: 'POST',
    json: {},
    ...opts,
  });
}

export function fetchLorebooks(opts = {}) {
  return requestNode('/api/lorebooks', opts);
}

export function importLorebookFile(file, opts = {}) {
  const form = new FormData();
  form.append('file', file);
  return requestNode('/api/lorebooks/import', {
    method: 'POST',
    body: form,
    ...opts,
  });
}

export function getExportStandaloneLorebookUrl(filename, opts = {}) {
  return nodeUrlFor(`/api/lorebooks/${encodeURIComponent(filename)}/export`, opts);
}

export function deleteLorebookFile(filename, opts = {}) {
  return requestNode(`/api/lorebooks/${encodeURIComponent(filename)}/delete`, {
    method: 'POST',
    json: {},
    ...opts,
  });
}

export function fetchCardLorebookEntries(opts = {}) {
  return requestNode('/api/lorebooks/card/entries', opts);
}

export function saveCardLorebookEntries(entries, opts = {}) {
  return requestNode('/api/lorebooks/card/save', {
    method: 'POST',
    json: { entries },
    ...opts,
  });
}

export function fetchLorebookEntries(filename, opts = {}) {
  return requestNode(`/api/lorebooks/${encodeURIComponent(filename)}/entries`, opts);
}

export function saveLorebookEntries(filename, { name, entries }, opts = {}) {
  return requestNode(`/api/lorebooks/${encodeURIComponent(filename)}/save`, {
    method: 'POST',
    json: { ...(name !== undefined ? { name } : {}), entries },
    ...opts,
  });
}

export function fetchProgramJournals(programId = '', sessionId = 'default', opts = {}) {
  const params = new URLSearchParams({ session_id: sessionId });
  if (programId) params.set('program_id', programId);
  return requestNode(`/api/programs/journals?${params.toString()}`, opts);
}

export function deleteProgramJournalEntry(entryId, programId = '', opts = {}) {
  return requestNode('/api/programs/journals/delete', {
    method: 'POST',
    json: { id: entryId, ...(programId ? { program_id: programId } : {}) },
    ...opts,
  });
}

export function saveEpicChronicle(summary, sessionId = 'default', opts = {}) {
  return requestNode('/api/programs/journals/summary/save', {
    method: 'POST',
    json: { session_id: sessionId, summary },
    ...opts,
  });
}

export function saveRecentChapter(index, content, sessionId = 'default', opts = {}) {
  return requestNode('/api/programs/journals/recent_chapters/save', {
    method: 'POST',
    json: { session_id: sessionId, index, content },
    ...opts,
  });
}

export function fetchQuests(opts = {}) {
  return requestNode('/api/quests', opts);
}

export function completeQuest(questId, sessionId = 'default', opts = {}) {
  return requestNode(`/api/quests/${encodeURIComponent(questId)}/complete`, {
    method: 'POST',
    json: { session_id: sessionId },
    ...opts,
  });
}

export function deleteQuest(questId, opts = {}) {
  return requestNode(`/api/quests/${encodeURIComponent(questId)}/delete`, {
    method: 'POST',
    json: {},
    ...opts,
  });
}

export function getQuestIcsDownloadUrl(questId, opts = {}) {
  return nodeUrlFor(`/api/quests/${encodeURIComponent(questId)}/download`, opts);
}

// Voice TTS & Call endpoints

export function synthesizeSpeech(messageId, text, opts = {}) {
  return requestNode('/api/tts', {
    method: 'POST',
    json: { message_id: messageId, text },
    timeoutMs: 60000,
    ...opts,
  });
}

export function startVoiceCall(sessionId = 'default', opts = {}) {
  return requestNode('/api/voice_call/start', {
    method: 'POST',
    json: { session_id: sessionId },
    ...opts,
  });
}

export function saveVoiceCallTranscript(transcript, sessionId = 'default', opts = {}) {
  return requestNode('/api/voice_call/save', {
    method: 'POST',
    json: { session_id: sessionId, transcript },
    ...opts,
  });
}

export function transcribeVoiceAudio(audioBlob, language = 'en', opts = {}) {
  const form = new FormData();
  form.append('audio', audioBlob, 'voice.webm');
  const qs = new URLSearchParams({ language }).toString();
  return requestNode(`/api/voice_call/transcribe?${qs}`, {
    method: 'POST',
    body: form,
    timeoutMs: 30000,
    ...opts,
  });
}

// Models & System Settings

export function fetchModels(opts = {}) {
  return requestNode('/models', opts);
}

export function fetchProjectSettings(opts = {}) {
  return requestNode('/api/project_settings', opts);
}

export function saveProjectSettings(settings, opts = {}) {
  return requestNode('/api/project_settings', {
    method: 'POST',
    json: settings,
    ...opts,
  });
}

export function fetchOpenHandsServerStatus(opts = {}) {
  return requestNode('/api/openhands/server', opts);
}

export function controlOpenHandsServer(action, opts = {}) {
  return requestNode('/api/openhands/server', {
    method: 'POST',
    json: { action },
    timeoutMs: 30000,
    ...opts,
  });
}

export function saveGenerationParams(temperature, opts = {}) {
  return requestNode('/api/save_generation_params', {
    method: 'POST',
    json: { temperature },
    ...opts,
  });
}

export function fetchNativeModels(opts = {}) {
  return requestNode('/api/models/native/list', opts);
}

export function loadNativeLlm(payload, opts = {}) {
  return requestNode('/api/models/native/load_llm', {
    method: 'POST',
    json: payload,
    timeoutMs: 0,
    ...opts,
  });
}

export function selectNativeCheckpoint(checkpointName, opts = {}) {
  return requestNode('/api/models/native/select_checkpoint', {
    method: 'POST',
    json: { checkpoint_name: checkpointName },
    ...opts,
  });
}

export function selectNativeWorkflow(workflowName, opts = {}) {
  return requestNode('/api/models/native/select_workflow', {
    method: 'POST',
    json: { workflow_name: workflowName },
    ...opts,
  });
}

export function openModelsFolder(folder = 'root', opts = {}) {
  return requestNode('/api/models/native/open_folder', {
    method: 'POST',
    json: { folder },
    ...opts,
  });
}

export function browseWorkspaceFolder(opts = {}) {
  return requestNode('/api/browse_folder', {
    method: 'POST',
    json: {},
    ...opts,
  });
}

export function requestNodeRaw(path, opts = {}) {
  return requestNode(path, { responseType: 'raw', ...opts });
}

export function syncMastodonUserProfileToSanctuary(profile, opts = {}) {
  return requestNode('/api/user_profiles/sync_mastodon', {
    method: 'POST',
    json: profile,
    background: true,
    timeoutMs: 4000,
    ...opts,
  });
}

export function fetchSanctuaryFeedProfile(opts = {}) {
  return requestNode('/api/feed_profile', {
    background: true,
    timeoutMs: 3000,
    ...opts,
  });
}

export function saveSanctuaryFeedProfile(profile, opts = {}) {
  return requestNode('/api/feed_profile', {
    method: 'PUT',
    json: profile,
    background: true,
    timeoutMs: 3000,
    ...opts,
  });
}

export function fetchSanctuarySocialAccounts(opts = {}) {
  return requestNode('/api/social/accounts', {
    timeoutMs: 10000,
    ...opts,
  });
}

export function saveSanctuarySocialAccount(accountId, record, opts = {}) {
  return requestNode(`/api/social/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PUT',
    json: record,
    timeoutMs: 10000,
    ...opts,
  });
}

export function deleteSanctuarySocialAccount(accountId, opts = {}) {
  return requestNode(`/api/social/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE',
    timeoutMs: 10000,
    ...opts,
  });
}

export async function fetchSanctuaryKeywordFilters(opts = {}) {
  const nodeUrl = opts.nodeUrl ?? getSanctuaryNodeUrl();
  if (!nodeUrl || (connectionStore.get().mode !== 'online' && !opts.nodeUrl)) return [];
  try {
    const res = await requestNode('/api/social/accounts/filters', {
      timeoutMs: 8000,
      ...opts,
    });
    return Array.isArray(res?.filters) ? res.filters : [];
  } catch {
    return [];
  }
}

export async function saveSanctuaryKeywordFilters(filters = [], opts = {}) {
  const nodeUrl = opts.nodeUrl ?? getSanctuaryNodeUrl();
  if (!nodeUrl || (connectionStore.get().mode !== 'online' && !opts.nodeUrl)) return [];
  try {
    const res = await requestNode('/api/social/accounts/filters', {
      method: 'PUT',
      json: { filters: Array.isArray(filters) ? filters : [] },
      timeoutMs: 8000,
      ...opts,
    });
    return Array.isArray(res?.filters) ? res.filters : [];
  } catch {
    return [];
  }
}

export function fetchSanctuarySocialDrafts(opts = {}) {
  return requestNode('/api/social/drafts', {
    timeoutMs: 20000,
    ...opts,
  });
}

export function saveSanctuarySocialDraft(draftId, draft, opts = {}) {
  return requestNode(`/api/social/drafts/${encodeURIComponent(draftId)}`, {
    method: 'PUT',
    json: { draft },
    timeoutMs: 30000,
    ...opts,
  });
}

export function deleteSanctuarySocialDraft(draftId, opts = {}) {
  return requestNode(`/api/social/drafts/${encodeURIComponent(draftId)}`, {
    method: 'DELETE',
    timeoutMs: 10000,
    ...opts,
  });
}

export function fetchSanctuaryLinkedPosts(opts = {}) {
  return requestNode('/api/social/linked-posts', {
    timeoutMs: 20000,
    ...opts,
  });
}

export function saveSanctuaryLinkedPost(canonicalId, record, opts = {}) {
  return requestNode(`/api/social/linked-posts/${encodeURIComponent(canonicalId)}`, {
    method: 'PUT',
    json: { record },
    timeoutMs: 10000,
    ...opts,
  });
}

export function deleteSanctuaryLinkedPost(canonicalId, opts = {}) {
  return requestNode(`/api/social/linked-posts/${encodeURIComponent(canonicalId)}`, {
    method: 'DELETE',
    timeoutMs: 10000,
    ...opts,
  });
}

/**
 * Call a stateless /api/social/* bridge endpoint on the configured Sanctuary node.
 * Returns null when the node is offline/dormant or on any error so callers fall back silently.
 */
export async function requestSocialBridge(path, payload, { timeoutMs = 8000 } = {}) {
  if (connectionStore.get().mode !== 'online') return null;
  try {
    return await requestNode(`/api/social${path}`, {
      method: 'POST',
      json: payload,
      timeoutMs,
    });
  } catch {
    return null;
  }
}

/**
 * Relay a stateless https://graph.threads.net request through the configured Sanctuary node
 * to bypass browser CORS omissions on Threads API endpoints.
 */
export async function requestThreadsProxy({ url, method = 'GET', body = '', timeoutMs = 15000 } = {}) {
  if (connectionStore.get().mode !== 'online') return null;
  try {
    return await requestNode('/api/social/threads-proxy', {
      method: 'POST',
      json: { url, method, body },
      timeoutMs,
    });
  } catch {
    return null;
  }
}

export async function requestThreadsInsightsBatch({ postIds = [], accessToken = '', timeoutMs = 15000 } = {}) {
  if (connectionStore.get().mode !== 'online') return null;
  const ids = Array.isArray(postIds) ? postIds.filter(Boolean) : [];
  if (ids.length === 0 || !accessToken) return null;
  try {
    const res = await requestNode('/api/social/threads-insights-batch', {
      method: 'POST',
      json: { postIds: ids, accessToken },
      timeoutMs,
    });
    if (res && typeof res.results === 'object' && !Array.isArray(res.results)) {
      return res.results;
    }
    return null;
  } catch {
    return null;
  }
}

export function resolveVideoEmbedUrl(embedSrc) {
  const cleanSrc = String(embedSrc || '').trim();
  if (!cleanSrc) return '';
  const loc = globalThis.location;
  const host = String(loc?.hostname || '').toLowerCase();
  if (host === '127.0.0.1' || host === '[::1]') {
    const proto = loc.protocol === 'https:' ? 'https:' : 'http:';
    const port = loc.port ? `:${loc.port}` : '';
    return `${proto}//localhost${port}/api/social/video-embed?src=${encodeURIComponent(cleanSrc)}`;
  }
  return cleanSrc;
}

// Browser Bookmark Sync & Reader Fallback

export function fetchSanctuaryBrowserBookmarks(opts = {}) {
  return requestNode('/api/browser/bookmarks', {
    timeoutMs: 10000,
    ...opts,
  });
}

export function saveSanctuaryBrowserBookmark(bookmarkId, bookmark, opts = {}) {
  return requestNode(`/api/browser/bookmarks/${encodeURIComponent(bookmarkId)}`, {
    method: 'PUT',
    json: { bookmark },
    timeoutMs: 10000,
    ...opts,
  });
}

export function deleteSanctuaryBrowserBookmark(bookmarkId, opts = {}) {
  return requestNode(`/api/browser/bookmarks/${encodeURIComponent(bookmarkId)}`, {
    method: 'DELETE',
    timeoutMs: 10000,
    ...opts,
  });
}

export function fetchSanctuaryBrowserReader(url, { mode = 'reader', ...opts } = {}) {
  return requestNode('/api/browser/reader', {
    method: 'POST',
    json: { url, mode },
    timeoutMs: 15000,
    ...opts,
  });
}

export async function fetchSanctuaryBrowserSuggest(query, engine = 'ecosia', opts = {}) {
  const clean = String(query || '').trim();
  if (!clean || connectionStore.get().mode !== 'online') return [];
  try {
    const qs = new URLSearchParams({ q: clean, engine: String(engine || 'ecosia') }).toString();
    const res = await requestNode(`/api/browser/suggest?${qs}`, {
      background: true,
      timeoutMs: 2500,
      ...opts,
    });
    return Array.isArray(res?.suggestions) ? res.suggestions : [];
  } catch {
    return [];
  }
}

export function submitBrowserCommandResult(cmdId, result, opts = {}) {
  return requestNode('/api/browser/command_result', {
    method: 'POST',
    json: { cmd_id: cmdId, result },
    timeoutMs: 10000,
    ...opts,
  });
}
